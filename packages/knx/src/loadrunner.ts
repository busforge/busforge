import { KnxDevice, PID } from "./device.ts";
import { lsmEvent, lsmState, allocSegment, LSM, STATE } from "./flash.ts";

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
  | { op: "restart" }
  | { op: "unload"; lsm: number }
  // load/loadCompleted assert the resulting LSM state by default (LOADING / LOADED). A
  // download that historically did NOT assert inline and checked completion only in a
  // final batch (System B group tables) sets assert:false and appends `assertLoaded`
  // steps instead, so the engine reproduces that exact wire order rather than adding
  // inline state reads mid-bracket. (Memory writes stay verified either way.)
  | { op: "load"; lsm: number; assert?: boolean }
  | { op: "loadCompleted"; lsm: number; assert?: boolean }
  | { op: "assertLoaded"; lsm: number }                  // read LSM state, throw unless LOADED (batch completion check)
  | { op: "alloc"; lsm: number; size: number }          // relative-segment allocate
  | { op: "writeMem"; address: number; bytes: Buffer }   // absolute addr, or relative resolved by the planner
  // Write a whole relative segment at its LSM's table address, resolved AT EXECUTION
  // TIME: a relative segment's address is only assigned by the alloc step, so the
  // planner cannot precompute it the way absolute writeMem steps can. Always read-back
  // verified (like every memory write in the engine).
  | { op: "writeSegment"; lsm: number; bytes: Buffer }
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
      case "restart": await dev.restart(); break;
      case "unload": {
        await lsmEvent(dev, step.lsm, LSM.UNLOAD);
        break;
      }
      case "load": {
        await lsmEvent(dev, step.lsm, LSM.LOAD);
        if (step.assert !== false) {
          const s = await lsmState(dev, step.lsm);
          if (s !== STATE.LOADING) throw new Error(`LSM ${step.lsm} not LOADING after LOAD (got ${stateName(s)})`);
        }
        break;
      }
      case "alloc": await allocSegment(dev, step.lsm, step.size); break;
      case "writeMem": await dev.memWrite(step.address, step.bytes, { verify: true }); break;
      case "writeSegment": await dev.memWrite(await dev.tableAddr(step.lsm), step.bytes, { verify: true, onProgress: opts.onWrite }); break;
      case "writeProp": await dev.propWrite(step.obj, step.pid, step.data); break;
      case "stampAppId": await dev.propWrite(step.lsm, PID.PROGRAM_ID, step.data); break;
      case "loadCompleted": {
        await lsmEvent(dev, step.lsm, LSM.LOAD_COMPLETED);
        if (step.assert !== false) {
          const s = await lsmState(dev, step.lsm);
          if (s !== STATE.LOADED) throw new Error(`LSM ${step.lsm} not LOADED after LOAD_COMPLETED (got ${stateName(s)})`);
        }
        break;
      }
      case "assertLoaded": {
        const s = await lsmState(dev, step.lsm);
        if (s !== STATE.LOADED) throw new Error(`LSM ${step.lsm} not LOADED (got ${stateName(s)})`);
        break;
      }
    }
  }
}
