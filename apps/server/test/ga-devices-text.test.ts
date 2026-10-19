import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { setDeviceLink, setDeviceParam } from "../src/db/deviceparams.ts";
import { createGroupAddress, createGroupRange } from "../src/db/groupedit.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";

// The group-address device list names a linked com-object the configuration view does not reach
// (hidden by a parameter) from the catalogue, like the view would: translated, with its
// {{0:default}} placeholder fed by the device's text parameter.
const M = "M-TXT1";
const A = `${M}_A-1`;
const appXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${M}"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Text App" DefaultLanguage="en-US">
<Static>
<ParameterTypes>
  <ParameterType Id="${A}_PT-1" Name="OnOff"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="Off" Value="0" Id="${A}_PT-1_EN-0"/><Enumeration Text="On" Value="1" Id="${A}_PT-1_EN-1"/></TypeRestriction></ParameterType>
  <ParameterType Id="${A}_PT-2" Name="Txt"><TypeText SizeInBit="80"/></ParameterType>
</ParameterTypes>
<Parameters>
  <Parameter Id="${A}_P-1" Name="Show" ParameterType="${A}_PT-1" Text="Show" Value="0"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0"/></Parameter>
  <Parameter Id="${A}_P-2" Name="Name" ParameterType="${A}_PT-2" Text="Name" Value=""><Memory CodeSegment="${A}_RS-1" Offset="1" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs><ParameterRef Id="${A}_P-1_R-1" RefId="${A}_P-1"/><ParameterRef Id="${A}_P-2_R-2" RefId="${A}_P-2"/></ParameterRefs>
<ComObjectTable>
  <ComObject Id="${A}_O-1" Number="1" Name="Hidden" Text="{{0:Sensor}}: value" FunctionText="Output" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/>
</ComObjectTable>
<ComObjectRefs><ComObjectRef Id="${A}_O-1_R-1" RefId="${A}_O-1" TextParameterRefId="${A}_P-2_R-2"/></ComObjectRefs>
<Code><RelativeSegment Id="${A}_RS-1" Offset="0" Size="16" LoadStateMachine="4"/></Code>
</Static>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main">
  <ParameterRefRef RefId="${A}_P-1_R-1"/>
  <choose ParamRefId="${A}_P-1_R-1"><when test="1"><ParameterRefRef RefId="${A}_P-2_R-2"/><ComObjectRefRef RefId="${A}_O-1_R-1"/></when></choose>
</ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer>
<Languages><Language Identifier="de-DE"><TranslationUnit RefId="${A}">
  <TranslationElement RefId="${A}_O-1_R-1"><Translation AttributeName="Text" Text="{{0:Fühler}}: Wert"/></TranslationElement>
</TranslationUnit></Language></Languages>
</ManufacturerData></KNX>`;

const hardware = `<?xml version="1.0"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${M}">
  <Hardware><Hardware Id="${M}_H-1" Name="HW" VersionNumber="1">
    <Products><Product Id="${M}_H-1_P-1" Text="Product" OrderNumber="${M}-001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${M}_H-1_HP-1"><ApplicationProgramRef RefId="${A}"/></Hardware2Program></Hardware2Programs>
  </Hardware></Hardware>
</Manufacturer></ManufacturerData></KNX>`;

const tmps: string[] = [];
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

async function setup(): Promise<{ state: AppState; projectId: string; deviceId: string; raw: number }> {
  const dir = mkdtempSync(join(tmpdir(), "busforge-gatext-"));
  tmps.push(dir);
  const state = createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
  const form = new FormData();
  form.set("file", new File([storeZip({ [`${M}/Hardware.xml`]: hardware, [`${M}/${A}.xml`]: appXml })], "prod.knxprod"));
  expect((await handleApi(new Request("http://x/api/catalog/import", { method: "POST", body: form }), state))!.status).toBe(201);
  const json = (path: string, body: unknown) =>
    new Request(`http://x${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const proj = (await (await handleApi(json("/api/projects", { name: "P" }), state))!.json()) as { id: string };
  const dev = (await (await handleApi(json(`/api/projects/${proj.id}/devices`, { appRef: `${M}_H-1_HP-1`, productRef: `${M}_H-1_P-1` }), state))!.json()) as { id: string };
  const main = createGroupRange(state.db, proj.id, null, "Main", 0);
  const mid = createGroupRange(state.db, proj.id, main, "Mid", 0);
  const { raw } = createGroupAddress(state.db, proj.id, mid, 1, "Switch", "1.001");
  setDeviceLink(state.db, proj.id, dev.id, "O-1_R-1", [raw]);
  return { state, projectId: proj.id, deviceId: dev.id, raw };
}

const names = async (s: { state: AppState; projectId: string; raw: number }, lang?: string) => {
  const res = (await handleApi(new Request(`http://x/api/projects/${s.projectId}/group-addresses/${s.raw}/devices${lang ? `?lang=${lang}` : ""}`), s.state))!;
  expect(res.status).toBe(200);
  const v = (await res.json()) as { receivers: { comObjName: string }[] };
  return v.receivers.map((r) => r.comObjName);
};

describe("group-address devices: a hidden linked com-object's name", () => {
  test("shows the placeholder's default, translated", async () => {
    const s = await setup();
    expect(await names(s)).toEqual(["Sensor: value"]);
    expect(await names(s, "de-DE")).toEqual(["Fühler: Wert"]);
  });

  test("shows the device's text parameter value", async () => {
    const s = await setup();
    setDeviceParam(s.state.db, s.projectId, s.deviceId, `${A}_P-2_R-2`, "Cellar");
    expect(await names(s)).toEqual(["Cellar: value"]);
  });
});
