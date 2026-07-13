import { randomUUID } from "node:crypto";
import { errorCode } from "./errors.ts";

// A single physical KNX interface backs every bus operation (one tunnel, one
// connection-oriented device link), so reads and flashes cannot run in parallel.
// Instead of rejecting a concurrent request, we queue it: jobs run strictly FIFO,
// one at a time, and each carries live state + progress for the UI to display.

export type TaskKind = "read" | "flash-params" | "flash-ga" | "assign-ia" | "download";
export type TaskState = "queued" | "running" | "done" | "error" | "cancelled";

export interface Task {
  id: string;
  projectId: string;
  deviceId: string;
  deviceName: string;
  ia: string;
  kind: TaskKind;
  state: TaskState;
  phase: string | null;
  done: number;
  total: number;
  error: string | null;
  // Stable code for client localization when the failure is a coded error; null
  // for cancellations and uncoded (unexpected) failures.
  errorCode: string | null;
  // What the operation actually reported. Without this a finished task says "done" and nothing
  // else, so a download that wrote every byte and then FAILED ITS READ-BACK looked exactly like
  // one that worked. The result is the only place that distinction exists; it belongs here.
  outcome: TaskOutcome | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// The bits of a bus-operation result the task list carries. `kind` is the operation's own verdict
// ("flashed" | "dryRun" | "unchanged" | ...), `verified` is whether the device was read back and
// agreed. Both are optional: a read returns neither.
export interface TaskOutcome { kind?: string; verified?: boolean }

const outcomeOf = (r: unknown): TaskOutcome | null => {
  if (!r || typeof r !== "object") return null;
  const o = r as { kind?: unknown; verified?: unknown };
  const kind = typeof o.kind === "string" ? o.kind : undefined;
  const verified = typeof o.verified === "boolean" ? o.verified : undefined;
  return kind === undefined && verified === undefined ? null : { kind, verified };
};

// Report progress from inside a job: a phase label plus optional done/total counters
// (unit-agnostic; memory reads report bytes).
export type ProgressFn = (phase: string, done?: number, total?: number) => void;

export class CancelledError extends Error {
  constructor() { super("task cancelled"); this.name = "CancelledError"; }
}

export interface TaskMeta {
  projectId: string;
  deviceId: string;
  deviceName: string;
  ia: string;
  kind: TaskKind;
}

// How long a finished task lingers in the list so the UI can show its result. A full download is
// several minutes of bus traffic; at the old 20s a caller that looked away for one poll interval
// found the task simply gone, with no way to learn how it ended. Outlive the operation itself.
const RETENTION_MS = 10 * 60_000;

export class TaskQueue {
  private tasks: Task[] = [];
  private controllers = new Map<string, AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private now: () => number = () => Date.now()) {}

  // Append a job; it starts once all earlier jobs have finished. The returned
  // promise resolves/rejects with the job's own result, independent of siblings.
  // `run` receives an AbortSignal it may honor to support cancellation.
  enqueue<T>(meta: TaskMeta, run: (progress: ProgressFn, signal: AbortSignal) => Promise<T>): Promise<T> {
    const task: Task = {
      id: randomUUID(), ...meta, state: "queued", phase: null, done: 0, total: 0,
      error: null, errorCode: null, outcome: null, queuedAt: this.now(), startedAt: null, finishedAt: null,
    };
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.tasks.push(task);
    this.prune();

    const result = this.tail.then(async () => {
      // Cancelled while still waiting in the queue: skip without running.
      if (task.state === "cancelled" || controller.signal.aborted) {
        if (task.state !== "cancelled") { task.state = "cancelled"; task.finishedAt = this.now(); }
        this.controllers.delete(task.id); // this path skips the run try/finally below
        throw new CancelledError();
      }
      task.state = "running";
      task.startedAt = this.now();
      const progress: ProgressFn = (phase, done = 0, total = 0) => { task.phase = phase; task.done = done; task.total = total; };
      try {
        const r = await run(progress, controller.signal);
        task.outcome = outcomeOf(r);
        // A write the device did not confirm is not a success. The routes already refuse to adopt
        // the programmed baseline in that case, but the TASK said "done" regardless, so a caller
        // polling the task list — which is the only thing the UI and a script can see — was told
        // green for a download the device never took. It is an error, and it is named as one.
        if (task.outcome?.verified === false) {
          task.state = "error";
          task.error = "the device did not verify what was written to it";
          task.errorCode = "FLASH_UNVERIFIED";
        } else {
          task.state = "done";
        }
        return r;
      } catch (e) {
        if (controller.signal.aborted) { task.state = "cancelled"; task.error = null; }
        else { task.state = "error"; task.error = (e as Error).message; task.errorCode = errorCode(e) ?? null; }
        throw e;
      } finally {
        task.finishedAt = this.now();
        this.controllers.delete(task.id);
        // The one line that says what a bus operation did. Without it the server logged nothing at
        // all about the hardware it drives, and a download that failed left no trace anywhere.
        const ms = (task.finishedAt ?? 0) - (task.startedAt ?? 0);
        const extra = task.outcome ? ` ${task.outcome.kind ?? "?"}${task.outcome.verified === undefined ? "" : ` verified=${task.outcome.verified}`}` : "";
        const why = task.error ? ` — ${task.errorCode ?? "error"}: ${task.error}` : "";
        console.log(`[bus] ${task.kind} ${task.ia} (${task.deviceName}) -> ${task.state}${extra} in ${ms}ms${why}`);
      }
    });
    // The queue must keep draining even if this job fails, so chain off a swallowed copy.
    this.tail = result.catch(() => {});
    return result;
  }

  // Cancel a task. Queued tasks are always cancellable (they never run). Running
  // tasks are only cancellable when the operation can be safely interrupted: a
  // read is read-only, but a flash mid-write would leave the device corrupted, so
  // that is refused. Returns which case was cancelled, or null if not possible.
  cancel(taskId: string): "queued" | "running" | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const controller = this.controllers.get(taskId);
    if (task.state === "queued") {
      task.state = "cancelled";
      task.finishedAt = this.now();
      controller?.abort();
      return "queued";
    }
    if (task.state === "running" && task.kind === "read") {
      controller?.abort();
      return "running";
    }
    return null;
  }

  list(projectId: string): Task[] {
    this.prune();
    return this.tasks.filter((t) => t.projectId === projectId);
  }

  private prune(): void {
    const cutoff = this.now() - RETENTION_MS;
    this.tasks = this.tasks.filter((t) => t.state === "queued" || t.state === "running" || (t.finishedAt ?? 0) > cutoff);
  }
}
