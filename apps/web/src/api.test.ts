import { test, expect, describe, afterEach } from "bun:test";
import { awaitTask, ApiError, type Task } from "./api.ts";

const base: Task = {
  id: "t1", projectId: "p", deviceId: "d", deviceName: "Dev", ia: "1.1.1", kind: "download", writes: true, snapshotId: null,
  state: "queued", phase: null, done: 0, total: 0, error: null, errorCode: null, result: null, baselineCommitted: false,
  queuedAt: 0, startedAt: null, finishedAt: null,
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
// Serve the task's successive states to the poll; a thrown entry is a network failure.
function serve(states: (Partial<Task> | Error)[]) {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    const next = states.shift();
    if (!next) throw new Error("polled past the end");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ ...base, ...next }), { status: 200 });
  }) as typeof fetch;
  return seen;
}

describe("awaitTask", () => {
  test("polls the submitted task by id until it finishes and returns its result", async () => {
    const seen = serve([{ state: "running", phase: "write" }, { state: "done", result: { kind: "flashed", verified: true } }]);
    const tasks: Task[] = [];
    const r = await awaitTask<unknown>("p", Promise.resolve(base), (t) => tasks.push(t), 1);
    expect(r).toEqual({ kind: "flashed", verified: true });
    expect(seen).toEqual(["/api/projects/p/tasks/t1", "/api/projects/p/tasks/t1"]);
    expect(tasks[0].id).toBe("t1"); // the caller learns its own task at submission
  });

  test("hands back an unverified write as the result it is", async () => {
    serve([{ state: "error", errorCode: "FLASH_UNVERIFIED", result: { kind: "flashed", verified: false } }]);
    expect(await awaitTask<unknown>("p", Promise.resolve(base), undefined, 1)).toEqual({ kind: "flashed", verified: false });
  });

  test("throws an interrupted write with its code", async () => {
    serve([{ state: "interrupted", errorCode: "TASK_WRITE_INTERRUPTED", error: "server stopped" }]);
    const e = await awaitTask<unknown>("p", Promise.resolve(base), undefined, 1).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("TASK_WRITE_INTERRUPTED");
  });

  test("a cancelled task without a code still fails with one", async () => {
    serve([{ state: "cancelled" }]);
    const e = await awaitTask<unknown>("p", Promise.resolve(base), undefined, 1).catch((x) => x);
    expect((e as ApiError).code).toBe("TASK_CANCELLED");
  });

  test("keeps polling through a server outage, and gives up with TASK_CONTACT_LOST", async () => {
    serve([new TypeError("fetch failed"), { state: "done", result: { kind: "unchanged" } }]);
    expect(await awaitTask<unknown>("p", Promise.resolve(base), undefined, 1)).toEqual({ kind: "unchanged" });
    serve(Array.from({ length: 60 }, () => new TypeError("fetch failed")));
    const e = await awaitTask<unknown>("p", Promise.resolve(base), undefined, 1).catch((x) => x);
    expect((e as ApiError).code).toBe("TASK_CONTACT_LOST");
  });
});
