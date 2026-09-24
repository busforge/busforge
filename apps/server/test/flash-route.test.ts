import { test, expect, describe, mock, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setDeviceParam, setDeviceLink, getDeviceChangedKeys, getDeviceParamBase, replaceParamBase } from "../src/db/deviceparams.ts";
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
const realDownload = real.downloadDeviceFull;

// Mutable delegation targets. Default = the real implementations, and afterAll restores
// them, so if the module mock leaks into later test files (bun does not auto-unmock),
// behavior there is indistinguishable from the unmocked module.
let paramFlashImpl: typeof realParamFlash = realParamFlash;
let gaFlashImpl: typeof realGaFlash = realGaFlash;
let downloadImpl: typeof realDownload = realDownload;

await mock.module("../src/deviceprofile.ts", () => ({
  ...real, // classify, readDeviceState, secureIdentify, profiles, ... stay real
  downloadDeviceFull: (opts: Parameters<typeof realDownload>[0]) => downloadImpl(opts),
  flashDeviceParameters: (opts: Parameters<typeof realParamFlash>[0]) => paramFlashImpl(opts),
  flashDeviceGroupAddresses: (opts: Parameters<typeof realGaFlash>[0]) => gaFlashImpl(opts),
}));

// app.ts must be imported AFTER the mock so its route handlers bind the wrappers.
const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;

afterAll(() => { paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; downloadImpl = realDownload; });

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));
const realAppXml = gunzipSync(readFileSync(join(
  import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "real", "M-0081_A-FE01-11-75D9.xml.gz",
))).toString("utf8");

// Hand-chosen refs from the real M-0081 app program: P-6_R-6 is a memory-backed
// Value-typed parameter that is image-writable AND com-object-table-neutral, so a
// verified flash both adopts it into the baseline and passes the com-object staleness
// guard (a param like P-4_R-4, which activates com-object 8, would be promoted to a full
// download instead — see the promote-to-download suite below). O-0_R-63 is com-object 0 in
// the default view (so a GA flash covers it).
const PARAM_REF = "M-0081_A-FE01-11-75D9_P-6_R-6";
const LINK_KEY = "O-0_R-63";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
function freshState(): AppState {
  const dir = mkdtempSync(join(tmpdir(), "busforge-flashroute-"));
  tmps.push(dir);
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);

// Import the demo project, swap its device's application program for `xml`, and point the project
// at a saved connection so the route passes isConnectionReady. Same setup pattern as server.test.ts.
async function projectWithApp(state: AppState, xml: string): Promise<{ projectId: string; deviceId: string }> {
  const form = new FormData();
  form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const imp = (await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as any;
  const proj = (await (await handleApi(req(`/api/projects/${imp.id}`), state))!.json()) as any;
  state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [xml, "M-TEST_A-1"]);
  const conn = (await (await handleApi(req("/api/connections", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }),
  }), state))!.json()) as any;
  await handleApi(req(`/api/projects/${imp.id}/connection`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }),
  }), state);
  return { projectId: imp.id, deviceId: proj.devices[0].id };
}
// The real M-0081 (MV-0705, flashParams+flashLinks capable) is the default device for these tests.
const m0081Project = (state: AppState) => projectWithApp(state, realAppXml);

// A real write answers 202 with its queued task; its outcome is collected from the task.
async function programmed(state: AppState, response: Promise<Response | null> | Response | null) {
  const res = (await response)!;
  expect(res.status).toBe(202);
  const submitted = (await res.json()) as { id: string; state: string; writes: boolean };
  expect(submitted.writes).toBe(true);
  return (await state.queue.wait(submitted.id))!;
}
const post = (state: AppState, path: string) => handleApi(req(path, { method: "POST" }), state);

const flashed = (verified: boolean): FlashResult =>
  ({ kind: "flashed", mask: "MV-0705", imageBytes: 1, diffBytes: 1, verified, backup: "x" });

describe("POST /flash: baseline adoption is gated on verified", () => {
  test("verified:false -> 200, but the param baseline is NOT adopted (drift stays)", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1"); // drift: live-only override
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);

    paramFlashImpl = async (opts) => { expect(opts.dryRun).toBe(false); return flashed(false); }; // a real flash must not arrive as dry
    const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect((task.result as FlashResult).kind).toBe("flashed"); // the mock was reached, not a guard
    expect(task).toMatchObject({ state: "error", errorCode: "FLASH_UNVERIFIED", baselineCommitted: false });

    // The fake-green lock: nothing was confirmed on the device, so the change marker survives.
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);
  });

  test("verified:true -> the changed param IS adopted into the baseline", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);

    paramFlashImpl = async () => flashed(true);
    const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect(task).toMatchObject({ state: "done", result: { verified: true }, baselineCommitted: true });

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(false);
  });

  test("an edit during parameter programming remains drift against the submitted value", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");
    paramFlashImpl = async (opts) => {
      expect(opts.params.get(PARAM_REF)).toBe("1");
      setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "2");
      return flashed(true);
    };
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect(getDeviceParamBase(state.db, projectId, deviceId).get(PARAM_REF)).toBe("1");
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);
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
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));

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
    // the device. PARAM_REF (P-6_R-6) is visible, genuinely written, and com-object-table-
    // neutral (so the promote-to-download guard does not fire on it).
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
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));

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
    const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash-ga`));
    expect(task).toMatchObject({ state: "error", errorCode: "FLASH_UNVERIFIED", result: { kind: "flashed" } });

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).links.has(LINK_KEY)).toBe(true);
  });

  test("verified:true -> the changed link is adopted (resetLinkBase on the flashed refs)", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceLink(state.db, projectId, deviceId, LINK_KEY, [0x040b]);
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).links.has(LINK_KEY)).toBe(true);

    gaFlashImpl = async () => flashed(true);
    const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash-ga`));
    expect(task).toMatchObject({ state: "done", result: { verified: true }, baselineCommitted: true });

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).links.has(LINK_KEY)).toBe(false);
  });
});

// A parameter (or link) edit that alters the device's com-object table (L3) cannot be a surgical
// flash: the route refuses BEFORE any bus write. Where the family can commission from scratch it
// points the UI at a full download (COM_OBJECT_TABLE_STALE_USE_DOWNLOAD, which the FlashDialog turns
// into a download button); where it cannot, it refuses honestly (COM_OBJECT_TABLE_STALE). The
// surgical-flash orchestrators must never be reached in either case.
describe("POST /flash + /flash-ga: an L3-changing edit is promoted to a full download (or refused)", () => {
  const readReal = (f: string) => gunzipSync(readFileSync(join(
    import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "real", f,
  ))).toString("utf8");
  const m0162 = readReal("M-0162_A-0004-11-F245.xml.gz"); // System B: fullDownload capable
  const TABLE_CHANGING_B = "M-0162_A-0004-11-F245_P-30_R-30"; // System B: activates a com-object

  // A device that can flash but CANNOT full-download: System B with NO parameter segment (no LSM4
  // RelativeSegment -> hasParamSegment false -> fullDownload false, flashParams still true). Its P-1
  // is a project-only param (no <Memory>) that activates com-object 5 via a choose, so it changes the
  // com-object table without a segment to write. No corpus fixture is flashable-but-not-full-
  // downloadable any more (un-gating MV-0705 made every flashable real device full-download-capable),
  // so this branch is exercised on a synthetic app. Modelled on the M-00FA app in comobjbuild.test.ts.
  const noParamSegApp = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-00FA"><ApplicationPrograms>
<ApplicationProgram Id="M-00FA_A-A012-55-0000" ApplicationNumber="40978" ApplicationVersion="85" MaskVersion="MV-07B0" DefaultLanguage="de-DE" Name="NoParamSeg">
<Static>
<ParameterTypes><ParameterType Id="M-00FA_A-A012-55-0000_PT-1"><TypeRestriction Base="Value" SizeInBit="1"><Enumeration Text="nein" Value="0"/><Enumeration Text="ja" Value="1"/></TypeRestriction></ParameterType></ParameterTypes>
<Parameters><Parameter Id="M-00FA_A-A012-55-0000_P-1" ParameterType="M-00FA_A-A012-55-0000_PT-1" Text="Kanal aktiv" Value="0"/></Parameters>
<ParameterRefs><ParameterRef Id="M-00FA_A-A012-55-0000_P-1_R-1" RefId="M-00FA_A-A012-55-0000_P-1"/></ParameterRefs>
<ComObjectTable>
<ComObject Id="M-00FA_A-A012-55-0000_O-1" Number="1" Name="Heartbeat" Text="In Betrieb" ObjectSize="1 Byte" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/>
<ComObject Id="M-00FA_A-A012-55-0000_O-5" Number="5" Name="Presence" Text="Präsenz" ObjectSize="1 Bit" ReadFlag="Disabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/>
</ComObjectTable>
<ComObjectRefs><ComObjectRef Id="M-00FA_A-A012-55-0000_O-1_R-1" RefId="M-00FA_A-A012-55-0000_O-1"/><ComObjectRef Id="M-00FA_A-A012-55-0000_O-5_R-5" RefId="M-00FA_A-A012-55-0000_O-5"/></ComObjectRefs>
</Static>
<Dynamic><ParameterBlock Id="M-00FA_A-A012-55-0000_PB-1" Name="Basis" Text="Basis">
<ParameterRefRef RefId="M-00FA_A-A012-55-0000_P-1_R-1"/>
<ComObjectRefRef RefId="M-00FA_A-A012-55-0000_O-1_R-1"/>
<choose ParamRefId="M-00FA_A-A012-55-0000_P-1_R-1"><when test="1"><ComObjectRefRef RefId="M-00FA_A-A012-55-0000_O-5_R-5"/></when></choose>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const TABLE_CHANGING_NOSEG = "M-00FA_A-A012-55-0000_P-1_R-1"; // activates com-object 5

  test("param flash, full-download-capable family (System B) -> USE_DOWNLOAD, and the surgical flash never runs", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, m0162);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_B, "1");
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash`, { method: "POST" }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("COM_OBJECT_TABLE_STALE_USE_DOWNLOAD");
  });

  test("param flash, family that cannot full-download -> plain COM_OBJECT_TABLE_STALE (no download offered)", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, noParamSegApp);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_NOSEG, "1");
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash`, { method: "POST" }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("COM_OBJECT_TABLE_STALE");
  });

  test("the GA flash is gated the same way: an L3-changing param promotes it too", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, m0162);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_B, "1");
    gaFlashImpl = async () => { throw new Error("the surgical GA flash must not be reached"); };
    const res = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash-ga`, { method: "POST" }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("COM_OBJECT_TABLE_STALE_USE_DOWNLOAD");
  });

  test("an unchanged com-object table still reaches the surgical flash (the guard does not over-fire)", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, m0162);
    let reached = false;
    paramFlashImpl = async () => { reached = true; return flashed(true); };
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect(reached).toBe(true);
  });
});


const programmingRoutes = ["flash", "flash-ga", "download"] as const;
function setProgrammingResult(run: () => Promise<FlashResult>) {
  paramFlashImpl = run;
  gaFlashImpl = run;
  downloadImpl = run;
}
function linkBaseline(state: AppState, projectId: string, deviceId: string): number[] {
  return (state.db.query("SELECT ga_raw AS raw FROM device_link_base WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ? ORDER BY slot")
    .all(projectId, deviceId, LINK_KEY) as { raw: number }[]).map((r) => r.raw);
}

for (const route of programmingRoutes) {
  for (const timing of ["queued", "running"] as const) {
    test(`${route}: edits while ${timing} retain submitted baselines`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await m0081Project(state);
      setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "2");
      setDeviceLink(state.db, projectId, deviceId, LINK_KEY, [0x040b]);
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const blocker = timing === "queued" ? state.queue.enqueue(
        { projectId, deviceId, deviceName: "blocker", ia: "1.1.10", kind: "read", writes: false }, () => gate.promise,
      ) : Promise.resolve();
      setProgrammingResult(async () => { started.resolve(); if (timing === "running") await gate.promise; return flashed(true); });
      const submitted = programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`));
      if (timing === "running") await started.promise;
      else {
        for (let i = 0; i < 50 && state.queue.list(projectId).length < 2; i++) await Promise.resolve();
        expect(state.queue.list(projectId)).toHaveLength(2);
      }
      setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");
      setDeviceLink(state.db, projectId, deviceId, LINK_KEY, [0x040c]);
      gate.resolve();
      await blocker;
      expect((await submitted).state).toBe("done");
      if (route !== "flash-ga") expect(getDeviceParamBase(state.db, projectId, deviceId).get(PARAM_REF)).toBe("2");
      if (route !== "flash") expect(linkBaseline(state, projectId, deviceId)).toEqual([0x040b]);
      const drift = getDeviceChangedKeys(state.db, projectId, deviceId);
      expect(drift.params.has(PARAM_REF)).toBe(true);
      expect(drift.links.has(LINK_KEY)).toBe(true);
    });
  }
  for (const outcome of ["unverified", "failed", "dry"] as const) {
    test(`${route}: ${outcome} cannot adopt submitted values`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await m0081Project(state);
      setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");
      setDeviceLink(state.db, projectId, deviceId, LINK_KEY, [0x040b]);
      const beforeParams = getDeviceParamBase(state.db, projectId, deviceId);
      const beforeLinks = linkBaseline(state, projectId, deviceId);
      setProgrammingResult(async () => {
        if (outcome === "failed") throw new Error("injected failure");
        // Even a misreported verified result must not adopt a dry request.
        return flashed(outcome === "dry");
      });
      if (outcome === "dry") {
        const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}?dry=1`))!;
        expect(res.status).toBe(200);
      } else {
        const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`));
        expect(task).toMatchObject({ state: "error", baselineCommitted: false });
      }
      expect(getDeviceParamBase(state.db, projectId, deviceId)).toEqual(beforeParams);
      expect(linkBaseline(state, projectId, deviceId)).toEqual(beforeLinks);
    });
  }
  for (const mutation of ["replace", "readdress", "recreate"] as const) {
    test(`${route}: ${mutation} while queued refuses before programming`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await m0081Project(state);
      const gate = Promise.withResolvers<void>();
      const blocker = state.queue.enqueue({ projectId, deviceId, deviceName: "blocker", ia: "1.1.10", kind: "read", writes: false }, () => gate.promise);
      let wrote = false;
      setProgrammingResult(async () => { wrote = true; return flashed(true); });
      const submitted = programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`));
      for (let i = 0; i < 50 && state.queue.list(projectId).length < 2; i++) await Promise.resolve();
      expect(state.queue.list(projectId)).toHaveLength(2);
      if (mutation === "replace") state.db.run("UPDATE devices SET product_ref = product_ref WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);
      if (mutation === "readdress") state.db.run("UPDATE devices SET ia = '1.1.99' WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);
      if (mutation === "recreate") {
        state.db.exec("CREATE TEMP TABLE saved_devices AS SELECT * FROM devices; DELETE FROM devices; INSERT INTO devices SELECT * FROM saved_devices;");
      }
      gate.resolve();
      await blocker;
      expect(await submitted).toMatchObject({ state: "error", errorCode: "DEVICE_TARGET_CHANGED" });
      expect(wrote).toBe(false);
    });
  }
  test(`${route}: deletion during execution refuses adoption and reports task failure`, async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    const before = getDeviceParamBase(state.db, projectId, deviceId);
    setProgrammingResult(async () => {
      state.db.run("DELETE FROM devices WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);
      return flashed(true);
    });
    const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`));
    expect(task).toMatchObject({ state: "error", errorCode: "DEVICE_TARGET_CHANGED", baselineCommitted: false });
    expect(getDeviceParamBase(state.db, projectId, deviceId)).toEqual(before);
  });
}

test("a removed hidden override retains its unobservable baseline", async () => {
  const state = freshState();
  const { projectId, deviceId } = await m0081Project(state);
  const hidden = "M-0081_A-FE01-11-75D9_P-16_R-16";
  replaceParamBase(state.db, projectId, deviceId, new Map([[hidden, "1"]]));
  setProgrammingResult(async () => flashed(true));
  await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
  expect(getDeviceParamBase(state.db, projectId, deviceId).get(hidden)).toBe("1");
});

test("a baseline learned by an earlier queued job survives a later unwritten submission", async () => {
  const state = freshState();
  const { projectId, deviceId } = await m0081Project(state);
  const hidden = "M-0081_A-FE01-11-75D9_P-16_R-16";
  const gate = Promise.withResolvers<void>();
  const earlier = state.queue.enqueue({ projectId, deviceId, deviceName: "earlier read", ia: "1.1.10", kind: "read", writes: false }, async () => {
    await gate.promise;
    replaceParamBase(state.db, projectId, deviceId, new Map([[hidden, "1"]]));
  });
  setProgrammingResult(async () => flashed(true));
  const submitted = programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
  for (let i = 0; i < 50 && state.queue.list(projectId).length < 2; i++) await Promise.resolve();
  expect(state.queue.list(projectId)).toHaveLength(2);
  gate.resolve();
  await earlier;
  expect((await submitted).state).toBe("done");
  expect(getDeviceParamBase(state.db, projectId, deviceId).get(hidden)).toBe("1");
});

describe("programming jobs outlive the request that submitted them", () => {
  test("a write answers 202 with its task before the device is touched, and the task carries the outcome", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    setDeviceParam(state.db, projectId, deviceId, PARAM_REF, "1");
    const gate = Promise.withResolvers<void>();
    paramFlashImpl = async () => { await gate.promise; return flashed(true); };
    const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`))!;
    expect(res.status).toBe(202);
    const submitted = (await res.json()) as any;
    expect(submitted).toMatchObject({ kind: "flash-params", writes: true, state: "queued", deviceId });
    expect(submitted.snapshotId).toBe((state.db.query("SELECT id FROM snapshots WHERE project_id = ? AND reason = 'before-flash'").get(projectId) as { id: string }).id);

    // The client is gone; the job is not.
    gate.resolve();
    await state.queue.wait(submitted.id);
    const polled = (await (await handleApi(req(`/api/projects/${projectId}/tasks/${submitted.id}`), state))!.json()) as any;
    expect(polled).toMatchObject({ state: "done", result: { kind: "flashed", verified: true }, baselineCommitted: true });
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(false);
  });

  test("a task is only visible within its own project", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    paramFlashImpl = async () => flashed(true);
    const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect((await handleApi(req(`/api/projects/other/tasks/${task.id}`), state))!.status).toBe(404);
    expect((await post(state, `/api/projects/other/tasks/${task.id}/cancel`))!.status).toBe(404);
  });

  for (const route of programmingRoutes) {
    test(`${route}: a second write to the same device is refused while the first is in flight`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await m0081Project(state);
      const gate = Promise.withResolvers<void>();
      let writes = 0;
      setProgrammingResult(async () => { writes++; await gate.promise; return flashed(true); });
      const first = programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`));
      for (const other of programmingRoutes) {
        const retry = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${other}`))!;
        expect(retry.status).toBe(409);
        expect(await retry.json()).toMatchObject({ error: { code: "DEVICE_WRITE_ACTIVE" } });
      }
      gate.resolve();
      expect((await first).state).toBe("done");
      expect(writes).toBe(1);
      // Finished, so the next submission is accepted again.
      expect((await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`))).state).toBe("done");
    });
  }

  test("a dry run is still answered directly and does not block a write", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    paramFlashImpl = async (opts) => (opts.dryRun ? { kind: "dryRun", mask: "MV-0705", imageBytes: 1, diffBytes: 1, backup: "x" } : flashed(true));
    const dry = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/flash?dry=1`))!;
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as any).kind).toBe("dryRun");
    expect(state.queue.list(projectId)[0]).toMatchObject({ writes: false, snapshotId: null });
    expect((await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`))).state).toBe("done");
  });

  test("a running write refuses cancellation and says why; a queued one is cancelled before it runs", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    paramFlashImpl = async () => { started.resolve(); await gate.promise; return flashed(true); };
    const running = (await (await post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`))!.json()) as any;
    await started.promise;
    const refused = (await post(state, `/api/projects/${projectId}/tasks/${running.id}/cancel`))!;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "TASK_WRITE_NOT_CANCELLABLE" } });

    // A write to another device waits behind it and can still be withdrawn.
    let reached = false;
    const queued = state.queue.submit({ projectId, deviceId: "other", deviceName: "other", ia: "1.1.11", kind: "flash-ga", writes: true }, async () => { reached = true; });
    expect(queued.state).toBe("queued");
    expect(await (await post(state, `/api/projects/${projectId}/tasks/${queued.id}/cancel`))!.json()).toEqual({ cancelled: "queued" });
    gate.resolve();
    expect((await state.queue.wait(queued.id))!.state).toBe("cancelled");
    expect(reached).toBe(false);
    expect((await state.queue.wait(running.id))!.state).toBe("done");
    const finished = (await post(state, `/api/projects/${projectId}/tasks/${running.id}/cancel`))!;
    expect(await finished.json()).toMatchObject({ error: { code: "TASK_ALREADY_FINISHED" } });
  });

  test("a restart reports unfinished work as interrupted or not started, and replays none of it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-restart-"));
    tmps.push(dir);
    const dbPath = join(dir, "busforge.db");
    const before = createState({ dbPath, dataDir: dir, now: () => 1000 });
    const { projectId, deviceId } = await m0081Project(before);
    const started = Promise.withResolvers<void>();
    let writes = 0;
    // Never settles: the process "dies" mid-write.
    setProgrammingResult(async () => { writes++; started.resolve(); return new Promise<FlashResult>(() => {}); });
    const running = (await (await post(before, `/api/projects/${projectId}/devices/${deviceId}/download`))!.json()) as any;
    await started.promise;
    const queuedRead = before.queue.submit({ projectId, deviceId: "-", deviceName: "scan", ia: "-", kind: "read", writes: false }, async () => { writes++; });

    const after = createState({ dbPath, dataDir: dir, now: () => 2000 });
    const tasks = after.queue.list(projectId);
    expect(tasks.find((t) => t.id === running.id)).toMatchObject({ state: "interrupted", errorCode: "TASK_WRITE_INTERRUPTED", finishedAt: 2000, baselineCommitted: false });
    expect(tasks.find((t) => t.id === queuedRead.id)).toMatchObject({ state: "cancelled", errorCode: "TASK_NOT_STARTED" });
    // Interrupted is final: the new process accepts a fresh write and never re-runs the old one.
    expect(() => after.queue.refuseConcurrentWrite(projectId, deviceId)).not.toThrow();
    expect(writes).toBe(1);
  });
});
