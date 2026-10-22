import { putGroupSenders } from "../src/db/groupSenders.ts";
import { test, expect, describe, mock, afterAll, setDefaultTimeout } from "bun:test";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe, corpusTest } from "../../../tools/corpus-test.ts";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDeviceParam, setDeviceLink, getDeviceChangedKeys, getDeviceParamBase, replaceParamBase, getImageStamps } from "../src/db/deviceparams.ts";
import { deviceParamRefs } from "../src/deviceservice.ts";
import { putDeviceSecurity } from "../src/db/deviceSecurity.ts";
import { putGroupKeys } from "../src/db/groupKeys.ts";
import { getDeviceCertificate } from "../src/db/deviceCertificates.ts";
import { encodeCertificate } from "@busforge/knx";
import { classify, parseAppConfig } from "@busforge/product";
import type { FlashResult } from "../src/deviceprofile.ts";
import { settle } from "./task-client.ts";
// The structural-flash routes plan over real application programs: 1.6-3.1 s each alone at load 29,
// 6.6 s inside the full check at load 24-40, past Bun's 5 s default.
setDefaultTimeout(30_000);

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
const realStructure = real.flashDeviceStructure;

// Mutable delegation targets. Default = the real implementations, and afterAll restores
// them, so if the module mock leaks into later test files (bun does not auto-unmock),
// behavior there is indistinguishable from the unmocked module.
let paramFlashImpl: typeof realParamFlash = realParamFlash;
let gaFlashImpl: typeof realGaFlash = realGaFlash;
let downloadImpl: typeof realDownload = realDownload;
let structureImpl: typeof realStructure = realStructure;

await mock.module("../src/deviceprofile.ts", () => ({
  ...real, // classify, readDeviceState, secureIdentify, profiles, ... stay real
  downloadDeviceFull: (opts: Parameters<typeof realDownload>[0]) => downloadImpl(opts),
  flashDeviceParameters: (opts: Parameters<typeof realParamFlash>[0]) => paramFlashImpl(opts),
  flashDeviceGroupAddresses: (opts: Parameters<typeof realGaFlash>[0]) => gaFlashImpl(opts),
  flashDeviceStructure: (opts: Parameters<typeof realStructure>[0]) => structureImpl(opts),
}));

// app.ts must be imported AFTER the mock so its route handlers bind the wrappers.
const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;

afterAll(() => { paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; downloadImpl = realDownload; structureImpl = realStructure; });

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));
const realAppXml = () => catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");

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
  // The test products are untested on hardware; the user's one acknowledgement per project.
  await acknowledgeUntested(state, imp.id, proj.devices[0].id);
  return { projectId: imp.id, deviceId: proj.devices[0].id };
}
async function acknowledgeUntested(state: AppState, projectId: string, deviceId: string) {
  expect((await handleApi(req(`/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}/untested-ack`, { method: "PUT" }), state))!.status).toBe(200);
}
// The real M-0081 (MV-0705, flashParams+flashLinks capable) is the default device for these tests.
// Its declared load procedure has a step the full download cannot execute (LdCtrlTaskCtrl1), so the
// tests that drive the download route use the MDT BE-02001.02 (MV-0705, every write offered).
const m0081Project = (state: AppState) => projectWithApp(state, realAppXml());
const mdtProject = (state: AppState) => projectWithApp(state, catalogueXml("M-0083_A-00B6-32-9642.xml.gz"));
// P-7_R-6 is a memory-backed number on the MDT that leaves the com-object table alone; MD-2_M-2_MI-1_O-3-0_R-11
// is com-object 0 (channel 1's first module instance) in the default view.
const MDT_PARAM_REF = "M-0083_A-00B6-32-9642_P-7_R-6";
const MDT_LINK_KEY = "MD-2_M-2_MI-1_O-3-0_R-11";

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

corpusDescribe("POST /flash: baseline adoption is gated on verified", () => {
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
    const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash?dry=1`);
    expect(res.state).toBe("done");
    expect((res.result as any).kind).toBe("dryRun");

    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(PARAM_REF)).toBe(true);
  });
});

corpusDescribe("POST /flash: keepDrift wiring for params the flash can never write", () => {
  // The flash route's adoption, with the parameter flash itself mocked: what the image codec cannot represent keeps
  // its changed chip, what it writes is adopted after a verified flash.
  const flashTwo = async (xml: string, refs: [string, string][]) => {
    const state = freshState();
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
    const projectId = imp.id, deviceId = proj.devices[0].id;
    await acknowledgeUntested(state, projectId, deviceId);
    for (const [ref, v] of refs) setDeviceParam(state.db, projectId, deviceId, ref, v);
    const before = getDeviceChangedKeys(state.db, projectId, deviceId).params;
    for (const [ref] of refs) expect(before.has(ref)).toBe(true);
    paramFlashImpl = async () => flashed(true);
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    return getDeviceChangedKeys(state.db, projectId, deviceId).params;
  };

  test("a memory-backed COLOUR override keeps its changed chip across a verified flash; a VALUE override is adopted", async () => {
    // No catalogue of the corpus has a memory-backed parameter of a type the codec does not represent, so the
    // MDT A-0137's 30-byte text type is declared a colour here: memory-backed, never written.
    const xml = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz").replace('<TypeText SizeInBit="240" />', '<TypeColor Space="RGB" />');
    const COLOUR_REF = "M-0083_A-0137-20-7EB2_P-162_R-162";
    const VALUE_REF = "M-0083_A-0137-20-7EB2_P-1_R-1";
    const after = await flashTwo(xml, [[COLOUR_REF, "#102030"], [VALUE_REF, "1"]]);
    expect(after.has(VALUE_REF)).toBe(false); // written and verified -> adopted
    expect(after.has(COLOUR_REF)).toBe(true); // never written -> the drift chip survives
  });

  test("a memory-backed TEXT override is adopted after a verified flash, like a VALUE override", async () => {
    const TEXT_REF = "M-0048_A-9071-20-F258-O00EF_P-817_R-868"; // the DALI-Gateway's admin password, 8 bytes
    const VALUE_REF = "M-0048_A-9071-20-F258-O00EF_P-1_R-1";
    const after = await flashTwo(catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz"), [[TEXT_REF, "admin"], [VALUE_REF, "1"]]);
    expect(after.has(VALUE_REF)).toBe(false);
    expect(after.has(TEXT_REF)).toBe(false);
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

corpusDescribe("POST /flash-ga: link baseline adoption is gated on verified", () => {
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

// ETS's record of the last download that wrote the parameters (ImageStamp): a verified download or parameter
// flash replaces it with its closing reads, an unverified one and a group-address flash leave it, a verified
// operation that keeps none clears it, and it lives in the database, so the parameter flash and the
// group-address flash after a server restart compare against it.
corpusDescribe("the stamp record across the flash routes and a server restart", () => {
  const stamps = (crc: string) => [{ obj: 4, element: 1, hex: `0000002a00ff${crc}` }];
  const withStamps = (verified: boolean, crc?: string): FlashResult => ({ ...flashed(verified), ...(crc ? { stamps: stamps(crc) } : {}) } as FlashResult);

  test("adopted on a verified commit, kept otherwise, read back by the next parameter flash after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-stamps-"));
    tmps.push(dir);
    const open = () => createState({ dbPath: join(dir, "busforge.db"), dataDir: dir, now: () => 1000 });
    const state = open();
    const { projectId, deviceId } = await mdtProject(state);
    const record = (st: AppState) => getImageStamps(st.db, projectId, deviceId);
    expect(record(state)).toBeUndefined();

    downloadImpl = async () => withStamps(true, "aaaa");
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/download`));
    expect(record(state)).toEqual(stamps("aaaa"));

    // A second server process on the same database: the record is there, and the parameter flash gets it.
    const restarted = open();
    let seen: unknown;
    setDeviceParam(restarted.db, projectId, deviceId, MDT_PARAM_REF, "1");
    paramFlashImpl = async (opts) => { seen = opts.stampRecord; return withStamps(true, "bbbb"); };
    await programmed(restarted, post(restarted, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect(seen).toEqual(stamps("aaaa"));
    expect(record(restarted)).toEqual(stamps("bbbb"));

    setDeviceParam(restarted.db, projectId, deviceId, MDT_PARAM_REF, "2");
    paramFlashImpl = async () => withStamps(false, "cccc");
    await programmed(restarted, post(restarted, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect(record(restarted)).toEqual(stamps("bbbb"));

    setDeviceLink(restarted.db, projectId, deviceId, MDT_LINK_KEY, [0x040b]);
    let seenGa: unknown;
    gaFlashImpl = async (opts) => { seenGa = opts.stampRecord; return withStamps(true, "dddd"); };
    await programmed(restarted, post(restarted, `/api/projects/${projectId}/devices/${deviceId}/flash-ga`));
    expect(seenGa).toEqual(stamps("bbbb"));
    expect(record(restarted)).toEqual(stamps("bbbb"));

    paramFlashImpl = async () => withStamps(true);
    await programmed(restarted, post(restarted, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect(record(restarted)).toBeUndefined();
  });
});

// A parameter (or link) edit that alters the device's com-object table (L3) cannot be a parameter or
// group-address flash alone. Where the application is offered the structural flash, both routes run that
// (parameters, com-object table and group tables in one bracket) and a verified result adopts both
// baselines; where it can only commission from scratch the route points at a full download
// (COM_OBJECT_TABLE_STALE_USE_DOWNLOAD); otherwise it refuses (COM_OBJECT_TABLE_STALE). The surgical
// orchestrators are never reached in any of these cases.
corpusDescribe("POST /flash + /flash-ga: an L3-changing edit runs the structural flash (or is refused)", () => {
  const readReal = catalogueXml;
  const m0162 = readReal("M-0162_A-0004-11-F245.xml.gz"); // System B: full download, no capture of the structural flash
  const TABLE_CHANGING_B = "M-0162_A-0004-11-F245_P-30_R-30"; // System B: activates a com-object
  const jung = readReal("M-0004_A-7072-21-99A7-O000A.xml.gz"); // System B, tested against ETS's capture of the structural flash
  const TABLE_CHANGING_JUNG = "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-149_R-142"; // 8 removes #253, #254


  test("param flash, System B -> the structural flash runs, the surgical flash never does, and a verified one adopts both baselines", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, jung);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_JUNG, "8");
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    let seen: Parameters<typeof realStructure>[0] | undefined;
    structureImpl = async (o) => { seen = o; return { ...flashed(true), structural: true }; };
    try {
      const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
      expect(task).toMatchObject({ kind: "flash-structure", state: "done", result: { verified: true, structural: true }, baselineCommitted: true });
    } finally { structureImpl = realStructure; }
    expect(seen?.params.get(TABLE_CHANGING_JUNG)).toBe("8");
    expect(Array.isArray(seen?.links)).toBe(true);
    expect(getDeviceParamBase(state.db, projectId, deviceId).get(TABLE_CHANGING_JUNG)).toBe("8");
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(TABLE_CHANGING_JUNG)).toBe(false);
  });

  test("an unverified structural flash adopts nothing", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, jung);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_JUNG, "8");
    structureImpl = async () => ({ ...flashed(false), structural: true });
    try { await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`)); }
    finally { structureImpl = realStructure; }
    expect(getDeviceChangedKeys(state.db, projectId, deviceId).params.has(TABLE_CHANGING_JUNG)).toBe(true);
  });

  test("the structural flash takes the group-address flash's link-baseline guard", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, jung);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_JUNG, "8");
    state.db.run("UPDATE devices SET link_base_gaps = 2 WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);
    structureImpl = async () => { throw new Error("the structural flash must not be reached"); };
    try {
      const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`))!;
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error.code).toBe("LINK_BASELINE_INCOMPLETE");
    } finally { structureImpl = realStructure; }
  });

  // The structural flash is the family's rule, so a System B application without a capture of it gets it too.
  test("param flash, System B application without a capture of the structural flash -> the structural flash, not the surgical one", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, m0162);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_B, "1");
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    let reached = false;
    structureImpl = async () => { reached = true; return { kind: "dryRun", mask: "MV-07B0", imageBytes: 1, diffBytes: 1, backup: "x", structural: true }; };
    try {
      const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash?dry=1`);
      expect(res.state).toBe("done");
      expect(reached).toBe(true);
    } finally { structureImpl = realStructure; paramFlashImpl = realParamFlash; }
  });

  test("the GA flash is routed the same way: an L3-changing param runs the structural flash", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, jung);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_JUNG, "8");
    gaFlashImpl = async () => { throw new Error("the surgical GA flash must not be reached"); };
    structureImpl = async () => ({ kind: "dryRun", mask: "MV-07B0", imageBytes: 9, diffBytes: 3, backup: "x", structural: true });
    try {
      const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash-ga?dry=1`);
      expect(res.state).toBe("done");
      expect(res.result).toMatchObject({ kind: "dryRun", structural: true });
    } finally { structureImpl = realStructure; }
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

describe("POST /flash: a family that cannot full-download", () => {
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

  test("a never-programmed device of a family that cannot full-download keeps its surgical flash, which ends the state", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, noParamSegApp);
    state.db.run("UPDATE devices SET never_programmed = 1 WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);
    const np = () => (state.db.query("SELECT never_programmed AS n FROM devices WHERE instance_id = ?").get(deviceId) as { n: number }).n;
    paramFlashImpl = async () => flashed(true);
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
    expect(np()).toBe(0);
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
});


// MDT IP Interface/Router (A-0137) declares tunnelling entries no Busforge path writes, so its full
// download is refused with its own code; the surgical flashes stay, and a never-programmed one is not
// sent to the download it cannot run.
corpusDescribe("an IP interface with tunnelling entries", () => {
  const a0137 = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");

  test("the download route refuses with FULL_DOWNLOAD_TUNNELING_ENTRIES and never reaches the download", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, a0137);
    downloadImpl = async () => { throw new Error("the full download must not be reached"); };
    try {
      for (const route of ["download", "download?dry=1"]) {
        const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`))!;
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error.code).toBe("FULL_DOWNLOAD_TUNNELING_ENTRIES");
      }
    } finally { downloadImpl = realDownload; }
  });

  // The MDT IP Interface Secure (MV-0012) writes its tunnelling addresses itself (the KNXnet/IP object's PID 53, as
  // ETS's capture shows), so its download is not refused for them; the route hands the device's KNXnet/IP settings
  // from the project to the download and the parameter flash, and none where the project holds none.
  test("a System 1 interface (MV-0012) is not refused for its tunnelling entries; its KNXnet/IP settings reach both writes", async () => {
    const a0138 = catalogueXml("M-0083_A-0138-21-F18E-O0072.xml.gz");
    expect(a0138).toContain('MaxTunnelingUserEntries="4"');
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, a0138);
    const seen: unknown[] = [];
    downloadImpl = async (o) => { seen.push(o.knxIp); throw new Error("stop"); };
    paramFlashImpl = async (o) => { seen.push(o.knxIp); throw new Error("stop"); };
    try {
      const run = async () => {
        for (const route of ["download", "flash"]) {
          const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}?dry=1`))!;
          const body = (await res.json()) as any;
          if (body.id) await state.queue.wait(body.id);
        }
      };
      await run();
      const settings = { instanceName: "", productName: "IP Interface", productNameTranslations: [], ipConfig: { Assign: "Fixed", IPAddress: "192.0.2.2" }, additionalAddresses: [255], securityAttributes: ["ToolKey"], toolKeyLoaded: true, busInterfaces: 0, installation: { Name: "" } };
      state.db.run("INSERT INTO device_knxip (project_id, device_id, settings) VALUES (?, ?, ?)", [projectId, deviceId, JSON.stringify(settings)]);
      await run();
      const ia = ((await (await handleApi(req(`/api/projects/${projectId}`), state))!.json()) as any).devices[0].ia;
      expect(seen).toEqual([undefined, undefined, { ia, ...settings }, { ia, ...settings }]);
    } finally { downloadImpl = realDownload; paramFlashImpl = realParamFlash; }
  });

  // The System 1 parameter download loads the security object, so a verified one records its fingerprint and the
  // device no longer shows its security state as unknown.
  test("a verified System 1 parameter download of a secure device records its security object", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, catalogueXml("M-0083_A-0138-21-F18E-O0072.xml.gz"));
    putDeviceSecurity(state.db, projectId, [{ deviceId, toolKey: Buffer.alloc(16, 7), serialNumber: Buffer.alloc(6, 2), sequenceNumber: "1", source: "import" }], state.masterKey);
    const security = async () => ((await (await handleApi(req(`/api/projects/${projectId}`), state))!.json()) as any).devices.find((d: any) => d.id === deviceId).changes.security;
    expect(await security()).toBe("unknown");
    paramFlashImpl = async () => flashed(true);
    try {
      const body = (await (await post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`))!.json()) as any;
      await state.queue.wait(body.id);
      expect(await security()).toBeFalsy();
    } finally { paramFlashImpl = realParamFlash; }
  });

  test("a never-programmed one keeps its parameter and group-address flash", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, a0137);
    state.db.run("UPDATE devices SET never_programmed = 1 WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);
    const reached: string[] = [];
    paramFlashImpl = async (o) => { reached.push("params"); expect(o.dryRun).toBe(true); return { kind: "dryRun", mask: "MV-07B0", imageBytes: 1, diffBytes: 1, backup: "x" }; };
    gaFlashImpl = async (o) => { reached.push("links"); expect(o.dryRun).toBe(true); return { kind: "dryRun", mask: "MV-07B0", imageBytes: 1, diffBytes: 1, backup: "x" }; };
    for (const route of ["flash?dry=1", "flash-ga?dry=1"]) {
      const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/${route}`);
      expect(res.state).toBe("done");
    }
    expect(reached).toEqual(["params", "links"]);
  });
});

// An application whose full download Busforge cannot build (the M-0081_A-FF31-31-D6FF: segment AS-456A
// declares a <Mask> shorter than the segment that marks bytes, a form no capture shows): the full
// download is refused with the planner's own code, and a device of it that the surgical flash cannot
// safely start from is pointed at ETS instead of at the download it cannot have. Its LdCtrlTaskCtrl1
// (Address 0, Count 0) is the Auro M-0081_A-FE01-11-75D9's, which runs its writes as ETS was captured
// running them, as the M-0008 does, so both are offered all three.
corpusDescribe("an application whose full download Busforge cannot build", () => {
  const ff31Project = (state: AppState) => projectWithApp(state, catalogueXml("M-0081_A-FF31-31-D6FF.xml.gz"));
  const TABLE_CHANGING_FF31 = "M-0081_A-FF31-31-D6FF_P-242_R-242"; // 1 changes the active com-objects
  const never = (state: AppState, projectId: string, deviceId: string) =>
    state.db.run("UPDATE devices SET never_programmed = 1 WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);

  test("the download route refuses with the planner's code and never reaches the download", async () => {
    const state = freshState();
    const { projectId, deviceId } = await ff31Project(state);
    downloadImpl = async () => { throw new Error("the full download must not be reached"); };
    try {
      for (const route of ["download", "download?dry=1"]) {
        const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`))!;
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error.code).toBe("FULL_DOWNLOAD_SEGMENT_UNKNOWN");
      }
    } finally { downloadImpl = realDownload; }
  });

  test("a never-programmed device is refused on the parameter and the group-address flash, naming ETS", async () => {
    const state = freshState();
    const { projectId, deviceId } = await ff31Project(state);
    never(state, projectId, deviceId);
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    gaFlashImpl = async () => { throw new Error("the GA flash must not be reached"); };
    try {
      for (const route of ["flash", "flash?dry=1", "flash-ga", "flash-ga?dry=1"]) {
        const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`))!;
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error.code).toBe("NEVER_PROGRAMMED_USE_ETS");
      }
    } finally { paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; }
  });

  test("a change that rewrites the com-object table names ETS, not the download", async () => {
    const state = freshState();
    const { projectId, deviceId } = await ff31Project(state);
    setDeviceParam(state.db, projectId, deviceId, TABLE_CHANGING_FF31, "1");
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    gaFlashImpl = async () => { throw new Error("the GA flash must not be reached"); };
    try {
      for (const route of ["flash?dry=1", "flash-ga?dry=1"]) {
        const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`))!;
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error.code).toBe("COM_OBJECT_TABLE_STALE_USE_ETS");
      }
    } finally { paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; }
  });

  test("M-0008 runs as ETS was captured: all three writes offered, no refusal, the flashes reached", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz"));
    const view = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    expect(view.capabilities).toMatchObject({ flashParams: true, flashLinks: true, fullDownload: true });
    expect(view.refusals ?? {}).toEqual({});
    const reached: string[] = [];
    const dry = { kind: "dryRun" as const, mask: "MV-0705", imageBytes: 1, diffBytes: 1, backup: "x" };
    paramFlashImpl = async () => { reached.push("flash"); return dry; };
    gaFlashImpl = async () => { reached.push("flash-ga"); return dry; };
    try {
      for (const route of ["flash?dry=1", "flash-ga?dry=1"]) {
        const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/${route}`);
        expect(res.state).toBe("done");
      }
      expect(reached).toEqual(["flash", "flash-ga"]);
    } finally { paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; }
  });

  test("M-0081_A-FE01-11-75D9 runs its declared steps as ETS was captured: all three writes offered, the download reached", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    const view = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    expect(view.capabilities).toMatchObject({ flashParams: true, flashLinks: true, fullDownload: true });
    expect(view.refusals ?? {}).toEqual({});
    const reached: string[] = [];
    downloadImpl = async (o) => { reached.push("download"); expect(o.dryRun).toBe(true); return { kind: "dryRun", mask: "MV-0705", imageBytes: 1, diffBytes: 1, backup: "x" }; };
    try {
      const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/download?dry=1`);
      expect(res.state).toBe("done");
      expect(reached).toEqual(["download"]);
    } finally { downloadImpl = realDownload; }
  });
});

// Jung 400021SE (module device): "Kanalfunktion" of channel 1 is a module-instance parameter with no
// device memory, yet it decides which com-objects the channel has (8 = door/window status removes
// #253 and #254). A download programmed with it compiled the device's com-object table for that
// value, so the baseline must record it: otherwise switching back looks like no change and the
// surgical parameter flash leaves the device on the other table while reporting success.
corpusDescribe("a memory-less module parameter that shapes the com-object table", () => {
  const jungXml = catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz");
  const CHANNEL_FUNCTION = "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-149_R-142";

  test("a never-programmed device: surgical flashes are refused, only a verified download clears it", async () => {
    const state = freshState();
    const { projectId, deviceId } = await mdtProject(state);
    state.db.run("UPDATE devices SET never_programmed = 1 WHERE project_id = ? AND instance_id = ?", [projectId, deviceId]);
    const np = () => (state.db.query("SELECT never_programmed AS n FROM devices WHERE instance_id = ?").get(deviceId) as { n: number }).n;
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    gaFlashImpl = async () => { throw new Error("the GA flash must not be reached"); };
    for (const route of ["flash", "flash-ga", "flash?dry=1"]) {
      const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`))!;
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe("NEVER_PROGRAMMED_USE_DOWNLOAD");
    }
    downloadImpl = async () => flashed(false);
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/download`));
    expect(np()).toBe(1); // not verified: nothing adopted
    downloadImpl = async () => flashed(true);
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/download`));
    expect(np()).toBe(0);
  });

  test("a download adopts it, and switching it back runs the structural flash", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, jungXml);
    setDeviceParam(state.db, projectId, deviceId, CHANNEL_FUNCTION, "8");
    downloadImpl = async () => flashed(true);
    await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/download`));
    expect(getDeviceParamBase(state.db, projectId, deviceId).get(CHANNEL_FUNCTION)).toBe("8");

    setDeviceParam(state.db, projectId, deviceId, CHANNEL_FUNCTION, "1");
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    structureImpl = async () => ({ kind: "dryRun", mask: "MV-07B0", imageBytes: 9, diffBytes: 3, backup: "x", structural: true });
    try {
      const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash?dry=1`);
      expect(res.state).toBe("done");
      expect(res.result).toMatchObject({ structural: true });
    } finally { structureImpl = realStructure; }
  });
});


const programmingRoutes = ["flash", "flash-ga", "download"] as const;
function setProgrammingResult(run: () => Promise<FlashResult>) {
  paramFlashImpl = run;
  gaFlashImpl = run;
  downloadImpl = run;
}
function linkBaseline(state: AppState, projectId: string, deviceId: string, key = MDT_LINK_KEY): number[] {
  return (state.db.query("SELECT ga_raw AS raw FROM device_link_base WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ? ORDER BY slot")
    .all(projectId, deviceId, key) as { raw: number }[]).map((r) => r.raw);
}

for (const route of programmingRoutes) {
  for (const timing of ["queued", "running"] as const) {
    corpusTest(`${route}: edits while ${timing} retain submitted baselines`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await mdtProject(state);
      setDeviceParam(state.db, projectId, deviceId, MDT_PARAM_REF, "2");
      setDeviceLink(state.db, projectId, deviceId, MDT_LINK_KEY, [0x040b]);
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
      setDeviceParam(state.db, projectId, deviceId, MDT_PARAM_REF, "1");
      setDeviceLink(state.db, projectId, deviceId, MDT_LINK_KEY, [0x040c]);
      gate.resolve();
      await blocker;
      expect((await submitted).state).toBe("done");
      if (route !== "flash-ga") expect(getDeviceParamBase(state.db, projectId, deviceId).get(MDT_PARAM_REF)).toBe("2");
      if (route !== "flash") expect(linkBaseline(state, projectId, deviceId)).toEqual([0x040b]);
      const drift = getDeviceChangedKeys(state.db, projectId, deviceId);
      expect(drift.params.has(MDT_PARAM_REF)).toBe(true);
      expect(drift.links.has(MDT_LINK_KEY)).toBe(true);
    });
  }
  for (const outcome of ["unverified", "failed", "dry"] as const) {
    corpusTest(`${route}: ${outcome} cannot adopt submitted values`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await mdtProject(state);
      setDeviceParam(state.db, projectId, deviceId, MDT_PARAM_REF, "1");
      setDeviceLink(state.db, projectId, deviceId, MDT_LINK_KEY, [0x040b]);
      const beforeParams = getDeviceParamBase(state.db, projectId, deviceId);
      const beforeLinks = linkBaseline(state, projectId, deviceId);
      setProgrammingResult(async () => {
        if (outcome === "failed") throw new Error("injected failure");
        // Even a misreported verified result must not adopt a dry request.
        return flashed(outcome === "dry");
      });
      if (outcome === "dry") {
        const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/${route}?dry=1`);
        expect(res.state).toBe("done");
      } else {
        const task = await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`));
        expect(task).toMatchObject({ state: "error", baselineCommitted: false });
      }
      expect(getDeviceParamBase(state.db, projectId, deviceId)).toEqual(beforeParams);
      expect(linkBaseline(state, projectId, deviceId)).toEqual(beforeLinks);
    });
  }
  for (const mutation of ["replace", "readdress", "recreate"] as const) {
    corpusTest(`${route}: ${mutation} while queued refuses before programming`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await mdtProject(state);
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
  corpusTest(`${route}: deletion during execution refuses adoption and reports task failure`, async () => {
    const state = freshState();
    const { projectId, deviceId } = await mdtProject(state);
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

corpusTest("a removed hidden override retains its unobservable baseline", async () => {
  const state = freshState();
  const { projectId, deviceId } = await m0081Project(state);
  const hidden = "M-0081_A-FE01-11-75D9_P-16_R-16";
  replaceParamBase(state.db, projectId, deviceId, new Map([[hidden, "1"]]));
  setProgrammingResult(async () => flashed(true));
  await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`));
  expect(getDeviceParamBase(state.db, projectId, deviceId).get(hidden)).toBe("1");
});

corpusTest("a baseline learned by an earlier queued job survives a later unwritten submission", async () => {
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

corpusDescribe("programming jobs outlive the request that submitted them", () => {
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
      const { projectId, deviceId } = await mdtProject(state);
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

  test("a shutting-down server refuses a write before taking its restore point", async () => {
    const state = freshState();
    const { projectId, deviceId } = await mdtProject(state);
    setProgrammingResult(async () => flashed(true));
    const snapshots = () => (state.db.query("SELECT count(*) AS n FROM snapshots WHERE project_id = ?").get(projectId) as { n: number }).n;
    const before = snapshots();
    await state.queue.shutdown();
    for (const route of programmingRoutes) {
      const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/${route}`))!;
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "SERVER_SHUTTING_DOWN" } });
    }
    expect(snapshots()).toBe(before);
    expect(state.queue.list(projectId)).toHaveLength(0);
  });

  test("a dry run is still answered directly and does not block a write", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    paramFlashImpl = async (opts) => (opts.dryRun ? { kind: "dryRun", mask: "MV-0705", imageBytes: 1, diffBytes: 1, backup: "x" } : flashed(true));
    const dry = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash?dry=1`);
    expect(dry.state).toBe("done");
    expect((dry.result as any).kind).toBe("dryRun");
    expect(state.queue.list(projectId)[0]).toMatchObject({ writes: false, snapshotId: null });
    expect((await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`))).state).toBe("done");
  });

  test("a running write refuses cancellation and says why; a queued one is cancelled before it runs", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    paramFlashImpl = async (opts) => { opts.beforeWrite?.(); started.resolve(); await gate.promise; return flashed(true); };
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

  test("a write is cancelled while it only reads the device, and never reaches its first write", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    const reading = Promise.withResolvers<void>();
    const readDone = Promise.withResolvers<void>();
    let wrote = false;
    let signalSeen: AbortSignal | undefined;
    paramFlashImpl = async (opts) => {
      signalSeen = opts.signal;
      reading.resolve();
      await readDone.promise; // the backup and compare
      opts.beforeWrite?.();
      wrote = true;
      return flashed(true);
    };
    const running = (await (await post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`))!.json()) as { id: string; cancellable: boolean };
    await reading.promise;
    expect(state.queue.get(running.id)).toMatchObject({ state: "running", cancellable: true });
    expect(await (await post(state, `/api/projects/${projectId}/tasks/${running.id}/cancel`))!.json()).toEqual({ cancelled: "running" });
    expect(signalSeen?.aborted).toBe(true);
    readDone.resolve();
    expect(await state.queue.wait(running.id)).toMatchObject({ state: "cancelled", cancellable: false, baselineCommitted: false });
    expect(wrote).toBe(false);
  });

  test("a dry run reaches the profile with the task's signal, and no write gate", async () => {
    const state = freshState();
    const { projectId, deviceId } = await m0081Project(state);
    let seen: { signal?: AbortSignal; beforeWrite?: () => void } = {};
    paramFlashImpl = async (opts) => { seen = opts; return { kind: "dryRun", mask: "MV-0705", imageBytes: 1, diffBytes: 1, backup: "x" }; };
    await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash?dry=1`);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.beforeWrite).toBeUndefined();
  });

  test("a restart reports unfinished work as interrupted or not started, and replays none of it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-restart-"));
    tmps.push(dir);
    const dbPath = join(dir, "busforge.db");
    const before = createState({ dbPath, dataDir: dir, now: () => 1000 });
    const { projectId, deviceId } = await mdtProject(before);
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

// A device with a stored tool key is driven over Data Secure. On System B the GA flash and the full
// download load its security object with the project's group keys; the credentials and the keys
// reach the profile. Where the memory model does not load it, those writes refuse.
corpusDescribe("a Data Secure device: its table writes carry the security object", () => {
  const readReal = catalogueXml;
  const m0162 = readReal("M-0162_A-0004-11-F245.xml.gz");
  const mdt0705 = readReal("M-0083_A-00B6-32-9642.xml.gz");
  const groupKey = Buffer.alloc(16, 0x5a);
  async function secureProject(state: AppState, app = m0162) {
    const p = await projectWithApp(state, app);
    putDeviceSecurity(state.db, p.projectId, [{ deviceId: p.deviceId, toolKey: Buffer.alloc(16, 1), serialNumber: Buffer.alloc(6, 2), sequenceNumber: "1", source: "import" }], state.masterKey);
    putGroupKeys(state.db, p.projectId, [{ raw: 1, key: groupKey, source: "import" }], state.masterKey);
    return p;
  }

  for (const route of ["flash-ga", "download"] as const) {
    test(`${route} (dry run) reaches the System B profile with the credentials and the group keys`, async () => {
      const state = freshState();
      const { projectId, deviceId } = await secureProject(state);
      let seen: { secure?: unknown; security?: { groupKeys: ReadonlyMap<number, Buffer> } } = {};
      gaFlashImpl = async (o) => { seen = o; return flashed(true); };
      downloadImpl = async (o) => { seen = o; return flashed(true); };
      try {
        await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/${route}?dry=1`);
      } finally { gaFlashImpl = realGaFlash; downloadImpl = realDownload; }
      expect(seen.secure).toEqual({ toolKey: Buffer.alloc(16, 1), serial: Buffer.alloc(6, 2), onPeerSequence: expect.any(Function) });
      expect(seen.security?.groupKeys).toEqual(new Map([[1, groupKey]]));
    });
  }

  test("the project's assigned senders and the other devices on its secured addresses reach the profile", async () => {
    const state = freshState();
    const { projectId, deviceId } = await secureProject(state);
    putGroupSenders(state.db, projectId, [{ gaRaw: 1, ia: "1.2.250", source: "import" }]);
    state.db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, 'O-1_R-1', 0, 1)").run(projectId, deviceId);
    // A link of a device the project no longer holds names no one who could send.
    state.db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, 'gone', 'O-1_R-1', 0, 1)").run(projectId);
    let seen: { security?: { senders?: ReadonlyMap<number, readonly number[]>; otherDevices?: ReadonlyMap<number, readonly unknown[]> } } = {};
    gaFlashImpl = async (o) => { seen = o; return flashed(true); };
    try { await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash-ga?dry=1`); }
    finally { gaFlashImpl = realGaFlash; }
    expect(seen.security?.senders).toEqual(new Map([[1, [0x12fa]]]));
    expect(seen.security?.otherDevices).toEqual(new Map());
  });

  test("a device without a tool key that is linked to a secured address is refused, not written plain", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, m0162);
    putGroupKeys(state.db, projectId, [{ raw: 1, key: groupKey, source: "import" }], state.masterKey);
    state.db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, 'O-1_R-1', 0, 1)").run(projectId, deviceId);
    let reached = false;
    gaFlashImpl = async () => { reached = true; return flashed(true); };
    downloadImpl = async () => { reached = true; return flashed(true); };
    try {
      for (const route of ["flash-ga?dry=1", "download?dry=1"]) {
        const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/${route}`);
        expect(res).toMatchObject({ state: "error", error: { code: "SECURE_GA_WITHOUT_DEVICE_KEY" } });
      }
    } finally { gaFlashImpl = realGaFlash; downloadImpl = realDownload; }
    expect(reached).toBe(false);
  });

  test("a forced-secure address the project holds no key for is refused, not written plain", async () => {
    const state = freshState();
    const { projectId, deviceId } = await secureProject(state);
    state.db.prepare("DELETE FROM group_keys WHERE project_id = ?").run(projectId);
    state.db.prepare("UPDATE group_addresses SET security = 'on' WHERE project_id = ? AND raw = 1").run(projectId);
    state.db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, 'O-1_R-1', 0, 1)").run(projectId, deviceId);
    let reached = false;
    gaFlashImpl = async () => { reached = true; return flashed(true); };
    downloadImpl = async () => { reached = true; return flashed(true); };
    try {
      for (const route of ["flash-ga?dry=1", "download?dry=1"]) {
        const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/${route}`);
        expect(res).toMatchObject({ state: "error", error: { code: "SECURE_GA_FORCED_WITHOUT_KEY" } });
      }
    } finally { gaFlashImpl = realGaFlash; downloadImpl = realDownload; }
    expect(reached).toBe(false);
  });

  test("an address set to never secured that still has a key is refused, not written secured", async () => {
    const state = freshState();
    const { projectId, deviceId } = await secureProject(state);
    state.db.prepare("UPDATE group_addresses SET security = 'off' WHERE project_id = ? AND raw = 1").run(projectId);
    state.db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, 'O-1_R-1', 0, 1)").run(projectId, deviceId);
    let reached = false;
    gaFlashImpl = async () => { reached = true; return flashed(true); };
    try {
      const res = await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash-ga?dry=1`);
      expect(res).toMatchObject({ state: "error", error: { code: "SECURE_GA_OFF_WITH_KEY" } });
    } finally { gaFlashImpl = realGaFlash; }
    expect(reached).toBe(false);
  });

  test("a plain device is written without either", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, m0162);
    let seen: Record<string, unknown> = {};
    gaFlashImpl = async (o) => { seen = o; return flashed(true); };
    try { await settle(handleApi, state, `/api/projects/${projectId}/devices/${deviceId}/flash-ga?dry=1`); }
    finally { gaFlashImpl = realGaFlash; }
    expect(seen.secure).toBeUndefined();
    expect(seen.security).toBeUndefined();
  });

  test("a parameter flash still reaches the profile, with the device's credentials", async () => {
    const state = freshState();
    const { projectId, deviceId } = await secureProject(state);
    let creds: unknown;
    paramFlashImpl = async (o) => { creds = o.secure; return flashed(true); };
    try { await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`)); }
    finally { paramFlashImpl = realParamFlash; }
    expect(creds).toEqual({ toolKey: Buffer.alloc(16, 1), serial: Buffer.alloc(6, 2), onPeerSequence: expect.any(Function) });
  });

  test("a parameter change that needs the com-object table rewritten runs the structural flash with the device's credentials and group keys", async () => {
    const state = freshState();
    const jungApp = catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz");
    const { projectId, deviceId } = await secureProject(state, jungApp);
    setDeviceParam(state.db, projectId, deviceId, "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-149_R-142", "8");
    paramFlashImpl = async () => { throw new Error("the surgical flash must not be reached"); };
    let seen: Record<string, unknown> = {};
    structureImpl = async (o) => { seen = o; return { ...flashed(true), structural: true }; };
    try { await programmed(state, post(state, `/api/projects/${projectId}/devices/${deviceId}/flash`)); }
    finally { paramFlashImpl = realParamFlash; structureImpl = realStructure; }
    expect(seen.secure).toMatchObject({ toolKey: Buffer.alloc(16, 1), serial: Buffer.alloc(6, 2) });
    expect(seen.security).toBeDefined();
  });

  test("a System 7 device's GA flash and download refuse the security object in the profile layer", async () => {
    const secure = { toolKey: Buffer.alloc(16, 1), serial: Buffer.alloc(6, 2) };
    const conn = { id: "c", name: "c", type: "ip", host: "127.0.0.1", port: 1 } as any;
    const base = { projectId: "p", deviceId: "d", ia: "1.1.1", appXml: mdt0705, connection: conn, secure, security: { groupKeys: new Map() }, dataDir: "/nonexistent", params: new Map(), moduleInstances: [], links: [] } as any;
    const dev = { disconnect: async () => {} } as any;
    for (const run of [
      () => classify(parseAppConfig(mdt0705)).flashGroupTables(dev, "MV-0705", { ...base, baseParams: new Map(), persistBackups: () => "" }),
      () => classify(parseAppConfig(mdt0705)).downloadFull(dev, "MV-0705", { ...base, persistBackups: () => "" }),
    ]) {
      const e = await run().catch((x: unknown) => x);
      expect((e as { code?: string }).code).toBe("SECURE_TABLES_UNSUPPORTED");
    }
  });

  test("the device view offers the GA flash and commissioning on System B, neither on System 7", async () => {
    for (const [app, offered] of [[m0162, true], [mdt0705, false]] as const) {
      const state = freshState();
      const { projectId, deviceId } = await secureProject(state, app);
      const view = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
      expect(view.capabilities.flashParams).toBe(true);
      expect(view.capabilities.flashLinks).toBe(offered);
      expect(view.capabilities.fullDownload).toBe(offered);
    }
  });
});

corpusDescribe("a Data Secure device: a security object that no longer matches is shown", () => {
  const m0162 = catalogueXml("M-0162_A-0004-11-F245.xml.gz");
  const security = async (state: AppState, projectId: string, deviceId: string) =>
    (((await (await handleApi(req(`/api/projects/${projectId}`), state))!.json()) as any).devices.find((d: any) => d.id === deviceId).changes.security ?? null) as string | null;
  async function setup(state: AppState) {
    const p = await projectWithApp(state, m0162);
    putDeviceSecurity(state.db, p.projectId, [{ deviceId: p.deviceId, toolKey: Buffer.alloc(16, 1), serialNumber: Buffer.alloc(6, 2), sequenceNumber: "1", source: "import" }], state.masterKey);
    putGroupKeys(state.db, p.projectId, [{ raw: 1, key: Buffer.alloc(16, 0x5a), source: "import" }], state.masterKey);
    setDeviceLink(state.db, p.projectId, p.deviceId, "O-1_R-1", [1]);
    return p;
  }
  const gaFlash = async (state: AppState, p: { projectId: string; deviceId: string }, verified: boolean) => {
    gaFlashImpl = async () => flashed(verified);
    try { return await programmed(state, post(state, `/api/projects/${p.projectId}/devices/${p.deviceId}/flash-ga`)); }
    finally { gaFlashImpl = realGaFlash; }
  };

  test("unknown until a verified GA flash records it, then changed by a sender or key change made elsewhere", async () => {
    const state = freshState();
    const p = await setup(state);
    expect(await security(state, p.projectId, p.deviceId)).toBe("unknown");
    await gaFlash(state, p, true);
    expect(await security(state, p.projectId, p.deviceId)).toBeNull();

    // A sender assigned to the address (not this device's own link) changes its sender table.
    putGroupSenders(state.db, p.projectId, [{ gaRaw: 1, ia: "1.2.250", source: "busforge" }]);
    expect(await security(state, p.projectId, p.deviceId)).toBe("changed");
    // The link baseline is untouched: the device's own change count says nothing about it.
    expect(getDeviceChangedKeys(state.db, p.projectId, p.deviceId).links.size).toBe(0);
    // An unverified write records nothing.
    await gaFlash(state, p, false);
    expect(await security(state, p.projectId, p.deviceId)).toBe("changed");
    await gaFlash(state, p, true);
    expect(await security(state, p.projectId, p.deviceId)).toBeNull();

    // A new key for the address, as one generated or re-keyed elsewhere.
    putGroupKeys(state.db, p.projectId, [{ raw: 1, key: Buffer.alloc(16, 0x6b), source: "generated" }], state.masterKey);
    expect(await security(state, p.projectId, p.deviceId)).toBe("changed");
  });

  test("another secure device linking a transmitting object to the address flags this one, not itself", async () => {
    const state = freshState();
    const p = await setup(state);
    await gaFlash(state, p, true);
    // A second secure device of the same product at another address.
    const cols = (state.db.query("PRAGMA table_info(devices)").all() as { name: string }[]).map((c) => c.name).filter((c) => !["id", "instance_id", "ia"].includes(c));
    state.db.prepare(`INSERT INTO devices (instance_id, ia, ${cols.join(", ")}) SELECT 'peer', '1.1.250', ${cols.join(", ")} FROM devices WHERE project_id = ? AND instance_id = ?`).run(p.projectId, p.deviceId);
    state.db.prepare("UPDATE devices SET security_base = NULL WHERE instance_id = 'peer'").run();
    putDeviceSecurity(state.db, p.projectId, [{ deviceId: "peer", toolKey: Buffer.alloc(16, 3), serialNumber: Buffer.alloc(6, 4), sequenceNumber: "7", source: "import" }], state.masterKey);
    expect(await security(state, p.projectId, p.deviceId)).toBeNull();
    // The object is the one this device links: it transmits, so the peer becomes one of its senders.
    setDeviceLink(state.db, p.projectId, "peer", "O-1_R-1", [1]);
    expect(await security(state, p.projectId, p.deviceId)).toBe("changed");
    expect(getDeviceChangedKeys(state.db, p.projectId, p.deviceId).links.size).toBe(0);
    // Moving the peer to another address changes the entry this device would list.
    await gaFlash(state, p, true);
    expect(await security(state, p.projectId, p.deviceId)).toBeNull();
    state.db.prepare("UPDATE devices SET ia = '1.1.251' WHERE instance_id = 'peer'").run();
    expect(await security(state, p.projectId, p.deviceId)).toBe("changed");
  });

  test("a GA flash that finds the device already matching records it, a dry run does not", async () => {
    const state = freshState();
    const p = await setup(state);
    gaFlashImpl = async () => ({ kind: "unchanged", mask: "MV-0701", imageBytes: 1, backup: "x" });
    try {
      await settle(handleApi, state, `/api/projects/${p.projectId}/devices/${p.deviceId}/flash-ga?dry=1`);
      expect(await security(state, p.projectId, p.deviceId)).toBe("unknown");
      await programmed(state, post(state, `/api/projects/${p.projectId}/devices/${p.deviceId}/flash-ga`));
    } finally { gaFlashImpl = realGaFlash; }
    expect(await security(state, p.projectId, p.deviceId)).toBeNull();
  });

  test("a sequence number the device moved on does not count as a change", async () => {
    const state = freshState();
    const p = await setup(state);
    await gaFlash(state, p, true);
    state.db.prepare("UPDATE device_security SET seq_group = '99999' WHERE project_id = ?").run(p.projectId);
    expect(await security(state, p.projectId, p.deviceId)).toBeNull();
  });

  test("the baseline travels with a .busforge export", async () => {
    const state = freshState();
    const p = await setup(state);
    await gaFlash(state, p, true);
    const res = (await handleApi(req(`/api/projects/${p.projectId}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), state))!;
    const form = new FormData();
    form.set("file", new File([await res.arrayBuffer()], "p.busforge"));
    const imp = (await (await handleApi(req("/api/projects/import-busforge", { method: "POST", body: form }), state))!.json()) as any;
    expect(await security(state, imp.id, p.deviceId)).toBeNull();
  });
});

corpusDescribe("a Data Secure device: addressing and activation", () => {
  const m0162 = catalogueXml("M-0162_A-0004-11-F245.xml.gz");
  const secureProject = async (state: AppState) => {
    const p = await projectWithApp(state, m0162);
    putDeviceSecurity(state.db, p.projectId, [{ deviceId: p.deviceId, toolKey: Buffer.alloc(16, 1), serialNumber: Buffer.from("00fa01020304", "hex"), sequenceNumber: "1", source: "import" }], state.masterKey);
    return p;
  };
  const put = (state: AppState, path: string, body: unknown) => handleApi(new Request(`http://x${path}`, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), state);

  // A master reset clears the address along with the key, so the address has to be assignable. The
  // broadcast goes out plain; the knx layer proves the result on the new address.
  test("assign-ia is not refused for being secure", async () => {
    const state = freshState();
    const { projectId, deviceId } = await secureProject(state);
    const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/assign-ia`))!;
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).kind).toBe("assign-ia");
  });

  test("a certificate is stored sealed only when it decodes and belongs to this device", async () => {
    const state = freshState();
    const { projectId, deviceId } = await secureProject(state);
    const path = `/api/projects/${projectId}/devices/${deviceId}/certificate`;
    const fdsk = Buffer.alloc(16, 0xfd);
    expect(((await (await put(state, path, { certificate: "AAAAAA" }))!.json()) as any).error.code).toBe("CERTIFICATE_INVALID");
    const other = encodeCertificate(Buffer.from("00fa09090909", "hex"), fdsk);
    expect(((await (await put(state, path, { certificate: other }))!.json()) as any).error.code).toBe("CERTIFICATE_SERIAL_MISMATCH");
    const res = (await put(state, path, { certificate: encodeCertificate(Buffer.from("00fa01020304", "hex"), fdsk) }))!;
    expect(await res.json()).toEqual({ serial: "00fa01020304" });
    expect(getDeviceCertificate(state.db, projectId, deviceId, state.masterKey)?.fdsk).toEqual(fdsk);
    const raw = state.db.query("SELECT fdsk FROM device_certificates").get() as { fdsk: Uint8Array };
    expect(Buffer.from(raw.fdsk).equals(fdsk)).toBe(false);
  });

  test("a project holding a tool key only busforge has is not deleted without the acknowledgement", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, m0162);
    putDeviceSecurity(state.db, projectId, [{ deviceId, toolKey: Buffer.alloc(16, 1), serialNumber: Buffer.alloc(6, 2), sequenceNumber: "", source: "provisioned" }], state.masterKey);
    const del = (q = "") => handleApi(new Request(`http://x/api/projects/${projectId}${q}`, { method: "DELETE" }), state);
    const refused = (await del())!;
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error.code).toBe("PROJECT_HOLDS_OWN_KEYS");
    expect((await del("?keysExported=1"))!.status).toBe(200);
  });

  test("activation without a stored certificate is refused before any bus access", async () => {
    const state = freshState();
    const { projectId, deviceId } = await secureProject(state);
    const res = (await post(state, `/api/projects/${projectId}/devices/${deviceId}/secure-activate`))!;
    expect(((await res.json()) as any).error.code).toBe("CERTIFICATE_MISSING");
  });
});


// A com-object flag edited on the device page: the group-address flash writes it, as ETS's group-address
// download does, and so does the full download; each receives the edit by object number and only a
// verified one adopts it as what the device holds. The parameter flash does not write flags: it runs,
// and the edit stays pending.
corpusDescribe("an edited com-object flag", () => {
  test("goes to the group-address flash and the full download, which adopt it only when verified; the parameter flash leaves it pending", async () => {
    const state = freshState();
    const { projectId, deviceId } = await mdtProject(state);
    const base = `/api/projects/${projectId}/devices/${encodeURIComponent(deviceId)}`;
    const view = (await (await handleApi(req(`${base}/config`), state))!.json()) as any;
    const o = view.blocks.flatMap((b: any) => b.items).find((i: any) => i.kind === "comObject").comObject;
    const setRead = (read: boolean | null) =>
      handleApi(req(`${base}/comobject-flags`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ comObjRefId: o.refId, flags: { read } }) }), state);
    const pending = () => getDeviceChangedKeys(state.db, projectId, deviceId).flags.size;
    expect((await setRead(!o.flags.read))!.status).toBe(200);
    try {
      paramFlashImpl = async () => flashed(true);
      await programmed(state, post(state, `${base}/flash`));
      expect(pending()).toBe(1);
      let ga: { changes?: ReadonlySet<number>; override?: unknown } = {};
      gaFlashImpl = async (opts) => { ga = { changes: opts.comObjectFlagChanges, override: opts.comObjectOverrides.get(o.number) }; return flashed(false); };
      await programmed(state, post(state, `${base}/flash-ga`));
      expect(ga).toEqual({ changes: new Set([o.number]), override: { flags: { read: !o.flags.read } } });
      expect(pending()).toBe(1); // not verified: nothing adopted
      gaFlashImpl = async () => flashed(true);
      await programmed(state, post(state, `${base}/flash-ga`));
      expect(pending()).toBe(0);
      // the edit back goes the same way
      await setRead(null);
      expect(pending()).toBe(1);
      await programmed(state, post(state, `${base}/flash-ga`));
      expect(pending()).toBe(0);
      // a device found already holding the edit (unchanged against the tables built with it) takes it too
      await setRead(!o.flags.read);
      gaFlashImpl = async () => ({ kind: "unchanged", mask: "MV-0705", imageBytes: 1 } as FlashResult);
      await programmed(state, post(state, `${base}/flash-ga`)).catch(() => undefined);
      expect(pending()).toBe(0);
      await setRead(null);
      gaFlashImpl = async () => flashed(true);
      await programmed(state, post(state, `${base}/flash-ga`));
      expect(pending()).toBe(0);
    } finally { paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; }
    await setRead(!o.flags.read);
    let seen: unknown;
    try {
      downloadImpl = async (opts) => { seen = opts.comObjectOverrides.get(o.number); return flashed(false); };
      await programmed(state, post(state, `${base}/download`));
      expect(seen).toEqual({ flags: { read: !o.flags.read } });
      expect(getDeviceChangedKeys(state.db, projectId, deviceId).flags.size).toBe(1); // not verified: nothing adopted
      // an edit made while the download runs is not what it wrote: it stays pending
      downloadImpl = async () => {
        await handleApi(req(`${base}/comobject-flags`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ comObjRefId: o.refId, priority: o.priority === "Alert" ? "Low" : "Alert" }) }), state);
        return flashed(true);
      };
      await programmed(state, post(state, `${base}/download`));
      expect(getDeviceChangedKeys(state.db, projectId, deviceId).flags.size).toBe(1);
      downloadImpl = async () => flashed(true);
      await programmed(state, post(state, `${base}/download`));
      expect(getDeviceChangedKeys(state.db, projectId, deviceId).flags.size).toBe(0);
    } finally { downloadImpl = realDownload; paramFlashImpl = realParamFlash; gaFlashImpl = realGaFlash; }
    // the structural flash writes the com-object table from the project as well, and adopts the same way
    setDeviceParam(state.db, projectId, deviceId, "M-0083_A-00B6-32-9642_MD-2_M-3_MI-1_P-24_R-2", "7"); // input B: two objects, the com-object table changes
    await setRead(null);
    expect(pending()).toBe(1);
    try {
      structureImpl = async () => flashed(true);
      expect((await programmed(state, post(state, `${base}/flash`))).kind).toBe("flash-structure");
      expect(pending()).toBe(0);
    } finally { structureImpl = realStructure; }
  });
});
