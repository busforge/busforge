import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { getDeviceParams, getDeviceLinks, setDeviceLink, setDeviceParam, resetParamBase, resetLinkBase } from "../src/db/deviceparams.ts";
import { putBaggage } from "../src/db/baggage.ts";
import { putDeviceSecurity } from "../src/db/deviceSecurity.ts";
import { createGroupAddress, createGroupRange } from "../src/db/groupedit.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";

// "Replace device": swap a project device's product for a catalog product, keeping
// the device row's identity (IA, name, room) and migrating its GA links through an
// explicit, total com-object mapping. Everything below the HTTP boundary is real
// server code on a fresh in-memory DB; the catalog is seeded via synthetic .knxprod
// archives (manufacturer data is gitignored, so no real product XML appears here).

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
function freshState(): AppState {
  const dir = mkdtempSync(join(tmpdir(), "busforge-replace-"));
  tmps.push(dir);
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
const req = (path: string, init?: RequestInit) => new Request(`http://x${path}`, init);
const jreq = (path: string, method: string, body: unknown) =>
  req(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// A synthetic .knxprod for one manufacturer product with its application program.
function knxprod(manu: string, appXml: string): Buffer {
  const hardware = `<?xml version="1.0"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${manu}">
  <Hardware><Hardware Id="${manu}_H-1" Name="HW" VersionNumber="1">
    <Products><Product Id="${manu}_H-1_P-1" Text="Product ${manu}" OrderNumber="${manu}-001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${manu}_H-1_HP-1"><ApplicationProgramRef RefId="${manu}_A-1"/></Hardware2Program></Hardware2Programs>
  </Hardware></Hardware>
</Manufacturer></ManufacturerData></KNX>`;
  return storeZip({ [`${manu}/Hardware.xml`]: hardware, [`${manu}/${manu}_A-1.xml`]: appXml });
}

// The OLD application: three com-objects, O-3 only visible when P-1 = 1 (hidden
// under the default 0), so a stored link on it exercises the GA-preserve path.
const OLD = "M-OLD1";
const OLD_APP = `${OLD}_A-1`;
const oldAppXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="${OLD}"><ApplicationPrograms>
<ApplicationProgram Id="${OLD_APP}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Old App" DefaultLanguage="en-US">
  <Static>
    <ParameterTypes>
      <ParameterType Id="${OLD_APP}_PT-1" Name="OnOff"><TypeRestriction Base="Value" SizeInBit="8">
        <Enumeration Text="Off" Value="0" Id="${OLD_APP}_PT-1_EN-0"/><Enumeration Text="On" Value="1" Id="${OLD_APP}_PT-1_EN-1"/>
      </TypeRestriction></ParameterType>
    </ParameterTypes>
    <Parameters><Parameter Id="${OLD_APP}_P-1" Name="Mode" ParameterType="${OLD_APP}_PT-1" Text="Mode" Value="0"/></Parameters>
    <ParameterRefs><ParameterRef Id="${OLD_APP}_P-1_R-1" RefId="${OLD_APP}_P-1"/></ParameterRefs>
    <ComObjectTable>
      <ComObject Id="${OLD_APP}_O-1" Number="0" Name="Switch" Text="Switch" FunctionText="On/Off" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled"/>
      <ComObject Id="${OLD_APP}_O-2" Number="1" Name="Dim" Text="Dim" FunctionText="Value" ObjectSize="1 Byte" DatapointType="DPST-5-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled"/>
      <ComObject Id="${OLD_APP}_O-3" Number="2" Name="Hidden" Text="Hidden" FunctionText="Extra" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled"/>
    </ComObjectTable>
    <ComObjectRefs>
      <ComObjectRef Id="${OLD_APP}_O-1_R-1" RefId="${OLD_APP}_O-1"/>
      <ComObjectRef Id="${OLD_APP}_O-2_R-2" RefId="${OLD_APP}_O-2"/>
      <ComObjectRef Id="${OLD_APP}_O-3_R-3" RefId="${OLD_APP}_O-3"/>
    </ComObjectRefs>
  </Static>
  <Dynamic><ChannelIndependentBlock><ParameterBlock Id="${OLD_APP}_PB-1" Name="main" Text="Main">
    <ParameterRefRef RefId="${OLD_APP}_P-1_R-1"/>
    <ComObjectRefRef RefId="${OLD_APP}_O-1_R-1"/>
    <ComObjectRefRef RefId="${OLD_APP}_O-2_R-2"/>
    <choose ParamRefId="${OLD_APP}_P-1_R-1"><when test="1"><ComObjectRefRef RefId="${OLD_APP}_O-3_R-3"/></when></choose>
  </ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

// The NEW application: O-1's ref overrides text/dpt/flags over its base object,
// O-2's text carries a {{0}} fed by a text parameter, O-3 is only reachable when
// P-1 = 1 (hidden under defaults — the universe must list it anyway). A German
// translation on O-1's ref exercises the lang parameter.
const NEW = "M-NEW1";
const NEW_APP = `${NEW}_A-1`;
const newAppXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="${NEW}"><ApplicationPrograms>
<ApplicationProgram Id="${NEW_APP}" ApplicationNumber="2" ApplicationVersion="1" MaskVersion="MV-07B0" Name="New App" DefaultLanguage="en-US">
  <Static>
    <ParameterTypes>
      <ParameterType Id="${NEW_APP}_PT-1" Name="OnOff"><TypeRestriction Base="Value" SizeInBit="8">
        <Enumeration Text="Off" Value="0" Id="${NEW_APP}_PT-1_EN-0"/><Enumeration Text="On" Value="1" Id="${NEW_APP}_PT-1_EN-1"/>
      </TypeRestriction></ParameterType>
      <ParameterType Id="${NEW_APP}_PT-2" Name="Name"><TypeText SizeInBit="80"/></ParameterType>
    </ParameterTypes>
    <Parameters>
      <Parameter Id="${NEW_APP}_P-1" Name="Mode" ParameterType="${NEW_APP}_PT-1" Text="Mode" Value="0"/>
      <Parameter Id="${NEW_APP}_P-2" Name="ChName" ParameterType="${NEW_APP}_PT-2" Text="Channel name" Value="Bad"/>
    </Parameters>
    <ParameterRefs>
      <ParameterRef Id="${NEW_APP}_P-1_R-1" RefId="${NEW_APP}_P-1"/>
      <ParameterRef Id="${NEW_APP}_P-2_R-2" RefId="${NEW_APP}_P-2"/>
    </ParameterRefs>
    <ComObjectTable>
      <ComObject Id="${NEW_APP}_O-1" Number="5" Name="Out" Text="Base text" FunctionText="Base fn" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled"/>
      <ComObject Id="${NEW_APP}_O-2" Number="6" Name="Named" Text="Output {{0}}" FunctionText="Value" ObjectSize="1 Byte" DatapointType="DPST-5-1" TextParameterRefId="${NEW_APP}_P-2_R-2" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled"/>
      <ComObject Id="${NEW_APP}_O-3" Number="7" Name="Later" Text="Only when on" FunctionText="Extra" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled"/>
    </ComObjectTable>
    <ComObjectRefs>
      <ComObjectRef Id="${NEW_APP}_O-1_R-1" RefId="${NEW_APP}_O-1" Text="Presence out" DatapointType="DPST-1-2" ReadFlag="Enabled"/>
      <ComObjectRef Id="${NEW_APP}_O-2_R-2" RefId="${NEW_APP}_O-2"/>
      <ComObjectRef Id="${NEW_APP}_O-3_R-3" RefId="${NEW_APP}_O-3"/>
    </ComObjectRefs>
  </Static>
  <Dynamic><ChannelIndependentBlock><ParameterBlock Id="${NEW_APP}_PB-1" Name="main" Text="Main">
    <ParameterRefRef RefId="${NEW_APP}_P-1_R-1"/>
    <ComObjectRefRef RefId="${NEW_APP}_O-1_R-1"/>
    <ComObjectRefRef RefId="${NEW_APP}_O-2_R-2"/>
    <choose ParamRefId="${NEW_APP}_P-1_R-1"><when test="1"><ComObjectRefRef RefId="${NEW_APP}_O-3_R-3"/></when></choose>
  </ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData>
<Languages><Language Identifier="de-DE"><TranslationUnit RefId="${NEW_APP}">
  <TranslationElement RefId="${NEW_APP}_O-1_R-1"><Translation AttributeName="Text" Text="Präsenz Ausgang"/></TranslationElement>
</TranslationUnit></Language></Languages></KNX>`;

// A module-def application (hasModules): its com-objects exist only per instance,
// which the universe/replace path refuses to enumerate.
const MOD = "M-MOD1";
const MOD_APP = `${MOD}_A-1`;
const modAppXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="${MOD}"><ApplicationPrograms>
<ApplicationProgram Id="${MOD_APP}" ApplicationNumber="3" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Module App" DefaultLanguage="en-US">
  <Static><ParameterTypes/><Parameters/><ParameterRefs/><ComObjectTable/><ComObjectRefs/></Static>
  <ModuleDefs><ModuleDef Id="${MOD_APP}_MD-1" Name="Ch">
    <Arguments><Argument Id="${MOD_APP}_MD-1_A-1" Name="Base" Allocates="1"/></Arguments>
    <Static>
      <ComObjects><ComObject Id="${MOD_APP}_MD-1_O-1" Number="0" Name="Sw" Text="Sw" FunctionText="" ObjectSize="1 Bit" DatapointType="DPST-1-1" WriteFlag="Enabled" CommunicationFlag="Enabled" BaseNumber="${MOD_APP}_MD-1_A-1"/></ComObjects>
      <ComObjectRefs><ComObjectRef Id="${MOD_APP}_MD-1_O-1_R-1" RefId="${MOD_APP}_MD-1_O-1"/></ComObjectRefs>
    </Static>
    <Dynamic><ParameterBlock Id="${MOD_APP}_MD-1_PB-1" Name="ch" Text="Ch"><ComObjectRefRef RefId="${MOD_APP}_MD-1_O-1_R-1"/></ParameterBlock></Dynamic>
  </ModuleDef></ModuleDefs>
  <Dynamic/>
</ApplicationProgram>
</ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

async function importKnxprod(state: AppState, bytes: Buffer): Promise<void> {
  const form = new FormData();
  form.set("file", new File([bytes], "prod.knxprod"));
  const res = (await handleApi(req("/api/catalog/import", { method: "POST", body: form }), state))!;
  expect(res.status).toBe(201);
}

const GA_SWITCH = 0x0101, GA_DIM_A = 0x0202, GA_DIM_B = 0x0203, GA_HIDDEN = 0x0303;

// Blank project + placed OLD device with links (two visible, one hidden/stored),
// a programmed baseline, params, a module row, security, baggage, and a room.
async function setup(): Promise<{ state: AppState; projectId: string; deviceId: string; spaceId: number }> {
  const state = freshState();
  await importKnxprod(state, knxprod(OLD, oldAppXml));
  await importKnxprod(state, knxprod(NEW, newAppXml));
  const proj = (await (await handleApi(jreq("/api/projects", "POST", { name: "P" }), state))!.json()) as { id: string };
  const dev = (await (await handleApi(jreq(`/api/projects/${proj.id}/devices`, "POST",
    { appRef: `${OLD}_H-1_HP-1`, productRef: `${OLD}_H-1_P-1`, name: "Sensor Bad" }), state))!.json()) as { id: string; ia: string };
  expect(dev.ia).toBe("1.1.1");

  // The linked addresses exist in the project (0/1/1, 0/2/2, 0/2/3, 0/3/3).
  const main = createGroupRange(state.db, proj.id, null, "Main", 0);
  for (const raw of [GA_SWITCH, GA_DIM_A, GA_DIM_B, GA_HIDDEN]) {
    const mid = (raw >> 8) & 0x07;
    const rangeId = (state.db.query("SELECT id FROM group_ranges WHERE project_id = ? AND parent_id = ? AND range_start = ?").get(proj.id, main, raw & 0xff00) as { id: number } | null)?.id
      ?? createGroupRange(state.db, proj.id, main, `Mid ${mid}`, mid);
    expect(createGroupAddress(state.db, proj.id, rangeId, raw & 0xff, `GA ${raw}`, "1.001").raw).toBe(raw);
  }

  // Links through the route (visible objects), plus a stored link on the HIDDEN
  // O-3 (GA-preserve: stored while invisible, flashed once parameters reveal it).
  const put = (comObjRefId: string, gaRaws: number[]) =>
    handleApi(jreq(`/api/projects/${proj.id}/devices/${dev.id}/links`, "PUT", { comObjRefId, gaRaws }), state);
  expect((await put(`${OLD_APP}_O-1_R-1`, [GA_SWITCH]))!.status).toBe(200);
  expect((await put(`${OLD_APP}_O-2_R-2`, [GA_DIM_A, GA_DIM_B]))!.status).toBe(200);
  setDeviceLink(state.db, proj.id, dev.id, "O-3_R-3", [GA_HIDDEN]);

  // Old-app state that must NOT survive the replacement.
  setDeviceParam(state.db, proj.id, dev.id, `${OLD_APP}_P-1_R-1`, "1");
  resetParamBase(state.db, proj.id, dev.id, getDeviceParams(state.db, proj.id, dev.id));
  resetLinkBase(state.db, proj.id, dev.id, ["O-1_R-1"], getDeviceLinks(state.db, proj.id, dev.id));
  state.db.prepare("INSERT INTO device_modules (project_id, device_id, instances) VALUES (?, ?, '[]')").run(proj.id, dev.id);
  putDeviceSecurity(state.db, proj.id, [{ deviceId: dev.id, toolKey: Buffer.alloc(16, 1), serialNumber: Buffer.alloc(6, 2), sequenceNumber: "0", source: "manual" }], state.masterKey);
  putBaggage(state.db, proj.id, `${dev.id}_dca.bin`, Buffer.from("old"));
  putBaggage(state.db, proj.id, "OTHER-DEVICE_dca.bin", Buffer.from("keep"));

  // Room assignment (space_devices keys on the instance id and must survive).
  const withSpace = (await (await handleApi(jreq(`/api/projects/${proj.id}/spaces`, "POST", { type: "Room", name: "Bathroom" }), state))!.json()) as { locations: { id: string }[] };
  const spaceId = Number(withSpace.locations[0].id);
  expect((await handleApi(jreq(`/api/projects/${proj.id}/devices/${dev.id}/space`, "PUT", { spaceId }), state))!.status).toBe(200);

  return { state, projectId: proj.id, deviceId: dev.id, spaceId };
}

const NEW_PRODUCT = { appRef: `${NEW}_H-1_HP-1`, productRef: `${NEW}_H-1_P-1` };
const replaceReq = (projectId: string, deviceId: string, body: unknown) =>
  jreq(`/api/projects/${projectId}/devices/${deviceId}/replace`, "POST", body);
const errCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("GET /api/catalog/apps/:id/comobjects (full universe)", () => {
  test("lists every ComObjectRef with ref overrides applied, hidden ones included", async () => {
    const state = freshState();
    await importKnxprod(state, knxprod(NEW, newAppXml));
    const res = (await handleApi(req(`/api/catalog/apps/${NEW_APP}/comobjects`), state))!;
    expect(res.status).toBe(200);
    const list = (await res.json()) as { refId: string; number: number; name: string; functionText: string; dpt: string; objectSize: string; flags: { read: boolean; write: boolean } }[];
    expect(list.map((e) => e.refId)).toEqual([`${NEW_APP}_O-1_R-1`, `${NEW_APP}_O-2_R-2`, `${NEW_APP}_O-3_R-3`]);
    // Ref overrides win over the base object; un-overridden fields come from the base.
    expect(list[0]).toMatchObject({ number: 5, name: "Presence out", functionText: "Base fn", dpt: "DPST-1-2", objectSize: "1 Bit" });
    expect(list[0].flags).toMatchObject({ read: true, write: true }); // read overridden by the ref, write inherited
    // {{0}} resolves to the text parameter's default (no device, no overrides).
    expect(list[1]).toMatchObject({ number: 6, name: "Output Bad", dpt: "DPST-5-1" });
    // O-3 is invisible under default parameters and listed anyway (that is the point).
    expect(list[2]).toMatchObject({ number: 7, name: "Only when on" });
  });

  test("?lang= resolves the catalogue translation", async () => {
    const state = freshState();
    await importKnxprod(state, knxprod(NEW, newAppXml));
    const list = (await (await handleApi(req(`/api/catalog/apps/${NEW_APP}/comobjects?lang=de`), state))!.json()) as { name: string }[];
    expect(list[0].name).toBe("Präsenz Ausgang");
  });

  test("unknown application program -> 404", async () => {
    const res = (await handleApi(req("/api/catalog/apps/M-NOPE_A-9/comobjects"), freshState()))!;
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("APP_PROGRAM_MISSING");
  });

  test("module-def application -> refused, not listed incompletely", async () => {
    const state = freshState();
    await importKnxprod(state, knxprod(MOD, modAppXml));
    const res = (await handleApi(req(`/api/catalog/apps/${MOD_APP}/comobjects`), state))!;
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("COMOBJ_UNIVERSE_MODULES_UNSUPPORTED");
  });
});

describe("POST /api/projects/:id/devices/:deviceId/replace", () => {
  test("happy path: links migrate per mapping, identity/room kept, old-app state gone", async () => {
    const { state, projectId, deviceId, spaceId } = await setup();
    const mapping = [
      { from: `${OLD_APP}_O-1_R-1`, to: "O-1_R-1" },          // full from, stripped to
      { from: "O-2_R-2", to: `${NEW_APP}_O-2_R-2` },           // two GAs: slot order must survive
      { from: "O-3_R-3", to: `${NEW_APP}_O-3_R-3` },           // hidden -> hidden (GA-preserve)
    ];
    const res = (await handleApi(replaceReq(projectId, deviceId, { ...NEW_PRODUCT, mapping }), state))!;
    expect(res.status).toBe(200);

    // Response is the fresh config view of the NEW application, migrated link overlaid.
    const view = (await res.json()) as { blocks: { items: { kind: string; comObject?: { refId: string; gaRaw: number | null } }[] }[] };
    const comObjs = view.blocks.flatMap((b) => b.items).filter((i) => i.kind === "comObject").map((i) => i.comObject!);
    expect(comObjs.find((c) => c.refId === `${NEW_APP}_O-1_R-1`)?.gaRaw).toBe(GA_SWITCH);

    // Device row: new product, same IA/name/instance id; room assignment intact.
    const proj = (await (await handleApi(req(`/api/projects/${projectId}`), state))!.json()) as {
      devices: { id: string; ia: string; name: string; appRef: string; productRef: string; changes: { params: number; links: number; flags: number; neverProgrammed: boolean } }[];
      locations: { id: string; deviceIds: string[] }[];
    };
    expect(proj.devices).toHaveLength(1);
    expect(proj.devices[0]).toMatchObject({ id: deviceId, ia: "1.1.1", name: "Sensor Bad", appRef: NEW_PRODUCT.appRef, productRef: NEW_PRODUCT.productRef });
    expect(proj.locations.find((l) => Number(l.id) === spaceId)?.deviceIds).toContain(deviceId);
    // The migrated links are unprogrammed drift (new hardware, no baseline); no param edits.
    expect(proj.devices[0].changes).toEqual({ params: 0, links: 3, flags: 0, neverProgrammed: true });

    // Stored rows: exactly the mapped links; the two-GA link keeps its slot order
    // (slot 0 is the sending address, swapping it would re-point the device).
    const links = state.db.query("SELECT com_obj_ref_id AS r, slot, ga_raw AS ga FROM device_links WHERE project_id = ? AND device_id = ? ORDER BY r, slot")
      .all(projectId, deviceId);
    expect(links).toEqual([
      { r: "O-1_R-1", slot: 0, ga: GA_SWITCH },
      { r: "O-2_R-2", slot: 0, ga: GA_DIM_A }, { r: "O-2_R-2", slot: 1, ga: GA_DIM_B },
      { r: "O-3_R-3", slot: 0, ga: GA_HIDDEN },
    ]);

    // The old application's data is gone: params, baselines, modules, security, baggage.
    const count = (table: string) => (state.db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND device_id = ?`).get(projectId, deviceId) as { n: number }).n;
    for (const t of ["device_parameters", "device_param_base", "device_link_base", "device_modules", "device_security"]) expect(count(t)).toBe(0);
    const bag = state.db.query("SELECT name FROM device_baggage WHERE project_id = ? ORDER BY name").all(projectId) as { name: string }[];
    expect(bag).toEqual([{ name: "OTHER-DEVICE_dca.bin" }]); // other devices' baggage untouched
  });

  test("a link mapped to null is dropped, not carried over", async () => {
    const { state, projectId, deviceId } = await setup();
    const mapping = [
      { from: "O-1_R-1", to: "O-1_R-1" },
      { from: "O-2_R-2", to: null },
      { from: "O-3_R-3", to: null },
    ];
    const res = (await handleApi(replaceReq(projectId, deviceId, { ...NEW_PRODUCT, mapping }), state))!;
    expect(res.status).toBe(200);
    const links = state.db.query("SELECT com_obj_ref_id AS r, slot, ga_raw AS ga FROM device_links WHERE project_id = ? AND device_id = ?")
      .all(projectId, deviceId);
    expect(links).toEqual([{ r: "O-1_R-1", slot: 0, ga: GA_SWITCH }]);
  });

  test("unknown project / device / product -> 404 with the existing codes", async () => {
    const { state, projectId, deviceId } = await setup();
    const total = [{ from: "O-1_R-1", to: null }, { from: "O-2_R-2", to: null }, { from: "O-3_R-3", to: null }];

    const noProj = (await handleApi(replaceReq("nope", deviceId, { ...NEW_PRODUCT, mapping: total }), state))!;
    expect([noProj.status, await errCode(noProj)]).toEqual([404, "PROJECT_NOT_FOUND"]);

    const noDev = (await handleApi(replaceReq(projectId, "ghost", { ...NEW_PRODUCT, mapping: total }), state))!;
    expect([noDev.status, await errCode(noDev)]).toEqual([404, "DEVICE_NOT_FOUND"]);

    const noProd = (await handleApi(replaceReq(projectId, deviceId, { appRef: "M-NOPE_H-9_HP-9", productRef: "M-NOPE_H-9_P-9", mapping: total }), state))!;
    expect([noProd.status, await errCode(noProd)]).toEqual([404, "CATALOG_PRODUCT_NOT_FOUND"]);
  });

  test("malformed body -> REPLACE_FIELDS_REQUIRED", async () => {
    const { state, projectId, deviceId } = await setup();
    for (const body of [
      {},
      { ...NEW_PRODUCT }, // no mapping
      { ...NEW_PRODUCT, mapping: [{ from: 5, to: null }] }, // non-string from
      { ...NEW_PRODUCT, mapping: [{ from: "O-1_R-1" }] }, // to missing entirely
    ]) {
      const res = (await handleApi(replaceReq(projectId, deviceId, body), state))!;
      expect([res.status, await errCode(res)]).toEqual([400, "REPLACE_FIELDS_REQUIRED"]);
    }
  });

  test("refusals: unknown target, unknown from, non-total, duplicate, collision", async () => {
    const { state, projectId, deviceId } = await setup();
    const call = async (mapping: unknown) => {
      const res = (await handleApi(replaceReq(projectId, deviceId, { ...NEW_PRODUCT, mapping }), state))!;
      return [res.status, await errCode(res)];
    };
    const rest = [{ from: "O-2_R-2", to: null }, { from: "O-3_R-3", to: null }];

    // `to` is not a com-object of the new application.
    expect(await call([{ from: "O-1_R-1", to: "O-99_R-99" }, ...rest])).toEqual([400, "REPLACE_COMOBJ_NOT_IN_APP"]);
    // `from` is not a current link of this device.
    expect(await call([{ from: "O-9_R-9", to: null }, { from: "O-1_R-1", to: null }, ...rest])).toEqual([400, "REPLACE_LINK_UNKNOWN"]);
    // The mapping must cover every current link.
    expect(await call([{ from: "O-1_R-1", to: null }])).toEqual([400, "REPLACE_MAPPING_INCOMPLETE"]);
    // The same `from` twice (full + stripped form resolve to one key).
    expect(await call([{ from: "O-1_R-1", to: null }, { from: `${OLD_APP}_O-1_R-1`, to: null }, ...rest])).toEqual([400, "REPLACE_MAPPING_DUPLICATE"]);
    // Two links onto one target would collide on (com_obj_ref_id, slot).
    expect(await call([{ from: "O-1_R-1", to: "O-1_R-1" }, { from: "O-2_R-2", to: "O-1_R-1" }, { from: "O-3_R-3", to: null }])).toEqual([400, "REPLACE_MAPPING_COLLISION"]);

    // Nothing was mutated by any refusal: still the old product, links intact.
    const proj = (await (await handleApi(req(`/api/projects/${projectId}`), state))!.json()) as { devices: { appRef: string }[] };
    expect(proj.devices[0].appRef).toBe(`${OLD}_H-1_HP-1`);
    const n = (state.db.query("SELECT COUNT(*) AS n FROM device_links WHERE project_id = ? AND device_id = ?").get(projectId, deviceId) as { n: number }).n;
    expect(n).toBe(4); // O-1 (1) + O-2 (2 slots) + O-3 (1)
  });

  test("replacing with a module-def product is refused, even with an all-null mapping", async () => {
    const { state, projectId, deviceId } = await setup();
    await importKnxprod(state, knxprod(MOD, modAppXml));
    const mapping = [{ from: "O-1_R-1", to: null }, { from: "O-2_R-2", to: null }, { from: "O-3_R-3", to: null }];
    const res = (await handleApi(replaceReq(projectId, deviceId, { appRef: `${MOD}_H-1_HP-1`, productRef: `${MOD}_H-1_P-1`, mapping }), state))!;
    expect([res.status, await errCode(res)]).toEqual([400, "COMOBJ_UNIVERSE_MODULES_UNSUPPORTED"]);
  });
});
