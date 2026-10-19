import { test, expect, mock, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The read-back route and the com-object flags a read of the device's table gives: they become the flag
// baseline (what the device holds), the project keeps its own, the difference shows as a change, and a
// revert takes the device's. readDeviceState is replaced by a fixed result; the read itself is covered
// in packages/product/test/comobj-readback.test.ts.
const real = await import("../src/deviceprofile.ts");
const realRead = real.readDeviceState;
type ReadOpts = Parameters<typeof realRead>[0];
type DeviceStateRead = Awaited<ReturnType<typeof realRead>>;
let readImpl: (o: ReadOpts) => Promise<DeviceStateRead> = realRead;
await mock.module("../src/deviceprofile.ts", () => ({ ...real, readDeviceState: (o: ReadOpts) => readImpl(o) }));
const { handleApi, createState } = await import("../src/app.ts");
const { getDeviceComObjOverrides, getDeviceComObjOverrideBase } = await import("../src/db/deviceparams.ts");
type AppState = ReturnType<typeof createState>;
afterAll(() => { readImpl = realRead; });

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jreq = (path: string, method: string, body: unknown) => req(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const j = async (res: Response | null) => (await res!.json()) as any;
const objects = (v: any) => v.blocks.flatMap((b: any) => b.items).filter((i: any) => i.kind === "comObject").map((i: any) => i.comObject);

// The demo project's first device, its one com-object shown (Mode=1).
async function setup(): Promise<{ state: AppState; id: string; deviceId: string; base: string; ref: string }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-readback-flags-"));
  dirs.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-config.knxproj"))], "ConfigDemo.knxproj"));
  form.set("password", "tester12");
  const { id } = await j(await handleApi(req("/api/projects/import", { method: "POST", body: form }), state));
  const deviceId = (await j(await handleApi(req(`/api/projects/${id}`), state))).devices[0].id as string;
  const conn = await j(await handleApi(jreq("/api/connections", "POST", { type: "ip", name: "GW", host: "198.51.100.10", port: 3671 }), state));
  await handleApi(jreq(`/api/projects/${id}/connection`, "PUT", { connectionId: conn.id }), state);
  state.db.run("UPDATE devices SET never_programmed = 0 WHERE project_id = ?", [id]);
  const base = `/api/projects/${id}/devices/${encodeURIComponent(deviceId)}`;
  await handleApi(jreq(`${base}/params`, "PUT", { paramRefId: "M-TEST_A-1_P-1_R-1", value: "1" }), state);
  // the device holds that value: no parameter change pending
  state.db.run("DELETE FROM device_param_base WHERE project_id = ?", [id]);
  state.db.run("INSERT INTO device_param_base (project_id, device_id, param_ref_id, value) SELECT project_id, device_id, param_ref_id, value FROM device_parameters WHERE project_id = ?", [id]);
  const [o] = objects(await j(await handleApi(req(`${base}/config`), state)));
  return { state, id, deviceId, base, ref: (o.refId as string).replace("M-TEST_A-1_", "") };
}
const answer = (over: Partial<DeviceStateRead>) => async (): Promise<DeviceStateRead> =>
  ({ mask: "MV-07B0", paramsRead: true, linksRead: true, paramBase: new Map(), links: [], ...over });
const readBack = async (s: { state: AppState; base: string }) => {
  const res = (await handleApi(jreq(`${s.base}/read-back`, "POST", { lang: "en" }), s.state))!;
  return { status: res.status, body: await j(res) };
};
const flagChanges = async (s: { state: AppState; id: string }) => (await j(await handleApi(req(`/api/projects/${s.id}`), s.state))).devices[0].changes.flags as number;

test("the flags the device holds become the baseline, show as a change against the project, and a revert takes them", async () => {
  const s = await setup();
  const rows = [{ comObjRefId: s.ref, attrs: { ReadFlag: "Enabled" } }];
  let asked: ReadOpts | undefined;
  readImpl = async (o) => { asked = o; return answer({ comObjOverrideBase: rows, comObjFlagsUndecoded: [] })(); };
  let r;
  try { r = await readBack(s); } finally { readImpl = realRead; }
  expect(r.status).toBe(200);
  expect(asked?.comObjectOverrideBaseRows).toEqual([]); // the stored baseline, which the read starts from
  expect(r.body.readback).toMatchObject({ flagsRead: true });
  expect(r.body.readback.flagsUndecoded).toBeUndefined();
  expect(getDeviceComObjOverrideBase(s.state.db, s.id, s.deviceId)).toEqual(rows);
  expect(getDeviceComObjOverrides(s.state.db, s.id, s.deviceId)).toEqual([]);
  expect(await flagChanges(s)).toBe(1);
  expect(objects(r.body).find((o: any) => o.refId === `M-TEST_A-1_${s.ref}`).flagsChanged).toBe(true);
  await handleApi(req(`${s.base}/revert`, { method: "POST" }), s.state);
  expect(getDeviceComObjOverrides(s.state.db, s.id, s.deviceId)).toEqual(rows);
  expect(await flagChanges(s)).toBe(0);
});

test("a read that could not take the flags leaves the baseline as it was, and says why and which objects", async () => {
  const s = await setup();
  const held = [{ comObjRefId: s.ref, attrs: { WriteFlag: "Disabled" } }];
  s.state.db.run("INSERT INTO device_comobj_override_base (project_id, device_id, seq, com_obj_ref_id, attrs) VALUES (?, ?, 0, ?, ?)", [s.id, s.deviceId, s.ref, JSON.stringify(held[0].attrs)]);
  let asked: ReadOpts | undefined;
  readImpl = async (o) => { asked = o; return answer({ comObjFlagsUnreadable: "DEVICE_NOT_PROGRAMMED: no com-object table" })(); };
  let r;
  try { r = await readBack(s); } finally { readImpl = realRead; }
  expect(r.status).toBe(200);
  expect(asked?.comObjectOverrideBaseRows).toEqual(held);
  expect(r.body.readback).toMatchObject({ flagsRead: false, flagsUnreadable: expect.stringContaining("DEVICE_NOT_PROGRAMMED") });
  expect(getDeviceComObjOverrideBase(s.state.db, s.id, s.deviceId)).toEqual(held);
  // objects whose flags the read could not take are named
  readImpl = answer({ comObjOverrideBase: held, comObjFlagsUndecoded: [1] });
  try { r = await readBack(s); } finally { readImpl = realRead; }
  expect(r.body.readback).toMatchObject({ flagsRead: true, flagsUndecoded: [1] });
});

// A parameter without a memory location that only picks an object's flags (a ComObjectRef with the read
// flag off): its values are told apart by the com-object table, unless the read took the device's flags
// into the baseline, whose image check then compares the table under the device's own flags.
test("flags read from the device prove no assumed value that only the flags would show", async () => {
  const { distinguishable } = await import("../src/routes/deviceops.ts");
  const { parseAppConfig } = await import("@busforge/product");
  const A = "M-0005_A-0009-01-0002";
  const app = parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="9" ApplicationVersion="2" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Flags" LoadProcedureStyle="MergedProcedure">
<Static>
<Code><RelativeSegment Id="${A}_RS-1" LoadStateMachine="4" Size="1"><Data>AA==</Data></RelativeSegment></Code>
<ParameterTypes><ParameterType Id="${A}_PT-1"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="Status" Value="1" Id="${A}_PT-1_EN-1"/><Enumeration Text="Command" Value="2" Id="${A}_PT-1_EN-2"/></TypeRestriction></ParameterType>
<ParameterType Id="${A}_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="${A}_P-1" ParameterType="${A}_PT-8" Text="Delay" Value="7"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="${A}_P-3" ParameterType="${A}_PT-1" Text="Use" Value="1"/>
</Parameters>
<ParameterRefs><ParameterRef Id="${A}_P-1_R-1" RefId="${A}_P-1"/><ParameterRef Id="${A}_P-3_R-3" RefId="${A}_P-3"/></ParameterRefs>
<ComObjectTable><ComObject Id="${A}_O-1" Number="1" Name="Out" Text="Out" ObjectSize="1 Bit" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/></ComObjectTable>
<ComObjectRefs><ComObjectRef Id="${A}_O-1_R-1" RefId="${A}_O-1"/><ComObjectRef Id="${A}_O-1_R-2" RefId="${A}_O-1" ReadFlag="Disabled"/></ComObjectRefs>
<LoadProcedures><LoadProcedure MergeId="2"><LdCtrlRelSegment LsmIdx="4" Size="1" Mode="0" Fill="0" AppliesTo="full,par"/></LoadProcedure></LoadProcedures>
</Static>
<Dynamic><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${A}_P-1_R-1"/><ParameterRefRef RefId="${A}_P-3_R-3"/>
<choose ParamRefId="${A}_P-3_R-3"><when test="1"><ComObjectRefRef RefId="${A}_O-1_R-1"/></when><when test="2"><ComObjectRefRef RefId="${A}_O-1_R-2"/></when></choose>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
  const values = new Map([[`${A}_P-3_R-3`, "1"]]);
  expect(await distinguishable(app, values, `${A}_P-3_R-3`, [], false)).toBe(true);
  expect(await distinguishable(app, values, `${A}_P-3_R-3`, [], true)).toBe(false);
});

// A flag baseline the device's flags cannot be laid over (two rows of one object that disagree) leaves the
// flags open; the parameters and links the read took stand.
test("a stored flag baseline that sets one object twice, differently, leaves the flags open and the read stands", async () => {
  const { parseAppConfig } = await import("@busforge/product");
  const { readStateOn } = real;
  const s = await setup();
  const xml = s.state.db.query("SELECT xml FROM app_programs WHERE id = 'M-TEST_A-1'").get() as { xml: string };
  const cfg = parseAppConfig(xml.xml);
  const profile = real.classify(cfg);
  const orig = profile.constructor.prototype.readState;
  const n = [...(await import("@busforge/product")).buildDeviceConfig(cfg, new Map([["M-TEST_A-1_P-1_R-1", "1"]])).imageComObjects.keys()][0];
  profile.constructor.prototype.readState = async () => ({ mask: cfg.mask, paramsRead: true, linksRead: true, paramBase: new Map([["M-TEST_A-1_P-1_R-1", "1"]]), links: [], comObjFlags: new Map([[n, { flags: { read: true }, priority: "Low" as const }]]) });
  try {
    const read = await readStateOn({} as never, cfg.mask, {
      appXml: xml.xml, deviceId: s.deviceId, ia: "1.1.10", liveParams: new Map(),
      comObjectOverrideBaseRows: [{ comObjRefId: s.ref, attrs: { ReadFlag: "Enabled" } }, { comObjRefId: s.ref, attrs: { ReadFlag: "Disabled" } }],
    });
    expect(read).toMatchObject({ paramsRead: true, linksRead: true, comObjFlagsUnreadable: expect.stringContaining("COM_OBJECT_OVERRIDE_CONFLICT") });
    expect(read.comObjOverrideBase).toBeUndefined();
  } finally { profile.constructor.prototype.readState = orig; }
});
