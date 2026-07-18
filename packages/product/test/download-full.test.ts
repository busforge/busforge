import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { LSM, STATE, crc16Ccitt, crc16CcittFalse, type KnxDevice } from "@busforge/knx";
import {
  parseAppConfig, classify, buildDeviceConfig, buildComObjectTable,
  buildRelativeSegmentTarget, buildGroupTables, type ComObjectLink,
} from "@busforge/product";

// downloadFull ORCHESTRATION on a mock device, using the real hardware-proven M-0162 System B
// application (the same fixture readstate/loadproc tests use). downloadFull is the riskiest write
// in the repo: it AUTHORS the com-object table a virgin device has none of, and the firmware
// validates nothing it is handed, so the ONLY proof is the read-back afterwards. The building
// blocks (planSystemBFullDownload, buildComObjectTable, sparseRuns, the CRC codec) are locked
// elsewhere; here the subject is the orchestration: the refusal gates, the backup-before-unload
// ordering, the implausible-count / segment-size refusals (Finding 5), and CRITICALLY that a CRC
// matching NEITHER convention forces the full segment read-back rather than passing on the CRC.
//
// Every expectation is derived INDEPENDENTLY in the test from the fixture (com-object table, group
// tables, both CRC conventions), so the orchestration cannot pass by comparing the code to itself.

const REAL = join(import.meta.dir, "fixtures", "real");
const xml = gunzipSync(readFileSync(join(REAL, "M-0162_A-0004-11-F245.xml.gz"))).toString("utf8");
const cfg = parseAppConfig(xml);

// The images the download must place, built independently of downloadFull for both seeding and
// assertions. Empty params = the application defaults (the corpus locks that these are the exact
// bytes ETS computes).
const params = new Map<string, string>();
const view = buildDeviceConfig(cfg, params, undefined, []);
const comObjTable = buildComObjectTable(view.imageComObjects);
const target = buildRelativeSegmentTarget(cfg, params, 4, { moduleInstances: [] })!; // 4 = OBJ.APP_PROGRAM (LSM 4)
const { addr: addrTable, assoc: assocTable } = buildGroupTables([]);
const CRC_AUG = crc16Ccitt(target.bytes);        // thelsing / OpenKNX (augmented)
const CRC_PLAIN = crc16CcittFalse(target.bytes); // GVS and other CCITT-FALSE firmware
const activeComObjNums = [...view.imageComObjects.keys()]; // [1..6]

// Object numbers on the bus. LSM 4 = parameter segment; 1/2/3 = addr/assoc/comObj tables.
const OBJ = { ADDR: 1, ASSOC: 2, COMOBJ: 3, LSM: 4 } as const;
const PID_LSM = 5, PID_MCB = 27, PID_DEVCTRL = 14;
// Distinct, non-overlapping memory regions the mock's tableAddr hands out.
const A = { [OBJ.LSM]: 0x4000, [OBJ.ADDR]: 0x5000, [OBJ.ASSOC]: 0x5100, [OBJ.COMOBJ]: 0x5200 } as Record<number, number>;

const mcbBuf = (size: number, crc: number) => { const b = Buffer.alloc(8); b.writeUInt32BE(size, 0); b.writeUInt16BE(crc, 6); return b; };

// A stateful byte-addressed mock exercising everything the full-download plan drives: LSM state via
// PID 5, the MCB (PID 27), verify mode (PID 14), memory read/write with a fill-aware alloc, plus the
// restart / reconnect lifecycle. `alloc` zeroes the allocated segment exactly as the real device
// does, so the sparse writes reconstruct the image byte-for-byte and the read-back is realistic.
interface MockOpts {
  addrs?: Record<number, number>;       // per-object table pointer (0 = never loaded)
  // PID_MCB_TABLE answer. "actual" (the default) reports the CRC of the bytes the device actually
  // holds, exactly as a real device does, so the verify's fast path engages iff the segment is
  // byte-correct. A fixed { size, crc } forces a specific convention (or a bogus value); null makes
  // the device decline to report (< 8 bytes).
  mcb?: "actual" | { size: number; crc: number } | null;
  seedTableCount?: Partial<Record<number, number>>; // count header to seed a group table's region with
  onRestart?: (mem: Map<number, number>) => void;   // mutate memory on restart (simulate a lost write)
}
class MockDevice {
  mem = new Map<number, number>();
  state = new Map<number, number>();
  reads: { addr: number; len: number }[] = [];
  events: string[] = [];
  private addrs: Record<number, number>;
  private mcb: "actual" | { size: number; crc: number } | null;
  private onRestart?: (mem: Map<number, number>) => void;
  constructor(opts: MockOpts = {}) {
    this.addrs = opts.addrs ?? A;
    this.mcb = opts.mcb === undefined ? "actual" : opts.mcb; // an explicit null means "device declines"
    this.onRestart = opts.onRestart;
    // Seed the device's CURRENT (pre-download) state: an all-zero parameter segment and empty
    // group tables, i.e. an already-programmed device. Group-table count headers seed to 0 unless
    // a test overrides one (the implausible-count case).
    for (let i = 0; i < target.size; i++) this.mem.set(this.addrs[OBJ.LSM] + i, 0);
    for (const obj of [OBJ.ADDR, OBJ.ASSOC, OBJ.COMOBJ]) {
      const count = opts.seedTableCount?.[obj] ?? 0;
      this.mem.set(this.addrs[obj], (count >> 8) & 0xff);
      this.mem.set(this.addrs[obj] + 1, count & 0xff);
    }
  }
  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return "MV-07B0"; }
  async restart() { this.events.push("restart"); this.onRestart?.(this.mem); }
  async setVerifyMode() {}
  async tableAddr(obj: number) { return this.addrs[obj] ?? 0; }
  async memRead(addr: number, len: number) {
    this.reads.push({ addr, len });
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0xff;
    return b;
  }
  async memWrite(addr: number, data: Buffer, opts: { verify?: boolean; echo?: boolean } = {}) {
    this.events.push("write");
    for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]);
    if (opts.verify || opts.echo) { const back = await this.memRead(addr, data.length); if (!back.equals(data)) throw new Error("verify mismatch"); }
  }
  // The parameter segment's bytes as the device currently holds them (for the "actual" MCB CRC).
  private segBytes(): Buffer {
    const b = Buffer.alloc(target.size);
    for (let i = 0; i < target.size; i++) b[i] = this.mem.get(this.addrs[OBJ.LSM] + i) ?? 0;
    return b;
  }
  async propRead(obj: number, pid: number) {
    if (pid === PID_LSM) return Buffer.from([this.state.get(obj) ?? STATE.LOADED]);
    if (pid === PID_MCB && obj === OBJ.LSM) {
      if (this.mcb === null) return Buffer.alloc(0); // device declines to report its segment size
      if (this.mcb === "actual") return mcbBuf(target.size, crc16Ccitt(this.segBytes()));
      return mcbBuf(this.mcb.size, this.mcb.crc);
    }
    if (pid === PID_DEVCTRL) return Buffer.from([0]);
    return Buffer.alloc(0);
  }
  async propWrite(obj: number, pid: number, data: Buffer) {
    if (pid === PID_LSM) {
      const ev = data[0];
      if (ev === LSM.LOAD) this.state.set(obj, STATE.LOADING);
      else if (ev === LSM.LOAD_COMPLETED) this.state.set(obj, STATE.LOADED);
      else if (ev === LSM.UNLOAD) { this.state.set(obj, STATE.UNLOADED); this.events.push("unload"); }
      else if (data[0] === 0x03 && data[1] === 0x0b) {
        // AdditionalLoadControls: allocate relative segment. Byte 6 = fill flag, byte 7 = fill byte.
        // Zero (or fill) the allocated region so the following sparse writes reconstruct the image.
        const size = data.readUInt32BE(2), fill = data[6], fb = data[7];
        if (fill) for (let i = 0; i < size; i++) this.mem.set(this.addrs[obj] + i, fb);
      }
    }
    return Buffer.alloc(0);
  }
}
const asDev = (m: MockDevice) => m as unknown as KnxDevice;

// The context the server hands the profile, with a recording backup hook. The hook logs
// "backup-persisted" into the SAME event stream the mock records unloads/writes into, so the
// backup-before-unload ordering is a positive assertion on one timeline (runFlashOp calls
// persistBackups before any write reaches the device).
function ctxFor(dev: MockDevice, over: { params?: Map<string, string>; links?: ComObjectLink[]; dryRun?: boolean } = {}) {
  const backups: { file: string; bytes: Buffer }[] = [];
  return {
    backups,
    ctx: {
      deviceId: "d", ia: "1.1.1", appXml: xml,
      params: over.params ?? params,
      links: over.links ?? [],
      moduleInstances: [], dryRun: over.dryRun ?? false,
      persistBackups: (files: { file: string; bytes: Buffer }[]) => { backups.push(...files); dev.events.push("backup-persisted"); return "backup"; },
    },
  };
}

describe("SystemB downloadFull orchestration (real M-0162 app, mock device)", () => {
  test("fixture ground truth: System B, full-download-capable, with com-objects and a param image", () => {
    expect(cfg.mask).toBe("MV-07B0");
    expect(classify(cfg).capabilities().fullDownload).toBe(true);
    expect(activeComObjNums.length).toBeGreaterThan(0);
    expect(target.size).toBeGreaterThan(0);
    expect(comObjTable.length).toBeGreaterThan(0);
    expect(CRC_AUG).not.toBe(CRC_PLAIN); // the two conventions genuinely differ on this image
  });

  test("REFUSES a link targeting a com-object this configuration does not activate (LINK_COM_OBJECT_INACTIVE)", async () => {
    const dead = Math.max(...activeComObjNums) + 100; // a number no active object carries
    const dev = new MockDevice();
    const { ctx } = ctxFor(dev, { links: [{ comObjNum: dead, gaRaws: [1] }] });
    const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx).catch((e) => e);
    expect(err?.code).toBe("LINK_COM_OBJECT_INACTIVE");
  });

  test("REFUSES a stored value it cannot place in the image (CHANNEL_MODULES_UNSUPPORTED)", async () => {
    const dev = new MockDevice();
    const { ctx } = ctxFor(dev, { params: new Map([["M-0162_A-0004-11-F245_P-not-a-real-ref", "1"]]) });
    const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx).catch((e) => e);
    expect(err?.code).toBe("CHANNEL_MODULES_UNSUPPORTED");
  });

  test("Finding 5a: an already-loaded table with an implausible count REFUSES, never silently skips (GROUP_TABLE_UNREADABLE)", async () => {
    // The com-object table region seeds a 60000-entry count header: the reader's twin refuses this
    // exact condition, and so must the backup, instead of returning size 0 and unloading it anyway.
    const dev = new MockDevice({ seedTableCount: { [OBJ.COMOBJ]: 60000 } });
    const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx).catch((e) => e);
    expect(err?.code).toBe("GROUP_TABLE_UNREADABLE");
    // It refused during backup: nothing was unloaded, nothing written.
    expect(dev.events).not.toContain("unload");
    expect(dev.events).not.toContain("write");
  });

  test("Finding 5b: a device that will not report its loaded segment size REFUSES, not backs up a guess (SEGMENT_SIZE_UNKNOWN)", async () => {
    const dev = new MockDevice({ mcb: null }); // PID_MCB_TABLE answers < 8 bytes
    const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx).catch((e) => e);
    expect(err?.code).toBe("SEGMENT_SIZE_UNKNOWN");
    expect(dev.events).not.toContain("unload");
  });

  test("Finding 5b: the parameter backup is sized from the device's loaded segment (its MCB), NOT the new image", async () => {
    // The device was programmed with a LARGER parameter segment than our new image. Sizing the
    // backup by the image (target.size) would silently omit the tail the unload is about to destroy.
    // The backup must capture the device's full MCB-reported length. (dryRun still runs the whole
    // backup loop, so this asserts the sizing without the slow write/restart bracket.)
    const biggerSize = target.size + 64;
    const dev = new MockDevice({ mcb: { size: biggerSize, crc: 0 } });
    const { ctx, backups } = ctxFor(dev, { dryRun: true });
    const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx);

    expect(res.kind).toBe("dryRun");
    expect(biggerSize).not.toBe(target.size); // the device's segment genuinely exceeds the image
    const paramBackup = backups.find((b) => b.file.includes("params"));
    expect(paramBackup?.bytes.length).toBe(biggerSize); // sized from the MCB, not target.size
  });

  test("happy path: backs up (sized from the device's MCB) BEFORE any unload, writes, and verifies via the CRC fast path", async () => {
    // The device reports the CRC of the bytes it actually holds ("actual"), which after a correct
    // download equals the augmented CRC the verify computes, so the verify accepts it without
    // reading the whole segment back.
    const dev = new MockDevice({ mcb: "actual" });
    const { ctx, backups } = ctxFor(dev);
    const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx);

    expect(res.kind).toBe("flashed");
    if (res.kind !== "flashed") throw new Error("unreachable");
    expect(res.verified).toBe(true);

    // CRC fast path: measured on the reads downloadFull ITSELF made (before the post-download
    // assertions below add their own reads). The parameter segment was read at full length exactly
    // ONCE, the pre-download backup; the verify accepted the MCB CRC and did NOT re-read the segment.
    const fullReadsByDownload = dev.reads.filter((r) => r.addr === A[OBJ.LSM] && r.len === target.size).length;
    expect(fullReadsByDownload).toBe(1);

    // Backup-before-unload: on one timeline, the backups were persisted before the first unload and
    // the first write reached the device.
    expect(dev.events[0]).toBe("backup-persisted");
    const firstUnload = dev.events.indexOf("unload");
    const firstWrite = dev.events.indexOf("write");
    expect(firstUnload).toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(0);
    // The parameter backup was sized from the DEVICE's MCB (target.size here), and all four segments
    // that were loaded got a copy.
    expect(backups.map((b) => b.bytes.length).sort((a, b) => a - b)).toEqual([2, 2, 2, target.size].sort((a, b) => a - b));

    // The device now holds the authored tables and the parameter image, byte for byte.
    expect((await dev.memRead(A[OBJ.ADDR], addrTable.length)).equals(addrTable)).toBe(true);
    expect((await dev.memRead(A[OBJ.ASSOC], assocTable.length)).equals(assocTable)).toBe(true);
    expect((await dev.memRead(A[OBJ.COMOBJ], comObjTable.length)).equals(comObjTable)).toBe(true);
    expect((await dev.memRead(A[OBJ.LSM], target.size)).equals(target.bytes)).toBe(true);
  }, 20_000); // the plan's settle (>=6 s) + reconnectAfterRestart (3 s) are not injectable here

  test("TEETH: an MCB CRC matching NEITHER convention forces the full read-back, which catches a lost write (verified:false)", async () => {
    // The device reports a CRC that is neither the augmented nor the CCITT-FALSE value, AND the
    // restart drops one owned parameter byte. The ONLY thing that can catch this is the full
    // segment read-back the verify must fall back to. If that fallback is removed or inverted to
    // treat a CRC mismatch as a pass, verified flips to true and this test goes red.
    const flip = target.verify.findIndex(Boolean); // an owned + verifiable byte
    const dev = new MockDevice({
      mcb: { size: target.size, crc: 0xdead }, // matches neither CRC_AUG nor CRC_PLAIN
      onRestart: (mem) => { mem.set(A[OBJ.LSM] + flip, target.bytes[flip] ^ 0xff); }, // the write did not stick
    });
    const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx);

    expect(res.kind).toBe("flashed");
    if (res.kind !== "flashed") throw new Error("unreachable");
    expect(res.verified).toBe(false); // the corrupted byte was caught by the full read-back, not swallowed

    // Prove the fallback engaged: the full-length segment was read again during verify (backup read
    // plus at least one verify read), not skipped on the strength of the CRC.
    const fullReads = dev.reads.filter((r) => r.addr === A[OBJ.LSM] && r.len === target.size);
    expect(fullReads.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  test("dryRun: captures the backup but writes NOTHING to the device", async () => {
    const dev = new MockDevice();
    const before = new Map(dev.mem);
    const { ctx, backups } = ctxFor(dev, { dryRun: true });
    const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx);

    expect(res.kind).toBe("dryRun");
    expect(backups.length).toBe(4);           // the device's four loaded segments were still copied
    expect(dev.events).not.toContain("write"); // ...but nothing was programmed
    expect(dev.events).not.toContain("unload");
    expect(dev.mem).toEqual(before);
  });
});
