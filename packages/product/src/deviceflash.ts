import type { AppConfig, ModuleInstance } from "./appconfig.ts";
import { buildAbsoluteSegmentTargets } from "./deviceimage.ts";
import { flattenSteps, lsmIdx, stepAddress, type LoadProcedures } from "./loadproc.ts";
import type { LoadPlan } from "@busforge/knx";

// Plan an MV-0705 (absolute-segment) parameter download as a SURGICAL memory write.
//
// Why surgical and not a full-segment write: an absolute segment without a <Data>
// default image (e.g. Steinel M-008E) cannot be reconstructed byte-for-byte, because
// ETS computes non-zero parameter defaults from a default image these devices do not
// ship (the irreducible 4-byte residual in docs/mv0705-spike-findings.md). Writing a
// whole segment would therefore push our zero approximation over the device's correct
// (but, to us, unknowable) defaults. So we only ever WRITE bytes we can positively
// justify: bytes owned by an active, resolved parameter (buildAbsoluteSegmentTargets'
// `owned` mask). Manufacturer-default bytes, erased gaps, and parameters in inactive
// branches are left exactly as they are on the device. This is the read-back-verify
// philosophy applied to writing: change only what we can prove, leave the rest.
//
// Passing `current` (a device read-back per segment) narrows the plan further to the
// owned bytes that actually DIFFER, so an unchanged reconfiguration writes nothing.

export interface FlashRun { address: number; bytes: Buffer; } // absolute device address
export interface SegmentFlashPlan {
  id: string;
  address: number;
  size: number;
  runs: FlashRun[]; // contiguous byte runs to write via memWrite, sorted by address
  ownedBytes: number; // bytes under flash authority (derived from active parameters)
  writtenBytes: number; // bytes actually scheduled to write (== ownedBytes if no `current`)
  skippedUnowned: number; // bytes we deliberately never touch (defaults / gaps / inactive)
}

export interface FlashPlan {
  segments: SegmentFlashPlan[];
  totalWrittenBytes: number;
}

// Coalesce the selected (owned, and optionally changed) byte indices into the fewest
// contiguous runs, carrying the target image's value for each byte.
function runsFromMask(image: Buffer, address: number, write: boolean[]): FlashRun[] {
  const runs: FlashRun[] = [];
  let start = -1;
  for (let i = 0; i <= write.length; i++) {
    if (i < write.length && write[i]) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      runs.push({ address: address + start, bytes: Buffer.from(image.subarray(start, i)) });
      start = -1;
    }
  }
  return runs;
}

export function planAbsoluteSegmentFlash(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; current?: Map<string, Buffer> } = {},
): FlashPlan {
  const targets = buildAbsoluteSegmentTargets(app, values, opts);
  const segments: SegmentFlashPlan[] = [];
  for (const t of targets) {
    const current = opts.current?.get(t.id);
    // A byte is written iff it is owned (authoritative) and, when we know the device's
    // current memory, actually different from it. An owned byte the device already
    // holds correctly is skipped, so a no-op reconfiguration produces an empty plan.
    const write = t.owned.map((own, i) => own && (!current || current[i] !== t.bytes[i]));
    const runs = runsFromMask(t.bytes, t.address, write);
    const ownedBytes = t.owned.reduce((n, b) => n + (b ? 1 : 0), 0);
    const writtenBytes = write.reduce((n, b) => n + (b ? 1 : 0), 0);
    segments.push({
      id: t.id,
      address: t.address,
      size: t.size,
      runs,
      ownedBytes,
      writtenBytes,
      skippedUnowned: t.size - ownedBytes,
    });
  }
  segments.sort((a, b) => a.address - b.address);
  return { segments, totalWrittenBytes: segments.reduce((n, s) => n + s.writtenBytes, 0) };
}

// Turn the surgical segment plan into an executable LoadPlan by wrapping it in the
// device's declared LSM load bracket. The procedure (parsed from the app program) tells
// us which AbsoluteSegment lives under which LSM (by address) and the order LSMs load;
// we emit the minimal "par" download proven on hardware: for each LSM that owns a
// changed segment, Load -> write its changed owned runs -> LoadCompleted, wrapped in
// connect/restart/disconnect. Byte selection is delegated to planAbsoluteSegmentFlash,
// so the owned-byte authority lives in exactly one place.
//
// `unplaceable` lists segments that have changed owned bytes but are NOT declared in the
// load procedure (so we have no LSM to load them under). They are reported, never
// silently dropped: the caller must refuse the flash rather than report a partial write
// as success.

export interface AbsParFlashPlan {
  plan: LoadPlan;
  changedBytes: number;
  segments: { id: string; address: number; lsm: number; changed: number }[];
  unplaceable: { id: string; address: number; changed: number }[];
}

export function planAbsoluteParFlash(
  app: AppConfig,
  values: Map<string, string>,
  procedure: LoadProcedures,
  current: Map<string, Buffer>, // AbsoluteSegment Id -> live device bytes
  opts: { lang?: string; moduleInstances?: ModuleInstance[] } = {},
): AbsParFlashPlan {
  const fp = planAbsoluteSegmentFlash(app, values, { ...opts, current });

  // From the procedure's PAR-applicable steps (a step scoped AppliesTo="full" must not
  // shape a par download): which LSM owns each absolute segment (by address), and the
  // order LSMs are loaded (the LdCtrlLoad sequence).
  const parSteps = flattenSteps(procedure, "par");
  const lsmByAddress = new Map<number, number>();
  const lsmOrder: number[] = [];
  for (const s of parSteps) {
    if (s.verb === "LdCtrlAbsSegment") { const a = stepAddress(s), l = lsmIdx(s); if (a !== undefined && l !== undefined) lsmByAddress.set(a, l); }
    if (s.verb === "LdCtrlLoad") { const l = lsmIdx(s); if (l !== undefined && !lsmOrder.includes(l)) lsmOrder.push(l); }
  }
  const has = (verb: string) => parSteps.some((s) => s.verb === verb);

  const runsByLsm = new Map<number, FlashRun[]>();
  const segments: AbsParFlashPlan["segments"] = [];
  const unplaceable: AbsParFlashPlan["unplaceable"] = [];
  let changedBytes = 0;
  for (const seg of fp.segments) {
    if (!seg.runs.length) continue; // no changed owned bytes in this segment
    const lsm = lsmByAddress.get(seg.address);
    if (lsm === undefined) { unplaceable.push({ id: seg.id, address: seg.address, changed: seg.writtenBytes }); continue; }
    changedBytes += seg.writtenBytes;
    segments.push({ id: seg.id, address: seg.address, lsm, changed: seg.writtenBytes });
    runsByLsm.set(lsm, [...(runsByLsm.get(lsm) ?? []), ...seg.runs]);
  }

  // The plan is the LSM bracket only. Connection lifecycle (T_Connect/T_Disconnect) is
  // the CALLER's job: it must already be connected (it read the live segment to diff),
  // and a second T_Connect here would reset the local sequence counter while the device
  // keeps counting, after which the device stops answering ("no reliable response").
  // So we do NOT emit connect/disconnect even though the procedure declares them.
  const plan: LoadPlan = [];
  if (changedBytes > 0) {
    for (const lsm of lsmOrder) {
      const runs = runsByLsm.get(lsm);
      if (!runs?.length) continue;
      plan.push({ op: "load", lsm });
      for (const r of runs) plan.push({ op: "writeMem", address: r.address, bytes: r.bytes });
      plan.push({ op: "loadCompleted", lsm });
    }
    if (has("LdCtrlRestart")) plan.push({ op: "restart" });
  }
  return { plan, changedBytes, segments, unplaceable };
}
