import { test, expect, describe } from "bun:test";
import { createState, handleApi, type AppState } from "../src/app.ts";
import { unpackBusforge } from "../src/db/busforgeArtifact.ts";
import { storeZip } from "../../../packages/project/test/ziputil.ts";
import { tempDir } from "../../../tools/test-temp.ts";

// A project file whose import leaves links out lists them per com-object: in the preview, on the
// imported project, and in its .busforge export. One device with an application of three objects:
// object 1 links an address the project does not have besides one it has, object 2 sends on an address
// the project does not have, object 3 imports in full.
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
  <GroupAddress Id="P-0001-0_GA-1" Address="1" Name="Kitchen light"/><GroupAddress Id="P-0001-0_GA-2" Address="2" Name="Kitchen status"/>
</GroupRange></GroupRange></GroupRanges></GroupAddresses></Installation></Installations></Project></KNX>`;
const knxprojWith = (app: string) => storeZip({ [`${M}/Hardware.xml`]: hardware, [`${M}/${A}.xml`]: app, "P-0001/0.xml": xml0 });
const knxproj = knxprojWith(appXml());

const expected = [
  {
    deviceId: "P-0001-0_DI-1", ia: "1.1.5", deviceName: "Kitchen actuator", comObjRefId: "O-1_R-1",
    comObjNumber: 1, comObjName: "Switch", functionText: "On/off", unresolved: null, refusal: null, reason: "addressNotInProject",
    gas: [{ etsId: "GA-1", address: "0/0/1", name: "Kitchen light", inProject: true }, { etsId: "GA-9", address: null, name: null, inProject: false }],
  },
  {
    deviceId: "P-0001-0_DI-1", ia: "1.1.5", deviceName: "Kitchen actuator", comObjRefId: "O-2_R-2",
    comObjNumber: 2, comObjName: "Status", functionText: "Feedback", unresolved: null, refusal: null, reason: "senderNotInProject",
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

  test("a device whose configuration refuses its application shows the refusal on its objects, and the preview still answers", async () => {
    const refused = appXml(`<ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="Main" Text="Main"><choose ParamRefId="${A}_P-1_R-1"><when test="on"><ComObjectRefRef RefId="${A}_O-1_R-1"/></when></choose></ParameterBlock></ChannelIndependentBlock>`);
    const a = await post(freshState(), "/api/projects/analyze", new File([knxprojWith(refused)], "Dropped.knxproj"));
    expect(a.droppedLinks.map((l: any) => [l.comObjNumber, l.unresolved, l.refusal])).toEqual([[null, "refused", "PARAM_TEST_UNSUPPORTED"], [null, "refused", "PARAM_TEST_UNSUPPORTED"]]);
  });

  test("a device without its application program in the file says so on its objects", async () => {
    const a = await post(freshState(), "/api/projects/analyze", new File([storeZip({ [`${M}/Hardware.xml`]: hardware, "P-0001/0.xml": xml0 })], "Dropped.knxproj"));
    expect(a.droppedLinks.map((l: any) => l.unresolved)).toEqual(["noApplication", "noApplication"]);
  });

  test("an address deleted since the import keeps its value and shows as not in the project", async () => {
    const state = freshState();
    const imp = await post(state, "/api/projects/import", new File([knxproj], "Dropped.knxproj"));
    const del = (await handleApi(new Request(`http://x/api/projects/${imp.id}/group-addresses/1`, { method: "DELETE" }), state))!;
    expect(del.status).toBeLessThan(300);
    const [first] = (await listed(state, imp.id)) as { gas: unknown[] }[];
    expect(first.gas[0]).toEqual({ etsId: "GA-1", address: "0/0/1", name: null, inProject: false });
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
