// The ETS sweep's rows judged side by side, each in a worker thread that judges one row at a time
// (tools/ets-sweep.ts runRow). Busforge's run into a simulated unit waits on the simulated line nearly all its
// time, so rows can overlap; but they cannot share an event loop: one row's parse of a large application holds
// the loop for seconds, and with it the timers of every other row's simulated line and connection. Nor can they
// take every core: `bun run check` runs the other workspaces' tests at the same time, and a worker that waits for
// a core delays its row's timers just the same.
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import type { Verdict } from "./ets-sweep.ts";

const ROLE = "ets-sweep-row";
// A row and its answer between the pool and a worker; `job` tells two judgements of one row apart.
export interface RowRequest { job: number; id: string }
export type RowAnswer = { job: number; verdict: Verdict } | { job: number; error: string };

// Half the cores: the rest is the other workspaces' tests' and the runner's.
export const ROW_WORKERS = Math.max(1, Math.floor(availableParallelism() / 2));

interface Job { job: number; id: string; resolve: (v: Verdict) => void; reject: (e: Error) => void; deaths: number }

// A pool of `size` workers (each started on demand, ended with the process): judge(id) is the row's verdict, as
// runRow gives it, or the error its run threw. A row whose worker dies is judged once more by another worker;
// the second death rejects it with the worker's error. `worker` is the worker's module (this one by default).
export class RowPool {
  private readonly queue: Job[] = [];
  private readonly idle: Worker[] = [];
  private readonly current = new Map<Worker, Job>();
  private workers = 0;
  private jobs = 0;

  constructor(private readonly size = ROW_WORKERS, private readonly worker: URL = new URL(import.meta.url)) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`a pool of ${size} workers judges no row`);
  }

  judge(id: string): Promise<Verdict> {
    return new Promise((resolve, reject) => {
      this.queue.push({ job: this.jobs++, id, resolve, reject, deaths: 0 });
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length) {
      const w = this.idle.pop() ?? (this.workers < this.size ? this.start() : undefined);
      if (w === undefined) return;
      const job = this.queue.shift()!;
      this.current.set(w, job);
      // An idle worker does not hold the process open; one judging a row does.
      w.ref();
      w.postMessage({ job: job.job, id: job.id } satisfies RowRequest);
    }
  }

  private start(): Worker {
    const w = new Worker(this.worker, { workerData: { role: ROLE } });
    this.workers++;
    let dead = false;
    w.on("message", (m: RowAnswer) => {
      const job = this.current.get(w);
      if (dead || job === undefined || job.job !== m.job) return;
      this.current.delete(w);
      if ("error" in m) job.reject(new Error(m.error)); else job.resolve(m.verdict);
      w.unref();
      this.idle.push(w);
      this.pump();
    });
    const died = (e: Error) => {
      if (dead) return;
      dead = true;
      this.workers--;
      const at = this.idle.indexOf(w);
      if (at >= 0) this.idle.splice(at, 1);
      const job = this.current.get(w);
      this.current.delete(w);
      if (job !== undefined) {
        if (++job.deaths < 2) this.queue.unshift(job);
        else job.reject(new Error(`the workers judging ${job.id} died twice; the second: ${e.message}`));
      }
      this.pump();
    };
    w.on("error", (e) => died(e instanceof Error ? e : new Error(String(e))));
    // A message that does not arrive leaves the worker running: it is ended, its row judged by another.
    w.on("messageerror", (e) => { died(e instanceof Error ? e : new Error(String(e))); w.unref(); void w.terminate(); });
    w.on("exit", (code) => died(new Error(`the worker exited with code ${code}`)));
    return w;
  }
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === ROLE) {
  const { readRow, runRow } = await import("./ets-sweep.ts");
  parentPort!.on("message", ({ job, id }: RowRequest) => {
    Promise.resolve().then(() => runRow(readRow(id))).then(
      (r) => parentPort!.postMessage({ job, verdict: r.verdict } satisfies RowAnswer),
      (e: unknown) => parentPort!.postMessage({ job, error: e instanceof Error ? e.stack ?? e.message : String(e) } satisfies RowAnswer),
    );
  });
}
