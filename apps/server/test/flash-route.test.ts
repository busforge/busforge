import { test, expect, describe, mock, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setDeviceParam, setDeviceLink, getDeviceChangedKeys } from "../src/db/deviceparams.ts";
import { deviceParamRefs } from "../src/deviceservice.ts";
import type { FlashResult } from "../src/deviceprofile.ts";

// Route-level fake-green lock for the flash endpoints: the baseline (device_param_base /
// device_link_base) may ONLY be adopted after a flash the profile layer POSITIVELY
// verified on the device. An unverified or dry-run result must leave the drift markers
// untouched. The profile layer is stubbed via mock.module so no bus/transport is needed;
// everything below the route boundary is the real server code.

// Import the REAL module first and pin the genuine functions as consts: mock.module
// replaces the module's exports in place, so a later `real.flashDeviceParameters`
// property access would hand back our own wrapper (infinite recursion).
const real = await import("../src/deviceprofile.ts");
const realParamFlash = real.flashDeviceParameters;
const realGaFlash = real.flashDeviceGroupAddresses;

// Mutable delegation targets. Default = the real implementations, and afterAll restores
// them, so if the module mock leaks into later test files (bun does not auto-unmock),
// behavior there is indistinguishable from the unmocked module.
let paramFlashImpl: typeof realParamFlash = realParamFlash;
let gaFlashImpl: typeof realGaFlash = realGaFlash;

mock.module("../src/deviceprofile.ts", () => ({
  ...real, // classify, readDeviceState, secureIdentify, profiles, ... stay real
  flashDeviceParameters: (opts: Parameters<typeof realParamFlash>[0]) => paramFlashImpl(opts),
  flashDeviceGroupAddresses: (opts: Parameters<typeof realGaFlash>[0]) => gaFlashImpl(opts),
}));

// app.ts must be imported AFTER the mock so its route handlers bind the wrappers.
const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;

afterAll(() => { paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; });

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));
const realAppXml = gunzipSync(readFileSync(join(
  import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "real", "M-0081_A-FE01-11-75D9.xml.gz",
))).toString("utf8");

// Hand-chosen refs from the real M-0081 app program: P-4_R-4 is a memory-backed
// Value-typed parameter (image-writable, so a verified flash adopts it into the
// baseline), O-0_R-63 is com-object 0 in the default view (so a GA flash covers it).
const PARAM_REF = "M-0081_A-FE01-11-75D9_P-4_R-4";
const LINK_KEY = "O-0_R-63";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
function freshState(): AppState {
  const dir = mkdtempSync(join(tmpdir(), "busforge-flashroute-"));
  tmps.push(dir);
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

// Import the demo project, swap its device's application program for the real M-0081
// (MV-0705, flashParams+flashLinks capable), and point the project at a saved connection
// so the route passes isConnectionReady. Same setup pattern as server.test.ts.
async function m0081Project(state: AppState): Promise<{ projectId: string; deviceId: string }> {
  const form = new FormData();
  form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
  state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [realAppXml, "M-TEST_A-1"]);
  const conn = (await (await handleApi(req("/api/connections", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }),
  }), state))!.json()) as any;
  await handleApi(req(`/api/projects/${imp.id}/connection`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }),
  }), state);
  return { projectId: imp.id, deviceId: proj.devices[0].id };
}

const flashed = (verified: boolean): FlashResult =>
  ({ kind: "flashed", mask: "MV-0705", imageBytes: 1, diffBytes: 1, verified, backup: "x" });

describe("POST /flash: baseline adoption is gated on verified", () => {
  test("verified:false -> 200, but the param baseline is NOT adopted (drift stays)", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1"); // drift: live-only override
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);

    paramFlashImpl = async (opts) => { expect(opts.dryRun).toBe(false); return flashed(false); }; // a real flash must not arrive as dry
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).kind).toBe("flashed"); // the mock was reached, not a guard

    // The fake-green lock: nothing was confirmed on the device, so the change marker survives.
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);
  });

  test("verified:true -> the changed param IS adopted into the baseline", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);

    paramFlashImpl = async () => flashed(true);
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).verified).toBe(true);

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(false);
  });

  test("dryRun (?dry=1) -> baseline untouched", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");

    // The dry flag must actually cross the route boundary: a route regression that drops
    // ?dry=1 would flash real hardware while this test's stub kept everything green.
    paramFlashImpl = async (opts) => { expect(opts.dryRun).toBe(true); return { kind: "dryRun", mask: "MV-0705", imageBytes: 1, diffBytes: 1, backup: "x" }; };
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash?dry=1`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).kind).toBe("dryRun");

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);
  });
});

describe("POST /flash: keepDrift wiring for params the flash can never write", () => {
  test("a memory-backed TEXT override keeps its changed chip across a verified flash; a VALUE override is adopted", async () => {
    const state = freshState();
    // M-0083 A-0137 (System B) carries memory-backed TypeText params. The image codec
    // cannot represent text, so a flash never writes them; adopting such an override
    // into the baseline would fake it as programmed.
    const a0137 = gunzipSync(readFileSync(join(
      import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "real", "M-0083_A-0137-20-7EB2.xml.gz",
    ))).toString("utf8");
    const form = new FormData();
    form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
    form.set("password", "tester12");
    const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
    const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
    state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [a0137, "M-TEST_A-1"]);
    const conn = (await (await handleApi(req("/api/connections", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }),
    }), state))!.json()) as any;
    await handleApi(req(`/api/projects/${imp.id}/connection`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }),
    }), state);
    const projectId = imp.id, deviceId = proj.devices[0].id;

    const TEXT_REF = "M-0083_A-0137-20-7EB2_P-162_R-162";  // memory-backed TypeText (unwritable)
    const VALUE_REF = "M-0083_A-0137-20-7EB2_P-1_R-1";     // memory-backed Value (writable)
    setDeviceParam(state.db, projectId, deviceId, TEXT_REF, "Kanalname");
    setDeviceParam(state.db, projectId, deviceId, VALUE_REF, "1");
    const before = getDeviceChangedKeys(state.db, projectId, deviceId).params;
    expect(before.has(TEXT_REF)).toBe(true);
    expect(before.has(VALUE_REF)).toBe(true);

    paramFlashImpl = async () => flashed(true);
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);

    const after = getDeviceChangedKeys(state.db, projectId, deviceId).params;
    expect(after.has(VALUE_REF)).toBe(false); // written and verified -> adopted
    expect(after.has(TEXT_REF)).toBe(true);   // never written -> the drift chip survives
  });

  test("a HIDDEN (inactive) override with a writable type keeps its drift chip; a visible one is adopted", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    // P-16_R-16 is a memory-backed Value(8-bit) param on M-0081 that the default dynamic
    // structure hides: it is NOT in the active config view, so buildAbsoluteSegmentTargets
    // skips it (active.get(ref) === undefined) and the flash never writes it. Its type is
    // perfectly image-writable, so the old unflashableParamRefs (type-only) would have
    // adopted it into the baseline, fabricating "in sync" for a value that never reached
    // the device. PARAM_REF (P-4_R-4) is visible and genuinely written.
    const HIDDEN_REF = "M-0081_A-FE01-11-75D9_P-16_R-16";
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");
    setDeviceParam(state.db, projectId, deviceId, HIDDEN_REF, "1");
    // Precondition: the hidden ref really is outside the active view (guards against the
    // fixture/setup accidentally making it visible, which would invalidate the assertion).
    const active = deviceParamRefs(state, projectId, deviceId);
    expect(active.has(PARAM_REF)).toBe(true);
    expect(active.has(HIDDEN_REF)).toBe(false);
    const before = getDeviceChangedKeys(state.db, projectId, deviceId).params;
    expect(before.has(PARAM_REF)).toBe(true);
    expect(before.has(HIDDEN_REF)).toBe(true);

    paramFlashImpl = async () => flashed(true);
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);

    const after = getDeviceChangedKeys(state.db, projectId, deviceId).params;
    expect(after.has(PARAM_REF)).toBe(false);  // visible + written -> adopted
    expect(after.has(HIDDEN_REF)).toBe(true);  // hidden, never written -> stays drift
  });
});

describe("POST /flash-ga: link baseline adoption is gated on verified", () => {
  test("verified:false -> changed link stays as drift", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceLink(state.db, projectId, deviceId, LINK_KEY, [0x040b]); // re-point com-object 0
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).links.has(LINK_KEY)).toBe(true);

    gaFlashImpl = async () => flashed(false);
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash-ga`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).kind).toBe("flashed");

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).links.has(LINK_KEY)).toBe(true);
  });

  test("verified:true -> the changed link is adopted (resetLinkBase on the flashed refs)", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceLink(state.db, projectId, deviceId, LINK_KEY, [0x040b]);
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).links.has(LINK_KEY)).toBe(true);

    gaFlashImpl = async () => flashed(true);
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash-ga`, { method: "POST" }), state))!;
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).verified).toBe(true);

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).links.has(LINK_KEY)).toBe(false);
  });
});
