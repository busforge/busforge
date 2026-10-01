import type { AppConfig, CfgAbsSegment, ModuleInstance } from "./appconfig.ts";
import { buildAbsoluteSegmentTargets, mergeOwnedBits, wholeBytes } from "./deviceimage.ts";
import { flattenSteps, lsmIdx, stepAddress, stepSize, memType, segType, segAccess, segFlags, type LoadProcedures, type McbWrite } from "./loadproc.ts";
import { buildGroupTablesMv0705, type ComObjectLink } from "./grouptables.ts";
import { buildComObjectTableMv0705 } from "./comobjbuild.ts";
import type { CfgComObjImage } from "./config.ts";
import { ProductError } from "./errors.ts";
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
    // is skipped, so a no-op reconfiguration produces an empty plan. Bits of a written byte that no
    // parameter owns are carried over from the device.
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
  const comObj = buildComObjectTableMv0705(comObjSeg.data, opts.comObjectTable.active, opts.comObjectTable.linked);
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
  const { addr, assoc } = buildGroupTablesMv0705(links, ownIa);
  const paramTargets = new Map(buildAbsoluteSegmentTargets(app, values, opts).map((t) => [t.address, t]));
  const segByAddr = new Map(app.absoluteSegments.map((s) => [s.address, s]));
  const manufacturer = Number.parseInt(String(app.id).split("_")[0].replace("M-", ""), 16);

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
      const image = buildComObjectTableMv0705(seg.data, opts.comObjectTable!.active, opts.comObjectTable!.linked);
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
  // A declared step whose attributes we cannot read is a recipe we cannot execute; refuse rather
  // than emit a plan that silently omits it. Same stance as the par path's coverage gate, but on
  // the "full" step list the planner actually runs.
  const need = <T>(v: T | undefined, verb: string, what: string): T => {
    if (v === undefined) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `${verb} is missing its ${what}; refusing to build a partial download`);
    return v;
  };
  for (const s of flattenSteps(procedure, "full")) {
    switch (s.verb) {
      case "LdCtrlUnload": plan.push({ op: "unload", lsm: need(lsmIdx(s), s.verb, "LsmIdx") }); break;
      case "LdCtrlLoad": plan.push({ op: "load", lsm: need(lsmIdx(s), s.verb, "LsmIdx") }); break;
      case "LdCtrlAbsSegment": {
        const l = need(lsmIdx(s), s.verb, "LsmIdx"), a = need(stepAddress(s), s.verb, "Address"), sz = need(stepSize(s), s.verb, "Size");
        plan.push({ op: "absSegment", lsm: l, segType: segType(s), address: a, size: sz, access: segAccess(s), memType: memType(s) ?? 0, segFlags: segFlags(s) });
        const built = imageFor(a, sz);
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
      case "LdCtrlTaskSegment":
        plan.push({ op: "taskSegment", lsm: need(lsmIdx(s), s.verb, "LsmIdx"), address: need(stepAddress(s), s.verb, "Address"), peiType: app.appPeiType, manufacturer, appNumber: app.appNumber, version: app.appVersion });
        break;
      case "LdCtrlLoadCompleted": plan.push({ op: "loadCompleted", lsm: need(lsmIdx(s), s.verb, "LsmIdx") }); break;
      case "LdCtrlRestart": plan.push({ op: "restart", requireReboot: opts.requireReboot ?? true }); break;
      // Session lifecycle + the app-id check are the caller's (see System7Profile.downloadFull).
      case "LdCtrlConnect": case "LdCtrlDisconnect": case "LdCtrlCompareProp": break;
      default:
        throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", `the load procedure declares a step this full download cannot execute yet (${s.verb}); refusing to run a partial recipe`);
    }
  }
  return { plan, segments, imageBytes };
}
