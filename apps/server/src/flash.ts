import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KnxIpTunnel, KnxDevice, flashParameters, flashGroupTables, appId } from "@busforge/knx";
import { parseApplication, buildParameterImage, buildGroupTables, decodeParameterImage, decodeGroupTables, unmappedParamRefs, type ComObjectLink } from "@busforge/product";
import { readAppProgram } from "@busforge/project";
import { ApiError } from "./errors.ts";
import type { ProgressFn } from "./taskqueue.ts";

const byteDiff = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d;
};

// Read a device's group tables (address, association, com-object), detecting the
// long vs short association format. `skipComObj` omits the com-object table (the
// largest, often dozens of objects): the read-back path only needs address +
// association to reverse the links, while flashing reads it to write it back
// unchanged. Skipping it removes many bus round-trips.
async function readGroupTables(dev: KnxDevice, onStep?: (done: number, total: number) => void, skipComObj = false): Promise<{ addr: Buffer; assoc: Buffer; comObj: Buffer; long: boolean }> {
  const counted = async (obj: number, width: number) => {
    const base = await dev.tableAddr(obj);
    const h = await dev.memRead(base, 2);
    return dev.memRead(base, 2 + (((h[0] << 8) | h[1]) * width));
  };
  const total = skipComObj ? 2 : 3;
  const addr = await counted(1, 2);
  onStep?.(1, total); // address table read
  const gcount = (addr[0] << 8) | addr[1];
  const a2 = await dev.tableAddr(2);
  const ah = await dev.memRead(a2, 2);
  const acount = (ah[0] << 8) | ah[1];
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
  appRef: string;
  sourceFile: string;
  interfaceIp: string;
  port: number;
  params: Map<string, string>;
  dataDir: string;
  dryRun: boolean;
  onProgress?: ProgressFn;
}): Promise<FlashResult> {
  const xml = readAppProgram(readFileSync(opts.sourceFile), opts.appRef);
  if (!xml) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project");
  const model = parseApplication(xml);
  // SAFETY: the image builder reads only static parameter refs; it does not yet
  // expand channel/module instances. Any stored value keyed to an instance
  // (…_MI-…) has no matching ref, so it would be silently dropped and that
  // channel written back at its manufacturer default. Refuse rather than wipe a
  // configured channel device. (Removed once the image path expands modules.)
  const unmapped = unmappedParamRefs(model, opts.params);
  if (unmapped.length) {
    throw new ApiError(
      "CHANNEL_MODULES_UNSUPPORTED",
      `parameter programming does not support this device's channel modules yet: ` +
      `${unmapped.length} stored value(s) would be dropped and those channels reset to defaults ` +
      `(e.g. ${unmapped[0]}). Refusing to flash to protect the device configuration.`,
    );
  }
  const image = buildParameterImage(model, LSM, opts.params);
  if (image.length === 0) throw new ApiError("EMPTY_IMAGE", "built an empty parameter image; refusing to flash");

  const tun = new KnxIpTunnel(opts.interfaceIp, opts.port);
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
    const current = await dev.memRead(addr, image.length, 12, (d, t) => opts.onProgress?.("backup", d, t));

    // Backup the current segment before touching anything.
    const backupDir = join(opts.dataDir, "projects", opts.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, `${opts.deviceId}-LSM${LSM}-${Date.now()}.bin`);
    writeFileSync(backup, current);

    let diffBytes = 0;
    for (let i = 0; i < image.length; i++) if (image[i] !== current[i]) diffBytes++;

    if (diffBytes === 0) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes: image.length, diffBytes, changed: false, flashed: false, backup };
    }
    if (opts.dryRun) {
      await dev.disconnect(); await tun.disconnect();
      return { mask, imageBytes: image.length, diffBytes, changed: true, flashed: false, backup };
    }

    await flashParameters(dev, image, appId(model.manufacturer, model.appNumber, model.version), (d, t) => opts.onProgress?.("write", d, t));

    // The device restarts after load-completed; reconnect and read the segment
    // back to confirm it matches the intended image.
    await sleep(3000);
    await dev.connect();
    const back = await dev.memRead(await dev.tableAddr(LSM), image.length, 12, (d, t) => opts.onProgress?.("verify", d, t));
    const verified = back.equals(image);

    await dev.disconnect(); await tun.disconnect();
    return { mask, imageBytes: image.length, diffBytes, changed: true, flashed: true, verified, backup };
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
  interfaceIp: string;
  port: number;
  dataDir: string;
  dryRun: boolean;
  onProgress?: ProgressFn;
}): Promise<FlashResult> {
  const { addr, assoc } = buildGroupTables(opts.links);

  const tun = new KnxIpTunnel(opts.interfaceIp, opts.port);
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
    const cur = await readGroupTables(dev);
    const backupDir = join(opts.dataDir, "projects", opts.projectId, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = Date.now();
    const backup = join(backupDir, `${opts.deviceId}-GA-${stamp}`);
    writeFileSync(`${backup}-addr.bin`, cur.addr);
    writeFileSync(`${backup}-assoc.bin`, cur.assoc);
    writeFileSync(`${backup}-comobj.bin`, cur.comObj);

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
  appRef: string;
  sourceFile: string;
  interfaceIp: string;
  port: number;
  liveParams: Map<string, string>;
  // The parameter refs that are actually part of this device's configuration (the
  // config view's keys). Drift is only recorded for these, so module devices,
  // whose real params are instance-expanded and not in the flat model, don't
  // produce phantom changes from flat refs the UI never shows.
  relevantRefs?: Set<string>;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}): Promise<DeviceReadback> {
  const xml = readAppProgram(readFileSync(opts.sourceFile), opts.appRef);
  if (!xml) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project");
  const model = parseApplication(xml);

  const tun = new KnxIpTunnel(opts.interfaceIp, opts.port);
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
      const projectVals = decodeParameterImage(model, LSM, buildParameterImage(model, LSM, opts.liveParams));
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
