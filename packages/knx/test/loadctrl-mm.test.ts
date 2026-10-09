import { test, expect, describe } from "bun:test";
import { declareAbsSegmentMM, declareTaskSegmentMM, lsmEvent, lsmState, STATE } from "../src/flash.ts";
import { runLoadPlan, differingRuns, type LoadPlan } from "../src/loadrunner.ts";
import { KnxDevice } from "../src/device.ts";

// Recording stub for the MEMORY-MAPPED LSM interface (MV-0700/0701). The load control is a
// memWrite to 0x0104 with the LSM index in byte[0]'s high nibble; the load status is a memRead
// from 46825+LsmIdx. The property path (propWrite/propRead PID 5) must NEVER be used here.
class MMDev {
  writes: { addr: number; hex: string; verify: boolean | undefined }[] = [];
  state = new Map<number, number>();
  async connect() {}
  async disconnect() {}
  async restart() {}
  async writesConfirmed() { return false; } // no PID_MAX_APDU_LENGTH: the classic write
  async memWrite(addr: number, data: Buffer, opts: { verify?: boolean } = {}) {
    this.writes.push({ addr, hex: data.toString("hex"), verify: opts.verify });
    if (addr === 0x0104) {
      const lsm = (data[0] >> 4) & 0x0f, event = data[0] & 0x0f;
      if (event === 1) this.state.set(lsm, STATE.LOADING);
      else if (event === 2) this.state.set(lsm, STATE.LOADED);
      else if (event === 4) this.state.set(lsm, STATE.UNLOADED);
      // event 3 (segment / task declaration) does not change the LSM state
    }
  }
  mem = new Map<number, number>();
  reads: { addr: number; len: number; chunk?: number }[] = [];
  async classicReadChunk() { return 12; }
  async memRead(addr: number, len: number, chunk?: number) {
    if (addr >= 46825 && addr < 46825 + 16) return Buffer.from([this.state.get(addr - 46825) ?? STATE.UNLOADED]);
    this.reads.push({ addr, len, chunk });
    return Buffer.from(Array.from({ length: len }, (_, i) => this.mem.get(addr + i) ?? 0));
  }
  async propWrite() { throw new Error("property (PID 5) path must not be used for a memory-mapped LSM"); }
  async propRead() { throw new Error("property (PID 5) path must not be used for a memory-mapped LSM"); }
}
const asDev = (d: MMDev) => d as unknown as KnxDevice;

describe("memory-mapped LSM controls (MV-0700/0701)", () => {
  // These byte layouts are hardware-validated on the ABB US/U 4.2 (MV-0701): the probe drove
  // LSM1 unload->load->AbsSegment(this)->write->TaskSegment(this)->LoadCompleted to LOADED.
  test("declareAbsSegmentMM byte layout", async () => {
    const d = new MMDev();
    await declareAbsSegmentMM(asDev(d), 1, 0, 0x4000, 511, 0xff, 3, 0);
    // (1<<4)|3, segType 0, segId 0, addr 0x4000, size 0x01ff, access 0xff, memType 3, segFlags 0, 0
    expect(d.writes).toEqual([{ addr: 0x0104, hex: "130000400001ffff030000", verify: false }]);
  });
  test("declareTaskSegmentMM byte layout carries the app identity", async () => {
    const d = new MMDev();
    await declareTaskSegmentMM(asDev(d), 1, 0x4000, 1, 0x0002, 0xa001, 0x13);
    // (1<<4)|3, seg 2, id 0, addr 0x4000, pei 1, manuf 0x0002, app 0xa001, ver 0x13
    expect(d.writes).toEqual([{ addr: 0x0104, hex: "1302004000010002a00113", verify: false }]);
  });
  test("a TaskCtrl1 to a memory-mapped LSM is the 0x0104 control ETS sends the Meteodata 140 S, checked LOADING", async () => {
    const d = new MMDev();
    await runLoadPlan(asDev(d), [{ op: "load", lsm: 3 }, { op: "taskCtrl1", lsm: 3, address: 18155, count: 1 }], { memMappedLsms: true });
    // captures/meteodata-140s-ets-fulldownload.log: MEM_WRITE 0x0104 33 04 00 46 EB 01 00 00 00 00 00
    expect(d.writes.at(-1)).toEqual({ addr: 0x0104, hex: "33040046eb010000000000", verify: false });
  });
  test("lsmEvent/lsmState memMapped use 0x0104 and 46825+lsm, never PID 5", async () => {
    const d = new MMDev();
    await lsmEvent(asDev(d), 2, 1, true); // Load LSM2
    expect(d.writes[0].addr).toBe(0x0104);
    expect(d.writes[0].hex).toBe("2100000000000000000000"); // (2<<4)|1 then 10 zero bytes
    expect(d.writes[0].verify).toBe(false);                 // 0x0104 is a control register, no read-back
    expect(await lsmState(asDev(d), 2, true)).toBe(STATE.LOADING);
  });
  test("runLoadPlan drives the absSegment/taskSegment bracket to LOADED over the memory-mapped transport", async () => {
    const d = new MMDev();
    const plan: LoadPlan = [
      { op: "unload", lsm: 1 },
      { op: "load", lsm: 1 },
      { op: "absSegment", lsm: 1, segType: 0, address: 0x4000, size: 511, access: 0xff, memType: 3, segFlags: 0 },
      { op: "writeMem", address: 0x4000, bytes: Buffer.from([1, 2, 3]) },
      { op: "taskSegment", lsm: 1, address: 0x4000, peiType: 1, manufacturer: 0x0002, appNumber: 0xa001, version: 0x13 },
      { op: "loadCompleted", lsm: 1 },
    ];
    await runLoadPlan(asDev(d), plan, { memMappedLsms: true });
    expect(d.state.get(1)).toBe(STATE.LOADED);
    // The segment data write is a normal read-back-verified absolute write, not a control write.
    const dataWrite = d.writes.find((w) => w.addr === 0x4000);
    expect(dataWrite?.verify).toBe(true);
  });
  test("a rejected absSegment declaration (LSM not LOADING) stops the bracket", async () => {
    // Simulate a device that refuses the load: its load control leaves the LSM in ERROR, so the
    // absSegment op's post-declare state check must throw instead of writing data into it.
    const d = new MMDev();
    d.memWrite = async (addr, data) => { if (addr === 0x0104 && (data[0] & 0x0f) === 1) d.state.set(1, STATE.ERROR); };
    const plan: LoadPlan = [
      { op: "load", lsm: 1, assert: false },
      { op: "absSegment", lsm: 1, segType: 0, address: 0x4000, size: 511, access: 0xff, memType: 3, segFlags: 0 },
    ];
    expect(runLoadPlan(asDev(d), plan, { memMappedLsms: true })).rejects.toThrow(/not LOADING/);
  });
});

// The PROPERTY-mapped LSM (MV-0705): a declaration marked `viaProperty` is a PID 5 write. Unmarked,
// it goes to 0x0104 as on every System 7 device before the captured applications (the MDT
// BE-02001.02 full download is hardware-proven that way).
class PropDev {
  props: string[] = [];
  mem: number[] = [];
  state = new Map<number, number>();
  stamp: Buffer = Buffer.from("0000001100f29876", "hex");
  async connect() {}
  async disconnect() {}
  async restart() {}
  async writesConfirmed() { return false; }
  async memWrite(addr: number) { this.mem.push(addr); }
  async memRead(_addr: number, len: number) { return Buffer.alloc(len); }
  async propWrite(obj: number, pid: number, data: Buffer) {
    this.props.push(`${obj}/${pid}=${data.toString("hex")}`);
    if (pid === 5 && data[0] !== 3) this.state.set(obj, ({ 1: STATE.LOADING, 2: STATE.LOADED, 4: STATE.UNLOADED } as Record<number, number>)[data[0]]);
    return Buffer.from([this.state.get(obj) ?? 0]);
  }
  async propRead(obj: number, pid: number) { return Buffer.from([pid === 5 ? this.state.get(obj) ?? 0 : 0]); }
  // Answers at most `elements` elements, each the stamp.
  elements = 15;
  async propReadCounted(obj: number, pid: number, start: number, count = 1) {
    this.props.push(`read ${obj}/${pid}#${start}${count > 1 ? `n${count}` : ""}`);
    const n = this.stamp.length ? Math.min(count, this.elements) : 0;
    return { objectIndex: obj, pid, count: n, start, value: Buffer.concat(Array.from({ length: n }, () => this.stamp)) };
  }
}

describe("property-mapped LSM controls (MV-0705)", () => {
  // The bytes ETS sends the Gira Tastsensor 3 Komfort (captures/gira-m0008-ets-fulldownload.log):
  // 1/5 = 03 00 4000 0011 F2 03 80 00 and 1/5 = 03 02 4000 00 0008 10D7 11.
  test("absSegment and taskSegment are PID 5 writes with ETS's layout, and the stamps are read", async () => {
    const d = new PropDev();
    const reads: string[] = [];
    await runLoadPlan(d as unknown as KnxDevice, [
      { op: "load", lsm: 1 },
      { op: "absSegment", lsm: 1, segType: 0, address: 0x4000, size: 17, access: 0xf2, memType: 3, segFlags: 0x80, viaProperty: true },
      { op: "writeMem", address: 0x4000, bytes: Buffer.from([8]) },
      { op: "taskSegment", lsm: 1, address: 0x4000, peiType: 0, manufacturer: 0x0008, appNumber: 0x10d7, version: 0x11, viaProperty: true },
      { op: "loadCompleted", lsm: 1 },
      { op: "readProp", obj: 1, pid: 27, start: 1 },
    ], { onRead: (o, p, s, v) => reads.push(`${o}/${p}#${s}=${v.toString("hex")}`) });
    expect(d.props).toEqual([
      "1/5=01000000000000000000", "1/5=030040000011f2038000", "1/5=0302400000000810d711", "1/5=02000000000000000000", "read 1/27#1",
    ]);
    expect(d.mem).toEqual([0x4000]);
    expect(reads).toEqual(["1/27#1=0000001100f29876"]);
  });
  test("unmarked, the same declarations go to the memory control 0x0104, as before the captured applications", async () => {
    const d = new PropDev();
    const mm: string[] = [];
    d.memWrite = async (addr: number, data?: Buffer) => { d.mem.push(addr); if (addr === 0x0104) mm.push(data!.toString("hex")); };
    await runLoadPlan(d as unknown as KnxDevice, [
      { op: "load", lsm: 1 },
      { op: "absSegment", lsm: 1, segType: 0, address: 0x4000, size: 17, access: 0xf2, memType: 3, segFlags: 0x80 },
      { op: "taskSegment", lsm: 1, address: 0x4000, peiType: 0, manufacturer: 0x0008, appNumber: 0x10d7, version: 0x11 },
      { op: "loadCompleted", lsm: 1 },
    ]);
    expect(d.props).toEqual(["1/5=01000000000000000000", "1/5=02000000000000000000"]);
    expect(mm).toEqual(["13000040000011f2038000", "130200400000000810d711"]);
    expect(d.mem).toEqual([0x0104, 0x0104]);
  });
  test("a property-marked declaration on memory-mapped LSMs is refused before anything is sent", async () => {
    const d = new MMDev();
    expect(await runLoadPlan(asDev(d), [{ op: "absSegment", lsm: 1, segType: 0, address: 0x4000, size: 17, access: 0xf2, memType: 3, segFlags: 0x80, viaProperty: true }], { memMappedLsms: true }).catch((e: unknown) => String(e))).toContain("memory-mapped");
    expect(d.writes).toEqual([]);
  });
  // The bytes ETS sends the Auro presence detector for LdCtrlTaskCtrl1 LsmIdx 3 Address 0 Count 0
  // (captures/auro-m0081-ets-fulldownload.log): 3/5 = 03 04 00000000 00000000, answered LOADING.
  test("taskCtrl1 is the PID 5 write of 03 04 and eight zero bytes, and the machine must stay LOADING", async () => {
    const d = new PropDev();
    await runLoadPlan(d as unknown as KnxDevice, [{ op: "load", lsm: 3 }, { op: "taskCtrl1", lsm: 3, address: 0, count: 0 }, { op: "loadCompleted", lsm: 3 }]);
    expect(d.props).toEqual(["3/5=01000000000000000000", "3/5=03040000000000000000", "3/5=02000000000000000000"]);
    expect(d.mem).toEqual([]);
  });
  // The TheLuxa P300's LdCtrlTaskCtrl1 LsmIdx 3 Address 17875 Count 1 (captures/theluxa-p300-ets-fulldownload.log):
  // 3/5 = 03 04 45D3 01 0000000000, answered LOADING.
  test("taskCtrl1 carries the address (2 bytes) and the count (1 byte) behind 03 04", async () => {
    const d = new PropDev();
    await runLoadPlan(d as unknown as KnxDevice, [{ op: "load", lsm: 3 }, { op: "taskCtrl1", lsm: 3, address: 17875, count: 1 }, { op: "loadCompleted", lsm: 3 }]);
    expect(d.props).toEqual(["3/5=01000000000000000000", "3/5=030445d3010000000000", "3/5=02000000000000000000"]);
  });
  test("a taskCtrl1 whose count needs more than one byte is refused before it is sent", async () => {
    const d = new PropDev();
    expect(await runLoadPlan(d as unknown as KnxDevice, [{ op: "load", lsm: 3 }, { op: "taskCtrl1", lsm: 3, address: 17875, count: 256 }]).catch((e: unknown) => String(e))).toContain("1-byte count");
    expect(d.props).toEqual(["3/5=01000000000000000000"]);
  });
  test("a taskCtrl1 the device answers with ERROR stops the bracket before LoadCompleted", async () => {
    const d = new PropDev();
    const write = d.propWrite.bind(d);
    d.propWrite = async (obj: number, pid: number, data: Buffer) => { const r = await write(obj, pid, data); if (data[0] === 3 && data[1] === 4) d.state.set(obj, STATE.ERROR); return r; };
    expect(await runLoadPlan(d as unknown as KnxDevice, [{ op: "load", lsm: 3 }, { op: "taskCtrl1", lsm: 3, address: 0, count: 0 }, { op: "loadCompleted", lsm: 3 }]).catch((e: unknown) => e))
      .toMatchObject({ code: "LOAD_STATE_UNEXPECTED" });
    expect(d.props).toEqual(["3/5=01000000000000000000", "3/5=03040000000000000000"]);
  });
  test("a taskCtrl1 a memory-mapped LSM does not answer LOADING stops the plan there", async () => {
    const d = new MMDev();
    expect(await runLoadPlan(asDev(d), [{ op: "taskCtrl1", lsm: 3, address: 18155, count: 1 }, { op: "loadCompleted", lsm: 3 }], { memMappedLsms: true }).catch((e: unknown) => e))
      .toMatchObject({ code: "LOAD_STATE_UNEXPECTED" });
    expect(d.writes.map((w) => w.hex)).toEqual(["33040046eb010000000000"]);
  });
  test("a stamp read of two elements is one request, and fails the plan when fewer come back", async () => {
    const d = new PropDev();
    const reads: string[] = [];
    await runLoadPlan(d as unknown as KnxDevice, [{ op: "readProp", obj: 4, pid: 27, start: 1, count: 2 }, { op: "restart" }], { onRead: (o, p, s, v) => reads.push(`${o}/${p}#${s}=${v.length}`) });
    expect(d.props).toEqual(["read 4/27#1n2"]);
    expect(reads).toEqual(["4/27#1=16"]);
    d.props = [];
    d.elements = 1;
    expect(await runLoadPlan(d as unknown as KnxDevice, [{ op: "readProp", obj: 4, pid: 27, start: 1, count: 2 }, { op: "restart" }]).catch((e: unknown) => e)).toMatchObject({ code: "PROPERTY_READ_EMPTY" });
  });
  test("a stamp read the device answers with no element fails the plan, after its restart", async () => {
    const d = new PropDev();
    d.stamp = Buffer.alloc(0);
    const restarts: number[] = [];
    d.restart = async () => { restarts.push(1); };
    expect(await runLoadPlan(d as unknown as KnxDevice, [{ op: "readProp", obj: 2, pid: 27, start: 1 }, { op: "restart" }]).catch((e: unknown) => e)).toMatchObject({ code: "PROPERTY_READ_EMPTY" });
    expect(restarts).toEqual([1]);
  });
});

describe("read-compare writes (memory-mapped System 7, as ETS writes them)", () => {
  test("per 12-byte block, the span from the first to the last differing byte, equal bytes inside included", () => {
    const want = Buffer.from("0114030a031e0001020000" + "c201000200000000000000", "hex");
    const have = Buffer.from("0814030a001e6800" + "00c201" + "c201000200000000000000", "hex");
    expect(differingRuns(0x6d01, want, have, 12).map((r) => [r.address.toString(16), r.bytes.toString("hex")])).toEqual([["6d01", "0114030a031e0001020000"]]);
    expect(differingRuns(0x6d01, want, want, 12)).toEqual([]);
    expect(differingRuns(0, Buffer.from([1, 2, 3, 4, 5]), Buffer.from([0, 2, 3, 4, 0]), 2).map((r) => [r.address, r.bytes.toString("hex")])).toEqual([[0, "01"], [4, "05"]]);
    expect(() => differingRuns(0, Buffer.alloc(3), Buffer.alloc(2), 12)).toThrow("partial read");
  });

  test("the runner reads each writeMem first in the device's read blocks and writes only those spans", async () => {
    const d = new MMDev();
    [0x01, 0x02, 0x03].forEach((b, i) => d.mem.set(0x4800 + i, b));
    await runLoadPlan(asDev(d), [{ op: "writeMem", address: 0x4800, bytes: Buffer.from([0x01, 0xaa, 0x03]) }], { memMappedLsms: true, readCompare: true });
    expect(d.reads).toEqual([{ addr: 0x4800, len: 3, chunk: 12 }]);
    expect(d.writes).toEqual([{ addr: 0x4801, hex: "aa", verify: true }]);
    const plain = new MMDev();
    await runLoadPlan(asDev(plain), [{ op: "writeMem", address: 0x4800, bytes: Buffer.from([0x01, 0xaa, 0x03]) }], { memMappedLsms: true });
    expect([plain.reads, plain.writes]).toEqual([[], [{ addr: 0x4800, hex: "01aa03", verify: true }]]);
  });
});
