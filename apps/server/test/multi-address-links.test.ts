import { test, expect, describe, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { mergeLinkBaseline } from "../src/deviceservice.ts";

// Several group addresses on one com-object: the device page sends the whole ordered set (the first
// is the object's sending address), and the views built from it (the device page, the
// group-address overlay) show the flags the device gets, the application's with the project's own
// overrides laid over them.

const fixtures = join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures");
const cfgFixture = readFileSync(join(fixtures, "sample-config.knxproj"));
// sample-config.knxproj: one device, Mode=1 shows the one com-object (#0, write + transmit +
// communication, no read), one group address raw 1.
const PARAM = "M-TEST_A-1_P-1_R-1";
const COMOBJ = "M-TEST_A-1_O-1_R-1";
const STORED = "O-1_R-1";

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jreq = (path: string, method: string, body: unknown) =>
  req(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const j = async (res: Response | null) => (await res!.json()) as any;
const comObj = (v: any) => v.blocks.flatMap((b: any) => b.items).find((i: any) => i.kind === "comObject" && i.comObject.refId === COMOBJ)?.comObject;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "busforge-multi-"));
  tmps.push(dir);
  const state: AppState = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([cfgFixture], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const { id } = await j(await handleApi(req("/api/projects/import", { method: "POST", body: form }), state));
  const proj = await j(await handleApi(req(`/api/projects/${id}`), state));
  const deviceId = proj.devices[0].id as string;
  const rangeId = Number(proj.groupRanges[0].id);
  for (const sub of [2, 3]) {
    const r = await handleApi(jreq(`/api/projects/${id}/group-addresses`, "POST", { rangeId, sub, name: `L${sub}`, dpt: "1.001" }), state);
    expect(r!.status).toBe(201);
  }
  const after = await j(await handleApi(req(`/api/projects/${id}`), state));
  const raws = (after.groupRanges[0].addresses as { raw: number }[]).map((a) => a.raw).sort((a, b) => a - b);
  expect(raws).toHaveLength(3);
  await handleApi(jreq(`/api/projects/${id}/devices/${deviceId}/params`, "PUT", { paramRefId: PARAM, value: "1" }), state);
  const put = (gaRaws: unknown[]) => handleApi(jreq(`/api/projects/${id}/devices/${deviceId}/links`, "PUT", { comObjRefId: COMOBJ, gaRaws }), state);
  const view = async () => j(await handleApi(req(`/api/projects/${id}/devices/${deviceId}/config`), state));
  const gaDevices = async (raw: number) => j(await handleApi(req(`/api/projects/${id}/group-addresses/${raw}/devices`), state));
  const overrides = (rows: { ref: string; attrs: Record<string, string> }[]) => {
    state.db.prepare("DELETE FROM device_comobj_overrides WHERE project_id = ? AND device_id = ?").run(id, deviceId);
    rows.forEach((r, seq) => state.db.prepare("INSERT INTO device_comobj_overrides (project_id, device_id, seq, com_obj_ref_id, attrs) VALUES (?, ?, ?, ?, ?)").run(id, deviceId, seq, r.ref, JSON.stringify(r.attrs)));
  };
  return { state, id, deviceId, raws, put, view, gaDevices, overrides };
}

describe("several group addresses per com-object", () => {
  test("are stored and shown in the order sent, the first being the sending address", async () => {
    const s = await setup();
    const [a, b, c] = s.raws;
    const res = await s.put([c, a, b]);
    expect(res!.status).toBe(200);
    const co = comObj(await j(res));
    expect(co.gaRaws).toEqual([c, a, b]);
    expect(co.gaRaw).toBe(c);
    expect(comObj(await s.view()).gaRaws).toEqual([c, a, b]);
  });

  test("an address twice is refused and the links stay as they were", async () => {
    const s = await setup();
    const [a, b] = s.raws;
    await s.put([a, b]);
    const res = await s.put([a, b, a]);
    expect(res!.status).toBe(400);
    expect((await j(res)).error.code).toBe("LINK_GA_DUPLICATE");
    expect(comObj(await s.view()).gaRaws).toEqual([a, b]);
  });

  test("an address the project does not hold, or a value that is no address, is refused", async () => {
    const s = await setup();
    const [a] = s.raws;
    await s.put([a]);
    for (const bad of [[a, 30000], [a, "x"], [a, 1.5]]) {
      const res = await s.put(bad);
      expect(res!.status).toBeGreaterThanOrEqual(400);
      expect(["GA_NOT_FOUND", "COMOBJ_FIELDS_REQUIRED"]).toContain((await j(res)).error.code);
    }
    expect(comObj(await s.view()).gaRaws).toEqual([a]);
  });

  test("the group-address overlay lists a transmitting object as sender only on its sending address", async () => {
    const s = await setup();
    const [a, b] = s.raws;
    await s.put([b, a]);
    const onB = await s.gaDevices(b);
    const onA = await s.gaDevices(a);
    expect(onB.senders.map((x: any) => x.comObjNumber)).toEqual([0]);
    expect(onA.senders).toEqual([]);
    // It listens on both: the write flag makes it a receiver of each.
    expect(onA.receivers.map((x: any) => x.comObjNumber)).toEqual([0]);
    expect(onB.receivers.map((x: any) => x.comObjNumber)).toEqual([0]);
  });
});

describe("the flags shown for a com-object", () => {
  test("are the application's where the project sets none", async () => {
    const s = await setup();
    const co = comObj(await s.view());
    expect(co.flags).toMatchObject({ read: false, write: true, comm: true, transmit: true });
    expect(co.overriddenFlags ?? []).toEqual([]);
  });

  test("carry the project's overrides, named, on the device page and in the group-address overlay", async () => {
    const s = await setup();
    const [a] = s.raws;
    await s.put([a]);
    s.overrides([{ ref: STORED, attrs: { ReadFlag: "Enabled", TransmitFlag: "Disabled" } }]);
    const co = comObj(await s.view());
    expect(co.flags).toMatchObject({ read: true, write: true, comm: true, transmit: false });
    expect([...co.overriddenFlags].sort((a: string, b: string) => a.localeCompare(b))).toEqual(["read", "transmit"]);
    const ga = await s.gaDevices(a);
    expect(ga.senders).toEqual([]);
    expect(ga.receivers.map((x: any) => x.flags.read)).toEqual([true]);
  });

  test("an object whose communication flag the project turns off sends on nothing", async () => {
    const s = await setup();
    const [a] = s.raws;
    await s.put([a]);
    s.overrides([{ ref: STORED, attrs: { CommunicationFlag: "Disabled" } }]);
    expect((await s.gaDevices(a)).senders).toEqual([]);
  });

  test("an override set to the application's own value is not named as one", async () => {
    const s = await setup();
    s.overrides([{ ref: STORED, attrs: { WriteFlag: "Enabled" } }]);
    expect(comObj(await s.view()).overriddenFlags ?? []).toEqual([]);
  });

  test("an override Busforge cannot place is named on the page, which still opens", async () => {
    const s = await setup();
    s.overrides([{ ref: "O-99_R-99", attrs: { ReadFlag: "Enabled" } }]);
    const res = await handleApi(req(`/api/projects/${s.id}/devices/${s.deviceId}/config`), s.state);
    expect(res!.status).toBe(200);
    const v = await j(res);
    expect(v.comObjFlagsRefused).toBe("COM_OBJECT_OVERRIDE_UNRESOLVED");
    expect(comObj(v).overriddenFlags ?? []).toEqual([]);
  });
});

describe("read-back of several addresses", () => {
  test("a different sending address on the device is drift, the same set in the same first place is not", () => {
    const live = new Map([["k", [5, 3]]]);
    expect(mergeLinkBaseline(live, new Map([["k", [3, 5]]]), new Set(["k"])).base.get("k")).toEqual([3, 5]);
    expect(mergeLinkBaseline(live, new Map([["k", [5, 3]]]), new Set(["k"])).base.get("k")).toEqual([5, 3]);
    // The order behind the sending address is the table's, by group index; it is no drift.
    const three = new Map([["k", [5, 9, 3]]]);
    expect(mergeLinkBaseline(three, new Map([["k", [5, 3, 9]]]), new Set(["k"])).base.get("k")).toEqual([5, 9, 3]);
  });
});
