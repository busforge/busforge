import { KnxDevice, type LoadPlan, planSystemBGaFlash, planSystemBFullDownload, planMv0705GaFlash, appId, runLoadPlan, iaToNum, compareDeclaredProp, readGroupTables, readGroupTablesMv0705, loadedTableAddr, crc16Ccitt, crc16CcittFalse, readSegmentCrc, GroupTableUnreadable, OBJ, lsmState, STATE } from "@busforge/knx";
import { toAppModel, unmappedParamRefs } from "./application.ts";
import { buildRelativeSegmentTarget, type RelativeSegmentTarget, mergeRelativeTarget, verifyRelativeOwned, verifyMaskedBytes, buildAbsoluteSegmentTargets } from "./deviceimage.ts";
import { resolveModuleInstances } from "./modules.ts";
import { assertComObjectTableStable } from "./comobjtable.ts";
import { buildComObjectTable, programIdStamp } from "./comobjbuild.ts";
import { buildDeviceConfig, type DeviceCapabilities } from "./config.ts";
import { decodeParameterImage, decodeAbsoluteImage } from "./image.ts";
import { buildGroupTables, buildGroupTablesMv0705, decodeGroupTables, decodeGroupTablesMv0705, type ComObjectLink } from "./grouptables.ts";
import { parseLoadProcedures, assessParCoverage, declaredPropChecks, relParamFillByte, type ParCoverage, type LoadProcedures } from "./loadproc.ts";
import { planAbsoluteParFlash, planRelativeParFlash, planAbsoluteFullDownload, type AbsFullSegment } from "./deviceflash.ts";
import { maskInfo, isMemoryMappedLsm, type MemoryModel, type SystemFamily } from "./masks.ts";
import { type AppConfig, type ModuleInstance } from "./appconfig.ts";
import type { AppModel } from "./application.ts";
import { ProductError } from "./errors.ts";

// Progress reporting for long-running device operations: a phase label plus optional
// done/total counters (unit-agnostic; memory reads report bytes). Structurally identical
// to the server task queue's ProgressFn, defined here so the device domain has no
// dependency on the server.
export type ProgressFn = (phase: string, done?: number, total?: number) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Device profiles: one strategy per KNX memory model.
//
// A KNX device's mask version (see masks.ts) fixes its MEMORY MODEL, and the memory
// model decides how we read its parameters/links off the bus and how we program them.
// Rather than re-detecting "is this MV-0705?" inline in every flash/read function (the
// old code did this five times, twice with DIFFERENT criteria), classify() resolves the
// device to exactly one DeviceProfile and every operation dispatches through it.
//
// The cardinal rule: a model we have NOT implemented does not fall through to a path that
// guesses. It resolves to UnsupportedProfile, whose every operation throws. That is the
// difference between "we don't support this device" (honest, explicit) and silently
// fabricating a wrong baseline or corrupting a table (the bug class this replaces).
//
// The profiles are PURE DEVICE DOMAIN: they receive an already-connected KnxDevice and
// context hooks (progress, backup persistence) and never touch transports, HTTP, the DB
// or the filesystem. The connect / mask-check / disconnect envelope lives in the server
// (withDeviceSession, apps/server deviceprofile.ts), which is the only glue left there.
// ─────────────────────────────────────────────────────────────────────────────

const LSM = OBJ.APP_PROGRAM; // System B parameter segment (LSM 4)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// After a LoadProcedure restart the device can be briefly unreachable while it reboots. Some
// devices are notably slow (M-008E answers only several seconds after the restart), so a single
// fixed pause then one connect would throw "device not answering" on the post-restart read and
// report a SUCCESSFUL flash as a failure. Re-establish the connection and wait for the device to
// answer a lightweight liveness probe, retrying with backoff. Throws only if the device never
// answers within the budget. Timing is injectable for tests. Worst case on a truly dead device
// is bounded (~40 s with the defaults: 3 s + 6 probes, each probe's request retries internally),
// which is acceptable for a one-off commissioning flash and far better than the false-failure.
export async function reconnectAfterRestart(
  dev: Pick<KnxDevice, "connect" | "disconnect" | "deviceDescriptor">,
  opts: { initialMs?: number; tries?: number; delayMs?: number } = {},
): Promise<void> {
  const { initialMs = 3000, tries = 6, delayMs = 2000 } = opts;
  await sleep(initialMs);
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      await dev.connect();
      await dev.deviceDescriptor(); // probe: confirms the rebooted device answers before verifying
      return;
    } catch (e) {
      lastErr = e;
      try { await dev.disconnect(); } catch { /* connection may already be gone */ }
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("device did not answer after restart");
}

// A post-restart verify read can transiently mismatch while a slow device is still settling its
// memory (it answers the reconnect probe before every byte is stable). Read, check, and on a
// mismatch settle briefly and read ONCE more before declaring failure, so a momentary read does
// not report a successful flash as failed. A genuine mis-write still fails (it persists on re-read).
// Returns the final readback and whether it matched. Settle is injectable for tests.
export async function verifySettled<T>(read: () => Promise<T>, ok: (v: T) => boolean, settleMs = 1500): Promise<{ value: T; ok: boolean }> {
  let value = await read();
  if (!ok(value)) { await sleep(settleMs); value = await read(); }
  return { value, ok: ok(value) };
}

// Fold a segment's decoded device values into the programmed baseline.
//
// Only refs the memory image ENCODES appear in `deviceVals`, and only those may be
// re-baselined: a parameter with no memory offset (a channel-count that lives solely in the
// project, say) is unobservable on the bus, so the read must leave its baseline untouched
// rather than adopt the live value. Adopting it would mark an unflashed edit as "programmed"
// merely because the device cannot contradict it.
//
// For an observable ref: the device's value wins where it differs from what the project would
// write; where it agrees, the baseline is the project's own live value (and stays SPARSE, an
// absent entry meaning "holds the application default", which is exactly what it holds).
function foldDeviceValues(
  paramBase: Map<string, string>,
  deviceVals: Map<string, string>,
  projectVals: Map<string, string>,
  liveParams: Map<string, string>,
  relevantRefs?: Set<string>,
): void {
  for (const [refId, devVal] of deviceVals) {
    if (relevantRefs && !relevantRefs.has(refId)) continue;
    if (projectVals.get(refId) !== devVal) { paramBase.set(refId, devVal); continue; }
    const live = liveParams.get(refId);
    if (live === undefined) paramBase.delete(refId); else paramBase.set(refId, live);
  }
}

const byteDiff = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d;
};

// Firmware families hardware-verified to persist their configuration at LoadCompleted rather than on
// the closing A_Restart, so a restart that does not reboot is not a failure (KnxDevice.restart's
// requireReboot=false path). Each entry is a manufacturer id PROVEN on real hardware by a power
// cycle: the parameter segment read back byte-identical after power-down. Everything NOT listed keeps
// the safe default — persistence happens on the restart (thelsing/knx, OpenKNX) — so an unproven
// device still refuses on a restart it could not confirm.
//   0x0085 GVS (K-BUS): AMMA-04/06.S full download survived a power cycle byte-identical, 2026-07-14.
const PERSIST_ON_LOAD_COMPLETED = new Set<number>([0x0085]);
const appManufacturer = (app: AppConfig): number => Number.parseInt(String(app.id).split("_")[0].replace("M-", ""), 16);

// Does this application's firmware persist at LoadCompleted (so the closing A_Restart need not prove
// a reboot)? Exported for the test that guards the default-strict gate: everything not in the
// hardware-verified allowlist must return false, or an OpenKNX device that failed to restart would
// be reported as programmed while it comes back factory-fresh.
export const persistsOnLoadCompleted = (app: AppConfig): boolean => PERSIST_ON_LOAD_COMPLETED.has(appManufacturer(app));

// Firmware families hardware-verified to INVALIDATE their running application when a table it
// references is unloaded underneath it, so a group-address flash must hold the application program
// object in its own load bracket across the rewrite (planSystemBGaFlash holdApplication).
//   0x0004 Jung (Insta stack): a table-only GA flash left all three tables LOADED and byte-perfect while
//   object 4 dropped to ERROR — the device answered management but ran no application, so every link was
//   dead, and only a full download recovered it. With the bracket the same flash keeps object 4 LOADED
//   and the re-pointed link answers on the bus (2026-07-24).
// Everything NOT listed keeps the proven table-only bracket, because the extra LoadCompleted is not
// free: on a persist-at-LoadCompleted device (GVS) it triggers an additional flash persist, and the GVS
// smoke failed its very next parameter flash with DEVICE_NOT_ANSWERING when the bracket was applied
// universally. The safety net for an unlisted family is the guard in flashGroupTables: if a GA flash
// does break the application, the flash FAILS loudly (GA_FLASH_BROKE_APPLICATION) instead of reporting
// verified, and the fix is to add that family here once it is proven on hardware.
const HOLD_APPLICATION_ON_GA_FLASH = new Set<number>([0x0004]);
export const holdsApplicationOnGaFlash = (app: AppConfig): boolean => HOLD_APPLICATION_ON_GA_FLASH.has(appManufacturer(app));

// Guard a par download against its own declared load procedure: every par-applicable
// step must have an explicit disposition (executed / caller / documented skip). A step
// the model cannot execute blocks the flash: running a partial recipe and reporting
// "programmed and verified" is exactly the silent-skip class this codebase refuses.
function assertParCoverage(proc: LoadProcedures, model: "absolute" | "relative"): ParCoverage {
  const coverage = assessParCoverage(proc, model);
  if (coverage.blocked.length) {
    const details = [...new Set(coverage.blocked.map((b) => b.detail))].join("; ");
    throw new ProductError("LOAD_STEP_UNSUPPORTED",
      `the device's load procedure declares ${coverage.blocked.length} step(s) this parameter download cannot execute yet (${details}); refusing to flash rather than run a partial recipe`);
  }
  return coverage;
}

// Run the procedure's declared CompareProp pre-flights (the hardware/application check
// ETS performs before a download). Read-only; a mismatch aborts before any write.
async function runDeclaredChecks(dev: KnxDevice, coverage: ParCoverage): Promise<void> {
  for (const c of coverage.checks) {
    const { ok, got } = await compareDeclaredProp(dev, c.obj, c.pid, c.expect, c.mask);
    if (!ok) {
      throw new ProductError("LOAD_PROC_CHECK_FAILED",
        `load-procedure check failed: object ${c.obj} property ${c.pid} reads ${got.toString("hex")} but the application declares ${c.expect.toString("hex")} (wrong hardware or application version?)`);
    }
  }
}

// The outcome of a flash operation, as a discriminated union so honesty is
// compiler-enforced: a "flashed" result MUST state whether it verified. The old shape
// (`verified?: boolean`) treated a forgotten field as verified at the persistence
// boundary (baseline reset), which is exactly the fake-green class this codebase bans.
export type FlashResult =
  | { kind: "unchanged"; mask: string; imageBytes: number; backup: string }
  | { kind: "dryRun"; mask: string; imageBytes: number; diffBytes: number; backup: string }
  | { kind: "flashed"; mask: string; imageBytes: number; diffBytes: number; verified: boolean; backup: string };

// One prepared flash operation, handed to runFlashOp by a profile after it has read the
// device's current state and computed the diff. The profile supplies only the
// model-specific pieces; the safety-critical sequencing lives in runFlashOp.
interface FlashOp {
  imageBytes: number;
  diffBytes: number;
  backup: string;                                 // representative path reported in the result
  backups: { file: string; bytes: Buffer }[];     // on-disk copies of the device's CURRENT state
  write: () => Promise<void>;                     // the model-specific download (device restarts after)
  verify: () => Promise<boolean>;                 // post-restart read-back comparison
}

// The one flash sequence every memory model runs: persist the backups, short-circuit an
// unchanged device and a dry run, write, reconnect across the device's restart, verify.
// Centralized so the invariants (backup BEFORE any write, verify AFTER the restart,
// a "flashed" result always carrying a real verified flag) hold structurally for every
// current and future profile instead of by convention in four hand-rolled copies.
async function runFlashOp(
  dev: KnxDevice, mask: string,
  ctx: { dryRun: boolean; persistBackups: PersistBackups },
  op: FlashOp,
): Promise<FlashResult> {
  // Persisting the device's current state is the FIRST step, structurally before any
  // write; the hook is injected (the server stores files on disk) so this layer stays
  // filesystem-free and the ordering is testable with a plain recording stub.
  const backup = ctx.persistBackups(op.backups, op.backup);
  if (op.diffBytes === 0) return { kind: "unchanged", mask, imageBytes: op.imageBytes, backup };
  if (ctx.dryRun) return { kind: "dryRun", mask, imageBytes: op.imageBytes, diffBytes: op.diffBytes, backup };
  await op.write();
  await reconnectAfterRestart(dev);
  const verified = await op.verify();
  return { kind: "flashed", mask, imageBytes: op.imageBytes, diffBytes: op.diffBytes, verified, backup };
}

// The programmed-baseline read back off the bus (see readState). `paramBase` is sparse like
// device_parameters; the caller persists only the aspects whose *Read flag is true.
export interface DeviceReadback { mask: string; paramsRead: boolean; linksRead: boolean; paramBase: Map<string, string>; links: ComObjectLink[]; }

// DeviceCapabilities lives in config.ts (the lower module) so the wire view can carry it without a
// cycle; re-exported here (imported above) because it is the return type of capabilities().
export type { DeviceCapabilities };

export interface ReadStateCtx {
  liveParams: Map<string, string>;
  // The programmed baseline as it stands BEFORE this read. Refs the device's memory image
  // does not encode (parameters with no memory offset, e.g. a channel-count parameter that
  // only ever lived in the project) cannot be observed on the bus, so the read must leave
  // their baseline alone. Seeding the baseline from the LIVE values instead would adopt an
  // unflashed edit as "programmed" purely because the device cannot contradict it, which is
  // the fake-green this whole layer exists to prevent. Omitted => same as live (import time).
  baseParams?: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  // Drift is only recorded for refs in this set (the config view's keys); see readState.
  relevantRefs?: Set<string>;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}
// Persist the pre-flash device-state backups somewhere durable and return the
// representative path/name reported in the FlashResult. Injected by the caller (the
// server writes .bin files under the project's backup dir); called by runFlashOp
// BEFORE any write reaches the device.
export type PersistBackups = (files: { file: string; bytes: Buffer }[], representative: string) => string;

export interface ParamFlashCtx {
  deviceId: string; // used in backup file names
  appXml: string;
  params: Map<string, string>;
  // The programmed baseline: the parameter set the device was last programmed with, hence the
  // one its (kept-from-device) com-object table was compiled for. REQUIRED, not optional: a
  // caller that forgot it would silently disable the com-object staleness gate, and a safety
  // gate that can be switched off by omission is not a gate. See comobjtable.ts.
  baseParams: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  dryRun: boolean;
  onProgress?: ProgressFn;
  persistBackups: PersistBackups;
}
// Commissioning a device from nothing needs everything at once: the parameters AND the links,
// because the com-object table it writes has to agree with the association table it writes.
export interface FullDownloadCtx {
  deviceId: string;
  ia: string; // the device's individual address; the System 7 address table stores it, so the plan needs it
  appXml: string;
  params: Map<string, string>;
  links: ComObjectLink[];
  moduleInstances?: ModuleInstance[];
  dryRun: boolean;
  // Read and persist the device's CURRENT memory to .bin files BEFORE the unload/rewrite destroys it,
  // as a recovery copy for a full download that lands on a device holding a configuration we cannot
  // reproduce (e.g. one programmed by ETS, never imported). OFF by default: on a full download every
  // written byte is derived from the project, so the image is reproducible and the backup's payoff is
  // narrow, while reading the whole parameter segment back (~1800 TP round trips, minutes) dominates the
  // wall-clock. The backup PATH stays fully implemented and tested; this only gates whether it runs, so
  // a future UI can offer "back up before commissioning" for the ETS-migration case. See
  // docs/load-procedures.md and docs/roadmap.md.
  backupBeforeUnload?: boolean;
  onProgress?: ProgressFn;
  persistBackups: PersistBackups;
}
export interface GaFlashCtx {
  deviceId: string; // used in backup file names
  ia: string;
  links: ComObjectLink[];
  // The com-object staleness gate applies here too, and for the same reason: `links` carries the
  // com-object NUMBERS of the live configuration, while the device's com-object table is still
  // the one it was last programmed with. Writing an association onto an object number that table
  // does not configure wires the group address to nothing, and the verify (which only re-reads
  // the tables we wrote) would still report success. Both maps are REQUIRED, like ParamFlashCtx.
  params: Map<string, string>;
  baseParams: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  dryRun: boolean;
  onProgress?: ProgressFn;
  persistBackups: PersistBackups;
}

// What a full download needs to build its image; the device-independent part of FullDownloadCtx.
export interface FullDownloadInputs {
  ia: string;
  params: Map<string, string>;
  links: ComObjectLink[];
  moduleInstances?: ModuleInstance[];
  proc: LoadProcedures;
}
// One segment a full download writes. `address` is null where the device assigns it (a System B
// relative segment, allocated during the download); `fillByte` is set where the allocation pre-fills
// the segment, so the bytes of `image` equal to it are not transmitted but are still the segment's content.
export interface FullDownloadSegment {
  id: string;
  lsm: number;
  source: AbsFullSegment["source"];
  address: number | null;
  image: Buffer;
  fillByte?: number;
}
// A full download, planned without touching the device: the load plan and every segment's image.
export interface FullDownloadBuild { plan: LoadPlan; segments: FullDownloadSegment[]; imageBytes: number; }

// An operation a device's memory model does not implement. Carries an ProductError code so the
// HTTP layer surfaces an honest "unsupported" rather than a 500.
export class UnsupportedOperation extends ProductError {
  constructor(op: string, family: SystemFamily, mask: string) {
    super("DEVICE_FAMILY_UNSUPPORTED", `${op} is not supported for ${family} devices (mask ${mask}); this device family is recognised but not yet implemented`);
  }
}

// The System B image model: the device's module instances materialised, and top-level union
// members kept. It must be the SAME model buildRelativeSegmentTarget builds from, because it
// is what read-back decodes with and what the flash guard tests stored values against; a model
// that is narrower than the builder decodes nothing at the offsets the builder writes (a union
// byte would be flashed and then read back as "no drift" whatever the device holds).
function moduleAwareModel(cfg: AppConfig, params: Map<string, string>, provided: ModuleInstance[]): { model: AppModel; instances: ModuleInstance[] } {
  const instances = cfg.hasModules ? (provided.length ? provided : resolveModuleInstances(cfg, params)) : [];
  return { model: toAppModel(cfg, { includeUnions: true, instances }), instances };
}

// Group-table readers (readGroupTables / readGroupTablesMv0705) live in @busforge/knx
// (grouptable-read.ts) next to the layout descriptors the product codec is asserted
// against, so the byte layout has one home instead of a copy per layer.

// ─────────────────────────────────────────────────────────────────────────────

export abstract class DeviceProfile {
  abstract readonly memoryModel: MemoryModel;
  abstract readonly family: SystemFamily;
  constructor(readonly mask: string, protected readonly cfg: AppConfig | null) {}

  // Capabilities are a function of the memory model + parsed application alone; they
  // deliberately take NO live parameter state (every implementation ignored it, and the
  // callers paid two DB reads per call to feed it).
  abstract capabilities(): DeviceCapabilities;
  abstract readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback>;
  abstract flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult>;
  abstract flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult>;

  // Commission the device from nothing. Default: refuse. A memory model that has not been proven
  // to survive a full download must not fall through into one, because a half-written download
  // leaves a device that answers nothing and has to be recovered by hand.
  async downloadFull(_dev: KnxDevice, _mask: string, _ctx: FullDownloadCtx): Promise<FlashResult> {
    throw new UnsupportedOperation("full download", this.family, this.mask);
  }

  // The image and load plan downloadFull writes, built offline. The same refusals apply; the
  // device-side pre-flight (declared property checks) is downloadFull's, not part of the plan.
  planFullDownload(_mask: string, _inputs: FullDownloadInputs): FullDownloadBuild {
    throw new UnsupportedOperation("full download", this.family, this.mask);
  }

  protected requireCfg(op: string): AppConfig {
    if (!this.cfg) throw new ProductError("APP_PROGRAM_MISSING", `${op} needs the application program but it was not provided`);
    return this.cfg;
  }
}

// System B (relative-segment) devices: MV-07B0 and its medium variants. Parameters live in a
// relative LSM4 segment (surgical owned-byte download); group tables use the count-prefixed
// System B layout. Hardware-proven (read and flash, on twisted pair).
export class SystemBProfile extends DeviceProfile {
  readonly memoryModel = "relative" as const;
  constructor(readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }

  capabilities(): DeviceCapabilities {
    // Parameters are decoded from the LSM4 segment; a relative device WITHOUT one has nowhere
    // to read them from, so don't claim its params verify. Group tables are always present.
    const hasParamSegment = this.cfg ? toAppModel(this.cfg).segments.some((s) => s.lsm === LSM) : false;
    // A full download needs the parameter segment to fill AND an application to author the
    // com-object table from; without either there is nothing to commission.
    return { readParams: hasParamSegment, readLinks: true, flashParams: true, flashLinks: true, fullDownload: hasParamSegment };
  }

  planFullDownload(mask: string, inputs: FullDownloadInputs): FullDownloadBuild {
    return this.planSystemBFull(mask, inputs);
  }

  private planSystemBFull(_mask: string, ctx: FullDownloadInputs): FullDownloadBuild & { target: RelativeSegmentTarget; comObj: Buffer; addr: Buffer; assoc: Buffer } {
    const cfg = this.requireCfg("full download");
    const proc = ctx.proc;
    assertParCoverage(proc, "relative");
    // What the mask wants the parameter segment pre-filled with (0 for most, 0xFF for e.g. the GVS
    // AMMA). Threaded into the plan so the allocation and the sparse image write agree with it.
    const fillByte = relParamFillByte(proc);

    const { model, instances } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
    const unmapped = unmappedParamRefs(model, ctx.params);
    if (unmapped.length) {
      throw new ProductError("CHANNEL_MODULES_UNSUPPORTED",
        `${unmapped.length} stored value(s) cannot be placed in this device's parameter image (e.g. ${unmapped[0]}); refusing to commission a device with a configuration we cannot express`);
    }

    // A full download owns the whole segment, so unlike the surgical parameter flash there is no
    // live image to merge into: every byte we do not derive is the allocation's zero fill.
    const target = buildRelativeSegmentTarget(cfg, ctx.params, LSM, { moduleInstances: instances });
    if (!target || target.size === 0) throw new ProductError("EMPTY_IMAGE", "built an empty parameter image; refusing to download");

    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    // A link whose com-object this configuration does not activate cannot be programmed: the
    // association table would point a group address at an entry that reads 0x0000, i.e. at an
    // object that does not communicate. Filtering such a link away and carrying on would leave the
    // user with a group address the UI calls programmed and the device ignores. Refuse.
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    // The linked objects are exactly those the association table connects; ETS clears the
    // Communication flag on every other object, so the com-object table build needs to know them.
    const linked = new Set(ctx.links.map((l) => l.comObjNum));
    const comObj = buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, linked);
    const { addr, assoc } = buildGroupTables(ctx.links);

    // Whether the closing A_Restart must prove a reboot. thelsing/knx persists ON the restart, so a
    // device that does not reboot lost the download; other firmware persists at LoadCompleted and
    // never goes silent (see PERSIST_ON_LOAD_COMPLETED). Default true keeps the safe behavior.
    const requireReboot = !persistsOnLoadCompleted(cfg);
    const plan = planSystemBFullDownload({
      params: target.bytes, comObj, addr, assoc, programId: programIdStamp(cfg),
    }, fillByte, requireReboot);
    const imageBytes = target.size + comObj.length + addr.length + assoc.length;

    return {
      plan, imageBytes, target, comObj, addr, assoc,
      segments: [
        { id: "L4 parameter segment", lsm: LSM, source: "params", address: null, image: target.bytes, fillByte },
        { id: "L3 com-object table", lsm: OBJ.COMOBJ_TABLE, source: "comObjTable", address: null, image: comObj },
        { id: "L2 association table", lsm: OBJ.ASSOC_TABLE, source: "assocTable", address: null, image: assoc },
        { id: "L1 address table", lsm: OBJ.ADDR_TABLE, source: "addrTable", address: null, image: addr },
      ],
    };
  }

  // Commission a System B device from nothing: write the application id, the parameter image, the
  // com-object table and the two group tables in ONE bracket, in the order the mask's own load
  // procedure prescribes (see planSystemBFullDownload).
  //
  // Unlike every other write in this codebase, this one AUTHORS the com-object table instead of
  // keeping the device's: a virgin device has no table to keep. That is the whole point, and it is
  // also the risk, because the firmware validates nothing it is given (see comobjbuild.ts). So the
  // table is built from the same active-configuration projection the read-back and the staleness
  // gate use, and the result is verified by reading it back off the device afterwards.
  async downloadFull(dev: KnxDevice, mask: string, ctx: FullDownloadCtx): Promise<FlashResult> {
    this.requireCfg("full download");
    // The device's own declared pre-flight (hardware type / application id) still runs: a full
    // download to the wrong hardware is the most expensive mistake available here.
    const proc = parseLoadProcedures(ctx.appXml);
    const coverage = assertParCoverage(proc, "relative");
    await runDeclaredChecks(dev, coverage);
    const { plan, imageBytes, target, comObj, addr, assoc } = this.planSystemBFull(mask, { ...ctx, proc });
    // A full download UNLOADS every segment before it rewrites them, so whatever the device held is
    // gone the moment it starts. A virgin device holds nothing (its load-state machines point at
    // address 0) and there is genuinely nothing to save. A device that was already programmed, by
    // ETS or by us, holds bytes we may not be able to reproduce, and destroying them without a copy
    // is not something this codebase does anywhere else.
    const stamp = Date.now();
    const backups: { file: string; bytes: Buffer }[] = [];
    // The pre-unload backup is OFF by default (ctx.backupBeforeUnload): reading the whole parameter
    // segment back is minutes of bus traffic to preserve bytes a full download reproduces from the
    // project anyway. The whole read stays here, gated, so it can be turned back on (a future UI for
    // the ETS-migration case). See FullDownloadCtx.backupBeforeUnload.
    if (ctx.backupBeforeUnload) {
      ctx.onProgress?.("backup");
      // Sizes first, bytes second. Reading the parameter segment back is ~1800 twelve-byte round
      // trips over TP, i.e. minutes; without a done/total the phase reports 0/0 for all of it and is
      // indistinguishable from a hang. It was mistaken for one. Sum the work before doing it so the
      // progress is against a real total.
      const segs: { obj: number; what: string; at: number; size: number }[] = [];
      for (const [obj, what] of [[LSM, "params"], [OBJ.COMOBJ_TABLE, "comobj"], [OBJ.ASSOC_TABLE, "assoc"], [OBJ.ADDR_TABLE, "addr"]] as [number, string][]) {
        const at = await dev.tableAddr(obj);
        if (at === 0) continue; // never loaded: there is nothing there to lose
        // Size the backup from the DEVICE's own loaded segment, never from the image we are about to
        // write. A device programmed (by ETS or by us) with a LARGER parameter segment than our new
        // image has a tail the unload is about to destroy; sizing this backup by `target.size` would
        // silently omit exactly those bytes and produce a "backup" that cannot restore what it
        // replaced. The parameter segment reports its loaded size in its MCB (PID_MCB_TABLE); the
        // group tables report theirs in their count header. If either cannot be determined, refuse the
        // whole download rather than back up a guessed length.
        let size: number;
        if (obj === LSM) {
          const mcb = await readSegmentCrc(dev, LSM);
          if (mcb === null || mcb.size === 0) {
            throw new ProductError("SEGMENT_SIZE_UNKNOWN",
              `the device will not report the size of its loaded parameter segment (PID_MCB_TABLE); refusing the full download rather than back up a guessed length and let the unload destroy the remainder`);
          }
          size = mcb.size;
        } else {
          size = await tableByteLength(dev, obj, at);
        }
        segs.push({ obj, what, at, size });
      }
      const backupTotal = segs.reduce((n, s) => n + s.size, 0);
      let backupDone = 0;
      for (const s of segs) {
        const bytes = await dev.memRead(s.at, s.size, undefined, (d) => ctx.onProgress?.("backup", backupDone + d, backupTotal));
        backupDone += s.size;
        backups.push({ file: `${ctx.deviceId}-full-${stamp}-${s.what}.bin`, bytes });
      }
    }

    return runFlashOp(dev, mask, ctx, {
      imageBytes,
      // Everything is written: a full download owns every byte of every segment, so there is no
      // meaningful diff against what was there (and on a virgin device there was nothing).
      diffBytes: imageBytes,
      backup: `${ctx.deviceId}-full-${stamp}`,
      backups,
      write: async () => {
        await runLoadPlan(dev, plan, { onWrite: (d, t) => ctx.onProgress?.("write", d, t) });
      },
      // The firmware accepts any bytes it is handed (it validates nothing on LoadCompleted), so
      // this read-back is the ONLY thing standing between a wrong table and a device that silently
      // mis-communicates. The three tables are small and are compared byte for byte. The parameter
      // image is 21601 bytes, i.e. 1800 memory reads, so it is checked against the CRC the device
      // itself computes over the loaded segment (PID_MCB_TABLE) instead: the very thing the
      // device's own load procedure declares `LdCtrlLoadImageProp ObjIdx=4 PropId=27` for.
      //
      // If the device declines to report a CRC, that is NOT a pass: fall back to reading the whole
      // segment. Slow, but the alternative would be calling a download verified because we could
      // not check it.
      verify: async () => {
        ctx.onProgress?.("verify");
        // The device reports its segment CRC via PID_MCB_TABLE, but which CRC-16 convention it uses
        // is firmware-specific: thelsing/knx (OpenKNX) augments the CCITT CRC with 16 zero bits,
        // other System B firmware (GVS K-BUS) does not. Both are legitimate; accept EITHER. Only when
        // the reported CRC matches neither convention (or the device reports none) do we read the
        // whole segment back and compare byte for byte — the ultimate truth, but slow, so it is the
        // fallback and not the default. A CRC that matches nothing is NOT itself a failure verdict.
        const wantAug = crc16Ccitt(target.bytes);        // thelsing / OpenKNX (augmented)
        const wantPlain = crc16CcittFalse(target.bytes); // GVS and other CCITT-FALSE firmware
        const { ok } = await verifySettled(
          async () => {
            const gt = await readGroupTables(dev);
            const mcb = await readSegmentCrc(dev, LSM);
            const crcOk = mcb !== null && mcb.size === target.size && (mcb.crc === wantAug || mcb.crc === wantPlain);
            const img = crcOk ? null : await dev.memRead(await loadedTableAddr(dev, LSM, "parameter segment"), target.size);
            return { gt, crcOk, img };
          },
          ({ gt, crcOk, img }) => {
            const tablesOk = gt.addr.equals(addr) && gt.assoc.equals(assoc) && gt.comObj.equals(comObj);
            const paramsOk = crcOk || (img !== null && verifyRelativeOwned(img, target));
            return tablesOk && paramsOk;
          },
        );
        return ok;
      },
    });
  }

  async readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback> {
    const cfg = this.requireCfg("read-back");
    const { model, instances } = moduleAwareModel(cfg, ctx.liveParams, ctx.moduleInstances ?? []);
    const support = this.capabilities();
    const paramBase = new Map(ctx.baseParams ?? ctx.liveParams);
    let links: ComObjectLink[] = [];
    let paramsRead = false, linksRead = false;

    // Parameters (LSM 4): read the whole segment, decode it, compare against the image the
    // FLASH would write, both normalized via the same codec. The project side is the surgical
    // target (not the legacy full-image build), so read-back compares against exactly the bytes
    // we would put on the device, and union branches resolve to the active one instead of the
    // last writer of an overlapping region. Same shape as the System 7 path below.
    const target = support.readParams ? buildRelativeSegmentTarget(cfg, ctx.liveParams, LSM, { moduleInstances: instances }) : null;
    if (target) {
      // loadedTableAddr, not tableAddr: a device that was never programmed points its parameter
      // segment at address 0, and reading there would decode whatever bytes happen to live at the
      // bottom of its memory into a "programmed baseline". Refuse instead (DEVICE_NOT_PROGRAMMED).
      const img = await dev.memRead(await loadedTableAddr(dev, LSM, "parameter segment"), target.size, undefined, (d, t) => ctx.onProgress?.("params", d, t), ctx.signal);
      foldDeviceValues(
        paramBase,
        decodeParameterImage(model, LSM, img),
        decodeParameterImage(model, LSM, target.bytes),
        ctx.liveParams,
        ctx.relevantRefs,
      );
      paramsRead = true;
    }
    // Group-address links: read address + association tables (skip the com-object table) and reverse.
    if (support.readLinks) {
      if (ctx.signal?.aborted) throw new ProductError("READ_ABORTED", "read aborted");
      ctx.onProgress?.("links", 0, 2);
      const gt = await readGroupTables(dev, (d, total) => ctx.onProgress?.("links", d, total), true);
      links = decodeGroupTables(gt.addr, gt.assoc, gt.long);
      linksRead = true;
    }
    return { mask, paramsRead, linksRead, paramBase, links };
  }

  async flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("parameter flash");
    // The MergedProcedure fragments parameterize the proven base bracket; every
    // par-applicable fragment step must be dispositioned (executed/skip) or the flash
    // refuses. The declared CompareProp pre-flights run below, before any bus write.
    const coverage = assertParCoverage(parseLoadProcedures(ctx.appXml), "relative");
    // Build + safety refusals. These run AFTER the session's connect/mask-check (vs before, in
    // the original), which is harmless: no device byte is written until below, and verifying we
    // are on the right device first is if anything safer.
    const { model } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
    // SAFETY: a stored value the image model cannot place would be silently dropped and its
    // region reset to default. Refuse rather than wipe a configured channel.
    const unmapped = unmappedParamRefs(model, ctx.params);
    if (unmapped.length) {
      throw new ProductError("CHANNEL_MODULES_UNSUPPORTED",
        `parameter programming cannot place ${unmapped.length} stored value(s) for this device (e.g. ${unmapped[0]}); they would be dropped and that region reset to defaults. Refusing to flash to protect the device configuration.`);
    }
    // The device keeps the com-object table it was last programmed with. If these parameters
    // imply a different one, flashing would leave that table stale while reporting success.
    assertComObjectTableStable(cfg, ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    // Surgical owned-byte target: only these bytes may be written; everything ETS computes that
    // we cannot reproduce is preserved by sourcing unowned bytes from the live read.
    const target = buildRelativeSegmentTarget(cfg, ctx.params, LSM, { moduleInstances: ctx.moduleInstances });
    if (!target || target.size === 0) throw new ProductError("EMPTY_IMAGE", "built an empty parameter image; refusing to flash");

    await runDeclaredChecks(dev, coverage);
    // A parameter (par) download rewrites an EXISTING segment; on a never-programmed device
    // there is nothing to back up and nothing to merge our owned bytes into. Refuse: that device
    // needs a full download, which is a different operation (docs/commissioning.md).
    const addr = await loadedTableAddr(dev, LSM, "parameter segment");
    const current = await dev.memRead(addr, target.size, undefined, (d, t) => ctx.onProgress?.("backup", d, t));

    const { image, diffBytes } = mergeRelativeTarget(current, target);
    const backupFile = `${ctx.deviceId}-LSM${LSM}-${Date.now()}.bin`;
    return runFlashOp(dev, mask, ctx, {
      imageBytes: image.length,
      diffBytes,
      backup: backupFile,
      backups: [{ file: backupFile, bytes: current }],
      write: () => runLoadPlan(
        dev,
        planRelativeParFlash(LSM, image, appId(model.manufacturer, model.appNumber, model.version), !persistsOnLoadCompleted(cfg)),
        { onWrite: (d, t) => ctx.onProgress?.("write", d, t) },
      ),
      // The device restarts after load-completed; verify ONLY the owned bytes.
      verify: async () => {
        const verifyAddr = await dev.tableAddr(LSM);
        const { ok } = await verifySettled(
          () => dev.memRead(verifyAddr, image.length, undefined, (d, t) => ctx.onProgress?.("verify", d, t)),
          (back) => verifyRelativeOwned(back, target),
        );
        return ok;
      },
    });
  }

  async flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult> {
    // `links` numbers its com-objects from the LIVE configuration, but the device's com-object
    // table is the one it was last programmed with. Associating a group address with an object
    // that table does not configure wires it to nothing, and the verify (which only re-reads the
    // tables we wrote) would still report success. Refuse for the same reason the param flash does.
    const cfg = this.requireCfg("group address flash");
    assertComObjectTableStable(cfg, ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    // Author the com-object table (L3) that THIS link set implies, and write it alongside the group
    // tables. It is NOT enough to write the address/association tables and keep the device's L3: ETS
    // (and buildComObjectTable) clears the Communication flag on every object WITHOUT a link, so an
    // object that was unlinked at the last full download holds comm=0 in the device's L3. Writing only
    // the association would then wire a group address to an object the device still refuses to talk on
    // — the link reads back byte-perfect (the group tables match our image) yet is functionally dead
    // (hardware-proven on the GVS AMMA: a status object linked by a GA flash never answered a read nor
    // transmitted, while the same object linked by a full download did). So the GA flash rebuilds L3
    // from the current config and writes L3+L1+L2 in one bracket. It stays a SURGICAL flash: L3/L1/L2
    // are small tables, so this never touches the large parameter image (L4) — the point of not
    // promoting a mere link change to a full download. The staleness gate above guarantees the only L3
    // difference is link-driven (params did not move it), so on a pure re-point L3 is byte-identical.
    const { instances } = moduleAwareModel(cfg, ctx.params, ctx.moduleInstances ?? []);
    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    const linked = new Set(ctx.links.map((l) => l.comObjNum));
    const comObj = buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, linked);
    const { addr, assoc } = buildGroupTables(ctx.links);
    // Read the current L3 as well (not just addr/assoc): it is the backup, and its diff against the
    // rebuilt table is what makes the link-driven L3 change visible in the dry-run preview.
    const cur = await readGroupTables(dev, undefined, false);
    // The application program object's load state BEFORE the flash. A GA flash unloads and rewrites the
    // three tables the running application references, and on some System B stacks that invalidates the
    // application itself: hardware-proven on the Jung 400021SE (Insta), where the flash leaves all three
    // tables LOADED and byte-perfect while object 4 drops to ERROR — the device keeps answering
    // management (so every table verified green) but its application no longer runs, so the freshly
    // linked object is functionally dead and no cheap recovery exists (a bare LoadCompleted, a
    // LOAD+LoadCompleted and a restart all leave it ERROR; only a full download brings it back).
    // Reporting `verified: true` for that is exactly the fake-green this codebase refuses, so the state
    // is captured here and re-checked after the write.
    const appBefore = await lsmState(dev, OBJ.APP_PROGRAM);
    const prefix = `${ctx.deviceId}-GA-${Date.now()}`;
    return runFlashOp(dev, mask, ctx, {
      imageBytes: addr.length + assoc.length + comObj.length,
      diffBytes: byteDiff(addr, cur.addr) + byteDiff(assoc, cur.assoc) + byteDiff(comObj, cur.comObj), // 0 iff all three match
      backup: prefix,
      backups: [
        { file: `${prefix}-addr.bin`, bytes: cur.addr },
        { file: `${prefix}-assoc.bin`, bytes: cur.assoc },
        ...(ctx.dryRun ? [] : [{ file: `${prefix}-comobj.bin`, bytes: cur.comObj }]),
      ],
      write: async () => {
        ctx.onProgress?.("write");
        // The application object is held in its own load bracket across the table rewrite (see
        // planSystemBGaFlash): unloading a table underneath a running application invalidates it on some
        // System B stacks, and the tables then read back byte-perfect while the device communicates on
        // nothing. Hardware-proven on the Jung 400021SE, where this is the difference between a link that
        // works and one that is silently dead.
        // Hold the application object open across the rewrite, but ONLY for a family hardware-proven to
        // need it (see HOLD_APPLICATION_ON_GA_FLASH: the extra LoadCompleted is not free on a
        // persist-at-LoadCompleted device) and only when its application is actually LOADED (driving
        // LOAD/LoadCompleted on an object holding no application is a transition this flash has no
        // business making, and its assertLoaded would then fail AFTER the tables were written). Any
        // family that needs it but is not listed still cannot fail silently: the guard below refuses.
        await runLoadPlan(dev, planSystemBGaFlash({ addr, assoc, comObj }, !persistsOnLoadCompleted(cfg), appBefore === STATE.LOADED && holdsApplicationOnGaFlash(cfg))); // rebuilt L3 carries the correct comm flags for the new link set
      },
      verify: async () => {
        ctx.onProgress?.("verify");
        // The application must still be loaded. Checking the tables alone cannot see that the device
        // stopped running its application (see appBefore above): the tables read back byte-perfect
        // either way. Only a DEGRADATION is an error — a device whose application object was already
        // not LOADED before the flash is left to the table check, so this never invents a new refusal
        // for a device that was in that state to begin with.
        // Read it the same way the table check is read: through verifySettled, so a device still
        // settling after the closing restart is given the same second chance and cannot produce a false
        // "your application is broken, run a full download" (an expensive lie in the other direction).
        const { ok: appOk } = await verifySettled(() => lsmState(dev, OBJ.APP_PROGRAM), (s) => appBefore !== STATE.LOADED || s === STATE.LOADED);
        if (!appOk) {
          throw new ProductError("GA_FLASH_BROKE_APPLICATION",
            "the group-address flash left the device's application program object out of the LOADED state (it was LOADED before): the tables were written but the device is no longer running its application, so the links are not functional. Recover the device with a full download.");
        }
        const { ok } = await verifySettled(
          () => readGroupTables(dev),
          (back) => back.addr.equals(addr) && back.assoc.equals(assoc) && back.comObj.equals(comObj),
        );
        return ok;
      },
    });
  }
}

// System 7 (absolute-segment) devices: MV-0700/0701/0705 and the RF/IP variants. Parameters
// live at fixed EEPROM addresses (driven by the device's declared LoadProcedure); group tables
// use the System-7 layout. Read-back, parameter flash and GA flash are all hardware-verified
// on twisted-pair (M-0081): identity flash, re-point and revert each byte-matched.
export class System7Profile extends DeviceProfile {
  readonly memoryModel = "absolute" as const;
  constructor(readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }

  capabilities(): DeviceCapabilities {
    // Parameters (absolute segments) and links (System-7 tables) are both read back. Parameter
    // and GA flash are hardware-proven on TP (M-0081); the RF/IP variants share the codec
    // but have not been exercised on that medium (see the device-support.md medium caveat).
    //
    // Full download needs the group-table segments and, for the memory-mapped System 7 masks
    // (MV-0700/0701, hardware-proven on the ABB US/U 4.2), nothing more: the app ships every
    // segment's <Data> so the whole image is authored from it. The property-mapped MV-0705 variants
    // do NOT ship a configured com-object table; downloadFull authors L3 into the <ComObjectTable
    // CodeSegment>, so a full download is possible exactly when the app declares that segment
    // (buildComObjectTableMv0705). Byte-verified against two ETS captures of the MDT BE-02001.02 and
    // live-hardware certified on it: full download verified=true, and the device answers
    // group communication on a flashed link, unchanged across a bus power-cycle (docs/commissioning.md).
    const canFull = !!this.cfg && this.cfg.absoluteSegments.length > 0 &&
      this.cfg.groupTables.addressSegment !== undefined && this.cfg.groupTables.associationSegment !== undefined &&
      (isMemoryMappedLsm(this.mask) || this.cfg.groupTables.comObjectSegment !== undefined);
    return { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: canFull };
  }

  async readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback> {
    const cfg = this.requireCfg("read-back");
    const paramBase = new Map(ctx.baseParams ?? ctx.liveParams);
    const instances = ctx.moduleInstances?.length ? ctx.moduleInstances : (cfg.hasModules ? resolveModuleInstances(cfg, ctx.liveParams) : []);
    const absModel = toAppModel(cfg, { includeUnions: true, instances });
    const absoluteTargets = buildAbsoluteSegmentTargets(cfg, ctx.liveParams, { moduleInstances: ctx.moduleInstances });

    // memRead reports progress in BYTES; accumulate across segments for a whole-read bar.
    const totalBytes = absoluteTargets.reduce((n, t) => n + t.size, 0);
    let doneBytes = 0;
    for (const t of absoluteTargets) {
      const deviceImg = await dev.memRead(t.address, t.size, undefined, (d) => ctx.onProgress?.("params", doneBytes + d, totalBytes), ctx.signal);
      foldDeviceValues(
        paramBase,
        decodeAbsoluteImage(absModel, t.id, deviceImg),
        decodeAbsoluteImage(absModel, t.id, t.bytes),
        ctx.liveParams,
        ctx.relevantRefs,
      );
      doneBytes += t.size;
    }

    if (ctx.signal?.aborted) throw new ProductError("READ_ABORTED", "read aborted");
    ctx.onProgress?.("links", 0, 2);
    const gt = await readGroupTablesMv0705(dev, (d, total) => ctx.onProgress?.("links", d, total));
    const links = decodeGroupTablesMv0705(gt.addr, gt.assoc);
    return { mask, paramsRead: true, linksRead: true, paramBase, links };
  }

  async flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("parameter flash");
    const proc = parseLoadProcedures(ctx.appXml);
    if (proc.style === "DefaultProcedure" || proc.blocks.length === 0) {
      throw new ProductError("LOAD_PROCEDURE_UNSUPPORTED", `device declares no usable load procedure (style ${proc.style}); cannot flash safely`);
    }
    const coverage = assertParCoverage(proc, "absolute");
    // Same com-object-table staleness gate as System B: the absolute path keeps the device's
    // com-object table too, so a parameter that changes the active object set or its flags
    // would silently invalidate it. See comobjtable.ts.
    assertComObjectTableStable(cfg, ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    const moduleInstances = ctx.moduleInstances;
    const targets = buildAbsoluteSegmentTargets(cfg, ctx.params, { moduleInstances }).filter((t) => t.size > 0);
    const totalBytes = targets.reduce((n, t) => n + t.size, 0);

    await runDeclaredChecks(dev, coverage);

    // Read each parameter segment at its fixed address; this is the backup and the diff source.
    const current = new Map<string, Buffer>();
    const stamp = Date.now();
    let read = 0;
    for (const t of targets) {
      const onDev = await dev.memRead(t.address, t.size, undefined, (d) => ctx.onProgress?.("backup", read + d, totalBytes));
      read += t.size;
      current.set(t.id, onDev);
    }

    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, ctx.params, proc, current, { moduleInstances, requireReboot: !persistsOnLoadCompleted(cfg) });
    // No-silent-drop: a changed segment with no LSM in the load procedure cannot be programmed.
    if (unplaceable.length) {
      throw new ProductError("FLASH_SEGMENT_UNPLACEABLE", `${unplaceable.length} changed parameter segment(s) are not declared in the device's load procedure; refusing to flash to avoid a silent partial write`);
    }
    return runFlashOp(dev, mask, ctx, {
      imageBytes: totalBytes,
      diffBytes: changedBytes,
      backup: `${ctx.deviceId}-${targets[0]?.id.split("_").pop() ?? "AS"}-${stamp}.bin`,
      backups: targets.map((t) => ({ file: `${ctx.deviceId}-${t.id.split("_").pop()}-${stamp}.bin`, bytes: current.get(t.id)! })),
      write: async () => {
        let wrote = 0;
        // The memory-mapped System 7 masks (MV-0700/0701) drive their LSMs over 0x0104, not PID 5;
        // a surgical param flash needs the same transport the full download does, or it would talk
        // to a dead property interface (hardware: the ABB US/U 4.2 flash never acked otherwise).
        await runLoadPlan(dev, plan, { memMappedLsms: isMemoryMappedLsm(mask), onStep: (_i, step) => { if (step.op === "writeMem") ctx.onProgress?.("write", (wrote += step.bytes.length), changedBytes); } });
      },
      verify: async () => {
        for (const t of targets) {
          // Verify only user-facing owned bytes (t.verify). Access="None" device-internal markers
          // are written but excluded: the device re-stamps them on download (e.g. M-008E AS-4B00[0:2]),
          // so checking them would fail every successful flash. Same authority boundary as unowned bytes.
          const { ok } = await verifySettled(
            () => dev.memRead(t.address, t.size, undefined, (d, n) => ctx.onProgress?.("verify", d, n)),
            (back) => verifyMaskedBytes(back, t.bytes, t.verify),
          );
          if (!ok) return false;
        }
        return true;
      },
    });
  }

  async flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult> {
    // Same com-object staleness gate as System B: an association onto an object the device's
    // (kept-from-device) com-object table does not configure is a link to nothing.
    assertComObjectTableStable(this.requireCfg("group address flash"), ctx.baseParams, ctx.params, ctx.moduleInstances ?? []);
    // buildGroupTablesMv0705 / planMv0705GaFlash, hardware-verified on TP (M-0081):
    // identity flash byte-matched (write path + LSM bracket + restart), a real re-point applied
    // and byte-matched, and the revert restored the device exactly.
    const { addr, assoc } = buildGroupTablesMv0705(ctx.links, iaToNum(ctx.ia));
    const cur = await readGroupTablesMv0705(dev);
    // CAPACITY: a System 7 device's address/association tables sit in PRE-RESERVED absolute
    // segments (no reallocation, unlike System B's allocSegment). The app program declares how
    // many entries the device reserved room for (<AddressTable>/<AssociationTable> MaxEntries),
    // so growing the tables UP TO that capacity stays inside the reserved segment; beyond it the
    // write would overrun adjacent memory (association/com-object table), which the table-only
    // verify below would not catch. Layouts: address = [count:1][own IA:2][GA:2 x N] -> max
    // 3 + 2*addressMaxEntries; association = [count:1][groupIdx:1][comObj:1 x M] -> max
    // 1 + 2*associationMaxEntries. If the program declares no capacity, fall back to the
    // conservative "no growth beyond the current table" bound (the current table demonstrably fits).
    const cap = this.cfg?.groupTables;
    const maxAddr = cap?.addressMaxEntries !== undefined ? 3 + 2 * cap.addressMaxEntries : cur.addr.length;
    const maxAssoc = cap?.associationMaxEntries !== undefined ? 1 + 2 * cap.associationMaxEntries : cur.assoc.length;
    if (addr.length > maxAddr || assoc.length > maxAssoc) {
      throw new ProductError("GA_TABLE_TOO_LARGE",
        `the group tables would need address ${addr.length} B / association ${assoc.length} B, but this device reserves only ${maxAddr} B / ${maxAssoc} B${cap?.addressMaxEntries !== undefined ? ` (${cap.addressMaxEntries} group addresses)` : ""}. Remove links or assign fewer group addresses.`);
    }
    const prefix = `${ctx.deviceId}-GA-${Date.now()}`;
    return runFlashOp(dev, mask, ctx, {
      imageBytes: addr.length + assoc.length,
      diffBytes: byteDiff(addr, cur.addr) + byteDiff(assoc, cur.assoc), // 0 iff both tables match
      backup: prefix,
      backups: [
        { file: `${prefix}-addr.bin`, bytes: cur.addr },
        { file: `${prefix}-assoc.bin`, bytes: cur.assoc },
      ],
      write: async () => {
        ctx.onProgress?.("write");
        await runLoadPlan(dev, planMv0705GaFlash({ addr, assoc }), { memMappedLsms: isMemoryMappedLsm(mask) }); // same memory-mapped transport as the param flash / download on MV-0700/0701
      },
      verify: async () => {
        ctx.onProgress?.("verify");
        const { ok } = await verifySettled(
          () => readGroupTablesMv0705(dev),
          (back) => back.addr.equals(addr) && back.assoc.equals(assoc),
        );
        return ok;
      },
    });
  }

  planFullDownload(mask: string, inputs: FullDownloadInputs): FullDownloadBuild {
    const { plan, segments, imageBytes } = this.planSystem7Full(mask, inputs);
    return { plan, imageBytes, segments: segments.map((s) => ({ id: s.id, lsm: s.lsm, source: s.source, address: s.address, image: s.image })) };
  }

  private planSystem7Full(mask: string, ctx: FullDownloadInputs): { plan: LoadPlan; segments: AbsFullSegment[]; imageBytes: number } {
    const cfg = this.requireCfg("full download");
    const proc = ctx.proc;
    const propertyMapped = !isMemoryMappedLsm(mask);
    if (propertyMapped && !cfg.groupTables.comObjectSegment) {
      throw new ProductError("FULL_DOWNLOAD_UNSUPPORTED",
        `property-mapped device (mask ${mask}) declares no <ComObjectTable CodeSegment>; cannot author its com-object table, refusing to write a manufacturer-default L3`);
    }
    const instances = cfg.hasModules ? (ctx.moduleInstances?.length ? ctx.moduleInstances : resolveModuleInstances(cfg, ctx.params)) : [];
    const view = buildDeviceConfig(cfg, ctx.params, undefined, instances);
    // A link whose com-object this configuration does not activate would build an association to an
    // object the device ignores: a group address the UI calls programmed and the device never answers.
    // Refuse, exactly as the surgical GA flash and the System B full download do. Without this the
    // MV-0705 L3 author clears the (inactive) object's linked bit while the association is still emitted.
    const active = new Set(view.imageComObjects.keys());
    const orphans = ctx.links.filter((l) => !active.has(l.comObjNum));
    if (orphans.length) {
      throw new ProductError("LINK_COM_OBJECT_INACTIVE",
        `${orphans.length} group-address link(s) target communication objects this configuration does not activate (e.g. #${orphans[0].comObjNum}); the device would ignore them, so refusing to report them as programmed`);
    }
    // The com-object table is authored only for property-mapped devices: the visibility-gated active
    // objects (imageComObjects) overlaid on the segment's static template, with the linked set from
    // the group-address links (see comobjbuild.ts buildComObjectTableMv0705 and its two-capture proof).
    const comObjectTable = propertyMapped
      ? { active: view.imageComObjects, linked: new Set(ctx.links.map((l) => l.comObjNum)) }
      : undefined;
    // These devices persist to EEPROM as each segment is written, so the closing A_Restart only
    // re-runs the application; it is not the persistence boundary (unlike thelsing/knx). Do not
    // demand a reboot signal the BIM M112 firmware need not give; the post-restart read-back proves
    // the configuration is really there.
    const { plan, segments, imageBytes } = planAbsoluteFullDownload(cfg, ctx.params, ctx.links, iaToNum(ctx.ia), proc, { moduleInstances: instances, requireReboot: false, comObjectTable });
    if (imageBytes === 0) throw new ProductError("EMPTY_IMAGE", "built an empty download image; refusing to commission nothing");

    return { plan, segments, imageBytes };
  }

  // Commission an absolute-segment (System 7) device from its declared load procedure: author the
  // address + association tables (from the links), every parameter-bearing segment (its <Data>
  // overlaid with the active parameters), and the static application segments (com-object table +
  // code, straight from their <Data>), driving the LSM brackets over the memory-mapped interface
  // (MV-0700/0701). Unlike the surgical par flash this writes EVERY segment, so a virgin device
  // comes up running. The device validates none of it; the read-back after the restart is the
  // only proof, so a "flashed" result carries a real verified flag.
  async downloadFull(dev: KnxDevice, mask: string, ctx: FullDownloadCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("full download");
    // Property-mapped System 7 (MV-0705) authors its com-object table (L3); memory-mapped MV-0700/0701
    // writes L3 as the manufacturer's static <Data>. The two paths share planAbsoluteFullDownload; the
    // difference is whether `comObjectTable` is supplied (see deviceflash.ts). ETS puts these devices
    // into verify mode (DeviceControl obj0/PID14 |= VERIFY_MODE) so the device echoes each write; we do
    // not need it — planAbsoluteFullDownload's writeMem reads every write back instead, the mechanism
    // the MV-0705 par flash is hardware-proven on for this device family (docs/commissioning.md).
    const propertyMapped = !isMemoryMappedLsm(mask);
    if (propertyMapped && !cfg.groupTables.comObjectSegment) {
      throw new ProductError("FULL_DOWNLOAD_UNSUPPORTED",
        `property-mapped device (mask ${mask}) declares no <ComObjectTable CodeSegment>; cannot author its com-object table, refusing to write a manufacturer-default L3`);
    }
    const proc = parseLoadProcedures(ctx.appXml);
    // App-id pre-flight, virgin-aware. The checks come from the download's OWN "full" steps (not
    // the "par" list), so a CompareProp declared AppliesTo="full" is never missed. A match = the
    // device already holds this application (re-commission); an all-zero read = a virgin device
    // (the intended from-nothing case); a DIFFERENT non-zero application is refused, so a full
    // download never lands the wrong app's image on a device. Unmodeled *steps* are refused by the
    // planner (planAbsoluteFullDownload's default case), which walks the same "full" list.
    for (const c of declaredPropChecks(proc, "full")) {
      const { ok, got } = await compareDeclaredProp(dev, c.obj, c.pid, c.expect, c.mask);
      const virgin = got.length === 0 || got.every((b) => b === 0);
      if (!ok && !virgin) {
        throw new ProductError("LOAD_PROC_CHECK_FAILED",
          `object ${c.obj} property ${c.pid} reads ${got.toString("hex")} but this application is ${c.expect.toString("hex")}; refusing to commission a different application onto this device`);
      }
    }

    const { plan, segments, imageBytes } = this.planSystem7Full(mask, { ...ctx, proc });

    // Back up every declared absolute segment before the unload/rewrite destroys it, sized by the
    // app's own segment declarations. OFF by default (ctx.backupBeforeUnload): the download rebuilds
    // every segment from the project, so reading them all back first is minutes of bus traffic for a
    // recovery copy whose payoff is narrow (see FullDownloadCtx.backupBeforeUnload). The read stays
    // here, gated, for a future opt-in.
    const stamp = Date.now();
    const backups: { file: string; bytes: Buffer }[] = [];
    if (ctx.backupBeforeUnload) {
      ctx.onProgress?.("backup");
      const backTotal = cfg.absoluteSegments.reduce((n, s) => n + s.size, 0);
      let backDone = 0;
      for (const seg of cfg.absoluteSegments) {
        const bytes = await dev.memRead(seg.address, seg.size, undefined, (d) => ctx.onProgress?.("backup", backDone + d, backTotal));
        backDone += seg.size;
        backups.push({ file: `${ctx.deviceId}-abs-${seg.id.split("_").pop()}-${stamp}.bin`, bytes });
      }
    }

    const memMappedLsms = isMemoryMappedLsm(mask);
    return runFlashOp(dev, mask, ctx, {
      imageBytes,
      diffBytes: imageBytes, // a full download owns every byte it writes
      backup: `${ctx.deviceId}-full-${stamp}`,
      backups,
      write: async () => { await runLoadPlan(dev, plan, { memMappedLsms, onWrite: (d, t) => ctx.onProgress?.("write", d, t) }); },
      // Read every written segment back and compare to what we built, masking out the download-
      // recognition bytes the device re-stamps for itself (the MV-0701 P-2228 "Downloaderkennung").
      // Only a full byte-match across every segment is a verified download.
      verify: async () => {
        for (const s of segments) {
          const back = await dev.memRead(s.address, s.image.length, undefined, (d, n) => ctx.onProgress?.("verify", d, n));
          if (!verifyMaskedBytes(back, s.image, s.verify)) return false;
        }
        return true;
      },
    });
  }
}

// Every recognised-but-not-implemented memory model: System 1 (BCU1), System 2 (BCU2),
// System 300, couplers, interfaces, IR decoders, media couplers, RF-only, unknown masks.
// Capabilities are all false and every operation throws, so such a device is reported as
// honestly unsupported instead of being misrouted into a path that would fabricate a result.
// (This is what fixes MV-0012: it has an AbsoluteSegment and used to be misread as System 7.)
export class UnsupportedProfile extends DeviceProfile {
  constructor(readonly memoryModel: MemoryModel, readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }
  capabilities(): DeviceCapabilities { return { readParams: false, readLinks: false, flashParams: false, flashLinks: false, fullDownload: false }; }
  async readState(): Promise<DeviceReadback> { throw new UnsupportedOperation("read-back", this.family, this.mask); }
  async flashParameters(): Promise<FlashResult> { throw new UnsupportedOperation("parameter flash", this.family, this.mask); }
  async flashGroupTables(): Promise<FlashResult> { throw new UnsupportedOperation("group-address flash", this.family, this.mask); }
}

function profileFor(mask: string, cfg: AppConfig | null): DeviceProfile {
  const info = maskInfo(mask);
  switch (info.memoryModel) {
    case "relative": return new SystemBProfile(info.family, mask, cfg);
    case "absolute": return new System7Profile(info.family, mask, cfg);
    // Memory models nobody has implemented. They resolve to a profile whose every operation
    // throws, which is the whole point (see UnsupportedProfile). Enumerated rather than caught by
    // a `default`, so that a model added to masks.ts cannot land here by accident and be declared
    // unsupported when someone has in fact implemented it.
    case "bcu1": case "bcu2": case "system300": case "none":
      return new UnsupportedProfile(info.memoryModel, info.family, mask, cfg);
  }
}

// Resolve a parsed application to its device profile. Dispatches on the MEMORY MODEL the mask
// version implies (masks.ts), never on incidental structure (the old "has an absolute segment"
// heuristic misrouted System 1 devices that happen to carry one).
export function classify(cfg: AppConfig): DeviceProfile {
  return profileFor(cfg.mask, cfg);
}

// Resolve a profile from a mask string alone, for the GA-flash path where the application is
// not re-parsed (group tables depend only on the memory model). Parameter operations on the
// returned profile throw (no cfg); the GA path never calls them.
export function classifyByMask(mask: string): DeviceProfile {
  return profileFor(mask, null);
}


// The reader (grouptable-read.ts) refuses a group table whose count header exceeds this; the
// backup path matches it so the two twins agree on what "not in the expected format" means.
const MAX_BACKUP_TABLE_ENTRIES = 2048;

// How many bytes a loaded group table occupies on the device, from its own count header. Used to
// back up an already-programmed device's tables before a full download destroys them. An
// implausible count means the loaded table is not in the expected System B form, so its true
// length is unknown: backing up a guessed span and then unloading the real table would destroy
// bytes the "backup" never captured. Refuse the whole download instead (the same coded error the
// reader raises on the same condition), rather than silently skipping the table and unloading it.
async function tableByteLength(dev: KnxDevice, obj: number, at: number): Promise<number> {
  const head = await dev.memRead(at, 2);
  const count = (head[0] << 8) | head[1];
  if (count > MAX_BACKUP_TABLE_ENTRIES) {
    throw new GroupTableUnreadable(
      `loaded group object ${obj} table reports ${count} entries (implausible); refusing the full download rather than unloading a table this backup cannot capture`);
  }
  const entryBytes = obj === OBJ.ASSOC_TABLE ? 4 : 2;
  return 2 + count * entryBytes;
}
