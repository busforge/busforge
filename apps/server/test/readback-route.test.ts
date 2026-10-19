import { test, expect, mock, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// Read-back route honesty guards:
// 1) an unsupported device class is REFUSED (400) with no baseline fabricated,
// 2) device links that map to no known com-object are counted as linkGaps and kept
//    OUT of the baseline (drift there stays visible as "unknown", never fake-synced),
// 3) a cleanly-mapping read reports zero gaps and lands in the baseline.
// readDeviceState is stubbed via mock.module (same strategy as flash-route.test.ts);
// the unsupported-refusal path is fully real (it never reaches readDeviceState).

const real = await import("../src/deviceprofile.ts");
const realRead = real.readDeviceState; // pin: mock.module replaces exports in place

const realGaFlash = real.flashDeviceGroupAddresses;

let readImpl: typeof realRead = realRead; // default real; restored in afterAll so a leaked mock is behavior-neutral
let gaFlashImpl: typeof realGaFlash = realGaFlash;

await mock.module("../src/deviceprofile.ts", () => ({
  ...real,
  readDeviceState: (opts: Parameters<typeof realRead>[0]) => readImpl(opts),
  flashDeviceGroupAddresses: (opts: Parameters<typeof realGaFlash>[0]) => gaFlashImpl(opts),
}));

const { handleApi, createState } = await import("../src/app.ts");
type AppState = ReturnType<typeof createState>;

afterAll(() => { readImpl = realRead; gaFlashImpl = realGaFlash; });

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));
const realXml = catalogueXml;

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
  // The test products are untested on hardware; the user's one acknowledgement per project.
  expect((await handleApi(req(`/api/projects/${imp.id}/devices/${encodeURIComponent(proj.devices[0].id)}/untested-ack`, { method: "PUT" }), state))!.status).toBe(200);
  return { projectId: imp.id, deviceId: proj.devices[0].id };
}

// Full baseline row dump, so "no baseline was created/changed" is an exact table
// comparison rather than a spot check.
const baselineRows = (db: Database, projectId: string) => ({
  params: db.query("SELECT device_id, param_ref_id, value FROM device_param_base WHERE project_id = ? ORDER BY device_id, param_ref_id").all(projectId),
  links: db.query("SELECT device_id, com_obj_ref_id, slot, ga_raw FROM device_link_base WHERE project_id = ? ORDER BY device_id, com_obj_ref_id, slot").all(projectId),
});

corpusDescribe("POST /read-back", () => {
  test("unsupported device class (MV-0020) -> 400 DEVICE_READBACK_UNSUPPORTED, baseline untouched", async () => {
    const state = freshState();
    // The M-0083 A-0138 app relabelled to mask MV-0020 (System 2 / BCU2) -> UnsupportedProfile,
    // all capabilities false. Reading it anyway would fabricate a "verified" baseline.
    const { projectId, deviceId } = await projectWithApp(state, realXml("M-0083_A-0138-21-F18E-O0072.xml.gz").replace('MaskVersion="MV-0012"', 'MaskVersion="MV-0020"'));
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
    expect(body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 1, unresolvedObjects: [9999] });

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

  const rows = (state: AppState, projectId: string, deviceId: string) =>
    state.db.query("SELECT com_obj_ref_id AS k, ga_raw AS g FROM device_link_base WHERE project_id = ? AND device_id = ? ORDER BY k").all(projectId, deviceId);
  const link = (state: AppState, projectId: string, deviceId: string, key: string, ga: number) =>
    state.db.run("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, 0, ?)", [projectId, deviceId, key, ga]);
  const readBack = async (state: AppState, projectId: string, deviceId: string) =>
    ((await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/read-back`, { method: "POST" }), state))!.json()) as any).readback;
  const changedObjects = async (state: AppState, projectId: string, deviceId: string) => {
    const view = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    return view.blocks.flatMap((b: any) => b.items).filter((it: any) => it.kind === "comObject" && it.comObject.changed).map((it: any) => it.comObject.number).sort();
  };
  const reading = (mask: string, links: { comObjNum: number; gaRaws: number[] }[], deviceConfig?: Map<string, string>) =>
    async () => ({ mask, paramsRead: deviceConfig !== undefined, linksRead: true, paramBase: new Map<string, string>(), links, deviceConfig });

  // MDT BE-02001.02, a module device: a module parameter switches on a channel object (#14).
  const MDT = "M-0083_A-00B6-32-9642";
  const MDT_SHOWS_14 = `${MDT}_MD-3_M-49_MI-1_P-1_R-3`;

  test("module device: a link on an object the device's configuration shows enters the baseline, and a project-only link is drift", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml(`${MDT}.xml.gz`));
    state.db.run("DELETE FROM device_links WHERE project_id = ? AND device_id = ?", [projectId, deviceId]);
    // Both sides show #14; the project links #0, the device links #14 and not #0.
    state.db.run("INSERT INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, '1')", [projectId, deviceId, MDT_SHOWS_14]);
    link(state, projectId, deviceId, "MD-2_M-2_MI-1_O-3-0_R-11", 0x77c8);
    readImpl = reading("MV-0705", [{ comObjNum: 14, gaRaws: [0x77c9] }], new Map([[MDT_SHOWS_14, "1"]]));
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(0);
    expect(rows(state, projectId, deviceId)).toEqual([{ k: "MD-3_M-49_MI-1_O-2-14_R-1", g: 0x77c9 }]);
    expect(await changedObjects(state, projectId, deviceId)).toEqual([0, 14]);
  });

  test("module device: an object only the device's configuration shows is placed by it, and counted since this page cannot show it", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml(`${MDT}.xml.gz`));
    state.db.run("DELETE FROM device_links WHERE project_id = ? AND device_id = ?", [projectId, deviceId]);
    readImpl = reading("MV-0705", [{ comObjNum: 14, gaRaws: [0x77c9] }], new Map([[MDT_SHOWS_14, "1"]]));
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(1);
    expect(rows(state, projectId, deviceId)).toEqual([{ k: "MD-3_M-49_MI-1_O-2-14_R-1", g: 0x77c9 }]);
  });

  // Jung 400021SE: a module template object has a bare number of its own (#5 names
  // MD-4_O-8-5_R-311 before any instance shift); no configuration places it at 5.
  test("module device: a number no configuration places is a gap, never a module template object", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml("M-0004_A-7072-21-99A7-O000A.xml.gz"));
    state.db.run("DELETE FROM device_links WHERE project_id = ? AND device_id = ?", [projectId, deviceId]);
    readImpl = reading("MV-07B0", [{ comObjNum: 5, gaRaws: [0x77c9] }], new Map());
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(1);
    expect(rows(state, projectId, deviceId)).toEqual([]);
  });

  test("module device read without its parameters keeps the cautious mapping and counts the rest as gaps", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml("M-0004_A-7072-21-99A7-O000A.xml.gz"));
    state.db.run("DELETE FROM device_links WHERE project_id = ? AND device_id = ?", [projectId, deviceId]);
    readImpl = reading("MV-07B0", [{ comObjNum: 254, gaRaws: [0x77c9] }]);
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(1);
  });

  // M-0081: P-4 swaps the ComObjectRef of object 0 (O-0_R-63 by default, O-0_R-167 when set).
  const M81 = "M-0081_A-FE01-11-75D9";
  test("one object in two ref variants is one object: the project's variant holds the device's link, no drift", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml(`${M81}.xml.gz`));
    state.db.run("DELETE FROM device_links WHERE project_id = ? AND device_id = ?", [projectId, deviceId]);
    state.db.run("INSERT INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, '1')", [projectId, deviceId, `${M81}_P-4_R-4`]);
    link(state, projectId, deviceId, "O-0_R-167", 0x040b);
    readImpl = reading("MV-0705", [{ comObjNum: 0, gaRaws: [0x040b] }], new Map());
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(0);
    expect(rows(state, projectId, deviceId)).toEqual([{ k: "O-0_R-167", g: 0x040b }]);
    expect(await changedObjects(state, projectId, deviceId)).toEqual([]);
  });

  test("a preserved link on an object the device's configuration hides stays in the baseline", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml(`${M81}.xml.gz`));
    state.db.run("DELETE FROM device_links WHERE project_id = ? AND device_id = ?", [projectId, deviceId]);
    link(state, projectId, deviceId, "O-8_R-9", 0x0401); // object 8 exists only with P-4 set; hidden, its GA preserved
    readImpl = reading("MV-0705", [], new Map());
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(0);
    expect(rows(state, projectId, deviceId)).toEqual([{ k: "O-8_R-9", g: 0x0401 }]);
  });

  // While the last read left device links out of the baseline, a group-address flash would
  // overwrite associations nobody has seen: refused until a complete read or a download.
  test("a group-address flash is refused while the last read-back had link gaps, and allowed after a complete one", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml(`${M81}.xml.gz`));
    let flashed = 0;
    gaFlashImpl = async () => { flashed++; return { kind: "unchanged", mask: "MV-0705", imageBytes: 0 } as any; };
    const flashGa = async () => (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash-ga?dry=1`, { method: "POST" }), state))!;
    readImpl = reading("MV-0705", [{ comObjNum: 9999, gaRaws: [123] }], new Map());
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(1);
    const refused = await flashGa();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error.code).toBe("LINK_BASELINE_INCOMPLETE");
    expect(flashed).toBe(0);
    const view = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/config`), state))!.json()) as any;
    expect(view.linkBaseGaps).toBe(1);

    readImpl = reading("MV-0705", [{ comObjNum: 0, gaRaws: [0x040b] }], new Map());
    expect((await readBack(state, projectId, deviceId)).linkGaps).toBe(0);
    expect((await flashGa()).status).toBe(200);
    expect(flashed).toBe(1);
    gaFlashImpl = realGaFlash;
  });

  const settled = async (state: AppState, projectId: string, taskId: string) => {
    for (let i = 0; i < 200; i++) {
      const t = (await (await handleApi(req(`/api/projects/${projectId}/tasks/${taskId}`), state))!.json()) as any;
      if (t.state !== "queued" && t.state !== "running") return t;
      await Bun.sleep(10);
    }
    throw new Error("task never settled");
  };

  test("a group-address flash queued behind a read-back that finds gaps is refused when it starts", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml(`${M81}.xml.gz`));
    let flashed = 0;
    gaFlashImpl = async () => { flashed++; return { kind: "flashed", mask: "MV-0705", imageBytes: 0, diffBytes: 0, verified: true } as any; };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    readImpl = async () => { await gate; return reading("MV-0705", [{ comObjNum: 9999, gaRaws: [123] }], new Map())(); };
    const read = readBack(state, projectId, deviceId);
    await Bun.sleep(10);
    const submitted = (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash-ga`, { method: "POST" }), state))!;
    expect(submitted.status).toBe(202); // no gaps known yet at submission
    const task = (await submitted.json()) as any;
    release();
    expect((await read).linkGaps).toBe(1);
    expect((await settled(state, projectId, task.id)).errorCode).toBe("LINK_BASELINE_INCOMPLETE");
    expect(flashed).toBe(0);
    gaFlashImpl = realGaFlash;
  });

  test("after a verified group-address flash the baseline holds no link the device no longer has", async () => {
    const state = freshState();
    const { projectId, deviceId } = await projectWithApp(state, realXml(`${M81}.xml.gz`));
    state.db.run("INSERT INTO device_link_base (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, 'O-999_R-1', 0, 5)", [projectId, deviceId]);
    gaFlashImpl = async () => ({ kind: "flashed", mask: "MV-0705", imageBytes: 0, diffBytes: 0, verified: true } as any);
    const task = (await (await handleApi(req(`/api/projects/${projectId}/devices/${deviceId}/flash-ga`, { method: "POST" }), state))!.json()) as any;
    expect((await settled(state, projectId, task.id)).state).toBe("done");
    expect(rows(state, projectId, deviceId).some((r: any) => r.k === "O-999_R-1")).toBe(false);
    gaFlashImpl = realGaFlash;
  });
});
