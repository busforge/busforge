import { KnxDevice, PID, OBJECT_TYPE_SECURITY } from "./device.ts";
import { lsmEvent, lsmState, allocSegment, declareAbsSegmentMM, declareTaskSegmentMM, declareAbsSegmentProp, declareTaskSegmentProp, taskCtrl1Prop, taskCtrl1MM, securityLsmEvent, LSM, STATE } from "./flash.ts";
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
// Memory writes verify by read-back (memWrite default). On any throw the device is left
// addressable and recoverable (re-run, or ETS full download); the caller backs up first.

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
  | { op: "alloc"; lsm: number; size: number; fill?: boolean; fillByte?: number } // relative-segment allocate; `fill` pre-fills it with `fillByte` (default 0) — a full download does, a par download does not
  | { op: "writeMem"; address: number; bytes: Buffer }   // absolute addr, or relative resolved by the planner
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
  // something else proves the bytes (the full download echo-checks every chunk as it writes it and
  // then compares the device's own segment CRC); a write nobody verifies is a write that did not
  // happen. `echo` requires the device to be in verify mode (see the verifyMode op).
  // `offset`: where in the segment these bytes go. A full download allocates the segment with
  // fill, so the device has already zeroed it and only the bytes that are NOT zero need to be
  // sent (see planSystemBFullDownload).
  | { op: "writeSegment"; lsm: number; bytes: Buffer; offset?: number; verify?: boolean; echo?: boolean }
  // A parameter download after a reallocation without fill: if the segment is still where it was
  // (`keptAt`), the device kept its bytes and only those holding an owned bit are written (`owned`,
  // a bit mask per byte), as ETS does; if the allocation moved it, nothing there is the old content,
  // so the whole image is written. Every write is read back before the bracket closes.
  | { op: "writeSegmentOwned"; lsm: number; image: Buffer; owned: ReadonlyArray<number>; keptAt: number }
  // Put the device into (or out of) verify mode, in which it answers every memory write with what
  // actually landed in its memory. A download's `LdCtrlWriteRelMem Verify="true"` asks for this.
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
  | { op: "securityLsm"; event: number }
  | { op: "writeSecurityProp"; pid: number; start: number; elementSize: number; data: Buffer };

export type LoadPlan = LoadStep[];

const stateName = (s: number) => Object.entries(STATE).find(([, v]) => v === s)?.[0] ?? `?${s}`;

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
  // re-read pause after restart is the caller's concern; the runner just fires restart
}

export async function runLoadPlan(dev: KnxDevice, plan: LoadPlan, opts: RunOpts = {}): Promise<void> {
  // The load-state machines this run has sent an UNLOAD or LOAD to and not yet completed. A failure
  // while any is open may leave the device without a complete application: an event that failed
  // may still have reached the device, so it counts from the moment it is sent.
  const open = new Set<number | "security">();
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

async function runSteps(dev: KnxDevice, plan: LoadPlan, opts: RunOpts, open: Set<number | "security">): Promise<void> {
  // Which write service the device takes is settled before the first load-state event, so a device
  // that does not answer the question is refused before anything is unloaded. A device written with
  // the confirmed extended write is never put into verify mode, and is not read back before the
  // restart: ETS does neither on such devices, and on thelsing/OpenKNX a read before the commit
  // returns the old bytes. The operation's read-back after the restart proves what was stored.
  const writes = plan.some((s) => s.op === "writeSegment" || s.op === "writeMem" || s.op === "verifyMode");
  let confirmed: boolean | undefined;
  // A readProp that fails is reported when the plan has run to its end: it comes after the last
  // LoadCompleted, and stopping there would leave the new configuration loaded but never restarted.
  let unread: Error | undefined;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (writes && confirmed === undefined && step.op !== "connect" && step.op !== "disconnect") confirmed = await dev.writesConfirmed();
    opts.onStep?.(i, step, plan.length);
    switch (step.op) {
      case "connect": await dev.connect(); break;
      case "disconnect": await dev.disconnect(); break;
      case "restart": await dev.restart(step.requireReboot ?? true, step.confirmed ?? false); break;
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
          if (s !== STATE.LOADING) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADING after LOAD (got ${stateName(s)})`);
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
        if (s !== STATE.LOADING) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADING after AbsSegment @${step.address} (got ${stateName(s)})`);
        break;
      }
      case "taskSegment":
        if (step.viaProperty && opts.memMappedLsms) throw new Error(`LSM ${step.lsm}: a TaskSegment declared as a property write on a device whose LSMs are memory-mapped`);
        await (step.viaProperty ? declareTaskSegmentProp : declareTaskSegmentMM)(dev, step.lsm, step.address, step.peiType, step.manufacturer, step.appNumber, step.version);
        break;
      case "taskCtrl1": {
        await (opts.memMappedLsms ? taskCtrl1MM : taskCtrl1Prop)(dev, step.lsm, step.address, step.count);
        const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
        if (s !== STATE.LOADING) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADING after TaskCtrl1 (got ${stateName(s)})`);
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
      case "writeMem": await dev.memWrite(step.address, step.bytes, { verify: true }); break;
      case "settle": await new Promise((r) => setTimeout(r, step.ms)); break;
      case "verifyMode": if (!confirmed) await dev.setVerifyMode(step.on); break;
      // HARDWARE-FOUND, and it cost a device twice before it was understood. After ~21 kB of
      // memory writes an RP2040-class device commits its flash, and while it does that it services
      // nothing: no T_ACK, no response. The request machine gives up after three attempts (about
      // 4.5 s) and the next step then hammers a device that is simply busy, until its watchdog
      // resets it mid-commit and it discards its whole configuration on the next boot.
      //
      // So wait for it, with a real budget, and re-establish the connection each time (a device
      // that was away has dropped ours). Failing here is honest: the device never came back.
      case "awaitReady": {
        const tries = step.tries ?? 12, delayMs = step.delayMs ?? 2000;
        let lastErr: unknown;
        for (let i = 0; i < tries; i++) {
          try { await dev.connect(); await dev.deviceDescriptor(); lastErr = undefined; break; }
          catch (e) {
            lastErr = e;
            try { await dev.disconnect(); } catch { /* it was never up */ }
            if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        if (lastErr) {
          // A stalled or closed link to the interface says nothing about the device.
          if (lastErr instanceof KnxError && (lastErr.code === "TUNNEL_CON_TIMEOUT" || lastErr.code === "TUNNEL_CLOSED")) throw lastErr;
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
        for (const r of runs) await dev.memWrite(at + r.offset, r.bytes, { verify: true, onProgress: opts.onWrite });
        break;
      }
      case "writeSegment": await dev.memWrite((await loadedTableAddr(dev, step.lsm, `load-state machine ${step.lsm}`)) + (step.offset ?? 0), step.bytes, { verify: step.verify ?? true, echo: step.echo, onProgress: opts.onWrite }); break;
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
      case "writeSecurityProp": await dev.propExtWriteElements(OBJECT_TYPE_SECURITY, 1, step.pid, step.start, step.elementSize, step.data); break;
      case "loadCompleted": {
        await lsmEvent(dev, step.lsm, LSM.LOAD_COMPLETED, opts.memMappedLsms);
        if (step.assert !== false) {
          const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
          if (s !== STATE.LOADED) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADED after LOAD_COMPLETED (got ${stateName(s)})`);
          open.delete(step.lsm);
        }
        break;
      }
      case "assertLoaded": {
        const s = await lsmState(dev, step.lsm, opts.memMappedLsms);
        if (s !== STATE.LOADED) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADED (got ${stateName(s)})`);
        open.delete(step.lsm);
        break;
      }
    }
  }
  if (unread !== undefined) throw unread;
}

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
