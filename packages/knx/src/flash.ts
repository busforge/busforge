import { KnxDevice, PID, OBJ } from "./device.ts";
import type { LoadPlan, LoadStep } from "./loadrunner.ts";

// The KNX load procedure (MV-07B0 / System B, property-mapped LSMs). Ported from
// the proven reference; see docs/findings.md for the wire details and gotchas.
//
// SAFETY: a download UNLOADS device segments before rewriting them. A failure
// between unload and load-completed leaves the device "unloaded" (still
// addressable, recoverable by re-flash). Always back up the segments first.

// LSM "load events" written to PID 5 (the value differs from the read-back STATE).
export const LSM = { LOAD: 1, LOAD_COMPLETED: 2, UNLOAD: 4 } as const;
// LSM states read back from PID 5.
export const STATE = { UNLOADED: 0, LOADED: 1, LOADING: 2, ERROR: 3 } as const;

const ev = (e: number) => { const b = Buffer.alloc(10); b[0] = e; return b; };
function allocPayload(size: number, fill: boolean, fillByte = 0): Buffer {
  const b = Buffer.alloc(10);
  b[0] = 0x03; b[1] = 0x0b;          // AdditionalLoadControls: allocate relative segment
  b.writeUInt32BE(size >>> 0, 2);    // size, big-endian
  // The device pre-fills the freshly allocated segment with `fillByte` when doFill is set (thelsing/knx
  // TableObject::additionalLoadControls: `bool doFill = data[6] == 0x1; uint8_t fillByte = data[7]`).
  // A first-time download wants it, so no byte of a previous application survives in a region the
  // new one does not write. A parameter-only download must NOT: it re-writes an existing segment.
  // The fill VALUE is the mask/application's choice, declared in the load procedure's LdCtrlRelSegment
  // (Fill attribute): most System B devices zero the segment (Fill=0), but some fill it with 0xFF (the
  // erased-flash state, Fill=255). It must match what the built image leaves in the bytes it does not
  // own, or the un-written regions read back wrong.
  b[6] = fill ? 1 : 0; b[7] = fillByte & 0xff;
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory-mapped LSM interface (BIM M112 masks MV-0700/0701, PropertyMappedLsms=0).
//
// These devices predate the property-mapped LSMs above: the load CONTROL is an
// A_Memory_Write to StandardMemory 0x0104 with the LSM index in the high nibble of byte[0],
// and the load STATUS is an A_Memory_Read from 46825 + LsmIdx (not a property read of PID 5).
// The load-event values (Load/LoadCompleted/Unload) and states (Unloaded/Loaded/Loading/Error)
// are the SAME as the property variant; only the transport differs. Hardware-confirmed on the
// ABB US/U 4.2 (MV-0701): unload→load→AbsSegment→write→TaskSegment→LoadCompleted drove the
// address-table LSM through Unloaded→Loading→Loaded and read back byte-identical.
const MM_CTRL_ADDR = 0x0104;      // load-control register in StandardMemory
const MM_STATUS_BASE = 46825;     // + LsmIdx -> that LSM's load-status byte
// A memory-mapped load control is an 11-byte payload; the trailing bytes are zero unless the
// specific control (segment/task declaration) fills them.
const mmCtrl = (bytes: number[]): Buffer => { const b = Buffer.alloc(11); bytes.forEach((v, i) => (b[i] = v & 0xff)); return b; };

// Drive an LSM event, over either transport. `memMapped` selects the memory-mapped interface.
export async function lsmEvent(dev: KnxDevice, obj: number, event: number, memMapped = false) {
  if (memMapped) await dev.memWrite(MM_CTRL_ADDR, mmCtrl([(obj << 4) | event]), { verify: false }); // 0x0104 is a control register: it does not read back what was written
  else await dev.propWrite(obj, PID.LOAD_STATE_CONTROL, ev(event));
}
export async function lsmState(dev: KnxDevice, obj: number, memMapped = false) {
  if (memMapped) return (await dev.memRead(MM_STATUS_BASE + obj, 1))[0];
  return (await dev.propRead(obj, PID.LOAD_STATE_CONTROL))[0];
}
export async function allocSegment(dev: KnxDevice, obj: number, size: number, fill = false, fillByte = 0) { await dev.propWrite(obj, PID.LOAD_STATE_CONTROL, allocPayload(size, fill, fillByte)); }

// Declare an ABSOLUTE segment to a memory-mapped LSM (LdCtrlAbsSegment). 11-byte load control:
// [(lsm<<4)|3, segType, 0(segId), address:2 BE, size:2 BE, access, memType, segFlags, 0]. SegType
// 0 = data/code segment. The segment DATA is written separately (a plain memWrite to `address`);
// on these devices that write is implicit in the declared segment when Access != 0.
export async function declareAbsSegmentMM(dev: KnxDevice, lsm: number, segType: number, address: number, size: number, access: number, memType: number, segFlags: number) {
  await dev.memWrite(MM_CTRL_ADDR, mmCtrl([(lsm << 4) | 0x03, segType, 0x00, (address >> 8) & 0xff, address & 0xff, (size >> 8) & 0xff, size & 0xff, access, memType, segFlags, 0x00]), { verify: false });
}
// Declare the TASK segment to a memory-mapped LSM (LdCtrlTaskSegment): SegType 2, the segment
// address, then the application identity the device validates at LoadCompleted (PEI type +
// manufacturer + application number + version). 11-byte load control.
export async function declareTaskSegmentMM(dev: KnxDevice, lsm: number, address: number, peiType: number, manufacturer: number, appNumber: number, version: number) {
  await dev.memWrite(MM_CTRL_ADDR, mmCtrl([(lsm << 4) | 0x03, 0x02, 0x00, (address >> 8) & 0xff, address & 0xff, peiType, (manufacturer >> 8) & 0xff, manufacturer & 0xff, (appNumber >> 8) & 0xff, appNumber & 0xff, version]), { verify: false });
}

// app-id stamp for PID 13: manufacturer(2) + applicationNumber(2) + version(1), big-endian
export function appId(manufacturer: number, appNumber: number, version: number): Buffer {
  return Buffer.from([(manufacturer >> 8) & 0xff, manufacturer & 0xff, (appNumber >> 8) & 0xff, appNumber & 0xff, version & 0xff]);
}

// Group-address downloads as LoadPlans for the generic executor (runLoadPlan). These
// replace the hand-rolled flashGroupTables/flashGroupTablesMv0705 executors that used to
// run here: every device write now goes through one verified engine. They stay in knx
// (not the @busforge/product planner layer) because they are FIXED, application-independent
// LSM brackets and the knx live-flash harness (tools/flashtest.ts) builds them without depending
// on product. Application-driven parameter planners (planAbsoluteParFlash) live in product.

// System B ("relative") group-address download: rewrite the com-object (3), association (2)
// and address (1) tables. The tables sit in relative segments, so each is unloaded and
// re-allocated. The com-object table is rewritten unchanged (a GA edit does not alter it)
// to keep the dependency order valid.
//
// This reproduces the retired flashGroupTables() bracket BYTE-FOR-BYTE on the wire. Its one
// legacy property (vs the asserting parameter bracket) is that Load/LoadCompleted are NOT
// state-asserted inline (assert:false); instead all three tables are checked LOADED in one
// batch at the end (assertLoaded), exactly as the hardware-proven path did. Table writes are
// read-back verified, like every memory write (the old memWrite call verified by default).
// Load+alloc run in the coded order com-obj, addr, assoc; write/complete/check run com-obj,
// assoc, addr.
// `holdApplication`: keep the APPLICATION PROGRAM object (LSM 4) in its own open load bracket while the
// three tables it references are unloaded and rewritten, then close it again so its LoadCompleted
// revalidates against them. Some System B stacks invalidate the running application when a table it
// points at is unloaded underneath it: hardware-proven on the Jung
// 400021SE (Insta), where a table-only GA flash leaves all three tables LOADED and byte-perfect while
// object 4 drops to ERROR and the device communicates on nothing — and no cheap recovery exists (a bare
// LoadCompleted, a LOAD+LoadCompleted and a restart all leave it ERROR; only a full download returns it).
// With the bracket the same flash keeps object 4 LOADED and the re-pointed link answers on the bus
// (proven: new GA answers 0x00, old GA silent, diff 1 byte). LOAD does not free the parameter image (only
// UNLOAD does), so the bracket costs two events and no rewrite. Omitting it reproduces the old table-only
// wire order, which the plan tests pin.
export function planSystemBGaFlash(tables: { addr: Buffer; assoc: Buffer; comObj: Buffer }, requireReboot = true, holdApplication = false): LoadPlan {
  const P = OBJ.APP_PROGRAM, C = OBJ.COMOBJ_TABLE, A = OBJ.ASSOC_TABLE, D = OBJ.ADDR_TABLE;
  return [
    ...(holdApplication ? [{ op: "load", lsm: P, assert: false } as LoadStep] : []),
    { op: "unload", lsm: C }, { op: "unload", lsm: A }, { op: "unload", lsm: D },
    { op: "load", lsm: C, assert: false }, { op: "alloc", lsm: C, size: tables.comObj.length },
    { op: "load", lsm: D, assert: false }, { op: "alloc", lsm: D, size: tables.addr.length },
    { op: "load", lsm: A, assert: false }, { op: "alloc", lsm: A, size: tables.assoc.length },
    { op: "writeSegment", lsm: C, bytes: tables.comObj },
    { op: "writeSegment", lsm: A, bytes: tables.assoc },
    { op: "writeSegment", lsm: D, bytes: tables.addr },
    { op: "loadCompleted", lsm: C, assert: false },
    { op: "loadCompleted", lsm: A, assert: false },
    { op: "loadCompleted", lsm: D, assert: false },
    // Close the application bracket last, so it revalidates against the tables that are now in place.
    // No program-id re-stamp: nothing in this flash touches the application's identity, the device still
    // holds the stamp it was commissioned with, and writing the PROJECT's stamp here would overwrite the
    // one piece of evidence a later parameter flash's declared app-id check relies on (and could make a
    // validating stack reject the LoadCompleted). Hardware-confirmed unnecessary on the Jung 400021SE.
    ...(holdApplication ? [{ op: "loadCompleted", lsm: P, assert: false } as LoadStep] : []),
    { op: "assertLoaded", lsm: C }, { op: "assertLoaded", lsm: A }, { op: "assertLoaded", lsm: D },
    ...(holdApplication ? [{ op: "assertLoaded", lsm: P } as LoadStep] : []),
    // A device that persists at LoadCompleted (e.g. GVS AMMA) writes its tables to flash before the
    // A_Restart and does not reboot in answer to it; requiring a reboot would reject that as
    // RESTART_IGNORED even though the flash succeeded. The caller passes requireReboot=false for those
    // (persistsOnLoadCompleted), mirroring the parameter-flash and full-download paths. The default
    // stays strict so an unproven device that ignores the restart still fails loud.
    { op: "restart", requireReboot },
  ];
}

// MV-0705 (System 7) group-address download: the address (LSM 1) and association (LSM 2)
// tables live at fixed absolute addresses, so unlike System B there is no relative-segment
// alloc and no unload. Per LSM: LOAD -> write the table at its fixed address (read-back
// verified) -> LOAD_COMPLETED, each state-asserted (the engine default), then restart. The
// com-object table (object 3) is left untouched (a GA change does not alter it). Maps to the
// asserting engine bracket with NO behavior delta (the retired flashGroupTablesMv0705 already
// asserted LOADING/LOADED and wrote verified); hardware-verified on TP (M-0081). The
// caller must already be connected (a second T_Connect resets the sequence counter).
// `comObj`: the com-object table of a memory-mapped device, rewritten with the links in the same
// flash so a newly linked object gets its Communication flag. ETS writes it inside an LSM 3
// load/completed bracket with no unload (ABB US/U 4.2 capture, 2026-09-25).
export function planMv0705GaFlash(tables: { addr: Buffer; assoc: Buffer; comObj?: { address: number; bytes: Buffer } }): LoadPlan {
  const D = OBJ.ADDR_TABLE, A = OBJ.ASSOC_TABLE, C = OBJ.COMOBJ_TABLE;
  return [
    { op: "load", lsm: D }, { op: "writeSegment", lsm: D, bytes: tables.addr }, { op: "loadCompleted", lsm: D },
    { op: "load", lsm: A }, { op: "writeSegment", lsm: A, bytes: tables.assoc }, { op: "loadCompleted", lsm: A },
    ...(tables.comObj ? [{ op: "load", lsm: C }, { op: "writeMem", address: tables.comObj.address, bytes: tables.comObj.bytes }, { op: "loadCompleted", lsm: C }] as LoadStep[] : []),
    { op: "restart" },
  ];
}

// Parameter ("par") downloads for BOTH memory models are driven by the generic executor:
// the planners (planRelativeParFlash / planAbsoluteParFlash in @busforge/product) emit a
// LoadPlan and runLoadPlan (loadrunner.ts) executes it. The formerly hardcoded System B
// executor lived here; its proven step order is now the relative planner's output,
// locked call-for-call in flash-exec.test.ts.

// MV-0705 (absolute-segment) parameter downloads are driven by the device's declared
// LoadProcedure: the planner (planAbsoluteParFlash) turns it into a LoadPlan and the
// generic executor (runLoadPlan, loadrunner.ts) runs it. See docs/load-procedures.md.

// LdCtrlCompareProp support: read a declared property and compare it against the
// procedure's expected value (the pre-download hardware/application check ETS runs).
// Trailing-zero padding in the expected value is tolerated: ETS pads InlineData to a
// fixed width while devices return the property's real element size.
export async function compareDeclaredProp(dev: KnxDevice, obj: number, pid: number, expect: Buffer, mask?: Buffer): Promise<{ ok: boolean; got: Buffer }> {
  const got = await dev.propRead(obj, pid);
  // With a mask, only the bytes the mask selects must match (ABB's app-id check masks out the
  // manufacturer + version and compares only the application number). Without one, the read must
  // equal the declared value (a shorter read is accepted only if the missing tail is all zero).
  const ok = mask
    ? got.length >= Math.min(mask.length, expect.length) &&
      Array.from({ length: Math.min(mask.length, expect.length) }).every((_, i) => (got[i] & mask[i]) === (expect[i] & mask[i]))
    : got.equals(expect) ||
      (got.length < expect.length && got.equals(expect.subarray(0, got.length)) && expect.subarray(got.length).every((b) => b === 0));
  return { ok, got };
}

// Split a freshly-filled segment into the runs that actually need writing.
//
// A full download allocates the parameter segment with fill, and the device pre-fills every byte
// with `fillByte` for us (thelsing/knx TableObject::allocTable: `for i < size: _memory.writeMemory(
// addr + i, 1, &fillByte)`). So the only bytes that need to travel over the bus are the ones that
// DIFFER from the fill. On the OpenKNX RaumController's default configuration (fill 0x00) that is 51
// bytes out of 21601, i.e. 0.2%: 22 telegrams instead of 1801. A device that fills with 0xFF instead
// (GVS AMMA) is treated the same way against 0xFF: the manufacturer's default image already carries
// 0xFF in the bytes it leaves untouched, so the run count stays just as small.
//
// This is not a speed optimisation dressed up as a principle. Hammering a small MCU with eighteen
// hundred memory writes is what killed the device three times before this was understood: it
// commits its flash while we keep writing at it, and its watchdog resets it mid-commit, after which
// it discards its whole configuration and comes back factory-fresh. Sending only what carries
// information removes the problem at its root. The device's own CRC over the finished segment
// (readSegmentCrc) still proves every one of the 21601 bytes, so nothing is taken on trust.
//
// Runs are merged across gaps shorter than one telegram: bridging a few fill bytes is cheaper than
// paying for another round trip.
export function sparseRuns(bytes: Buffer, gap = 12, fillByte = 0): { offset: number; bytes: Buffer }[] {
  const runs: { offset: number; bytes: Buffer }[] = [];
  let start = -1, lastKept = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== fillByte) { if (start < 0) start = i; lastKept = i; }
    else if (start >= 0 && i - lastKept >= gap) { runs.push({ offset: start, bytes: bytes.subarray(start, lastKept + 1) }); start = -1; }
  }
  if (start >= 0) runs.push({ offset: start, bytes: bytes.subarray(start, lastKept + 1) });
  return runs;
}

// The System B FULL download: the first-time commissioning of a device, as opposed to the
// parameter-only ("par") download that rewrites an already-programmed one.
//
// The order below is NOT invented. It is the mask's own load procedure, taken from the KNX master
// data (`knx_master.xml`, MaskVersion MV-07B0, Procedure ProcedureType="Load"
// ProcedureSubType="ap1", i.e. a device with a single application program) with the application's
// own LoadProcedure fragments merged into it. The two properties of it that are easy to get wrong,
// and that the device will not warn you about:
//
//   - ALL FOUR load-state machines are open at once. L4 (the application/parameter segment) is
//     opened FIRST and completed FIRST, but L3/L1/L2 are allocated while L4 is still LOADING.
//     Closing L4 early does not fail: it just leaves the tables in a segment nobody allocated.
//   - The application id stamp (PID_PROGRAM_ID) is written BEFORE the LoadCompleted events. It is
//     what a later parameter-only download compares itself against.
//
// The segments' addresses are not known here: the device assigns them during the allocation, and
// `writeSegment` resolves each one through PID_TABLE_REFERENCE at execution time.
export function planSystemBFullDownload(tables: {
  params: Buffer;   // LSM 4, the parameter image
  comObj: Buffer;   // LSM 3, the com-object table (authored, not kept from the device)
  addr: Buffer;     // LSM 1, the group-address table
  assoc: Buffer;    // LSM 2, the association table
  programId: Buffer; // PID 13: manufacturer + application number + version
}, fillByte = 0, requireReboot = true, mcb: { obj: number; element: number; data: Buffer; echoPrefix?: number }[] = []): LoadPlan {
  const P = OBJ.APP_PROGRAM, C = OBJ.COMOBJ_TABLE, A = OBJ.ASSOC_TABLE, D = OBJ.ADDR_TABLE;
  // The memory-control-block entries the application declares (PID 27), written right after the
  // object's allocation as ETS does. They split a segment into regions the device checks at boot;
  // without them the Jung 400021SE keeps one region over its whole parameter segment and refuses
  // its application after the next restart.
  const unplaced = mcb.find((m) => !([P, C, A, D] as number[]).includes(m.obj));
  if (unplaced) throw new Error(`an MCB entry for object ${unplaced.obj}, which this download does not allocate`);
  const mcbFor = (obj: number): LoadStep[] => mcb.filter((m) => m.obj === obj).map((m) => ({ op: "writeProp", obj, pid: PID.MCB_TABLE, start: m.element, data: m.data, echoPrefix: m.echoPrefix }));
  return [
    // The application's load procedure declares `LdCtrlWriteRelMem ... Verify="true"`, and this is
    // what that means: the device answers every memory write with what actually landed. Without
    // it a write that the device drops is silent, and we would find out (if at all) a thousand
    // telegrams later, with no idea which one it was.
    { op: "verifyMode", on: true },
    // Everything goes back to unloaded first: a device that was half-programmed by a previous
    // attempt must not contribute leftovers to this one.
    { op: "unload", lsm: P }, { op: "unload", lsm: C }, { op: "unload", lsm: A }, { op: "unload", lsm: D },
    // All four brackets are opened and allocated before anything is written, which is what the
    // mask's procedure does. The parameter segment asks for fill: a first-time download owns the
    // whole segment, so any byte the new application does not write must be the mask's declared fill
    // (`fillByte`) rather than whatever the previous one left there.
    { op: "load", lsm: P }, { op: "alloc", lsm: P, size: tables.params.length, fill: true, fillByte }, ...mcbFor(P),
    { op: "load", lsm: C, assert: false }, { op: "alloc", lsm: C, size: tables.comObj.length }, ...mcbFor(C),
    { op: "load", lsm: D, assert: false }, { op: "alloc", lsm: D, size: tables.addr.length }, ...mcbFor(D),
    { op: "load", lsm: A, assert: false }, { op: "alloc", lsm: A, size: tables.assoc.length }, ...mcbFor(A),
    // The THREE SMALL TABLES GO FIRST, and the 21601-byte parameter image last. Hardware-found,
    // and the reason is worth writing down because it cost a device: writing the parameter image
    // first leaves the device's flash subsystem with a full erase-block buffer sitting exactly at
    // the boundary the tables land behind, and the table writes that follow are then dropped or
    // kill it outright (it discards its whole configuration on the next boot). Writing the small
    // tables before the long haul avoids that entirely. The load-state brackets are all open
    // either way, so the order of the writes inside them is ours to choose.
    { op: "writeSegment", lsm: C, bytes: tables.comObj, echo: true, verify: false },
    { op: "writeSegment", lsm: A, bytes: tables.assoc, echo: true, verify: false },
    { op: "writeSegment", lsm: D, bytes: tables.addr, echo: true, verify: false },
    // Only the runs that differ from the fill: the allocation above already set every other byte to
    // `fillByte` (see sparseRuns). Every chunk is echo-checked as it is written (verify mode, above),
    // and the device's CRC over the finished segment proves the whole 21601 bytes at the end.
    ...sparseRuns(tables.params, 12, fillByte).map((r): LoadStep => ({ op: "writeSegment", lsm: P, offset: r.offset, bytes: r.bytes, echo: true, verify: false })),
    { op: "stampAppId", lsm: P, data: tables.programId },
    { op: "loadCompleted", lsm: P }, { op: "loadCompleted", lsm: C, assert: false },
    { op: "loadCompleted", lsm: A, assert: false }, { op: "loadCompleted", lsm: D, assert: false },
    // The device believes any table it is handed (thelsing/knx validates nothing on LoadCompleted),
    // so the only proof that the four brackets closed is to read their states back.
    { op: "awaitReady" },
    { op: "assertLoaded", lsm: P }, { op: "assertLoaded", lsm: C },
    { op: "assertLoaded", lsm: A }, { op: "assertLoaded", lsm: D },
    { op: "verifyMode", on: false }, // leave the device as we found it
    // AND NOW LEAVE IT ALONE, or everything above is thrown away.
    //
    // This device does not persist its configuration when it is told the load is complete. It
    // persists it on a TIMER, from its main loop, five seconds after the last time its memory was
    // touched (thelsing/knx Memory::loop: `if (_saveTimeout != 0 && millis() - _saveTimeout > 5000)
    // writeMemory()`), and that deferred save is the only thing that writes the load states and the
    // metadata the device validates on boot. LoadCompleted itself only flushes the flash buffer.
    //
    // Two consequences, and both bit us:
    //   - Restart before the timer expires and the device boots with metadata that never described
    //     the download. It discards everything and comes back factory-fresh, having cheerfully
    //     reported every load state as LOADED a second earlier (those live in RAM).
    //   - The timer is ARMED only when memory is freed (the unloads) and merely REFRESHED by
    //     writes: `if (_saveTimeout != 0) _saveTimeout = millis()`. So if it ever expires DURING
    //     the download, the save fires with every load state still LOADING and then never fires
    //     again. Which is why there is no waiting around between the unloads and here: a pause
    //     longer than five seconds anywhere in the bracket silently costs the whole download.
    { op: "settle", ms: 8000 },
    // And now re-open the link before the restart, because the pause above just killed it.
    //
    // A connection-oriented KNX link dies after SIX seconds of silence. The settle is EIGHT. So the
    // A_Restart that follows was being sent into a connection the device had already torn down: it
    // never arrived, the device never rebooted, and `Memory::writeMemory()` — the ONLY thing on the
    // bus path that writes the flash metadata (the four load states, the table addresses, the
    // individual address) — never ran.
    //
    // Nothing caught it. The device kept running with a perfect configuration in RAM and answered
    // every check afterwards: all four load states LOADED, all three tables byte-identical, its own
    // CRC over the parameter segment matching ours. Every one of those reads was RAM. The device
    // lost the lot the next time it was powered down, and came back factory-fresh.
    { op: "disconnect" }, { op: "connect" },
    { op: "restart", requireReboot },
  ];
}

// The CRC a System B device computes over a loaded segment, and hands out through PID_MCB_TABLE
// (property 27) once the segment is LOADED. This is what the device's own load procedure means by
// `LdCtrlLoadImageProp ObjIdx=4 PropId=27`, and it is how a 21601-byte parameter image is verified
// with ONE property read instead of eighteen hundred memory reads (which, at KNX speeds, is the
// difference between a download that takes two minutes and one that takes ten).
//
// Transcribed from the firmware that produces it (thelsing/knx bits.cpp crc16Ccitt): CRC-16-CCITT,
// polynomial 0x1021, initial value 0xFFFF, over the data followed by 16 zero bits. Written out
// bit by bit exactly as the firmware does it rather than as a table-driven variant, because the
// point is to match that implementation and not a textbook.
export function crc16Ccitt(data: Buffer): number {
  let result = 0xffff;
  const bits = 8 * (data.length + 2); // the trailing two bytes are the appended zeros
  for (let i = 0; i < bits; i++) {
    result = (result << 1) >>> 0;
    const byte = i >> 3;
    const nextBit = byte < data.length ? (data[byte] >> (7 - (i & 7))) & 1 : 0;
    result |= nextBit;
    if (result & 0x10000) result ^= 0x1021;
  }
  return result & 0xffff;
}

// CRC-16/CCITT-FALSE: polynomial 0x1021, initial 0xFFFF, no reflection, and — unlike crc16Ccitt
// above — NO trailing 16-zero-bit augmentation. The two differ only by that augmentation, and both
// are legitimate "CRC-CCITT" conventions: the thelsing/knx firmware (OpenKNX) augments, other System
// B firmware does not. Hardware-confirmed on a GVS K-BUS AMMA-04/06.S, whose PID_MCB_TABLE reports
// exactly crc16CcittFalse(segment) (0xBF5D) over a segment that is byte-identical to ours, where
// crc16Ccitt would read 0xD6EA. So the CRC "mismatch" was a convention difference, not wrong bytes;
// the verify path accepts either value before it falls back to a full read-back.
export function crc16CcittFalse(data: Buffer): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

// Read a loaded segment's size and CRC straight from the device (PID_MCB_TABLE, 8 bytes:
// [size u32 BE][crc control][access][crc16 u16 BE]). The device only answers once the segment is
// LOADED, so this belongs after the load-completed bracket. Returns null when the device declines,
// which the caller must treat as "not verified" and fall back on, never as "verified".
export async function readSegmentCrc(dev: KnxDevice, lsm: number): Promise<{ size: number; crc: number } | null> {
  const mcb = await dev.propRead(lsm, PID.MCB_TABLE);
  if (mcb.length < 8) return null;
  return { size: mcb.readUInt32BE(0), crc: mcb.readUInt16BE(6) };
}
