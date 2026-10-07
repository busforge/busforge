import { createHash } from "node:crypto";
import type { AppConfig, CfgAbsSegment, ModuleInstance } from "./appconfig.ts";
import { buildAbsoluteSegmentTargets, mergeOwnedBits, wholeBytes, parameterMemoryBytes } from "./deviceimage.ts";
import { flattenSteps, lsmIdx, stepAddress, stepSize, memType, segType, segAccess, segFlags, etsCapturedSystem7, etsDeclaredOrderSystem7, etsRegionTablesSystem7, etsTableSegmentDataSystem7, ETS_DECLARED_ORDER_TASK_CTRL1, imageStampReads, type LoadProcedures, type McbWrite, type ClosingPropWrite } from "./loadproc.ts";
import { buildGroupTablesMv0705, type ComObjectLink } from "./grouptables.ts";
import { buildComObjectTableMv0705, etsUpdateBitMv0705 } from "./comobjbuild.ts";
import type { CfgComObjImage } from "./config.ts";
import { ProductError } from "./errors.ts";
import { isMemoryMappedLsm } from "./masks.ts";
import { OBJ, planSecurityObjectLoad, securityUnload, type LoadPlan, type LoadStep, type SecurityObjectTables } from "@busforge/knx";

// Plan an MV-0705 (absolute-segment) parameter download as a SURGICAL memory write.
//
// Why surgical and not a full-segment write: an absolute segment without a <Data>
// default image (e.g. Steinel M-008E) cannot be reconstructed byte-for-byte, because
// ETS computes non-zero parameter defaults from a default image these devices do not
// ship (the irreducible 4-byte residual in docs/device-memory-model.md). Writing a
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
    // A byte is written iff it holds an owned (authoritative) bit and, when we know the device's
    // current memory, actually differs from it. An owned byte the device already holds correctly
    // is skipped, so a no-op reconfiguration produces an empty plan, except where the device rewrites
    // a byte itself after each download: the Theben TheLuxa P300 clears its download marker P-2228
    // (Access="None", $AA) to 00, so that byte differs every time and is written every time, as ETS
    // writes it in every download. Bits of a written byte that no parameter owns are carried over
    // from the device.
    if (opts.current && (!current || current.length !== t.size)) {
      throw new ProductError("PARAM_SEGMENT_NOT_READ", `the device's ${t.id} was not read in full (${current?.length ?? 0} of ${t.size} B); refusing to write its shared bytes without the bits it holds`);
    }
    const image = current ? Buffer.from(t.bytes.map((b, i) => mergeOwnedBits(current[i], b, t.owned[i]))) : t.bytes;
    const write = t.owned.map((own, i) => own !== 0 && (!current || current[i] !== image[i]));
    const runs = runsFromMask(image, t.address, write);
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

// The System B ("relative") par-download bracket as a LoadPlan for the generic executor,
// replacing the formerly hardcoded flashParameters() in @busforge/knx. Step order is the
// hardware-proven bracket (M-0162 full-image byte-match, Theben 493B module
// param change): unload -> load -> alloc(size) -> write the owned bytes (read-back verified,
// address resolved at execution time) -> stamp the app id so LoadCompleted validates ->
// load-completed -> restart. Connection lifecycle stays with the caller, like the
// absolute planner. One DELIBERATE delta vs the retired executor: the engine asserts
// LOADING after Load (it always did for the absolute path); standard LSM behavior, but
// not yet hardware-smoked on a System B device (see docs/load-procedures.md).
// `mcb` are the memory-control-block entries the application declares (declaredMcbWrites): the
// allocation resets the segment's regions, so they are written again right after it.
// Only the bytes holding an owned bit are written (`owned`, a bit mask per byte), as ETS does: its
// parameter download reallocates without fill and writes exactly the bytes its parameter model owns
// (GVS AMMA and Jung 400021SE partial-download captures, 2026-09-26), relying on the device to keep
// the rest. That holds only while the segment stays at `keptAt`, the address it had before; one the
// allocation moved is written whole (writeSegmentOwned). The caller's read-back of the whole
// segment proves the result.
export function planRelativeParFlash(lsm: number, image: Buffer, owned: ReadonlyArray<number>, keptAt: number, appIdStamp: Buffer, requireReboot = true, mcb: McbWrite[] = []): LoadPlan {
  const other = mcb.find((m) => m.obj !== lsm);
  if (other) throw new ProductError("LOAD_STEP_UNSUPPORTED", `an MCB entry for object ${other.obj}; the parameter flash only allocates object ${lsm}`);
  return [
    { op: "unload", lsm },
    { op: "load", lsm },
    { op: "alloc", lsm, size: image.length },
    ...mcb.map((m): LoadStep => ({ op: "writeProp", obj: lsm, pid: 27, start: m.element, data: m.data, echoPrefix: m.echoPrefix })),
    { op: "writeSegmentOwned", lsm, image, owned, keptAt },
    { op: "stampAppId", lsm, data: appIdStamp },
    { op: "loadCompleted", lsm },
    // Whether the closing A_Restart must PROVE a reboot. thelsing/knx persists ON the restart, so no
    // reboot means the write was lost; other firmware (the GVS AMMA) persists at LoadCompleted and
    // never goes silent, so demanding a reboot would fail a flash that actually landed. Same
    // PERSIST_ON_LOAD_COMPLETED distinction the full download already makes.
    { op: "restart", requireReboot },
  ];
}

// Put a download's closing property writes (closingPropWrites) right before its restart, where ETS
// sends them: after every LoadCompleted, so the device takes them on a finished load.
export function withClosingWrites(plan: LoadPlan, writes: ClosingPropWrite[]): LoadPlan {
  if (!writes.length) return plan;
  const at = plan.findLastIndex((st) => st.op === "restart");
  if (at < 0 || plan.slice(0, at).every((st) => st.op !== "loadCompleted")) {
    throw new ProductError("LOAD_STEP_UNSUPPORTED", "the load procedure declares a property write that closes the download, and this plan has no completed load and restart to place it in");
  }
  return [...plan.slice(0, at), ...writes.map((w): LoadStep => ({ op: "writeProp", obj: w.obj, pid: w.pid, data: w.data })), ...plan.slice(at)];
}

// A segment of a System B structural flash: the image, which of its bytes to send while the segment
// stays at `keptAt` (a bit mask per byte, as writeSegmentOwned takes it), and that address.
export interface KeptSegment { image: Buffer; owned: ReadonlyArray<number>; keptAt: number }

// The System B bracket for a change that alters the com-object table: the application, the
// com-object table and both group tables, and on a Data Secure device its security object, in one
// load bracket. This is the bracket ETS runs for such a partial download (Jung 400021SE, K2 switched
// between two functions with different objects, both directions, 2026-10-01): unload all four objects
// and the security object; load and reallocate each without fill (the application first, then its
// memory-control blocks); write the parameter bytes, the com-object table bytes that differ, the
// association and address tables whole; load the security object; stamp the program id; complete
// application, com-object, association and address table; restart. Its bytes are what the full
// download's bracket (planSystemBFullDownload) writes, minus what the device keeps across a
// reallocation at the same address.
export function planRelativeStructuralFlash(
  lsm: number,
  segs: { params: KeptSegment; comObj: KeptSegment; addr: Buffer; assoc: Buffer },
  appIdStamp: Buffer, requireReboot = true, mcb: McbWrite[] = [], security?: SecurityObjectTables,
): LoadPlan {
  const other = mcb.find((m) => m.obj !== lsm);
  if (other) throw new ProductError("LOAD_STEP_UNSUPPORTED", `an MCB entry for object ${other.obj}; the structural flash writes memory-control blocks of object ${lsm} only, as the parameter flash does`);
  const C = OBJ.COMOBJ_TABLE, A = OBJ.ASSOC_TABLE, D = OBJ.ADDR_TABLE;
  return [
    { op: "unload", lsm }, { op: "unload", lsm: C }, { op: "unload", lsm: A }, { op: "unload", lsm: D },
    ...(security ? [securityUnload] : []),
    { op: "load", lsm }, { op: "alloc", lsm, size: segs.params.image.length },
    ...mcb.map((m): LoadStep => ({ op: "writeProp", obj: lsm, pid: 27, start: m.element, data: m.data, echoPrefix: m.echoPrefix })),
    { op: "load", lsm: C, assert: false }, { op: "alloc", lsm: C, size: segs.comObj.image.length },
    { op: "load", lsm: D, assert: false }, { op: "alloc", lsm: D, size: segs.addr.length },
    { op: "load", lsm: A, assert: false }, { op: "alloc", lsm: A, size: segs.assoc.length },
    { op: "writeSegmentOwned", lsm, ...segs.params },
    { op: "writeSegmentOwned", lsm: C, ...segs.comObj },
    { op: "writeSegment", lsm: A, bytes: segs.assoc },
    { op: "writeSegment", lsm: D, bytes: segs.addr },
    ...(security ? planSecurityObjectLoad(security) : []),
    { op: "stampAppId", lsm, data: appIdStamp },
    { op: "loadCompleted", lsm },
    { op: "loadCompleted", lsm: C, assert: false }, { op: "loadCompleted", lsm: A, assert: false }, { op: "loadCompleted", lsm: D, assert: false },
    { op: "assertLoaded", lsm: C }, { op: "assertLoaded", lsm: A }, { op: "assertLoaded", lsm: D },
    { op: "restart", requireReboot },
  ];
}

// The bytes of a table to send after a reallocation at the same address: those that differ from what
// the device holds there, and every byte past its old length.
export function differingBytes(want: Buffer, have: Buffer): number[] {
  return Array.from(want, (b, i) => (i >= have.length || have[i] !== b ? 0xff : 0));
}

// One region a System 7 structural flash compares and may write: the image the new configuration
// gives it, which bits of it are ours to write (`owned`), and which a read-back may assert (`verify`).
export interface AbsStructuralImage { id: string; address: number; image: Buffer; owned: ReadonlyArray<number>; verify: ReadonlyArray<number> }
export interface AbsStructuralSegment { id: string; address: number; lsm: number; image: Buffer; verify: ReadonlyArray<number> }
export interface AbsStructuralFlashPlan { plan: LoadPlan; changedBytes: number; lsms: number[]; concerned: number[]; segments: AbsStructuralSegment[] }

// What a System 7 structural flash compares against the device: the address and association tables,
// the com-object table authored from its segment's template (as the full download authors it), and
// the parameter segments' owned bytes. A parameter that was active in the programmed baseline
// (`baseValues`) and is not in the new configuration goes back to its segment's <Data> template value,
// as ETS writes it: ETS writes where its old image differs from its new one (MDT BE-02001.02, input
// B's short/long settings, 2026-10-01). Only bits a baseline parameter owned and verifies are taken
// this way, so a byte no parameter derives (a text, a value the codec cannot encode) and an
// Access="None" parameter the device stamps are never reset, and every bit taken is verified.
export function absoluteStructuralImages(
  app: AppConfig,
  values: Map<string, string>,
  links: ComObjectLink[],
  ownIa: number,
  opts: { baseValues: Map<string, string>; baseInstances?: ModuleInstance[]; moduleInstances?: ModuleInstance[]; comObjectTable: { active: Map<number, CfgComObjImage>; linked: ReadonlySet<number> } },
): AbsStructuralImage[] {
  const segment = (segId: string | undefined, which: string): CfgAbsSegment => {
    const seg = segId === undefined ? undefined : app.absoluteSegments.find((s) => s.id === segId);
    if (!seg) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the application names no segment for its ${which} table; refusing to write it blind`);
    return seg;
  };
  const addrSeg = segment(app.groupTables.addressSegment, "address");
  const assocSeg = segment(app.groupTables.associationSegment, "association");
  const comObjSeg = segment(app.groupTables.comObjectSegment, "com-object");
  if (comObjSeg.data.length === 0) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the com-object table segment ${comObjSeg.id} carries no <Data> template; refusing to author it blind`);
  const { addr, assoc } = buildGroupTablesMv0705(links, ownIa);
  if (addr.length > addrSeg.size) throw new ProductError("GA_TABLE_TOO_LARGE", `the address table needs ${addr.length} B but its segment reserves only ${addrSeg.size} B; assign fewer group addresses`);
  if (assoc.length > assocSeg.size) throw new ProductError("GA_TABLE_TOO_LARGE", `the association table needs ${assoc.length} B but its segment reserves only ${assocSeg.size} B; remove links`);
  const comObj = buildComObjectTableMv0705(comObjSeg.data, opts.comObjectTable.active, opts.comObjectTable.linked, { updateBit: etsUpdateBitMv0705(app.id) });
  if (comObj.length > comObjSeg.size) throw new ProductError("COM_OBJECT_TABLE_TOO_LARGE", `the com-object table needs ${comObj.length} B but its segment reserves only ${comObjSeg.size} B`);
  const all = (n: number) => new Array<number>(n).fill(0xff);
  const images: AbsStructuralImage[] = [
    { id: addrSeg.id, address: addrSeg.address, image: addr, owned: all(addr.length), verify: all(addr.length) },
    { id: assocSeg.id, address: assocSeg.address, image: assoc, owned: all(assoc.length), verify: all(assoc.length) },
    { id: comObjSeg.id, address: comObjSeg.address, image: comObj, owned: all(comObj.length), verify: all(comObj.length) },
  ];
  const tables = [...images];
  const before = new Map(buildAbsoluteSegmentTargets(app, opts.baseValues, { moduleInstances: opts.baseInstances ?? opts.moduleInstances }).map((t) => [t.address, t]));
  for (const t of buildAbsoluteSegmentTargets(app, values, { moduleInstances: opts.moduleInstances })) {
    if (t.size === 0) continue;
    if (tables.some((w) => t.address < w.address + w.image.length && w.address < t.address + t.size)) {
      throw new ProductError("FLASH_SEGMENT_UNPLACEABLE", `parameter segment ${t.id} overlaps a group or com-object table; refusing to write two images over one another`);
    }
    const template = app.absoluteSegments.find((seg) => seg.address === t.address)?.data.length ?? 0;
    const was = before.get(t.address);
    // A verify bit is an owned bit of a parameter that is not Access="None": a byte the device stamps
    // itself is never taken back to the template.
    const dropped = (i: number) => (was && i < template ? (was.verify[i] ?? 0) & ~t.owned[i] & 0xff : 0);
    images.push({
      id: t.id, address: t.address, image: t.bytes,
      owned: t.owned.map((m, i) => m | dropped(i)),
      verify: t.verify.map((v, i) => v | dropped(i)),
    });
  }
  return images;
}

// The System 7 writes for a change that alters the com-object table, as ETS writes them in a partial
// download (MDT BE-02001.02, input B switched between a one-object and a two-object function, 2026-10-01):
// one load bracket per load-state machine, in the order the load procedure loads them, each with only
// the bytes that differ from the device (address and association table, then the application's own
// machine with the parameter bytes and the com-object table). One restart closes it. ETS also unloads
// the two group tables and declares their segments again; this plan brackets them the way the
// hardware-proven group-address flash does (planMv0705GaFlash), with no unload and no declaration.
// `current`: what the device holds at each image's address, at the image's length.
// `concerned`: every load-state machine an image maps to, written or not, for the load-state check.
export function planAbsoluteStructuralFlash(
  images: AbsStructuralImage[],
  procedure: LoadProcedures,
  current: ReadonlyMap<number, Buffer>,
  requireReboot = true,
): AbsStructuralFlashPlan {
  const lsmByAddress = new Map<number, number>();
  const lsmOrder: number[] = [];
  for (const s of flattenSteps(procedure, "full")) {
    if (s.verb === "LdCtrlAbsSegment") { const a = stepAddress(s), l = lsmIdx(s); if (a !== undefined && l !== undefined) lsmByAddress.set(a, l); }
    if (s.verb === "LdCtrlLoad") { const l = lsmIdx(s); if (l !== undefined && !lsmOrder.includes(l)) lsmOrder.push(l); }
  }
  const runsByLsm = new Map<number, FlashRun[]>();
  const segments: AbsStructuralSegment[] = [];
  let changedBytes = 0;
  for (const w of images) {
    const have = current.get(w.address);
    if (!have || have.length !== w.image.length) {
      throw new ProductError("PARAM_SEGMENT_NOT_READ", `the device's ${w.id} was not read in full (${have?.length ?? 0} of ${w.image.length} B); refusing to write its shared bytes without the bits it holds`);
    }
    const image = Buffer.from(w.image.map((b, i) => mergeOwnedBits(have[i], b, w.owned[i])));
    const write = w.owned.map((own, i) => own !== 0 && have[i] !== image[i]);
    const runs = runsFromMask(image, w.address, write);
    if (!runs.length) continue;
    const lsm = lsmByAddress.get(w.address);
    if (lsm === undefined || !lsmOrder.includes(lsm)) {
      throw new ProductError("FLASH_SEGMENT_UNPLACEABLE", `segment ${w.id} differs from the device but the load procedure loads it under no load-state machine; refusing a partial write`);
    }
    changedBytes += write.filter(Boolean).length;
    segments.push({ id: w.id, address: w.address, lsm, image, verify: w.verify });
    runsByLsm.set(lsm, [...(runsByLsm.get(lsm) ?? []), ...runs]);
  }
  const plan: LoadPlan = [];
  const lsms = lsmOrder.filter((l) => runsByLsm.has(l));
  for (const lsm of lsms) {
    plan.push({ op: "load", lsm });
    for (const r of runsByLsm.get(lsm)!) plan.push({ op: "writeMem", address: r.address, bytes: r.bytes });
    plan.push({ op: "loadCompleted", lsm });
  }
  if (plan.length) plan.push({ op: "restart", requireReboot });
  const concerned = lsmOrder.filter((l) => images.some((w) => lsmByAddress.get(w.address) === l));
  return { plan, changedBytes, lsms, concerned, segments };
}

export function planAbsoluteParFlash(
  app: AppConfig,
  values: Map<string, string>,
  procedure: LoadProcedures,
  current: Map<string, Buffer>, // AbsoluteSegment Id -> live device bytes
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; requireReboot?: boolean } = {},
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
    // Unplaceable if we have no LSM for this segment's address, OR the LSM exists but the
    // procedure never loads it (no LdCtrlLoad, so it is absent from lsmOrder). The plan is
    // built by iterating lsmOrder, so an un-loaded LSM's runs would be silently omitted while
    // still counted as changed: a partial write reported as success. Refuse instead.
    if (lsm === undefined || !lsmOrder.includes(lsm)) { unplaceable.push({ id: seg.id, address: seg.address, changed: seg.writtenBytes }); continue; }
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
    // A captured application's stamps are read after the last LoadCompleted (gira-m0008-ets-partial-params.log).
    for (const r of imageStampReads(procedure)) plan.push({ op: "readProp", ...r });
    if (has("LdCtrlRestart")) plan.push({ op: "restart", requireReboot: opts.requireReboot ?? true });
  }
  return { plan, changedBytes, segments, unplaceable };
}

// ── Full download for absolute-segment (System 7) devices ────────────────────────
//
// Commission an absolute-segment device by executing its declared load procedure, writing
// EVERY segment (not just the changed parameter bytes the surgical `par` planner touches):
//   - the address and association tables from the group-address links (buildGroupTablesMv0705),
//   - each parameter-bearing segment as its <Data> default overlaid with the active parameter
//     values (buildAbsoluteSegmentTargets, whole image), and
//   - every remaining declared segment (com-object table + application code) as its <Data>.
//
// The procedure is walked IN ORDER and each verb translated to a LoadStep, so the LSM brackets
// (and cross-LSM task declarations like the com-object table's LSM5 task nested inside the LSM3
// load) are reproduced exactly rather than reconstructed. The device drives its LSMs over the
// memory-mapped interface (MV-0700/0701); the runner is told so via `memMappedLsms`. Connect /
// app-id CompareProp / disconnect are the caller's (session + preflight), not emitted here.
export interface AbsFullSegment {
  id: string;
  address: number;
  lsm: number;
  source: "addrTable" | "assocTable" | "comObjTable" | "params" | "static";
  image: Buffer;      // the bytes written to this segment
  verify: ReadonlyArray<number | boolean>;  // which of `image` (bytes, or bit masks per byte) a post-restart read-back may assert (excludes device-stamped bytes)
}
export interface AbsFullDownloadPlan {
  plan: LoadPlan;
  segments: AbsFullSegment[]; // every segment written, in write order
  imageBytes: number;
  // Where the plan re-declares the address and association tables away from their declared segments
  // (ETS_CAPTURED_SYSTEM7_APPS, ETS_REGION_TABLES_SYSTEM7_APPS): the address each table's load-state
  // machine must reference (PID 7) after the download, or the device does not read the bytes written.
  tableRefs?: { lsm: number; address: number }[];
}

// The declared "full" steps planAbsoluteFullDownload executes, with the attributes each needs. Connect,
// disconnect and the app-id CompareProp are the caller's (System7Profile.downloadFull).
const ABS_FULL_STEP_ATTRS: Record<string, readonly string[]> = {
  LdCtrlUnload: ["LsmIdx"], LdCtrlLoad: ["LsmIdx"], LdCtrlLoadCompleted: ["LsmIdx"],
  LdCtrlAbsSegment: ["LsmIdx", "Address", "Size"], LdCtrlTaskSegment: ["LsmIdx", "Address"],
  LdCtrlRestart: [], LdCtrlConnect: [], LdCtrlDisconnect: [], LdCtrlCompareProp: [],
};

// The declared LdCtrlTaskCtrl1 is exactly the one the ETS capture of this application shows.
function capturedTaskCtrl1(procedure: LoadProcedures, s: ReturnType<typeof flattenSteps>[number]): boolean {
  const c = procedure.app !== undefined ? ETS_DECLARED_ORDER_TASK_CTRL1[procedure.app] : undefined;
  return !!c && Object.keys(s.attrs).length === 3 && s.attrs.LsmIdx === c.LsmIdx && s.attrs.Address === c.Address && s.attrs.Count === c.Count;
}

export interface StepRefusal { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" | "FULL_DOWNLOAD_STEP_MALFORMED" | "LOAD_PROCEDURE_UNSUPPORTED"; message: string }

// Why the absolute full download cannot run this declared procedure, or null when it can. The planner
// refuses with exactly this, and capabilities() offers the full download only where it is null, so the
// UI never offers a download the planner then refuses.
export function absoluteFullStepRefusal(procedure: LoadProcedures): StepRefusal | null {
  const steps = flattenSteps(procedure, "full");
  if (steps.length === 0) {
    return { code: "LOAD_PROCEDURE_UNSUPPORTED", message: `the application declares no full-download steps (load procedure style ${procedure.style}); refusing to commission it from a recipe Busforge would have to invent` };
  }
  if (etsCapturedSystem7(procedure)) return capturedStepRefusal(steps);
  const declaredOrder = etsDeclaredOrderSystem7(procedure);
  for (const s of steps) {
    if (s.verb === "LdCtrlTaskCtrl1" && declaredOrder) {
      if (!capturedTaskCtrl1(procedure, s)) {
        const a = s.attrs, c = procedure.app !== undefined ? ETS_DECLARED_ORDER_TASK_CTRL1[procedure.app] : undefined;
        return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares LdCtrlTaskCtrl1 LsmIdx ${a.LsmIdx} Address ${a.Address} Count ${a.Count}; the ETS capture of this application shows ${c ? `only LsmIdx ${c.LsmIdx} with Address ${c.Address} and Count ${c.Count}` : "none"}, refusing to guess what another form sends` };
      }
      continue;
    }
    const needs = ABS_FULL_STEP_ATTRS[s.verb];
    if (!needs) return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares a step this full download cannot execute yet (${s.verb}); refusing to run a partial recipe` };
    const missing = needs.find((a) => s.attrs[a] === undefined);
    if (missing) return { code: "FULL_DOWNLOAD_STEP_MALFORMED", message: `${s.verb} is missing its ${missing}; refusing to build a partial download` };
  }
  return null;
}

// ── ETS-captured System 7 downloads (loadproc.ts ETS_CAPTURED_SYSTEM7_APPS) ─────────
//
// What each declared full step becomes, as the captures show it. Anything outside this list refuses.
const TABLE_LSMS = [OBJ.ADDR_TABLE, OBJ.ASSOC_TABLE] as const;
const APP_LSM = OBJ.COMOBJ_TABLE; // LSM 3: the application's segments, the com-object table among them
const CAPTURED_STEPS: { verb: string; lsms?: readonly number[]; what: string }[] = [
  { verb: "LdCtrlConnect", what: "the caller's session" }, { verb: "LdCtrlDisconnect", what: "the caller's session" },
  { verb: "LdCtrlCompareProp", what: "the caller's pre-flight" }, { verb: "LdCtrlRestart", what: "sent" },
  { verb: "LdCtrlUnload", lsms: [1, 2, 3], what: "sent for the tables, not for the application" },
  { verb: "LdCtrlLoad", lsms: [1, 2, 3], what: "sent" }, { verb: "LdCtrlLoadCompleted", lsms: [1, 2, 3], what: "sent" },
  { verb: "LdCtrlAbsSegment", lsms: [1, 2, 3], what: "re-declared at the built size for the tables; for the application, its data written" },
  { verb: "LdCtrlTaskSegment", lsms: [1, 2, 3, 5], what: "sent for the tables, not for the application or LSM 5" },
  { verb: "LdCtrlTaskCtrl1", lsms: [3], what: "not sent" }, { verb: "LdCtrlLoadImageProp", what: "a read of PID 27" },
];

function capturedStepRefusal(steps: ReturnType<typeof flattenSteps>): StepRefusal | null {
  for (const s of steps) {
    const known = CAPTURED_STEPS.find((c) => c.verb === s.verb);
    const l = lsmIdx(s);
    if (!known || (known.lsms && (l === undefined || !known.lsms.includes(l)))) {
      return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares ${s.verb}${l !== undefined ? ` LsmIdx ${l}` : ""}, which no ETS capture of this application shows; refusing to run a partial recipe` };
    }
  }
  return null;
}

interface AbsDecl { lsm: number; segType: number; address: number; size: number; access: number; memType: number; segFlags: number }
const absDecl = (s: ReturnType<typeof flattenSteps>[number]): AbsDecl | null => {
  const lsm = lsmIdx(s), address = stepAddress(s), size = stepSize(s);
  return lsm === undefined || address === undefined || size === undefined ? null : { lsm, segType: segType(s), address, size, access: segAccess(s), memType: memType(s) ?? 0, segFlags: segFlags(s) };
};

export interface CapturedTables { steps: LoadStep[]; addrAt: number; assocAt: number; writes: { lsm: number; address: number; image: Buffer }[] }

// Where an application of ETS_REGION_TABLES_SYSTEM7_APPS gets its tables: the two declared table
// segments as one region, the address table's segment as long as the table, the association table's
// directly behind it with the rest of the region.
interface TableRegion { d1: AbsDecl; d2: AbsDecl; addrAt: number; assocAt: number; assocSize: number }
function tableRegion(app: AppConfig, procedure: LoadProcedures, tables: { addr: Buffer; assoc: Buffer }): TableRegion {
  const steps = flattenSteps(procedure, "full");
  const decl = (lsm: number): AbsDecl => {
    const ds = steps.filter((s) => s.verb === "LdCtrlAbsSegment" && lsmIdx(s) === lsm).map(absDecl);
    if (ds.length !== 1 || !ds[0]) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `the load procedure declares ${ds.length} readable segment(s) for load-state machine ${lsm}, where the ETS capture shows one table segment; refusing to place the table`);
    if (!steps.some((s) => s.verb === "LdCtrlTaskSegment" && lsmIdx(s) === lsm)) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `the load procedure declares no task segment for load-state machine ${lsm}; the ETS capture declares one`);
    return ds[0];
  };
  const [d1, d2] = TABLE_LSMS.map(decl);
  const segAt = (id: string | undefined) => app.absoluteSegments.find((s) => s.id === id)?.address;
  if (segAt(app.groupTables.addressSegment) !== d1.address || segAt(app.groupTables.associationSegment) !== d2.address || d1.address + d1.size !== d2.address) {
    throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `the table segments (${d1.address}+${d1.size}, ${d2.address}+${d2.size}) are not the application's address and association tables one behind the other; the ETS capture places the tables in one such region, refusing to guess another layout`);
  }
  const cap = app.groupTables;
  if ((cap.addressMaxEntries !== undefined && tables.addr.length > 3 + 2 * cap.addressMaxEntries) || (cap.associationMaxEntries !== undefined && tables.assoc.length > 1 + 2 * cap.associationMaxEntries)) {
    throw new ProductError("GA_TABLE_TOO_LARGE", `the tables need address ${tables.addr.length} B / association ${tables.assoc.length} B, more entries than the application declares (${cap.addressMaxEntries} addresses, ${cap.associationMaxEntries} associations); remove links or assign fewer group addresses`);
  }
  const region = d1.size + d2.size;
  if (tables.addr.length + tables.assoc.length > region) {
    throw new ProductError("GA_TABLE_TOO_LARGE", `the address table (${tables.addr.length} B) and the association table (${tables.assoc.length} B) need more than the ${region} B the application reserves for both; remove links or assign fewer group addresses`);
  }
  return { d1, d2, addrAt: d1.address, assocAt: d1.address + tables.addr.length, assocSize: region - tables.addr.length };
}

// The address and association tables of an application of ETS_REGION_TABLES_SYSTEM7_APPS, re-declared
// as ETS declares them (tableRegion), each load-state machine unloaded first, and its task segment
// declared at the table's new address.
// `etsRuns`: write of each table only the bytes ETS's image of its full and group-address downloads
// holds (etsTableRuns); without it the tables are written whole, the address table's own individual
// address included.
export function planCapturedTableBrackets(app: AppConfig, procedure: LoadProcedures, tables: { addr: Buffer; assoc: Buffer }, opts: { etsRuns?: boolean } = {}): CapturedTables {
  const { d1, d2, addrAt, assocAt, assocSize } = tableRegion(app, procedure, tables);
  const manufacturer = appManufacturerNumber(app);
  const writes: CapturedTables["writes"] = [];
  const bracket = (d: AbsDecl, at: number, size: number, bytes: Buffer): LoadStep[] => {
    const runs = opts.etsRuns ? etsTableRuns(app, at, bytes, d.lsm === OBJ.ADDR_TABLE) : [{ address: at, image: bytes }];
    writes.push(...runs.map((r) => ({ lsm: d.lsm, ...r })));
    return [
      { op: "load", lsm: d.lsm },
      { op: "absSegment", lsm: d.lsm, segType: d.segType, address: at, size, access: d.access, memType: d.memType, segFlags: d.segFlags, ...declarationTransport(app) },
      ...runs.map((r): LoadStep => ({ op: "writeMem", address: r.address, bytes: r.image })),
      { op: "taskSegment", lsm: d.lsm, address: at, peiType: app.appPeiType, manufacturer, appNumber: app.appNumber, version: app.appVersion, ...declarationTransport(app) },
      { op: "loadCompleted", lsm: d.lsm },
    ];
  };
  return {
    addrAt, assocAt, writes,
    steps: [
      { op: "unload", lsm: d1.lsm }, { op: "unload", lsm: d2.lsm },
      ...bracket(d1, addrAt, tables.addr.length, tables.addr),
      ...bracket(d2, assocAt, assocSize, tables.assoc),
    ],
  };
}

const appManufacturerNumber = (app: AppConfig): number => Number.parseInt(String(app.id).split("_")[0].replace("M-", ""), 16);
// How a captured application's segment declarations travel: the LSM's PID 5 on a property-mapped mask,
// the 0x0104 control (no flag) on a memory-mapped one (the Meteodata 140 S's MV-0701, its ETS captures).
const declarationTransport = (app: AppConfig): { viaProperty?: true } => (isMemoryMappedLsm(app.mask) ? {} : { viaProperty: true });

// The stamp reads (LdCtrlLoadImageProp) and the restart that close every captured download.
function capturedClose(procedure: LoadProcedures, requireReboot: boolean): LoadStep[] {
  return [...imageStampReads(procedure).map((r): LoadStep => ({ op: "readProp", ...r })), { op: "restart", requireReboot }];
}

// The group-address flash of an application of ETS_REGION_TABLES_SYSTEM7_APPS, as ETS's partial download
// after a link change writes it (gira-m0008-ets-partial-links.log, theluxa-p300-ets-partial-links.log):
// both tables re-declared and written, the com-object table written in the application's load bracket
// without unloading it, the stamps read where the application declares them, the restart. Of
// each table only the bytes ETS's image holds are written (etsTableRuns): the address table without
// the device's own individual address, the com-object table to its counted entries, not the rest of
// its segment. `comObjWrites`: what is written of the com-object table, for the read-back.
export function planCapturedSystem7GaFlash(app: AppConfig, procedure: LoadProcedures, tables: { addr: Buffer; assoc: Buffer }, comObj: { address: number; bytes: Buffer } | null, requireReboot = true): CapturedTables & { plan: LoadPlan; comObjWrites: { address: number; image: Buffer }[] } {
  if (!etsRegionTablesSystem7(procedure)) throw new ProductError("LOAD_STEP_UNSUPPORTED", "the group-address flash with re-declared tables is captured for the applications of ETS_REGION_TABLES_SYSTEM7_APPS only");
  const t = planCapturedTableBrackets(app, procedure, tables, { etsRuns: true });
  const comObjWrites = comObj ? etsTableRuns(app, comObj.address, builtComObjectTable(comObj.bytes), false) : [];
  const app3: LoadStep[] = comObj ? [{ op: "load", lsm: APP_LSM }, ...comObjWrites.map((r): LoadStep => ({ op: "writeMem", address: r.address, bytes: r.image })), { op: "loadCompleted", lsm: APP_LSM }] : [];
  return { ...t, comObjWrites, plan: [...t.steps, ...app3, ...capturedClose(procedure, requireReboot)] };
}

// A declared-order application's group-address flash, as ETS's partial download after a link change
// writes it (auro-m0081-ets-partial-links.log, and the tables of auro-m0081-ets-partial-revert.log):
// the address and association tables unloaded, then each in its declared bracket (load, the declared
// segment as a PID 5 write, the table's bytes as the full download writes them, the declared task
// segment, completion); the com-object table written whole in the application's load bracket, without
// unloading or declaring it; the restart. Each table is written to its built length only, so a table
// that shrinks leaves its old bytes behind it, as ETS's does. `segments`: what is written, for the
// read-back. `tableRefs`: the address each table's load-state machine is declared at, which the device
// reports as its table reference (PID 7) once the declaration took.
export function planDeclaredOrderSystem7GaFlash(
  app: AppConfig, procedure: LoadProcedures, tables: { addr: Buffer; assoc: Buffer },
  comObj: { address: number; bytes: Buffer } | null, requireReboot = true,
): { plan: LoadPlan; segments: { address: number; image: Buffer }[]; tableRefs: { lsm: number; address: number; runs: { address: number; image: Buffer }[] }[] } {
  if (!etsDeclaredOrderSystem7(procedure) || etsRegionTablesSystem7(procedure)) throw new ProductError("LOAD_STEP_UNSUPPORTED", "the declared-order group-address flash is captured for the applications of ETS_DECLARED_ORDER_SYSTEM7_APPS whose tables ETS declares as the procedure does only");
  const steps = flattenSteps(procedure, "full");
  const manufacturer = appManufacturerNumber(app);
  const segments: { address: number; image: Buffer }[] = [];
  const tableRefs: { lsm: number; address: number; runs: { address: number; image: Buffer }[] }[] = [];
  const bracket = (lsm: number, table: Buffer, segId: string | undefined, which: string): LoadStep[] => {
    const ds = steps.filter((s) => s.verb === "LdCtrlAbsSegment" && lsmIdx(s) === lsm).map(absDecl);
    const ts = steps.filter((s) => s.verb === "LdCtrlTaskSegment" && lsmIdx(s) === lsm).map(stepAddress);
    const d = ds[0];
    if (ds.length !== 1 || !d || ts.length !== 1 || ts[0] === undefined) {
      throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `the load procedure declares ${ds.length} segment(s) and ${ts.length} task segment(s) for load-state machine ${lsm}, where the ETS capture shows one of each for the ${which} table; refusing to place it`);
    }
    const seg = app.absoluteSegments.find((s) => s.id === segId);
    if (!seg || seg.address !== d.address) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the ${which} table's segment is not the one load-state machine ${lsm} declares at ${d.address}; refusing to write it blind`);
    if (table.length > d.size) throw new ProductError("GA_TABLE_TOO_LARGE", `the ${which} table needs ${table.length} B but its segment reserves only ${d.size} B; remove links or assign fewer group addresses`);
    const runs = etsWrittenRuns(app, seg, { image: table, verify: new Array<boolean>(table.length).fill(true) }, "table");
    const written = runs.map((r) => ({ address: r.address, image: r.image }));
    segments.push(...written);
    tableRefs.push({ lsm, address: d.address, runs: written });
    return [
      { op: "load", lsm },
      { op: "absSegment", lsm, segType: d.segType, address: d.address, size: d.size, access: d.access, memType: d.memType, segFlags: d.segFlags, ...declarationTransport(app) },
      ...runs.map((r): LoadStep => ({ op: "writeMem", address: r.address, bytes: r.image })),
      { op: "taskSegment", lsm, address: ts[0], peiType: app.appPeiType, manufacturer, appNumber: app.appNumber, version: app.appVersion, ...declarationTransport(app) },
      { op: "loadCompleted", lsm },
    ];
  };
  const [D, A] = TABLE_LSMS;
  const plan: LoadPlan = [
    { op: "unload", lsm: D }, { op: "unload", lsm: A },
    ...bracket(D, tables.addr, app.groupTables.addressSegment, "address"),
    ...bracket(A, tables.assoc, app.groupTables.associationSegment, "association"),
  ];
  if (comObj) {
    plan.push({ op: "load", lsm: APP_LSM }, { op: "writeMem", address: comObj.address, bytes: comObj.bytes }, { op: "loadCompleted", lsm: APP_LSM });
    segments.push({ address: comObj.address, image: comObj.bytes });
  }
  plan.push({ op: "restart", requireReboot });
  return { plan, segments, tableRefs };
}

export function planAbsoluteFullDownload(
  app: AppConfig,
  values: Map<string, string>,
  links: ComObjectLink[],
  ownIa: number,
  procedure: LoadProcedures,
  // `comObjectTable`: the active com-objects (visibility-gated) and the linked object numbers, so the
  // planner AUTHORS L3 into the <ComObjectTable> segment from its template, as ETS does on both LSM
  // styles (MDT BE-02001.02 and ABB US/U 4.2 captures). Absent => L3 is written as its static <Data>.
  // `propertyMapped`: a declared segment without <Data> is the device's own (declared, not written).
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; requireReboot?: boolean; propertyMapped: boolean; comObjectTable?: { active: Map<number, CfgComObjImage>; linked: ReadonlySet<number> } },
): AbsFullDownloadPlan {
  // A declared step we cannot execute, or whose attributes we cannot read, is a recipe we cannot
  // run; refuse before building anything rather than emit a plan that silently omits it. Same stance
  // as the par path's coverage gate, but on the "full" step list the planner actually runs.
  const refusal = absoluteFullStepRefusal(procedure);
  if (refusal) throw new ProductError(refusal.code, refusal.message);
  const propertyMapped = opts.propertyMapped;
  // The two group tables live in the segments the app names; every other declared segment is the
  // application image (params overlaid on <Data>, or plain <Data>). If the app names a table
  // segment that does not exist, refuse: silently letting it fall through to the static-<Data>
  // path would write a manufacturer-default (link-less) table where the built one belongs, and
  // the association table is what actually fires on the bus.
  const tableAddr = (segId: string | undefined, which: string): number | undefined => {
    if (segId === undefined) return undefined;
    const seg = app.absoluteSegments.find((s) => s.id === segId);
    if (!seg) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the ${which} table names segment ${segId}, which the application does not define; refusing to author the group tables blind`);
    return seg.address;
  };
  const addrTableAddr = tableAddr(app.groupTables.addressSegment, "address");
  const assocTableAddr = tableAddr(app.groupTables.associationSegment, "association");
  const comObjTableAddr = opts.comObjectTable ? tableAddr(app.groupTables.comObjectSegment, "com-object") : undefined;
  const { addr, assoc } = buildGroupTablesMv0705(links, ownIa, { order: etsRegionTablesSystem7(procedure) ? "ets-captured" : "object" });
  const paramTargets = new Map(buildAbsoluteSegmentTargets(app, values, opts).map((t) => [t.address, t]));
  const segByAddr = new Map(app.absoluteSegments.map((s) => [s.address, s]));
  const manufacturer = appManufacturerNumber(app);

  // Returns the bytes to write to a segment, or null to declare the segment in the LSM bracket but
  // write NOTHING to it (a property-mapped device fills its own computed segments, e.g. the RAM/
  // system segment AS-0700-class the app declares with no <Data>; ETS writes 0 bytes there and the
  // firmware populates it during LoadCompleted).
  const imageFor = (address: number, size: number): Pick<AbsFullSegment, "image" | "verify" | "source"> | null => {
    // The built table must fit the segment the load procedure reserves for it; overrunning would
    // write into the adjacent segment (the association/com-object table) with the per-segment
    // read-back none the wiser. Refuse, as the surgical GA flash does (GA_TABLE_TOO_LARGE).
    if (addrTableAddr !== undefined && address === addrTableAddr) {
      if (addr.length > size) throw new ProductError("GA_TABLE_TOO_LARGE", `the address table needs ${addr.length} B but its segment reserves only ${size} B; assign fewer group addresses`);
      return { image: addr, verify: new Array<boolean>(addr.length).fill(true), source: "addrTable" };
    }
    if (assocTableAddr !== undefined && address === assocTableAddr) {
      if (assoc.length > size) throw new ProductError("GA_TABLE_TOO_LARGE", `the association table needs ${assoc.length} B but its segment reserves only ${size} B; remove links`);
      return { image: assoc, verify: new Array<boolean>(assoc.length).fill(true), source: "assocTable" };
    }
    // L3: overlay the configured objects' flags onto the manufacturer's static template (the
    // segment's <Data>).
    if (comObjTableAddr !== undefined && address === comObjTableAddr) {
      const seg = segByAddr.get(address);
      if (!seg || seg.data.length === 0) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the com-object table segment at ${address} carries no <Data> template; refusing to author L3 blind`);
      const image = buildComObjectTableMv0705(seg.data, opts.comObjectTable!.active, opts.comObjectTable!.linked, { updateBit: etsUpdateBitMv0705(app.id) });
      if (image.length > size) throw new ProductError("COM_OBJECT_TABLE_TOO_LARGE", `the com-object table needs ${image.length} B but its segment reserves only ${size} B`);
      return { image, verify: new Array<boolean>(image.length).fill(true), source: "comObjTable" };
    }
    const pt = paramTargets.get(address);
    if (pt) return { image: pt.bytes, verify: wholeBytes(pt.verify), source: "params" };
    const seg = segByAddr.get(address);
    if (!seg) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the load procedure declares a segment at ${address} the application does not define; refusing to write an image we cannot build`);
    // A segment the app declares with no static image: on a property-mapped device this is a
    // computed/RAM segment the firmware fills itself (ETS writes nothing to it), so declare it but
    // do not write. On a memory-mapped device the historical behaviour (write the erased-flash 0xFF)
    // is preserved, since that path is hardware-proven.
    if (propertyMapped && seg.data.length === 0) return null;
    // A pure static segment (com-object table / code): its <Data> laid over the erased-flash state.
    const image = Buffer.alloc(size, 0xff);
    seg.data.copy(image);
    return { image, verify: new Array<boolean>(size).fill(true), source: "static" };
  };

  const plan: LoadPlan = [];
  const segments: AbsFullSegment[] = [];
  let imageBytes = 0;

  // A captured application: the tables in ETS's region, then the application's data segments in their
  // declared order inside one load bracket, without unloading or declaring them (a segment without
  // <Data> is the device's own and is not written, as ETS writes none). Of each, the bytes ETS's image
  // holds (etsWrittenRuns): the application stays loaded, so of its data segments only the bytes a
  // parameter covers. ETS then leaves out the bytes it believes the device already holds (its
  // differential download, from the stamps it read in the previous download); Busforge keeps no such
  // record and writes the whole image, every byte of it read back after the restart.
  if (etsCapturedSystem7(procedure)) {
    const t = planCapturedTableBrackets(app, procedure, { addr, assoc }, { etsRuns: true });
    for (const w of t.writes) {
      const id = (w.lsm === OBJ.ADDR_TABLE ? app.groupTables.addressSegment : app.groupTables.associationSegment) ?? `@${w.address}`;
      segments.push({ id, address: w.address, lsm: w.lsm, source: w.lsm === OBJ.ADDR_TABLE ? "addrTable" : "assocTable", image: w.image, verify: new Array<boolean>(w.image.length).fill(true) });
    }
    const appWrites: LoadStep[] = [];
    for (const s of flattenSteps(procedure, "full")) {
      if (s.verb !== "LdCtrlAbsSegment" || lsmIdx(s) !== APP_LSM) continue;
      const d = absDecl(s);
      if (!d) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `${s.verb} is missing its LsmIdx, Address or Size; refusing to build a partial download`);
      const seg = segByAddr.get(d.address);
      if (!seg) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the load procedure declares a segment at ${d.address} the application does not define; refusing to write an image we cannot build`);
      if (seg.data.length === 0) continue;
      const built = imageFor(d.address, d.size);
      if (!built) continue;
      if (built.source === "static") throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `segment ${seg.id} is neither the com-object table nor a parameter segment; the ETS captures of this application write no other, refusing to guess its bytes`);
      const runs = built.source === "comObjTable"
        ? etsWrittenRuns(app, seg, { ...built, image: builtComObjectTable(built.image) }, "table")
        : etsWrittenRuns(app, seg, built, "writtenIntoApplication", opts.moduleInstances);
      for (const run of runs) {
        appWrites.push({ op: "writeMem", address: run.address, bytes: run.image });
        segments.push({ id: seg.id, lsm: APP_LSM, source: built.source, ...run });
      }
    }
    plan.push(...t.steps, { op: "load", lsm: APP_LSM }, ...appWrites, { op: "loadCompleted", lsm: APP_LSM }, ...capturedClose(procedure, opts.requireReboot ?? true));
    return { plan, segments, imageBytes: segments.reduce((n, s) => n + s.image.length, 0), tableRefs: [{ lsm: OBJ.ADDR_TABLE, address: t.addrAt }, { lsm: OBJ.ASSOC_TABLE, address: t.assocAt }] };
  }

  const need = <T>(v: T | undefined, verb: string, what: string): T => {
    if (v === undefined) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `${verb} is missing its ${what}; refusing to build a partial download`);
    return v;
  };
  // An application ETS is captured downloading in its declared order (etsDeclaredOrderSystem7): its
  // declarations are PID 5 writes, and of each segment only the bytes ETS writes are written. Where ETS
  // re-declares the group tables as one region (etsRegionTablesSystem7), their two segments are declared
  // and written where tableRegion puts them, the task segments at the tables' new addresses.
  const declaredOrder = etsDeclaredOrderSystem7(procedure);
  const via = declaredOrder && propertyMapped ? { viaProperty: true as const } : {};
  const region = declaredOrder && etsRegionTablesSystem7(procedure) ? tableRegion(app, procedure, { addr, assoc }) : null;
  const regionTable = (lsm: number) => (!region ? null : lsm === OBJ.ADDR_TABLE ? { at: region.addrAt, size: addr.length, table: addr, source: "addrTable" as const } : lsm === OBJ.ASSOC_TABLE ? { at: region.assocAt, size: region.assocSize, table: assoc, source: "assocTable" as const } : null);
  for (const s of flattenSteps(procedure, "full")) {
    switch (s.verb) {
      case "LdCtrlUnload": plan.push({ op: "unload", lsm: need(lsmIdx(s), s.verb, "LsmIdx") }); break;
      case "LdCtrlLoad": plan.push({ op: "load", lsm: need(lsmIdx(s), s.verb, "LsmIdx") }); break;
      case "LdCtrlAbsSegment": {
        const l = need(lsmIdx(s), s.verb, "LsmIdx"), a = need(stepAddress(s), s.verb, "Address"), sz = need(stepSize(s), s.verb, "Size");
        const moved = regionTable(l);
        if (moved) {
          plan.push({ op: "absSegment", lsm: l, segType: segType(s), address: moved.at, size: moved.size, access: segAccess(s), memType: memType(s) ?? 0, segFlags: segFlags(s), ...via });
          for (const run of etsTableRuns(app, moved.at, moved.table, l === OBJ.ADDR_TABLE)) {
            plan.push({ op: "writeMem", address: run.address, bytes: run.image });
            segments.push({ id: (l === OBJ.ADDR_TABLE ? app.groupTables.addressSegment : app.groupTables.associationSegment) ?? `@${run.address}`, lsm: l, source: moved.source, address: run.address, image: run.image, verify: new Array<boolean>(run.image.length).fill(true) });
            imageBytes += run.image.length;
          }
          if (l === OBJ.ASSOC_TABLE && etsTableSegmentDataSystem7(procedure)) {
            for (const run of tableSegmentDataBehind(app, region!, moved.at + moved.table.length)) {
              plan.push({ op: "writeMem", address: run.address, bytes: run.image });
              segments.push({ ...run, lsm: l, source: "static", verify: new Array<boolean>(run.image.length).fill(true) });
              imageBytes += run.image.length;
            }
          }
          break;
        }
        plan.push({ op: "absSegment", lsm: l, segType: segType(s), address: a, size: sz, access: segAccess(s), memType: memType(s) ?? 0, segFlags: segFlags(s), ...via });
        const built = imageFor(a, sz);
        if (built && declaredOrder) {
          const seg = segByAddr.get(a);
          if (!seg) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the load procedure declares a segment at ${a} the application does not define; refusing to write an image we cannot build`);
          // The group tables to their built length; the application's segments, the com-object table's
          // among them, as segments loaded afresh (LSM 3 is unloaded and each declared): the TheLuxa P300's
          // com-object table segment holds application data behind the table, and ETS writes it whole
          // (theluxa-p300-ets6log-fulldownload.txt, "Execute image" rows 0x43FC-0x45EF).
          const table = built.source === "addrTable" || built.source === "assocTable";
          if (built.source === "comObjTable") refuseComObjectTableOverlaps(app, seg, built.image, opts.moduleInstances);
          for (const run of etsWrittenRuns(app, seg, built, table ? "table" : "loaded", opts.moduleInstances)) {
            plan.push({ op: "writeMem", address: run.address, bytes: run.image });
            segments.push({ id: seg.id, lsm: l, source: built.source, ...run });
            imageBytes += run.image.length;
          }
          break;
        }
        // A null image means the segment is declared but the device fills it itself: no memory write,
        // nothing to read back (so it is not added to `segments`).
        if (built) {
          // The segment data write is implicit in the declaration on these devices; write it now.
          plan.push({ op: "writeMem", address: a, bytes: built.image });
          segments.push({ id: segByAddr.get(a)?.id ?? `@${a}`, address: a, lsm: l, source: built.source, image: built.image, verify: built.verify });
          imageBytes += built.image.length;
        }
        break;
      }
      case "LdCtrlTaskSegment": {
        const l = need(lsmIdx(s), s.verb, "LsmIdx");
        plan.push({ op: "taskSegment", lsm: l, address: regionTable(l)?.at ?? need(stepAddress(s), s.verb, "Address"), peiType: app.appPeiType, manufacturer, appNumber: app.appNumber, version: app.appVersion, ...via });
        break;
      }
      // Only the form the application's capture shows, and only where absoluteFullStepRefusal has let it through.
      case "LdCtrlTaskCtrl1":
        if (!declaredOrder || !capturedTaskCtrl1(procedure, s)) {
          throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", `the load procedure declares ${s.verb} ${JSON.stringify(s.attrs)}, which no ETS capture of this application shows; refusing to run a partial recipe`);
        }
        plan.push({ op: "taskCtrl1", lsm: need(lsmIdx(s), s.verb, "LsmIdx"), address: need(stepAddress(s), s.verb, "Address"), count: Number(s.attrs.Count) });
        break;
      case "LdCtrlLoadCompleted": plan.push({ op: "loadCompleted", lsm: need(lsmIdx(s), s.verb, "LsmIdx") }); break;
      case "LdCtrlRestart": plan.push({ op: "restart", requireReboot: opts.requireReboot ?? true }); break;
      // Session lifecycle + the app-id check are the caller's (see System7Profile.downloadFull).
      case "LdCtrlConnect": case "LdCtrlDisconnect": case "LdCtrlCompareProp": break;
      default:
        throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", `the load procedure declares a step this full download cannot execute yet (${s.verb}); refusing to run a partial recipe`);
    }
  }
  return { plan, segments, imageBytes, ...(region ? { tableRefs: [{ lsm: OBJ.ADDR_TABLE, address: region.addrAt }, { lsm: OBJ.ASSOC_TABLE, address: region.assocAt }] } : {}) };
}

// The <Data> bytes of the declared table segments behind the tables (from `from` on) that ETS's full
// download writes on an application of ETS_TABLE_SEGMENT_DATA_SYSTEM7_APPS: not FF, and marked by the
// segment's <Mask> where it declares one.
function tableSegmentDataBehind(app: AppConfig, region: TableRegion, from: number): { id: string; address: number; image: Buffer }[] {
  const out: { id: string; address: number; image: Buffer }[] = [];
  for (const d of [region.d1, region.d2]) {
    const seg = app.absoluteSegments.find((s) => s.address === d.address);
    if (!seg) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the table segment declared at ${d.address} is not one the application defines; refusing to write its data blind`);
    const mask = segmentMask(seg);
    const written = (i: number) => seg.address + i >= from && i < seg.data.length && seg.data[i] !== 0xff && (!mask || mask[i] !== 0);
    const end = region.d2.address + region.d2.size;
    if (seg.data.some((_, i) => written(i) && (i >= d.size || seg.address + i >= end))) {
      throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `<Data> of ${seg.id} reaches past the size its load procedure declares or past the table region; refusing to write into another segment`);
    }
    out.push(...runsWhere(seg.data, written, seg.address, new Array<boolean>(seg.data.length).fill(true), null).map((r) => ({ id: seg.id, address: r.address, image: r.image })));
  }
  return out;
}

// The bytes of a segment ETS puts in its image, for the applications whose downloads are captured
// (loadproc.ts ETS_CAPTURED_SYSTEM7_APPS, ETS_DECLARED_ORDER_SYSTEM7_APPS). One rule fits every
// capture of both (docs/load-procedures.md, "Which bytes ETS writes"):
//  - "table": an address, association or com-object table, only as long as it is built, and of that
//    the bytes the segment's <Mask> marks, never the address table's own individual address (bytes 1-2:
//    outside the Gira's and the Auro's <Mask>, and left out of the TheLuxa P300's table, whose segment
//    declares no <Mask>);
//  - "loaded": a data segment ETS loads afresh (its load-state machine unloaded, LdCtrlAbsSegment
//    executed), the bytes the <Mask> marks and every byte a parameter's memory covers, the whole
//    segment where it declares no <Mask>; nothing where the <Mask> marks no byte and no parameter
//    covers one (the TheLuxa P300's RAM segment AS-0700, declared and not written);
//  - "writtenIntoApplication": a data segment of an application ETS leaves loaded (its log turns the
//    LdCtrlAbsSegment into LdCtrlWriteMem), every byte a parameter's memory covers and no other,
//    whatever the <Mask> marks.
// Each run is read back where a parameter's verify mask asks for it, and wholly where no parameter
// covers the byte.
type EtsSegmentKind = "table" | "loaded" | "writtenIntoApplication";
type Run = Pick<AbsFullSegment, "address" | "image" | "verify">;
function etsWrittenRuns(app: AppConfig, seg: CfgAbsSegment, built: Pick<AbsFullSegment, "image" | "verify">, kind: EtsSegmentKind, moduleInstances?: ModuleInstance[]): Run[] {
  const { image } = built;
  if (image.length > seg.size) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the image for segment ${seg.id} is ${image.length} B, longer than the segment's ${seg.size}; refusing to write past it`);
  const runs = etsWrittenRunsOf(app, seg, built, kind, moduleInstances);
  if (runs.length === 0 && kind === "loaded" && segmentMask(seg)?.every((b) => b === 0)) return runs;
  if (runs.length === 0) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `of segment ${seg.id} no byte would be written; the ETS captures show none such, refusing to leave a segment with <Data> out silently`);
  return runs;
}
function etsWrittenRunsOf(app: AppConfig, seg: CfgAbsSegment, built: Pick<AbsFullSegment, "image" | "verify">, kind: EtsSegmentKind, moduleInstances?: ModuleInstance[]): Run[] {
  const { image } = built;
  const mask = segmentMask(seg);
  if (!mask && kind === "loaded") return [{ address: seg.address, image, verify: built.verify }];
  const params = parameterMemoryBytes(app, seg.id, seg.size, { moduleInstances });
  if (!params) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `a parameter in segment ${seg.id} has a type of no known width, so the bytes the download writes there cannot be told; refusing to guess`);
  if (kind === "table") {
    if (params.some(Boolean)) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `a parameter's memory lies in the table segment ${seg.id}; no ETS capture shows which bytes it writes there, refusing to guess`);
    const addressTable = seg.address === app.absoluteSegments.find((x) => x.id === app.groupTables.addressSegment)?.address;
    refuseUnmarkedTableBytes(seg.id, mask, 0, image.length, addressTable);
    return runsWhere(image, (i) => !(addressTable && (i === 1 || i === 2)) && (!mask || mask[i] !== 0), seg.address, built.verify, null);
  }
  if (!mask) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `segment ${seg.id} declares no <Mask>, and no ETS capture shows which bytes of such a segment it writes into an application it leaves loaded; refusing to guess`);
  return runsWhere(image, kind === "loaded" ? (i) => mask[i] !== 0 || params[i] : (i) => params[i], seg.address, built.verify, params);
}

// An MV-0705 com-object table as ETS builds it: the 3-byte header and one 4-byte entry per object its
// first byte counts. A template or a device's table longer than that (the Gira M-0008's, by 8 bytes)
// keeps the rest, which ETS leaves out of its image.
// The com-object table's segment, written as a segment loaded afresh, is still the table's: refuse, as
// for a table, a parameter whose memory lies anywhere in the segment (its image is the table authored
// from the template, which carries no parameter value) and a <Mask> that leaves out a byte of the
// table's counted entries.
function refuseComObjectTableOverlaps(app: AppConfig, seg: CfgAbsSegment, image: Buffer, moduleInstances?: ModuleInstance[]): void {
  const params = parameterMemoryBytes(app, seg.id, seg.size, { moduleInstances });
  if (!params) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `a parameter in segment ${seg.id} has a type of no known width, so the bytes the download writes there cannot be told; refusing to guess`);
  if (params.some(Boolean)) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `a parameter's memory lies in the com-object table segment ${seg.id}; no ETS capture shows which bytes it writes there, refusing to guess`);
  refuseUnmarkedTableBytes(seg.id, segmentMask(seg), 0, builtComObjectTable(image).length, false);
}
function builtComObjectTable(image: Buffer): Buffer {
  const length = 3 + 4 * image[0];
  if (length > image.length) throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID", `the com-object table counts ${image[0]} objects, ${length} B, but is only ${image.length} B; refusing to write a truncated table`);
  return image.subarray(0, length);
}

// A table's bytes the <Mask> leaves out: the captures show only the address table's own individual
// address (bytes 1-2); any other would drop a table byte silently.
function refuseUnmarkedTableBytes(segId: string, mask: Buffer | undefined, from: number, length: number, addressTable: boolean): void {
  if (!mask) return;
  for (let i = from; i < from + length; i++) {
    if (mask[i] === 0 && !(addressTable && (i === 1 || i === 2))) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the <Mask> of ${segId} leaves out byte ${i} of the table written there; the ETS captures leave out only the address table's own individual address, refusing to drop a table byte`);
  }
}

// A segment's <Mask>, refused unless it is whole bytes over the whole segment, or over exactly its <Data>
// where that is shorter and the mask marks nothing: the forms the captures show. The Meteodata 140 S's RAM
// segment AS-1C00 declares 432 bytes with 342 of <Data> and a <Mask> of 342 zero bytes; ETS writes none
// of it (meteodata-140s-ets6log-fulldownload.txt, Memory[$1C00-$1DAF] without a row). Behind such a
// <Data> there is no byte to write, so the bytes behind the <Mask> count as unmarked.
function segmentMask(seg: CfgAbsSegment): Buffer | undefined {
  const mask = seg.mask;
  const shortUnmarked = !!mask && mask.length > 0 && mask.length === seg.data.length && mask.length < seg.size && mask.every((b) => b === 0);
  if (mask && !shortUnmarked && (mask.length !== seg.size || mask.some((b) => b !== 0 && b !== 0xff))) {
    throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `segment ${seg.id} declares a <Mask> of ${mask.length} bytes for ${seg.size} (${seg.data.length} of <Data>), or one that marks single bits; the ETS captures show whole-byte masks over the whole segment, or a mask marking nothing over a shorter <Data>, only; refusing to guess which bytes it writes`);
  }
  return mask && mask.length < seg.size ? Buffer.concat([mask, Buffer.alloc(seg.size - mask.length)]) : mask;
}

function runsWhere(image: Buffer, written: (i: number) => boolean, address: number, verify: ReadonlyArray<number | boolean>, params: boolean[] | null): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < image.length;) {
    if (!written(i)) { i++; continue; }
    const start = i;
    while (i < image.length && written(i)) i++;
    runs.push({ address: address + start, image: Buffer.from(image.subarray(start, i)), verify: Array.from({ length: i - start }, (_, k) => (!params || params[start + k] ? verify[start + k] : true)) });
  }
  return runs;
}

// A table ETS writes at `address`, which need not be the start of a segment (a captured application's
// association table sits behind the address table, inside the address table's declared segment): the
// runs of it the <Mask> of the segment holding each byte marks, the address table's own individual
// address (bytes 1-2) left out whatever the <Mask> says (etsWrittenRuns, "table").
function etsTableRuns(app: AppConfig, address: number, table: Buffer, addressTable: boolean): { address: number; image: Buffer }[] {
  const marked = Array.from(table, (_, i) => {
    const a = address + i;
    const seg = app.absoluteSegments.find((s) => a >= s.address && a < s.address + s.size);
    if (!seg) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the table written at ${address} reaches ${a}, which lies in no segment the application defines; refusing to write it blind`);
    const mask = segmentMask(seg);
    return !(addressTable && (i === 1 || i === 2)) && (!mask || mask[a - seg.address] !== 0);
  });
  marked.forEach((m, i) => {
    if (!m && !(addressTable && (i === 1 || i === 2))) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the <Mask> leaves out byte ${i} of the table written at ${address}; the ETS captures leave out only the address table's own individual address, refusing to drop a table byte`);
  });
  return runsWhere(table, (i) => marked[i], address, new Array<boolean>(table.length).fill(true), null).map(({ address: at, image }) => ({ address: at, image }));
}

// A digest of a full download's image: every segment's address (0xFFFFFFFF where the device assigns
// it), length and bytes, in plan order. Two plans with the same digest write the same bytes.
export function fullDownloadImageDigest(segments: readonly { address: number | null; image: Buffer }[]): string {
  const h = createHash("sha256");
  for (const s of segments) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(s.address ?? 0xffffffff, 0);
    head.writeUInt32BE(s.image.length, 4);
    h.update(head).update(s.image);
  }
  return h.digest("hex");
}
