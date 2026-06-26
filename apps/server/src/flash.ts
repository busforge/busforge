import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnxDevice, flashParameters, flashGroupTables, appId, runLoadPlan } from "@busforge/knx";
import { makeTransport } from "./transport.ts";
import type { Connection } from "./db/connections.ts";
import { toAppModel, buildParameterImage, buildRelativeSegmentTarget, mergeRelativeTarget, verifyRelativeOwned, buildDeviceConfig, buildGroupTables, decodeParameterImage, decodeGroupTables, unmappedParamRefs, resolveModuleInstances, parseAppConfig, parseLoadProcedures, buildAbsoluteSegmentTargets, planAbsoluteParFlash, type AppConfig, type AppModel, type ModuleInstance, type ComObjectLink } from "@busforge/product";
import { ApiError } from "./errors.ts";
import type { ProgressFn } from "./taskqueue.ts";

const byteDiff = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d;
};

// Resolve a device's module instances and build a module-aware image model plus the
// values to write. Instances come from the imported project (0.xml) when present, else
// the allocators are re-run for a from-scratch device (resolveModuleInstances) so its
// per-instance memory offsets match what ETS would compute. Module parameters are then
// placed at those offsets; the values written are the VISIBILITY-RESOLVED active set
// (an inactive branch's param stays at the segment default, as ETS leaves it), while
// top-level parameters keep the stored values so the proven non-module relative path
// stays byte-for-byte unchanged. A non-module device gets the unchanged flat model.
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

// Read a device's group tables (address, association, com-object), detecting the
// long vs short association format. `skipComObj` omits the com-object table (the
// largest, often dozens of objects): the read-back path only needs address +
// association to reverse the links, while flashing reads it to write it back
// unchanged. Skipping it removes many bus round-trips.
// A group/association table starts with a 2-byte entry count followed by the entries. The
// count is device-supplied, so it must be bounded before reading `count * width` bytes: if
// the device does not store its tables in this System B format (e.g. an MV-0705 absolute
// device, whose table pointer lands in parameter memory), those 2 bytes are not a count and
// decode to thousands of entries, which would otherwise read tens of KB one 12-byte chunk at
// a time over the bus and manifest as a multi-minute hang. No real TP device has this many.
const MAX_TABLE_ENTRIES = 2048;
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
  onStep?.(1, total); // address table read
  const gcount = (addr[0] << 8) | addr[1];
  const a2 = await dev.tableAddr(2);
  const ah = await dev.memRead(a2, 2);
  const acount = boundCount((ah[0] << 8) | ah[1], "association table");
  let assoc = await dev.memRead(a2, 2 + acount * 4);
  let long = true;
  for (let k = 0; k < acount; k++) { const gi = (assoc[2 + k * 4] << 8) | assoc[3 + k * 4]; if (gi < 1 || gi > gcount) { long = false; break; } }
  if (!long) assoc = await dev.memRead(a2, 2 + acount * 2);
  onStep?.(2, total); // association table read
  const comObj = skipComObj ? Buffer.alloc(0) : await counted(3, 2);
  if (!skipComObj) onStep?.(3, total); // com-object table read
  return { addr, assoc, comObj, long };
}

// Program a device's parameter segment (LSM 4) from its stored configuration.
// Read-only on the addressing/group tables: only the application parameters are
// written. Always backs up the current segment first, verifies the device is the
// expected one before writing, and reads the segment back to confirm the result.
//
// SAFETY: a parameter download unloads LSM 4 before rewriting. A failure between
// unload and load-completed leaves the device addressable but unloaded; it is
// recoverable by re-flashing (the backup holds the previous bytes).

const LSM = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FlashResult {
  mask: string;
  imageBytes: number;
  diffBytes: number;
  changed: boolean;
  flashed: boolean;
  verified?: boolean;
  backup: string;
}

export async function flashDeviceParameters(opts: {
  projectId: string;
  deviceId: string;
  ia: string;
  appXml: string;
  connection: Connection;
  params: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  dataDir: string;
  dryRun: boolean;
  onProgress?: ProgressFn;
}): Promise<FlashResult> {
  // Absolute-segment (MV-0705) devices keep parameters at fixed EEPROM addresses and
  // are flashed by driving their declared LoadProcedure, not the LSM4 relative path.
  const cfg = parseAppConfig(opts.appXml);
  if (buildAbsoluteSegmentTargets(cfg, opts.params).some((t) => t.size > 0)) {
    return flashAbsoluteParameters(opts, cfg);
  }

  // moduleAwareImage's model is still used for the mask/app id and the unmapped-ref
  // safety refusal (a stored value the image model cannot place would be reset).
  const { model } = moduleAwareImage(cfg, opts.params, opts.moduleInstances ?? []);
  // SAFETY: any stored value whose ref the image model still cannot place (e.g. a
  // not-yet-supported nested-module case) would be silently dropped and that region
  // written back at its default. Refuse rather than wipe a configured channel.
  const unmapped = unmappedParamRefs(model, opts.params);
  if (unmapped.length) {
    throw new ApiError(
      "CHANNEL_MODULES_UNSUPPORTED",
      `parameter programming cannot place ${unmapped.length} stored value(s) for this device ` +
      `(e.g. ${unmapped[0]}); they would be dropped and that region reset to defaults. ` +
      `Refusing to flash to protect the device configuration.`,
    );
  }
  // Surgical RelativeSegment (System B) flash: the owned-byte target says which bytes we
  // may write and their values. We then write ONLY owned bytes over the device's current
  // memory, preserving everything ETS computes that we cannot reproduce (the Theben
  // "Objektlink" union tables, patch-always markers, defaults we already match). See
  // buildRelativeSegmentTarget.
  const target = buildRelativeSegmentTarget(cfg, opts.params, LSM, { moduleInstances: opts.moduleInstances });
  if (!target || target.size === 0) throw new ApiError("EMPTY_IMAGE", "built an empty parameter image; refusing to flash");

  const tun = makeTransport(opts.connection);
  opts.onProgress?.("connect");
  await tun.connect();
  const dev = new KnxDevice(tun, opts.ia);
  try {
    await dev.connect();

    // Safety: confirm we are talking to the expected device/application.
    const mask = await dev.deviceDescriptor();
    const wantMask = model.mask.replace(/^MV-/, "");
    if (!wantMask) throw new ApiError("MASK_UNKNOWN", "application mask unknown; refusing to flash");
    if (!mask.includes(wantMask)) throw new ApiError("MASK_MISMATCH", `device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);

    const addr = await dev.tableAddr(LSM);
    const current = await dev.memRead(addr, target.size, 12, (d, t) => opts.onProgress?.("backup", d, t));

    // Backup the current segment before touching anything.
    const backupDir = join(opts.dataDir, "projects", opts.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${opts.deviceId}-LSM${LSM}-${Date.now()}.bin`);
    writeFileSync(backup, current);

    // The image to write = the device's current segment with ONLY owned bytes overlaid.
    // A System B download rewrites the whole segment after realloc, so we must supply
    // every byte; sourcing the unowned ones from the live read preserves them across the
    // unload/load (rather than the seg.data zero/default approximation a full build uses).
    const { image, diffBytes } = mergeRelativeTarget(current, target);

    if (diffBytes === 0) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes: image.length, diffBytes, changed: false, flashed: false, backup };
    }
    if (opts.dryRun) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes: image.length, diffBytes, changed: true, flashed: false, backup };
    }

    await flashParameters(dev, image, appId(model.manufacturer, model.appNumber, model.version), (d, t) => opts.onProgress?.("write", d, t));

    // The device restarts after load-completed; reconnect and read the segment back. Verify
    // ONLY the owned bytes: a System B reload can recompute unowned regions (the channel
    // "Objektlink" tables), so full-buffer equality would flag a correct flash as failed.
    await sleep(3000);
    await dev.connect();
    const back = await dev.memRead(await dev.tableAddr(LSM), image.length, 12, (d, t) => opts.onProgress?.("verify", d, t));
    const verified = verifyRelativeOwned(back, target);

    await dev.disconnect(); await tun.disconnect();
    return { mask, imageBytes: image.length, diffBytes, changed: true, flashed: true, verified, backup };
  } catch (e) {
    try { await dev.disconnect(); } catch {}
    try { await tun.disconnect(); } catch {}
    throw e;
  }
}

// Program an absolute-segment (MV-0705) device's parameters by driving its own
// declared LoadProcedure (parsed from the app program). Surgical "par" download: only
// owned bytes that differ from the live device are written, inside the device's LSM
// load bracket (Load -> write -> LoadCompleted -> Restart). Same safety contract as the
// relative path: mask check, segment backup, dry-run, post-flash read-back verify.
//
// Hardware-verified on M-0081 (LED feedback change applied + reverted, LSM3 LOADED).
async function flashAbsoluteParameters(opts: Parameters<typeof flashDeviceParameters>[0], cfg: AppConfig): Promise<FlashResult> {
  const proc = parseLoadProcedures(opts.appXml);
  if (proc.style === "DefaultProcedure" || proc.blocks.length === 0) {
    throw new ApiError("LOAD_PROCEDURE_UNSUPPORTED", `device declares no usable load procedure (style ${proc.style}); cannot flash safely`);
  }
  const moduleInstances = opts.moduleInstances;
  const targets = buildAbsoluteSegmentTargets(cfg, opts.params, { moduleInstances }).filter((t) => t.size > 0);
  const totalBytes = targets.reduce((n, t) => n + t.size, 0);

  const tun = makeTransport(opts.connection);
  opts.onProgress?.("connect");
  await tun.connect();
  const dev = new KnxDevice(tun, opts.ia);
  try {
    await dev.connect();
    const mask = await dev.deviceDescriptor();
    const wantMask = cfg.mask.replace(/^MV-/, "");
    if (!wantMask) throw new ApiError("MASK_UNKNOWN", "application mask unknown; refusing to flash");
    if (!mask.includes(wantMask)) throw new ApiError("MASK_MISMATCH", `device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);

    // Read each parameter segment at its fixed address; this is the backup and the
    // diff source (we write only owned bytes that actually differ).
    const current = new Map<string, Buffer>();
    const backupDir = join(opts.dataDir, "projects", opts.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = Date.now();
    let read = 0;
    for (const t of targets) {
      const onDev = await dev.memRead(t.address, t.size, 12, (d, n) => opts.onProgress?.("backup", read + d, totalBytes));
      read += t.size;
      current.set(t.id, onDev);
      writeFileSync(join(backupDir, `${opts.deviceId}-${t.id.split("_").pop()}-${stamp}.bin`), onDev);
    }
    const backup = join(backupDir, `${opts.deviceId}-${targets[0]?.id.split("_").pop() ?? "AS"}-${stamp}.bin`);

    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, opts.params, proc, current, { moduleInstances });
    // No-silent-drop: a changed segment with no LSM in the load procedure cannot be
    // programmed; refuse rather than flash the rest and report success.
    if (unplaceable.length) {
      throw new ApiError("FLASH_SEGMENT_UNPLACEABLE", `${unplaceable.length} changed parameter segment(s) are not declared in the device's load procedure; refusing to flash to avoid a silent partial write`);
    }
    if (changedBytes === 0) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes: totalBytes, diffBytes: 0, changed: false, flashed: false, backup };
    }
    if (opts.dryRun) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes: totalBytes, diffBytes: changedBytes, changed: true, flashed: false, backup };
    }

    let wrote = 0;
    await runLoadPlan(dev, plan, { onStep: (_i, step) => { if (step.op === "writeMem") opts.onProgress?.("write", (wrote += step.bytes.length), changedBytes); } });

    // The device restarts after load-completed; reconnect and confirm each segment's
    // owned bytes now match the target image.
    await sleep(3000);
    await dev.connect();
    let verified = true;
    for (const t of targets) {
      const back = await dev.memRead(t.address, t.size, 12, (d, n) => opts.onProgress?.("verify", d, n));
      for (let i = 0; i < t.size; i++) if (t.owned[i] && back[i] !== t.bytes[i]) { verified = false; break; }
    }
    await dev.disconnect(); await tun.disconnect();
    return { mask, imageBytes: totalBytes, diffBytes: changedBytes, changed: true, flashed: true, verified, backup };
  } catch (e) {
    try { await dev.disconnect(); } catch {}
    try { await tun.disconnect(); } catch {}
    throw e;
  }
}

// Program a device's group-address tables (address + association) from its
// com-object links. The com-object table (flags/size) is read from the device
// and written back unchanged, so only the GA assignments change.
export async function flashDeviceGroupAddresses(opts: {
  projectId: string;
  deviceId: string;
  ia: string;
  expectedMask: string;
  links: ComObjectLink[];
  connection: Connection;
  dataDir: string;
  dryRun: boolean;
  onProgress?: ProgressFn;
}): Promise<FlashResult> {
  const { addr, assoc } = buildGroupTables(opts.links);

  const tun = makeTransport(opts.connection);
  opts.onProgress?.("connect");
  await tun.connect();
  const dev = new KnxDevice(tun, opts.ia);
  try {
    await dev.connect();
    const mask = await dev.deviceDescriptor();
    const wantMask = opts.expectedMask.replace(/^MV-/, "");
    if (!wantMask) throw new ApiError("MASK_UNKNOWN", "application mask unknown; refusing to flash");
    if (!mask.includes(wantMask)) throw new ApiError("MASK_MISMATCH", `device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);

    opts.onProgress?.("read");
    // The dry-run preview compares only the address + association tables. The com-object
    // table is often the largest, and is read here only to write it back unchanged on a real
    // flash, so skip it when previewing: otherwise "checking for changes" is dominated by a
    // long chunked read of a table this path does not use.
    const cur = await readGroupTables(dev, undefined, opts.dryRun);
    const backupDir = join(opts.dataDir, "projects", opts.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = Date.now();
    const backup = join(backupDir, `${opts.deviceId}-GA-${stamp}`);
    writeFileSync(`${backup}-addr.bin`, cur.addr);
    writeFileSync(`${backup}-assoc.bin`, cur.assoc);
    if (!opts.dryRun) writeFileSync(`${backup}-comobj.bin`, cur.comObj);

    const diffBytes = byteDiff(addr, cur.addr) + byteDiff(assoc, cur.assoc);
    const imageBytes = addr.length + assoc.length;

    if (addr.equals(cur.addr) && assoc.equals(cur.assoc)) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes, diffBytes: 0, changed: false, flashed: false, backup };
    }
    if (opts.dryRun) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes, diffBytes, changed: true, flashed: false, backup };
    }

    // Keep the device's com-object table; only address + association change.
    opts.onProgress?.("write");
    await flashGroupTables(dev, { addr, assoc, comObj: cur.comObj });

    await sleep(3000);
    await dev.connect();
    opts.onProgress?.("verify");
    const back = await readGroupTables(dev);
    const verified = back.addr.equals(addr) && back.assoc.equals(assoc);

    await dev.disconnect(); await tun.disconnect();
    return { mask, imageBytes, diffBytes, changed: true, flashed: true, verified, backup };
  } catch (e) {
    try { await dev.disconnect(); } catch {}
    try { await tun.disconnect(); } catch {}
    throw e;
  }
}

// Read a device's current state back off the bus and turn it into a programmed
// baseline: the parameter rows (LSM 4) and com-object -> GA links that, stored as
// the baseline, make any drift from the project config show up as a change.
// Read-only on the bus: nothing is written to the device.
//
// `paramBase` is sparse like device_parameters: it copies the live rows and only
// overrides a parameter where the device's value actually differs from what the
// project would flash. Both sides are normalized through the same build+decode,
// so default-vs-stored representation can't cause phantom diffs. The caller maps
// each link's comObjNum back to its ref id before storing.
export interface DeviceReadback { mask: string; paramBase: Map<string, string>; links: ComObjectLink[]; }

export async function readDeviceState(opts: {
  ia: string;
  appXml: string;
  connection: Connection;
  liveParams: Map<string, string>;
  moduleInstances?: ModuleInstance[];
  // The parameter refs that are actually part of this device's configuration (the
  // config view's keys). Drift is only recorded for these, so module devices,
  // whose real params are instance-expanded and not in the flat model, don't
  // produce phantom changes from flat refs the UI never shows.
  relevantRefs?: Set<string>;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}): Promise<DeviceReadback> {
  // Module-aware image model so a channel device's instance params are decoded from
  // device memory and compared against the project (drift detection covers modules).
  const cfg = parseAppConfig(opts.appXml);
  const { model, writeValues } = moduleAwareImage(cfg, opts.liveParams, opts.moduleInstances ?? []);

  const tun = makeTransport(opts.connection);
  opts.onProgress?.("connect");
  await tun.connect();
  const dev = new KnxDevice(tun, opts.ia);
  try {
    await dev.connect();

    const mask = await dev.deviceDescriptor();
    const wantMask = model.mask.replace(/^MV-/, "");
    if (!wantMask) throw new ApiError("MASK_UNKNOWN", "application mask unknown; refusing to read");
    if (!mask.includes(wantMask)) throw new ApiError("MASK_MISMATCH", `device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);

    // Parameters (LSM 4): read the whole segment, decode it, and compare against
    // what the project config would flash, both normalized via the same codec.
    const paramBase = new Map(opts.liveParams);
    const seg = model.segments.find((s) => s.lsm === LSM);
    if (seg) {
      const img = await dev.memRead(await dev.tableAddr(LSM), seg.size, 12, (d, t) => opts.onProgress?.("params", d, t), opts.signal);
      const deviceVals = decodeParameterImage(model, LSM, img);
      const projectVals = decodeParameterImage(model, LSM, buildParameterImage(model, LSM, writeValues));
      for (const [refId, devVal] of deviceVals) {
        if (opts.relevantRefs && !opts.relevantRefs.has(refId)) continue; // not part of this device's config
        if (projectVals.get(refId) !== devVal) paramBase.set(refId, devVal); // device drifted from project
      }
    }

    // Group-address links: read the address + association tables and reverse them.
    // The com-object table is not needed to decode links, so skip it (much faster).
    if (opts.signal?.aborted) throw new ApiError("READ_ABORTED", "read aborted");
    opts.onProgress?.("links", 0, 2);
    const gt = await readGroupTables(dev, (d, total) => opts.onProgress?.("links", d, total), true);
    const links = decodeGroupTables(gt.addr, gt.assoc, gt.long);

    await dev.disconnect(); await tun.disconnect();
    return { mask, paramBase, links };
  } catch (e) {
    try { await dev.disconnect(); } catch {}
    try { await tun.disconnect(); } catch {}
    throw e;
  }
}
