import { test, expect, describe, mock, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { APCI, iaToNum } from "@busforge/knx";
import type { Connection } from "../src/db/connections.ts";
import { SimSystemB, ALLOWED_APCIS } from "../../../packages/product/test/collect-sim.ts";

// POST .../collect runs raw acquisition as a queued bus job against a simulated device: it sends read
// services only, writes its package as a file, and leaves every table of the database but the task
// list exactly as it was.

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

async function setup(): Promise<{ state: AppState; projectId: string; deviceId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-collect-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir });
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
  return { state, projectId: imp.id, deviceId: proj.devices[0].id };
}

// Every row of every table but the task list, which records the job itself.
function dump(db: Database): Record<string, unknown[]> {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'tasks' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, db.query(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}

describe("POST /collect", () => {
  test("reads only, writes its package, and leaves the database as it was", async () => {
    sims = []; silent = () => false;
    const { state, projectId, deviceId } = await setup();
    const before = dump(state.db);
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}/collect`, { method: "POST" }), state))!;
    expect(res.status).toBe(202);
    const task = (await res.json()) as { id: string; kind: string; writes: boolean };
    expect(task).toMatchObject({ kind: "collect", writes: false });
    const done = await state.queue.wait(task.id);
    expect(done?.state).toBe("done");
    expect(done?.outcome).toEqual({ kind: "complete" });
    expect(dump(state.db)).toEqual(before);

    for (const a of sims.flatMap((s) => s.apcis)) expect(ALLOWED_APCIS.has(a)).toBe(true);
    const pkgRes = (await handleApi(req(`/api/projects/${projectId}/collections/${task.id}`), state))!;
    expect(pkgRes.status).toBe(200);
    const pkg = (await pkgRes.json()) as any;
    expect(pkg).toMatchObject({ format: "busforge-raw-collect/1", taskId: task.id, mask: "MV-07B0", stop: null, error: null });
    expect(pkg.provenance.transport).toMatchObject({ kind: "ip", route: "198.51.100.10:3671" });
    expect(pkg.provenance.busReleasedAt).toBeGreaterThanOrEqual(pkg.provenance.busTakenAt);
    expect(pkg.records.some((r: any) => r.outcome === "refused")).toBe(true);
  });

  test("a device that stops answering still leaves its package, with what it read", async () => {
    process.env.KNX_TRIES = "1";
    sims = [];
    let gone = false;
    silent = (a) => (gone ||= a === APCI.MEMORY_READ);
    try {
      const { state, projectId, deviceId } = await setup();
      const res = (await handleApi(req(`/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}/collect`, { method: "POST" }), state))!;
      const task = (await res.json()) as { id: string };
      expect((await state.queue.wait(task.id))?.outcome).toEqual({ kind: "stopped:unresponsive" });
      const pkg = (await (await handleApi(req(`/api/projects/${projectId}/collections/${task.id}`), state))!.json()) as any;
      expect(pkg.records.find((r: any) => r.step === "descriptor").outcome).toBe("bytes");
    } finally { delete process.env.KNX_TRIES; }
  }, 20_000);

  test("a link that fails is the task's failure, and the package still says so", async () => {
    sims = []; silent = () => false;
    const { state, projectId, deviceId } = await setup();
    makeImpl = () => ({ assignedIa: 0, onCemi: null, onClosed: null, connect: async () => { throw Object.assign(new Error("gateway gone"), { code: "TUNNEL_CONNECT_TIMEOUT" }); }, sendCemi: async () => {}, disconnect: async () => {} });
    try {
      const res = (await handleApi(req(`/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}/collect`, { method: "POST" }), state))!;
      const task = (await res.json()) as { id: string };
      expect(await state.queue.wait(task.id)).toMatchObject({ state: "error", errorCode: "COLLECT_FAILED" });
      const pkg = (await (await handleApi(req(`/api/projects/${projectId}/collections/${task.id}`), state))!.json()) as any;
      expect(pkg).toMatchObject({ stop: { reason: "interface" }, error: expect.stringContaining("gateway gone"), records: [] });
    } finally {
      makeImpl = () => { const s = new SimSystemB(); Object.assign(s, { device: deviceIa }); s.silent = silent; sims.push(s); return s; };
    }
  });

  test("an unknown package is a 404, and a path that is no task id never reaches the disk", async () => {
    const { state, projectId } = await setup();
    expect((await handleApi(req(`/api/projects/${projectId}/collections/00000000-0000-0000-0000-000000000000`), state))!.status).toBe(404);
    expect((await handleApi(req(`/api/projects/${projectId}/collections/..%2F..%2Fbusforge.db`), state))!.status).toBe(404);
  });
});
