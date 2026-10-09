import { createHash } from "node:crypto";
import type { AppConfig, CfgAbsSegment, ModuleInstance } from "./appconfig.ts";
import { buildAbsoluteSegmentTargets, absoluteBuildInstances, mergeOwnedBits, wholeBytes, parameterMemoryBytes } from "./deviceimage.ts";
import { flattenSteps, lsmIdx, stepAddress, stepSize, memType, segType, segAccess, segFlags, closingSteps, taskCtrl1Of, type LoadProcedures, type McbWrite, type ClosingStep, type ClosingOp } from "./loadproc.ts";
import { buildGroupTablesMv0705, type ComObjectLink } from "./grouptables.ts";
import { buildComObjectTableMv0705 } from "./comobjbuild.ts";
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
// owned bytes that actually DIFFER, so an unchanged reconfiguration writes nothing. The parameter
// flash (planAbsoluteParFlash) widens a changed plan to the bytes ETS writes (parWriteSet).

export interface FlashRun { address: number; bytes: Buffer; } // absolute device address
export interface SegmentFlashPlan {
  id: string;
  address: number;
  size: number;
  runs: FlashRun[]; // contiguous byte runs to write via memWrite, sorted by address
  image: Buffer; // the segment as it is to end: the target's owned bits over the device's (`current`) bytes
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
      image,
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
// we emit the "par" download proven on hardware: for each LSM that owns a segment with
// bytes to write, Load -> write them (parWriteSet) -> LoadCompleted, then restart. The owned
// bytes and their values come from planAbsoluteSegmentFlash, so the owned-byte authority lives
// in exactly one place.
//
// `unplaceable` lists segments that have changed owned bytes but are NOT declared in the
// load procedure (so we have no LSM to load them under). They are reported, never
// silently dropped: the caller must refuse the flash rather than report a partial write
// as success.

export interface AbsParFlashPlan {
  plan: LoadPlan;
  // Per segment written by parameter coverage: the image written and which bytes it covers.
  covered: { id: string; address: number; image: Buffer; covered: boolean[] }[];
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

// A plan's restart as the confirmed restart (A_Restart type 1, erase code 1), where `confirmed`.
export function withConfirmedRestart(plan: LoadPlan, confirmed: boolean): LoadPlan {
  return confirmed ? plan.map((st) => (st.op === "restart" ? { ...st, confirmed: true } : st)) : plan;
}

// The PID 27 element of a memory-control block: region size (4), control (2), CRC (2).
const MCB_ELEMENT_BYTES = 8;

// The load steps of a download's closing steps (loadproc.ts closingSteps).
export function closingLoadSteps(steps: ClosingStep[]): LoadStep[] {
  return steps.map((c): LoadStep => c.kind === "read"
    ? { op: "readProp", obj: c.obj, pid: c.pid, start: c.start, count: c.count, elementSize: MCB_ELEMENT_BYTES }
    : { op: "writeProp", obj: c.obj, pid: c.pid, start: c.start, data: c.data, ...(c.verify ? {} : { echoPrefix: 0 }) });
}

// Put the steps that close a download (closingSteps) right before its restart, after every LoadCompleted,
// where ETS sends them.
export function withClosing(plan: LoadPlan, procedure: LoadProcedures, op: ClosingOp): LoadPlan {
  const steps = closingLoadSteps(closingSteps(procedure, op));
  if (!steps.length) return plan;
  const at = plan.findLastIndex((st) => st.op === "restart");
  if (at < 0 || plan.slice(0, at).every((st) => st.op !== "loadCompleted")) {
    throw new ProductError("LOAD_STEP_UNSUPPORTED", "the load procedure declares steps that close the download, and this plan has no completed load and restart to place them in");
  }
  return [...plan.slice(0, at), ...steps, ...plan.slice(at)];
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
  return planRelativeBracket(lsm, segs, appIdStamp, requireReboot, mcb, security);
}

// ETS's partial form of a System B full download, on a unit that holds the application loaded, of an
// application declaring PreferPartialDownloadIfApplicationLoaded (Jung 400021SE: no change, a parameter
// change, a parameter and link change, the revert; Theben DALI-Gateway): the structural flash's bracket
// with only the objects that have something to write. The address and association tables are always
// reloaded and written whole, a Data Secure unit's security object always reloaded. The application and
// the com-object table carry the bytes differentialMask selects, and an object with none is not reloaded
// at all (`params`/`comObj` null). No PEI unload: the application stays in the unit.
export function planRelativePartialFullDownload(
  lsm: number,
  segs: { params: KeptSegment | null; comObj: KeptSegment | null; addr: Buffer; assoc: Buffer },
  appIdStamp: Buffer, requireReboot = true, mcb: McbWrite[] = [], security?: SecurityObjectTables,
): LoadPlan {
  return planRelativeBracket(lsm, segs, appIdStamp, requireReboot, mcb, security);
}

// The bytes of an image to send into a segment the unit keeps: those holding an owned bit (`owned`, a
// bit mask per byte) that differ from what the unit holds (`current`), as a mask writeSegmentOwned takes.
export function changedOwned(image: Buffer, current: Buffer, owned: ReadonlyArray<number>): number[] {
  return Array.from(image, (b, i) => ((owned[i] ?? 0) !== 0 && (i >= current.length || current[i] !== b) ? 0xff : 0));
}

// A region of a segment's memory-control block (PID 27): its size and its CRC-control byte.
export interface McbRegion { size: number; control: number }

// The memory-control-block regions an application declares for its segment (the LdCtrlWriteProp to
// PID 27 its procedure writes after the allocation), in element order; null where it declares none.
export function declaredMcbRegions(mcb: McbWrite[]): McbRegion[] | null {
  if (!mcb.length) return null;
  return [...mcb].sort((a, b) => a.element - b.element).map((m) => ({ size: m.data.readUInt32BE(0), control: m.data[4] }));
}

// What ETS's differential download sends into a segment the unit keeps, region by region of the
// segment's memory-control block: in a region whose CRC-control byte is 0 the bytes that differ from the
// unit (`changed`), in any other region, past the regions, or where no region is known, every byte the
// image carries (`whole`). Jung 400021SE: the application's 7700-byte region (control 0) only where it
// changed, its declared one-byte region (control 1) in every download, the com-object table (control 0)
// only where it changed. Theben DALI-Gateway: the application (control 0) only where it changed, the
// com-object table (control 1) whole even unchanged. OpenKNX RaumController: the application (control 0)
// only where it changed, the com-object table, which reports no memory-control block, whole.
export function differentialMask(changed: ReadonlyArray<number>, whole: ReadonlyArray<number>, regions: McbRegion[] | null): number[] {
  const out = Array.from(whole);
  if (!regions) return out;
  let at = 0;
  for (const r of regions) {
    if (r.control === 0) for (let i = at; i < Math.min(at + r.size, out.length); i++) out[i] = changed[i];
    at += r.size;
  }
  return out;
}

function planRelativeBracket(
  lsm: number,
  segs: { params: KeptSegment | null; comObj: KeptSegment | null; addr: Buffer; assoc: Buffer },
  appIdStamp: Buffer, requireReboot: boolean, mcb: McbWrite[], security?: SecurityObjectTables,
): LoadPlan {
  const other = mcb.find((m) => m.obj !== lsm);
  if (other) throw new ProductError("LOAD_STEP_UNSUPPORTED", `an MCB entry for object ${other.obj}; the structural flash writes memory-control blocks of object ${lsm} only, as the parameter flash does`);
  const C = OBJ.COMOBJ_TABLE, A = OBJ.ASSOC_TABLE, D = OBJ.ADDR_TABLE;
  const { params, comObj } = segs;
  return [
    ...(params ? [{ op: "unload", lsm } as LoadStep] : []),
    ...(comObj ? [{ op: "unload", lsm: C } as LoadStep] : []),
    { op: "unload", lsm: A }, { op: "unload", lsm: D },
    ...(security ? [securityUnload] : []),
    ...(params ? [
      { op: "load", lsm }, { op: "alloc", lsm, size: params.image.length },
      ...mcb.map((m): LoadStep => ({ op: "writeProp", obj: lsm, pid: 27, start: m.element, data: m.data, echoPrefix: m.echoPrefix })),
    ] as LoadStep[] : []),
    ...(comObj ? [{ op: "load", lsm: C, assert: false }, { op: "alloc", lsm: C, size: comObj.image.length }] as LoadStep[] : []),
    { op: "load", lsm: D, assert: false }, { op: "alloc", lsm: D, size: segs.addr.length },
    { op: "load", lsm: A, assert: false }, { op: "alloc", lsm: A, size: segs.assoc.length },
    ...(params ? [{ op: "writeSegmentOwned", lsm, ...params } as LoadStep] : []),
    ...(comObj ? [{ op: "writeSegmentOwned", lsm: C, ...comObj } as LoadStep] : []),
    { op: "writeSegment", lsm: A, bytes: segs.assoc },
    { op: "writeSegment", lsm: D, bytes: segs.addr },
    ...(security ? planSecurityObjectLoad(security) : []),
    ...(params ? [{ op: "stampAppId", lsm, data: appIdStamp }, { op: "loadCompleted", lsm }] as LoadStep[] : []),
    ...(comObj ? [{ op: "loadCompleted", lsm: C, assert: false } as LoadStep] : []),
    { op: "loadCompleted", lsm: A, assert: false }, { op: "loadCompleted", lsm: D, assert: false },
    ...(comObj ? [{ op: "assertLoaded", lsm: C } as LoadStep] : []),
    { op: "assertLoaded", lsm: A }, { op: "assertLoaded", lsm: D },
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
export interface AbsStructuralFlashPlan { plan: LoadPlan; changedBytes: number; lsms: number[]; concerned: number[]; segments: AbsStructuralSegment[]; tableRefs?: { lsm: number; address: number }[] }

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
// download of such a change (MDT BE-02001.02, input B switched between a one-object and a two-object
// function; the reverts of the Auro M-0081, Gira M-0008, TheLuxa P300, Meteodata 140 S and MDT BE-06001.02):
// one bracket set and one restart. Both group tables unloaded and written as the group-address flash writes
// them (planSystem7TableBrackets), then the application loaded without unloading or declaring it, the
// com-object table to its counted entries and the parameter bytes written, completed, the steps that close
// the download, the restart. Of the parameter segments the bytes the parameter flash writes (parWriteSet).
// `current`: what the device holds at each image's address, at the image's length.
// `concerned`: every load-state machine the plan loads, for the load-state check.
export function planAbsoluteStructuralFlash(
  app: AppConfig,
  images: AbsStructuralImage[],
  procedure: LoadProcedures,
  current: ReadonlyMap<number, Buffer>,
  requireReboot: boolean,
  moduleInstances: ModuleInstance[], // the instances the images were built with, for the bytes a parameter covers
): AbsStructuralFlashPlan {
  const g = app.groupTables;
  const at = (id: string | undefined) => app.absoluteSegments.find((x) => x.id === id)?.address;
  const imageAt = (id: string | undefined, which: string) => {
    const w = images.find((x) => x.address === at(id));
    if (!w) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the structural flash has no ${which} table image; refusing a partial write`);
    return w;
  };
  const addrImg = imageAt(g.addressSegment, "address"), assocImg = imageAt(g.associationSegment, "association"), comImg = imageAt(g.comObjectSegment, "com-object");
  const tables = planSystem7TableBrackets(app, procedure, { addr: addrImg.image, assoc: assocImg.image });
  const comObjWrites = etsTableRuns(app, comImg.address, builtComObjectTable(comImg.image), false);
  const lsmByAddress = new Map<number, number>();
  for (const st of flattenSteps(procedure, "full")) {
    if (st.verb === "LdCtrlAbsSegment") { const a = stepAddress(st), l = lsmIdx(st); if (a !== undefined && l !== undefined) lsmByAddress.set(a, l); }
  }
  const segments: AbsStructuralSegment[] = [
    ...tables.writes.map((w) => ({ id: w.lsm === OBJ.ADDR_TABLE ? addrImg.id : assocImg.id, address: w.address, lsm: w.lsm, image: w.image, verify: new Array<number>(w.image.length).fill(0xff) })),
    ...comObjWrites.map((w) => ({ id: comImg.id, address: w.address, lsm: APP_LSM, image: w.image, verify: new Array<number>(w.image.length).fill(0xff) })),
  ];
  const paramWrites: LoadStep[] = [];
  let changedBytes = 0;
  const tableIds = new Set([addrImg.id, assocImg.id, comImg.id]);
  // The parameter bytes, as the parameter flash writes them (parWriteSet): those that differ from the
  // device, and on a property-mapped mask, once any does, every byte a parameter covers in every parameter
  // segment, a covered byte no parameter owns with the device's value and checked back as such.
  const params = images.filter((x) => !tableIds.has(x.id)).map((w) => {
    const have = current.get(w.address);
    if (!have || have.length !== w.image.length) {
      throw new ProductError("PARAM_SEGMENT_NOT_READ", `the device's ${w.id} was not read in full (${have?.length ?? 0} of ${w.image.length} B); refusing to write its shared bytes without the bits it holds`);
    }
    const image = Buffer.from(w.image.map((b, i) => mergeOwnedBits(have[i], b, w.owned[i])));
    return { w, image, differing: w.owned.map((own, i) => own !== 0 && have[i] !== image[i]) };
  });
  const anyDiffers = params.some((x) => x.differing.some(Boolean));
  for (const { w, image, differing } of params) {
    let write = differing, verify = w.verify;
    if (anyDiffers && parWriteSet(app) === "parameterBytes") {
      const cov = parameterMemoryBytes(app, w.id, w.image.length, { moduleInstances, colorWidth: true });
      if (!cov) throw new ProductError("PARAM_SEGMENT_UNKNOWN", `a parameter in segment ${w.id} has a type of no known width, so the bytes ETS's download writes there cannot be told; refusing to guess`);
      const outside = differing.flatMap((d, i) => (d && !cov[i] ? [i] : []));
      if (outside.length) throw new ProductError("PARAM_SEGMENT_UNKNOWN", `segment ${w.id}: ${outside.length} changed byte(s) (first at offset ${outside[0]}) lie outside every parameter's memory; refusing a write set that would leave them out`);
      write = cov;
      verify = w.verify.map((v, i) => (cov[i] && !w.owned[i] ? 0xff : v));
    }
    const runs = runsFromMask(image, w.address, write);
    if (!runs.length) continue;
    // A segment without a change that the procedure does not load with the application (load-state machine
    // 3, the only one this bracket loads) is left out; a changed one there is refused below.
    if (!differing.some(Boolean) && lsmByAddress.get(w.address) !== APP_LSM) continue;
    if (lsmByAddress.get(w.address) !== APP_LSM) {
      throw new ProductError("FLASH_SEGMENT_UNPLACEABLE", `segment ${w.id} is to be written but the load procedure does not load it with the application (load-state machine ${APP_LSM}); refusing a partial write`);
    }
    changedBytes += differing.filter(Boolean).length;
    segments.push({ id: w.id, address: w.address, lsm: APP_LSM, image, verify });
    paramWrites.push(...runs.map((r): LoadStep => ({ op: "writeMem", address: r.address, bytes: r.bytes })));
  }
  for (const w of [...tables.writes, ...comObjWrites]) {
    const have = current.get(w.address);
    changedBytes += have && have.length >= w.image.length ? w.image.reduce((n, b, i) => n + (have[i] !== b ? 1 : 0), 0) : w.image.length;
  }
  const plan = withClosing([
    ...tables.steps,
    { op: "load", lsm: APP_LSM }, ...comObjWrites.map((r): LoadStep => ({ op: "writeMem", address: r.address, bytes: r.image })), ...paramWrites, { op: "loadCompleted", lsm: APP_LSM },
    { op: "restart", requireReboot },
  ], procedure, "par");
  const lsms = [OBJ.ADDR_TABLE, OBJ.ASSOC_TABLE, APP_LSM];
  return { plan, changedBytes, lsms, concerned: lsms, segments, ...tableRefsOf(app, tables) };
}

// Which bytes ETS's parameter download of a System 7 application writes, by its mask family. On a
// memory-mapped mask (MV-0700/0701) ETS reads each block of its image and writes only the bytes that
// differ (its "optimistic write"; Theben Meteodata 140 S, ABB US/U 4.2). On a property-mapped mask it
// writes every byte a parameter's memory covers, changed or not (Auro M-0081_A-FE01, Theben TheLuxa
// P300, MDT BE-06001.02 partial downloads; their ETS logs list exactly those bytes as the image). Where
// the application closes with image stamps (LdCtrlLoadImageProp PID 27, the Gira M-0008), ETS writes only
// what differs from its record of its last download while the stamps still equal that record, and the
// same every-covered-byte image where they do not; Busforge keeps no record, so it writes that image.
export type ParWriteSet = "differing" | "parameterBytes";
export const parWriteSet = (app: AppConfig): ParWriteSet => (isMemoryMappedLsm(app.mask) ? "differing" : "parameterBytes");

export function planAbsoluteParFlash(
  app: AppConfig,
  values: Map<string, string>,
  procedure: LoadProcedures,
  current: Map<string, Buffer>, // AbsoluteSegment Id -> live device bytes
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; requireReboot?: boolean } = {},
): AbsParFlashPlan {
  const fp = planAbsoluteSegmentFlash(app, values, { ...opts, current });
  // What ETS writes of a parameter download (parWriteSet): on a memory-mapped mask it reads its image
  // first and writes the bytes that differ, which are fp's runs; elsewhere every byte a parameter's
  // memory covers, in every parameter segment, once anything changed.
  // `covered` is what the caller verifies besides the owned bytes: the device's own values it rewrote.
  const differing = fp.segments.reduce((n, sg) => n + sg.writtenBytes, 0);
  const covered: AbsParFlashPlan["covered"] = [];
  if (differing > 0 && parWriteSet(app) === "parameterBytes") {
    const instances = absoluteBuildInstances(app, values, opts.moduleInstances);
    for (const sg of fp.segments) {
      const cov = parameterMemoryBytes(app, sg.id, sg.size, { moduleInstances: instances, colorWidth: true });
      if (!cov) throw new ProductError("PARAM_SEGMENT_UNKNOWN", `a parameter in segment ${sg.id} has a type of no known width, so the bytes ETS's parameter download writes there cannot be told; refusing to guess`);
      const outside = sg.runs.flatMap((r) => [...r.bytes.keys()].map((k) => r.address - sg.address + k)).filter((i) => !cov[i]);
      if (outside.length) throw new ProductError("PARAM_SEGMENT_UNKNOWN", `segment ${sg.id}: ${outside.length} changed byte(s) (first at offset ${outside[0]}) lie outside every parameter's memory; refusing a write set that would leave them out`);
      sg.runs = runsFromMask(sg.image, sg.address, cov);
      covered.push({ id: sg.id, address: sg.address, image: sg.image, covered: cov });
    }
  }

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
    if (!seg.runs.length) continue; // nothing to write in this segment
    const lsm = lsmByAddress.get(seg.address);
    // A segment without a change whose LSM the procedure does not load is left out, as before coverage
    // writes: nothing of it has to reach the device.
    if (seg.writtenBytes === 0 && (lsm === undefined || !lsmOrder.includes(lsm))) continue;
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
    // The steps that close the download (closingSteps), after the last LoadCompleted.
    plan.push(...closingLoadSteps(closingSteps(procedure, "par")));
    if (has("LdCtrlRestart")) plan.push({ op: "restart", requireReboot: opts.requireReboot ?? true });
  }
  return { plan, changedBytes, segments, unplaceable, covered };
}

// ── Full download and group-address flash for absolute-segment (System 7) devices ────────────────
//
// What ETS sends follows from the application's catalogue entry, by rule (docs/load-procedures.md,
// "The rules, by level"):
//   - which form of the procedure (absoluteFullForm): the declared ProductProcedure step by step, or,
//     where the application declares PreferPartialDownloadIfApplicationLoaded and the unit holds it
//     loaded, the partial form that reloads the group tables and leaves the application loaded;
//   - how the declarations travel (declarationTransport): PID 5 on a property-mapped mask, the
//     0x0104 control on a memory-mapped one;
//   - where the group tables go (tablePlacement): the declared segments, or with
//     DynamicTableManagement="true" one region of both;
//   - which bytes of each segment (etsWrittenRuns, tableSegmentData) and the steps that close it
//     (closingSteps).
// Connect, the app-id CompareProp and disconnect are the caller's (session + preflight), not emitted here.
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
  // Where the group tables are re-declared away from their declared segments (DynamicTableManagement):
  // the address each table's load-state machine must reference (PID 7) after the download, or the
  // device does not read the bytes written.
  tableRefs?: { lsm: number; address: number }[];
}

// Which form of its procedure ETS runs for a full download. "partial": the application declares
// PreferPartialDownloadIfApplicationLoaded and the unit holds it, loaded (ETS6.log "Trying partial/
// differential download because of PreferPartialDownloadIfApplicationLoaded"; Gira M-0008, ABB US/U 4.2
// captures). "declared": every other case, ETS reading no load state before it (Auro M-0081, TheLuxa
// P300, Meteodata 140 S, MDT BE-02001.02 and BE-06001.02 captures).
export type AbsFullForm = "declared" | "partial";
export const absoluteFullForm = (procedure: LoadProcedures, unitHoldsApplication: boolean): AbsFullForm =>
  procedure.preferPartialIfLoaded && unitHoldsApplication ? "partial" : "declared";

// The declared "full" steps planAbsoluteFullDownload executes, with the attributes each needs. Connect,
// disconnect and the app-id CompareProp are the caller's (System7Profile.downloadFull).
const ABS_FULL_STEP_ATTRS: Record<string, readonly string[]> = {
  LdCtrlUnload: ["LsmIdx"], LdCtrlLoad: ["LsmIdx"], LdCtrlLoadCompleted: ["LsmIdx"],
  LdCtrlAbsSegment: ["LsmIdx", "Address", "Size"], LdCtrlTaskSegment: ["LsmIdx", "Address"],
  LdCtrlRestart: [], LdCtrlConnect: [], LdCtrlDisconnect: [], LdCtrlCompareProp: [],
};

export interface StepRefusal { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" | "FULL_DOWNLOAD_STEP_MALFORMED" | "FULL_DOWNLOAD_SEGMENT_UNKNOWN" | "LOAD_PROCEDURE_UNSUPPORTED"; message: string }

// Why the absolute full download cannot run this declared procedure in `form`, or null when it can. The
// planner refuses with exactly this, and capabilities() offers the full download only where one form
// can run, so the UI never offers a download the planner then refuses.
export function absoluteFullStepRefusal(procedure: LoadProcedures, form: AbsFullForm = "declared"): StepRefusal | null {
  const steps = flattenSteps(procedure, "full");
  if (steps.length === 0 || procedure.style !== "ProductProcedure") {
    return { code: "LOAD_PROCEDURE_UNSUPPORTED", message: `the application declares no full-download procedure of its own (load procedure style ${procedure.style}); refusing to commission it from a recipe Busforge would have to invent` };
  }
  try { closingSteps(procedure, "full"); } catch (e) { return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: (e as Error).message }; }
  if (form === "partial") return partialStepRefusal(steps);
  const restartAt = steps.findIndex((s) => s.verb === "LdCtrlRestart");
  for (const [i, s] of steps.entries()) {
    if (restartAt >= 0 && i > restartAt && s.verb !== "LdCtrlDisconnect") {
      return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares ${s.verb}${lsmIdx(s) !== undefined ? ` LsmIdx ${lsmIdx(s)}` : ""} after the restart, which no capture shows ETS sending; refusing to run a partial recipe` };
    }
    if (s.verb === "LdCtrlTaskCtrl1") {
      const t = taskCtrl1Of(s);
      if (typeof t === "string") return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares LdCtrlTaskCtrl1 ${JSON.stringify(s.attrs)}: ${t}; refusing to guess what it sends` };
      continue;
    }
    if (s.verb === "LdCtrlLoadImageProp" || s.verb === "LdCtrlWriteProp") {
      if (closingSteps(procedure, "full").length && isAfterLastLoadCompleted(steps, i)) continue;
      return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares ${s.verb} inside a load bracket, which no capture shows; refusing to run a partial recipe` };
    }
    const needs = ABS_FULL_STEP_ATTRS[s.verb];
    if (!needs) return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares a step this full download cannot execute yet (${s.verb}); refusing to run a partial recipe` };
    const missing = needs.find((a) => s.attrs[a] === undefined);
    if (missing) return { code: "FULL_DOWNLOAD_STEP_MALFORMED", message: `${s.verb} is missing its ${missing}; refusing to build a partial download` };
  }
  return null;
}
// What the application's segments keep a full download from writing, before anything is planned, so
// capabilities() does not offer it:
//  - a parameter segment without <Data>, which has no default image: ETS computes the bytes no active
//    parameter derives from defaults it does not ship (the Steinel M-008E's read-back keeps 4 such bytes
//    Busforge cannot build), so writing the segment would write guessed bytes;
//  - a segment declared in the procedure whose <Mask> is of a form no capture shows (segmentMask).
export function fullDownloadSegmentRefusal(app: AppConfig, procedure: LoadProcedures): StepRefusal | null {
  const dataLess = app.absoluteSegments.find((sg) => sg.data.length === 0 && [...app.params.values()].some((p) => p.codeSegment === sg.id && p.offset !== undefined));
  if (dataLess) return { code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: `parameter segment ${dataLess.id} declares no <Data>, so the bytes no active parameter derives cannot be built; refusing to write a guessed image` };
  const declared = new Set(flattenSteps(procedure, "full").filter((st) => st.verb === "LdCtrlAbsSegment").map(stepAddress));
  for (const sg of app.absoluteSegments.filter((x) => declared.has(x.address))) {
    try { segmentMask(sg); } catch (e) { return { code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: (e as Error).message }; }
  }
  return null;
}
const isAfterLastLoadCompleted = (steps: ReturnType<typeof flattenSteps>, i: number): boolean =>
  i > steps.findLastIndex((s) => s.verb === "LdCtrlLoadCompleted");

// What each declared full step becomes in the partial form (Gira M-0008 and ABB US/U 4.2 captures).
// Anything outside this list refuses.
const TABLE_LSMS = [OBJ.ADDR_TABLE, OBJ.ASSOC_TABLE] as const;
const APP_LSM = OBJ.COMOBJ_TABLE; // LSM 3: the application's segments, the com-object table among them
const PARTIAL_STEPS: { verb: string; lsms?: readonly number[]; what: string }[] = [
  { verb: "LdCtrlConnect", what: "the caller's session" }, { verb: "LdCtrlDisconnect", what: "the caller's session" },
  { verb: "LdCtrlCompareProp", what: "the caller's pre-flight" }, { verb: "LdCtrlRestart", what: "sent" },
  { verb: "LdCtrlUnload", lsms: [1, 2, 3], what: "sent for the tables, not for the application" },
  { verb: "LdCtrlLoad", lsms: [1, 2, 3], what: "sent" }, { verb: "LdCtrlLoadCompleted", lsms: [1, 2, 3], what: "sent" },
  { verb: "LdCtrlAbsSegment", lsms: [1, 2, 3], what: "declared for the tables (tablePlacement); for the application, its data written" },
  { verb: "LdCtrlTaskSegment", lsms: [1, 2, 3, 5], what: "sent for the tables, not for the application or LSM 5" },
  { verb: "LdCtrlTaskCtrl1", lsms: [3], what: "not sent" }, { verb: "LdCtrlLoadImageProp", what: "a closing read" },
];

function partialStepRefusal(steps: ReturnType<typeof flattenSteps>): StepRefusal | null {
  for (const s of steps) {
    const known = PARTIAL_STEPS.find((c) => c.verb === s.verb);
    const l = lsmIdx(s);
    if (!known || (known.lsms && (l === undefined || !known.lsms.includes(l)))) {
      return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares ${s.verb}${l !== undefined ? ` LsmIdx ${l}` : ""}, which no capture shows in ETS's partial form of a full download; refusing to run a partial recipe` };
    }
  }
  return null;
}

interface AbsDecl { lsm: number; segType: number; address: number; size: number; access: number; memType: number; segFlags: number }
const absDecl = (s: ReturnType<typeof flattenSteps>[number]): AbsDecl | null => {
  const lsm = lsmIdx(s), address = stepAddress(s), size = stepSize(s);
  return lsm === undefined || address === undefined || size === undefined ? null : { lsm, segType: segType(s), address, size, access: segAccess(s), memType: memType(s) ?? 0, segFlags: segFlags(s) };
};

export interface System7Tables { steps: LoadStep[]; addrAt: number; assocAt: number; moved: boolean; writes: { lsm: number; address: number; image: Buffer }[] }

// Where the group tables go. With DynamicTableManagement="true" ETS takes the two declared table
// segments as one region: the address table's segment exactly as long as the table, the association
// table's directly behind it with the rest (Gira M-0008, TheLuxa P300, Meteodata 140 S). Otherwise each
// table in the segment its load-state machine declares (Auro M-0081, MDT BE-02001.02 and BE-06001.02,
// ABB US/U 4.2). Each table's task segment is declared at the table's address.
interface TablePlacement { d1: AbsDecl; d2: AbsDecl; t1: number; t2: number; addrAt: number; addrSize: number; assocAt: number; assocSize: number; moved: boolean }
function tablePlacement(app: AppConfig, procedure: LoadProcedures, tables: { addr: Buffer; assoc: Buffer }): TablePlacement {
  const steps = flattenSteps(procedure, "full");
  const decl = (lsm: number): { d: AbsDecl; task: number } => {
    const ds = steps.filter((s) => s.verb === "LdCtrlAbsSegment" && lsmIdx(s) === lsm).map(absDecl);
    const ts = steps.filter((s) => s.verb === "LdCtrlTaskSegment" && lsmIdx(s) === lsm).map(stepAddress);
    if (ds.length !== 1 || !ds[0]) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `the load procedure declares ${ds.length} readable segment(s) for load-state machine ${lsm}, where a group table takes one; refusing to place the table`);
    if (ts.length !== 1 || ts[0] === undefined) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `the load procedure declares ${ts.length} task segment(s) for load-state machine ${lsm}, where a group table takes one; refusing to place the table`);
    return { d: ds[0], task: ts[0] };
  };
  const [{ d: d1, task: t1 }, { d: d2, task: t2 }] = TABLE_LSMS.map(decl);
  const segAt = (id: string | undefined) => app.absoluteSegments.find((s) => s.id === id)?.address;
  if (segAt(app.groupTables.addressSegment) !== d1.address || segAt(app.groupTables.associationSegment) !== d2.address) {
    throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the table segments the load procedure declares (${d1.address}+${d1.size}, ${d2.address}+${d2.size}) are not the application's address and association tables; refusing to write them blind`);
  }
  const cap = app.groupTables;
  if ((cap.addressMaxEntries !== undefined && tables.addr.length > 3 + 2 * cap.addressMaxEntries) || (cap.associationMaxEntries !== undefined && tables.assoc.length > 1 + 2 * cap.associationMaxEntries)) {
    throw new ProductError("GA_TABLE_TOO_LARGE", `the tables need address ${tables.addr.length} B / association ${tables.assoc.length} B, more entries than the application declares (${cap.addressMaxEntries} addresses, ${cap.associationMaxEntries} associations); remove links or assign fewer group addresses`);
  }
  if (!procedure.dynamicTables) {
    if (tables.addr.length > d1.size) throw new ProductError("GA_TABLE_TOO_LARGE", `the address table needs ${tables.addr.length} B but its segment reserves only ${d1.size} B; assign fewer group addresses`);
    if (tables.assoc.length > d2.size) throw new ProductError("GA_TABLE_TOO_LARGE", `the association table needs ${tables.assoc.length} B but its segment reserves only ${d2.size} B; remove links`);
    return { d1, d2, t1, t2, addrAt: d1.address, addrSize: d1.size, assocAt: d2.address, assocSize: d2.size, moved: false };
  }
  if (d1.address + d1.size !== d2.address) {
    throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `the table segments (${d1.address}+${d1.size}, ${d2.address}+${d2.size}) do not lie one behind the other; ETS takes them as one region only where they do, refusing to guess another layout`);
  }
  const region = d1.size + d2.size;
  if (tables.addr.length + tables.assoc.length > region) {
    throw new ProductError("GA_TABLE_TOO_LARGE", `the address table (${tables.addr.length} B) and the association table (${tables.assoc.length} B) need more than the ${region} B the application reserves for both; remove links or assign fewer group addresses`);
  }
  const assocAt = d1.address + tables.addr.length;
  return { d1, d2, t1: d1.address, t2: assocAt, addrAt: d1.address, addrSize: tables.addr.length, assocAt, assocSize: region - tables.addr.length, moved: true };
}

// The address and association tables as ETS writes them in a full or group-address download: both
// load-state machines unloaded, each table in its own bracket (load, the segment declared where
// tablePlacement puts it, the bytes ETS's image holds (etsTableRuns), the task segment, completion).
// `withData`: also the table segments' <Data> no table can reach (tableSegmentData), which ETS writes
// in its full download only (Meteodata 140 S).
export function planSystem7TableBrackets(app: AppConfig, procedure: LoadProcedures, tables: { addr: Buffer; assoc: Buffer }, opts: { withData?: boolean } = {}): System7Tables & { placement: TablePlacement; data: { id: string; address: number; image: Buffer }[] } {
  const p = tablePlacement(app, procedure, tables);
  // A table segment that also holds a parameter's memory: no capture shows which bytes ETS writes there.
  for (const d of [p.d1, p.d2]) {
    const seg = app.absoluteSegments.find((x) => x.address === d.address)!;
    const params = parameterMemoryBytes(app, seg.id, seg.size);
    if (!params) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `a parameter in segment ${seg.id} has a type of no known width, so the bytes the download writes there cannot be told; refusing to guess`);
    if (params.some(Boolean)) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `a parameter's memory lies in the table segment ${seg.id}; no ETS capture shows which bytes it writes there, refusing to guess`);
  }
  const manufacturer = appManufacturerNumber(app);
  const writes: System7Tables["writes"] = [];
  const data = opts.withData ? tableSegmentData(app, p, tables) : [];
  const bracket = (d: AbsDecl, at: number, size: number, task: number, bytes: Buffer, extra: { address: number; image: Buffer }[]): LoadStep[] => {
    const runs = etsTableRuns(app, at, bytes, d.lsm === OBJ.ADDR_TABLE);
    writes.push(...runs.map((r) => ({ lsm: d.lsm, ...r })));
    return [
      { op: "load", lsm: d.lsm },
      { op: "absSegment", lsm: d.lsm, segType: d.segType, address: at, size, access: d.access, memType: d.memType, segFlags: d.segFlags, ...declarationTransport(app) },
      ...[...runs, ...extra].map((r): LoadStep => ({ op: "writeMem", address: r.address, bytes: r.image })),
      { op: "taskSegment", lsm: d.lsm, address: task, peiType: app.appPeiType, manufacturer, appNumber: app.appNumber, version: app.appVersion, ...declarationTransport(app) },
      { op: "loadCompleted", lsm: d.lsm },
    ];
  };
  // The data of a region goes in the association table's bracket, where the Meteodata capture writes it.
  const dataOf = (lsm: number) => data.filter((w) => (p.moved ? lsm === OBJ.ASSOC_TABLE : w.address >= (lsm === OBJ.ADDR_TABLE ? p.d1 : p.d2).address && w.address < (lsm === OBJ.ADDR_TABLE ? p.d1 : p.d2).address + (lsm === OBJ.ADDR_TABLE ? p.d1 : p.d2).size));
  return {
    placement: p, data, addrAt: p.addrAt, assocAt: p.assocAt, moved: p.moved, writes,
    steps: [
      { op: "unload", lsm: p.d1.lsm }, { op: "unload", lsm: p.d2.lsm },
      ...bracket(p.d1, p.addrAt, p.addrSize, p.t1, tables.addr, dataOf(OBJ.ADDR_TABLE)),
      ...bracket(p.d2, p.assocAt, p.assocSize, p.t2, tables.assoc, dataOf(OBJ.ASSOC_TABLE)),
    ],
  };
}

const appManufacturerNumber = (app: AppConfig): number => Number.parseInt(String(app.id).split("_")[0].replace("M-", ""), 16);
// How a segment declaration travels: the LSM's PID 5 on a property-mapped mask, the 0x0104 control (no
// flag) on a memory-mapped one (Auro, TheLuxa, Gira, MDT captures: PID 5; Meteodata, ABB: 0x0104).
const declarationTransport = (app: AppConfig): { viaProperty?: true } => (isMemoryMappedLsm(app.mask) ? {} : { viaProperty: true });

// The group-address flash of a System 7 application, as ETS's partial download after a link change
// writes it (Gira M-0008, TheLuxa P300, Meteodata 140 S, Auro M-0081, MDT BE-02001.02 and BE-06001.02,
// ABB US/U 4.2 captures): both tables unloaded and written in their brackets (planSystem7TableBrackets),
// the com-object table to its counted entries in the application's load bracket without unloading or
// declaring it, the steps that close the download, the restart. `comObjWrites`: what is written of the
// com-object table, for the read-back.
export function planSystem7GaFlash(app: AppConfig, procedure: LoadProcedures, tables: { addr: Buffer; assoc: Buffer }, comObj: { address: number; bytes: Buffer } | null, requireReboot = true): System7Tables & { plan: LoadPlan; comObjWrites: { address: number; image: Buffer }[] } {
  if (procedure.style !== "ProductProcedure") throw new ProductError("LOAD_STEP_UNSUPPORTED", `the group-address flash follows the application's own load procedure, and this one declares none (style ${procedure.style})`);
  const t = planSystem7TableBrackets(app, procedure, tables);
  const comObjWrites = comObj ? etsTableRuns(app, comObj.address, builtComObjectTable(comObj.bytes), false) : [];
  const app3: LoadStep[] = comObj ? [{ op: "load", lsm: APP_LSM }, ...comObjWrites.map((r): LoadStep => ({ op: "writeMem", address: r.address, bytes: r.image })), { op: "loadCompleted", lsm: APP_LSM }] : [];
  const { placement: _p, data: _d, ...tables7 } = t;
  return { ...tables7, comObjWrites, plan: withClosing([...t.steps, ...app3, { op: "restart", requireReboot }], procedure, "grp") };
}

// The table references (PID 7) a System 7 download's verify asks the unit for, as the group-address
// flash does: where the plan moved the tables away from their declared segments, and on every
// property-mapped mask, whose table objects answer PID 7.
function tableRefsOf(app: AppConfig, t: { moved: boolean; addrAt: number; assocAt: number }): { tableRefs?: { lsm: number; address: number }[] } {
  return t.moved || !isMemoryMappedLsm(app.mask) ? { tableRefs: [{ lsm: OBJ.ADDR_TABLE, address: t.addrAt }, { lsm: OBJ.ASSOC_TABLE, address: t.assocAt }] } : {};
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
  // `form`: which form of the procedure (absoluteFullForm), from the unit's state.
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; requireReboot?: boolean; propertyMapped: boolean; form: AbsFullForm; comObjectTable?: { active: Map<number, CfgComObjImage>; linked: ReadonlySet<number> } },
): AbsFullDownloadPlan {
  // A declared step we cannot execute, or whose attributes we cannot read, is a recipe we cannot
  // run; refuse before building anything rather than emit a plan that silently omits it.
  const refusal = absoluteFullStepRefusal(procedure, opts.form) ?? fullDownloadSegmentRefusal(app, procedure);
  if (refusal) throw new ProductError(refusal.code, refusal.message);
  const propertyMapped = opts.propertyMapped;
  const tableAddr = (segId: string | undefined, which: string): number | undefined => {
    if (segId === undefined) return undefined;
    const seg = app.absoluteSegments.find((s) => s.id === segId);
    if (!seg) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the ${which} table names segment ${segId}, which the application does not define; refusing to author the group tables blind`);
    return seg.address;
  };
  tableAddr(app.groupTables.addressSegment, "address");
  tableAddr(app.groupTables.associationSegment, "association");
  const comObjTableAddr = opts.comObjectTable ? tableAddr(app.groupTables.comObjectSegment, "com-object") : undefined;
  const { addr, assoc } = buildGroupTablesMv0705(links, ownIa);
  const paramTargets = new Map(buildAbsoluteSegmentTargets(app, values, opts).map((t) => [t.address, t]));
  const segByAddr = new Map(app.absoluteSegments.map((s) => [s.address, s]));
  const manufacturer = appManufacturerNumber(app);

  // The bytes a segment of the application carries, or null to declare the segment in the LSM bracket but
  // write NOTHING to it (a property-mapped device fills its own computed segments, e.g. the RAM/system
  // segment AS-0700-class the app declares with no <Data>; ETS writes 0 bytes there).
  const imageFor = (address: number, size: number): Pick<AbsFullSegment, "image" | "verify" | "source"> | null => {
    // L3: overlay the configured objects' flags onto the manufacturer's static template (the segment's <Data>).
    if (comObjTableAddr !== undefined && address === comObjTableAddr) {
      const seg = segByAddr.get(address);
      if (!seg || seg.data.length === 0) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the com-object table segment at ${address} carries no <Data> template; refusing to author L3 blind`);
      const image = buildComObjectTableMv0705(seg.data, opts.comObjectTable!.active, opts.comObjectTable!.linked);
      if (image.length > size) throw new ProductError("COM_OBJECT_TABLE_TOO_LARGE", `the com-object table needs ${image.length} B but its segment reserves only ${size} B`);
      return { image, verify: new Array<boolean>(image.length).fill(true), source: "comObjTable" };
    }
    const pt = paramTargets.get(address);
    const seg = segByAddr.get(address);
    if (pt) return { image: pt.bytes, verify: wholeBytes(pt.verify), source: "params" };
    if (!seg) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the load procedure declares a segment at ${address} the application does not define; refusing to write an image we cannot build`);
    if (propertyMapped && seg.data.length === 0) return null;
    // A pure static segment (com-object table / code): its <Data> laid over the erased-flash state.
    const image = Buffer.alloc(size, 0xff);
    seg.data.copy(image);
    return { image, verify: new Array<boolean>(size).fill(true), source: "static" };
  };

  const plan: LoadPlan = [];
  const segments: AbsFullSegment[] = [];
  const tableSegs = (t: System7Tables & { data: { id: string; address: number; image: Buffer }[] }) => {
    for (const w of t.writes) {
      const id = (w.lsm === OBJ.ADDR_TABLE ? app.groupTables.addressSegment : app.groupTables.associationSegment) ?? `@${w.address}`;
      segments.push({ id, address: w.address, lsm: w.lsm, source: w.lsm === OBJ.ADDR_TABLE ? "addrTable" : "assocTable", image: w.image, verify: new Array<boolean>(w.image.length).fill(true) });
    }
    for (const w of t.data) segments.push({ ...w, lsm: w.address >= t.assocAt || t.moved ? OBJ.ASSOC_TABLE : OBJ.ADDR_TABLE, source: "static", verify: new Array<boolean>(w.image.length).fill(true) });
  };
  const close = () => withClosing([...plan, { op: "restart", requireReboot: opts.requireReboot ?? true }], procedure, "full");
  const imageBytes = () => segments.reduce((n, s) => n + s.image.length, 0);

  // The partial form: the tables in their brackets, then the application's data segments in their
  // declared order inside one load bracket, without unloading or declaring them (a segment without <Data>
  // is the device's own and is not written). Of each, the bytes ETS's image holds (etsWrittenRuns): the
  // application stays loaded, so of its data segments only the bytes a parameter covers. ETS then leaves
  // out the bytes it believes the device already holds (its differential download, from the stamps it
  // read in the previous download); Busforge keeps no such record and writes the whole image (on a
  // memory-mapped mask, read and compared, what differs from it), every byte read back after the restart.
  if (opts.form === "partial") {
    const t = planSystem7TableBrackets(app, procedure, { addr, assoc });
    tableSegs(t);
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
      const runs = built.source === "comObjTable"
        ? etsWrittenRuns(app, seg, { ...built, image: builtComObjectTable(built.image) }, "table")
        : etsWrittenRuns(app, seg, built, "writtenIntoApplication", opts.moduleInstances);
      for (const run of runs) {
        appWrites.push({ op: "writeMem", address: run.address, bytes: run.image });
        segments.push({ id: seg.id, lsm: APP_LSM, source: built.source, ...run });
      }
    }
    plan.push(...t.steps, { op: "load", lsm: APP_LSM }, ...appWrites, { op: "loadCompleted", lsm: APP_LSM });
    return { plan: close(), segments, imageBytes: imageBytes(), ...tableRefsOf(app, t) };
  }

  // The declared form: every step in its declared order. The group tables' segments are declared and
  // written where tablePlacement puts them; the application's segments are loaded afresh (LSM 3 unloaded,
  // each declared), the com-object table's among them, with the bytes ETS writes of each.
  const need = <T>(v: T | undefined, verb: string, what: string): T => {
    if (v === undefined) throw new ProductError("FULL_DOWNLOAD_STEP_MALFORMED", `${verb} is missing its ${what}; refusing to build a partial download`);
    return v;
  };
  const tables = planSystem7TableBrackets(app, procedure, { addr, assoc }, { withData: true });
  tableSegs(tables);
  const via = declarationTransport(app);
  // The table brackets' steps, by load-state machine: the declared order places each table's declaration,
  // writes and task segment where the procedure declares them.
  const bracketOf = (lsm: number) => {
    const at = tables.steps.findIndex((st) => st.op === "load" && st.lsm === lsm);
    return tables.steps.slice(at + 1, tables.steps.findIndex((st, i) => i > at && st.op === "loadCompleted"));
  };
  for (const s of flattenSteps(procedure, "full")) {
    const l = lsmIdx(s);
    const isTable = l === OBJ.ADDR_TABLE || l === OBJ.ASSOC_TABLE;
    switch (s.verb) {
      case "LdCtrlUnload": plan.push({ op: "unload", lsm: need(l, s.verb, "LsmIdx") }); break;
      case "LdCtrlLoad": plan.push({ op: "load", lsm: need(l, s.verb, "LsmIdx") }); break;
      case "LdCtrlAbsSegment": {
        const lsm = need(l, s.verb, "LsmIdx"), a = need(stepAddress(s), s.verb, "Address"), sz = need(stepSize(s), s.verb, "Size");
        if (isTable) { plan.push(...bracketOf(lsm).filter((st) => st.op !== "taskSegment")); break; }
        plan.push({ op: "absSegment", lsm, segType: segType(s), address: a, size: sz, access: segAccess(s), memType: memType(s) ?? 0, segFlags: segFlags(s), ...via });
        const built = imageFor(a, sz);
        if (!built) break;
        const seg = segByAddr.get(a);
        if (!seg) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the load procedure declares a segment at ${a} the application does not define; refusing to write an image we cannot build`);
        if (built.source === "comObjTable") refuseComObjectTableOverlaps(app, seg, built.image, opts.moduleInstances);
        for (const run of etsWrittenRuns(app, seg, built, "loaded", opts.moduleInstances)) {
          plan.push({ op: "writeMem", address: run.address, bytes: run.image });
          segments.push({ id: seg.id, lsm, source: built.source, ...run });
        }
        break;
      }
      case "LdCtrlTaskSegment": {
        const lsm = need(l, s.verb, "LsmIdx");
        if (isTable) { plan.push(...bracketOf(lsm).filter((st) => st.op === "taskSegment")); break; }
        plan.push({ op: "taskSegment", lsm, address: need(stepAddress(s), s.verb, "Address"), peiType: app.appPeiType, manufacturer, appNumber: app.appNumber, version: app.appVersion, ...via });
        break;
      }
      case "LdCtrlTaskCtrl1": {
        const t = taskCtrl1Of(s);
        if (typeof t === "string") throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", `the load procedure declares ${s.verb} ${JSON.stringify(s.attrs)}: ${t}; refusing to guess what it sends`);
        plan.push({ op: "taskCtrl1", lsm: t.lsm, address: t.address, count: t.count });
        break;
      }
      case "LdCtrlLoadCompleted": plan.push({ op: "loadCompleted", lsm: need(l, s.verb, "LsmIdx") }); break;
      // The steps that close the download and the restart are placed by close().
      case "LdCtrlRestart": case "LdCtrlLoadImageProp": case "LdCtrlWriteProp": break;
      // Session lifecycle + the app-id check are the caller's (see System7Profile.downloadFull).
      case "LdCtrlConnect": case "LdCtrlDisconnect": case "LdCtrlCompareProp": break;
      default:
        throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", `the load procedure declares a step this full download cannot execute yet (${s.verb}); refusing to run a partial recipe`);
    }
  }
  if (!flattenSteps(procedure, "full").some((s) => s.verb === "LdCtrlRestart")) throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", "the load procedure declares no restart; refusing to leave the device unrestarted");
  return { plan: close(), segments, imageBytes: imageBytes(), ...tableRefsOf(app, tables) };
}

// The <Data> of a table's declared segment that no table can reach: the bytes past the most the
// segment's own table can grow to (address table 3 + 2 x MaxEntries, association table 1 + 2 x
// MaxEntries), not FF, marked by the segment's <Mask> where it declares one, and not under a built table.
// ETS's full download writes them; inside that capacity the segment is table area and ETS writes only the
// built table (Meteodata 140 S: AS-4000 511-512 = 00 00 written; Gira M-0008 AS-40F3+0 and TheLuxa P300
// AS-41FF+0 inside capacity, not written). Its group-address download leaves them out.
function tableSegmentData(app: AppConfig, p: TablePlacement, tables: { addr: Buffer; assoc: Buffer }): { id: string; address: number; image: Buffer }[] {
  const cap = app.groupTables;
  const covered = (a: number) => (a >= p.addrAt && a < p.addrAt + tables.addr.length) || (a >= p.assocAt && a < p.assocAt + tables.assoc.length);
  const out: { id: string; address: number; image: Buffer }[] = [];
  for (const [d, capacity] of [[p.d1, cap.addressMaxEntries === undefined ? Infinity : 3 + 2 * cap.addressMaxEntries], [p.d2, cap.associationMaxEntries === undefined ? Infinity : 1 + 2 * cap.associationMaxEntries]] as const) {
    const seg = app.absoluteSegments.find((s) => s.address === d.address);
    if (!seg) throw new ProductError("FULL_DOWNLOAD_TABLE_SEGMENT_MISSING", `the table segment declared at ${d.address} is not one the application defines; refusing to write its data blind`);
    const mask = segmentMask(seg);
    const written = (i: number) => i >= capacity && i < seg.data.length && seg.data[i] !== 0xff && (!mask || mask[i] !== 0) && !covered(seg.address + i);
    if (seg.data.some((_, i) => written(i) && i >= d.size)) {
      throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `<Data> of ${seg.id} reaches past the size its load procedure declares; refusing to write into another segment`);
    }
    out.push(...runsWhere(seg.data, written, seg.address, new Array<boolean>(seg.data.length).fill(true), null).map((r) => ({ id: seg.id, address: r.address, image: r.image })));
  }
  return out;
}

// The bytes of a segment ETS puts in its image. One rule fits every System 7 capture
// (docs/load-procedures.md, "Which bytes ETS writes"):
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
//    whatever the <Mask> marks or where it declares none; nothing of a segment no parameter covers (the
//    ABB US/U 4.2's code segment AS-4600 and AS-6F10).
// Each run is read back where a parameter's verify mask asks for it, and wholly where no parameter
// covers the byte.
type EtsSegmentKind = "table" | "loaded" | "writtenIntoApplication";
type Run = Pick<AbsFullSegment, "address" | "image" | "verify">;
function etsWrittenRuns(app: AppConfig, seg: CfgAbsSegment, built: Pick<AbsFullSegment, "image" | "verify">, kind: EtsSegmentKind, moduleInstances?: ModuleInstance[]): Run[] {
  const { image } = built;
  if (image.length > seg.size) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `the image for segment ${seg.id} is ${image.length} B, longer than the segment's ${seg.size}; refusing to write past it`);
  const runs = etsWrittenRunsOf(app, seg, built, kind, moduleInstances);
  if (runs.length === 0 && kind === "loaded" && segmentMask(seg)?.every((b) => b === 0)) return runs;
  if (kind === "writtenIntoApplication") return runs;
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
  if (kind === "writtenIntoApplication") return runsWhere(image, (i) => params[i], seg.address, built.verify, params);
  if (!mask) throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `segment ${seg.id} declares no <Mask>, and no ETS capture shows which bytes of such a segment it writes when it loads it afresh; refusing to guess`);
  return runsWhere(image, (i) => mask[i] !== 0 || params[i], seg.address, built.verify, params);
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
