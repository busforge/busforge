import { randomUUID } from "node:crypto";

// A single physical KNX interface backs every bus operation (one tunnel, one
// connection-oriented device link), so reads and flashes cannot run in parallel.
// Instead of rejecting a concurrent request, we queue it: jobs run strictly FIFO,
// one at a time, and each carries live state + progress for the UI to display.

export type TaskKind = "read" | "flash-params" | "flash-ga";
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
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// Report progress from inside a job: a phase label plus an optional chunk count.
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

// How long a finished task lingers in the list so the UI can show its result.
const RETENTION_MS = 20_000;

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
      error: null, queuedAt: this.now(), startedAt: null, finishedAt: null,
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
        task.state = "done";
        return r;
      } catch (e) {
        if (controller.signal.aborted) { task.state = "cancelled"; task.error = null; }
        else { task.state = "error"; task.error = (e as Error).message; }
        throw e;
      } finally {
        task.finishedAt = this.now();
        this.controllers.delete(task.id);
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
