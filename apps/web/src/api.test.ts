import { test, expect, describe, afterEach } from "bun:test";
import { api, awaitTask, ApiError, type Task } from "./api.ts";

const base: Task = {
  id: "t1", projectId: "p", deviceId: "d", deviceName: "Dev", ia: "1.1.1", kind: "download", writes: true, snapshotId: null,
  state: "queued", phase: null, done: 0, total: 0, error: null, errorCode: null, errorDetails: null, result: null, baselineCommitted: false,
  queuedAt: 0, startedAt: null, finishedAt: null, cancellable: true,
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

  test("throws a refusal with its code and the facts behind it", async () => {
    serve([{ state: "error", errorCode: "READBACK_ASSUMPTION_UNRESOLVED", error: "still unresolved", errorDetails: { objects: [20] } }]);
    const e = await awaitTask<unknown>("p", Promise.resolve(base), undefined, 1).catch((x) => x);
    expect([(e as ApiError).code, (e as ApiError).details]).toEqual(["READBACK_ASSUMPTION_UNRESOLVED", { objects: [20] }]);
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

describe("readBackDevice", () => {
  test("submits the read, waits for its task, and hands back the refreshed view with what the read covered", async () => {
    const seen: string[] = [];
    const readback = { paramsRead: true, linksRead: true, linkGaps: 0 };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/read-back")) return new Response(JSON.stringify({ ...base, kind: "read", writes: false }), { status: 202 });
      if (url.includes("/tasks/")) return new Response(JSON.stringify({ ...base, kind: "read", writes: false, state: "done", result: readback }), { status: 200 });
      return new Response(JSON.stringify({ blocks: [] }), { status: 200 });
    }) as typeof fetch;
    expect(await api.readBackDevice("p", "d", "de", undefined, 1)).toEqual({ blocks: [], readback } as never);
    expect(seen).toEqual(["POST /api/projects/p/devices/d/read-back", "GET /api/projects/p/tasks/t1", "GET /api/projects/p/devices/d/config?lang=de"]);
  });

  test("a read that ended but whose view cannot be fetched is not reported as a failed read", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/read-back")) return new Response(JSON.stringify({ ...base, kind: "read", writes: false }), { status: 202 });
      if (url.includes("/tasks/")) return new Response(JSON.stringify({ ...base, kind: "read", writes: false, state: "done", result: { paramsRead: true, linksRead: true, linkGaps: 0 } }), { status: 200 });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const e = await api.readBackDevice("p", "d", "de", undefined, 1).catch((x) => x);
    expect((e as ApiError).code).toBe("READBACK_VIEW_UNAVAILABLE");
  });
});
