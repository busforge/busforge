import { test, expect, describe, mock, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Database } from "bun:sqlite";

// Read-back route honesty guards:
// 1) an unsupported device class is REFUSED (400) with no baseline fabricated,
// 2) device links that map to no known com-object are counted as linkGaps and kept
//    OUT of the baseline (drift there stays visible as "unknown", never fake-synced),
// 3) a cleanly-mapping read reports zero gaps and lands in the baseline.
// readDeviceState is stubbed via mock.module (same strategy as flash-route.test.ts);
// the unsupported-refusal path is fully real (it never reaches readDeviceState).

const real = await import("../src/deviceprofile.ts");
const realRead = real.readDeviceState; // pin: mock.module replaces exports in place

let readImpl: typeof realRead = realRead; // default real; restored in afterAll so a leaked mock is behavior-neutral

await mock.module("../src/deviceprofile.ts", () => ({
  ...real,
  readDeviceState: (opts: Parameters<typeof realRead>[0]) => readImpl(opts),
}));

const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;

afterAll(() => { readImpl = realRead; });

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));
const REAL_DIR = join(import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "real");
const realXml = (n: string) => gunzipSync(readFileSync(join(REAL_DIR, n))).toString("utf8");

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
function freshState(): AppState {
  const dir = mkdtempSync(join(tmpdir(), "busforge-readback-"));
  tmps.push(dir);
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

// Import the demo project, swap the device's application program for a real catalogue
// app, and attach a ready connection (same pattern as server.test.ts / flash-route).
async function projectWithApp(state: AppState, appXml: string): Promise<{ projectId: string; deviceId: string }> {
  const form = new FormData();
  form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
  state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [appXml, "M-TEST_A-1"]);
  const conn = (await (await handleApi(req("/api/connections", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }),
  }), state))!.json()) as any;
  await handleApi(req(`/api/projects/${imp.id}/connection`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }),
  }), state);
  return { projectId: imp.id, deviceId: proj.devices[0].id };
}

// Full baseline row dump, so "no baseline was created/changed" is an exact table
// comparison rather than a spot check.
const baselineRows = (db: Database, projectId: string) => ({
  params: db.query("SELECT device_id, param_ref_id, value FROM device_param_base WHERE project_id = ? ORDER BY device_id, param_ref_id").all(projectId),
  links: db.query("SELECT device_id, com_obj_ref_id, slot, ga_raw FROM device_link_base WHERE project_id = ? ORDER BY device_id, com_obj_ref_id, slot").all(projectId),
});

describe("POST /read-back", () => {
  test("unsupported device class (MV-0012) -> 400 DEVICE_READBACK_UNSUPPORTED, baseline untouched", async () => {
    const state = freshState();
    // Real M-0083 A-0138 app: mask MV-0012 (System 1 / BCU1) -> UnsupportedProfile,
    // all capabilities false. Reading it anyway would fabricate a "verified" baseline.
    const { projectId, deviceId } = await projectWithApp(state, realXml("M-0083_A-0138-21-F18E-O0072.xml.gz"));
    const before = baselineRows(state.db, projectId);

    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/read-back`, { method: "POST" }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("DEVICE_READBACK_UNSUPPORTED");

    // The no-fabricated-baseline guarantee: not a single baseline row appeared or changed.
    expect(baselineRows(state.db, projectId)).toEqual(before);
  });

  test("device link on an unknown com-object number -> counted as linkGap, kept OUT of the baseline", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml("M-0081_A-FE01-11-75D9.xml.gz"));

    // The device claims an association on com-object 9999, which exists nowhere in the
    // M-0081 app model. It must be surfaced as a gap, never invented into the baseline.
    readImpl = async () => ({
      mask: "MV-0705", paramsRead: true, linksRead: true,
      paramBase: new Map<string, string>(),
      links: [{ comObjNum: 9999, gaRaws: [123] }],
    });
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/read-back`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 1 });

    // The bogus association never entered device_link_base.
    const rows = state.db.query("SELECT ga_raw FROM device_link_base WHERE project_id = ? AND device_id = ?").all(projectId, deviceId) as { ga_raw: number }[];
    expect(rows.some((r) => r.ga_raw === 123)).toBe(false);
  });

  test("device link mapping onto a known com-object -> zero gaps and it enters the baseline", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml("M-0081_A-FE01-11-75D9.xml.gz"));

    // Com-object number 0 resolves to ref O-0_R-63 in the M-0081 default view
    // (hand-checked against the fixture), so this read maps cleanly.
    readImpl = async () => ({
      mask: "MV-0705", paramsRead: true, linksRead: true,
      paramBase: new Map<string, string>(),
      links: [{ comObjNum: 0, gaRaws: [0x040b] }],
    });
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/read-back`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 0 });

    // Positive proof the mapped link WAS folded into the baseline (and thus shows as
    // drift against the project, which has no such link).
    const rows = state.db.query("SELECT com_obj_ref_id, ga_raw FROM device_link_base WHERE project_id = ? AND device_id = ?").all(projectId, deviceId) as { com_obj_ref_id: string; ga_raw: number }[];
    expect(rows).toEqual([{ com_obj_ref_id: "O-0_R-63", ga_raw: 0x040b }]);
  });
});
