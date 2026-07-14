import { KnxDevice, PID } from "./device.ts";
import { lsmEvent, lsmState, allocSegment, LSM, STATE } from "./flash.ts";
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
  | { op: "restart"; requireReboot?: boolean } // requireReboot defaults true; false for firmware that persists at LoadCompleted (see KnxDevice.restart)
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
  | { op: "writeProp"; obj: number; pid: number; data: Buffer }
  | { op: "stampAppId"; lsm: number; data: Buffer };      // propWrite(lsm, 13, appId) so loadCompleted validates

export type LoadPlan = LoadStep[];

const stateName = (s: number) => Object.entries(STATE).find(([, v]) => v === s)?.[0] ?? `?${s}`;

export interface RunOpts {
  onStep?: (i: number, step: LoadStep, total: number) => void;
  // Byte progress within a writeSegment step (a relative segment is one large write,
  // so per-step notification alone would freeze the progress bar for its duration).
  onWrite?: (done: number, total: number) => void;
  // re-read pause after restart is the caller's concern; the runner just fires restart
}

export async function runLoadPlan(dev: KnxDevice, plan: LoadPlan, opts: RunOpts = {}): Promise<void> {
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    opts.onStep?.(i, step, plan.length);
    switch (step.op) {
      case "connect": await dev.connect(); break;
      case "disconnect": await dev.disconnect(); break;
      case "restart": await dev.restart(step.requireReboot ?? true); break;
      case "unload": {
        await lsmEvent(dev, step.lsm, LSM.UNLOAD);
        break;
      }
      case "load": {
        await lsmEvent(dev, step.lsm, LSM.LOAD);
        if (step.assert !== false) {
          const s = await lsmState(dev, step.lsm);
          if (s !== STATE.LOADING) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADING after LOAD (got ${stateName(s)})`);
        }
        break;
      }
      case "alloc": await allocSegment(dev, step.lsm, step.size, step.fill ?? false, step.fillByte ?? 0); break;
      case "writeMem": await dev.memWrite(step.address, step.bytes, { verify: true }); break;
      case "settle": await new Promise((r) => setTimeout(r, step.ms)); break;
      case "verifyMode": await dev.setVerifyMode(step.on); break;
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
          throw new KnxError("DEVICE_NOT_ANSWERING",
            `the device stopped answering after a segment write and did not come back within ${Math.round((tries * (delayMs + 4500)) / 1000)} s; it may be committing its flash, or it may have reset`);
        }
        break;
      }
      // loadedTableAddr, not tableAddr: a load-state machine whose allocation failed still reports
      // its table reference as 0, and writing a 21601-byte parameter image over the bottom of the
      // device's memory is not something to discover later from a failed assert.
      case "writeSegment": await dev.memWrite((await loadedTableAddr(dev, step.lsm, `load-state machine ${step.lsm}`)) + (step.offset ?? 0), step.bytes, { verify: step.verify ?? true, echo: step.echo, onProgress: opts.onWrite }); break;
      case "writeProp": await dev.propWrite(step.obj, step.pid, step.data); break;
      case "stampAppId": await dev.propWrite(step.lsm, PID.PROGRAM_ID, step.data); break;
      case "loadCompleted": {
        await lsmEvent(dev, step.lsm, LSM.LOAD_COMPLETED);
        if (step.assert !== false) {
          const s = await lsmState(dev, step.lsm);
          if (s !== STATE.LOADED) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADED after LOAD_COMPLETED (got ${stateName(s)})`);
        }
        break;
      }
      case "assertLoaded": {
        const s = await lsmState(dev, step.lsm);
        if (s !== STATE.LOADED) throw new KnxError("LOAD_STATE_UNEXPECTED", `LSM ${step.lsm} not LOADED (got ${stateName(s)})`);
        break;
      }
    }
  }
}
