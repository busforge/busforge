import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { LSM, STATE, crc16Ccitt, crc16CcittFalse, type KnxDevice } from "@busforge/knx";
import {
  parseAppConfig, parseLoadProcedures, classify, buildDeviceConfig, buildComObjectTable,
  buildRelativeSegmentTarget, buildGroupTables, fullDownloadParamImage, type ComObjectLink,
} from "@busforge/product";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { absentIfEmpty, refusedIfEmpty } from "./property-reads.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 7.5 s with the
// file alone (load 5-27) and up to 7.5 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(160_000);

// downloadFull ORCHESTRATION on a mock device, using the real hardware-proven M-0162 System B
// application (the same fixture readstate/loadproc tests use). downloadFull is the riskiest write
// in the repo: it AUTHORS the com-object table a virgin device has none of, and the firmware
// validates nothing it is handed, so the ONLY proof is the read-back afterwards. The building
// blocks (planSystemBFullDownload, buildComObjectTable, fillAllocatedRuns, the CRC codec) are locked
// elsewhere; here the subject is the orchestration: the refusal gates, the backup-before-unload
// ordering, the implausible-count / segment-size refusals (Finding 5), and CRITICALLY that a CRC
// matching NEITHER convention forces the full segment read-back rather than passing on the CRC.
//
// Every expectation is derived INDEPENDENTLY in the test from the fixture (com-object table, group
// tables, both CRC conventions), so the orchestration cannot pass by comparing the code to itself.

// Object numbers on the bus. LSM 4 = parameter segment; 1/2/3 = addr/assoc/comObj tables.
const OBJ = { ADDR: 1, ASSOC: 2, COMOBJ: 3, LSM: 4 } as const;
const PID_LSM = 5, PID_MCB = 27, PID_DEVCTRL = 14;
// Distinct, non-overlapping memory regions the mock's tableAddr hands out.
const A = { [OBJ.LSM]: 0x4000, [OBJ.ADDR]: 0x5000, [OBJ.ASSOC]: 0x5100, [OBJ.COMOBJ]: 0x5200 } as Record<number, number>;

const mcbBuf = (size: number, crc: number) => { const b = Buffer.alloc(8); b.writeUInt32BE(size, 0); b.writeUInt16BE(crc, 6); return b; };

// A stateful byte-addressed mock exercising everything the full-download plan drives: LSM state via
// PID 5, the MCB (PID 27), verify mode (PID 14), memory read/write with a fill-aware alloc, plus the
// restart / reconnect lifecycle. `alloc` zeroes (or fills with `fillByte`) the allocated segment
// exactly as the real device does, so the sparse writes reconstruct the image byte-for-byte and the
// read-back is realistic.
interface MockOpts {
  segmentSize: number;
  addrs?: Record<number, number>;       // per-object table pointer (0 = never loaded)
  // PID_MCB_TABLE answer. "actual" (the default) reports the CRC of the bytes the device actually
  // holds, exactly as a real device does, so the verify's fast path engages iff the segment is
  // byte-correct. A fixed { size, crc } forces a specific convention (or a bogus value); null makes
  // the device decline to report (< 8 bytes).
  mcb?: "actual" | { size: number; crc: number } | null;
  // With mcb "actual": the region sizes the parameter segment's MCB splits it into, one element each
  // (Jung 400021SE: 7700 and 1). Default: one region over the whole segment.
  mcbRegions?: number[];
  // The group tables that report their MCB (one region over the allocated table, the CRC of what it
  // holds): true for all three.
  tableMcb?: boolean | number[];
  seedTableCount?: Partial<Record<number, number>>; // count header to seed a group table's region with
  onRestart?: (mem: Map<number, number>) => void;   // mutate memory on restart (simulate a lost write)
  confirmedWrites?: boolean;                        // true = A_MemoryExtended_Write (no verify mode / read-back)
  crc?: (b: Buffer) => number;                      // CRC convention for mcb "actual" (default crc16Ccitt)
}
class MockDevice {
  mem = new Map<number, number>();
  state = new Map<number, number>();
  reads: { addr: number; len: number }[] = [];
  writes: { addr: number; data: Buffer }[] = [];
  events: string[] = [];
  private addrs: Record<number, number>;
  private mcb: "actual" | { size: number; crc: number } | null;
  private mcbRegions: number[];
  private tableMcb: number[];
  private allocated = new Map<number, number>();
  private confirmed: boolean;
  private crcFn: (b: Buffer) => number;
  onRestart?: (mem: Map<number, number>) => void; // settable after construction too (a test can break the device only on a LATER restart)
  constructor(opts: MockOpts) {
    this.addrs = opts.addrs ?? A;
    this.mcb = opts.mcb === undefined ? "actual" : opts.mcb; // an explicit null means "device declines"
    this.mcbRegions = opts.mcbRegions ?? [opts.segmentSize];
    this.tableMcb = opts.tableMcb === true ? [OBJ.ADDR, OBJ.ASSOC, OBJ.COMOBJ] : opts.tableMcb || [];
    this.confirmed = opts.confirmedWrites ?? false;
    this.crcFn = opts.crc ?? crc16Ccitt;
    this.onRestart = opts.onRestart;
    // Seed the device's CURRENT (pre-download) state: an all-zero parameter segment and empty
    // group tables, i.e. an already-programmed device. Group-table count headers seed to 0 unless
    // a test overrides one (the implausible-count case).
    for (let i = 0; i < opts.segmentSize; i++) this.mem.set(this.addrs[OBJ.LSM] + i, 0);
    for (const obj of [OBJ.ADDR, OBJ.ASSOC, OBJ.COMOBJ]) {
      const count = opts.seedTableCount?.[obj] ?? 0;
      this.mem.set(this.addrs[obj], (count >> 8) & 0xff);
      this.mem.set(this.addrs[obj] + 1, count & 0xff);
    }
  }
  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return "MV-07B0"; }
  readsAtRestart = 0;
  async restart() { this.events.push("restart"); this.readsAtRestart = this.reads.length; this.onRestart?.(this.mem); }
  async setVerifyMode() {}
  async tableAddr(obj: number) { return this.addrs[obj] ?? 0; }
  async memRead(addr: number, len: number) {
    this.reads.push({ addr, len });
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0xff;
    return b;
  }
  async writesConfirmed() { return this.confirmed; }
  confirmedWrites() { return []; }
  clearConfirmedWrites() {}
  setExtendedMemoryServices() {}
  acceptUnprovenRestart() {}
  // The stamps the download's closing reads take (PID 27), on a standard-frame device.
  async propValueDataMax() { return this.confirmed ? 50 : 10; }
  async propReadCounted(obj: number, pid: number, start: number, count = 1) { return { objectIndex: obj, pid, count, start, value: Buffer.alloc(8 * count) }; }
  async memWrite(addr: number, data: Buffer, opts: { verify?: boolean; echo?: boolean } = {}) {
    this.events.push("write");
    this.writes.push({ addr, data: Buffer.from(data) });
    for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]);
    if (!this.confirmed && (opts.verify || opts.echo)) { const back = await this.memRead(addr, data.length); if (!back.equals(data)) throw new Error("verify mismatch"); }
  }
  // A segment's bytes as the device currently holds them (for the "actual" MCB CRC).
  segBytes(obj: number, from: number, size: number): Buffer {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = this.mem.get(this.addrs[obj] + from + i) ?? 0;
    return b;
  }
  // The association table described as the long form (PDT_GENERIC_04), as the tables this unit holds.
  async propertyDescription(obj: number, pid: number) { return { objectIndex: obj, pid, propertyIndex: 0, writable: true, pdt: 0x14, maxElements: 1, readLevel: 3, writeLevel: 3 }; }
  // PID 27 answers element by element; an element past the last region answers with nothing.
  async propRead(obj: number, pid: number, start = 1) { return refusedIfEmpty(await this.propertyAnswer(obj, pid, start), obj, pid, start); }
  async propReadIfPresent(obj: number, pid: number, start = 1) { return absentIfEmpty(await this.propertyAnswer(obj, pid, start)); }
  async propertyAnswer(obj: number, pid: number, element = 1) {
    if (pid === PID_LSM) return Buffer.from([this.state.get(obj) ?? STATE.LOADED]);
    if (pid === PID_MCB && obj === OBJ.LSM) {
      if (this.mcb === null) return Buffer.alloc(0); // device declines to report its segment size
      if (this.mcb === "actual") {
        const size = this.mcbRegions[element - 1];
        if (size === undefined) return Buffer.alloc(0);
        const from = this.mcbRegions.slice(0, element - 1).reduce((n, r) => n + r, 0);
        return mcbBuf(size, this.crcFn(this.segBytes(OBJ.LSM, from, size)));
      }
      return element === 1 ? mcbBuf(this.mcb.size, this.mcb.crc) : Buffer.alloc(0);
    }
    if (pid === PID_MCB && this.tableMcb.includes(obj) && element === 1 && this.allocated.has(obj)) {
      const size = this.allocated.get(obj)!;
      return mcbBuf(size, this.crcFn(this.segBytes(obj, 0, size)));
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
        this.allocated.set(obj, size);
        if (fill) for (let i = 0; i < size; i++) this.mem.set(this.addrs[obj] + i, fb);
      }
    }
    return Buffer.alloc(0);
  }
}
const asDev = (m: MockDevice) => m as unknown as KnxDevice;

corpusDescribe("full download against the real M-0162 application", () => {
  const xml = catalogueXml("M-0162_A-0004-11-F245.xml.gz");
  const cfg = parseAppConfig(xml);

  // The images the download must place, built independently of downloadFull for both seeding and
  // assertions. Empty params = the application defaults (the corpus locks that these are the exact
  // bytes ETS computes).
  const params = new Map<string, string>();
  const view = buildDeviceConfig(cfg, params, undefined, []);
  // No group-address links in this download (buildGroupTables([]) below), so every object is unlinked
  // and ETS clears its Communication flag; pass the matching empty linked set.
  const comObjTable = buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set());
  const target = buildRelativeSegmentTarget(cfg, params, 4, { moduleInstances: [] })!; // 4 = OBJ.APP_PROGRAM (LSM 4)
  const { addr: addrTable, assoc: assocTable } = buildGroupTables([]);
  const CRC_AUG = crc16Ccitt(target.bytes);        // thelsing / OpenKNX (augmented)
  const CRC_PLAIN = crc16CcittFalse(target.bytes); // GVS and other CCITT-FALSE firmware
  const activeComObjNums = [...view.imageComObjects.keys()]; // [1..6]

  const mock = (opts: Omit<MockOpts, "segmentSize"> = {}) => new MockDevice({ segmentSize: target.size, ...opts });

  // The context the server hands the profile, with a recording backup hook. The hook logs
  // "backup-persisted" into the SAME event stream the mock records unloads/writes into, so the
  // backup-before-unload ordering is a positive assertion on one timeline (runFlashOp calls
  // persistBackups before any write reaches the device).
  // backupBeforeUnload mirrors the production default (OFF): the pre-unload backup is opt-in, so a test
  // that asserts the backup path must ask for it explicitly. persistBackups is still always called (with
  // an empty list when the backup is off), so the backup-before-unload ORDERING assertions keep a
  // "backup-persisted" marker to anchor on.
  function ctxFor(dev: MockDevice, over: { params?: Map<string, string>; links?: ComObjectLink[]; dryRun?: boolean; backupBeforeUnload?: boolean } = {}) {
    const backups: { file: string; bytes: Buffer }[] = [];
    return {
      backups,
      ctx: {
        deviceId: "d", ia: "1.1.1", appXml: xml,
        params: over.params ?? params,
        links: over.links ?? [],
        moduleInstances: [], dryRun: over.dryRun ?? false,
        backupBeforeUnload: over.backupBeforeUnload ?? false,
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
      const dev = mock();
      const { ctx } = ctxFor(dev, { links: [{ comObjNum: dead, gaRaws: [1] }] });
      const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx).catch((e) => e);
      expect(err?.code).toBe("LINK_COM_OBJECT_INACTIVE");
    });

    test("REFUSES a stored value it cannot place in the image (CHANNEL_MODULES_UNSUPPORTED)", async () => {
      const dev = mock();
      const { ctx } = ctxFor(dev, { params: new Map([["M-0162_A-0004-11-F245_P-not-a-real-ref", "1"]]) });
      const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx).catch((e) => e);
      expect(err?.code).toBe("CHANNEL_MODULES_UNSUPPORTED");
    });

    test("Finding 5a: an already-loaded table with an implausible count REFUSES, never silently skips (GROUP_TABLE_UNREADABLE)", async () => {
      // The com-object table region seeds a 60000-entry count header: the reader's twin refuses this
      // exact condition, and so must the backup, instead of returning size 0 and unloading it anyway.
      const dev = mock({ seedTableCount: { [OBJ.COMOBJ]: 60000 } });
      const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev, { backupBeforeUnload: true }).ctx).catch((e) => e);
      expect(err?.code).toBe("GROUP_TABLE_UNREADABLE");
      // It refused during backup: nothing was unloaded, nothing written.
      expect(dev.events).not.toContain("unload");
      expect(dev.events).not.toContain("write");
    });

    test("Finding 5b: a device that will not report its loaded segment size REFUSES, not backs up a guess (SEGMENT_SIZE_UNKNOWN)", async () => {
      const dev = mock({ mcb: null }); // PID_MCB_TABLE answers < 8 bytes
      const err = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev, { backupBeforeUnload: true }).ctx).catch((e) => e);
      expect(err?.code).toBe("SEGMENT_SIZE_UNKNOWN");
      expect(dev.events).not.toContain("unload");
    });

    test("Finding 5b: the parameter backup is sized from the device's loaded segment (its MCB), NOT the new image", async () => {
      // The device was programmed with a LARGER parameter segment than our new image. Sizing the
      // backup by the image (target.size) would silently omit the tail the unload is about to destroy.
      // The backup must capture the device's full MCB-reported length. (dryRun still runs the whole
      // backup loop, so this asserts the sizing without the slow write/restart bracket.)
      const biggerSize = target.size + 64;
      const dev = mock({ mcb: { size: biggerSize, crc: 0 } });
      const { ctx, backups } = ctxFor(dev, { dryRun: true, backupBeforeUnload: true });
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
      const dev = mock({ mcb: "actual" });
      const { ctx, backups } = ctxFor(dev, { backupBeforeUnload: true });
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
    }, 70_000); // the plan's settle (>=6 s) + reconnectAfterRestart (3 s) are not injectable here

    test("TEETH: an MCB CRC matching NEITHER convention forces the full read-back, which catches a lost write (verified:false)", async () => {
      // The device reports a CRC that is neither the augmented nor the CCITT-FALSE value, AND the
      // restart drops one owned parameter byte. The ONLY thing that can catch this is the full
      // segment read-back the verify must fall back to. If that fallback is removed or inverted to
      // treat a CRC mismatch as a pass, verified flips to true and this test goes red.
      const flip = target.verify.findIndex(Boolean); // an owned + verifiable byte
      const dev = mock({
        mcb: { size: target.size, crc: 0xdead }, // matches neither CRC_AUG nor CRC_PLAIN
        onRestart: (mem) => { mem.set(A[OBJ.LSM] + flip, target.bytes[flip] ^ 0xff); }, // the write did not stick
      });
      // Backup ON so the full-read count is backup(1) + verify-fallback(>=1); the subject is the verify
      // fallback, but the assertion below counts both, matching how this test was authored.
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev, { backupBeforeUnload: true }).ctx);

      expect(res.kind).toBe("flashed");
      if (res.kind !== "flashed") throw new Error("unreachable");
      expect(res.verified).toBe(false); // the corrupted byte was caught by the full read-back, not swallowed

      // Prove the fallback engaged: the full-length segment was read again during verify (backup read
      // plus at least one verify read), not skipped on the strength of the CRC.
      const fullReads = dev.reads.filter((r) => r.addr === A[OBJ.LSM] && r.len === target.size);
      expect(fullReads.length).toBeGreaterThanOrEqual(2);
    }, 100_000);

    // A segment past 0xFFFF on an application without the extended memory services is written with
    // A_UserMemory, which the device reads nothing back with (USER_MEMORY_UNSUPPORTED): no proof, no failure.
    test("a parameter segment its CRC does not prove and that cannot be read back leaves the download unverified", async () => {
      const dev = mock({ mcb: { size: target.size, crc: 0xdead } });
      const read = dev.memRead.bind(dev);
      dev.memRead = async (addr: number, len: number) => {
        if (addr === A[OBJ.LSM]) throw Object.assign(new Error("the read would take A_UserMemory_Read"), { code: "USER_MEMORY_UNSUPPORTED" });
        return read(addr, len);
      };
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx);
      expect(res.kind).toBe("flashed");
      if (res.kind !== "flashed") throw new Error("unreachable");
      expect(res.verified).toBe(false);
      expect(dev.events).toContain("write");
    }, 100_000);

    test("dryRun with backup ON: captures the backup but writes NOTHING to the device", async () => {
      const dev = mock();
      const before = new Map(dev.mem);
      const { ctx, backups } = ctxFor(dev, { dryRun: true, backupBeforeUnload: true });
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx);

      expect(res.kind).toBe("dryRun");
      expect(backups.length).toBe(4);           // the device's four loaded segments were still copied
      expect(dev.events).not.toContain("write"); // ...but nothing was programmed
      expect(dev.events).not.toContain("unload");
      expect(dev.mem).toEqual(before);
    });

    test("DEFAULT (backupBeforeUnload OFF): no pre-unload backup read, yet the download still writes and verifies", async () => {
      // The production default: the full download does NOT read the device's memory back before the
      // unload/rewrite, because the image it writes is derived from the project and reproducible. The
      // ~1800-round-trip parameter read that dominated the wall-clock is gone; the download proceeds and
      // verifies exactly as before. persistBackups is still called (with an EMPTY list) so the ordering
      // hook stays intact.
      const dev = mock({ mcb: "actual" });
      const { ctx, backups } = ctxFor(dev); // backupBeforeUnload defaults to false
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctx);

      expect(res.kind).toBe("flashed");
      if (res.kind !== "flashed") throw new Error("unreachable");
      expect(res.verified).toBe(true);
      expect(backups.length).toBe(0); // nothing was backed up
      // The parameter segment was NOT read at full length before the write (the verify accepts the MCB
      // CRC, so it is not read at full length after either): zero full-segment reads by the download.
      const fullReads = dev.reads.filter((r) => r.addr === A[OBJ.LSM] && r.len === target.size).length;
      expect(fullReads).toBe(0);
      // The download still wrote every segment and did so AFTER the (empty) backup was persisted.
      expect(dev.events[0]).toBe("backup-persisted");
      expect(dev.events).toContain("unload");
      expect(dev.events).toContain("write");
      expect((await dev.memRead(A[OBJ.LSM], target.size)).equals(target.bytes)).toBe(true);
    }, 70_000);

    // The memory-control block of a segment may hold several regions, each with its own CRC (the Jung
    // 400021SE: 7700 bytes and 1; the Theben MIX 2: 1642 and 361). Every region has to be read and
    // match: the first alone covers less than the segment and proves nothing about the rest.
    const twoRegions = [target.size - 1, 1];

    test("a segment the device splits into two MCB regions is proven by both regions' CRCs, without a read-back", async () => {
      const dev = mock({ mcb: "actual", mcbRegions: twoRegions });
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx);
      expect(res.kind === "flashed" && res.verified).toBe(true);
      expect(dev.reads.filter((r) => r.addr === A[OBJ.LSM] && r.len === target.size).length).toBe(0);
    }, 70_000);

    test("TEETH: a lost write in the second MCB region fails that region's CRC, and reading that region back catches it", async () => {
      const last = target.size - 1; // the one byte of the second region
      const dev = mock({
        mcb: "actual", mcbRegions: twoRegions,
        onRestart: (mem) => { mem.set(A[OBJ.LSM] + last, target.bytes[last] ^ 0xff); },
      });
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx);
      expect(res.kind === "flashed" && res.verified).toBe(false);
      // Only the unproven region is read; the first stays proven by its CRC.
      expect(dev.reads.some((r) => r.addr === A[OBJ.LSM] + last && r.len === 1)).toBe(true);
      expect(dev.reads.filter((r) => r.addr === A[OBJ.LSM] && r.len === target.size).length).toBe(0);
    }, 100_000);

    // The reads of the group tables after the restart, i.e. by the verify (the mock reads each echoed
    // write back while the download writes).
    const tableReads = (dev: MockDevice) => dev.reads.slice(dev.readsAtRestart).filter((r) => [A[OBJ.ADDR], A[OBJ.ASSOC], A[OBJ.COMOBJ]].includes(r.addr)).length;

    test("group tables the device proves by their own CRCs are not read back", async () => {
      const dev = mock({ mcb: "actual", tableMcb: true });
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx);
      expect(res.kind === "flashed" && res.verified).toBe(true);
      expect(tableReads(dev)).toBe(0);
    }, 70_000);

    test("a table whose block proves nothing is read back, and a com-object table its CRC proves is not", async () => {
      const dev = mock({ mcb: "actual", tableMcb: [OBJ.ASSOC, OBJ.COMOBJ] }); // no block for the address table
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx);
      expect(res.kind === "flashed" && res.verified).toBe(true);
      const after = dev.reads.slice(dev.readsAtRestart);
      expect(after.some((r) => r.addr === A[OBJ.ADDR])).toBe(true);
      expect(after.some((r) => r.addr === A[OBJ.COMOBJ])).toBe(false);
    }, 70_000);

    test("TEETH: a com-object table that lost a byte fails its CRC, is read back, and fails the verify", async () => {
      const dev = mock({
        mcb: "actual", tableMcb: true,
        onRestart: (mem) => { mem.set(A[OBJ.COMOBJ] + 2, comObjTable[2] ^ 0xff); },
      });
      const res = await classify(cfg).downloadFull(asDev(dev), cfg.mask, ctxFor(dev).ctx);
      expect(res.kind === "flashed" && res.verified).toBe(false);
      expect(tableReads(dev)).toBeGreaterThan(0);
    }, 100_000);
  });

  // The GA flash must rewrite the com-object table (L3), not just the group tables. ETS (and
  // buildComObjectTable) clears the Communication flag on every object WITHOUT a link, so an object
  // unlinked at the last full download holds comm=0 in the device's L3. A GA flash that wrote only the
  // address/association tables and kept that L3 wired the group address to a deaf object: the read-back
  // verified green (the group tables matched) yet the link was functionally dead. Hardware-proven on
  // the GVS AMMA (a status object linked by a GA flash never answered a read nor transmitted; the same
  // object linked by a full download did). This locks the fix: the GA flash rebuilds L3 from the link
  // set and writes L3+L1+L2 in one bracket, WITHOUT touching the parameter image (L4).
  describe("SystemB flashGroupTables rewrites the com-object table for a newly-linked object", () => {
    const profile = classify(cfg);
    const COMM = 1 << 2; // bit 2 of the System B flags byte (comobjbuild.ts)
    const gaCtx = (links: ComObjectLink[]) => ({
      deviceId: "d", ia: "1.1.1", links, params: new Map<string, string>(), baseParams: new Map<string, string>(),
      moduleInstances: [], dryRun: false, persistBackups: () => "backup",
    });
    const commByteOf = (dev: MockDevice, n: number) => dev.mem.get(A[OBJ.COMOBJ] + 2 + (n - 1) * 2) ?? 0; // flags byte of object n

    test("linking a previously-unlinked object sets its Communication flag in the device's L3 (a kept-L3 flash left it a dead link)", async () => {
      const dev = mock();
      // Seed an already-programmed device via a full download with NO links: every object's L3 entry
      // carries comm=0 (unlinked), exactly the state that made the GVS status link dead.
      await profile.downloadFull(asDev(dev), cfg.mask, ctxFor(dev, { links: [] }).ctx);
      const obj = activeComObjNums[0]; // an object this configuration activates
      expect(commByteOf(dev, obj) & COMM).toBe(0); // sanity: unlinked -> comm cleared

      // GA-flash a link onto that object. The fix must lift its comm flag in L3, not keep the stale one.
      const res = await profile.flashGroupTables(asDev(dev), cfg.mask, gaCtx([{ comObjNum: obj, gaRaws: [2305] }]));
      expect(res.kind).toBe("flashed");
      expect((res as { verified: boolean }).verified).toBe(true);
      expect(commByteOf(dev, obj) & COMM).toBe(COMM); // the link now communicates

      // And the whole L3 equals the table independently built for this link set (not the kept one).
      const expected = buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set([obj]));
      const back = await dev.memRead(A[OBJ.COMOBJ], expected.length);
      expect(back.equals(expected)).toBe(true);
    }, 130_000);

    // Writing the tables is not the same as leaving the device working. On the Jung 400021SE (Insta,
    // System B) a table-only GA flash left all three tables LOADED and byte-perfect while the APPLICATION
    // PROGRAM object dropped to ERROR: the device still answered management, so every byte verified green,
    // but it ran no application and every link was dead. The flash now brackets the application object
    // across the rewrite (planSystemBGaFlash holdApplication) AND re-checks its state afterwards, so this
    // failure can never be reported as `verified` again.
    test("an application that stops being LOADED across the flash fails loudly instead of reporting verified", async () => {
      const dev = mock();
      await profile.downloadFull(asDev(dev), cfg.mask, ctxFor(dev, { links: [] }).ctx);
      // The closing restart leaves the application broken (what the unfixed path did on real hardware).
      dev.onRestart = () => { dev.state.set(OBJ.LSM, STATE.ERROR); };
      const flash = profile.flashGroupTables(asDev(dev), cfg.mask, gaCtx([{ comObjNum: activeComObjNums[0], gaRaws: [2305] }]));
      expect(flash).rejects.toThrow(/no longer running its application/);
    }, 160_000);

    test("a device whose application was ALREADY not LOADED gains no new refusal (only a degradation is an error)", async () => {
      const dev = mock();
      await profile.downloadFull(asDev(dev), cfg.mask, ctxFor(dev, { links: [] }).ctx);
      dev.state.set(OBJ.LSM, STATE.UNLOADED); // e.g. a device with no application loaded at all
      const res = await profile.flashGroupTables(asDev(dev), cfg.mask, gaCtx([{ comObjNum: activeComObjNums[0], gaRaws: [2305] }]));
      expect(res.kind).toBe("flashed"); // the tables are still written and checked; the guard stays silent
    }, 130_000);

    test("the parameter segment (L4) is left untouched: this is a surgical link flash, not a full download", async () => {
      const dev = mock();
      await profile.downloadFull(asDev(dev), cfg.mask, ctxFor(dev, { links: [] }).ctx);
      const paramSegBefore = await dev.memRead(A[OBJ.LSM], target.size);
      await profile.flashGroupTables(asDev(dev), cfg.mask, gaCtx([{ comObjNum: activeComObjNums[0], gaRaws: [2305] }]));
      const paramSegAfter = await dev.memRead(A[OBJ.LSM], target.size);
      expect(paramSegAfter.equals(paramSegBefore)).toBe(true); // L4 (the 21601-byte image) never rewritten
    }, 130_000);
  });
});

// Dataless System B RelativeSegment with LdCtrlRelSegment Mode="1" Fill="255" (runs with and without
// the private corpus): ETS pre-fills the segment to 0xFF via allocation and writes only parameter-covered
// octets, keeping 0 in the unowned bits of partially-owned bytes.
describe("System B full download on a dataless RelativeSegment with Fill=255", () => {
  const APP_ID = "M-00A6_A-0025-30-A50D";
  const SEG = `${APP_ID}_RS-04-00000`;
  const SIZE = 128;

  // Parameter layout exercising all cases:
  //   - offset 4, bit 0 (1 bit, value 1): partially-owned byte -> 0x80 (unowned bits stay 0, not 0x7F)
  //   - offset 8, bit 0 (8 bits, value 0): owned zero byte -> 0x00 (must be written over 0xFF fill)
  //   - offset 9, bit 0 (8 bits, value 255): owned 0xFF byte (equals fill; isolated from next non-fill)
  //   - offset 60, bit 0 (8 bits, value 0x12): distant owned byte -> separate write run
  //   - offsets 0..3, 5..7, 10..59, 61..127: unowned -> stay at allocation fill 0xFF and are never written
  // Notice offset 4 and offset 8 are only 3 bytes apart (< FILL_RUN_SKIPPED = 31): unowned offsets 5..7
  // MUST NOT be bridged or written over the bus.
  const synthXml = (opts: { data?: string; mask?: string; mode?: string; fill?: string; preferPartial?: boolean; hiddenVal?: number } = {}) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-00A6"><ApplicationPrograms>
<ApplicationProgram Id="${APP_ID}" ApplicationNumber="37" ApplicationVersion="48" MaskVersion="MV-07B0" MinEtsVersion="5.0" DefaultLanguage="en-US" LoadProcedureStyle="MergedProcedure" Name="DatalessFill">
<Static>
<Code><RelativeSegment Id="${SEG}" Name="Params" Size="${SIZE}" LoadStateMachine="4" Offset="0">${opts.data ? `<Data>${opts.data}</Data>` : ""}${opts.mask ? `<Mask>${opts.mask}</Mask>` : ""}</RelativeSegment></Code>
<ParameterTypes>
  <ParameterType Id="${APP_ID}_PT-1"><TypeNumber SizeInBit="1" Type="unsignedInt" minInclusive="0" maxInclusive="1"/></ParameterType>
  <ParameterType Id="${APP_ID}_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType>
</ParameterTypes>
<Parameters>
  <Parameter Id="${APP_ID}_P-1" Name="bit" ParameterType="${APP_ID}_PT-1" Text="bit" Value="1"><Memory CodeSegment="${SEG}" Offset="4" BitOffset="0"/></Parameter>
  <Parameter Id="${APP_ID}_P-2" Name="zero" ParameterType="${APP_ID}_PT-8" Text="zero" Value="0"><Memory CodeSegment="${SEG}" Offset="8" BitOffset="0"/></Parameter>
  <Parameter Id="${APP_ID}_P-3" Name="ff" ParameterType="${APP_ID}_PT-8" Text="ff" Value="255"><Memory CodeSegment="${SEG}" Offset="9" BitOffset="0"/></Parameter>
  <Parameter Id="${APP_ID}_P-4" Name="far" ParameterType="${APP_ID}_PT-8" Text="far" Value="18"><Memory CodeSegment="${SEG}" Offset="60" BitOffset="0"/></Parameter>
  ${opts.hiddenVal !== undefined ? `<Parameter Id="${APP_ID}_P-5" Name="hid" ParameterType="${APP_ID}_PT-8" Text="hid" Value="${opts.hiddenVal}"><Memory CodeSegment="${SEG}" Offset="20" BitOffset="0"/></Parameter>` : ""}
</Parameters>
<ParameterRefs>
  <ParameterRef Id="${APP_ID}_P-1_R-1" RefId="${APP_ID}_P-1"/>
  <ParameterRef Id="${APP_ID}_P-2_R-2" RefId="${APP_ID}_P-2"/>
  <ParameterRef Id="${APP_ID}_P-3_R-3" RefId="${APP_ID}_P-3"/>
  <ParameterRef Id="${APP_ID}_P-4_R-4" RefId="${APP_ID}_P-4"/>
  ${opts.hiddenVal !== undefined ? `<ParameterRef Id="${APP_ID}_P-5_R-5" RefId="${APP_ID}_P-5"/>` : ""}
</ParameterRefs>
<ComObjectTable><ComObject Id="${APP_ID}_O-1" Name="c1" Text="c1" Number="1" FunctionText="f" ObjectSize="1 Bit" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled"/></ComObjectTable>
<ComObjectRefs><ComObjectRef Id="${APP_ID}_O-1_R-1" RefId="${APP_ID}_O-1"/></ComObjectRefs>
<AddressTable MaxEntries="16"/>
<AssociationTable MaxEntries="16"/>
<LoadProcedures>
  <LoadProcedure MergeId="2">
    <LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="${SIZE}" Mode="${opts.mode ?? "1"}" Fill="${opts.fill ?? "255"}"/>
    <LdCtrlRelSegment AppliesTo="par" LsmIdx="4" Size="${SIZE}" Mode="0" Fill="${opts.fill ?? "255"}"/>
  </LoadProcedure>
  <LoadProcedure MergeId="4"><LdCtrlWriteRelMem AppliesTo="full,par" ObjIdx="4" Offset="0" Size="${SIZE}" Verify="true"/></LoadProcedure>
</LoadProcedures>
<Options DownloadInvisibleParameters="None" SupportsExtendedMemoryServices="true"${opts.preferPartial ? ' PreferPartialDownloadIfApplicationLoaded="true"' : ""}/>
</Static>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${APP_ID}_PB-1" Name="main" Text="Main">
  <ParameterRefRef RefId="${APP_ID}_P-1_R-1"/>
  <ParameterRefRef RefId="${APP_ID}_P-2_R-2"/>
  <ParameterRefRef RefId="${APP_ID}_P-3_R-3"/>
  <ParameterRefRef RefId="${APP_ID}_P-4_R-4"/>
  <ComObjectRefRef RefId="${APP_ID}_O-1_R-1"/>
</ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

  test("fullDownloadParamImage fills unowned bytes only on dataless segments and refuses length mismatch", () => {
    const dataless = parseAppConfig(synthXml());
    const bytes = Buffer.from([0x00, 0x80, 0x00, 0x00, 0x12]);
    const owned = [0, 0x80, 0, 0xff, 0xff];
    expect(fullDownloadParamImage(dataless, { lsm: 4, bytes, owned }, 0xff).toString("hex")).toBe("ff80ff0012");
    expect(fullDownloadParamImage(dataless, { lsm: 4, bytes, owned }, 0x00).toString("hex")).toBe("0080000012");
    expect(() => fullDownloadParamImage(dataless, { lsm: 4, bytes, owned: [0, 0] }, 0xff)).toThrow(/does not match ownership length/);
    // A segment declaring <Data> (with or without <Mask>) keeps target.bytes unchanged.
    const withData = parseAppConfig(synthXml({ data: Buffer.alloc(SIZE, 0x00).toString("base64"), mask: Buffer.alloc(SIZE, 0x00).toString("base64") }));
    expect(fullDownloadParamImage(withData, { lsm: 4, bytes, owned }, 0xff)).toBe(bytes);
  });

  test("planFullDownload allocates Mode=1 Fill=255 and writes only parameter-covered octets, leaving unowned gaps at 0xFF", () => {
    const xml = synthXml();
    const cfg = parseAppConfig(xml);
    const proc = parseLoadProcedures(xml);
    const build = classify(cfg).planFullDownload("MV-07B0", { ia: "1.1.1", params: new Map(), links: [], proc });

    const alloc = build.plan.find((s) => s.op === "alloc" && s.lsm === 4);
    expect(alloc).toEqual({ op: "alloc", lsm: 4, size: SIZE, fill: true, fillByte: 0xff });

    // Only the three non-fill parameter-covered octets are written (offsets 4, 8, 60); the 3-byte unowned
    // gap at 5..7 (< 31 bytes) is NOT bridged, offset 9 (owned 0xFF) is left to the allocation fill, and
    // offset 4 is 0x80 (unowned bits within the partially-owned byte stay 0).
    const l4Writes = build.plan
      .filter((s) => s.op === "writeSegment" && s.lsm === 4)
      .map((s) => (s.op === "writeSegment" ? [s.offset, s.bytes.toString("hex")] : []));
    expect(l4Writes).toEqual([[4, "80"], [8, "00"], [60, "12"]]);

    // The L4 segment image reflects the final device memory: 0xFF outside owned bytes, encoded values inside.
    const l4Seg = build.segments.find((s) => s.lsm === 4)!;
    expect(l4Seg.fillByte).toBe(0xff);
    expect(l4Seg.image.length).toBe(SIZE);
    for (let i = 0; i < SIZE; i++) {
      const want = i === 4 ? 0x80 : i === 8 ? 0x00 : i === 60 ? 0x12 : 0xff;
      expect(l4Seg.image[i]).toBe(want);
    }
  });

  test("partial download form does not apply the full-download fill to hidden-parameter checks", () => {
    const unitMemory = { params: Buffer.alloc(SIZE, 0x00), paramsAt: 0x4000, paramsMcb: null, comObj: Buffer.from([0, 1, 0x00, 0x00]), comObjAt: 0x5200, comObjMcb: null };
    // Full form with Fill=255 refuses hidden default 0 (differs from 0xFF) and accepts 255.
    const xmlZero = synthXml({ preferPartial: true, hiddenVal: 0 });
    const cfgZero = parseAppConfig(xmlZero);
    const procZero = parseLoadProcedures(xmlZero);
    expect(() => classify(cfgZero).planFullDownload("MV-07B0", { ia: "1.1.1", params: new Map(), links: [], proc: procZero }))
      .toThrow(expect.objectContaining({ code: "PARAM_HIDDEN_UNSUPPORTED" }));
    // Partial form keeps the unit's 0x00 bytes, so hidden default 0 matches and builds cleanly.
    expect(() => classify(cfgZero).planFullDownload("MV-07B0", { ia: "1.1.1", params: new Map(), links: [], proc: procZero, unitHoldsApplication: true, unitMemory }))
      .not.toThrow();

    // Conversely, hidden default 255 is accepted by the full form (matches Fill=255) and refused by the partial form.
    const xmlFF = synthXml({ preferPartial: true, hiddenVal: 255 });
    const cfgFF = parseAppConfig(xmlFF);
    const procFF = parseLoadProcedures(xmlFF);
    expect(() => classify(cfgFF).planFullDownload("MV-07B0", { ia: "1.1.1", params: new Map(), links: [], proc: procFF }))
      .not.toThrow();
    expect(() => classify(cfgFF).planFullDownload("MV-07B0", { ia: "1.1.1", params: new Map(), links: [], proc: procFF, unitHoldsApplication: true, unitMemory }))
      .toThrow(expect.objectContaining({ code: "PARAM_HIDDEN_UNSUPPORTED" }));
  });

  test("Mode=0 with <Data> and Fill=255 still writes every byte of the segment whole", () => {
    const data = Buffer.alloc(SIZE, 0xff).toString("base64");
    const xml = synthXml({ data, mode: "0", fill: "255" });
    const cfg = parseAppConfig(xml);
    const proc = parseLoadProcedures(xml);
    const build = classify(cfg).planFullDownload("MV-07B0", { ia: "1.1.1", params: new Map(), links: [], proc });

    const alloc = build.plan.find((s) => s.op === "alloc" && s.lsm === 4);
    expect(alloc).toEqual({ op: "alloc", lsm: 4, size: SIZE, fill: false, fillByte: 0xff });
    const l4Writes = build.plan.filter((s) => s.op === "writeSegment" && s.lsm === 4);
    expect(l4Writes).toHaveLength(1);
    expect(l4Writes[0].op === "writeSegment" ? [l4Writes[0].offset, l4Writes[0].bytes.length] : []).toEqual([0, SIZE]);
  });

  test("downloadFull verifies via the PID 27 MCB CRC fast path when the device pre-fills with 0xFF", async () => {
    const xml = synthXml();
    const cfg = parseAppConfig(xml);
    const dev = new MockDevice({ segmentSize: SIZE, mcb: "actual", tableMcb: true, confirmedWrites: true, crc: crc16CcittFalse });

    const res = await classify(cfg).downloadFull(asDev(dev), "MV-07B0", {
      deviceId: "d", ia: "1.1.1", appXml: xml, params: new Map(), links: [], moduleInstances: [], dryRun: false,
      persistBackups: () => "backup",
    });
    expect(res.kind).toBe("flashed");
    if (res.kind !== "flashed") throw new Error("unreachable");
    expect(res.verified).toBe(true);
    // MCB CRC matched the 0xFF-filled segment without falling back to a full segment read-back.
    expect(dev.reads.filter((r) => r.addr === A[OBJ.LSM] && r.len === SIZE)).toEqual([]);
    const l4Writes = dev.writes.filter((w) => w.addr >= A[OBJ.LSM] && w.addr < A[OBJ.LSM] + SIZE);
    expect(l4Writes.map((w) => [w.addr - A[OBJ.LSM], w.data.toString("hex")])).toEqual([[4, "80"], [8, "00"], [60, "12"]]);
    const finalL4 = dev.segBytes(OBJ.LSM, 0, SIZE);
    expect(finalL4[0]).toBe(0xff);
    expect(finalL4[4]).toBe(0x80);
    expect(finalL4[5]).toBe(0xff);
    expect(finalL4[8]).toBe(0x00);
    expect(finalL4[9]).toBe(0xff);
    expect(finalL4[60]).toBe(0x12);
    expect(finalL4[127]).toBe(0xff);
  }, 30_000);
});
