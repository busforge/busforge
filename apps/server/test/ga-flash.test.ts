import { test, expect, describe } from "bun:test";
import { KnxDevice, LSM, STATE } from "@busforge/knx";
import { buildGroupTablesMv0705, parseAppConfig, type AppConfig, type ComObjectLink } from "@busforge/product";
import { System7Profile } from "../src/deviceprofile.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// A REAL application program: flashGroupTables needs one, because it checks the links against the
// com-object table the device was last programmed with (an association onto an object the device's
// kept-from-device table does not configure is a link to nothing). Params and baseline are both
// empty in these tests, so that gate is a no-op and they exercise the write path as before.
// The second Auro application, M-0081_A-FF31: its group-address flash is the System 7 one every
// application with its own procedure runs (planSystem7GaFlash; the ETS comparisons are in
// packages/product/test/captured-system7.test.ts and tools/etsdiff.test.ts).
corpusDescribe("the GA flash against the real M-0081 application", () => {
  const realCfg = parseAppConfig(catalogueXml("M-0081_A-FF31-31-D6FF.xml.gz"));
  // Same application, with the device's declared table capacity overridden (the capacity cases).
  const withCapacity = (addressMaxEntries: number | undefined, associationMaxEntries: number | undefined): AppConfig =>
    ({ ...realCfg, groupTables: { ...realCfg.groupTables, addressMaxEntries, associationMaxEntries } }) as AppConfig;
  // The application's com-object table segment: the flash reads the device's table there and changes
  // only each object's linked bit (config byte 0x04).
  const comObjSeg = realCfg.absoluteSegments.find((s) => s.id === realCfg.groupTables.comObjectSegment)!;

  // Byte-addressed mock of the bus device, enough to drive the MV-0705 GA flash orchestration
  // (LSM bracket and segment declarations via property 5, table addresses via property 7, memory
  // read/write, restart). The tables sit in the segments the application declares for them.
  const segAddr = (id: string | undefined) => realCfg.absoluteSegments.find((s) => s.id === id)!.address;
  const ADDR = segAddr(realCfg.groupTables.addressSegment), ASSOC = segAddr(realCfg.groupTables.associationSegment);
  class MockDevice {
    mem = new Map<number, number>();
    state = new Map<number, number>(); // LSM object -> STATE
    addrOf: Record<number, number> = { 1: ADDR, 2: ASSOC, 3: comObjSeg.address };
    async connect() {}
    async disconnect() {}
    async deviceDescriptor() { return "MV-0705"; } // post-restart liveness probe (reconnectAfterRestart)
    async restart() {}
    async tableAddr(obj: number) { return this.addrOf[obj]; }
    async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0xff; return b; }
    async writesConfirmed() { return false; } // no PID_MAX_APDU_LENGTH: the classic write
    confirmedWrites() { return []; }
    clearConfirmedWrites() {}
    setExtendedMemoryServices() {}
    acceptUnprovenRestart() {}
    async memWrite(addr: number, data: Buffer, opts: { verify?: boolean } = {}) {
      for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]);
      if (opts.verify) { const back = await this.memRead(addr, data.length); if (!back.equals(data)) throw new Error("verify mismatch"); }
    }
    async propRead(obj: number, pid: number) { if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.LOADED]); return Buffer.alloc(0); }
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === 5 && data[0] === 3) { if (data[1] === 0) this.addrOf[obj] = data.readUInt16BE(2); return Buffer.alloc(0); } // a declaration: the machine stays LOADING
      if (pid === 5) { const ev = data[0]; this.state.set(obj, ev === LSM.LOAD ? STATE.LOADING : ev === LSM.LOAD_COMPLETED ? STATE.LOADED : STATE.UNLOADED); }
      return Buffer.alloc(0);
    }
    seedTables(addr: Buffer, assoc: Buffer) { addr.forEach((b, i) => this.mem.set(ADDR + i, b)); assoc.forEach((b, i) => this.mem.set(ASSOC + i, b)); }
    seedComObjTable(table: Buffer) { table.forEach((b, i) => this.mem.set(comObjSeg.address + i, b)); }
    constructor() { this.seedComObjTable(comObjSeg.data); } // the device holds a com-object table
  }
  const asDev = (m: MockDevice) => m as unknown as KnxDevice;
  const ia = (1 << 12) | (2 << 8) | 7; // 1.2.7

  describe("MV-0705 GA flash orchestration (mock device)", () => {
    test("System7Profile.flashGroupTables programs a same-size re-point and reports verified", async () => {
      const orig: ComObjectLink[] = [{ comObjNum: 1, gaRaws: [0x040b] }, { comObjNum: 5, gaRaws: [0x1107] }];
      const dev = new MockDevice();
      const o = buildGroupTablesMv0705(orig, ia);
      dev.seedTables(o.addr, o.assoc);
      const repointed: ComObjectLink[] = [{ comObjNum: 1, gaRaws: [0x040c] }, { comObjNum: 5, gaRaws: [0x1107] }]; // same count
      const res = await new System7Profile("system-7", "MV-0705", withCapacity(undefined, undefined)).flashGroupTables(asDev(dev), "MV-0705", {
        deviceId: "d", ia: "1.2.7", links: repointed, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup",
      });
      expect(res.kind).toBe("flashed");
      expect(res.kind === "flashed" && res.verified).toBe(true);
      const built = buildGroupTablesMv0705(repointed, ia);
      expect((await dev.memRead(ADDR, built.addr.length)).equals(built.addr)).toBe(true);
    });

    const grownLinks: ComObjectLink[] = [ // 4 GAs / 4 associations
      { comObjNum: 1, gaRaws: [0x040b] }, { comObjNum: 2, gaRaws: [0x040c] },
      { comObjNum: 3, gaRaws: [0x040d] }, { comObjNum: 4, gaRaws: [0x040e] },
    ];

    test("ADDS group addresses up to the device's declared MaxEntries capacity", async () => {
      const dev = new MockDevice();
      const small = buildGroupTablesMv0705([{ comObjNum: 1, gaRaws: [0x040b] }], ia); // 1 GA today
      dev.seedTables(small.addr, small.assoc);
      const res = await new System7Profile("system-7", "MV-0705", withCapacity(22, 22)).flashGroupTables(asDev(dev), "MV-0705", {
        deviceId: "d", ia: "1.2.7", links: grownLinks, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup", // grow 1 -> 4, within 22
      });
      expect(res.kind).toBe("flashed");
      const built = buildGroupTablesMv0705(grownLinks, ia);
      expect((await dev.memRead(ADDR, built.addr.length)).equals(built.addr)).toBe(true); // the larger table was written
    });

    test("REFUSES growth BEYOND MaxEntries instead of overrunning the reserved segment", async () => {
      const dev = new MockDevice();
      const small = buildGroupTablesMv0705([{ comObjNum: 1, gaRaws: [0x040b] }], ia);
      dev.seedTables(small.addr, small.assoc);
      expect(new System7Profile("system-7", "MV-0705", withCapacity(3, 3)).flashGroupTables(asDev(dev), "MV-0705", {
        deviceId: "d", ia: "1.2.7", links: grownLinks, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup", // 4 GAs > capacity 3
      })).rejects.toThrow(/GA_TABLE_TOO_LARGE|reserves only/);
      expect((await dev.memRead(ADDR, small.addr.length)).equals(small.addr)).toBe(true); // unchanged
    });

    test("without a declared capacity, falls back to refusing any growth (conservative)", async () => {
      const dev = new MockDevice();
      const small = buildGroupTablesMv0705([{ comObjNum: 1, gaRaws: [0x040b] }], ia);
      dev.seedTables(small.addr, small.assoc);
      expect(new System7Profile("system-7", "MV-0705", withCapacity(undefined, undefined)).flashGroupTables(asDev(dev), "MV-0705", {
        deviceId: "d", ia: "1.2.7", links: grownLinks, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup",
      })).rejects.toThrow(/reserves only/);
    });

    test("changes only the linked bit of the device's com-object table, and verifies it", async () => {
      const dev = new MockDevice();
      const o = buildGroupTablesMv0705([], ia);
      dev.seedTables(o.addr, o.assoc);
      const held = Buffer.from(comObjSeg.data);
      held[3 + 1 * 4 + 2] |= 0x04; // object 1 held as linked, its link is being removed
      dev.seedComObjTable(held);
      const res = await new System7Profile("system-7", "MV-0705", realCfg).flashGroupTables(asDev(dev), "MV-0705", {
        deviceId: "d", ia: "1.2.7", links: [{ comObjNum: 0, gaRaws: [0x040b] }], params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup",
      });
      expect(res.kind === "flashed" && res.verified).toBe(true);
      const back = await dev.memRead(comObjSeg.address, held.length);
      const want = Buffer.from(held); // every config byte keeps all but its linked bit, which follows the links
      for (let n = 0; n < held[0]; n++) want[3 + n * 4 + 2] = n === 0 ? held[3 + n * 4 + 2] | 0x04 : held[3 + n * 4 + 2] & ~0x04;
      expect(back.equals(want)).toBe(true);
    });

    test("REFUSES a memory-mapped device whose application names no com-object table, writing nothing", async () => {
      const dev = new MockDevice();
      const o = buildGroupTablesMv0705([], ia);
      dev.seedTables(o.addr, o.assoc);
      const noSeg = { ...realCfg, groupTables: { ...realCfg.groupTables, comObjectSegment: undefined } } as AppConfig;
      const before = new Map(dev.mem);
      expect(new System7Profile("system-7", "MV-0701", noSeg).flashGroupTables(asDev(dev), "MV-0701", {
        deviceId: "d", ia: "1.2.7", links: [{ comObjNum: 0, gaRaws: [0x040b] }], params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup",
      })).rejects.toThrow(/FULL_DOWNLOAD_TABLE_SEGMENT_MISSING|names no com-object table/);
      expect(dev.mem).toEqual(before);
    });
  });
});
