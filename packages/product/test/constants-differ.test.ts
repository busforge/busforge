import { test, expect, describe } from "bun:test";
import { STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, buildDeviceConfig, buildComObjectTable, buildGroupTables, type FlashResult } from "../src/index.ts";

// A System B application with a parameter (offset 0) and a constant Access="None" download marker
// (offset 1, $AA, deviceimage.ts constantParams), against a unit that holds the parameter and has
// cleared the marker. The flashes compare, find no change, and name the marker in their result.
const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="M-0005_A-0009-01-0001" ApplicationNumber="9" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Marker" LoadProcedureStyle="MergedProcedure">
<Static>
<Code><RelativeSegment Id="M-0005_A-0009-01-0001_RS-1" LoadStateMachine="4" Size="2"><Data>AAA=</Data></RelativeSegment></Code>
<ParameterTypes><ParameterType Id="M-0005_A-0009-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters>
<Parameter Id="M-0005_A-0009-01-0001_P-1" ParameterType="M-0005_A-0009-01-0001_PT-8" Text="Delay" Value="7"><Memory CodeSegment="M-0005_A-0009-01-0001_RS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0005_A-0009-01-0001_P-2" ParameterType="M-0005_A-0009-01-0001_PT-8" Access="None" Text="Download marker" Value="170"><Memory CodeSegment="M-0005_A-0009-01-0001_RS-1" Offset="1" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs><ParameterRef Id="M-0005_A-0009-01-0001_P-1_R-1" RefId="M-0005_A-0009-01-0001_P-1"/><ParameterRef Id="M-0005_A-0009-01-0001_P-2_R-2" RefId="M-0005_A-0009-01-0001_P-2"/></ParameterRefs>
<ComObjectTable><ComObject Id="M-0005_A-0009-01-0001_O-1" Number="1" Name="Out" Text="Out" ObjectSize="1 Bit" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/></ComObjectTable>
<ComObjectRefs><ComObjectRef Id="M-0005_A-0009-01-0001_O-1_R-1" RefId="M-0005_A-0009-01-0001_O-1"/></ComObjectRefs>
<AddressTable MaxEntries="16"/><AssociationTable MaxEntries="16"/>
<LoadProcedures><LoadProcedure MergeId="2"><LdCtrlRelSegment LsmIdx="4" Size="2" Mode="0" Fill="0" AppliesTo="full,par"/></LoadProcedure></LoadProcedures>
</Static>
<Dynamic><ParameterBlock Id="M-0005_A-0009-01-0001_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="M-0005_A-0009-01-0001_P-1_R-1"/><ParameterRefRef RefId="M-0005_A-0009-01-0001_P-2_R-2"/><ComObjectRefRef RefId="M-0005_A-0009-01-0001_O-1_R-1"/></ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const cfg = parseAppConfig(xml);
const BASE = 0x4000;
const at = (obj: number) => (obj === 4 ? BASE : 0x100 * obj);

// The unit's group tables and com-object table as this configuration builds them, no link.
const view = buildDeviceConfig(cfg, new Map());
const tables = buildGroupTables([]);
const TABLES: [number, Buffer][] = [[at(1), tables.addr], [at(2), tables.assoc], [at(3), buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set())]];

function unit(bytes: number[]) {
  const mem = new Map<number, number>(bytes.map((b, i) => [BASE + i, b]));
  for (const [a, b] of TABLES) b.forEach((x, i) => mem.set(a + i, x));
  const writes: number[] = [];
  const dev = {
    connect: async () => {}, disconnect: async () => {}, deviceDescriptor: async () => "MV-07B0", restart: async () => {}, setVerifyMode: async () => {},
    writesConfirmed: async () => false, confirmedWrites: () => [], clearConfirmedWrites() {}, setExtendedMemoryServices() {}, acceptUnprovenRestart() {},
    tableAddr: async (o: number) => at(o),
    memRead: async (a: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0)),
    memWrite: async (a: number) => { writes.push(a); },
    propReadIfPresent: async () => null,
    // The association table described as the long form (PDT_GENERIC_04), as the tables this unit holds.
    propertyDescription: async (o: number, pid: number) => ({ objectIndex: o, pid, propertyIndex: 0, writable: true, pdt: 0x14, maxElements: 1, readLevel: 3, writeLevel: 3 }),
    propRead: async (o: number, pid: number) => (pid === 5 ? Buffer.from([STATE.LOADED]) : pid === 7 ? Buffer.from([0, 0, at(o) >> 8, at(o) & 0xff]) : Buffer.alloc(0)),
  };
  return { dev: dev as unknown as KnxDevice, writes };
}
const ctx = { deviceId: "d", appXml: xml, params: new Map<string, string>(), baseParams: new Map<string, string>(), dryRun: true, persistBackups: () => "b" };
const MARKER = [{ paramRefId: "M-0005_A-0009-01-0001_P-2_R-2", label: "Download marker" }];

describe("a System B unit that differs only in a constant parameter", () => {
  test("the parameter flash is unchanged, writes nothing and names the marker", async () => {
    const { dev, writes } = unit([7, 0x00]);
    const r: FlashResult = await classify(cfg).flashParameters(dev, cfg.mask, ctx);
    expect(r).toMatchObject({ kind: "unchanged", constantsDiffer: MARKER });
    expect(writes).toEqual([]);
  });

  test("with the marker as written, nothing is named; with another change, it is a change", async () => {
    expect(await classify(cfg).flashParameters(unit([7, 0xaa]).dev, cfg.mask, ctx)).not.toHaveProperty("constantsDiffer");
    expect(await classify(cfg).flashParameters(unit([6, 0x00]).dev, cfg.mask, ctx)).toMatchObject({ kind: "dryRun", diffBytes: 1 });
  });

  test("the structural flash is unchanged and names the marker", async () => {
    const { dev, writes } = unit([7, 0x00]);
    const r = await classify(cfg).flashStructure(dev, cfg.mask, { ...ctx, ia: "1.1.9", links: [] });
    expect(r).toMatchObject({ kind: "unchanged", constantsDiffer: MARKER });
    expect(writes).toEqual([]);
  });
});
