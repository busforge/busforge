import { KnxDevice, PID, OBJ } from "./device.ts";
import type { LoadPlan } from "./loadrunner.ts";

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
function allocPayload(size: number): Buffer {
  const b = Buffer.alloc(10);
  b[0] = 0x03; b[1] = 0x0b;          // AdditionalLoadControls: allocate relative segment
  b.writeUInt32BE(size >>> 0, 2);    // size, big-endian
  b[6] = 0; b[7] = 0;                // mode, fill
  return b;
}

export async function lsmEvent(dev: KnxDevice, obj: number, event: number) { await dev.propWrite(obj, PID.LOAD_STATE_CONTROL, ev(event)); }
export async function lsmState(dev: KnxDevice, obj: number) { return (await dev.propRead(obj, PID.LOAD_STATE_CONTROL))[0]; }
export async function allocSegment(dev: KnxDevice, obj: number, size: number) { await dev.propWrite(obj, PID.LOAD_STATE_CONTROL, allocPayload(size)); }

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
