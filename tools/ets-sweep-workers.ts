// The ETS sweep's rows judged side by side, each in a worker thread that judges one row at a time
// (tools/ets-sweep.ts runRow). Busforge's run into a simulated unit waits on the simulated line nearly all its
// time, so rows can overlap; but they cannot share an event loop: one row's parse of a large application holds
// the loop for seconds, and with it the timers of every other row's simulated line and connection. Nor can they
// take every core: `bun run check` runs the other workspaces' tests at the same time, and a worker that waits for
// a core delays its row's timers just the same.
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { ManifestRow, Verdict } from "./ets-sweep.ts";

const ROLE = "ets-sweep-row";
// What a row's judgement carries besides its verdict: its manifest entry (tools/ets-sweep.ts manifestRow), and
// Busforge's capture with the simulator's lines, each where asked for.
export interface RowWants { manifest?: boolean; keep?: boolean }
export interface RowJudgement { verdict: Verdict; manifest?: ManifestRow; kept?: { capture: string; simLines: string[] } }
// A row and its answer between the pool and a worker; `job` tells two judgements of one row apart.
export interface RowRequest extends RowWants { job: number; id: string }
export type RowAnswer = { job: number; judgement: RowJudgement } | { job: number; error: string };

// Half the cores: the rest is the other workspaces' tests' and the runner's.
export const ROW_WORKERS = Math.max(1, Math.floor(availableParallelism() / 2));

interface Job { job: number; id: string; wants: RowWants; resolve: (v: RowJudgement) => void; reject: (e: Error) => void; deaths: number; timer?: ReturnType<typeof setTimeout> }

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

// A pool of `size` workers (each started on demand): judge(id) is the row's judgement, as runRow gives it, or the
// error its run threw. A row whose worker dies is judged once more by another worker; the second death rejects it
// with the worker's error. `rowTimeoutMs`: how long a row may take from when a worker takes it (not while it waits
// for one); a row that takes longer is rejected and its worker retired. close() rejects the rows not judged yet,
// judges none after, and retires every worker. `worker` is the worker's module (this one by default).
//
// A retired worker leaves the pool and no longer holds the process open, but is not ended: on Bun 1.3.8 a worker
// thread that ends (terminated or of itself) while the process runs on crashes the process a moment later
// (EXC_BREAKPOINT, "pointer being freed was not allocated" in the thread's pthread_exit). So a timed-out row's job runs
// on in its retired worker, unheard, and every worker ends with the process.
export class RowPool {
  private readonly queue: Job[] = [];
  private readonly idle: Worker[] = [];
  private readonly current = new Map<Worker, Job>();
  private readonly all = new Set<Worker>();
  private jobs = 0;
  private closed = false;

  constructor(private readonly size = ROW_WORKERS, private readonly opts: { rowTimeoutMs?: number; worker?: URL } = {}) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`a pool of ${size} workers judges no row`);
  }

  judge(id: string, wants: RowWants = {}): Promise<RowJudgement> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error(`the pool is closed: ${id} is not judged`)); return; }
      this.queue.push({ job: this.jobs++, id, wants, resolve, reject, deaths: 0 });
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error(`the pool was closed: ${job.id} is not judged`));
    for (const [w, job] of [...this.current]) { this.settle(w, job); job.reject(new Error(`the pool was closed: ${job.id} is not judged`)); }
    for (const w of [...this.all]) this.retire(w);
  }

  // A job no longer waits on its worker.
  private settle(w: Worker, job: Job): void {
    clearTimeout(job.timer);
    this.current.delete(w);
  }

  private pump(): void {
    while (this.queue.length && !this.closed) {
      let w: Worker | undefined;
      // A worker that cannot be started fails the row that asked for it, not the caller of the event that pumped.
      try { w = this.idle.pop() ?? (this.all.size < this.size ? this.start() : undefined); }
      catch (e) { this.queue.shift()!.reject(asError(e)); continue; }
      if (w === undefined) return;
      const job = this.queue.shift()!;
      this.current.set(w, job);
      // An idle worker does not hold the process open; one judging a row does.
      w.ref();
      try { w.postMessage({ job: job.job, id: job.id, ...job.wants } satisfies RowRequest); }
      catch (e) { this.settle(w, job); job.reject(asError(e)); this.retire(w); continue; }
      const limit = this.opts.rowTimeoutMs;
      const taken = w;
      if (limit !== undefined) job.timer = setTimeout(() => {
        if (this.current.get(taken) !== job) return;
        this.settle(taken, job);
        job.reject(new Error(`${job.id} was not judged within ${limit / 1000} s of its worker taking it`));
        this.retire(taken);
      }, limit);
    }
  }

  // A worker that is not to judge another row: it leaves the pool and no longer holds the process open.
  private retire(w: Worker): void {
    this.all.delete(w);
    const at = this.idle.indexOf(w);
    if (at >= 0) this.idle.splice(at, 1);
    w.unref();
    this.pump();
  }

  private start(): Worker {
    const w = new Worker(this.opts.worker ?? new URL(import.meta.url), { workerData: { role: ROLE } });
    this.all.add(w);
    w.on("message", (m: RowAnswer) => {
      const job = this.current.get(w);
      if (!this.all.has(w) || job === undefined || job.job !== m.job) return;
      this.settle(w, job);
      if ("error" in m) job.reject(new Error(m.error)); else job.resolve(m.judgement);
      w.unref();
      this.idle.push(w);
      this.pump();
    });
    const died = (e: Error) => {
      if (!this.all.has(w)) return;
      const job = this.current.get(w);
      if (job !== undefined) {
        this.settle(w, job);
        if (++job.deaths < 2) this.queue.unshift(job);
        else job.reject(new Error(`the workers judging ${job.id} died twice; the second: ${e.message}`));
      }
      this.retire(w);
    };
    // An error or a message that does not arrive leaves the worker running: it is retired, its row judged by another.
    w.on("error", (e) => died(asError(e)));
    w.on("messageerror", (e) => died(asError(e)));
    w.on("exit", (code) => died(new Error(`the worker exited with code ${code}`)));
    return w;
  }
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === ROLE) {
  const { manifestRow, readRow, runRow } = await import("./ets-sweep.ts");
  parentPort!.on("message", ({ job, id, manifest, keep }: RowRequest) => {
    Promise.resolve().then(async (): Promise<RowJudgement> => {
      const row = readRow(id);
      const r = await runRow(row);
      return { verdict: r.verdict, ...(manifest ? { manifest: manifestRow(row, r) } : {}), ...(keep ? { kept: { capture: r.busforge.capture, simLines: r.busforge.sim.lines } } : {}) };
    }).then(
      (judgement) => parentPort!.postMessage({ job, judgement } satisfies RowAnswer),
      (e: unknown) => parentPort!.postMessage({ job, error: e instanceof Error ? e.stack ?? e.message : String(e) } satisfies RowAnswer),
    );
  });
}
