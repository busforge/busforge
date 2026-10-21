import { test, expect, describe } from "bun:test";
import { STATE, gaToNum, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, classify, buildDeviceConfig, buildComObjectTable, buildGroupTables, type ComObjectLink } from "../src/index.ts";

// A System B application with two objects, whose tables take two group addresses and two associations
// (<AddressTable MaxEntries>, <AssociationTable MaxEntries>), against a unit holding its tables without a link.
const app = (capacity: string) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="M-0005_A-000A-01-0001" ApplicationNumber="10" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Capacity" LoadProcedureStyle="MergedProcedure">
<Static>
<Code><RelativeSegment Id="M-0005_A-000A-01-0001_RS-1" LoadStateMachine="4" Size="1"><Data>AA==</Data></RelativeSegment></Code>
<ParameterTypes><ParameterType Id="M-0005_A-000A-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType></ParameterTypes>
<Parameters><Parameter Id="M-0005_A-000A-01-0001_P-1" ParameterType="M-0005_A-000A-01-0001_PT-8" Text="Delay" Value="7"><Memory CodeSegment="M-0005_A-000A-01-0001_RS-1" Offset="0" BitOffset="0"/></Parameter></Parameters>
<ParameterRefs><ParameterRef Id="M-0005_A-000A-01-0001_P-1_R-1" RefId="M-0005_A-000A-01-0001_P-1"/></ParameterRefs>
<ComObjectTable><ComObject Id="M-0005_A-000A-01-0001_O-1" Number="1" Name="Out" Text="Out" ObjectSize="1 Bit" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/><ComObject Id="M-0005_A-000A-01-0001_O-2" Number="2" Name="In" Text="In" ObjectSize="1 Bit" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled"/></ComObjectTable>
<ComObjectRefs><ComObjectRef Id="M-0005_A-000A-01-0001_O-1_R-1" RefId="M-0005_A-000A-01-0001_O-1"/><ComObjectRef Id="M-0005_A-000A-01-0001_O-2_R-2" RefId="M-0005_A-000A-01-0001_O-2"/></ComObjectRefs>
${capacity}
<LoadProcedures><LoadProcedure MergeId="2"><LdCtrlRelSegment LsmIdx="4" Size="1" Mode="1" Fill="0" AppliesTo="full"/><LdCtrlRelSegment LsmIdx="4" Size="1" Mode="0" Fill="0" AppliesTo="par"/></LoadProcedure></LoadProcedures>
</Static>
<Dynamic><ParameterBlock Id="M-0005_A-000A-01-0001_PB-1" Name="Main" Text="Main"><ParameterRefRef RefId="M-0005_A-000A-01-0001_P-1_R-1"/><ComObjectRefRef RefId="M-0005_A-000A-01-0001_O-1_R-1"/><ComObjectRefRef RefId="M-0005_A-000A-01-0001_O-2_R-2"/></ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const CAPACITY = `<AddressTable MaxEntries="2"/><AssociationTable MaxEntries="2"/>`;
const at = (obj: number) => 0x100 * obj;

function unit(xml: string) {
  const cfg = parseAppConfig(xml);
  const view = buildDeviceConfig(cfg, new Map());
  const none = buildGroupTables([]);
  const mem = new Map<number, number>([[at(4), 7]]);
  for (const [a, b] of [[at(1), none.addr], [at(2), none.assoc], [at(3), buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set())]] as const) b.forEach((x, i) => mem.set(a + i, x));
  const writes: number[] = [];
  const dev = {
    connect: async () => {}, disconnect: async () => {}, deviceDescriptor: async () => "MV-07B0", restart: async () => {}, setVerifyMode: async () => {},
    writesConfirmed: async () => false, confirmedWrites: () => [], clearConfirmedWrites() {}, setExtendedMemoryServices() {}, acceptUnprovenRestart() {},
    tableAddr: async (o: number) => at(o),
    memRead: async (a: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => mem.get(a + i) ?? 0)),
    memWrite: async (a: number) => { writes.push(a); },
    propWrite: async (o: number) => { writes.push(-o); return Buffer.alloc(0); },
    propReadIfPresent: async () => null,
    propertyDescription: async (o: number, pid: number) => ({ objectIndex: o, pid, propertyIndex: 0, writable: true, pdt: 0x14, maxElements: 1, readLevel: 3, writeLevel: 3 }),
    propRead: async (o: number, pid: number) => (pid === 5 ? Buffer.from([STATE.LOADED]) : pid === 7 ? Buffer.from([0, 0, at(o) >> 8, at(o) & 0xff]) : Buffer.alloc(0)),
  };
  return { cfg, dev: dev as unknown as KnxDevice, writes };
}
const linksTo = (n: number): ComObjectLink[] => [{ comObjNum: 1, gaRaws: Array.from({ length: n }, (_, i) => gaToNum(`1/1/${i + 1}`)) }];
const ctx = (xml: string, links: ComObjectLink[], dryRun = true) => ({ deviceId: "d", ia: "1.1.9", appXml: xml, links, params: new Map<string, string>(), baseParams: new Map<string, string>(), dryRun, persistBackups: () => "b" });
const code = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as { code?: string }).code);

describe("a System B unit's tables take what its application declares", () => {
  const xml = app(CAPACITY);
  test("two group addresses fit: the group-address flash, the structural flash and the full download's plan take them", async () => {
    const { cfg, dev } = unit(xml);
    expect(await classify(cfg).flashGroupTables(dev, cfg.mask, ctx(xml, linksTo(2)))).toMatchObject({ kind: "dryRun" });
    expect(await classify(cfg).flashStructure(unit(xml).dev, cfg.mask, ctx(xml, linksTo(2)))).toMatchObject({ kind: "dryRun" });
    expect(classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.9", params: new Map(), links: linksTo(2), proc: parseLoadProcedures(xml) }).plan.length).toBeGreaterThan(0);
  });
  test("a third is refused by each of them before anything is written, dry run or not", async () => {
    for (const dryRun of [true, false]) {
      const g = unit(xml);
      expect(await code(classify(g.cfg).flashGroupTables(g.dev, g.cfg.mask, ctx(xml, linksTo(3), dryRun)))).toBe("GA_TABLE_TOO_LARGE");
      expect(g.writes).toEqual([]);
      const s = unit(xml);
      expect(await code(classify(s.cfg).flashStructure(s.dev, s.cfg.mask, ctx(xml, linksTo(3), dryRun)))).toBe("GA_TABLE_TOO_LARGE");
      expect(s.writes).toEqual([]);
      const f = unit(xml);
      expect(await code(classify(f.cfg).downloadFull(f.dev, f.cfg.mask, ctx(xml, linksTo(3), dryRun)))).toBe("GA_TABLE_TOO_LARGE");
      expect(f.writes).toEqual([]);
    }
    const { cfg } = unit(xml);
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.9", params: new Map(), links: linksTo(3), proc: parseLoadProcedures(xml) })).toThrow(expect.objectContaining({ code: "GA_TABLE_TOO_LARGE" }));
  });
  test("the associations are held to their own limit: two addresses on three associations are refused", async () => {
    const { cfg, dev, writes } = unit(xml);
    const links = [...linksTo(2), { comObjNum: 2, gaRaws: [gaToNum("1/1/1")] }];
    expect(buildGroupTables(links).assoc.readUInt16BE(0)).toBe(3);
    expect(buildGroupTables(links).addr.readUInt16BE(0)).toBe(2);
    expect(await code(classify(cfg).flashGroupTables(dev, cfg.mask, ctx(xml, links)))).toBe("GA_TABLE_TOO_LARGE");
    expect(writes).toEqual([]);
  });
  test("an application declaring no capacity has its tables refused, even empty ones", async () => {
    const bare = app("");
    const { cfg, dev, writes } = unit(bare);
    expect(await code(classify(cfg).flashGroupTables(dev, cfg.mask, ctx(bare, linksTo(1))))).toBe("GA_TABLE_CAPACITY_UNDECLARED");
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.9", params: new Map(), links: [], proc: parseLoadProcedures(bare) })).toThrow(expect.objectContaining({ code: "GA_TABLE_CAPACITY_UNDECLARED" }));
    expect(writes).toEqual([]);
  });
});
