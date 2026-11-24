// The ETS sweep's rows judged side by side, each in a worker thread of its own that judges one row at a time
// (tools/ets-sweep.ts runRow). Busforge's run into a simulated unit waits on the simulated line nearly all its
// time, so rows can overlap; but they cannot share an event loop: one row's parse of a large application holds
// the loop for seconds, and with it the timers of every other row's simulated line and connection.
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { readRow, runRow, type Verdict } from "./ets-sweep.ts";

const ROLE = "ets-sweep-row";
type Judged = { id: string; verdict: Verdict } | { id: string; error: string };

// One worker per core but one, for the test runner's own thread.
export const ROW_WORKERS = Math.max(1, availableParallelism() - 1);

// Each row's verdict, as runRow gives it; a row whose run threw is rejected with the worker's error.
export function judgeRows(ids: readonly string[], workers = ROW_WORKERS): Map<string, Promise<Verdict>> {
  const queue = [...ids];
  const settle = new Map<string, { resolve: (v: Verdict) => void; reject: (e: Error) => void }>();
  const out = new Map(ids.map((id) => [id, new Promise<Verdict>((resolve, reject) => settle.set(id, { resolve, reject }))]));
  // A rejection is the test's to report when it awaits its row, not an unhandled one before.
  for (const p of out.values()) p.catch(() => {});
  const start = () => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { role: ROLE } });
    let current: string | undefined;
    const next = () => {
      current = queue.shift();
      if (current !== undefined) { worker.postMessage(current); return; }
      // No more rows: the worker no longer holds the process open and closes its port. Terminating it from
      // here crashes Bun (1.3) while the worker's sockets wind down.
      worker.unref();
      worker.postMessage(null);
    };
    worker.on("message", (m: Judged) => {
      const s = settle.get(m.id)!;
      if ("error" in m) s.reject(new Error(m.error)); else s.resolve(m.verdict);
      next();
    });
    // A worker that dies takes its row with it; the rows still queued go to a new worker.
    const died = (e: Error) => {
      if (current === undefined) return;
      settle.get(current)!.reject(e);
      current = undefined;
      if (queue.length) start();
    };
    worker.on("error", (e) => died(e instanceof Error ? e : new Error(String(e))));
    worker.on("exit", (code) => died(new Error(`the worker judging the row exited with code ${code}`)));
    next();
  };
  for (let i = 0; i < Math.min(workers, ids.length); i++) start();
  return out;
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === ROLE) {
  parentPort!.on("message", (id: string | null) => {
    if (id === null) { parentPort!.close(); return; }
    Promise.resolve().then(() => runRow(readRow(id))).then(
      (r) => parentPort!.postMessage({ id, verdict: r.verdict } satisfies Judged),
      (e: unknown) => parentPort!.postMessage({ id, error: e instanceof Error ? e.stack ?? e.message : String(e) } satisfies Judged),
    );
  });
}
