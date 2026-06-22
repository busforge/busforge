import { test, expect, describe } from "bun:test";
import { TaskQueue } from "../src/taskqueue.ts";

const meta = (deviceId: string) => ({ projectId: "p1", deviceId, deviceName: deviceId, ia: "1.1.1", kind: "read" as const });
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
    await expect(j1).rejects.toThrow("boom");
    expect(await j2).toBe(42);
    const tasks = q.list("p1");
    expect(tasks.find((t) => t.deviceId === "d1")?.state).toBe("error");
    expect(tasks.find((t) => t.deviceId === "d1")?.error).toBe("boom");
    expect(tasks.find((t) => t.deviceId === "d2")?.state).toBe("done");
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

  test("prunes finished tasks past the retention window, keeps active ones", async () => {
    let clock = 1000;
    const q = new TaskQueue(() => clock);
    await q.enqueue(meta("old"), async () => undefined);
    expect(q.list("p1").length).toBe(1);
    clock += 30_000; // advance past the 20s retention
    expect(q.list("p1").length).toBe(0);
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
    await expect(j2).rejects.toThrow(); // never ran
  });

  test("cancels a running read via its abort signal", async () => {
    const q = new TaskQueue(() => 0);
    const job = q.enqueue(meta("d1"), (_progress, signal) =>
      new Promise<void>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("read aborted")))));
    await Promise.resolve();
    const task = q.list("p1")[0];
    expect(task.state).toBe("running");
    expect(q.cancel(task.id)).toBe("running");
    await expect(job).rejects.toThrow();
    expect(q.list("p1")[0].state).toBe("cancelled");
  });

  test("refuses to cancel a running flash (would corrupt the device)", async () => {
    const q = new TaskQueue(() => 0);
    const gate = defer();
    const job = q.enqueue({ ...meta("d1"), kind: "flash-params" }, async () => { await gate.p; return "ok"; });
    await Promise.resolve();
    const id = q.list("p1")[0].id;
    expect(q.cancel(id)).toBeNull();
    expect(q.list("p1")[0].state).toBe("running");
    gate.resolve();
    expect(await job).toBe("ok");
  });
});
