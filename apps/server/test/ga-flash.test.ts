import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnxDevice, flashGroupTablesMv0705, LSM, STATE } from "@busforge/knx";
import { buildGroupTablesMv0705, decodeGroupTablesMv0705, type ComObjectLink } from "@busforge/product";
import { System7Profile, readGroupTablesMv0705 } from "../src/deviceprofile.ts";

// Byte-addressed mock of the bus device, enough to drive the MV-0705 GA flash orchestration
// (LSM bracket via property 5, table addresses via property 7, memory read/write, restart).
// This covers the endpoint write path that was previously only exercised by a scratchpad.
class MockDevice {
  mem = new Map<number, number>();
  state = new Map<number, number>(); // LSM object -> STATE
  addrOf: Record<number, number> = { 1: 0x1000, 2: 0x2000, 3: 0x3000 };
  async connect() {}
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
  test("flashGroupTablesMv0705 writes the built tables through the LSM bracket and round-trips", async () => {
    const links: ComObjectLink[] = [{ comObjNum: 1, gaRaws: [0x040b] }, { comObjNum: 5, gaRaws: [0x180a] }];
    const { addr, assoc } = buildGroupTablesMv0705(links, ia);
    const dev = new MockDevice();
    dev.seedTables(Buffer.from("0312110000", "hex"), Buffer.from("00", "hex")); // some prior table
    await flashGroupTablesMv0705(asDev(dev), { addr, assoc });
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
    const dataDir = mkdtempSync(join(tmpdir(), "ga-flash-"));
    const res = await new System7Profile("system-7", "MV-0705", null).flashGroupTables(asDev(dev), "MV-0705", {
      projectId: "p", deviceId: "d", ia: "1.2.17", links: repointed, dataDir, dryRun: false,
    });
    expect(res.flashed).toBe(true);
    expect(res.verified).toBe(true);
    const built = buildGroupTablesMv0705(repointed, ia);
    expect((await dev.memRead(0x1000, built.addr.length)).equals(built.addr)).toBe(true);
  });

  test("System7Profile.flashGroupTables REFUSES growth (adding GAs) instead of overflowing fixed tables", async () => {
    const dev = new MockDevice();
    const small = buildGroupTablesMv0705([{ comObjNum: 1, gaRaws: [0x040b] }], ia); // 1 GA
    dev.seedTables(small.addr, small.assoc);
    const grown: ComObjectLink[] = [ // 4 GAs -> larger tables than the device holds
      { comObjNum: 1, gaRaws: [0x040b] }, { comObjNum: 2, gaRaws: [0x040c] },
      { comObjNum: 3, gaRaws: [0x040d] }, { comObjNum: 4, gaRaws: [0x040e] },
    ];
    const dataDir = mkdtempSync(join(tmpdir(), "ga-flash-"));
    const profile = new System7Profile("system-7", "MV-0705", null);
    await expect(profile.flashGroupTables(asDev(dev), "MV-0705", {
      projectId: "p", deviceId: "d", ia: "1.2.17", links: grown, dataDir, dryRun: false,
    })).rejects.toThrow(/GA_TABLE_TOO_LARGE|larger than the device/);
    // and nothing was written (the guard fires before any memWrite to the tables)
    expect((await dev.memRead(0x1000, small.addr.length)).equals(small.addr)).toBe(true);
  });
});
