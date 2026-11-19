import { test, expect, describe } from "bun:test";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { unpackBusforge } from "../src/db/busforgeArtifact.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { tempDir } from "../../../tools/test-temp.ts";

// A project file whose import leaves links out lists them per com-object: in the preview, on the
// imported project, and in its .busforge export. One device with an application of three objects:
// object 1 links an address the project does not have besides one it has, object 2 sends on an address
// the project does not have, object 3 imports in full. Address 0/0/3 is linked to nothing.
const M = "M-TDL1";
const A = `${M}_A-1`;
const obj = (n: number, name: string, fn: string) =>
  `<ComObject Id="${A}_O-${n}" Number="${n}" Name="${name}" Text="${name}" FunctionText="${fn}" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/>`;
// `dynamic`: the application's <Dynamic> body; one whose condition Busforge refuses makes the device's
// configuration refuse.
const appXml = (dynamic = `<ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main">
  ${[1, 2, 3].map((n) => `<ComObjectRefRef RefId="${A}_O-${n}_R-${n}"/>`).join("")}
</ParameterBlock></ChannelIndependentBlock>`) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${M}"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Dropped App" DefaultLanguage="en-US">
<Static>
<ParameterTypes><ParameterType Id="${A}_PT-1" Name="OnOff"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="Off" Value="0" Id="${A}_PT-1_EN-0"/><Enumeration Text="On" Value="1" Id="${A}_PT-1_EN-1"/></TypeRestriction></ParameterType></ParameterTypes>
<Parameters><Parameter Id="${A}_P-1" Name="Show" ParameterType="${A}_PT-1" Text="Show" Value="0"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0"/></Parameter></Parameters>
<ParameterRefs><ParameterRef Id="${A}_P-1_R-1" RefId="${A}_P-1"/></ParameterRefs>
<ComObjectTable>${obj(1, "Switch", "On/off")}${obj(2, "Status", "Feedback")}${obj(3, "Lock", "Block")}</ComObjectTable>
<ComObjectRefs>${[1, 2, 3].map((n) => `<ComObjectRef Id="${A}_O-${n}_R-${n}" RefId="${A}_O-${n}"/>`).join("")}</ComObjectRefs>
<Code><RelativeSegment Id="${A}_RS-1" Offset="0" Size="16" LoadStateMachine="4"/></Code>
</Static>
<Dynamic>${dynamic}</Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const hardware = `<?xml version="1.0"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${M}">
  <Hardware><Hardware Id="${M}_H-1" Name="HW" VersionNumber="1">
    <Products><Product Id="${M}_H-1_P-1" Text="Dropped Product" OrderNumber="${M}-001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${M}_H-1_HP-1"><ApplicationProgramRef RefId="${A}"/></Hardware2Program></Hardware2Programs>
  </Hardware></Hardware>
</Manufacturer></ManufacturerData></KNX>`;
const xml0 = `<?xml version="1.0"?><KNX xmlns="http://knx.org/xml/project/21"><Project Id="P-0001"><Installations>
<Installation InstallationId="0" Name="Main"><Topology><Area Address="1"><Line Address="1">
<DeviceInstance Id="P-0001-0_DI-1" Name="Kitchen actuator" Address="5" ProductRefId="${M}_H-1_P-1" Hardware2ProgramRefId="${M}_H-1_HP-1"><ComObjectInstanceRefs>
  <ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-9"/>
  <ComObjectInstanceRef RefId="O-2_R-2" Links="GA-8 GA-2"/>
  <ComObjectInstanceRef RefId="O-3_R-3" Links="GA-2"/>
</ComObjectInstanceRefs></DeviceInstance></Line></Area></Topology>
<GroupAddresses><GroupRanges><GroupRange Name="Main" RangeStart="0" RangeEnd="2047"><GroupRange Name="Mid" RangeStart="0" RangeEnd="255">
  <GroupAddress Id="P-0001-0_GA-1" Address="1" Name="Kitchen light"/><GroupAddress Id="P-0001-0_GA-2" Address="2" Name="Kitchen status"/><GroupAddress Id="P-0001-0_GA-3" Address="3" Name="Spare"/>
</GroupRange></GroupRange></GroupRanges></GroupAddresses></Installation></Installations></Project></KNX>`;
const knxprojWith = (app: string, project = xml0) => storeZip({ [`${M}/Hardware.xml`]: hardware, [`${M}/${A}.xml`]: app, "P-0001/0.xml": project });
const knxproj = knxprojWith(appXml());

// A channel device: a module per channel, as many as its parameter P-1 says (1 or 2), the allocator giving
// each channel's object its number. The device stores no module instances, so they follow its values. Channel 2's
// object links an address the project does not have besides 0/0/1.
const MA = `${M}_A-2`;
const moduleAppXml = (objects = `<ComObjectRefRef RefId="${MA}_MD-1_O-1_R-1"/>`) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${M}"><ApplicationPrograms>
<ApplicationProgram Id="${MA}" ApplicationNumber="2" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Channel App" DefaultLanguage="en-US">
<Static>
<ParameterTypes><ParameterType Id="${MA}_PT-1" Name="Channels"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="1" Value="1" Id="${MA}_PT-1_EN-1"/><Enumeration Text="2" Value="2" Id="${MA}_PT-1_EN-2"/></TypeRestriction></ParameterType></ParameterTypes>
<Parameters><Parameter Id="${MA}_P-1" Name="Channels" ParameterType="${MA}_PT-1" Text="Channels" Value="2"/><Parameter Id="${MA}_P-2" Name="Switch" ParameterType="${MA}_PT-1" Text="Switch" Value="1"/></Parameters>
<ParameterRefs><ParameterRef Id="${MA}_P-1_R-1" RefId="${MA}_P-1"/><ParameterRef Id="${MA}_P-2_R-1" RefId="${MA}_P-2"/></ParameterRefs>
<ComObjectTable/><ComObjectRefs/>
<Allocators><Allocator Id="${MA}_L-1" Name="Objects" Start="1" maxInclusive="10"/></Allocators>
</Static>
<ModuleDefs><ModuleDef Id="${MA}_MD-1" Name="Channel">
  <Arguments><Argument Id="${MA}_MD-1_A-1" Name="Base" Allocates="1"/></Arguments>
  <Static>
    <ComObjects><ComObject Id="${MA}_MD-1_O-1" Number="0" Name="Switch" Text="Switch" FunctionText="On/off" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" BaseNumber="${MA}_MD-1_A-1"/></ComObjects>
    <ComObjectRefs><ComObjectRef Id="${MA}_MD-1_O-1_R-1" RefId="${MA}_MD-1_O-1"/></ComObjectRefs>
  </Static>
  <Dynamic><ParameterBlock Id="${MA}_MD-1_PB-1" Name="ch" Text="Channel">${objects}</ParameterBlock></Dynamic>
</ModuleDef></ModuleDefs>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${MA}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${MA}_P-1_R-1"/><ParameterRefRef RefId="${MA}_P-2_R-1"/></ParameterBlock></ChannelIndependentBlock>
<choose ParamRefId="${MA}_P-1_R-1">
  <when test="1"><Module Id="${MA}_MD-1_M-1" RefId="${MA}_MD-1" Name="C"><NumericArg RefId="${MA}_MD-1_A-1" AllocatorRefId="${MA}_L-1"/></Module></when>
  <when test="2"><Repeat Id="${MA}_X-1" Name="C" Count="2"><Module Id="${MA}_MD-1_M-1" RefId="${MA}_MD-1" Name="C"><NumericArg RefId="${MA}_MD-1_A-1" AllocatorRefId="${MA}_L-1"/></Module></Repeat></when>
</choose></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const moduleHardware = hardware.replace(`<ApplicationProgramRef RefId="${A}"/>`, `<ApplicationProgramRef RefId="${MA}"/>`);
const moduleKnxprojWith = (app: string, refs = `<ComObjectInstanceRef RefId="MD-1_M-1_MI-2_O-1_R-1" Links="GA-1 GA-9"/>`) => storeZip({
  [`${M}/Hardware.xml`]: moduleHardware, [`${M}/${MA}.xml`]: app,
  "P-0001/0.xml": xml0.replace(/<ComObjectInstanceRefs>[\s\S]*<\/ComObjectInstanceRefs>/, `<ComObjectInstanceRefs>${refs}</ComObjectInstanceRefs>`),
});
const moduleKnxproj = moduleKnxprojWith(moduleAppXml());

const expected = [
  {
    deviceId: "P-0001-0_DI-1", ia: "1.1.5", deviceName: "Kitchen actuator", comObjRefId: "O-1_R-1",
    comObjNumber: 1, comObjName: "Switch", functionText: "On/off", unresolved: null, refusal: null, unrecoverable: false, reason: "addressNotInProject",
    gas: [{ etsId: "GA-1", address: "0/0/1", name: "Kitchen light", inProject: true }, { etsId: "GA-9", address: null, name: null, inProject: false }],
  },
  {
    deviceId: "P-0001-0_DI-1", ia: "1.1.5", deviceName: "Kitchen actuator", comObjRefId: "O-2_R-2",
    comObjNumber: 2, comObjName: "Status", functionText: "Feedback", unresolved: null, refusal: null, unrecoverable: false, reason: "senderNotInProject",
    gas: [{ etsId: "GA-8", address: null, name: null, inProject: false }, { etsId: "GA-2", address: "0/0/2", name: "Kitchen status", inProject: true }],
  },
];

// The project's .busforge artifact, as the export route returns it.
async function exportArtifact(state: AppState, id: string): Promise<{ bytes: Buffer }> {
  const res = (await handleApi(new Request(`http://x/api/projects/${id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), state))!;
  expect(res.status).toBe(200);
  return { bytes: Buffer.from(await res.arrayBuffer()) };
}

function freshState(): AppState {
  const dir = tempDir("busforge-dropped-");
  return createState({ dbPath: ":memory:", dataDir: dir, now: () => 1000 });
}
const post = async (state: AppState, path: string, file: File) => {
  const form = new FormData();
  form.set("file", file);
  const res = (await handleApi(new Request(`http://x${path}`, { method: "POST", body: form }), state))!;
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as any;
};
const put = async (state: AppState, projectId: string, what: "links" | "params", body: object) => {
  const res = (await handleApi(new Request(`http://x/api/projects/${projectId}/devices/P-0001-0_DI-1/${what}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), state))!;
  expect(res.status).toBe(200);
};
const relink = (state: AppState, projectId: string, comObjRefId: string, gaRaws: number[]) => put(state, projectId, "links", { comObjRefId, gaRaws });
const listed = async (state: AppState, projectId: string) => {
  const res = (await handleApi(new Request(`http://x/api/projects/${projectId}/dropped-links`), state))!;
  expect(res.status).toBe(200);
  return (await res.json()) as unknown[];
};

describe("links an import does not take over, per com-object", () => {
  test("the preview lists each com-object with its number, name, ETS addresses and reason, next to the counts", async () => {
    const a = await post(freshState(), "/api/projects/analyze", new File([knxproj], "Dropped.knxproj"));
    expect(a.unresolvedLinks).toBe(2);
    expect(a.linksWithoutSender).toBe(1);
    expect(a.droppedLinks).toEqual(expected);
  });

  test("the imported project keeps the same list, and its .busforge export carries it into a re-import", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([knxproj], "Dropped.knxproj"));
    expect(await listed(state, imp.id)).toEqual(expected);
    const { bytes } = await exportArtifact(state, imp.id);
    const again = await post(state, "/api/projects/import-busforge", new File([bytes], "Dropped.busforge"));
    expect(await listed(state, again.id)).toEqual(expected);
  });

  test("a device whose configuration refuses its application shows the refusal on its objects, with the number the application declares, and the preview still answers", async () => {
    // Object 1 is declared with Number 0: the digit of its ETS id is no number.
    const refused = appXml(`<ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><choose ParamRefId="${A}_P-1_R-1"><when test="on"><ComObjectRefRef RefId="${A}_O-1_R-1"/></when></choose></ParameterBlock></ChannelIndependentBlock>`).replace(`_O-1" Number="1"`, `_O-1" Number="0"`);
    const a = await post(freshState(), "/api/projects/analyze", new File([knxprojWith(refused)], "Dropped.knxproj"));
    expect(a.droppedLinks.map((l: any) => [l.comObjNumber, l.comObjName, l.functionText, l.unresolved, l.refusal, l.unrecoverable])).toEqual([
      [0, "Switch", "On/off", "refused", "PARAM_TEST_UNSUPPORTED", true], [2, "Status", "Feedback", "refused", "PARAM_TEST_UNSUPPORTED", true],
    ]);
  });

  test("a device without its application program in the file says so on its objects", async () => {
    const a = await post(freshState(), "/api/projects/analyze", new File([storeZip({ [`${M}/Hardware.xml`]: hardware, "P-0001/0.xml": xml0 })], "Dropped.knxproj"));
    expect(a.droppedLinks.map((l: any) => [l.unresolved, l.unrecoverable])).toEqual([["noApplication", true], ["noApplication", true]]);
  });

  test("an address deleted since the import keeps its value and shows as not in the project", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([knxproj], "Dropped.knxproj"));
    const del = (await handleApi(new Request(`http://x/api/projects/${imp.id}/group-addresses/1`, { method: "DELETE" }), state))!;
    expect(del.status).toBeLessThan(300);
    const [first] = (await listed(state, imp.id)) as { gas: unknown[] }[];
    expect(first.gas[0]).toEqual({ etsId: "GA-1", address: "0/0/1", name: null, inProject: false });
  });

  test("an object linked again by hand leaves the list, its record stays in the export", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([knxproj], "Dropped.knxproj"));
    // Object 2 had 0/0/2 and an address the project lacks: 0/0/2 alone is not all ETS linked it to.
    await relink(state, imp.id, "O-2_R-2", [2]);
    expect(await listed(state, imp.id)).toEqual(expected);
    // 0/0/3 stands in for the missing sending address.
    await relink(state, imp.id, "O-2_R-2", [3, 2]);
    expect(await listed(state, imp.id)).toEqual([expected[0]]);
    // Object 1 kept 0/0/1 from the import; a second address makes it whole.
    await relink(state, imp.id, "O-1_R-1", [1, 3]);
    expect(await listed(state, imp.id)).toEqual([]);
    const data = (await unpackBusforge((await exportArtifact(state, imp.id)).bytes)) as any;
    expect(data.droppedLinks.map((l: any) => l.comObjRefId)).toEqual(["O-1_R-1", "O-2_R-2"]);
    // Unlinking an ETS address the project has opens the entry again.
    await relink(state, imp.id, "O-1_R-1", [3, 2]);
    expect(await listed(state, imp.id)).toEqual([expected[0]]);
  });

  test("an object ETS names no sending address for leaves the list once it holds its ETS addresses", async () => {
    const state = freshState();
    const project = xml0.replace(`<ComObjectInstanceRef RefId="O-3_R-3" Links="GA-2"/>`, `<ComObjectInstanceRef RefId="O-3_R-3"><Connectors><Receive GroupAddressRefId="P-0001-0_GA-2"/><Receive GroupAddressRefId="P-0001-0_GA-3"/></Connectors></ComObjectInstanceRef>`);
    const imp = await post(state, "/api/projects/import", new File([knxprojWith(appXml(), project)], "Dropped.knxproj"));
    expect((await listed(state, imp.id)).map((l: any) => [l.comObjRefId, l.reason])).toEqual([["O-1_R-1", "addressNotInProject"], ["O-2_R-2", "senderNotInProject"], ["O-3_R-3", "noSingleSender"]]);
    await relink(state, imp.id, "O-3_R-3", [2]);
    expect((await listed(state, imp.id)).map((l: any) => l.comObjRefId)).toEqual(["O-1_R-1", "O-2_R-2", "O-3_R-3"]);
    await relink(state, imp.id, "O-3_R-3", [3, 2]);
    expect((await listed(state, imp.id)).map((l: any) => l.comObjRefId)).toEqual(["O-1_R-1", "O-2_R-2"]);
  });

  test("an ETS address deleted since the import needs a stand-in like one the project never had", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([knxproj], "Dropped.knxproj"));
    const del = (await handleApi(new Request(`http://x/api/projects/${imp.id}/group-addresses/1`, { method: "DELETE" }), state))!;
    expect(del.status).toBeLessThan(300);
    await relink(state, imp.id, "O-1_R-1", [3]);
    expect((await listed(state, imp.id)).map((l: any) => l.comObjRefId)).toEqual(["O-1_R-1", "O-2_R-2"]);
    await relink(state, imp.id, "O-1_R-1", [3, 2]);
    expect((await listed(state, imp.id)).map((l: any) => l.comObjRefId)).toEqual(["O-2_R-2"]);
  });

  test("an object two ETS refs share stays listed after the import, the other ref's address being no stand-in", async () => {
    const state = freshState();
    const project = xml0.replace(`<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-9"/>`, `<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-9"/><ComObjectInstanceRef RefId="O-1_R-1" Links="GA-3"/>`);
    const imp = await post(state, "/api/projects/import", new File([knxprojWith(appXml(), project)], "Dropped.knxproj"));
    expect((await listed(state, imp.id)).map((l: any) => l.comObjRefId)).toEqual(["O-1_R-1", "O-2_R-2"]);
    await relink(state, imp.id, "O-1_R-1", [1, 3, 2]);
    expect((await listed(state, imp.id)).map((l: any) => l.comObjRefId)).toEqual(["O-2_R-2"]);
  });

  test("an object linked again counts only while the configuration shows it", async () => {
    const state = freshState();
    const hiding = appXml(`<ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${A}_P-1_R-1"/>
      <ComObjectRefRef RefId="${A}_O-1_R-1"/><choose ParamRefId="${A}_P-1_R-1"><when test="0"><ComObjectRefRef RefId="${A}_O-2_R-2"/></when></choose><ComObjectRefRef RefId="${A}_O-3_R-3"/>
    </ParameterBlock></ChannelIndependentBlock>`);
    const imp = await post(state, "/api/projects/import", new File([knxprojWith(hiding)], "Dropped.knxproj"));
    await relink(state, imp.id, "O-2_R-2", [3, 2]);
    expect((await listed(state, imp.id)).map((l: any) => l.comObjRefId)).toEqual(["O-1_R-1"]);
    await put(state, imp.id, "params", { paramRefId: `${A}_P-1_R-1`, value: "1" });
    expect((await listed(state, imp.id)).map((l: any) => [l.comObjRefId, l.comObjNumber])).toEqual([["O-1_R-1", 1], ["O-2_R-2", 2]]);
  });

  test("a hidden object gives the same reason whether a ComObjectRef or a bare ComObject is hidden, and none once it shows", async () => {
    const state = freshState();
    const hiding = appXml(`<ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${A}_P-1_R-1"/>
      <choose ParamRefId="${A}_P-1_R-1"><when test="1"><ComObjectRefRef RefId="${A}_O-1_R-1"/><ComObjectRefRef RefId="${A}_O-4"/></when></choose>
    </ParameterBlock></ChannelIndependentBlock>`).replace("</ComObjectTable>", `${obj(4, "Scene", "Recall")}</ComObjectTable>`);
    const project = xml0.replace(/<ComObjectInstanceRefs>[\s\S]*<\/ComObjectInstanceRefs>/, `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-9"/><ComObjectInstanceRef RefId="O-4" Links="GA-1 GA-9"/></ComObjectInstanceRefs>`);
    const imp = await post(state, "/api/projects/import", new File([knxprojWith(hiding, project)], "Dropped.knxproj"));
    const entries = async () => ((await listed(state, imp.id)) as any[]).map((l) => [l.comObjRefId, l.unresolved, l.unrecoverable]);
    expect(await entries()).toEqual([["O-1_R-1", "notInConfiguration", false], ["O-4", "notInConfiguration", false]]);
    await put(state, imp.id, "params", { paramRefId: `${A}_P-1_R-1`, value: "1" });
    expect(await entries()).toEqual([["O-1_R-1", null, false], ["O-4", null, false]]);
  });

  test("an object the application does not have can never be linked again: listed apart, with its reason", async () => {
    const state = freshState();
    const project = xml0.replace(`<ComObjectInstanceRef RefId="O-3_R-3" Links="GA-2"/>`, `<ComObjectInstanceRef RefId="O-3_R-3" Links="GA-2"/><ComObjectInstanceRef RefId="O-7_R-7" Links="GA-9"/>`);
    const imp = await post(state, "/api/projects/import", new File([knxprojWith(appXml(), project)], "Dropped.knxproj"));
    expect((await listed(state, imp.id)).map((l: any) => [l.comObjRefId, l.unresolved, l.unrecoverable])).toEqual([
      ["O-1_R-1", null, false], ["O-2_R-2", null, false], ["O-7_R-7", "notInApplication", true],
    ]);
  });

  test("an object its parameters hide stays open also where the configuration places it without a ComObjectRef", async () => {
    const state = freshState();
    const direct = appXml(`<ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${A}_P-1_R-1"/>
      <choose ParamRefId="${A}_P-1_R-1"><when test="1"><ComObjectRefRef RefId="${A}_O-4"/></when></choose>
    </ParameterBlock></ChannelIndependentBlock>`).replace("</ComObjectTable>", `${obj(4, "Scene", "Recall")}</ComObjectTable>`);
    const project = xml0.replace(/<ComObjectInstanceRefs>[\s\S]*<\/ComObjectInstanceRefs>/, `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="O-4" Links="GA-1 GA-9"/></ComObjectInstanceRefs>`);
    const imp = await post(state, "/api/projects/import", new File([knxprojWith(direct, project)], "Dropped.knxproj"));
    const entries = async () => ((await listed(state, imp.id)) as any[]).map((l) => [l.comObjRefId, l.comObjNumber, l.unresolved, l.unrecoverable]);
    expect(await entries()).toEqual([["O-4", 4, "notInConfiguration", false]]);
    await put(state, imp.id, "params", { paramRefId: `${A}_P-1_R-1`, value: "1" });
    expect(await entries()).toEqual([["O-4", 4, null, false]]);
  });

  test("an object the configuration does not place carries the application's number, never the digit of its ETS id, and its texts only where they can be resolved", async () => {
    const state = freshState();
    const direct = appXml(`<ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="${A}_P-1_R-1"/>
      <choose ParamRefId="${A}_P-1_R-1"><when test="1"><ComObjectRefRef RefId="${A}_O-4"/></when></choose>
    </ParameterBlock></ChannelIndependentBlock>`).replace("</ComObjectTable>", `${obj(4, "Scene", "Recall").replace(`Number="4"`, `Number="14"`)}</ComObjectTable>`);
    const project = xml0.replace(/<ComObjectInstanceRefs>[\s\S]*<\/ComObjectInstanceRefs>/, `<ComObjectInstanceRefs><ComObjectInstanceRef RefId="O-4" Links="GA-1 GA-9"/><ComObjectInstanceRef RefId="O-8_R-8" Links="GA-1 GA-9"/></ComObjectInstanceRefs>`);
    const imp = await post(state, "/api/projects/import", new File([knxprojWith(direct, project)], "Dropped.knxproj"));
    // O-4 is a ComObject the configuration places without a ComObjectRef: no translated text to send. O-8 is no
    // object of the application: nothing names its number.
    expect(((await listed(state, imp.id)) as any[]).map((l) => [l.comObjRefId, l.comObjNumber, l.comObjName, l.functionText, l.unresolved])).toEqual([
      ["O-4", 14, null, null, "notInConfiguration"], ["O-8_R-8", null, null, null, "notInApplication"],
    ]);
  });

  test("a module object is open while its instance is there and can never be linked again once a parameter removes it", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([moduleKnxproj], "Dropped.knxproj"));
    const entry = async () => ((await listed(state, imp.id)) as any[]).map((l) => [l.comObjRefId, l.comObjNumber, l.unresolved, l.unrecoverable]);
    // Two channels: the allocators make instances 1 and 2 of the device's values (it stores none).
    expect(await entry()).toEqual([["MD-1_M-1_MI-2_O-1_R-1", 2, null, false]]);
    await put(state, imp.id, "params", { paramRefId: `${MA}_P-1_R-1`, value: "1" });
    expect(await entry()).toEqual([["MD-1_M-1_MI-2_O-1_R-1", null, "moduleInstanceGone", true]]);
    // The record keeps the entry, and a second channel brings the object back as open work.
    const data = (await unpackBusforge((await exportArtifact(state, imp.id)).bytes)) as any;
    expect(data.droppedLinks.map((l: any) => l.comObjRefId)).toEqual(["MD-1_M-1_MI-2_O-1_R-1"]);
    await put(state, imp.id, "params", { paramRefId: `${MA}_P-1_R-1`, value: "2" });
    expect(await entry()).toEqual([["MD-1_M-1_MI-2_O-1_R-1", 2, null, false]]);
  });

  test("a refused configuration knows no instance, so a module object of it has no number", async () => {
    const refused = moduleAppXml().replace(`<when test="1">`, `<when test="on">`);
    const a = await post(freshState(), "/api/projects/analyze", new File([moduleKnxprojWith(refused)], "Dropped.knxproj"));
    expect(a.droppedLinks.map((l: any) => [l.comObjRefId, l.comObjNumber, l.comObjName, l.unresolved, l.unrecoverable])).toEqual([["MD-1_M-1_MI-2_O-1_R-1", null, null, "refused", true]]);
  });

  test("a module object of an instance the configuration no longer has carries no number and no text", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([moduleKnxproj], "Dropped.knxproj"));
    await put(state, imp.id, "params", { paramRefId: `${MA}_P-1_R-1`, value: "1" });
    expect(((await listed(state, imp.id)) as any[]).map((l) => [l.comObjNumber, l.comObjName, l.functionText, l.unresolved])).toEqual([[null, null, null, "moduleInstanceGone"]]);
  });

  test("a module object its parameters hide stays open, one its module does not declare can never be linked again", async () => {
    const state = freshState();
    // The channel's object shows while P-2 is 1, not at 2; channel 2 also carries an object its module has no such ref for.
    const hiding = moduleAppXml(`<choose ParamRefId="${MA}_P-2_R-1"><when test="1"><ComObjectRefRef RefId="${MA}_MD-1_O-1_R-1"/></when></choose>`);
    const refs = `<ComObjectInstanceRef RefId="MD-1_M-1_MI-2_O-1_R-1" Links="GA-1 GA-9"/><ComObjectInstanceRef RefId="MD-1_M-1_MI-2_O-9_R-9" Links="GA-1 GA-9"/>`;
    const imp = await post(state, "/api/projects/import", new File([moduleKnxprojWith(hiding, refs)], "Dropped.knxproj"));
    const entries = async () => ((await listed(state, imp.id)) as any[]).map((l) => [l.comObjRefId, l.comObjNumber, l.unresolved, l.unrecoverable]);
    expect(await entries()).toEqual([["MD-1_M-1_MI-2_O-1_R-1", 2, null, false], ["MD-1_M-1_MI-2_O-9_R-9", null, "notInApplication", true]]);
    await put(state, imp.id, "params", { paramRefId: `${MA}_P-2_R-1`, value: "2" });
    // Hidden, the object keeps the number its instance's base gives it, but no text: a module object's texts
    // take its instance's arguments. The one its module lacks has no number.
    const view = async () => ((await listed(state, imp.id)) as any[]).map((l) => [l.comObjName, l.functionText]);
    expect(await view()).toEqual([[null, null], [null, null]]);
    expect(await entries()).toEqual([["MD-1_M-1_MI-2_O-1_R-1", 2, "notInConfiguration", false], ["MD-1_M-1_MI-2_O-9_R-9", null, "notInApplication", true]]);
  });

  test("a project without dropped links lists none, and an unknown project is refused", async () => {
    const state = freshState();
    const blank = (await (await handleApi(new Request("http://x/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "P" }) }), state))!.json()) as { id: string };
    expect(await listed(state, blank.id)).toEqual([]);
    const res = (await handleApi(new Request("http://x/api/projects/nope/dropped-links"), state))!;
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("a .busforge entry for a device the artifact does not have is refused", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([knxproj], "Dropped.knxproj"));
    const { bytes } = await exportArtifact(state, imp.id);
    const data = (await unpackBusforge(bytes)) as any;
    data.droppedLinks[0].deviceId = "P-0001-0_DI-77";
    const form = new FormData();
    form.set("file", new File([JSON.stringify(data)], "p.busforge.json"));
    const res = (await handleApi(new Request("http://x/api/projects/import-busforge", { method: "POST", body: form }), state))!;
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("BUSFORGE_INVALID");
  });
});
