import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnxDevice, flashParameters, flashGroupTables, flashGroupTablesMv0705, appId, runLoadPlan, iaToNum } from "@busforge/knx";
import {
  toAppModel, buildParameterImage, buildRelativeSegmentTarget, mergeRelativeTarget, verifyRelativeOwned,
  buildDeviceConfig, buildGroupTables, buildGroupTablesMv0705, decodeParameterImage, decodeAbsoluteImage,
  decodeGroupTables, decodeGroupTablesMv0705, unmappedParamRefs, resolveModuleInstances, parseLoadProcedures,
  buildAbsoluteSegmentTargets, planAbsoluteParFlash, maskInfo, parseAppConfig,
  type AppConfig, type AppModel, type ModuleInstance, type ComObjectLink, type MemoryModel, type SystemFamily,
} from "@busforge/product";
import { makeTransport } from "./transport.ts";
import type { Connection } from "./db/connections.ts";
import { ApiError } from "./errors.ts";
import type { ProgressFn } from "./taskqueue.ts";

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
// The connect / mask-check / disconnect envelope is identical across models and read/flash,
// so it lives once in withDeviceSession(); the profiles own only the model-specific body.
// ─────────────────────────────────────────────────────────────────────────────

const LSM = 4; // System B parameter segment
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const byteDiff = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d;
};

export interface FlashResult {
  mask: string;
  imageBytes: number;
  diffBytes: number;
  changed: boolean;
  flashed: boolean;
  verified?: boolean;
  backup: string;
}

// The programmed-baseline read back off the bus (see readState). `paramBase` is sparse like
// device_parameters; the caller persists only the aspects whose *Read flag is true.
export interface DeviceReadback { mask: string; paramsRead: boolean; linksRead: boolean; paramBase: Map<string, string>; links: ComObjectLink[]; }

// What can be done with a device today, split by aspect. Read and write are independent
// capabilities (an unsupported family may be neither), as are parameters and links.
export interface DeviceCapabilities { readParams: boolean; readLinks: boolean; flashParams: boolean; flashLinks: boolean; }

export interface ReadStateCtx {
  liveParams: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  // Drift is only recorded for refs in this set (the config view's keys); see readState.
  relevantRefs?: Set<string>;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}
export interface ParamFlashCtx {
  projectId: string;
  deviceId: string;
  appXml: string;
  params: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  dataDir: string;
  dryRun: boolean;
  onProgress?: ProgressFn;
}
export interface GaFlashCtx {
  projectId: string;
  deviceId: string;
  ia: string;
  links: ComObjectLink[];
  dataDir: string;
  dryRun: boolean;
  onProgress?: ProgressFn;
}

// An operation a device's memory model does not implement. Carries an ApiError code so the
// HTTP layer surfaces an honest "unsupported" rather than a 500.
export class UnsupportedOperation extends ApiError {
  constructor(op: string, family: SystemFamily, mask: string) {
    super("DEVICE_FAMILY_UNSUPPORTED", `${op} is not supported for ${family} devices (mask ${mask}); this device family is recognised but not yet implemented`);
  }
}

// Open a connection-oriented link to the device, verify it is the device/application we
// expect, run the model-specific body, and always tear the link down. The mask check is the
// primary safety gate (wrong device or wrong application aborts before any read or write).
async function withDeviceSession<T>(
  connection: Connection,
  ia: string,
  wantMask: string,
  onProgress: ProgressFn | undefined,
  body: (dev: KnxDevice, mask: string) => Promise<T>,
): Promise<T> {
  const tun = makeTransport(connection);
  onProgress?.("connect");
  await tun.connect();
  const dev = new KnxDevice(tun, ia);
  try {
    await dev.connect();
    const mask = await dev.deviceDescriptor();
    const want = wantMask.replace(/^MV-/, "");
    if (!want) throw new ApiError("MASK_UNKNOWN", "application mask unknown; refusing");
    if (!mask.includes(want)) throw new ApiError("MASK_MISMATCH", `device mask ${mask} != expected ${want}; aborting (wrong device or application)`);
    const result = await body(dev, mask);
    await dev.disconnect(); await tun.disconnect();
    return result;
  } catch (e) {
    try { await dev.disconnect(); } catch {}
    try { await tun.disconnect(); } catch {}
    throw e;
  }
}

// Resolve a device's module instances and build a module-aware image model plus the values
// to write (System B). Unchanged from the original flash module; used by the System B param
// read and flash. A non-module device gets the unchanged flat model.
function moduleAwareImage(cfg: AppConfig, params: Map<string, string>, provided: ModuleInstance[], lang?: string): { model: AppModel; writeValues: Map<string, string> } {
  if (!cfg.hasModules) return { model: toAppModel(cfg), writeValues: params };
  const instances = provided.length ? provided : resolveModuleInstances(cfg, params);
  const model = toAppModel(cfg, { instances });
  const view = buildDeviceConfig(cfg, params, lang, instances);
  const writeValues = new Map<string, string>();
  for (const [k, v] of params) if (!k.includes("_MI-")) writeValues.set(k, v);
  for (const [k, v] of view.imageValues) if (k.includes("_MI-")) writeValues.set(k, v);
  return { model, writeValues };
}

// A group/association table starts with a device-supplied entry count; it must be bounded
// before reading count*width bytes (see readGroupTables). An MV-0705 device whose table
// pointer lands in parameter memory would otherwise decode to thousands of entries and hang.
const MAX_TABLE_ENTRIES = 2048;

// Read a System B device's group tables (address, association, com-object), detecting the
// long vs short association format. `skipComObj` omits the (largest) com-object table.
export async function readGroupTables(dev: KnxDevice, onStep?: (done: number, total: number) => void, skipComObj = false): Promise<{ addr: Buffer; assoc: Buffer; comObj: Buffer; long: boolean }> {
  const boundCount = (count: number, what: string): number => {
    if (count > MAX_TABLE_ENTRIES) throw new ApiError("GROUP_TABLE_UNREADABLE", `${what} reports ${count} entries (implausible); this device's group tables are not in the expected System B format`);
    return count;
  };
  const counted = async (obj: number, width: number) => {
    const base = await dev.tableAddr(obj);
    const h = await dev.memRead(base, 2);
    const count = boundCount((h[0] << 8) | h[1], `group object ${obj} table`);
    return dev.memRead(base, 2 + count * width);
  };
  const total = skipComObj ? 2 : 3;
  const addr = await counted(1, 2);
  onStep?.(1, total);
  const gcount = (addr[0] << 8) | addr[1];
  const a2 = await dev.tableAddr(2);
  const ah = await dev.memRead(a2, 2);
  const acount = boundCount((ah[0] << 8) | ah[1], "association table");
  let assoc = await dev.memRead(a2, 2 + acount * 4);
  let long = true;
  for (let k = 0; k < acount; k++) { const gi = (assoc[2 + k * 4] << 8) | assoc[3 + k * 4]; if (gi < 1 || gi > gcount) { long = false; break; } }
  if (!long) assoc = await dev.memRead(a2, 2 + acount * 2);
  onStep?.(2, total);
  const comObj = skipComObj ? Buffer.alloc(0) : await counted(3, 2);
  if (!skipComObj) onStep?.(3, total);
  return { addr, assoc, comObj, long };
}

// Read an MV-0705 device's address + association tables. Same property-pointer addressing as
// System B, but the count is a SINGLE byte and each entry is 2 bytes (read length 1+count*2).
export async function readGroupTablesMv0705(dev: KnxDevice, onStep?: (done: number, total: number) => void): Promise<{ addr: Buffer; assoc: Buffer }> {
  const readTable = async (obj: number) => {
    const base = await dev.tableAddr(obj);
    const count = (await dev.memRead(base, 1))[0];
    return dev.memRead(base, 1 + count * 2);
  };
  const addr = await readTable(1); onStep?.(1, 2);
  const assoc = await readTable(2); onStep?.(2, 2);
  return { addr, assoc };
}

// ─────────────────────────────────────────────────────────────────────────────

export abstract class DeviceProfile {
  abstract readonly memoryModel: MemoryModel;
  abstract readonly family: SystemFamily;
  constructor(readonly mask: string, protected readonly cfg: AppConfig | null) {}

  abstract capabilities(params: Map<string, string>, moduleInstances?: ModuleInstance[]): DeviceCapabilities;
  abstract readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback>;
  abstract flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult>;
  abstract flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult>;

  protected requireCfg(op: string): AppConfig {
    if (!this.cfg) throw new ApiError("APP_PROGRAM_MISSING", `${op} needs the application program but it was not provided`);
    return this.cfg;
  }
}

// System B (relative-segment) devices: MV-07B0 and its medium variants. Parameters live in a
// relative LSM4 segment (surgical owned-byte download); group tables use the count-prefixed
// System B layout. Hardware-proven (read and flash, on twisted pair).
export class SystemBProfile extends DeviceProfile {
  readonly memoryModel = "relative" as const;
  constructor(readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }

  capabilities(params: Map<string, string>): DeviceCapabilities {
    // Parameters are decoded from the LSM4 segment; a relative device WITHOUT one has nowhere
    // to read them from, so don't claim its params verify. Group tables are always present.
    const hasParamSegment = this.cfg ? toAppModel(this.cfg).segments.some((s) => s.lsm === LSM) : false;
    return { readParams: hasParamSegment, readLinks: true, flashParams: true, flashLinks: true };
  }

  async readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback> {
    const cfg = this.requireCfg("read-back");
    const { model, writeValues } = moduleAwareImage(cfg, ctx.liveParams, ctx.moduleInstances ?? []);
    const support = this.capabilities(ctx.liveParams);
    const paramBase = new Map(ctx.liveParams);
    let links: ComObjectLink[] = [];
    let paramsRead = false, linksRead = false;

    // Parameters (LSM 4): read the whole segment, decode it, compare against what the project
    // would flash, both normalized via the same codec.
    const seg = model.segments.find((s) => s.lsm === LSM);
    if (support.readParams && seg) {
      const img = await dev.memRead(await dev.tableAddr(LSM), seg.size, 12, (d, t) => ctx.onProgress?.("params", d, t), ctx.signal);
      const deviceVals = decodeParameterImage(model, LSM, img);
      const projectVals = decodeParameterImage(model, LSM, buildParameterImage(model, LSM, writeValues));
      for (const [refId, devVal] of deviceVals) {
        if (ctx.relevantRefs && !ctx.relevantRefs.has(refId)) continue;
        if (projectVals.get(refId) !== devVal) paramBase.set(refId, devVal);
      }
      paramsRead = true;
    }
    // Group-address links: read address + association tables (skip the com-object table) and reverse.
    if (support.readLinks) {
      if (ctx.signal?.aborted) throw new ApiError("READ_ABORTED", "read aborted");
      ctx.onProgress?.("links", 0, 2);
      const gt = await readGroupTables(dev, (d, total) => ctx.onProgress?.("links", d, total), true);
      links = decodeGroupTables(gt.addr, gt.assoc, gt.long);
      linksRead = true;
    }
    return { mask, paramsRead, linksRead, paramBase, links };
  }

  async flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("parameter flash");
    // Build + safety refusals. These run AFTER the session's connect/mask-check (vs before, in
    // the original), which is harmless: no device byte is written until below, and verifying we
    // are on the right device first is if anything safer.
    const { model } = moduleAwareImage(cfg, ctx.params, ctx.moduleInstances ?? []);
    // SAFETY: a stored value the image model cannot place would be silently dropped and its
    // region reset to default. Refuse rather than wipe a configured channel.
    const unmapped = unmappedParamRefs(model, ctx.params);
    if (unmapped.length) {
      throw new ApiError("CHANNEL_MODULES_UNSUPPORTED",
        `parameter programming cannot place ${unmapped.length} stored value(s) for this device (e.g. ${unmapped[0]}); they would be dropped and that region reset to defaults. Refusing to flash to protect the device configuration.`);
    }
    // Surgical owned-byte target: only these bytes may be written; everything ETS computes that
    // we cannot reproduce is preserved by sourcing unowned bytes from the live read.
    const target = buildRelativeSegmentTarget(cfg, ctx.params, LSM, { moduleInstances: ctx.moduleInstances });
    if (!target || target.size === 0) throw new ApiError("EMPTY_IMAGE", "built an empty parameter image; refusing to flash");

    const addr = await dev.tableAddr(LSM);
    const current = await dev.memRead(addr, target.size, 12, (d, t) => ctx.onProgress?.("backup", d, t));

    const backupDir = join(ctx.dataDir, "projects", ctx.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${ctx.deviceId}-LSM${LSM}-${Date.now()}.bin`);
    writeFileSync(backup, current);

    const { image, diffBytes } = mergeRelativeTarget(current, target);
    if (diffBytes === 0) return { mask, imageBytes: image.length, diffBytes, changed: false, flashed: false, backup };
    if (ctx.dryRun) return { mask, imageBytes: image.length, diffBytes, changed: true, flashed: false, backup };

    await flashParameters(dev, image, appId(model.manufacturer, model.appNumber, model.version), (d, t) => ctx.onProgress?.("write", d, t));

    // The device restarts after load-completed; reconnect and verify ONLY the owned bytes.
    await sleep(3000);
    await dev.connect();
    const back = await dev.memRead(await dev.tableAddr(LSM), image.length, 12, (d, t) => ctx.onProgress?.("verify", d, t));
    const verified = verifyRelativeOwned(back, target);
    return { mask, imageBytes: image.length, diffBytes, changed: true, flashed: true, verified, backup };
  }

  async flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult> {
    const { addr, assoc } = buildGroupTables(ctx.links);
    // The dry-run preview compares only address + association; the com-object table is read
    // only to write it back unchanged on a real flash, so skip it when previewing.
    const cur = await readGroupTables(dev, undefined, ctx.dryRun);
    const backupDir = join(ctx.dataDir, "projects", ctx.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = Date.now();
    const backup = join(backupDir, `${ctx.deviceId}-GA-${stamp}`);
    writeFileSync(`${backup}-addr.bin`, cur.addr);
    writeFileSync(`${backup}-assoc.bin`, cur.assoc);
    if (!ctx.dryRun) writeFileSync(`${backup}-comobj.bin`, cur.comObj);

    const diffBytes = byteDiff(addr, cur.addr) + byteDiff(assoc, cur.assoc);
    const imageBytes = addr.length + assoc.length;
    if (addr.equals(cur.addr) && assoc.equals(cur.assoc)) return { mask, imageBytes, diffBytes: 0, changed: false, flashed: false, backup };
    if (ctx.dryRun) return { mask, imageBytes, diffBytes, changed: true, flashed: false, backup };

    ctx.onProgress?.("write");
    await flashGroupTables(dev, { addr, assoc, comObj: cur.comObj }); // keep the device's com-object table
    await sleep(3000);
    await dev.connect();
    ctx.onProgress?.("verify");
    const back = await readGroupTables(dev);
    const verified = back.addr.equals(addr) && back.assoc.equals(assoc);
    return { mask, imageBytes, diffBytes, changed: true, flashed: true, verified, backup };
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
    return { readParams: true, readLinks: true, flashParams: true, flashLinks: true };
  }

  async readState(dev: KnxDevice, mask: string, ctx: ReadStateCtx): Promise<DeviceReadback> {
    const cfg = this.requireCfg("read-back");
    const paramBase = new Map(ctx.liveParams);
    const instances = ctx.moduleInstances?.length ? ctx.moduleInstances : (cfg.hasModules ? resolveModuleInstances(cfg, ctx.liveParams) : []);
    const absModel = toAppModel(cfg, { includeUnions: true, instances });
    const absoluteTargets = buildAbsoluteSegmentTargets(cfg, ctx.liveParams, { moduleInstances: ctx.moduleInstances });

    // memRead reports progress in 12-byte chunks; accumulate across segments for a whole-read bar.
    const chunksFor = (size: number) => Math.ceil(size / 12);
    const totalChunks = absoluteTargets.reduce((n, t) => n + chunksFor(t.size), 0);
    let doneChunks = 0;
    for (const t of absoluteTargets) {
      const deviceImg = await dev.memRead(t.address, t.size, 12, (d) => ctx.onProgress?.("params", doneChunks + d, totalChunks), ctx.signal);
      const deviceVals = decodeAbsoluteImage(absModel, t.id, deviceImg);
      const projectVals = decodeAbsoluteImage(absModel, t.id, t.bytes);
      for (const [refId, devVal] of deviceVals) {
        if (ctx.relevantRefs && !ctx.relevantRefs.has(refId)) continue;
        if (projectVals.get(refId) !== devVal) paramBase.set(refId, devVal);
      }
      doneChunks += chunksFor(t.size);
    }

    if (ctx.signal?.aborted) throw new ApiError("READ_ABORTED", "read aborted");
    ctx.onProgress?.("links", 0, 2);
    const gt = await readGroupTablesMv0705(dev, (d, total) => ctx.onProgress?.("links", d, total));
    const links = decodeGroupTablesMv0705(gt.addr, gt.assoc);
    return { mask, paramsRead: true, linksRead: true, paramBase, links };
  }

  async flashParameters(dev: KnxDevice, mask: string, ctx: ParamFlashCtx): Promise<FlashResult> {
    const cfg = this.requireCfg("parameter flash");
    const proc = parseLoadProcedures(ctx.appXml);
    if (proc.style === "DefaultProcedure" || proc.blocks.length === 0) {
      throw new ApiError("LOAD_PROCEDURE_UNSUPPORTED", `device declares no usable load procedure (style ${proc.style}); cannot flash safely`);
    }
    const moduleInstances = ctx.moduleInstances;
    const targets = buildAbsoluteSegmentTargets(cfg, ctx.params, { moduleInstances }).filter((t) => t.size > 0);
    const totalBytes = targets.reduce((n, t) => n + t.size, 0);

    // Read each parameter segment at its fixed address; this is the backup and the diff source.
    const current = new Map<string, Buffer>();
    const backupDir = join(ctx.dataDir, "projects", ctx.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = Date.now();
    let read = 0;
    for (const t of targets) {
      const onDev = await dev.memRead(t.address, t.size, 12, (d) => ctx.onProgress?.("backup", read + d, totalBytes));
      read += t.size;
      current.set(t.id, onDev);
      writeFileSync(join(backupDir, `${ctx.deviceId}-${t.id.split("_").pop()}-${stamp}.bin`), onDev);
    }
    const backup = join(backupDir, `${ctx.deviceId}-${targets[0]?.id.split("_").pop() ?? "AS"}-${stamp}.bin`);

    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, ctx.params, proc, current, { moduleInstances });
    // No-silent-drop: a changed segment with no LSM in the load procedure cannot be programmed.
    if (unplaceable.length) {
      throw new ApiError("FLASH_SEGMENT_UNPLACEABLE", `${unplaceable.length} changed parameter segment(s) are not declared in the device's load procedure; refusing to flash to avoid a silent partial write`);
    }
    if (changedBytes === 0) return { mask, imageBytes: totalBytes, diffBytes: 0, changed: false, flashed: false, backup };
    if (ctx.dryRun) return { mask, imageBytes: totalBytes, diffBytes: changedBytes, changed: true, flashed: false, backup };

    let wrote = 0;
    await runLoadPlan(dev, plan, { onStep: (_i, step) => { if (step.op === "writeMem") ctx.onProgress?.("write", (wrote += step.bytes.length), changedBytes); } });

    await sleep(3000);
    await dev.connect();
    let verified = true;
    for (const t of targets) {
      const back = await dev.memRead(t.address, t.size, 12, (d, n) => ctx.onProgress?.("verify", d, n));
      // Verify only user-facing owned bytes (t.verify). Access="None" device-internal markers
      // are written but excluded: the device re-stamps them on download (e.g. M-008E AS-4B00[0:2]),
      // so checking them would fail every successful flash. Same authority boundary as unowned bytes.
      for (let i = 0; i < t.size; i++) if (t.verify[i] && back[i] !== t.bytes[i]) { verified = false; break; }
    }
    return { mask, imageBytes: totalBytes, diffBytes: changedBytes, changed: true, flashed: true, verified, backup };
  }

  async flashGroupTables(dev: KnxDevice, mask: string, ctx: GaFlashCtx): Promise<FlashResult> {
    // buildGroupTablesMv0705 / flashGroupTablesMv0705, hardware-verified on TP (M-0081):
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
      throw new ApiError("GA_TABLE_TOO_LARGE",
        `the group tables would need address ${addr.length} B / association ${assoc.length} B, but this device reserves only ${maxAddr} B / ${maxAssoc} B${cap?.addressMaxEntries !== undefined ? ` (${cap.addressMaxEntries} group addresses)` : ""}. Remove links or assign fewer group addresses.`);
    }
    const backupDir = join(ctx.dataDir, "projects", ctx.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = Date.now();
    const backup = join(backupDir, `${ctx.deviceId}-GA-${stamp}`);
    writeFileSync(`${backup}-addr.bin`, cur.addr);
    writeFileSync(`${backup}-assoc.bin`, cur.assoc);

    const diffBytes = byteDiff(addr, cur.addr) + byteDiff(assoc, cur.assoc);
    const imageBytes = addr.length + assoc.length;
    if (addr.equals(cur.addr) && assoc.equals(cur.assoc)) return { mask, imageBytes, diffBytes: 0, changed: false, flashed: false, backup };
    if (ctx.dryRun) return { mask, imageBytes, diffBytes, changed: true, flashed: false, backup };

    ctx.onProgress?.("write");
    await flashGroupTablesMv0705(dev, { addr, assoc });
    await sleep(3000);
    await dev.connect();
    ctx.onProgress?.("verify");
    const back = await readGroupTablesMv0705(dev);
    const verified = back.addr.equals(addr) && back.assoc.equals(assoc);
    return { mask, imageBytes, diffBytes, changed: true, flashed: true, verified, backup };
  }
}

// Every recognised-but-not-implemented memory model: System 1 (BCU1), System 2 (BCU2),
// System 300, couplers, interfaces, IR decoders, media couplers, RF-only, unknown masks.
// Capabilities are all false and every operation throws, so such a device is reported as
// honestly unsupported instead of being misrouted into a path that would fabricate a result.
// (This is what fixes MV-0012: it has an AbsoluteSegment and used to be misread as System 7.)
export class UnsupportedProfile extends DeviceProfile {
  constructor(readonly memoryModel: MemoryModel, readonly family: SystemFamily, mask: string, cfg: AppConfig | null) { super(mask, cfg); }
  capabilities(): DeviceCapabilities { return { readParams: false, readLinks: false, flashParams: false, flashLinks: false }; }
  async readState(): Promise<DeviceReadback> { throw new UnsupportedOperation("read-back", this.family, this.mask); }
  async flashParameters(): Promise<FlashResult> { throw new UnsupportedOperation("parameter flash", this.family, this.mask); }
  async flashGroupTables(): Promise<FlashResult> { throw new UnsupportedOperation("group-address flash", this.family, this.mask); }
}

function profileFor(mask: string, cfg: AppConfig | null): DeviceProfile {
  const info = maskInfo(mask);
  switch (info.memoryModel) {
    case "relative": return new SystemBProfile(info.family, mask, cfg);
    case "absolute": return new System7Profile(info.family, mask, cfg);
    default: return new UnsupportedProfile(info.memoryModel, info.family, mask, cfg);
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

// ─────────────────────────────────────────────────────────────────────────────
// Public orchestrators. Each resolves the device profile, then runs the model-specific body
// inside the shared connect/mask-check/disconnect session. Read-only on the bus for reads;
// always backs up before any write (inside the profile body).
// ─────────────────────────────────────────────────────────────────────────────

// Program a device's parameter segment from its stored configuration.
export function flashDeviceParameters(opts: ParamFlashCtx & { ia: string; connection: Connection }): Promise<FlashResult> {
  const profile = classify(parseAppConfig(opts.appXml));
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.flashParameters(dev, mask, opts));
}

// Program a device's group-address tables (address + association) from its com-object links.
export function flashDeviceGroupAddresses(opts: GaFlashCtx & { expectedMask: string; connection: Connection }): Promise<FlashResult> {
  const profile = classifyByMask(opts.expectedMask);
  return withDeviceSession(opts.connection, opts.ia, opts.expectedMask, opts.onProgress, (dev, mask) => profile.flashGroupTables(dev, mask, opts));
}

// Read a device's current state back off the bus into a programmed baseline (drift detection).
// Read-only: nothing is written to the device.
export function readDeviceState(opts: ReadStateCtx & { ia: string; appXml: string; connection: Connection }): Promise<DeviceReadback> {
  const profile = classify(parseAppConfig(opts.appXml));
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.readState(dev, mask, opts));
}
