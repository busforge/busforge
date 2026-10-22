import { test, expect, describe, mock, afterAll, setDefaultTimeout } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { APCI, iaToNum } from "@busforge/knx";
import type { Connection } from "../src/db/connections.ts";
import { SimSystemB, ALLOWED_APCIS } from "../../../packages/product/test/collect-sim.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 4.5 s with the
// file alone (load 5-27) and up to 4.5 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(100_000);

// POST .../collect runs raw acquisition as a queued bus job against a simulated device: it sends read
// services only, keeps its cleaned diagnostic package in memory on the job (never on disk), and leaves
// every table of the database but the task list exactly as it was. A cancel leaves no package.

let deviceIa = 0;
let sims: SimSystemB[] = [];
let silent: (apci: number) => boolean = () => false;
const realTransport = await import("../src/transport.ts");
const realMake = realTransport.makeTransport;
let makeImpl: typeof realMake = () => { const s = new SimSystemB(); Object.assign(s, { device: deviceIa }); s.silent = silent; sims.push(s); return s; };
await mock.module("../src/transport.ts", () => ({ ...realTransport, makeTransport: (c: Connection) => makeImpl(c) }));
const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;
afterAll(() => { makeImpl = realMake; });

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));
const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

async function setup(now?: () => number): Promise<{ state: AppState; projectId: string; deviceId: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-collect-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now });
  const form = new FormData();
  form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
  const conn = (await (await handleApi(req("/api/connections", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }),
  }), state))!.json()) as any;
  await handleApi(req(`/api/projects/${imp.id}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }) }), state);
  deviceIa = iaToNum(proj.devices[0].ia);
  return { state, projectId: imp.id, deviceId: proj.devices[0].id, dir };
}
const collect = async (state: AppState, projectId: string, deviceId: string) =>
  (await (await handleApi(req(`/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}/collect`, { method: "POST" }), state))!.json()) as { id: string };
const diagnostic = (state: AppState, projectId: string, taskId: string) => handleApi(req(`/api/projects/${projectId}/diagnostics/${taskId}`), state).then((r) => r!);
// Every file under the data directory, to show the package never reaches the disk.
const files = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.startsWith("catalog") && !f.endsWith("master.key")).sort();

// Every row of every table but the task list, which records the job itself.
function dump(db: Database): Record<string, unknown[]> {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'tasks' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, db.query(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}

describe("POST /collect", () => {
  test("reads only, keeps its cleaned package on the job, and leaves the database and the disk as they were", async () => {
    sims = []; silent = () => false;
    const { state, projectId, deviceId, dir } = await setup();
    const before = dump(state.db);
    const filesBefore = files(dir);
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}/collect`, { method: "POST" }), state))!;
    expect(res.status).toBe(202);
    const task = (await res.json()) as { id: string; kind: string; writes: boolean };
    expect(task).toMatchObject({ kind: "collect", writes: false });
    const done = await state.queue.wait(task.id);
    expect(done?.state).toBe("done");
    expect(done?.outcome).toEqual({ kind: "complete" });
    // The task counted its requests as it went.
    expect(done?.done).toBeGreaterThan(0);
    expect(dump(state.db)).toEqual(before);
    expect(files(dir)).toEqual(filesBefore);

    for (const a of sims.flatMap((s) => s.apcis)) expect(ALLOWED_APCIS.has(a)).toBe(true);
    const pkgRes = await diagnostic(state, projectId, task.id);
    expect(pkgRes.status).toBe(200);
    const pkg = (await pkgRes.json()) as any;
    expect(pkg).toMatchObject({ format: "busforge-diagnostic/1", mask: "MV-07B0", stop: null, error: null, connection: { kind: "ip", ipTransport: "auto" } });
    expect(pkg.bus.releasedAt).toBeGreaterThanOrEqual(pkg.bus.takenAt);
    expect(pkg.records.some((r: any) => r.outcome === "refused")).toBe(true);
    // Nothing that names the installation's ids, the gateway or the device's serial.
    const text = JSON.stringify(pkg);
    for (const s of [projectId, deviceId, task.id, "198.51.100.10", "00fa01020304"]) expect(text).not.toContain(s);
    expect(pkg.records.filter((r: any) => r.removed === "serial number, 6 bytes").length).toBeGreaterThan(0);
    // Another project does not see it.
    expect((await diagnostic(state, "00000000-0000-0000-0000-000000000000", task.id)).status).toBe(404);
  });

  test("a device that stops answering still leaves its package, marked as stopped, with what it read", async () => {
    process.env.KNX_TRIES = "1";
    sims = [];
    let gone = false;
    silent = (a) => (gone ||= a === APCI.MEMORY_READ);
    try {
      const { state, projectId, deviceId } = await setup();
      const task = await collect(state, projectId, deviceId);
      expect((await state.queue.wait(task.id))?.outcome).toEqual({ kind: "stopped:unresponsive" });
      const pkg = (await (await diagnostic(state, projectId, task.id)).json()) as any;
      expect(pkg.stop.reason).toBe("unresponsive");
      expect(pkg.records.find((r: any) => r.step === "descriptor").outcome).toBe("bytes");
    } finally { delete process.env.KNX_TRIES; }
  }, 100_000);

  test("a cancelled job leaves no package, and nothing it read survives", async () => {
    sims = [];
    const { state, projectId, deviceId, dir } = await setup();
    const filesBefore = files(dir);
    let taskId = "";
    silent = (a) => { if (a === APCI.PROPERTY_DESCRIPTION_READ && taskId) state.queue.cancel(taskId); return false; };
    try {
      const task = await collect(state, projectId, deviceId);
      taskId = task.id;
      expect((await state.queue.wait(task.id))?.state).toBe("cancelled");
      expect(sims.flatMap((s) => s.apcis)).toContain(APCI.PROPERTY_DESCRIPTION_READ);
      expect((await diagnostic(state, projectId, task.id)).status).toBe(404);
      expect(files(dir)).toEqual(filesBefore);
    } finally { silent = () => false; }
  });

  test("a link that fails is the task's failure, and the package still says so", async () => {
    sims = []; silent = () => false;
    const { state, projectId, deviceId } = await setup();
    makeImpl = () => ({ assignedIa: 0, onCemi: null, onClosed: null, connect: async () => { throw Object.assign(new Error("gateway 198.51.100.10:3671 gone"), { code: "TUNNEL_CONNECT_TIMEOUT" }); }, sendCemi: async () => {}, disconnect: async () => {} });
    try {
      const task = await collect(state, projectId, deviceId);
      expect(await state.queue.wait(task.id)).toMatchObject({ state: "error", errorCode: "COLLECT_FAILED" });
      const pkg = (await (await diagnostic(state, projectId, task.id)).json()) as any;
      expect(pkg).toMatchObject({ stop: { reason: "interface" }, error: "TUNNEL_CONNECT_TIMEOUT: gateway <removed> gone", records: [] });
    } finally {
      makeImpl = () => { const s = new SimSystemB(); Object.assign(s, { device: deviceIa }); s.silent = silent; sims.push(s); return s; };
    }
  });

  test("a cancel that arrives after the read finished still drops its package, for its project only", async () => {
    sims = []; silent = () => false;
    const { state, projectId, deviceId } = await setup();
    const task = await collect(state, projectId, deviceId);
    await state.queue.wait(task.id);
    const cancel = (p: string) => handleApi(req(`/api/projects/${p}/tasks/${task.id}/cancel`, { method: "POST" }), state).then((r) => r!);
    expect((await cancel("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await diagnostic(state, projectId, task.id)).status).toBe(200);
    const res = await cancel(projectId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: "discarded" });
    expect((await diagnostic(state, projectId, task.id)).status).toBe(404);
  });

  test("a package lives at most a day after its job", async () => {
    sims = []; silent = () => false;
    let clock = 1_000_000;
    const { state, projectId, deviceId } = await setup(() => clock);
    const task = await collect(state, projectId, deviceId);
    await state.queue.wait(task.id);
    clock += 24 * 60 * 60_000 - 1;
    expect((await diagnostic(state, projectId, task.id)).status).toBe(200);
    clock += 1;
    expect((await diagnostic(state, projectId, task.id)).status).toBe(404);
  });

  test("an unknown task has no package", async () => {
    const { state, projectId } = await setup();
    const res = await diagnostic(state, projectId, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("DIAGNOSTIC_NOT_FOUND");
  });
});
