import { test, expect, describe } from "bun:test";
import { declareAbsSegmentMM, declareTaskSegmentMM, lsmEvent, lsmState, STATE } from "../src/flash.ts";
import { runLoadPlan, type LoadPlan } from "../src/loadrunner.ts";
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
  async memRead(addr: number, len: number) {
    if (addr >= 46825 && addr < 46825 + 16) return Buffer.from([this.state.get(addr - 46825) ?? STATE.UNLOADED]);
    return Buffer.alloc(len);
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
