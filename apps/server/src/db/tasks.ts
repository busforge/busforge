import type { Database } from "bun:sqlite";
import { NOT_STARTED_REASON, outcomeOf, type Task, type TaskKind, type TaskState, type TaskStore } from "../taskqueue.ts";

interface TaskRow {
  id: string; project_id: string; device_id: string; device_name: string; ia: string; kind: string;
  writes: number; snapshot_id: string | null; state: string; phase: string | null; done: number; total: number;
  error: string | null; error_code: string | null; result: string | null; baseline_committed: number;
  queued_at: number; started_at: number | null; finished_at: number | null;
}

const fromRow = (r: TaskRow): Task => {
  const result = r.result === null ? null : JSON.parse(r.result) as unknown;
  return {
    id: r.id, projectId: r.project_id, deviceId: r.device_id, deviceName: r.device_name, ia: r.ia,
    kind: r.kind as TaskKind, writes: r.writes === 1, snapshotId: r.snapshot_id, state: r.state as TaskState,
    phase: r.phase, done: r.done, total: r.total, error: r.error, errorCode: r.error_code,
    outcome: outcomeOf(result), result, baselineCommitted: r.baseline_committed === 1,
    queuedAt: r.queued_at, startedAt: r.started_at, finishedAt: r.finished_at,
    // A stored row is a task of an earlier process, or one this process no longer runs.
    cancellable: false,
  };
};

export class SqliteTaskStore implements TaskStore {
  constructor(private db: Database) {}

  save(t: Task): void {
    this.db.prepare(`INSERT INTO tasks (id, project_id, device_id, device_name, ia, kind, writes, snapshot_id, state, phase, done, total,
        error, error_code, result, baseline_committed, queued_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = excluded.state, phase = excluded.phase, done = excluded.done, total = excluded.total,
        error = excluded.error, error_code = excluded.error_code, result = excluded.result,
        baseline_committed = excluded.baseline_committed, started_at = excluded.started_at, finished_at = excluded.finished_at`)
      .run(t.id, t.projectId, t.deviceId, t.deviceName, t.ia, t.kind, t.writes ? 1 : 0, t.snapshotId, t.state, t.phase, t.done, t.total,
        t.error, t.errorCode, t.result === null || t.result === undefined ? null : JSON.stringify(t.result), t.baselineCommitted ? 1 : 0,
        t.queuedAt, t.startedAt, t.finishedAt);
  }

  commit(task: Task, adopt: () => void): void {
    this.db.transaction(() => { adopt(); this.save(task); })();
  }

  get(id: string): Task | null {
    const r = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
    return r ? fromRow(r) : null;
  }

  recent(projectId: string, since: number): Task[] {
    return (this.db.query("SELECT * FROM tasks WHERE project_id = ? AND (finished_at IS NULL OR finished_at > ?)")
      .all(projectId, since) as TaskRow[]).map(fromRow);
  }
}

// A process that stops cannot finish its tasks, and a task is never replayed on the next start: a
// queued write the user submitted an hour ago may no longer be what they want. So at startup,
// every task the previous process left unfinished is closed with what is actually known about it.
// A queued task never reached the bus. A running read or dry run wrote nothing. A running write may have
// stopped mid-bracket, and the device's state is unknown until it is read back.
export function closeUnfinishedTasks(db: Database, now: number): void {
  db.transaction(() => {
    db.run(`UPDATE tasks SET state = 'cancelled', finished_at = ?, error_code = 'TASK_NOT_STARTED', error = ?
      WHERE state = 'queued'`, [now, NOT_STARTED_REASON]);
    // Adoption and baseline_committed are one transaction, so a write whose baseline was committed
    // was verified on the device: only closing the task record was lost.
    db.run("UPDATE tasks SET state = 'done', finished_at = ? WHERE state = 'running' AND baseline_committed = 1", [now]);
    db.run(`UPDATE tasks SET state = 'interrupted', finished_at = ?, error_code = 'TASK_WRITE_INTERRUPTED',
        error = 'the server stopped while this write was running; the device state is unknown, read it back before trusting it'
      WHERE state = 'running' AND writes = 1`, [now]);
    db.run(`UPDATE tasks SET state = 'interrupted', finished_at = ?, error_code = 'TASK_READ_INTERRUPTED',
        error = 'the server stopped while this read or preview was running; nothing was written to the device'
      WHERE state = 'running' AND writes = 0`, [now]);
  })();
}

export function pruneTasks(db: Database, before: number): void {
  db.run("DELETE FROM tasks WHERE finished_at IS NOT NULL AND finished_at < ?", [before]);
}
