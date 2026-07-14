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

export async function lsmEvent(dev: KnxDevice, obj: number, event: number) { await dev.propWrite(obj, PID.LOAD_STATE_CONTROL, ev(event)); }
export async function lsmState(dev: KnxDevice, obj: number) { return (await dev.propRead(obj, PID.LOAD_STATE_CONTROL))[0]; }
export async function allocSegment(dev: KnxDevice, obj: number, size: number, fill = false, fillByte = 0) { await dev.propWrite(obj, PID.LOAD_STATE_CONTROL, allocPayload(size, fill, fillByte)); }

// app-id stamp for PID 13: manufacturer(2) + applicationNumber(2) + version(1), big-endian
export function appId(manufacturer: number, appNumber: number, version: number): Buffer {
  return Buffer.from([(manufacturer >> 8) & 0xff, manufacturer & 0xff, (appNumber >> 8) & 0xff, appNumber & 0xff, version & 0xff]);
}

// Group-address downloads as LoadPlans for the generic executor (runLoadPlan). These
// replace the hand-rolled flashGroupTables/flashGroupTablesMv0705 executors that used to
// run here: every device write now goes through one verified engine. They stay in knx
// (not the @busforge/product planner layer) because they are FIXED, application-independent
// LSM brackets and the knx live-flash harness (flashtest.ts) builds them without depending
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
export function planSystemBGaFlash(tables: { addr: Buffer; assoc: Buffer; comObj: Buffer }): LoadPlan {
  const C = OBJ.COMOBJ_TABLE, A = OBJ.ASSOC_TABLE, D = OBJ.ADDR_TABLE;
  return [
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
    { op: "assertLoaded", lsm: C }, { op: "assertLoaded", lsm: A }, { op: "assertLoaded", lsm: D },
    { op: "restart" },
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
export function planMv0705GaFlash(tables: { addr: Buffer; assoc: Buffer }): LoadPlan {
  const D = OBJ.ADDR_TABLE, A = OBJ.ASSOC_TABLE;
  return [
    { op: "load", lsm: D }, { op: "writeSegment", lsm: D, bytes: tables.addr }, { op: "loadCompleted", lsm: D },
    { op: "load", lsm: A }, { op: "writeSegment", lsm: A, bytes: tables.assoc }, { op: "loadCompleted", lsm: A },
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
export async function compareDeclaredProp(dev: KnxDevice, obj: number, pid: number, expect: Buffer): Promise<{ ok: boolean; got: Buffer }> {
  const got = await dev.propRead(obj, pid);
  const ok =
    got.equals(expect) ||
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
}, fillByte = 0): LoadPlan {
  const P = OBJ.APP_PROGRAM, C = OBJ.COMOBJ_TABLE, A = OBJ.ASSOC_TABLE, D = OBJ.ADDR_TABLE;
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
    { op: "load", lsm: P }, { op: "alloc", lsm: P, size: tables.params.length, fill: true, fillByte },
    { op: "load", lsm: C, assert: false }, { op: "alloc", lsm: C, size: tables.comObj.length },
    { op: "load", lsm: D, assert: false }, { op: "alloc", lsm: D, size: tables.addr.length },
    { op: "load", lsm: A, assert: false }, { op: "alloc", lsm: A, size: tables.assoc.length },
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
    { op: "restart" },
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

// Read a loaded segment's size and CRC straight from the device (PID_MCB_TABLE, 8 bytes:
// [size u32 BE][crc control][access][crc16 u16 BE]). The device only answers once the segment is
// LOADED, so this belongs after the load-completed bracket. Returns null when the device declines,
// which the caller must treat as "not verified" and fall back on, never as "verified".
export async function readSegmentCrc(dev: KnxDevice, lsm: number): Promise<{ size: number; crc: number } | null> {
  const mcb = await dev.propRead(lsm, PID.MCB_TABLE);
  if (mcb.length < 8) return null;
  return { size: mcb.readUInt32BE(0), crc: mcb.readUInt16BE(6) };
}
