import { KnxDevice, PID, OBJECT_TYPE_SECURITY } from "./device.ts";
import { lsmEvent, lsmState, allocSegment, declareAbsSegmentMM, declareTaskSegmentMM, declareAbsSegmentProp, declareTaskSegmentProp, taskCtrl1Prop, taskCtrl1MM, taskPtrProp, taskCtrl2Prop, securityLsmEvent, LSM, STATE, LOAD_EVENT_LENGTH } from "./flash.ts";
import { apdu, propertyExtHead, APCI } from "./frame.ts";
import { KnxError } from "./errors.ts";
import { loadedTableAddr } from "./grouptable-read.ts";

// Generic executor for a device's load procedure, expressed as a flat list of typed
// operations (a LoadPlan). The PLANNER (which turns a parsed <LoadProcedure> + built
// segment images + a device read into this list) lives one layer up; this module only
// EXECUTES, so the same runner drives an absolute-segment (MV-0705) or relative-segment
// (System B) download. It reuses the proven LSM helpers in flash.ts.
//
// Every load/loadCompleted asserts the resulting LSM state, so a refused or desynced
// transition stops before the next step instead of writing into a half-open machine.
// Memory writes verify by read-back (memWrite default) unless their step takes the device's answer
// in verify mode instead (withVerifyModeEchoed). On any throw the device is left addressable and
// recoverable (re-run, or ETS full download); the caller backs up first.

export type LoadStep =
  | { op: "connect" }
  | { op: "disconnect" }
  // requireReboot defaults true; false for firmware that persists at LoadCompleted. confirmed: the
  // confirmed restart (A_Restart type 1, erase code 1) instead of the basic one (see KnxDevice.restart).
  | { op: "restart"; requireReboot?: boolean; confirmed?: boolean }
  | { op: "unload"; lsm: number }
  // load/loadCompleted assert the resulting LSM state by default (LOADING / LOADED). A
  // download that historically did NOT assert inline and checked completion only in a
  // final batch (System B group tables) sets assert:false and appends `assertLoaded`
  // steps instead, so the engine reproduces that exact wire order rather than adding
  // inline state reads mid-bracket. (Memory writes stay verified either way.)
  | { op: "load"; lsm: number; assert?: boolean }
  | { op: "loadCompleted"; lsm: number; assert?: boolean }
  | { op: "assertLoaded"; lsm: number }                  // read LSM state, throw unless LOADED (batch completion check)
  | { op: "alloc"; lsm: number; size: number; fill?: boolean; fillByte?: number } // relative-segment allocate; `fill` pre-fills it with `fillByte` (default 0): a full download whose procedure declares the filled allocation does, a par download does not
  // absolute addr, or relative resolved by the planner. `opens`/`closes`: the write stops / lets run again an
  // application outside any load-state machine (a System 1 run error), so a failure between the two leaves
  // the device without a running application, as an open load-state machine does. `verify` and `echo` as
  // on writeSegment.
  | { op: "writeMem"; address: number; bytes: Buffer; opens?: string; closes?: string; verify?: boolean; echo?: boolean }
  // Declare an absolute segment to an LSM (LdCtrlAbsSegment): the segment must be declared to the LSM
  // before its data is written. Written to the memory-mapped control 0x0104, or with `viaProperty` as
  // the LSM's PID 5 write (a property-mapped mask); asserts the LSM stays LOADING (a rejected declaration is an ERROR, and must stop the bracket).
  | { op: "absSegment"; lsm: number; segType: number; address: number; size: number; access: number; memType: number; segFlags: number; viaProperty?: true }
  // Declare the task segment (LdCtrlTaskSegment) with the application identity the device checks
  // at LoadCompleted, over the same transport as absSegment.
  | { op: "taskSegment"; lsm: number; address: number; peiType: number; manufacturer: number; appNumber: number; version: number; viaProperty?: true }
  // LdCtrlTaskCtrl1: the LSM's PID 5 write of 03 04, the address, the count and zero bytes
  // (taskCtrl1Prop), or the same fields in the 0x0104 control of a memory-mapped LSM (taskCtrl1MM).
  // Asserts the LSM stays LOADING, as after a segment declaration.
  | { op: "taskCtrl1"; lsm: number; address: number; count: number }
  // LdCtrlTaskPtr and LdCtrlTaskCtrl2: the LSM's PID 5 write of 03 03 / 03 05 and their four 16-bit fields
  // (taskPtrProp, taskCtrl2Prop), on a property-mapped LSM only. The answer must carry LOADING.
  | { op: "taskPtr"; lsm: number; initPtr: number; savePtr: number; serialPtr: number }
  | { op: "taskCtrl2"; lsm: number; callback: number; address: number; seg0: number; seg1: number }
  // LdCtrlMasterReset: the confirmed A_Restart with the declared erase code and channel, then a new
  // connection to the device (KnxDevice.masterResetAnswered).
  // `mask`: the device's, which it must answer with again on the new connection.
  | { op: "masterReset"; eraseCode: number; channel: number; mask: string }
  // A declared LdCtrlWriteProp inside a load bracket: the property's description read first, then
  // `count` elements from `start` in one write, the data exactly as wide as the description's elements
  // make them; `verify`: the answer must carry the written value, else any answer with as many octets.
  | { op: "declaredWriteProp"; obj: number; pid: number; start: number; count: number; data: Buffer; verify: boolean }
  // Read elements of a property and require an answer (a declared LdCtrlLoadImageProp: the segment
  // stamps, PID 27, after the last LoadCompleted). The values are handed to RunOpts.onRead. `count`
  // elements from `start` (default 1), all of them required; with `elementSize`, as many per request as
  // one response carries on this device, as ETS reads them (one per request on a standard-frame device,
  // Gira M-0008; two in one on the Theben MIX 2 and Jung 400021SE).
  | { op: "readProp"; obj: number; pid: number; start: number; count?: number; elementSize?: number }
  // Write a whole relative segment at its LSM's table address, resolved AT EXECUTION
  // TIME: a relative segment's address is only assigned by the alloc step, so the
  // planner cannot precompute it the way absolute writeMem steps can. Always read-back
  // verified (like every memory write in the engine).
  // `verify: false` skips the per-write read-back of the whole segment. Only ever correct when
  // something else proves the bytes (the full download echo-checks every chunk as it writes it and,
  // after the restart, compares the device's own segment CRCs or reads the segment back); a write
  // nobody verifies is a write that did not happen. `echo`: the device's answer to each write is this
  // write's check, so the device must be in verify mode (the verifyMode op) or take the confirmed write.
  // `offset`: where in the segment these bytes go. A full download whose procedure declares the filled
  // allocation (Mode 1) has the device pre-fill the segment, so only the bytes that differ from the fill
  // need to be sent; an unfilled one (Mode 0) is written whole (see planSystemBFullDownload).
  | { op: "writeSegment"; lsm: number; bytes: Buffer; offset?: number; verify?: boolean; echo?: boolean }
  // A parameter download after a reallocation without fill: if the segment is still where it was
  // (`keptAt`), the device kept its bytes and only those holding an owned bit are written (`owned`,
  // a bit mask per byte), as ETS does; if the allocation moved it, nothing there is the old content,
  // so the whole image is written. Every write is read back before the bracket closes, or with `verify:
  // false` and `echo` taken on the device's answer in verify mode, as on writeSegment.
  | { op: "writeSegmentOwned"; lsm: number; image: Buffer; owned: ReadonlyArray<number>; keptAt: number; verify?: boolean; echo?: boolean }
  // Put the device into (or out of) verify mode, in which it answers every memory write (VERIFY_MODE).
  // On: at the next classic memory write (runSteps), and every classic write after it awaits the answer;
  // a master reset ends the device's mode and the next classic write switches it on again, the closing
  // restart ends it. Off: at once, where the device is in it. withVerifyMode places the step.
  | { op: "verifyMode"; on: boolean }
  // Wait for the device to be able to talk again. After a long segment write it commits its flash,
  // and a small MCU can be gone for seconds doing it. See the executor for why this is not
  // optional.
  | { op: "awaitReady"; tries?: number; delayMs?: number }
  // Leave the device alone for a while. Some devices persist their configuration on a timer from
  // their main loop rather than when they are told to; restarting one before it has had that
  // quiet moment throws the whole download away. See planSystemBFullDownload.
  | { op: "settle"; ms: number }
  // echoPrefix: how many leading bytes of the device's echo must equal `data` (default: all of it).
  // A declared write without verification may come back with fields the device fills itself.
  | { op: "writeProp"; obj: number; pid: number; data: Buffer; start?: number; echoPrefix?: number }
  | { op: "stampAppId"; lsm: number; data: Buffer }       // propWrite(lsm, 13, appId) so loadCompleted validates
  // The Data Secure security object (type 17): a load event whose resulting state is asserted, and a
  // confirmed write of whole elements of one of its properties (see planSecurityObjectLoad).
  // `tolerate`: the return code the load procedure ignores for this write (OnError Ignore); a write
  // with it goes out as one request.
  | { op: "securityLsm"; event: number }
  | { op: "writeSecurityProp"; pid: number; start: number; elementSize: number; data: Buffer; tolerate?: number }
  // An interface object reached by its object type through the extended services (the KNXnet/IP
  // parameter object, type 11): a confirmed write of `count` elements from `start`, which must answer
  // success; a read that must answer the `count` elements (a declared LdCtrlLoadImageProp); a function
  // property command that must answer return code 0.
  | { op: "writePropExt"; objectType: number; instance: number; pid: number; start: number; count: number; data: Buffer }
  | { op: "readPropExt"; objectType: number; instance: number; pid: number; start: number; count: number }
  | { op: "funcPropExt"; objectType: number; instance: number; pid: number; data: Buffer };

export type LoadPlan = LoadStep[];

const stateName = (s: number) => Object.entries(STATE).find(([, v]) => v === s)?.[0] ?? `?${s}`;

// DPT 20.011 (DPT_ErrorClass_System), the type of a load object's PID_ERROR_CODE, as the KNX master
// data names its values. The app's English locale names them alike (errorDetails.lsmErrorClass).
export const ERROR_CLASS_SYSTEM: readonly string[] = [
  "no fault", "general device fault", "communication fault", "configuration fault", "hardware fault",
  "software fault", "insufficient non volatile memory", "insufficient volatile memory",
  "memory allocation command with size 0 received", "CRC error", "watchdog reset detected",
  "invalid opcode detected", "general protection fault", "maximal table length exceeded",
  "undefined load command received", "group address table is not sorted", "invalid connection number (TSAP)",
  "invalid group object number (ASAP)", "group object type exceeds PID_MAX_APDU_LENGTH - 2",
];

// A load-state machine not in the state a step needs. One that went to ERROR keeps the reason in its
// PID_ERROR_CODE (28), read once here; a memory-mapped machine has no such property. The read only adds
// to the refusal: a device without the property, or one that does not answer it, still gets refused.
// The refusal's details carry what the read gave, `lsmErrorCode`: the code, "none" (the device gives
// none) or "unreadable" (it did not answer); the app names the code in the user's language.
async function stateRefusal(dev: KnxDevice, lsm: number, s: number, what: string, memMapped?: boolean): Promise<KnxError> {
  let why = "";
  let lsmErrorCode: number | "none" | "unreadable" | undefined;
  if (s === STATE.ERROR && !memMapped) {
    try {
      const v = await dev.propReadCounted(lsm, PID.ERROR_CODE, 1, 1);
      const code = v.value[0];
      lsmErrorCode = v.count === 0 || code === undefined ? "none" : code;
      why = lsmErrorCode === "none"
        ? "; the device gives no error code for it (PID 28)"
        : `; its error code (PID 28) is ${code}, ${ERROR_CLASS_SYSTEM[lsmErrorCode] ?? "a value DPT 20.011 does not define"}`;
    } catch (e) {
      lsmErrorCode = "unreadable";
      why = `; its error code (PID 28) could not be read: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${lsm} ${what} (got ${stateName(s)})${why}`, lsmErrorCode === undefined ? undefined : { lsmErrorCode });
}

export interface RunOpts {
  onStep?: (i: number, step: LoadStep, total: number) => void;
  // Byte progress within a writeSegment step (a relative segment is one large write,
  // so per-step notification alone would freeze the progress bar for its duration).
  onWrite?: (done: number, total: number) => void;
  // Drive the LSMs over the memory-mapped interface (0x0104 / 46825+lsm) instead of PID-5
  // property writes. Set for the BIM M112 masks MV-0700/0701; false/absent everywhere else.
  memMappedLsms?: boolean;
  // The answer to each readProp step.
  onRead?: (obj: number, pid: number, start: number, data: Buffer) => void;
  // Read the memory of every writeMem step first and write only the bytes that differ, as ETS writes
  // a memory-mapped mask (MV-0700/0701, differingRuns).
  readCompare?: boolean;
  // The bytes each memory write of a writeMem step puts on the bus: the step's bytes, or with
  // `readCompare` the runs that differed.
  onWritten?: (bytes: number) => void;
  // re-read pause after restart is the caller's concern; the runner just fires restart
}

// What ETS writes of `want` on a memory-mapped System 7 device, against what the device holds (`have`,
// read at the same address): it reads the run in blocks of `block` bytes (one A_Memory_Read each) and
// writes, per block, the span from its first to its last differing byte, the equal bytes inside it
// included (its "optimistic write"; ABB US/U 4.2: block 0x6D00 read, 0x6D01-0x6D0B written with four
// equal bytes in it; Theben Meteodata 140 S: of a 1893-byte full download two bytes).
export function differingRuns(address: number, want: Buffer, have: Buffer, block: number): { address: number; bytes: Buffer }[] {
  if (have.length !== want.length) throw new Error(`read ${have.length} of ${want.length} bytes at 0x${address.toString(16)} before writing them; refusing to compare against a partial read`);
  if (!Number.isInteger(block) || block < 1) throw new Error(`a read block of ${block} bytes`);
  const runs: { address: number; bytes: Buffer }[] = [];
  for (let at = 0; at < want.length; at += block) {
    const end = Math.min(at + block, want.length);
    let first = -1, last = -1;
    for (let i = at; i < end; i++) if (want[i] !== have[i]) { if (first < 0) first = i; last = i; }
    if (first >= 0) runs.push({ address: address + first, bytes: Buffer.from(want.subarray(first, last + 1)) });
  }
  return runs;
}

// A download's device control as ETS writes it: where the mask declares verify mode (`declared`, the
// mask's VerifyMode feature in the master data) ETS reads object 0 PID 14 right before its first classic
// memory write and writes it back with bit 2 set, once, and leaves it to the closing restart to clear (04,
// or 05 where the unit reports its application stopped; MEAN WELL KNX-40E-1280D, Theben DALI-Gateway, Gira
// Tastsensor 3, MDT BE-02001.02). Into a unit written with the confirmed extended write (Jung 400021SE,
// Theben MIX 2, GVS AMMA, OpenKNX) and on the memory-mapped masks (ABB US/U 4.2, Theben Meteodata 140 S)
// it writes none: the runner leaves the step out on the former, the latter declare no verify mode. The
// step goes before the plan's first memory write; the runner switches the mode on at the first classic one.
export function withVerifyMode(plan: LoadPlan, declared: boolean): LoadPlan {
  if (!declared) return plan;
  const at = plan.findIndex((st) => st.op === "writeMem" || st.op === "writeSegment" || st.op === "writeSegmentOwned");
  return at < 0 ? plan : [...plan.slice(0, at), { op: "verifyMode", on: true }, ...plan.slice(at)];
}

// A partial download (the parameter, group-address and structural flash) as ETS writes it where the mask
// declares verify mode: the mode switched on as in withVerifyMode, and every memory write taken on the
// device's answer to it alone, not read back (ETS's captures of these downloads: MEAN WELL KNX-40E-1280D
// and Theben DALI-Gateway on System B; Gira Tastsensor 3, MDT BE-02001.02 and BE-06001.02, Theben TheLuxa
// P300 and the Auro presence detector on System 7). Into a unit written with the confirmed extended write
// each chunk's answer is the check, as without this. Where the mask declares none, the plan as it is.
export function withVerifyModeEchoed(plan: LoadPlan, declared: boolean): LoadPlan {
  if (!declared) return plan;
  return withVerifyMode(plan.map((st): LoadStep => (st.op === "writeMem" || st.op === "writeSegment" || st.op === "writeSegmentOwned" ? { ...st, verify: false, echo: true } : st)), true);
}

export async function runLoadPlan(dev: KnxDevice, plan: LoadPlan, opts: RunOpts = {}): Promise<void> {
  // The load-state machines this run has sent an UNLOAD or LOAD to and not yet completed. A failure
  // while any is open may leave the device without a complete application: an event that failed
  // may still have reached the device, so it counts from the moment it is sent.
  const open = new Set<number | string>();
  try { await runSteps(dev, plan, opts, open); }
  catch (e) {
    if (open.size > 0 && e !== null && typeof e === "object" && Object.isExtensible(e)) (e as { leftUnloaded?: boolean }).leftUnloaded = true;
    throw e;
  }
}

// Whether an error broke off a load plan inside its bracket, leaving the device unloaded.
export function leftUnloaded(e: unknown): boolean {
  return e !== null && typeof e === "object" && (e as { leftUnloaded?: unknown }).leftUnloaded === true;
}

// The cEMI length field of a request a plan sends whole, framed as KnxDevice frames it: a property write,
// an extended property write, a function property command (the security load events among them). Null
// for a step whose requests KnxDevice splits, or that sends only short ones.
function wholeRequestLength(step: LoadStep): number | null {
  const ext = propertyExtHead(0, 0, 0).length;
  if (step.op === "writeProp" || step.op === "declaredWriteProp") return apdu(0, APCI.PROPERTY_WRITE, Buffer.alloc(4 + step.data.length)).length - 1;
  if (step.op === "writePropExt") return apdu(0, APCI.PROPERTY_EXT_WRITE_CON, Buffer.alloc(ext + 3 + step.data.length)).length - 1;
  if (step.op === "funcPropExt") return apdu(0, APCI.FUNCTION_PROPERTY_EXT_COMMAND, Buffer.alloc(ext + step.data.length)).length - 1;
  if (step.op === "securityLsm") return apdu(0, APCI.FUNCTION_PROPERTY_EXT_COMMAND, Buffer.alloc(ext + LOAD_EVENT_LENGTH)).length - 1;
  return null;
}

async function runSteps(dev: KnxDevice, plan: LoadPlan, opts: RunOpts, open: Set<number | string>): Promise<void> {
  // Where the device takes standard frames only (a route through a coupler), a request the plan sends
  // whole and that does not fit one is refused before any bus traffic, not part-way through the download.
  for (const step of plan) {
    const n = wholeRequestLength(step);
    if (n !== null) dev.assertFitsRoute?.(n); // optional like interfaceMaxApdu: test doubles of a device leave it out
  }
  // Which write service the device takes is settled before the first load-state event, so a device
  // that does not answer the question is refused before anything is unloaded. A device written with
  // the confirmed extended write is never put into verify mode, and is not read back before the
  // restart: ETS does neither on such devices, and on thelsing/OpenKNX a read before the commit
  // returns the old bytes. The operation's read-back after the restart proves what was stored.
  const writes = plan.some((s) => s.op === "writeSegment" || s.op === "writeMem" || s.op === "verifyMode");
  let confirmed: boolean | undefined;
  // Whether a verifyMode step asked for verify mode, and whether the device is in it. ETS switches it on
  // right before its first classic A_Memory_Write, not before the A_UserMemory writes past 0xFFFF that
  // may come first (bussard's ETS downloads, tools/bussard-user-memory.test.ts); in it the device answers
  // every classic write, and each write takes its answer, so no answer is left behind for a later request
  // to take. A master reset ends the device's mode (it is switched on again at the next classic write), the
  // closing restart ends it.
  let verifyWanted = false, verifying = false;
  const write = async (address: number, bytes: Buffer, o: { verify: boolean; echoChecked?: boolean; onProgress?: (done: number, total: number) => void }, what: string) => {
    const classic = !confirmed && address + bytes.length - 1 <= 0xffff;
    if (classic && verifyWanted && !verifying) { await dev.setVerifyMode(true); verifying = true; }
    if (classic && o.echoChecked && !verifying) throw new Error(`${what}: a write checked by the device's answer, on a device that is not in verify mode`);
    await dev.memWrite(address, bytes, { verify: o.verify, echo: verifying, onProgress: o.onProgress });
  };
  // A readProp that fails is reported when the plan has run to its end: it comes after the last
  // LoadCompleted, and stopping there would leave the new configuration loaded but never restarted.
  let unread: Error | undefined;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (writes && confirmed === undefined && step.op !== "connect" && step.op !== "disconnect") {
      confirmed = await dev.writesConfirmed();
      await dev.interfaceMaxApdu?.(); // asked here, outside the bracket, not at the first write inside it
      // The device control is read where ETS reads it, right before the first classic write inside the
      // bracket, not before: a device that does not report it stops the download there, with its
      // load-state machines unloaded.
      if (!confirmed && opts.memMappedLsms && plan.some((s) => s.op === "verifyMode" && s.on)) {
        throw new Error("verify mode on a device whose LSMs are memory-mapped: its load controls are classic writes nobody awaits the answer of");
      }
    }
    opts.onStep?.(i, step, plan.length);
    switch (step.op) {
      case "connect": await dev.connect(); break;
      case "disconnect": await dev.disconnect(); break;
      case "restart": verifyWanted = verifying = false; await dev.restart(step.requireReboot ?? true, step.confirmed ?? false); break;
      case "unload": {
        open.add(step.lsm);
        await lsmEvent(dev, step.lsm, LSM.UNLOAD, opts.memMappedLsms);
        break;
      }
      case "load": {
        open.add(step.lsm);
        await lsmEvent(dev, step.lsm, LSM.LOAD, opts.memMappedLsms);
        if (step.assert !== false) {
          const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
          if (s !== STATE.LOADING) throw await stateRefusal(dev, step.lsm, s, "not LOADING after LOAD", opts.memMappedLsms);
        }
        break;
      }
      case "alloc": await allocSegment(dev, step.lsm, step.size, step.fill ?? false, step.fillByte ?? 0); break;
      // Declare an absolute segment, then confirm the LSM did not reject it (still LOADING). A
      // rejected declaration flips the LSM to ERROR; carrying on would write data into a machine
      // that will refuse LoadCompleted, so stop here.
      case "absSegment": {
        if (step.viaProperty && opts.memMappedLsms) throw new Error(`LSM ${step.lsm}: an AbsSegment declared as a property write on a device whose LSMs are memory-mapped`);
        await (step.viaProperty ? declareAbsSegmentProp : declareAbsSegmentMM)(dev, step.lsm, step.segType, step.address, step.size, step.access, step.memType, step.segFlags);
        const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
        if (s !== STATE.LOADING) throw await stateRefusal(dev, step.lsm, s, `not LOADING after AbsSegment @${step.address}`, opts.memMappedLsms);
        break;
      }
      case "taskSegment":
        if (step.viaProperty && opts.memMappedLsms) throw new Error(`LSM ${step.lsm}: a TaskSegment declared as a property write on a device whose LSMs are memory-mapped`);
        await (step.viaProperty ? declareTaskSegmentProp : declareTaskSegmentMM)(dev, step.lsm, step.address, step.peiType, step.manufacturer, step.appNumber, step.version);
        break;
      case "taskCtrl1": {
        await (opts.memMappedLsms ? taskCtrl1MM : taskCtrl1Prop)(dev, step.lsm, step.address, step.count);
        const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
        if (s !== STATE.LOADING) throw await stateRefusal(dev, step.lsm, s, "not LOADING after TaskCtrl1", opts.memMappedLsms);
        break;
      }
      case "taskPtr":
      case "taskCtrl2": {
        if (opts.memMappedLsms) throw new Error(`LSM ${step.lsm}: a ${step.op === "taskPtr" ? "TaskPtr" : "TaskCtrl2"} on a device whose LSMs are memory-mapped, which no capture shows encoded`);
        const s = step.op === "taskPtr"
          ? await taskPtrProp(dev, step.lsm, step.initPtr, step.savePtr, step.serialPtr)
          : await taskCtrl2Prop(dev, step.lsm, step.callback, step.address, step.seg0, step.seg1);
        if (s !== STATE.LOADING) throw await stateRefusal(dev, step.lsm, s, `not LOADING after ${step.op === "taskPtr" ? "TaskPtr" : "TaskCtrl2"}`, opts.memMappedLsms);
        break;
      }
      case "masterReset": verifying = false; await dev.masterResetAnswered(step.eraseCode, step.channel, step.mask); break;
      case "declaredWriteProp": {
        const d = await dev.propertyDescription(step.obj, step.pid, 0);
        const size = genericElementSize(d.pdt);
        const at = `object ${step.obj} PID ${step.pid}`;
        if (d.pid === 0) throw new KnxError("PROPERTY_WRITE_REFUSED", `${at}: the device describes no such property, where the load procedure writes it`);
        if (!d.writable) throw new KnxError("PROPERTY_WRITE_REFUSED", `${at}: the device describes the property as not writable, where the load procedure writes it`);
        if (size === null) throw new KnxError("PROPERTY_WRITE_REFUSED", `${at}: the device describes the property with type 0x${d.pdt.toString(16)}, whose element width no capture shows a declared write to take`);
        if (size * step.count !== step.data.length) throw new KnxError("PROPERTY_WRITE_REFUSED", `${at}: the load procedure writes ${step.data.length} octets as ${step.count} element(s), the device's elements are ${size} octets wide; refusing to pad or cut the declared data`);
        if (step.start + step.count - 1 > d.maxElements) throw new KnxError("PROPERTY_WRITE_REFUSED", `${at}: the load procedure writes elements ${step.start}-${step.start + step.count - 1}, the device describes ${d.maxElements}`);
        const echo = await dev.propWrite(step.obj, step.pid, step.data, step.start, step.count);
        if (step.verify ? !echo.equals(step.data) : echo.length !== step.data.length) {
          throw new KnxError("PROPERTY_WRITE_REFUSED", `${at} element ${step.start}: the device answered ${echo.toString("hex") || "nothing"} to a write of ${step.data.toString("hex")}`);
        }
        break;
      }
      case "readProp": {
        try {
          const count = step.count ?? 1;
          const per = step.elementSize ? Math.max(1, Math.floor((await dev.propValueDataMax()) / step.elementSize)) : count;
          for (let at = step.start; at < step.start + count; at += per) {
            const n = Math.min(per, step.start + count - at);
            const v = await dev.propReadCounted(step.obj, step.pid, at, n);
            if (v.count !== n) throw new KnxError("PROPERTY_READ_EMPTY", `object ${step.obj} PID ${step.pid} element ${at}: the device answered with ${v.count} element(s), where the load procedure reads ${n}`);
            opts.onRead?.(step.obj, step.pid, at, v.value);
          }
        } catch (e) { unread ??= e instanceof Error ? e : new KnxError("PROPERTY_READ_EMPTY", String(e)); }
        break;
      }
      case "writeMem": {
        if (step.opens) open.add(step.opens);
        const checked = { verify: step.verify ?? true, echoChecked: step.echo };
        if (!opts.readCompare) { await write(step.address, step.bytes, checked, `memory at 0x${step.address.toString(16)}`); opts.onWritten?.(step.bytes.length); if (step.closes) open.delete(step.closes); break; }
        const block = await dev.classicReadChunk();
        const have = await dev.memRead(step.address, step.bytes.length, block);
        for (const r of differingRuns(step.address, step.bytes, have, block)) { await write(r.address, r.bytes, checked, `memory at 0x${r.address.toString(16)}`); opts.onWritten?.(r.bytes.length); }
        if (step.closes) open.delete(step.closes);
        break;
      }
      case "settle": await new Promise((r) => setTimeout(r, step.ms)); break;
      case "verifyMode":
        if (confirmed) break;
        if (step.on) verifyWanted = true;
        else { if (verifying) await dev.setVerifyMode(false); verifyWanted = verifying = false; }
        break;
      // HARDWARE-FOUND, and it cost a device twice before it was understood. After ~21 kB of
      // memory writes an RP2040-class device commits its flash, and while it does that it services
      // nothing: no T_ACK, no response. The request machine gives up after three attempts (about
      // 4.5 s) and the next step then hammers a device that is simply busy, until its watchdog
      // resets it mid-commit and it discards its whole configuration on the next boot.
      //
      // So wait for it, with a real budget, and re-establish the connection each time (a device
      // that was away has dropped ours). Failing here is honest: the device never came back.
      // Each try closes the connection before it opens one, the first try the one the download ran
      // on: thelsing/knx (the OpenKNX RaumController) takes a T_Connect from the partner it is connected
      // to as nothing, keeps that connection's sequence numbers and refuses every request of a new one
      // with T_NAK.
      case "awaitReady": {
        const tries = step.tries ?? 12, delayMs = step.delayMs ?? 2000;
        let lastErr: unknown;
        for (let i = 0; i < tries; i++) {
          try { await dev.disconnect(); await dev.connect(); await dev.deviceDescriptor(); lastErr = undefined; break; }
          catch (e) {
            lastErr = e;
            if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        if (lastErr) {
          // A stalled or closed link to the interface says nothing about the device.
          if (lastErr instanceof KnxError && (lastErr.code === "TUNNEL_CON_TIMEOUT" || lastErr.code === "TUNNEL_CLOSED")) throw lastErr;
          // A device that answers with another service is back, but not as asked: say that.
          if (lastErr instanceof KnxError && lastErr.code === "ANSWER_SERVICE_MISMATCH") throw lastErr;
          throw new KnxError("DEVICE_NOT_ANSWERING",
            `the device stopped answering after a segment write and did not come back within ${Math.round((tries * (delayMs + 4500)) / 1000)} s; it may be committing its flash, or it may have reset`);
        }
        break;
      }
      // loadedTableAddr, not tableAddr: a load-state machine whose allocation failed still reports
      // its table reference as 0, and writing a 21601-byte parameter image over the bottom of the
      // device's memory is not something to discover later from a failed assert.
      case "writeSegmentOwned": {
        const at = await loadedTableAddr(dev, step.lsm, `load-state machine ${step.lsm}`);
        const runs = at === step.keptAt ? ownedRuns(step.image, step.owned) : [{ offset: 0, bytes: step.image }];
        for (const r of runs) await write(at + r.offset, r.bytes, { verify: step.verify ?? true, echoChecked: step.echo, onProgress: opts.onWrite }, `LSM ${step.lsm}`);
        break;
      }
      case "writeSegment": await write((await loadedTableAddr(dev, step.lsm, `load-state machine ${step.lsm}`)) + (step.offset ?? 0), step.bytes, { verify: step.verify ?? true, echoChecked: step.echo, onProgress: opts.onWrite }, `LSM ${step.lsm}`); break;
      // The device echoes what it stored; a declined write answers with nothing (or something else),
      // and carrying on would leave e.g. an MCB region the device never took.
      case "writeProp": {
        const echo = await dev.propWrite(step.obj, step.pid, step.data, step.start ?? 1);
        const n = step.echoPrefix ?? step.data.length;
        if (echo.length < n || !echo.subarray(0, n).equals(step.data.subarray(0, n))) {
          throw new KnxError("PROPERTY_WRITE_REFUSED", `object ${step.obj} PID ${step.pid} element ${step.start ?? 1}: the device answered ${echo.toString("hex") || "nothing"} to a write of ${step.data.toString("hex")}`);
        }
        break;
      }
      case "stampAppId": await dev.propWrite(step.lsm, PID.PROGRAM_ID, step.data); break;
      case "securityLsm": {
        if (step.event !== LSM.LOAD_COMPLETED) open.add("security");
        await securityLsmEvent(dev, step.event);
        if (step.event === LSM.LOAD_COMPLETED) open.delete("security");
        break;
      }
      case "writeSecurityProp":
        if (step.tolerate === undefined) await dev.propExtWriteElements(OBJECT_TYPE_SECURITY, 1, step.pid, step.start, step.elementSize, step.data);
        else await dev.propExtWriteCon(OBJECT_TYPE_SECURITY, 1, step.pid, step.data, step.start, step.data.length / step.elementSize, step.tolerate);
        break;
      case "writePropExt": await dev.propExtWriteCon(step.objectType, step.instance, step.pid, step.data, step.start, step.count); break;
      // Reported at the plan's end, like readProp: the read comes after the last load completion.
      case "readPropExt": {
        try {
          const v = await dev.propExtRead(step.objectType, step.instance, step.pid, step.start, step.count);
          opts.onRead?.(step.objectType, step.pid, step.start, v);
        }
        catch (e) { unread ??= e instanceof Error ? e : new KnxError("PROPERTY_EXT_READ_REFUSED", String(e)); }
        break;
      }
      case "funcPropExt": {
        const { returnCode, result } = await dev.funcPropExtCommand(step.objectType, step.instance, step.pid, step.data);
        if (returnCode !== 0) throw new KnxError("FUNCTION_PROPERTY_REFUSED", `object type ${step.objectType} PID ${step.pid}: the device answered return code 0x${returnCode.toString(16)} (${result.toString("hex") || "no data"}) to ${step.data.toString("hex")}`);
        break;
      }
      case "loadCompleted": {
        await lsmEvent(dev, step.lsm, LSM.LOAD_COMPLETED, opts.memMappedLsms);
        if (step.assert !== false) {
          const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
          if (s !== STATE.LOADED) throw await stateRefusal(dev, step.lsm, s, "not LOADED after LOAD_COMPLETED", opts.memMappedLsms);
          open.delete(step.lsm);
        }
        break;
      }
      case "assertLoaded": {
        const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
        if (s !== STATE.LOADED) throw await stateRefusal(dev, step.lsm, s, "not LOADED", opts.memMappedLsms);
        open.delete(step.lsm);
        break;
      }
    }
  }
  if (unread !== undefined) throw unread;
}

// The element width of a generic property data type (PDT_GENERIC_01 0x11 to PDT_GENERIC_20 0x24: 1 to 20
// octets), null for any other type.
const genericElementSize = (pdt: number): number | null => (pdt >= 0x11 && pdt <= 0x24 ? pdt - 0x10 : null);

// The runs of consecutive bytes that hold an owned bit.
export function ownedRuns(image: Buffer, owned: ReadonlyArray<number>): { offset: number; bytes: Buffer }[] {
  const runs: { offset: number; bytes: Buffer }[] = [];
  for (let i = 0; i < image.length; ) {
    if (!owned[i]) { i++; continue; }
    const start = i;
    while (i < image.length && owned[i]) i++;
    runs.push({ offset: start, bytes: Buffer.from(image.subarray(start, i)) });
  }
  return runs;
}
