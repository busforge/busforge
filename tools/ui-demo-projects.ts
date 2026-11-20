// Small invented .knxproj files for looking at the UI's import-gap displays (dropped links, a device
// without application, a configuration Busforge refuses). Built in memory, nothing from the private
// corpus or a real installation. tools/ui-instance.ts imports them with `--demo`.
import { storeZip } from "../packages/project/test/ziputil.ts";

// A 1-bit com-object `n` of the application `<m>_A-1`.
export const droppedLinksObject = (m: string, n: number, name: string, fn: string) =>
  `<ComObject Id="${m}_A-1_O-${n}" Number="${n}" Name="${name}" Text="${name}" FunctionText="${fn}" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/>`;

// The application `<m>_A-1` of manufacturer `m`: three 1-bit objects (1 Switch, 2 Status, 3 Lock)
// and one parameter, `dynamic` its <Dynamic> body (by default one block showing all three objects).
// apps/server/test/dropped-links.test.ts builds its archives from it too.
export function droppedLinksApplication(m: string, dynamic?: string): string {
  const a = `${m}_A-1`;
  const obj = (n: number, name: string, fn: string) => droppedLinksObject(m, n, name, fn);
  return `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${m}"><ApplicationPrograms>
<ApplicationProgram Id="${a}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Dropped App" DefaultLanguage="en-US">
<Static>
<ParameterTypes><ParameterType Id="${a}_PT-1" Name="OnOff"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="Off" Value="0" Id="${a}_PT-1_EN-0"/><Enumeration Text="On" Value="1" Id="${a}_PT-1_EN-1"/></TypeRestriction></ParameterType></ParameterTypes>
<Parameters><Parameter Id="${a}_P-1" Name="Show" ParameterType="${a}_PT-1" Text="Show" Value="0"><Memory CodeSegment="${a}_RS-1" Offset="0" BitOffset="0"/></Parameter></Parameters>
<ParameterRefs><ParameterRef Id="${a}_P-1_R-1" RefId="${a}_P-1"/></ParameterRefs>
<ComObjectTable>${obj(1, "Switch", "On/off")}${obj(2, "Status", "Feedback")}${obj(3, "Lock", "Block")}</ComObjectTable>
<ComObjectRefs>${[1, 2, 3].map((n) => `<ComObjectRef Id="${a}_O-${n}_R-${n}" RefId="${a}_O-${n}"/>`).join("")}</ComObjectRefs>
<Code><RelativeSegment Id="${a}_RS-1" Offset="0" Size="16" LoadStateMachine="4"/></Code>
</Static>
<Dynamic>${dynamic ?? `<ChannelIndependentBlock><ParameterBlock Id="${a}_PB-1" Name="Main" Text="Main">${[1, 2, 3].map((n) => `<ComObjectRefRef RefId="${a}_O-${n}_R-${n}"/>`).join("")}</ParameterBlock></ChannelIndependentBlock>`}</Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
}

// The application whose configuration Busforge refuses: "on" is no value of the parameter's type.
// Object 1 is declared with Number 0: the digit of its ETS id is no number.
export const droppedLinksRefusedApplication = (m: string) =>
  droppedLinksApplication(m, `<ChannelIndependentBlock><ParameterBlock Id="${m}_A-1_PB-1" Name="Main" Text="Main"><choose ParamRefId="${m}_A-1_P-1_R-1"><when test="on"><ComObjectRefRef RefId="${m}_A-1_O-1_R-1"/></when></choose></ParameterBlock></ChannelIndependentBlock>`)
    .replace(`_O-1" Number="1"`, `_O-1" Number="0"`);

// One product of manufacturer `m` whose hardware names the application `<m>_A-1`.
export const droppedLinksHardware = (m: string) => `<?xml version="1.0"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="${m}">
  <Hardware><Hardware Id="${m}_H-1" Name="HW" VersionNumber="1">
    <Products><Product Id="${m}_H-1_P-1" Text="Dropped Product" OrderNumber="${m}-001"/></Products>
    <Hardware2Programs><Hardware2Program Id="${m}_H-1_HP-1"><ApplicationProgramRef RefId="${m}_A-1"/></Hardware2Program></Hardware2Programs>
  </Hardware></Hardware>
</Manufacturer></ManufacturerData></KNX>`;

// Object instance refs: [object number, the link list].
const device = (n: number, name: string, address: number, m: string, links: [number, string][]) =>
  `<DeviceInstance Id="P-0001-0_DI-${n}" Name="${name}" Address="${address}" ProductRefId="${m}_H-1_P-1" Hardware2ProgramRefId="${m}_H-1_HP-1"><ComObjectInstanceRefs>${
    links.map(([o, l]) => `<ComObjectInstanceRef RefId="O-${o}_R-${o}" Links="${l}"/>`).join("")}</ComObjectInstanceRefs></DeviceInstance>`;

// Line 1.1 with three devices and the group addresses 0/0/1-0/0/3; GA-8 and GA-9 are links to
// addresses the project does not have.
// - 1.1.5 Kitchen actuator: object 1 keeps 0/0/1 and loses GA-9, object 2 loses its sending GA-8,
//   object 3 imports whole, object 7 is not in the application.
// - 1.1.6 Hall actuator: its hardware names an application the archive does not hold.
// - 1.1.7 Garage actuator: its configuration has a condition Busforge refuses, so the whole device's
//   links are dropped for that one reason. `many` gives it six more links to objects its
//   application does not have, for a list that has to scroll.
export function droppedLinksDemo(many: boolean): Buffer {
  const garage: [number, string][] = [[1, "GA-1 GA-9"], [2, "GA-2 GA-9"], ...(many ? [11, 12, 13, 14, 15, 16].map((o): [number, string] => [o, "GA-1 GA-9"]) : [])];
  const project = `<?xml version="1.0"?><KNX xmlns="http://knx.org/xml/project/21"><Project Id="P-0001"><Installations>
<Installation InstallationId="0" Name="Main"><Topology><Area Address="1"><Line Address="1">
${device(1, "Kitchen actuator", 5, "M-TDL1", [[1, "GA-1 GA-9"], [2, "GA-8 GA-2"], [3, "GA-2"], [7, "GA-1 GA-9"]])}
${device(2, "Hall actuator", 6, "M-TDL2", [[1, "GA-1 GA-9"], [4, "GA-8 GA-2"]])}
${device(3, "Garage actuator", 7, "M-TDL3", garage)}
</Line></Area></Topology>
<GroupAddresses><GroupRanges><GroupRange Name="Main" RangeStart="0" RangeEnd="2047"><GroupRange Name="Mid" RangeStart="0" RangeEnd="255">
  <GroupAddress Id="P-0001-0_GA-1" Address="1" Name="Kitchen light"/><GroupAddress Id="P-0001-0_GA-2" Address="2" Name="Kitchen status"/><GroupAddress Id="P-0001-0_GA-3" Address="3" Name="Spare"/>
</GroupRange></GroupRange></GroupRanges></GroupAddresses></Installation></Installations></Project></KNX>`;
  return storeZip({
    "M-TDL1/Hardware.xml": droppedLinksHardware("M-TDL1"), "M-TDL1/M-TDL1_A-1.xml": droppedLinksApplication("M-TDL1"),
    "M-TDL2/Hardware.xml": droppedLinksHardware("M-TDL2"),
    "M-TDL3/Hardware.xml": droppedLinksHardware("M-TDL3"), "M-TDL3/M-TDL3_A-1.xml": droppedLinksRefusedApplication("M-TDL3"),
    "P-0001/0.xml": project,
  });
}
