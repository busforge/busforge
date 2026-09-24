import { randomUUID } from "node:crypto";
import { ApiError, errorCode } from "./errors.ts";

// A single physical KNX interface backs every bus operation (one tunnel, one
// connection-oriented device link), so reads and flashes cannot run in parallel.
// Instead of rejecting a concurrent request, we queue it: jobs run strictly FIFO,
// one at a time, and each carries live state + progress for the UI to display.
//
// Every task is also written to a TaskStore, so its outcome outlives the HTTP request that
// submitted it and the process that ran it. A task the process was still running when it died
// is never replayed: the store reports it as interrupted, and for a write that means the device
// state is unknown.

export type TaskKind = "read" | "flash-params" | "flash-ga" | "assign-ia" | "download";
export type TaskState = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export interface Task {
  id: string;
  projectId: string;
  deviceId: string;
  deviceName: string;
  ia: string;
  kind: TaskKind;
  // True when the task changes the device (a real flash, download or address assignment). A dry
  // run and a read are false: cancelling or interrupting them cannot leave the device half-written.
  writes: boolean;
  // The automatic restore point taken of the submitted configuration, when one was taken.
  snapshotId: string | null;
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
  // A write's full result (a FlashResult, an address assignment), for the client that submitted
  // it and collects the answer later. Null for reads: their result lands in the database instead.
  result: unknown;
  // Whether the verified submission was adopted as the device's programmed baseline. Set in the
  // same transaction as the adoption, so the two cannot disagree after a crash.
  baselineCommitted: boolean;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

// The bits of a bus-operation result the task list carries. `kind` is the operation's own verdict
// ("flashed" | "dryRun" | "unchanged" | ...), `verified` is whether the device was read back and
// agreed. Both are optional: a read returns neither.
export interface TaskOutcome { kind?: string; verified?: boolean }

export const outcomeOf = (r: unknown): TaskOutcome | null => {
  if (!r || typeof r !== "object") return null;
  const o = r as { kind?: unknown; verified?: unknown };
  const kind = typeof o.kind === "string" ? o.kind : undefined;
  const verified = typeof o.verified === "boolean" ? o.verified : undefined;
  return kind === undefined && verified === undefined ? null : { kind, verified };
};

// Report progress from inside a job: a phase label plus optional done/total counters
// (unit-agnostic; memory reads report bytes).
export type ProgressFn = (phase: string, done?: number, total?: number) => void;
// Adopt a verified result as the programmed baseline, atomically with recording that on the task.
export type CommitFn = (result: unknown, adopt: () => void) => void;

export class CancelledError extends Error {
  constructor() { super("task cancelled"); this.name = "CancelledError"; }
}

export interface TaskMeta {
  projectId: string;
  deviceId: string;
  deviceName: string;
  ia: string;
  kind: TaskKind;
  writes: boolean;
  snapshotId?: string | null;
}

export interface TaskStore {
  save(task: Task): void;
  // Run `adopt` and persist `task` in one transaction: both happen, or neither.
  commit(task: Task, adopt: () => void): void;
  get(id: string): Task | null;
  // Every queued/running task of the project plus its most recently finished ones since `since`.
  recent(projectId: string, since: number): Task[];
}

// Keeps tasks for the life of the process only. For tests and callers without a database.
export class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, Task>();
  save(task: Task): void { this.tasks.set(task.id, task); }
  commit(task: Task, adopt: () => void): void { adopt(); this.save(task); }
  get(id: string): Task | null { return this.tasks.get(id) ?? null; }
  recent(projectId: string, since: number): Task[] {
    return [...this.tasks.values()].filter((t) => t.projectId === projectId && (t.finishedAt === null || t.finishedAt > since));
  }
}

// How long a finished task stays in the list. A full download is minutes of bus traffic, and a
// task the server was interrupted in must still be visible when someone comes back to look.
// Beyond this window a task is still retrievable by id.
const LIST_WINDOW_MS = 24 * 60 * 60_000;
const LIST_FINISHED_MAX = 50;

export const NOT_STARTED_REASON = "the server stopped before this task started; nothing was sent to the device";

const isActive = (t: Task) => t.state === "queued" || t.state === "running";

export class TaskQueue {
  // Queued and running tasks, holding the live progress the store only sees at phase changes.
  private live = new Map<string, Task>();
  private settled = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
  private draining: Promise<void> | null = null;
  constructor(
    private now: () => number = () => Date.now(),
    private exclusive: <T>(run: () => Promise<T>) => Promise<T> = (run) => run(),
    private store: TaskStore = new MemoryTaskStore(),
  ) {}

  // Append a job; it starts once all earlier jobs have finished. The returned
  // promise resolves/rejects with the job's own result, independent of siblings.
  // `run` receives an AbortSignal it may honor to support cancellation.
  enqueue<T>(meta: TaskMeta, run: (progress: ProgressFn, signal: AbortSignal, commit: CommitFn) => Promise<T>): Promise<T> {
    return this.start(meta, run).result;
  }

  // Append a job and return its task at once, for a caller that collects the outcome later by id.
  // Nothing waits on the job's promise, so its failure lives only in the task, never as an
  // unhandled rejection.
  submit<T>(meta: TaskMeta, run: (progress: ProgressFn, signal: AbortSignal, commit: CommitFn) => Promise<T>): Task {
    const { task, result } = this.start(meta, run);
    result.catch(() => {});
    return { ...task };
  }

  refuseAdmission(): void {
    if (this.draining) throw new ApiError("SERVER_SHUTTING_DOWN", "the server is shutting down and accepts no new bus operations", 503);
  }

  // Two writes to the same device must never be in flight together: a client that lost the
  // response to its first submission and retries would otherwise program the device twice.
  refuseConcurrentWrite(projectId: string, deviceId: string): void {
    const active = [...this.live.values()].find((t) => t.writes && isActive(t) && t.projectId === projectId && t.deviceId === deviceId);
    if (active) {
      throw new ApiError("DEVICE_WRITE_ACTIVE", `a ${active.kind} of this device is already ${active.state} (task ${active.id}); wait for its result before programming again`, 409);
    }
  }

  private start<T>(meta: TaskMeta, run: (progress: ProgressFn, signal: AbortSignal, commit: CommitFn) => Promise<T>): { task: Task; result: Promise<T> } {
    this.refuseAdmission();
    if (meta.writes) this.refuseConcurrentWrite(meta.projectId, meta.deviceId);
    const task: Task = {
      id: randomUUID(), ...meta, snapshotId: meta.snapshotId ?? null, state: "queued", phase: null, done: 0, total: 0,
      error: null, errorCode: null, outcome: null, result: null, baselineCommitted: false,
      queuedAt: this.now(), startedAt: null, finishedAt: null,
    };
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.live.set(task.id, task);
    try { this.store.save(task); }
    catch (e) { this.live.delete(task.id); this.controllers.delete(task.id); throw e; }

    const result = this.tail.then(async () => {
      // Cancelled while still waiting in the queue: skip without running.
      if (task.state === "cancelled" || controller.signal.aborted) {
        if (task.state !== "cancelled") { task.state = "cancelled"; task.finishedAt = this.now(); }
        this.controllers.delete(task.id); // this path skips the run try/finally below
        this.close(task);
        throw new CancelledError();
      }
      task.state = "running";
      task.startedAt = this.now();
      // Progress is recorded for a restart to report where a job stopped. Failing to record it must
      // not abort a write mid-bracket, which would do the device far more harm than a stale phase.
      const progress: ProgressFn = (phase, done = 0, total = 0) => {
        const changed = phase !== task.phase;
        task.phase = phase; task.done = done; task.total = total;
        if (changed) {
          try { this.store.save(task); }
          catch (e) { console.error(`[bus] could not record phase ${phase} of task ${task.id}: ${(e as Error).message}`); }
        }
      };
      const commit: CommitFn = (r, adopt) => {
        task.result = r; task.outcome = outcomeOf(r); task.baselineCommitted = true;
        try { this.store.commit(task, adopt); }
        catch (e) { task.baselineCommitted = false; throw e; }
      };
      try {
        // Nothing touches the bus until the store knows the job started: a write it never heard of
        // could not be reported as interrupted after a restart.
        this.store.save(task);
        const r = await this.exclusive(() => {
          if (controller.signal.aborted) throw new CancelledError();
          return run(progress, controller.signal, commit);
        });
        task.result = task.writes ? r ?? null : null;
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
        this.close(task);
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
    const settled = this.tail.then(() => { this.settled.delete(task.id); });
    this.settled.set(task.id, settled);
    return { task, result };
  }

  // Cancel a task. Queued tasks are always cancellable (they never run). Of the running tasks only
  // a read is: it honors the abort signal and writes nothing. A running write is refused, because
  // stopping mid-bracket can leave the device reset.
  cancel(taskId: string): "queued" | "running" | null {
    const task = this.live.get(taskId);
    if (!task) return null;
    const controller = this.controllers.get(taskId);
    if (task.state === "queued") {
      this.cancelQueued(task);
      return "queued";
    }
    if (task.state === "running" && task.kind === "read") {
      controller?.abort();
      return "running";
    }
    return null;
  }

  private cancelQueued(task: Task, code: string | null = null, why: string | null = null): void {
    task.state = "cancelled";
    task.errorCode = code;
    task.error = why;
    task.finishedAt = this.now();
    this.close(task);
    this.controllers.get(task.id)?.abort();
  }

  // Resolves once every running write has ended, read-back and baseline commit included: an
  // interrupted download can leave the device reset. Nothing else is waited for.
  shutdown(): Promise<void> {
    if (this.draining) return this.draining;
    const writes: Promise<unknown>[] = [];
    for (const task of [...this.live.values()]) {
      if (task.state === "queued") {
        this.cancelQueued(task, "TASK_NOT_STARTED", NOT_STARTED_REASON);
      } else if (task.state === "running") {
        if (task.writes) {
          const settled = this.settled.get(task.id);
          if (!settled) throw new Error(`running write ${task.id} has no completion to wait for`);
          writes.push(settled);
        }
        else this.controllers.get(task.id)?.abort();
      }
    }
    this.draining = Promise.all(writes).then(() => {});
    return this.draining;
  }

  // The running writes a shutdown is waiting for, for the log.
  activeWrites(): Task[] {
    return [...this.live.values()].filter((t) => t.writes && t.state === "running");
  }

  // Record a finished task and stop holding it in memory. If the store cannot record it, the task
  // stays in memory, finished, for the life of the process: otherwise the store would go on
  // reporting it running and a client waiting for it would wait forever.
  private close(task: Task): void {
    try {
      this.store.save(task);
      this.live.delete(task.id);
    } catch (e) {
      console.error(`[bus] could not record the end of task ${task.id} (${task.kind} ${task.ia} -> ${task.state}): ${(e as Error).message}`);
    }
  }

  get(taskId: string): Task | null {
    return this.live.get(taskId) ?? this.store.get(taskId);
  }

  // Resolves with the task once it has finished (immediately if it already has).
  async wait(taskId: string): Promise<Task | null> {
    await this.settled.get(taskId);
    return this.get(taskId);
  }

  list(projectId: string): Task[] {
    const tasks = this.store.recent(projectId, this.now() - LIST_WINDOW_MS).map((t) => this.live.get(t.id) ?? t);
    const finished = tasks.filter((t) => !isActive(t)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, LIST_FINISHED_MAX);
    return [...tasks.filter(isActive), ...finished].sort((a, b) => a.queuedAt - b.queuedAt);
  }
}
