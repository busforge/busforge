import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { KnxDevice, planMv0705GaFlash, runLoadPlan, readGroupTablesMv0705, LSM, STATE } from "@busforge/knx";
import { buildGroupTablesMv0705, decodeGroupTablesMv0705, parseAppConfig, type AppConfig, type ComObjectLink } from "@busforge/product";
import { System7Profile } from "../src/deviceprofile.ts";

// A REAL application program: flashGroupTables needs one, because it checks the links against the
// com-object table the device was last programmed with (an association onto an object the device's
// kept-from-device table does not configure is a link to nothing). Params and baseline are both
// empty in these tests, so that gate is a no-op and they exercise the write path as before.
const REAL = join(import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "real");
const realCfg = parseAppConfig(gunzipSync(readFileSync(join(REAL, "M-0081_A-FE01-11-75D9.xml.gz"))).toString("utf8"));
// Same application, with the device's declared table capacity overridden (the capacity cases).
const withCapacity = (addressMaxEntries: number | undefined, associationMaxEntries: number | undefined): AppConfig =>
  ({ ...realCfg, groupTables: addressMaxEntries === undefined ? undefined : { addressMaxEntries, associationMaxEntries } }) as AppConfig;

// Byte-addressed mock of the bus device, enough to drive the MV-0705 GA flash orchestration
// (LSM bracket via property 5, table addresses via property 7, memory read/write, restart).
// This covers the endpoint write path that was previously only exercised by a scratchpad.
class MockDevice {
  mem = new Map<number, number>();
  state = new Map<number, number>(); // LSM object -> STATE
  addrOf: Record<number, number> = { 1: 0x1000, 2: 0x2000, 3: 0x3000 };
  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return "MV-0705"; } // post-restart liveness probe (reconnectAfterRestart)
  async restart() {}
  async tableAddr(obj: number) { return this.addrOf[obj]; }
  async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0xff; return b; }
  async memWrite(addr: number, data: Buffer, opts: { verify?: boolean } = {}) {
    for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]);
    if (opts.verify) { const back = await this.memRead(addr, data.length); if (!back.equals(data)) throw new Error("verify mismatch"); }
  }
  async propRead(obj: number, pid: number) { if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.LOADED]); return Buffer.alloc(0); }
  async propWrite(obj: number, pid: number, data: Buffer) {
    if (pid === 5) { const ev = data[0]; this.state.set(obj, ev === LSM.LOAD ? STATE.LOADING : ev === LSM.LOAD_COMPLETED ? STATE.LOADED : STATE.UNLOADED); }
    return Buffer.alloc(0);
  }
  seedTables(addr: Buffer, assoc: Buffer) { addr.forEach((b, i) => this.mem.set(0x1000 + i, b)); assoc.forEach((b, i) => this.mem.set(0x2000 + i, b)); }
}
const asDev = (m: MockDevice) => m as unknown as KnxDevice;
const ia = (1 << 12) | (2 << 8) | 17; // 1.2.17

describe("MV-0705 GA flash orchestration (mock device)", () => {
  test("planMv0705GaFlash writes the built tables through the LSM bracket and round-trips", async () => {
    const links: ComObjectLink[] = [{ comObjNum: 1, gaRaws: [0x040b] }, { comObjNum: 5, gaRaws: [0x180a] }];
    const { addr, assoc } = buildGroupTablesMv0705(links, ia);
    const dev = new MockDevice();
    dev.seedTables(Buffer.from("0312110000", "hex"), Buffer.from("00", "hex")); // some prior table
    await runLoadPlan(asDev(dev), planMv0705GaFlash({ addr, assoc }));
    // exact bytes landed at the fixed table addresses
    expect((await dev.memRead(0x1000, addr.length)).equals(addr)).toBe(true);
    expect((await dev.memRead(0x2000, assoc.length)).equals(assoc)).toBe(true);
    // LSM 1 and 2 ended LOADED (bracket completed)
    expect(dev.state.get(1)).toBe(STATE.LOADED);
    expect(dev.state.get(2)).toBe(STATE.LOADED);
    // and the device reads back to the same links
    const back = await readGroupTablesMv0705(asDev(dev));
    expect(decodeGroupTablesMv0705(back.addr, back.assoc).sort((a, b) => a.comObjNum - b.comObjNum)).toEqual(links);
  });

  test("System7Profile.flashGroupTables programs a same-size re-point and reports verified", async () => {
    const orig: ComObjectLink[] = [{ comObjNum: 1, gaRaws: [0x040b] }, { comObjNum: 5, gaRaws: [0x180a] }];
    const dev = new MockDevice();
    const o = buildGroupTablesMv0705(orig, ia);
    dev.seedTables(o.addr, o.assoc);
    const repointed: ComObjectLink[] = [{ comObjNum: 1, gaRaws: [0x040c] }, { comObjNum: 5, gaRaws: [0x180a] }]; // same count
    const res = await new System7Profile("system-7", "MV-0705", withCapacity(undefined, undefined)).flashGroupTables(asDev(dev), "MV-0705", {
      deviceId: "d", ia: "1.2.17", links: repointed, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup",
    });
    expect(res.kind).toBe("flashed");
    expect(res.kind === "flashed" && res.verified).toBe(true);
    const built = buildGroupTablesMv0705(repointed, ia);
    expect((await dev.memRead(0x1000, built.addr.length)).equals(built.addr)).toBe(true);
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
      deviceId: "d", ia: "1.2.17", links: grownLinks, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup", // grow 1 -> 4, within 22
    });
    expect(res.kind).toBe("flashed");
    const built = buildGroupTablesMv0705(grownLinks, ia);
    expect((await dev.memRead(0x1000, built.addr.length)).equals(built.addr)).toBe(true); // the larger table was written
  });

  test("REFUSES growth BEYOND MaxEntries instead of overrunning the reserved segment", async () => {
    const dev = new MockDevice();
    const small = buildGroupTablesMv0705([{ comObjNum: 1, gaRaws: [0x040b] }], ia);
    dev.seedTables(small.addr, small.assoc);
    await expect(new System7Profile("system-7", "MV-0705", withCapacity(3, 3)).flashGroupTables(asDev(dev), "MV-0705", {
      deviceId: "d", ia: "1.2.17", links: grownLinks, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup", // 4 GAs > capacity 3
    })).rejects.toThrow(/GA_TABLE_TOO_LARGE|reserves only/);
    expect((await dev.memRead(0x1000, small.addr.length)).equals(small.addr)).toBe(true); // unchanged
  });

  test("without a declared capacity, falls back to refusing any growth (conservative)", async () => {
    const dev = new MockDevice();
    const small = buildGroupTablesMv0705([{ comObjNum: 1, gaRaws: [0x040b] }], ia);
    dev.seedTables(small.addr, small.assoc);
    await expect(new System7Profile("system-7", "MV-0705", withCapacity(undefined, undefined)).flashGroupTables(asDev(dev), "MV-0705", {
      deviceId: "d", ia: "1.2.17", links: grownLinks, params: new Map(), baseParams: new Map(), dryRun: false, persistBackups: () => "backup",
    })).rejects.toThrow(/reserves only/);
  });
});
