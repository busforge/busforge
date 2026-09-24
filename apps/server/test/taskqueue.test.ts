import { test, expect, describe } from "bun:test";
import { MemoryTaskStore, TaskQueue } from "../src/taskqueue.ts";
import { ApiError } from "../src/errors.ts";
import { openDb } from "../src/db/schema.ts";
import { SqliteTaskStore, closeUnfinishedTasks } from "../src/db/tasks.ts";

const meta = (deviceId: string) => ({ projectId: "p1", deviceId, deviceName: deviceId, ia: "1.1.1", kind: "read" as const, writes: false });
const defer = () => { let resolve!: () => void; const p = new Promise<void>((r) => (resolve = r)); return { p, resolve }; };

describe("TaskQueue", () => {
  test("runs jobs serially in FIFO order even when enqueued together", async () => {
    const q = new TaskQueue(() => 0);
    const order: number[] = [];
    const running = () => q.list("p1").filter((t) => t.state === "running").length;

    const a = defer(), b = defer();
    const j1 = q.enqueue(meta("d1"), async () => { order.push(1); await a.p; order.push(11); return 1; });
    const j2 = q.enqueue(meta("d2"), async () => { order.push(2); await b.p; order.push(22); return 2; });

    await Promise.resolve();
    expect(running()).toBe(1); // only the first job runs; the second waits its turn
    a.resolve();
    expect(await j1).toBe(1);
    b.resolve();
    expect(await j2).toBe(2);
    expect(order).toEqual([1, 11, 2, 22]); // job 2 starts only after job 1 finishes
  });

  test("a failing job rejects but does not stall the queue", async () => {
    const q = new TaskQueue(() => 0);
    const j1 = q.enqueue(meta("d1"), async () => { throw new Error("boom"); });
    const j2 = q.enqueue(meta("d2"), async () => 42);
    expect(j1).rejects.toThrow("boom");
    expect(await j2).toBe(42);
    const tasks = q.list("p1");
    expect(tasks.find((t) => t.deviceId === "d1")?.state).toBe("error");
    expect(tasks.find((t) => t.deviceId === "d1")?.error).toBe("boom");
    expect(tasks.find((t) => t.deviceId === "d1")?.errorCode).toBeNull(); // plain Error carries no code
    expect(tasks.find((t) => t.deviceId === "d2")?.state).toBe("done");
  });

  test("captures a coded error's code so the UI can localize it", async () => {
    const q = new TaskQueue(() => 0);
    const j = q.enqueue(meta("d1"), async () => { throw new ApiError("MASK_MISMATCH", "device mask 1 != expected 2"); });
    expect(j).rejects.toThrow("device mask 1 != expected 2");
    const task = q.list("p1").find((t) => t.deviceId === "d1");
    expect(task?.state).toBe("error");
    expect(task?.error).toBe("device mask 1 != expected 2"); // raw message kept as fallback
    expect(task?.errorCode).toBe("MASK_MISMATCH"); // code flows through for localization
  });

  test("exposes live phase + chunk progress", async () => {
    const q = new TaskQueue(() => 0);
    const gate = defer();
    const job = q.enqueue(meta("d1"), async (progress) => { progress("params", 3, 8); await gate.p; });
    await Promise.resolve();
    const t = q.list("p1")[0];
    expect(t).toMatchObject({ state: "running", phase: "params", done: 3, total: 8 });
    gate.resolve();
    await job;
  });

  test("lists finished tasks for a day, and keeps them retrievable by id after that", async () => {
    let clock = 1000;
    const q = new TaskQueue(() => clock);
    await q.enqueue(meta("old"), async () => undefined);
    const id = q.list("p1")[0].id;
    // A finished task must outlive the operation that produced it: a full download is minutes of
    // bus traffic, and someone coming back after an interruption still has to find its result.
    clock += 23 * 60 * 60_000;
    expect(q.list("p1").length).toBe(1);
    clock += 2 * 60 * 60_000;
    expect(q.list("p1").length).toBe(0);
    expect(q.get(id)?.state).toBe("done");
  });

  test("a write the device did not verify is not reported as done", async () => {
    const q = new TaskQueue(() => 0);
    await q.enqueue({ ...meta("d1"), kind: "download" }, async () => ({ kind: "flashed", verified: false }));
    expect(q.list("p1")[0]).toMatchObject({
      state: "error", errorCode: "FLASH_UNVERIFIED", outcome: { kind: "flashed", verified: false },
    });
  });

  test("carries a verified write's own verdict", async () => {
    const q = new TaskQueue(() => 0);
    await q.enqueue({ ...meta("d1"), kind: "download" }, async () => ({ kind: "flashed", verified: true }));
    expect(q.list("p1")[0]).toMatchObject({ state: "done", outcome: { kind: "flashed", verified: true } });
  });

  test("scopes listed tasks to the project", async () => {
    const q = new TaskQueue(() => 0);
    await q.enqueue({ ...meta("d1"), projectId: "p1" }, async () => undefined);
    await q.enqueue({ ...meta("d2"), projectId: "p2" }, async () => undefined);
    expect(q.list("p1").map((t) => t.deviceId)).toEqual(["d1"]);
    expect(q.list("p2").map((t) => t.deviceId)).toEqual(["d2"]);
  });

  test("cancels a queued task before it runs", async () => {
    const q = new TaskQueue(() => 0);
    const gate = defer();
    const j1 = q.enqueue(meta("d1"), async () => { await gate.p; });
    const j2 = q.enqueue(meta("d2"), async () => 99);
    await Promise.resolve();
    const id2 = q.list("p1").find((t) => t.deviceId === "d2")!.id;
    expect(q.cancel(id2)).toBe("queued");
    expect(q.list("p1").find((t) => t.deviceId === "d2")!.state).toBe("cancelled");
    gate.resolve();
    await j1;
    expect(j2).rejects.toThrow(); // never ran
  });

  test("cancels a running read via its abort signal", async () => {
    const q = new TaskQueue(() => 0);
    const job = q.enqueue(meta("d1"), (_progress, signal) =>
      new Promise<void>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("read aborted")))));
    await Promise.resolve();
    const task = q.list("p1")[0];
    expect(task.state).toBe("running");
    expect(q.cancel(task.id)).toBe("running");
    expect(job).rejects.toThrow();
    expect(q.list("p1")[0].state).toBe("cancelled");
  });

  test("refuses to cancel a running flash (would corrupt the device)", async () => {
    const q = new TaskQueue(() => 0);
    const gate = defer();
    const job = q.enqueue({ ...meta("d1"), kind: "flash-params", writes: true }, async () => { await gate.p; return "ok"; });
    await Promise.resolve();
    const id = q.list("p1")[0].id;
    expect(q.cancel(id)).toBeNull();
    expect(q.list("p1")[0].state).toBe("running");
    gate.resolve();
    expect(await job).toBe("ok");
  });

  test("submit returns the queued task at once; wait collects its outcome", async () => {
    const q = new TaskQueue(() => 0);
    const gate = defer();
    const task = q.submit({ ...meta("d1"), kind: "download", writes: true }, async () => { await gate.p; return { kind: "flashed", verified: true }; });
    expect(task).toMatchObject({ state: "queued", writes: true, result: null });
    gate.resolve();
    expect(await q.wait(task.id)).toMatchObject({ state: "done", result: { kind: "flashed", verified: true } });
  });

  test("a submitted job's failure stays in its task", async () => {
    const q = new TaskQueue(() => 0);
    const task = q.submit({ ...meta("d1"), kind: "flash-params", writes: true }, async () => { throw new ApiError("MASK_MISMATCH", "wrong mask"); });
    expect(await q.wait(task.id)).toMatchObject({ state: "error", errorCode: "MASK_MISMATCH" });
  });

  test("refuses a second write to the same device while one is queued or running", async () => {
    const q = new TaskQueue(() => 0);
    const gate = defer();
    const first = q.submit({ ...meta("d1"), kind: "flash-params", writes: true }, async () => { await gate.p; });
    expect(() => q.submit({ ...meta("d1"), kind: "download", writes: true }, async () => undefined)).toThrow("already");
    // Reads and other devices are not writes to this device.
    q.submit(meta("d1"), async () => undefined);
    q.submit({ ...meta("d2"), kind: "flash-params", writes: true }, async () => undefined);
    gate.resolve();
    await q.wait(first.id);
    expect(() => q.refuseConcurrentWrite("p1", "d1")).not.toThrow();
  });

  test("commit records the baseline adoption with the adoption itself", async () => {
    const q = new TaskQueue(() => 0);
    let adopted = false;
    const task = q.submit({ ...meta("d1"), kind: "flash-params", writes: true }, async (_p, _s, commit) => {
      const r = { kind: "flashed", verified: true };
      commit(r, () => { adopted = true; });
      return r;
    });
    expect(await q.wait(task.id)).toMatchObject({ state: "done", baselineCommitted: true });
    expect(adopted).toBe(true);
  });

  test("an adoption that throws leaves the baseline uncommitted and the task failed", async () => {
    const q = new TaskQueue(() => 0);
    const task = q.submit({ ...meta("d1"), kind: "flash-params", writes: true }, async (_p, _s, commit) => {
      commit({ kind: "flashed", verified: true }, () => { throw new Error("db locked"); });
      return { kind: "flashed", verified: true };
    });
    expect(await q.wait(task.id)).toMatchObject({ state: "error", error: "db locked", baselineCommitted: false });
  });
});

test("a task whose end the store cannot record is still reported finished, and releases its device", async () => {
  const store = new MemoryTaskStore();
  const q = new TaskQueue(() => 0, undefined, {
    save: (t) => { if (t.finishedAt !== null) throw new Error("disk full"); store.save(t); },
    commit: (t, adopt) => store.commit(t, adopt), get: (id) => store.get(id), recent: (p, since) => store.recent(p, since),
  });
  const task = q.submit({ ...meta("d1"), kind: "download", writes: true }, async () => ({ kind: "flashed", verified: true }));
  expect(await q.wait(task.id)).toMatchObject({ state: "done" });
  expect(q.list("p1")[0].state).toBe("done");
  expect(() => q.refuseConcurrentWrite("p1", "d1")).not.toThrow();
});

test("a job whose start the store cannot record never runs, fails, and releases its device", async () => {
  const store = new MemoryTaskStore();
  let failStart = true, ran = false;
  const q = new TaskQueue(() => 0, undefined, {
    save: (t) => { if (t.state === "running" && failStart) throw new Error("database is locked"); store.save(t); },
    commit: (t, adopt) => store.commit(t, adopt), get: (id) => store.get(id), recent: (p, since) => store.recent(p, since),
  });
  const task = q.submit({ ...meta("d1"), kind: "download", writes: true }, async () => { ran = true; });
  expect(await q.wait(task.id)).toMatchObject({ state: "error", error: "database is locked" });
  expect(ran).toBe(false);
  failStart = false;
  expect(() => q.refuseConcurrentWrite("p1", "d1")).not.toThrow();
});

test("a phase the store cannot record does not abort the write", async () => {
  const store = new MemoryTaskStore();
  const q = new TaskQueue(() => 0, undefined, {
    save: (t) => { if (t.phase === "write" && t.finishedAt === null) throw new Error("disk full"); store.save(t); },
    commit: (t, adopt) => store.commit(t, adopt), get: (id) => store.get(id), recent: (p, since) => store.recent(p, since),
  });
  const task = q.submit({ ...meta("d1"), kind: "download", writes: true }, async (progress) => { progress("write", 1, 2); return { kind: "flashed", verified: true }; });
  expect(await q.wait(task.id)).toMatchObject({ state: "done" });
});

test("a job the store cannot even queue is refused and leaves nothing behind", () => {
  const q = new TaskQueue(() => 0, undefined, {
    save: () => { throw new Error("read-only database"); },
    commit: () => {}, get: () => null, recent: () => [],
  });
  expect(() => q.submit({ ...meta("d1"), kind: "download", writes: true }, async () => undefined)).toThrow("read-only database");
  expect(() => q.refuseConcurrentWrite("p1", "d1")).not.toThrow();
});

describe("SqliteTaskStore", () => {
  const store = () => { const db = openDb(":memory:"); return { db, store: new SqliteTaskStore(db) }; };

  test("persists every transition, result included", async () => {
    const { store: s } = store();
    const q = new TaskQueue(() => 5, undefined, s);
    const gate = defer();
    const task = q.submit({ ...meta("d1"), kind: "flash-params", writes: true, snapshotId: "snap" }, async (progress) => {
      progress("write", 1, 4);
      await gate.p;
      return { kind: "flashed", verified: true, diffBytes: 3 };
    });
    await Promise.resolve();
    expect(s.get(task.id)).toMatchObject({ state: "running", phase: "write", snapshotId: "snap", writes: true });
    gate.resolve();
    await q.wait(task.id);
    expect(s.get(task.id)).toMatchObject({ state: "done", result: { diffBytes: 3 }, outcome: { kind: "flashed", verified: true }, finishedAt: 5 });
  });

  test("a failed adoption rolls back with the task record", async () => {
    const { db, store: s } = store();
    db.run("CREATE TABLE marker (v TEXT)");
    const q = new TaskQueue(() => 0, undefined, s);
    const task = q.submit({ ...meta("d1"), kind: "flash-params", writes: true }, async (_p, _s, commit) => {
      commit({ kind: "flashed", verified: true }, () => { db.run("INSERT INTO marker VALUES ('half')"); throw new Error("adopt failed"); });
    });
    expect(await q.wait(task.id)).toMatchObject({ state: "error", baselineCommitted: false });
    expect(db.query("SELECT count(*) AS n FROM marker").get()).toEqual({ n: 0 });
  });

  test("closes unfinished tasks at startup with what is known about each", () => {
    const { db, store: s } = store();
    const base = { projectId: "p1", deviceName: "x", ia: "1.1.1", snapshotId: null, phase: null, done: 0, total: 0, error: null, errorCode: null, outcome: null, result: null, queuedAt: 1, startedAt: 1, finishedAt: null };
    s.save({ ...base, id: "queued", deviceId: "a", kind: "download", writes: true, state: "queued", baselineCommitted: false });
    s.save({ ...base, id: "writing", deviceId: "b", kind: "download", writes: true, state: "running", baselineCommitted: false });
    s.save({ ...base, id: "committed", deviceId: "c", kind: "flash-params", writes: true, state: "running", baselineCommitted: true, result: { kind: "flashed", verified: true } });
    s.save({ ...base, id: "reading", deviceId: "d", kind: "read", writes: false, state: "running", baselineCommitted: false });
    s.save({ ...base, id: "finished", deviceId: "e", kind: "read", writes: false, state: "done", baselineCommitted: false, finishedAt: 1 });
    closeUnfinishedTasks(db, 9);
    expect(s.get("queued")).toMatchObject({ state: "cancelled", errorCode: "TASK_NOT_STARTED", finishedAt: 9 });
    expect(s.get("writing")).toMatchObject({ state: "interrupted", errorCode: "TASK_WRITE_INTERRUPTED", finishedAt: 9 });
    expect(s.get("committed")).toMatchObject({ state: "done", errorCode: null, baselineCommitted: true });
    expect(s.get("reading")).toMatchObject({ state: "interrupted", errorCode: "TASK_READ_INTERRUPTED" });
    expect(s.get("finished")).toMatchObject({ state: "done", finishedAt: 1 });
  });
});
