import { test, expect, describe } from "bun:test";
import type { KnxDevice } from "../src/device.ts";
import { flashParameters, flashGroupTables, flashGroupTablesMv0705, appId, compareDeclaredProp, STATE } from "../src/flash.ts";
import { runLoadPlan, type LoadPlan, type LoadStep } from "../src/loadrunner.ts";

// Recording stub of KnxDevice (the ga-flash.test.ts asDev pattern): every call is
// appended to `calls` as a plain tuple so a whole procedure can be asserted as ONE
// hand-written call-order array. LSM state (propRead obj,5) follows the last load
// event written (LOAD->LOADING, LOAD_COMPLETED->LOADED, UNLOAD->UNLOADED, per the
// LSM state machine) unless a per-object answer queue injects a failure state.
type Call = Array<string | number | boolean | null>;
class RecDev {
  calls: Call[] = [];
  state = new Map<number, number>(); // tracked LSM state per object
  lsmQueue = new Map<number, number[]>(); // injected propRead(obj,5) answers, shifted first
  addrOf: Record<number, number> = { 1: 0x1000, 2: 0x2000, 3: 0x3000, 4: 0x4000 };
  async connect() { this.calls.push(["connect"]); }
  async disconnect() { this.calls.push(["disconnect"]); }
  async restart() { this.calls.push(["restart"]); }
  async tableAddr(obj: number) { this.calls.push(["tableAddr", obj]); return this.addrOf[obj]; }
  async memWrite(addr: number, data: Buffer, opts: { verify?: boolean } = {}) {
    this.calls.push(["memWrite", addr, data.toString("hex"), opts.verify ?? null]);
  }
  async propWrite(obj: number, pid: number, data: Buffer) {
    this.calls.push(["propWrite", obj, pid, data.toString("hex")]);
    if (pid === 5) { // track only real load events; the alloc payload (0x03 0x0b ...) is not a state change
      const e = data[0];
      if (e === 1) this.state.set(obj, STATE.LOADING);
      else if (e === 2) this.state.set(obj, STATE.LOADED);
      else if (e === 4) this.state.set(obj, STATE.UNLOADED);
    }
    return Buffer.alloc(0);
  }
  async propRead(obj: number, pid: number) {
    this.calls.push(["propRead", obj, pid]);
    const q = this.lsmQueue.get(obj);
    if (q && q.length) return Buffer.from([q.shift()!]);
    return Buffer.from([this.state.get(obj) ?? STATE.LOADED]);
  }
}
const asDev = (d: RecDev) => d as unknown as KnxDevice;

// LSM load-event payloads written to PID 5: 10 zero-padded bytes, first byte = event
// (flash.ts ev(); LOAD=1, LOAD_COMPLETED=2, UNLOAD=4).
const EV_LOAD = "01000000000000000000";
const EV_DONE = "02000000000000000000";
const EV_UNLD = "04000000000000000000";
// allocPayload(size): 0x03 0x0b (AdditionalLoadControls: allocate relative segment)
// + 4-byte big-endian size + mode 0 + fill 0, zero-padded to 10 bytes.
const alloc = (sizeBe8: string) => "030b" + sizeBe8 + "0000" + "0000";

describe("appId", () => {
  test("manufacturer(2) + appNumber(2) + version(1), big-endian", () => {
    // 0x0083 -> 00 83, 0x1234 -> 12 34, 0x21 -> 21
    expect(appId(0x0083, 0x1234, 0x21).toString("hex")).toBe("0083123421");
    // high bytes must not sign-extend or truncate: 0xffee -> ff ee, 0xbeef -> be ef, 0xff -> ff
    expect(appId(0xffee, 0xbeef, 0xff).toString("hex")).toBe("ffeebeefff");
  });
});

describe("flashParameters (System B bracket, LSM 4)", () => {
  test("exact call order: unload, load, alloc, write image, stamp id, load-completed, state check, restart", async () => {
    const dev = new RecDev();
    const image = Buffer.alloc(212, 0xab); // 212 = 0xd4 exercises a non-trivial size byte
    await flashParameters(asDev(dev), image, appId(0x0083, 0x1234, 0x21));
    expect(dev.calls).toEqual([
      ["propWrite", 4, 5, EV_UNLD],                    // UNLOAD the app segment first
      ["propWrite", 4, 5, EV_LOAD],                    // open the load state machine
      ["propWrite", 4, 5, alloc("000000d4")],          // allocate 212 bytes (0x000000d4 big-endian)
      ["tableAddr", 4],                                // segment base = PID 7 of LSM 4
      ["memWrite", 0x4000, "ab".repeat(212), null],    // image at the segment base, device-default verify
      ["propWrite", 4, 13, "0083123421"],              // PID 13 app-id stamp so LoadCompleted validates
      ["propWrite", 4, 5, EV_DONE],                    // LOAD_COMPLETED
      ["propRead", 4, 5],                              // read back the LSM state
      ["restart"],
    ]);
  });

  test("a non-LOADED state after load-completed aborts before restart", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(4, [STATE.ERROR]); // device refuses the load (e.g. app-id mismatch)
    await expect(flashParameters(asDev(dev), Buffer.alloc(4), appId(1, 2, 3))).rejects.toThrow(/not Loaded/);
    expect(dev.calls.some((c) => c[0] === "restart")).toBe(false); // no restart into a broken load
  });
});

describe("flashGroupTables (System B, LSMs 3/2/1)", () => {
  const tables = {
    comObj: Buffer.from("0102030405060708", "hex"), // 8 bytes
    addr: Buffer.from("1112131415", "hex"),         // 5 bytes
    assoc: Buffer.from("212223242526", "hex"),      // 6 bytes
  };

  test("exact call order: unload 3,2,1; load+alloc 3,1,2; write comObj,assoc,addr; complete 3,2,1; checks; restart", async () => {
    const dev = new RecDev();
    await flashGroupTables(asDev(dev), tables);
    expect(dev.calls).toEqual([
      ["propWrite", 3, 5, EV_UNLD],           // unload in dependency order com-obj -> assoc -> addr
      ["propWrite", 2, 5, EV_UNLD],
      ["propWrite", 1, 5, EV_UNLD],
      ["propWrite", 3, 5, EV_LOAD],           // load+alloc pairs in the coded order 3, 1, 2
      ["propWrite", 3, 5, alloc("00000008")], // comObj is 8 bytes
      ["propWrite", 1, 5, EV_LOAD],
      ["propWrite", 1, 5, alloc("00000005")], // addr is 5 bytes
      ["propWrite", 2, 5, EV_LOAD],
      ["propWrite", 2, 5, alloc("00000006")], // assoc is 6 bytes
      ["tableAddr", 3],
      ["memWrite", 0x3000, "0102030405060708", null],
      ["tableAddr", 2],
      ["memWrite", 0x2000, "212223242526", null],
      ["tableAddr", 1],
      ["memWrite", 0x1000, "1112131415", null],
      ["propWrite", 3, 5, EV_DONE],           // load-completed 3, 2, 1
      ["propWrite", 2, 5, EV_DONE],
      ["propWrite", 1, 5, EV_DONE],
      ["propRead", 3, 5],                     // all three LSMs must read back LOADED
      ["propRead", 2, 5],
      ["propRead", 1, 5],
      ["restart"],
    ]);
  });

  test("one LSM reading non-LOADED after load-completed rejects and skips restart", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(2, [STATE.ERROR]); // association-table LSM refuses
    await expect(flashGroupTables(asDev(dev), tables)).rejects.toThrow(/not Loaded/);
    expect(dev.calls.some((c) => c[0] === "restart")).toBe(false);
  });
});

describe("flashGroupTablesMv0705 (System 7, absolute tables)", () => {
  const tables = { addr: Buffer.from("1112131415", "hex"), assoc: Buffer.from("212223242526", "hex") };

  test("exact order: per LSM load -> LOADING check -> verified write -> completed -> LOADED check; addr(1) before assoc(2); no unload, no alloc", async () => {
    const dev = new RecDev();
    await flashGroupTablesMv0705(asDev(dev), tables);
    // Absolute segments: no relative-segment alloc and no unload appear anywhere,
    // and memWrite runs with verify:true (chunk-verified, per the hardware-proven path).
    expect(dev.calls).toEqual([
      ["propWrite", 1, 5, EV_LOAD],            // address table first
      ["propRead", 1, 5],                      // must observe LOADING
      ["tableAddr", 1],
      ["memWrite", 0x1000, "1112131415", true],
      ["propWrite", 1, 5, EV_DONE],
      ["propRead", 1, 5],                      // must observe LOADED
      ["propWrite", 2, 5, EV_LOAD],            // then association table
      ["propRead", 2, 5],
      ["tableAddr", 2],
      ["memWrite", 0x2000, "212223242526", true],
      ["propWrite", 2, 5, EV_DONE],
      ["propRead", 2, 5],
      ["restart"],
    ]);
  });

  test("rejects when LOAD is not answered with LOADING", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(1, [STATE.UNLOADED]); // device ignored the Load event
    await expect(flashGroupTablesMv0705(asDev(dev), tables)).rejects.toThrow(/not Loading/);
    // aborted before touching device memory
    expect(dev.calls.some((c) => c[0] === "memWrite")).toBe(false);
  });

  test("rejects when LOAD_COMPLETED is not answered with LOADED", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(1, [STATE.LOADING, STATE.LOADING]); // Load ok, but completion never lands
    await expect(flashGroupTablesMv0705(asDev(dev), tables)).rejects.toThrow(/not Loaded/);
    expect(dev.calls.some((c) => c[0] === "restart")).toBe(false);
  });
});

describe("runLoadPlan (generic load-procedure executor)", () => {
  test("drives every op type in plan order and reports each step via onStep", async () => {
    const dev = new RecDev();
    const plan: LoadPlan = [
      { op: "connect" },
      { op: "unload", lsm: 4 },
      { op: "load", lsm: 4 },
      { op: "alloc", lsm: 4, size: 0x1234 },
      { op: "writeMem", address: 0x4711, bytes: Buffer.from("cafe", "hex") },
      { op: "writeProp", obj: 0, pid: 0x53, data: Buffer.from("beef", "hex") },
      { op: "stampAppId", lsm: 4, data: appId(0x0083, 0x1234, 0x21) },
      { op: "loadCompleted", lsm: 4 },
      { op: "restart" },
      { op: "disconnect" },
    ];
    const steps: Array<[number, string, number]> = [];
    await runLoadPlan(asDev(dev), plan, { onStep: (i, s, total) => steps.push([i, s.op, total]) });
    expect(dev.calls).toEqual([
      ["connect"],
      ["propWrite", 4, 5, EV_UNLD],
      ["propWrite", 4, 5, EV_LOAD],
      ["propRead", 4, 5],                       // load asserts LOADING
      ["propWrite", 4, 5, alloc("00001234")],   // size 0x1234 big-endian in the alloc payload
      ["memWrite", 0x4711, "cafe", true],       // writeMem always verifies by read-back
      ["propWrite", 0, 0x53, "beef"],           // writeProp passes obj/pid/data through
      ["propWrite", 4, 13, "0083123421"],       // stampAppId = propWrite(lsm, 13, data)
      ["propWrite", 4, 5, EV_DONE],
      ["propRead", 4, 5],                       // loadCompleted asserts LOADED
      ["restart"],
      ["disconnect"],
    ]);
    // onStep fires once per step, before the step runs, with (index, step, total)
    expect(steps).toEqual(plan.map((s: LoadStep, i: number): [number, string, number] => [i, s.op, plan.length]));
  });

  test("load step names the actual state in its error", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(4, [STATE.ERROR]);
    await expect(runLoadPlan(asDev(dev), [{ op: "load", lsm: 4 }])).rejects.toThrow(/not LOADING after LOAD \(got ERROR\)/);
  });

  test("loadCompleted step rejects when the state is not LOADED", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(4, [STATE.LOADING]); // completion refused, machine stuck in LOADING
    await expect(runLoadPlan(asDev(dev), [{ op: "loadCompleted", lsm: 4 }])).rejects.toThrow(/not LOADED after LOAD_COMPLETED \(got LOADING\)/);
  });
});

describe("compareDeclaredProp (LdCtrlCompareProp)", () => {
  // Only propRead is used, so a one-method stub suffices.
  const devAnswering = (hex: string) => ({ propRead: async () => Buffer.from(hex, "hex") }) as unknown as KnxDevice;

  test("exact match is ok", async () => {
    const r = await compareDeclaredProp(devAnswering("0083123421"), 0, 78, Buffer.from("0083123421", "hex"));
    expect(r.ok).toBe(true);
  });

  test("device prefix of a zero-padded expectation is ok (ETS InlineData padding)", async () => {
    // ETS pads InlineData to a fixed width; the device returns the property's real
    // 6-byte element. The 4 trailing pad bytes are all zero, so this must pass.
    const r = await compareDeclaredProp(devAnswering("010203040506"), 0, 78, Buffer.from("01020304050600000000", "hex"));
    expect(r.ok).toBe(true);
  });

  test("prefix with a NON-zero expectation tail is a real mismatch", async () => {
    // Same 6-byte device value, but the expectation's tail carries a meaningful 0xff:
    // treating it as padding would silently drop a compared byte.
    const r = await compareDeclaredProp(devAnswering("010203040506"), 0, 78, Buffer.from("010203040506000000ff", "hex"));
    expect(r.ok).toBe(false);
  });

  test("plain mismatch is not ok and `got` carries the device value", async () => {
    const r = await compareDeclaredProp(devAnswering("aabb"), 0, 78, Buffer.from("aacc", "hex"));
    expect(r.ok).toBe(false);
    expect(r.got.toString("hex")).toBe("aabb");
  });

  test("device value longer than the expectation is not ok", async () => {
    // Padding tolerance only runs when the device value is SHORTER; a longer value
    // can never equal the expectation.
    const r = await compareDeclaredProp(devAnswering("aabbcc"), 0, 78, Buffer.from("aabb", "hex"));
    expect(r.ok).toBe(false);
  });
});
