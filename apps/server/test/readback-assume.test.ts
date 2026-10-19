import { test, expect, mock, afterAll, describe } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAbsoluteSegmentTargets, parseAppConfig } from "@busforge/product";
import { CollectedUnit, asDevice, type Collection } from "../../../packages/product/test/collected-unit.ts";
import { catalogueXml, corpusPath, inServiceCollection } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The read-back route's two rules beyond the plain read: values it is asked to assume for parameters
// without a memory location, taken into project and baseline only when every link then resolves, and
// "never programmed", which a complete read of a device reporting this application's id clears.
// readDeviceState is replaced by the real read on an open session (readStateOn), run on an emulated
// unit, or by a fixed result where the rule alone is under test.
const real = await import("../src/deviceprofile.ts");
const realRead = real.readDeviceState;
const realReadOn = real.readStateOn;
let readImpl: typeof realRead = realRead;
await mock.module("../src/deviceprofile.ts", () => ({ ...real, readDeviceState: (o: Parameters<typeof realRead>[0]) => readImpl(o) }));
const { handleApi, createState } = await import("../src/app.ts");
type DeviceStateRead = Awaited<ReturnType<typeof realRead>>;
type AppState = ReturnType<typeof createState>;
afterAll(() => { readImpl = realRead; });

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
  const res = (await handleApi(req(`${path}/read-back`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang: "de", ...(assume ? { assume } : {}) }) }), state))!;
  return { status: res.status, body: (await res.json()) as Body };
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
    ({ mask: "MV-0705", paramsRead: true, linksRead: true, paramBase: new Map<string, string>(), links: [], programIdMatches: true, loaded: true, imageMatches: true, ...over });

  test("a complete read without unresolved links, of a device reporting this application's id, loaded, its image as the project's, clears it", async () => {
    const { state, pid, did, path } = await placed();
    readImpl = read({});
    try { expect((await readBack(state, path)).status).toBe(200); } finally { readImpl = realRead; }
    expect(neverProgrammed(state, pid, did)).toBe(false);
  });

  test("constant parameters the device differs in are no change, and the read names them", async () => {
    const { state, pid, did, path } = await placed();
    const constantsDiffer = [{ paramRefId: "M-TEST_A-1_P-9_R-9", label: "Download marker" }];
    readImpl = read({ constantsDiffer });
    let body: Body = {};
    try { const r = await readBack(state, path); expect(r.status).toBe(200); body = r.body; } finally { readImpl = realRead; }
    expect(body.readback?.constantsDiffer).toEqual(constantsDiffer);
    expect(neverProgrammed(state, pid, did)).toBe(false);
  });

  test("it stays with an unresolved link, another application id, none reported, a load state not LOADED, an image a flash would change or one not compared, or a read that missed a part", async () => {
    for (const over of [{ links: [{ comObjNum: 9999, gaRaws: [123] }] }, { programIdMatches: false }, { programIdMatches: null }, { loaded: false }, { imageMatches: false }, { imageMatches: null }, { paramsRead: false }, { linksRead: false }]) {
      const { state, pid, did, path } = await placed();
      readImpl = read(over);
      try { expect((await readBack(state, path)).status).toBe(200); } finally { readImpl = realRead; }
      expect([over, neverProgrammed(state, pid, did)]).toEqual([over, true]);
    }
  });

  test("an unresolved link is named by its object number", async () => {
    const { state, path } = await placed();
    readImpl = read({ links: [{ comObjNum: 9999, gaRaws: [123] }] });
    try { expect((await readBack(state, path)).body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 1, unresolvedObjects: [9999], neverProgrammedKept: "links unresolved" }); } finally { readImpl = realRead; }
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
    expect(r.body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 3, unresolvedObjects: [18, 20, 64], neverProgrammedKept: "links unresolved; a flash would write bytes the device does not hold" });
    expect(neverProgrammed(state, pid, did)).toBe(true);
  });

  test("with them, project and baseline take them, and once the project takes the device's values every link resolves and the device no longer counts as never programmed", async () => {
    const { state, pid, did, path } = await placed(xml);
    const r = await onUnit(() => readBack(state, path, [...ROCKERS, ...LEDS]));
    expect(r.status).toBe(200);
    // Object 64 is shown by a parameter with a memory location, which the project takes on revert.
    expect(r.body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 1, unresolvedObjects: [64], neverProgrammedKept: "links unresolved" });
    const s = stored(state, pid, did);
    for (const a of [...ROCKERS, ...LEDS]) {
      expect(s.live).toContainEqual({ r: a.paramRefId, v: a.value });
      expect(s.base).toContainEqual({ r: a.paramRefId, v: a.value });
    }
    expect(neverProgrammed(state, pid, did)).toBe(true);
    expect((await handleApi(req(`${path}/revert`, { method: "POST" }), state))!.status).toBe(200);
    const again = await onUnit(() => readBack(state, path));
    expect(again.body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 0 });
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
      expect((await readBack(state, path)).body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 0, constantsDiffer: [{ paramRefId: marker.paramRefId, label: "Downloaderkennung" }] });
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
    try { expect((await readBack(state, path)).body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 0, neverProgrammedKept: "application id of another application" }); } finally { readImpl = realRead; }
    expect(neverProgrammed(state, pid, did)).toBe(true);
  });

  test("a value that shows the linked objects but is not the unit's (Jalousie for Dimmen) is refused by the image, and nothing is stored", async () => {
    const { state, pid, did, path } = await placed(xml);
    const before = stored(state, pid, did);
    const r = await onUnit(() => readBack(state, path, [...ROCKERS.map((a) => ({ ...a, value: "3" })), ...LEDS]));
    expect([r.status, r.body.error?.code]).toEqual([400, "READBACK_ASSUMPTION_IMAGE_DIFFERS"]);
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
    expect(again.body.readback).toEqual({ paramsRead: true, linksRead: true, linkGaps: 0, neverProgrammedKept: "a flash would write bytes the device does not hold" });
    expect(neverProgrammed(state, pid, did)).toBe(true);
  });

  test("values that leave a link unresolved are refused with its object, and nothing is stored", async () => {
    const { state, pid, did, path } = await placed(xml);
    const before = stored(state, pid, did);
    const r = await onUnit(() => readBack(state, path, [ROCKERS[0]]));
    expect(r.status).toBe(400);
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
