import { test, expect, mock, afterAll, describe, setDefaultTimeout } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAbsoluteSegmentTargets, parseAppConfig } from "@busforge/product";
import { CollectedUnit, asDevice, type Collection } from "../../../packages/product/test/collected-unit.ts";
import { catalogueXml, corpusPath, inServiceCollection } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { readBackAs } from "./task-client.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 1.0 s with the
// file alone (load 5-27) and up to 1.0 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(60_000);

// The read-back route's two rules beyond the plain read: values it is asked to assume for parameters
// without a memory location, taken into project and baseline only when every link then resolves, and
// "never programmed", which a complete read of a device reporting this application's id clears.
// readDeviceState is replaced by the real read on an open session (readStateOn), run on an emulated
// unit, or by a fixed result where the rule alone is under test.
const real = await import("../src/deviceprofile.ts");
const realRead = real.readDeviceState;
const realReadOn = real.readStateOn;
let readImpl: typeof realRead = realRead;
const realParamFlash = real.flashDeviceParameters, realStructureFlash = real.flashDeviceStructure;
let paramFlashImpl: typeof realParamFlash = realParamFlash;
let structureFlashImpl: typeof realStructureFlash = realStructureFlash;
await mock.module("../src/deviceprofile.ts", () => ({ ...real, readDeviceState: (o: Parameters<typeof realRead>[0]) => readImpl(o), flashDeviceParameters: (o: Parameters<typeof realParamFlash>[0]) => paramFlashImpl(o), flashDeviceStructure: (o: Parameters<typeof realStructureFlash>[0]) => structureFlashImpl(o) }));
const { handleApi, createState } = await import("../src/app.ts");
type DeviceStateRead = Awaited<ReturnType<typeof realRead>>;
type AppState = ReturnType<typeof createState>;
afterAll(() => { readImpl = realRead; paramFlashImpl = realParamFlash; structureFlashImpl = realStructureFlash; });

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");

// The demo project's first device, its application swapped for `appXml` when given, reset to what a
// placement leaves: nothing stored, never programmed.
async function placed(appXml?: string): Promise<{ state: AppState; pid: string; did: string; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-readback-assume-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([readFileSync(join(fixtures, "sample-config.knxproj"))], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const pid = ((await (await handleApi(req("/api/projects/import", { method: "POST", body: form }), state))!.json()) as { id: string }).id;
  const did = ((await (await handleApi(req(`/api/projects/${pid}`), state))!.json()) as { devices: { id: string }[] }).devices[0].id;
  if (appXml) state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [appXml, "M-TEST_A-1"]);
  for (const t of ["device_parameters", "device_param_base", "device_links", "device_link_base"]) state.db.run(`DELETE FROM ${t} WHERE project_id = ? AND device_id = ?`, [pid, did]);
  state.db.run("UPDATE devices SET never_programmed = 1, link_base_gaps = 0 WHERE project_id = ? AND instance_id = ?", [pid, did]);
  const conn = (await (await handleApi(req("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }) }), state))!.json()) as { id: string };
  await handleApi(req(`/api/projects/${pid}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: conn.id }) }), state);
  return { state, pid, did, path: `/api/projects/${pid}/devices/${encodeURIComponent(did)}` };
}
type Body = { readback?: Record<string, unknown>; linkBaseGaps?: number; error?: { code: string; message: string; details?: Record<string, unknown> } };
const readBack = async (state: AppState, path: string, assume?: { paramRefId: string; value: string }[]) => {
  const r = await readBackAs(handleApi, state, path, assume ? { assume } : {});
  return { ...r, body: r.body as Body };
};
const neverProgrammed = (state: AppState, pid: string, did: string) =>
  (state.db.query("SELECT never_programmed AS n FROM devices WHERE project_id = ? AND instance_id = ?").get(pid, did) as { n: number }).n === 1;
const stored = (state: AppState, pid: string, did: string) => ({
  live: state.db.query("SELECT param_ref_id AS r, value AS v FROM device_parameters WHERE project_id = ? AND device_id = ? ORDER BY r").all(pid, did),
  base: state.db.query("SELECT param_ref_id AS r, value AS v FROM device_param_base WHERE project_id = ? AND device_id = ? ORDER BY r").all(pid, did),
  links: state.db.query("SELECT com_obj_ref_id AS k, ga_raw AS g FROM device_link_base WHERE project_id = ? AND device_id = ? ORDER BY k").all(pid, did),
});

describe("a read-back and never programmed", () => {
  const read = (over: Partial<DeviceStateRead>): typeof realRead => async () =>
    ({ mask: "MV-0705", paramsRead: true, linksRead: true, paramBase: new Map<string, string>(), links: [], deviceConfig: new Map<string, string>(), programIdMatches: true, loaded: true, imageMatches: true, ...over });

  test("a complete read without unresolved links, of a device reporting this application's id, loaded, its image as the project's, clears it", async () => {
    const { state, pid, did, path } = await placed();
    readImpl = read({});
    try { expect((await readBack(state, path)).state).toBe("done"); } finally { readImpl = realRead; }
    expect(neverProgrammed(state, pid, did)).toBe(false);
  });

  test("constant parameters the device differs in are no change, and the read names them", async () => {
    const { state, pid, did, path } = await placed();
    const constantsDiffer = [{ paramRefId: "M-TEST_A-1_P-9_R-9", label: "Download marker" }];
    readImpl = read({ constantsDiffer });
    let body: Body = {};
    try { const r = await readBack(state, path); expect(r.state).toBe("done"); body = r.body; } finally { readImpl = realRead; }
    expect(body.readback?.constantsDiffer).toEqual(constantsDiffer);
    expect(neverProgrammed(state, pid, did)).toBe(false);
  });

  test("each reason it stays is named by its code", async () => {
    const cases: [Partial<DeviceStateRead>, unknown][] = [
      // A read that missed a part compares no image either; the reason is named once.
      [{ paramsRead: false, deviceConfig: undefined, imageMatches: null, imageRefused: "the read did not cover both parameters and links" }, [{ reason: "readIncomplete" }]],
      [{ imageMatches: null }, [{ reason: "imageNotCompared" }]],
      [{ programIdMatches: false }, [{ reason: "otherApplication" }]],
      [{ programIdMatches: null, loaded: false }, [{ reason: "applicationIdNotReported" }, { reason: "notLoaded" }]],
      [{ imageMatches: false }, [{ reason: "imageDiffers" }]],
      // Why the image was not compared travels as a code the client localizes, never as prose.
      [{ imageMatches: null, imageRefused: "PROPERTY_REFUSED: no", imageRefusedCode: "PROPERTY_REFUSED" }, [{ reason: "imageNotCompared", code: "PROPERTY_REFUSED" }]],
    ];
    for (const [over, want] of cases) {
      const { state, path } = await placed();
      readImpl = read(over);
      try { expect([over, (await readBack(state, path)).body.readback?.neverProgrammedKept]).toEqual([over, want]); } finally { readImpl = realRead; }
    }
  });

  test("it stays with an unresolved link, another application id, none reported, a load state not LOADED, an image a flash would change or one not compared, or a read that missed a part", async () => {
    for (const over of [{ links: [{ comObjNum: 9999, gaRaws: [123] }] }, { programIdMatches: false }, { programIdMatches: null }, { loaded: false }, { imageMatches: false }, { imageMatches: null }, { paramsRead: false }, { linksRead: false }]) {
      const { state, pid, did, path } = await placed();
      readImpl = read(over);
      try { expect((await readBack(state, path)).state).toBe("done"); } finally { readImpl = realRead; }
      expect([over, neverProgrammed(state, pid, did)]).toEqual([over, true]);
    }
  });

  test("an unresolved link is named by its object number", async () => {
    const { state, path } = await placed();
    readImpl = read({ links: [{ comObjNum: 9999, gaRaws: [123] }] });
    try { expect((await readBack(state, path)).body.readback).toEqual({ paramsRead: true, linksRead: true, flagsRead: false, linkGaps: 1, unresolvedObjects: [9999], unplacedObjects: [9999], neverProgrammedKept: [{ reason: "linksUnresolved" }] }); } finally { readImpl = realRead; }
  });
});

// The demo application: P-1 "Mode" (On shows object 0 and P-2, Off shows P-3).
const DEMO = "M-TEST_A-1";
const MODE = `${DEMO}_P-1_R-1`, NOTE = `${DEMO}_P-4_R-4`, UNIT = `${DEMO}_P-6_R-6`;
const demoXml = (state: AppState) => (state.db.query("SELECT xml FROM app_programs WHERE id = ?").get(DEMO) as { xml: string }).xml;
// The demo application with "Mode" held by no memory location, a memoryless "Note" that changes
// nothing the device holds, as an application's purely descriptive choice does, and a memoryless
// "Unit" that shows a memory-backed "Step" (its value is written only while shown) and no object.
function memorylessDemo(state: AppState): void {
  let xml = demoXml(state);
  const swap = (from: string, to: string) => { expect(xml.split(from).length).toBe(2); xml = xml.replace(from, to); };
  swap('<Memory CodeSegment="M-TEST_A-1_RS-4" Offset="0" BitOffset="0" />', "");
  // A parameter segment, so the image holds the parameters' bytes.
  swap("<ParameterTypes>", '<Code><RelativeSegment Id="M-TEST_A-1_RS-4" LoadStateMachine="4" Size="16" Data="AAAAAAAAAAAAAAAAAAAAAA==" /></Code><ParameterTypes>');
  swap("</Parameters>", '<Parameter Id="M-TEST_A-1_P-4" Name="Note" ParameterType="M-TEST_A-1_PT-Mode" Text="Note" Value="0" />'
    + '<Parameter Id="M-TEST_A-1_P-6" Name="Unit" ParameterType="M-TEST_A-1_PT-Mode" Text="Unit" Value="0" />'
    + '<Parameter Id="M-TEST_A-1_P-7" Name="Step" ParameterType="M-TEST_A-1_PT-Num" Text="Step" Value="5"><Memory CodeSegment="M-TEST_A-1_RS-4" Offset="13" BitOffset="0" /></Parameter></Parameters>');
  swap("</ParameterRefs>", '<ParameterRef Id="M-TEST_A-1_P-4_R-4" RefId="M-TEST_A-1_P-4" /><ParameterRef Id="M-TEST_A-1_P-6_R-6" RefId="M-TEST_A-1_P-6" /><ParameterRef Id="M-TEST_A-1_P-7_R-7" RefId="M-TEST_A-1_P-7" /></ParameterRefs>');
  swap('<ParameterRefRef RefId="M-TEST_A-1_P-1_R-1" />', '<ParameterRefRef RefId="M-TEST_A-1_P-1_R-1" /><ParameterRefRef RefId="M-TEST_A-1_P-4_R-4" />'
    + '<ParameterRefRef RefId="M-TEST_A-1_P-6_R-6" /><choose ParamRefId="M-TEST_A-1_P-6_R-6"><when test="1"><ParameterRefRef RefId="M-TEST_A-1_P-7_R-7" /></when></choose>');
  state.db.run("UPDATE app_programs SET xml = ? WHERE id = ?", [xml, DEMO]);
}
type ParamRow = { refId: string; value: string; changed?: boolean; assumed?: true };
const paramsOf = (view: { blocks?: { items: { kind: string; param?: ParamRow }[] }[] }) =>
  new Map((view.blocks ?? []).flatMap((b) => b.items).filter((it) => it.kind === "param").map((it) => [it.param!.refId, it.param!]));
const config = async (state: AppState, path: string) => paramsOf((await (await handleApi(req(`${path}/config`), state))!.json()) as Parameters<typeof paramsOf>[0]);
const send = async (state: AppState, path: string, op: string, body: unknown) =>
  paramsOf((await (await handleApi(req(`${path}/${op}`, { method: op === "params" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), state))!.json()) as Parameters<typeof paramsOf>[0]);
const marks = (state: AppState, pid: string, did: string) =>
  state.db.query("SELECT param_ref_id AS r, value AS v FROM device_param_assumed WHERE project_id = ? AND device_id = ? ORDER BY r").all(pid, did);
// A device holding exactly the values the read is run under, as a unit that runs them.
const holdingAll: typeof realRead = async (o) =>
  ({ mask: "MV-07B0", paramsRead: true, linksRead: true, paramBase: new Map(o.baseParams), links: [], deviceConfig: new Map(o.liveParams), programIdMatches: true, loaded: true, imageMatches: true });

describe("the objects a read leaves unresolved, by what resolves them", () => {
  const reading = (deviceConfig: Map<string, string> | undefined, links: { comObjNum: number; gaRaws: number[] }[]): typeof realRead => async () =>
    ({ mask: "MV-07B0", paramsRead: deviceConfig !== undefined, linksRead: true, paramBase: new Map<string, string>(), links, deviceConfig, programIdMatches: true, loaded: true, imageMatches: true });
  const split = async (projectMode: string | null, read: typeof realRead) => {
    const { state, pid, did, path } = await placed();
    if (projectMode !== null) state.db.run("INSERT INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)", [pid, did, MODE, projectMode]);
    readImpl = read;
    try {
      const rb = (await readBack(state, path)).body.readback!;
      return { unresolvedObjects: rb.unresolvedObjects, unplacedObjects: rb.unplacedObjects, hiddenObjects: rb.hiddenObjects, unknownObjects: rb.unknownObjects };
    } finally { readImpl = realRead; }
  };

  test("a link the device's own configuration places no object for is one only another value of a parameter the read does not see resolves", async () => {
    expect(await split("0", reading(new Map([[MODE, "0"]]), [{ comObjNum: 0, gaRaws: [1] }]))).toEqual({ unresolvedObjects: [0], unplacedObjects: [0], hiddenObjects: undefined, unknownObjects: undefined });
    expect(await split(null, reading(new Map(), [{ comObjNum: 9999, gaRaws: [1] }]))).toEqual({ unresolvedObjects: [9999], unplacedObjects: [9999], hiddenObjects: undefined, unknownObjects: undefined });
  });

  test("a link on an object the device's configuration places and only the project's own values hide is one Revert resolves", async () => {
    expect(await split("0", reading(new Map([[MODE, "1"]]), [{ comObjNum: 0, gaRaws: [1] }]))).toEqual({ unresolvedObjects: [0], unplacedObjects: undefined, hiddenObjects: [0], unknownObjects: undefined });
  });

  test("a read without the device's parameters cannot tell, and says so", async () => {
    expect(await split(null, reading(undefined, [{ comObjNum: 9999, gaRaws: [1] }]))).toEqual({ unresolvedObjects: [9999], unplacedObjects: undefined, hiddenObjects: undefined, unknownObjects: [9999] });
  });
});

describe("a value assumed, not proven, stays marked on its parameter", () => {
  test("the read marks it in the store and on the row; a proven one is not marked", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    readImpl = holdingAll;
    let r: Awaited<ReturnType<typeof readBack>>;
    try { r = await readBack(state, path, [{ paramRefId: NOTE, value: "1" }, { paramRefId: MODE, value: "0" }]); } finally { readImpl = realRead; }
    expect(r.state).toBe("done");
    expect(r.body.readback?.unprovenAssumptions).toEqual([NOTE]);
    expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: "1" }]);
    const rows = paramsOf(r.body as Parameters<typeof paramsOf>[0]);
    expect([rows.get(NOTE)?.assumed, rows.get(MODE)?.assumed]).toEqual([true, undefined]);
    // after a reload
    expect((await config(state, path)).get(NOTE)?.assumed).toBe(true);
  });

  test("an edit shows the edited value unmarked; a revert brings the assumed value back, marked", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    readImpl = holdingAll;
    try { await readBack(state, path, [{ paramRefId: NOTE, value: "1" }]); } finally { readImpl = realRead; }
    const edited = (await send(state, path, "params", { paramRefId: NOTE, value: "0" })).get(NOTE)!;
    expect([edited.value, edited.changed, edited.assumed]).toEqual(["0", true, undefined]);
    expect((await send(state, path, "revert-param", { paramRefId: NOTE })).get(NOTE)?.assumed).toBe(true);
    await send(state, path, "params", { paramRefId: NOTE, value: "0" });
    expect((await send(state, path, "revert", {})).get(NOTE)?.assumed).toBe(true);
    expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: "1" }]);
  });

  test("a later plain read keeps it; a read that assumes it again takes its verdict, and one that proves an earlier mark clears it", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    readImpl = holdingAll;
    try {
      await readBack(state, path, [{ paramRefId: NOTE, value: "1" }]);
      await readBack(state, path);
      expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: "1" }]);
      // assumed again at its default, which the baseline holds as no row
      await readBack(state, path, [{ paramRefId: NOTE, value: "0" }]);
      expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: null }]);
      expect((await config(state, path)).get(NOTE)).toMatchObject({ value: "0", assumed: true });
      // a mark an earlier read left on "Mode", which this read proves
      state.db.run("INSERT INTO device_param_assumed (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, NULL)", [pid, did, MODE]);
      expect((await readBack(state, path, [{ paramRefId: MODE, value: "1" }])).state).toBe("done");
    } finally { readImpl = realRead; }
    expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: null }]);
  });

  test("a mark is shown only on the value it is about; one on a parameter the project's configuration does not show is counted", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    // A mark whose value the baseline does not hold (as a crafted artifact could carry) marks nothing.
    state.db.run("INSERT INTO device_param_assumed (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, '1')", [pid, did, NOTE]);
    expect((await config(state, path)).get(NOTE)?.assumed).toBeUndefined();
    // "Level" (P-2), shown only while "Mode" is On; with Mode Off in the project its row is not shown.
    const LEVEL = `${DEMO}_P-2_R-2`;
    state.db.run("DELETE FROM device_param_assumed WHERE project_id = ?", [pid]);
    state.db.run("INSERT INTO device_param_assumed (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, NULL)", [pid, did, LEVEL]);
    const view = async () => (await (await handleApi(req(`${path}/config`), state))!.json()) as { assumedHidden?: number };
    expect((await view()).assumedHidden).toBeUndefined();
    await send(state, path, "params", { paramRefId: MODE, value: "0" });
    expect((await view()).assumedHidden).toBe(1);
  });

  // A verified parameter flash adopts the project's values into the baseline (resetParamBase).
  const flashOnce = async (state: AppState, path: string) => {
    const verified = async () => ({ kind: "flashed" as const, mask: "MV-07B0", imageBytes: 1, diffBytes: 1, verified: true, backup: "x" });
    paramFlashImpl = verified; structureFlashImpl = verified;
    try {
      const res = (await handleApi(req(`${path}/flash`, { method: "POST" }), state))!;
      expect([res.status, res.status === 202 ? "" : await res.clone().text()]).toEqual([202, ""]);
      const task = (await state.queue.wait(((await res.json()) as { id: string }).id))!;
      expect(task).toMatchObject({ state: "done", baselineCommitted: true });
    } finally { paramFlashImpl = realParamFlash; structureFlashImpl = realStructureFlash; }
  };
  const flashable = async (state: AppState, pid: string, did: string, path: string) => {
    state.db.run("UPDATE devices SET never_programmed = 0 WHERE project_id = ? AND instance_id = ?", [pid, did]);
    expect((await handleApi(req(`${path}/untested-ack`, { method: "PUT" }), state))!.status).toBe(200);
  };

  // The parameter has no memory location: a write never reaches it and proves nothing about it.
  test("a verified flash keeps the mark on the value it records, the same or another", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    readImpl = holdingAll;
    try { await readBack(state, path, [{ paramRefId: NOTE, value: "1" }]); } finally { readImpl = realRead; }
    await flashable(state, pid, did, path);
    await flashOnce(state, path);
    expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: "1" }]);
    await send(state, path, "params", { paramRefId: NOTE, value: "0" });
    await flashOnce(state, path);
    expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: null }]);
    expect((await config(state, path)).get(NOTE)).toMatchObject({ value: "0", assumed: true });
  });

  test("a mark moved by a write ends only when a read assumes the new value and proves it", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    // "Step" holds 7 on the device and in the project, so the image differs with "Unit" On (7 written) and
    // Off (Step's default written in its place).
    for (const t of ["device_parameters", "device_param_base"]) state.db.run(`INSERT INTO ${t} (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, '7')`, [pid, did, `${DEMO}_P-7_R-7`]);
    // "Unit" assumed Off (its default) by an earlier read that could not tell it apart.
    state.db.run("INSERT INTO device_param_assumed (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, NULL)", [pid, did, UNIT]);
    await flashable(state, pid, did, path);
    await send(state, path, "params", { paramRefId: UNIT, value: "1" });
    await flashOnce(state, path);
    expect(marks(state, pid, did)).toEqual([{ r: UNIT, v: "1" }]);
    expect((await config(state, path)).get(UNIT)).toMatchObject({ value: "1", assumed: true });
    // On writes "Step", Off does not: a read assuming On proves it.
    readImpl = holdingAll;
    try {
      const r = await readBack(state, path, [{ paramRefId: UNIT, value: "1" }]);
      expect([r.state, r.body.readback?.unprovenAssumptions]).toEqual(["done", undefined]);
    } finally { readImpl = realRead; }
    expect(marks(state, pid, did)).toEqual([]);
  });

  test("a baseline write that records the assumed default as a row of its own keeps the mark", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    readImpl = holdingAll;
    try { await readBack(state, path, [{ paramRefId: NOTE, value: "0" }]); } finally { readImpl = realRead; }
    expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: null }]);
    // the project holds the default as an explicit row, as a .knxproj import can
    state.db.run("INSERT INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, '0')", [pid, did, NOTE]);
    await flashable(state, pid, did, path);
    await flashOnce(state, path);
    expect(state.db.query("SELECT value AS v FROM device_param_base WHERE project_id = ? AND device_id = ? AND param_ref_id = ?").get(pid, did, NOTE)).toEqual({ v: "0" });
    expect(marks(state, pid, did)).toEqual([{ r: NOTE, v: "0" }]);
    expect((await config(state, path)).get(NOTE)?.assumed).toBe(true);
  });

  test("a refused assumption marks nothing", async () => {
    const { state, pid, did, path } = await placed();
    memorylessDemo(state);
    readImpl = async (o) => ({ ...(await holdingAll(o)), imageMatches: false });
    try { expect((await readBack(state, path, [{ paramRefId: NOTE, value: "1" }])).body.error?.code).toBe("READBACK_ASSUMPTION_IMAGE_DIFFERS"); } finally { readImpl = realRead; }
    expect(marks(state, pid, did)).toEqual([]);
  });
});

corpusDescribe("a read-back of the Gira Tastsensor 3 Komfort, assuming the values of parameters without a memory location", () => {
  const xml = catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz");
  const collection = JSON.parse(readFileSync(corpusPath(inServiceCollection("gira-m0008-in-service")), "utf8")) as Collection;
  const A = "M-0008_A-10D7-11-2783-O000A";
  // The unit's rocker functions ("Dimmen") and status LED functions, as its ETS project sets them.
  const ROCKERS = [{ paramRefId: `${A}_P-224_R-224`, value: "2" }, { paramRefId: `${A}_P-2194_R-2194`, value: "2" }];
  const LEDS = [{ paramRefId: `${A}_P-579_R-579`, value: "3" }, { paramRefId: `${A}_P-1286_R-1286`, value: "3" }];
  const onUnit = async <T>(fn: () => Promise<T>): Promise<T> => {
    const dev = new CollectedUnit(collection);
    readImpl = (o) => realReadOn(asDevice(dev), "MV-0705", o);
    try { return await fn(); } finally { readImpl = realRead; }
  };

  test("without them, the unit's dimming objects stay hidden: two links unresolved, named, and the device stays never programmed", async () => {
    const { state, pid, did, path } = await placed(xml);
    const r = await onUnit(() => readBack(state, path));
    // 18 and 20 no configuration of the unit's held values places (the rocker functions decide them);
    // 64 the unit's configuration places, and only the project's own values hide it.
    expect(r.body.readback).toEqual({ paramsRead: true, linksRead: true, flagsRead: true, linkGaps: 3, unresolvedObjects: [18, 20, 64], unplacedObjects: [18, 20], hiddenObjects: [64], neverProgrammedKept: [{ reason: "linksUnresolved" }, { reason: "imageDiffers" }] });
    expect(neverProgrammed(state, pid, did)).toBe(true);
  });

  test("with them, project and baseline take them, and once the project takes the device's values every link resolves and the device no longer counts as never programmed", async () => {
    const { state, pid, did, path } = await placed(xml);
    const r = await onUnit(() => readBack(state, path, [...ROCKERS, ...LEDS]));
    expect(r.state).toBe("done");
    // Object 64 is shown by a parameter with a memory location, which the project takes on revert.
    expect(r.body.readback).toEqual({ paramsRead: true, linksRead: true, flagsRead: true, linkGaps: 1, unresolvedObjects: [64], hiddenObjects: [64], neverProgrammedKept: [{ reason: "linksUnresolved" }] });
    const s = stored(state, pid, did);
    for (const a of [...ROCKERS, ...LEDS]) {
      expect(s.live).toContainEqual({ r: a.paramRefId, v: a.value });
      expect(s.base).toContainEqual({ r: a.paramRefId, v: a.value });
    }
    expect(neverProgrammed(state, pid, did)).toBe(true);
    expect((await handleApi(req(`${path}/revert`, { method: "POST" }), state))!.status).toBe(200);
    const again = await onUnit(() => readBack(state, path));
    expect(again.body.readback).toEqual({ paramsRead: true, linksRead: true, flagsRead: true, linkGaps: 0 });
    expect(again.body.linkBaseGaps).toBe(0);
    for (const a of [...ROCKERS, ...LEDS]) expect(stored(state, pid, did).base).toContainEqual({ r: a.paramRefId, v: a.value });
    expect(neverProgrammed(state, pid, did)).toBe(false);
  });

  // P-3738 "Downloaderkennung" is a constant parameter (R17): a unit holding another value there is
  // taken over all the same, and the read names it.
  test("a unit that differs only in a constant parameter is taken over, and the read names it", async () => {
    const { state, pid, did, path } = await placed(xml);
    await onUnit(() => readBack(state, path, [...ROCKERS, ...LEDS]));
    await handleApi(req(`${path}/revert`, { method: "POST" }), state);
    const cfg = parseAppConfig(xml);
    const marker = buildAbsoluteSegmentTargets(cfg, new Map()).flatMap((t) => t.constants.map((c) => ({ ...c, at: t.address + c.offset })))
      .find((c) => c.paramId === `${A}_P-3738`)!;
    const dev = new CollectedUnit(collection);
    dev.mem.set(marker.at, dev.mem.get(marker.at)! ^ 0xff);
    readImpl = (o) => realReadOn(asDevice(dev), "MV-0705", o);
    try {
      expect((await readBack(state, path)).body.readback).toEqual({ paramsRead: true, linksRead: true, flagsRead: true, linkGaps: 0, constantsDiffer: [{ paramRefId: marker.paramRefId, label: "Downloaderkennung" }] });
    } finally { readImpl = realRead; }
    expect(neverProgrammed(state, pid, did)).toBe(false);
  });

  test("the same read of a unit reporting another application id leaves it never programmed", async () => {
    const { state, pid, did, path } = await placed(xml);
    await onUnit(() => readBack(state, path, [...ROCKERS, ...LEDS]));
    await handleApi(req(`${path}/revert`, { method: "POST" }), state);
    const dev = new CollectedUnit(collection);
    dev.props.set("3/13/1", Buffer.from("000810d712", "hex"));
    readImpl = (o) => realReadOn(asDevice(dev), "MV-0705", o);
    try { expect((await readBack(state, path)).body.readback).toEqual({ paramsRead: true, linksRead: true, flagsRead: true, linkGaps: 0, neverProgrammedKept: [{ reason: "otherApplication" }] }); } finally { readImpl = realRead; }
    expect(neverProgrammed(state, pid, did)).toBe(true);
  });

  test("a value that shows the linked objects but is not the unit's (Jalousie for Dimmen) is refused by the image, and nothing is stored", async () => {
    const { state, pid, did, path } = await placed(xml);
    const before = stored(state, pid, did);
    const r = await onUnit(() => readBack(state, path, [...ROCKERS.map((a) => ({ ...a, value: "3" })), ...LEDS]));
    expect([r.state, r.body.error?.code]).toEqual(["error", "READBACK_ASSUMPTION_IMAGE_DIFFERS"]);
    expect(stored(state, pid, did)).toEqual(before);
  });

  test("with a value the image shows wrong left at its default, a later complete read does not end never programmed", async () => {
    const { state, pid, did, path } = await placed(xml);
    // The LED functions stay at the catalogue default the unit does not run, so the assumption is
    // refused, the rockers are set by hand as a user would, and the read after the revert finds every
    // link but an image the flash would change.
    expect((await onUnit(() => readBack(state, path, ROCKERS))).body.error?.code).toBe("READBACK_ASSUMPTION_IMAGE_DIFFERS");
    await onUnit(() => readBack(state, path));
    await handleApi(req(`${path}/revert`, { method: "POST" }), state);
    for (const a of ROCKERS) await handleApi(req(`${path}/params`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(a) }), state);
    const again = await onUnit(() => readBack(state, path));
    expect(again.body.readback).toEqual({ paramsRead: true, linksRead: true, flagsRead: true, linkGaps: 0, neverProgrammedKept: [{ reason: "imageDiffers" }] });
    expect(neverProgrammed(state, pid, did)).toBe(true);
  });

  test("values that leave a link unresolved are refused with its object, and nothing is stored", async () => {
    const { state, pid, did, path } = await placed(xml);
    const before = stored(state, pid, did);
    const r = await onUnit(() => readBack(state, path, [ROCKERS[0]]));
    expect(r.state).toBe("error");
    expect(r.body.error?.code).toBe("READBACK_ASSUMPTION_UNRESOLVED");
    expect(r.body.error?.details).toEqual({ objects: [20] });
    expect(stored(state, pid, did)).toEqual(before);
    expect(neverProgrammed(state, pid, did)).toBe(true);
  });

  test("a parameter with a memory location, an unknown one, a value its type does not take, or one named twice is refused before the bus is reached", async () => {
    const { state, pid, did, path } = await placed(xml);
    const before = stored(state, pid, did);
    readImpl = async () => { throw new Error("the bus must not be reached"); };
    try {
      const cases: [{ paramRefId: string; value: string }[], string][] = [
        [[{ paramRefId: `${A}_P-3764_R-3764`, value: "40" }], "READBACK_ASSUMPTION_HAS_MEMORY"],
        // "Hardware", located in a property of the device (PID 78), not in memory.
        [[{ paramRefId: `${A}_P-3720_R-3720`, value: "0" }], "READBACK_ASSUMPTION_HAS_MEMORY"],
        [[{ paramRefId: ROCKERS[0].paramRefId, value: "02" }], "READBACK_ASSUMPTION_INVALID"],
        [[{ paramRefId: `${A}_P-999999_R-999999`, value: "1" }], "READBACK_ASSUMPTION_UNKNOWN_PARAM"],
        [[{ paramRefId: ROCKERS[0].paramRefId, value: "77" }], "READBACK_ASSUMPTION_INVALID"],
        [[ROCKERS[0], ROCKERS[0]], "READBACK_ASSUMPTION_INVALID"],
      ];
      for (const [assume, code] of cases) {
        const r = await readBack(state, path, assume);
        expect([assume[0].paramRefId, r.status, r.body.error?.code]).toEqual([assume[0].paramRefId, 400, code]);
      }
    } finally { readImpl = realRead; }
    expect(stored(state, pid, did)).toEqual(before);
  });
});
