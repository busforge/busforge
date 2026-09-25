import { test, expect, describe } from "bun:test";
import { planSystemBGaFlash, planSystemBFullDownload, planMv0705GaFlash, appId, compareDeclaredProp, crc16Ccitt, crc16CcittFalse, sparseRuns, STATE } from "../src/flash.ts";
import { KnxDevice, ERASE, RESTART_MASTER } from "../src/device.ts";
import { runLoadPlan, type LoadPlan, type LoadStep } from "../src/loadrunner.ts";
import { KnxError } from "../src/errors.ts";

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
  writeFailAt: number | null = null;   // 1-based memWrite index to throw on (simulates a transport error or a read-back verify mismatch mid-download)
  writeFailMsg = "memWrite verify mismatch";
  private writeCount = 0;
  async connect() { this.calls.push(["connect"]); }
  async disconnect() { this.calls.push(["disconnect"]); }
  async restart() { this.calls.push(["restart"]); }
  async tableAddr(obj: number) { this.calls.push(["tableAddr", obj]); return this.addrOf[obj]; }
  async memWrite(addr: number, data: Buffer, opts: { verify?: boolean } = {}) {
    this.writeCount++;
    this.calls.push(["memWrite", addr, data.toString("hex"), opts.verify ?? null]);
    if (this.writeFailAt !== null && this.writeCount === this.writeFailAt) throw new Error(this.writeFailMsg);
  }
  async propWrite(obj: number, pid: number, data: Buffer) {
    this.calls.push(["propWrite", obj, pid, data.toString("hex")]);
    if (pid === 5) { // track only real load events; the alloc payload (0x03 0x0b ...) is not a state change
      const e = data[0];
      if (e === 1) this.state.set(obj, STATE.LOADING);
      else if (e === 2) this.state.set(obj, STATE.LOADED);
      else if (e === 4) this.state.set(obj, STATE.UNLOADED);
    }
    return Buffer.from(data); // a device echoes the value it stored
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

describe("the System B par bracket, engine-driven (planRelativeParFlash + runLoadPlan)", () => {
  // The relative planner lives in @busforge/product; this test locks that the planned
  // steps reproduce the RETIRED hardcoded executor's hardware-proven call order
  // (M-0162 byte-match) exactly, with ONE deliberate, documented delta: the
  // engine asserts LOADING after Load (an extra propRead), as it always did for the
  // absolute path. Standard LSM behavior, now hardware-smoked on a System B device: a
  // module-instance param change was flashed + restored, byte-checked, on the Theben
  // HMG through this engine bracket (see docs/load-procedures.md).
  const relativePlan = (lsm: number, image: Buffer, id: Buffer): LoadPlan => [
    { op: "unload", lsm },
    { op: "load", lsm },
    { op: "alloc", lsm, size: image.length },
    { op: "writeSegment", lsm, bytes: image },
    { op: "stampAppId", lsm, data: id },
    { op: "loadCompleted", lsm },
    { op: "restart" },
  ];

  // (The planner-shape lock, planRelativeParFlash === this bracket, lives in
  // packages/product/test/loadplan.test.ts: knx must not depend on product.)

  test("exact device call order: unload, load(+LOADING assert), alloc, write image, stamp id, load-completed(+LOADED assert), restart", async () => {
    const dev = new RecDev();
    const image = Buffer.alloc(212, 0xab); // 212 = 0xd4 exercises a non-trivial size byte
    await runLoadPlan(asDev(dev), relativePlan(4, image, appId(0x0083, 0x1234, 0x21)));
    expect(dev.calls).toEqual([
      ["propWrite", 4, 5, EV_UNLD],                    // UNLOAD the app segment first
      ["propWrite", 4, 5, EV_LOAD],                    // open the load state machine
      ["propRead", 4, 5],                              // engine asserts LOADING (the documented delta)
      ["propWrite", 4, 5, alloc("000000d4")],          // allocate 212 bytes (0x000000d4 big-endian)
      ["tableAddr", 4],                                // segment base = PID 7 of LSM 4, resolved at execution
      ["memWrite", 0x4000, "ab".repeat(212), true],    // image at the segment base, read-back verified (same as the retired executor's memWrite default)
      ["propWrite", 4, 13, "0083123421"],              // PID 13 app-id stamp so LoadCompleted validates
      ["propWrite", 4, 5, EV_DONE],                    // LOAD_COMPLETED
      ["propRead", 4, 5],                              // engine asserts LOADED
      ["restart"],
    ]);
  });

  test("a non-LOADED state after load-completed aborts before restart", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(4, [STATE.LOADING, STATE.ERROR]); // Load ok, completion refused (e.g. app-id mismatch)
    expect(runLoadPlan(asDev(dev), relativePlan(4, Buffer.alloc(4), appId(1, 2, 3)))).rejects.toThrow(/not LOADED/);
    expect(dev.calls.some((c) => c[0] === "restart")).toBe(false); // no restart into a broken load
  });

  test("a refused Load aborts BEFORE any alloc or write (the new safety property of the assert)", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(4, [STATE.UNLOADED]); // device ignored the Load event
    expect(runLoadPlan(asDev(dev), relativePlan(4, Buffer.alloc(4), appId(1, 2, 3)))).rejects.toThrow(/not LOADING/);
    expect(dev.calls.some((c) => c[0] === "memWrite")).toBe(false);
    expect(dev.calls.filter((c) => c[0] === "propWrite" && c[2] === 5).length).toBe(2); // unload + load only, no alloc
  });
});

describe("the System B GA bracket, engine-driven (planSystemBGaFlash + runLoadPlan)", () => {
  const tables = {
    comObj: Buffer.from("0102030405060708", "hex"), // 8 bytes
    addr: Buffer.from("1112131415", "hex"),         // 5 bytes
    assoc: Buffer.from("212223242526", "hex"),      // 6 bytes
  };

  test("planSystemBGaFlash emits the legacy bracket: unasserted loads, verified writes, batch LOADED check", () => {
    // Byte-for-byte the retired flashGroupTables() order. The loads/completions carry
    // assert:false (no inline state read); the three tables are checked LOADED in one batch
    // (assertLoaded) at the end, exactly as the hardware-proven path did. Writes are
    // read-back verified (the retired memWrite call verified by default), so writeSegment
    // carries no opt-out.
    expect(planSystemBGaFlash(tables)).toEqual([
      { op: "unload", lsm: 3 }, { op: "unload", lsm: 2 }, { op: "unload", lsm: 1 },
      { op: "load", lsm: 3, assert: false }, { op: "alloc", lsm: 3, size: 8 },
      { op: "load", lsm: 1, assert: false }, { op: "alloc", lsm: 1, size: 5 },
      { op: "load", lsm: 2, assert: false }, { op: "alloc", lsm: 2, size: 6 },
      { op: "writeSegment", lsm: 3, bytes: tables.comObj },
      { op: "writeSegment", lsm: 2, bytes: tables.assoc },
      { op: "writeSegment", lsm: 1, bytes: tables.addr },
      { op: "loadCompleted", lsm: 3, assert: false },
      { op: "loadCompleted", lsm: 2, assert: false },
      { op: "loadCompleted", lsm: 1, assert: false },
      { op: "assertLoaded", lsm: 3 }, { op: "assertLoaded", lsm: 2 }, { op: "assertLoaded", lsm: 1 },
      { op: "restart", requireReboot: true }, // default: strict, unless the caller opts out for a persist-at-LoadCompleted device
    ]);
  });

  test("holdApplication brackets the application object around the table rewrite, touching none of its memory", () => {
    // Unloading a table underneath a running application invalidates it on some System B stacks: on the
    // Jung 400021SE (Insta) a table-only GA flash leaves all three tables LOADED and byte-perfect while
    // object 4 drops to ERROR and the device communicates on nothing. The bracket opens object 4 BEFORE
    // the unloads and closes it AFTER the tables are in place, re-stamping the program id so its
    // LoadCompleted revalidates; hardware-proven to keep the object LOADED and the re-pointed link live.
    const plan = planSystemBGaFlash(tables, true, true);
    expect(plan[0]).toEqual({ op: "load", lsm: 4, assert: false }); // opened FIRST, before any unload
    const appCompleted = plan.findIndex((s) => s.op === "loadCompleted" && s.lsm === 4);
    const appChecked = plan.findIndex((s) => s.op === "assertLoaded" && s.lsm === 4);
    const lastTableComplete = plan.map((s) => s.op === "loadCompleted" && s.lsm !== 4).lastIndexOf(true);
    // Closed only after every table bracket has closed, and checked only after it is closed.
    expect(appCompleted).toBeGreaterThan(lastTableComplete);
    expect(appChecked).toBeGreaterThan(appCompleted);
    // The application's memory is never touched: no unload (that frees the parameter image), no alloc,
    // no write, and no program-id re-stamp (the device keeps the identity it was commissioned with).
    expect(plan.some((s) => s.op === "unload" && s.lsm === 4)).toBe(false);
    expect(plan.some((s) => (s.op === "alloc" || s.op === "writeSegment" || s.op === "stampAppId") && s.lsm === 4)).toBe(false);
    // Not held: byte-for-byte the table-only bracket, no application steps at all.
    expect(planSystemBGaFlash(tables).some((s) => "lsm" in s && s.lsm === 4)).toBe(false);
  });

  test("requireReboot=false opts the closing restart out of the reboot proof (persist-at-LoadCompleted device, e.g. GVS AMMA)", () => {
    // Only the restart step changes; a device that persists its tables at LoadCompleted and does
    // not reboot in answer to A_Restart must not be rejected as RESTART_IGNORED. The caller passes
    // this via !persistsOnLoadCompleted(cfg), mirroring the parameter-flash and full-download paths.
    const plan = planSystemBGaFlash(tables, false);
    expect(plan[plan.length - 1]).toEqual({ op: "restart", requireReboot: false });
  });

  test("exact device call order: unload 3,2,1; load+alloc 3,1,2; write comObj,assoc,addr; complete 3,2,1; batch checks; restart", async () => {
    const dev = new RecDev();
    await runLoadPlan(asDev(dev), planSystemBGaFlash(tables));
    // Identical wire to the retired executor: same op order, and the writes verify by
    // read-back (memWrite verify:true) exactly as the old no-opts memWrite did (default
    // verify ?? true). assert:false suppresses the inline LOADING/LOADED reads; the batch
    // assertLoaded at the end does them, matching the retired executor.
    expect(dev.calls).toEqual([
      ["propWrite", 3, 5, EV_UNLD],           // unload in dependency order com-obj -> assoc -> addr
      ["propWrite", 2, 5, EV_UNLD],
      ["propWrite", 1, 5, EV_UNLD],
      ["propWrite", 3, 5, EV_LOAD],           // load+alloc pairs in the coded order 3, 1, 2 (no LOADING read: assert:false)
      ["propWrite", 3, 5, alloc("00000008")], // comObj is 8 bytes
      ["propWrite", 1, 5, EV_LOAD],
      ["propWrite", 1, 5, alloc("00000005")], // addr is 5 bytes
      ["propWrite", 2, 5, EV_LOAD],
      ["propWrite", 2, 5, alloc("00000006")], // assoc is 6 bytes
      ["tableAddr", 3],
      ["memWrite", 0x3000, "0102030405060708", true], // read-back verified, as the legacy path wrote
      ["tableAddr", 2],
      ["memWrite", 0x2000, "212223242526", true],
      ["tableAddr", 1],
      ["memWrite", 0x1000, "1112131415", true],
      ["propWrite", 3, 5, EV_DONE],           // load-completed 3, 2, 1 (no LOADED read: assert:false)
      ["propWrite", 2, 5, EV_DONE],
      ["propWrite", 1, 5, EV_DONE],
      ["propRead", 3, 5],                     // batch: all three LSMs must read back LOADED (assertLoaded)
      ["propRead", 2, 5],
      ["propRead", 1, 5],
      ["restart"],
    ]);
  });

  test("one LSM reading non-LOADED at the batch check rejects and skips restart", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(2, [STATE.ERROR]); // association-table LSM refuses at the batch assertLoaded
    expect(runLoadPlan(asDev(dev), planSystemBGaFlash(tables))).rejects.toThrow(/not LOADED/);
    expect(dev.calls.some((c) => c[0] === "restart")).toBe(false);
  });
});

describe("the System 7 GA bracket, engine-driven (planMv0705GaFlash + runLoadPlan)", () => {
  const tables = { addr: Buffer.from("1112131415", "hex"), assoc: Buffer.from("212223242526", "hex") };

  test("planMv0705GaFlash emits the asserting absolute bracket: no unload, no alloc, verified writes", () => {
    expect(planMv0705GaFlash(tables)).toEqual([
      { op: "load", lsm: 1 }, { op: "writeSegment", lsm: 1, bytes: tables.addr }, { op: "loadCompleted", lsm: 1 },
      { op: "load", lsm: 2 }, { op: "writeSegment", lsm: 2, bytes: tables.assoc }, { op: "loadCompleted", lsm: 2 },
      { op: "restart" },
    ]);
  });

  test("exact order: per LSM load -> LOADING check -> verified write -> completed -> LOADED check; addr(1) before assoc(2); no unload, no alloc", async () => {
    const dev = new RecDev();
    await runLoadPlan(asDev(dev), planMv0705GaFlash(tables));
    // Absolute segments: no relative-segment alloc and no unload appear anywhere,
    // and memWrite runs with verify:true (chunk-verified, per the hardware-proven path).
    expect(dev.calls).toEqual([
      ["propWrite", 1, 5, EV_LOAD],            // address table first
      ["propRead", 1, 5],                      // must observe LOADING (engine default assert)
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
    expect(runLoadPlan(asDev(dev), planMv0705GaFlash(tables))).rejects.toThrow(/not LOADING/);
    // aborted before touching device memory
    expect(dev.calls.some((c) => c[0] === "memWrite")).toBe(false);
  });

  test("rejects when LOAD_COMPLETED is not answered with LOADED", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(1, [STATE.LOADING, STATE.LOADING]); // Load ok, but completion never lands
    expect(runLoadPlan(asDev(dev), planMv0705GaFlash(tables))).rejects.toThrow(/not LOADED/);
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

  test("load step names the actual state in its error, as a coded KnxError (localizable, not a raw 500)", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(4, [STATE.ERROR]);
    const err = await runLoadPlan(asDev(dev), [{ op: "load", lsm: 4 }]).catch((e) => e);
    expect(err).toBeInstanceOf(KnxError);
    expect(err.code).toBe("LOAD_STATE_UNEXPECTED"); // the server's errorCode() maps this to a 400 + localized message
    expect(err.message).toMatch(/not LOADING after LOAD \(got ERROR\)/);
  });

  test("loadCompleted step rejects when the state is not LOADED", async () => {
    const dev = new RecDev();
    dev.lsmQueue.set(4, [STATE.LOADING]); // completion refused, machine stuck in LOADING
    expect(runLoadPlan(asDev(dev), [{ op: "loadCompleted", lsm: 4 }])).rejects.toThrow(/not LOADED after LOAD_COMPLETED \(got LOADING\)/);
  });

  // A memory write can throw mid-bracket: a lost T_ACK, or (the common case) a read-back
  // verify mismatch (memWrite verify:true). The executor's promise is that on ANY throw it
  // stops immediately, never completes the load and never restarts into a half-written
  // segment, and the device is left re-runnable. These lock that promise, which the
  // happy-path call-order tests could not.
  const bracket = (lsm: number): LoadPlan => [
    { op: "unload", lsm }, { op: "load", lsm },
    { op: "writeMem", address: 0x4000, bytes: Buffer.from("dead", "hex") },
    { op: "writeMem", address: 0x4002, bytes: Buffer.from("beef", "hex") },
    { op: "loadCompleted", lsm }, { op: "restart" },
  ];

  test("a write that throws mid-bracket aborts BEFORE loadCompleted and restart; LSM stays LOADING (recoverable)", async () => {
    const dev = new RecDev();
    dev.writeFailAt = 2; // second writeMem throws (e.g. its read-back verify failed)
    expect(runLoadPlan(asDev(dev), bracket(4))).rejects.toThrow(/verify mismatch/);
    // The load opened (LOADING) but was never completed, and no restart happened: the device
    // is addressable and can be re-flashed, not bricked in a half-open, restarted state.
    expect(dev.state.get(4)).toBe(STATE.LOADING);
    expect(dev.calls.some((c) => c[0] === "propWrite" && c[1] === 4 && c[3] === EV_DONE)).toBe(false);
    expect(dev.calls.some((c) => c[0] === "restart")).toBe(false);
    // The first write went out, the second threw: no write AFTER the failing one.
    expect(dev.calls.filter((c) => c[0] === "memWrite").length).toBe(2);
  });

  test("re-running the plan after a mid-write failure completes (the device was left recoverable)", async () => {
    const dev = new RecDev();
    dev.writeFailAt = 1;
    expect(runLoadPlan(asDev(dev), bracket(4))).rejects.toThrow();
    // Recovery: the same plan, now with a healthy device, runs to completion and restarts.
    dev.writeFailAt = null;
    dev.calls = [];
    await runLoadPlan(asDev(dev), bracket(4));
    expect(dev.state.get(4)).toBe(STATE.LOADED);
    expect(dev.calls.at(-1)).toEqual(["restart"]);
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

describe("segment CRC (how a 21601-byte image is verified with one property read)", () => {
  // Transcribed from the firmware that produces it (thelsing/knx bits.cpp crc16Ccitt). These
  // vectors are computed by an INDEPENDENT reimplementation of that C code, so a transcription
  // slip in either direction shows up here rather than as a download that reports success while
  // the device holds different bytes.
  const reference = (data: Buffer): number => {
    // literal transcription of the C, kept separate from the shipped implementation on purpose
    let r = 0xffff;
    for (let i = 0; i < 8 * (data.length + 2); i++) {
      r = (r << 1) >>> 0;
      r |= (i >> 3) < data.length ? (data[i >> 3] >> (7 - (i % 8))) & 1 : 0;
      if (r & 0x10000) r ^= 0x1021;
    }
    return r & 0xffff;
  };

  test("matches an independent transcription of the firmware, on real-shaped data", () => {
    for (const data of [
      Buffer.alloc(0),
      Buffer.from([0x00]),
      Buffer.from("0001012c0e00", "hex"),                        // the first bytes of the real image
      Buffer.alloc(21601),                                        // the whole segment, all zeros
      Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) & 0xff)),
    ]) {
      expect(crc16Ccitt(data)).toBe(reference(data));
    }
  });

  test("a single flipped byte changes the CRC (it has teeth)", () => {
    const a = Buffer.alloc(21601); a[12345] = 0x01;
    const b = Buffer.alloc(21601);
    expect(crc16Ccitt(a)).not.toBe(crc16Ccitt(b));
  });

  // crc16CcittFalse is the non-augmented CCITT convention (no trailing 16 zero bits) that non-
  // thelsing System B firmware (GVS K-BUS) uses for its MCB CRC.
  test("crc16CcittFalse matches the canonical CRC-16/CCITT-FALSE check value", () => {
    // The catalogue check: CRC-16/CCITT-FALSE("123456789") = 0x29B1.
    expect(crc16CcittFalse(Buffer.from("123456789", "ascii"))).toBe(0x29b1);
  });

  test("the two CCITT conventions produce different values on real data (why the device 'mismatched')", () => {
    // Same poly (0x1021) and init (0xFFFF), but the augmented (crc16Ccitt) and non-augmented
    // (crc16CcittFalse) conventions genuinely differ, which is the whole reason the GVS's reported
    // MCB CRC did not equal crc16Ccitt over a byte-identical segment. The verify path accepts either.
    for (const data of [Buffer.from("0001012c0e00", "hex"), Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff))]) {
      expect(crc16CcittFalse(data)).not.toBe(crc16Ccitt(data));
    }
  });
});

describe("writes in the device's verify mode (what LdCtrlWriteRelMem Verify=true asks for)", () => {
  // A device that silently drops a memory write is the failure mode that cost us a device: the
  // download ran on for a thousand more telegrams and the loss surfaced far from where it
  // happened, by which point the device had given up on its own configuration. In verify mode the
  // device answers every write with what actually landed, so a drop fails immediately, at the
  // chunk, with its address (thelsing/knx BauSystemB::memoryWriteIndication).
  const deviceWith = (opts: { control?: number; dropsAt?: number } = {}) => {
    const mem = new Map<number, number>();
    const propWrites: { obj: number; pid: number; data: Buffer }[] = [];
    let control = opts.control ?? 0;
    const dev = Object.create(KnxDevice.prototype);
    dev.propRead = async (obj: number, pid: number) => (obj === 0 && pid === 14 ? Buffer.from([control]) : Buffer.alloc(1));
    dev.propWrite = async (obj: number, pid: number, data: Buffer) => {
      propWrites.push({ obj, pid, data: Buffer.from(data) });
      if (obj === 0 && pid === 14) control = data[0];
      return Buffer.alloc(0);
    };
    // The real request machine is what memWrite drives; stub it at the frame level so the echo is
    // built from the device's ACTUAL memory, exactly as the firmware answers it.
    dev.request = async (build: (seq: number) => Buffer, expectResponse: boolean) => {
      const tpdu = build(0);
      const addr = (tpdu[2] << 8) | tpdu[3];
      const payload = tpdu.subarray(4);
      for (let i = 0; i < payload.length; i++) if (addr + i !== opts.dropsAt) mem.set(addr + i, payload[i]);
      if (!expectResponse) return null;
      const back = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) back[i] = mem.get(addr + i) ?? 0xff;
      return { control: false, seq: 0, apci: 0x240, data: Buffer.concat([Buffer.from([tpdu[2], tpdu[3]]), back]) };
    };
    dev.memRead = async (a: number, len: number) => {
      const b = Buffer.alloc(len);
      for (let i = 0; i < len; i++) b[i] = mem.get(a + i) ?? 0xff;
      return b;
    };
    return { dev: dev as KnxDevice, mem, propWrites, control: () => control };
  };

  test("setVerifyMode keeps the other bits of PID_DEVICE_CONTROL (programming mode lives in that byte)", async () => {
    const d = deviceWith({ control: 0x01 }); // the device is in programming mode
    await d.dev.setVerifyMode(true);
    expect(d.control()).toBe(0x05); // verify mode added, programming mode untouched
    await d.dev.setVerifyMode(false);
    expect(d.control()).toBe(0x01); // and removed again, still not touching programming mode
  });

  test("an echoed write that the device did not store fails AT that chunk, naming the address", async () => {
    const d = deviceWith({ dropsAt: 0x1004 }); // the device silently ignores this one byte
    const err = await d.dev.memWrite(0x1000, Buffer.alloc(24, 0xa5), { chunk: 4, echo: true, verify: false })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("FLASH_VERIFY_MISMATCH");
    expect((err as Error).message).toContain("1004"); // the exact chunk, not "something went wrong"
    // and it stopped there rather than writing on into the dark
    expect(d.mem.has(0x1008)).toBe(false);
  });

  test("an echoed write the device stores is accepted with no second pass over the segment", async () => {
    const d = deviceWith();
    await d.dev.memWrite(0x1000, Buffer.alloc(24, 0xa5), { chunk: 4, echo: true, verify: false });
    expect(await d.dev.memRead(0x1000, 24)).toEqual(Buffer.alloc(24, 0xa5));
  });
});

describe("sparse writes (only the bytes that carry information)", () => {
  // A full download allocates the parameter segment with fill, so the device zeroes it for us. The
  // only bytes that need to cross the bus are the ones that are not zero. On the real OpenKNX
  // RaumController that is 51 bytes out of 21601: 22 telegrams instead of 1801. Sending the other
  // 21550 zeros is not merely wasteful, it is what killed the device: it commits its flash while we
  // keep writing at it, and its watchdog resets it mid-commit.
  test("finds the runs and skips the zeros", () => {
    const b = Buffer.alloc(100);
    b[3] = 0xaa; b[4] = 0xbb;      // a run at 3..4
    b[60] = 0x01;                   // and one at 60
    const runs = sparseRuns(b);
    expect(runs.map((r) => [r.offset, r.bytes.toString("hex")])).toEqual([[3, "aabb"], [60, "01"]]);
  });

  test("bridges a gap shorter than one telegram rather than paying for another round trip", () => {
    const b = Buffer.alloc(40);
    b[0] = 1; b[5] = 1;   // 4 zero bytes between them: cheaper to send them than to send a second telegram
    b[30] = 1;            // 24 zeros away: worth its own telegram
    expect(sparseRuns(b, 12).map((r) => r.offset)).toEqual([0, 30]);
    expect(sparseRuns(b, 12)[0].bytes.length).toBe(6); // the gap rode along
  });

  test("an all-zero segment needs no writes at all (the fill already did it)", () => {
    expect(sparseRuns(Buffer.alloc(4096))).toEqual([]);
  });

  test("the runs reassemble into the original segment over a zeroed buffer", () => {
    const original = Buffer.alloc(1000);
    for (const i of [0, 1, 2, 500, 501, 999]) original[i] = (i % 251) + 1;
    const rebuilt = Buffer.alloc(1000); // what the device holds after alloc(fill)
    for (const r of sparseRuns(original)) r.bytes.copy(rebuilt, r.offset);
    expect(rebuilt).toEqual(original); // nothing was lost by not sending the zeros
  });

  // A device that fills with 0xFF (GVS AMMA, Fill=255) must be sparsed against 0xFF, not 0x00: an
  // 0x00 byte in the image is then MEANINGFUL and must be sent, while an 0xFF byte is the fill.
  test("against a 0xFF fill, the 0xFF bytes are the fill and everything else is written", () => {
    const b = Buffer.alloc(100, 0xff); // the device pre-filled this with 0xFF
    b[3] = 0x00; b[4] = 0x00;          // meaningful zeros: must NOT be skipped
    b[60] = 0x01;
    const runs = sparseRuns(b, 12, 0xff);
    expect(runs.map((r) => [r.offset, r.bytes.toString("hex")])).toEqual([[3, "0000"], [60, "01"]]);
  });

  test("an all-0xFF segment against a 0xFF fill needs no writes at all", () => {
    expect(sparseRuns(Buffer.alloc(4096, 0xff), 12, 0xff)).toEqual([]);
  });

  test("the runs reassemble over a 0xFF-filled buffer, losing nothing", () => {
    const original = Buffer.alloc(1000, 0xff);
    for (const i of [0, 1, 2, 500, 501, 999]) original[i] = i % 256; // includes 0x00s that must survive
    const rebuilt = Buffer.alloc(1000, 0xff); // what the device holds after alloc(fill=0xFF)
    for (const r of sparseRuns(original, 12, 0xff)) r.bytes.copy(rebuilt, r.offset);
    expect(rebuilt).toEqual(original);
  });
});

describe("planSystemBFullDownload: the parameter fill byte is threaded end to end", () => {
  const tables = () => ({
    params: (() => { const p = Buffer.alloc(64, 0xff); p[10] = 0x42; return p; })(),
    comObj: Buffer.from([1, 2]), addr: Buffer.from([3, 4]), assoc: Buffer.from([5, 6]),
    programId: appId(0x0085, 0x0072, 0x30),
  });

  test("default (0x00 fill): the parameter alloc asks doFill=1/fillByte=0, unchanged from before", () => {
    const plan = planSystemBFullDownload(tables());
    const palloc = plan.find((s) => s.op === "alloc" && s.lsm === 4) as { fill?: boolean; fillByte?: number };
    expect(palloc.fill).toBe(true);
    expect(palloc.fillByte ?? 0).toBe(0);
    // Against a 0x00 fill, the 0xFF image bytes are all non-fill and get written.
    const writes = plan.filter((s) => s.op === "writeSegment" && s.lsm === 4);
    expect(writes.length).toBeGreaterThan(0);
  });

  test("0xFF fill: the alloc carries fillByte=0xFF and only the non-0xFF byte is written", () => {
    const plan = planSystemBFullDownload(tables(), 0xff);
    const palloc = plan.find((s) => s.op === "alloc" && s.lsm === 4) as { fillByte?: number };
    expect(palloc.fillByte).toBe(0xff);
    // The image is 0xFF except one byte at offset 10: exactly one run, exactly that byte.
    const writes = plan.filter((s) => s.op === "writeSegment" && s.lsm === 4) as { offset?: number; bytes: Buffer }[];
    expect(writes.length).toBe(1);
    expect(writes[0].offset).toBe(10);
    expect(writes[0].bytes.toString("hex")).toBe("42");
  });

  test("requireReboot defaults true and threads into the closing restart step", () => {
    const dflt = planSystemBFullDownload(tables()).find((s) => s.op === "restart") as { requireReboot?: boolean };
    expect(dflt.requireReboot).toBe(true); // safe default: the restart must prove a reboot
    const relaxed = planSystemBFullDownload(tables(), 0, false).find((s) => s.op === "restart") as { requireReboot?: boolean };
    expect(relaxed.requireReboot).toBe(false); // LoadCompleted-persist firmware: a live device is fine
  });
});

describe("the download must not restart the device before it has saved", () => {
  // HARDWARE-FOUND, and it cost the device a dozen times. This device does not persist its
  // configuration when it is told the load is complete: it persists it on a TIMER, from its main
  // loop, five seconds after its memory was last touched (thelsing/knx Memory::loop). Restart it
  // before that and it boots with metadata that never described the download, discards everything,
  // and comes back factory-fresh, having reported every load state as LOADED a second earlier
  // (those live in RAM).
  //
  // Worse, the timer is ARMED only when memory is freed and merely REFRESHED by writes
  // (`if (_saveTimeout != 0) _saveTimeout = millis()`), so if it expires DURING the download the
  // save fires with every load state still LOADING and then never fires again. Which is why the
  // bracket must stay tight and the ONLY long pause belongs at the end.
  const plan = planSystemBFullDownload({
    params: Buffer.alloc(64, 1), comObj: Buffer.from([0, 1, 0x4f, 0]),
    addr: Buffer.from([0, 0]), assoc: Buffer.from([0, 0]), programId: Buffer.alloc(5),
  });

  test("it settles before the restart, and nothing touches the device's memory in between", () => {
    const restart = plan.findIndex((s) => s.op === "restart");
    expect(restart).toBeGreaterThan(0);
    const settle = plan.findIndex((s) => s.op === "settle");
    expect(settle).toBeGreaterThan(0);
    expect(settle).toBeLessThan(restart);
    expect((plan[settle] as { ms: number }).ms).toBeGreaterThanOrEqual(6000); // the device's threshold is 5 s

    // Between the settle and the restart, only the LINK may be touched. Re-opening the connection
    // is not optional: a connection-oriented KNX link dies after 6s of silence and the settle is 8,
    // so without it the A_Restart is sent into a torn-down connection and never arrives — and the
    // restart is the only thing that makes the device write its flash metadata. But nothing in here
    // may touch the device's MEMORY, because a memory write refreshes the deferred-save timer
    // (`if (_saveTimeout != 0) _saveTimeout = millis()`) and pushes the save back out past the
    // restart, which is the very thing the settle exists to prevent.
    const between = plan.slice(settle + 1, restart).map((s) => s.op);
    expect(between).toEqual(["disconnect", "connect"]);
  });

  test("the restart is the last step: nothing follows a device that is rebooting", () => {
    expect(plan[plan.length - 1].op).toBe("restart");
  });

  test("nothing waits around between the unloads and the load-completed bracket", () => {
    // A pause longer than the device's five-second save threshold anywhere in here fires the save
    // early, with the load states still LOADING, and the download is silently lost.
    const first = plan.findIndex((s) => s.op === "unload");
    const done = plan.findIndex((s) => s.op === "loadCompleted");
    const waits = plan.slice(first, done).filter((s) => s.op === "settle" || s.op === "awaitReady");
    expect(waits).toEqual([]);
  });
});

describe("master reset over the bus", () => {
  // A_Restart carries its type in the low bits of the APCI: a plain restart is one thing, a master
  // reset (which then takes an erase code) is another. Getting the bytes wrong here means either a
  // no-op or wiping the wrong thing, so pin the frame.
  test("builds A_Restart with the MasterReset type and the erase code", async () => {
    const sent: Buffer[] = [];
    const tun = { assignedIa: 0, onCemi: null, connect: async () => {}, disconnect: async () => {}, sendCemi: async (c: Buffer) => { sent.push(Buffer.from(c)); } };
    const dev = new KnxDevice(tun as any, "1.2.32");
    await dev.masterReset(ERASE.FACTORY_RESET);

    const cemi = sent[0];
    const tpdu = cemi.subarray(9); // after the 9-byte cEMI L_Data head
    const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
    expect(apci & 0x3c0).toBe(0x380);       // A_Restart
    expect(apci & 0x3f).toBe(RESTART_MASTER); // ...with the master-reset type in the low bits
    expect(tpdu[2]).toBe(ERASE.FACTORY_RESET); // erase code
    expect(tpdu[3]).toBe(0);                   // channel
  });

  test("a send failure propagates: a reset whose frame never left the interface is not a success", async () => {
    // The frame never left the interface, so the device still holds its full configuration. Returning
    // clean here would tell the caller a factory reset happened when nothing was wiped.
    const tun = { assignedIa: 0, onCemi: null, connect: async () => {}, disconnect: async () => {}, sendCemi: async () => { throw new Error("interface down"); } };
    const dev = new KnxDevice(tun as any, "1.2.32");
    expect(dev.masterReset(ERASE.FACTORY_RESET)).rejects.toThrow("interface down");
  });
})

describe("planSystemBFullDownload: the declared MCB entries", () => {
  const tables = { params: Buffer.alloc(16, 1), comObj: Buffer.from([1, 2]), addr: Buffer.from([3, 4]), assoc: Buffer.from([5, 6]), programId: appId(0x0004, 0x7072, 0x21) };
  const mcb = [
    { obj: 4, element: 1, data: Buffer.from("00001e1400330000", "hex") },
    { obj: 4, element: 2, data: Buffer.from("0000000101330000", "hex") },
  ];

  test("each entry is written right after its object's allocation, in order, as ETS does", () => {
    const plan = planSystemBFullDownload(tables, 0, true, mcb);
    const at = plan.findIndex((s) => s.op === "alloc" && s.lsm === 4);
    expect(plan.slice(at + 1, at + 3)).toEqual([
      { op: "writeProp", obj: 4, pid: 27, start: 1, data: mcb[0].data },
      { op: "writeProp", obj: 4, pid: 27, start: 2, data: mcb[1].data },
    ]);
  });

  test("without declared entries the plan is unchanged", () => {
    expect(planSystemBFullDownload(tables, 0, true, [])).toEqual(planSystemBFullDownload(tables, 0, true));
    expect(planSystemBFullDownload(tables).some((s) => s.op === "writeProp")).toBe(false);
  });

  test("an entry for an object the download does not allocate is refused", () => {
    expect(() => planSystemBFullDownload(tables, 0, true, [{ obj: 5, element: 1, data: mcb[0].data }])).toThrow("object 5");
  });
});

describe("runLoadPlan: a property write must be taken as written", () => {
  const step: LoadStep = { op: "writeProp", obj: 4, pid: 27, start: 2, data: Buffer.from("0000000101330000", "hex") };

  test("an echo equal to the data continues", async () => {
    const dev = new RecDev();
    dev.propWrite = async (_o: number, _p: number, data: Buffer) => Buffer.from(data);
    await runLoadPlan(dev as unknown as KnxDevice, [step]);
  });

  test("with echoPrefix only that many leading bytes must match: the device may fill the rest", async () => {
    const dev = new RecDev();
    dev.propWrite = async (_o: number, _p: number, data: Buffer) => Buffer.concat([data.subarray(0, 6), Buffer.from("c73a", "hex")]); // its own CRC
    await runLoadPlan(dev as unknown as KnxDevice, [{ ...step, echoPrefix: 4 }]);
    dev.propWrite = async () => Buffer.alloc(0);
    const err = await runLoadPlan(dev as unknown as KnxDevice, [{ ...step, echoPrefix: 4 }]).then(() => null, (e: unknown) => e as KnxError);
    expect(err?.code).toBe("PROPERTY_WRITE_REFUSED");
  });

  test("a declined write (empty echo) fails the plan instead of carrying on", async () => {
    const dev = new RecDev();
    dev.propWrite = async () => Buffer.alloc(0); // echoes nothing, like a device that refuses the element
    const err = await runLoadPlan(dev as unknown as KnxDevice, [step]).then(() => null, (e: unknown) => e as KnxError);
    expect(err?.code).toBe("PROPERTY_WRITE_REFUSED");
  });
});
