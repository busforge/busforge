import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KnxIpTunnel, KnxDevice, flashParameters, flashGroupTables, appId } from "@busforge/knx";
import { parseApplication, buildParameterImage, buildGroupTables, type ComObjectLink } from "@busforge/product";
import { readAppProgram } from "@busforge/project";

const byteDiff = (a: Buffer, b: Buffer): number => {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d;
};

// Read a device's group tables (address, association, com-object), detecting the
// long vs short association format.
async function readGroupTables(dev: KnxDevice): Promise<{ addr: Buffer; assoc: Buffer; comObj: Buffer }> {
  const counted = async (obj: number, width: number) => {
    const base = await dev.tableAddr(obj);
    const h = await dev.memRead(base, 2);
    return dev.memRead(base, 2 + (((h[0] << 8) | h[1]) * width));
  };
  const addr = await counted(1, 2);
  const gcount = (addr[0] << 8) | addr[1];
  const a2 = await dev.tableAddr(2);
  const acount = ((await dev.memRead(a2, 2))[0] << 8) | (await dev.memRead(a2, 2))[1];
  let assoc = await dev.memRead(a2, 2 + acount * 4);
  let long = true;
  for (let k = 0; k < acount; k++) { const gi = (assoc[2 + k * 4] << 8) | assoc[3 + k * 4]; if (gi < 1 || gi > gcount) { long = false; break; } }
  if (!long) assoc = await dev.memRead(a2, 2 + acount * 2);
  const comObj = await counted(3, 2);
  return { addr, assoc, comObj };
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
}): Promise<FlashResult> {
  const xml = readAppProgram(readFileSync(opts.sourceFile), opts.appRef);
  if (!xml) throw new Error("application program not found in project");
  const model = parseApplication(xml);
  const image = buildParameterImage(model, LSM, opts.params);
  if (image.length === 0) throw new Error("built an empty parameter image; refusing to flash");

  const tun = new KnxIpTunnel(opts.interfaceIp, opts.port);
  await tun.connect();
  const dev = new KnxDevice(tun, opts.ia);
  try {
    await dev.connect();

    // Safety: confirm we are talking to the expected device/application.
    const mask = await dev.deviceDescriptor();
    const wantMask = model.mask.replace(/^MV-/, "");
    if (!wantMask) throw new Error("application mask unknown; refusing to flash");
    if (!mask.includes(wantMask)) throw new Error(`device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);

    const addr = await dev.tableAddr(LSM);
    const current = await dev.memRead(addr, image.length);

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

    await flashParameters(dev, image, appId(model.manufacturer, model.appNumber, model.version));

    // The device restarts after load-completed; reconnect and read the segment
    // back to confirm it matches the intended image.
    await sleep(3000);
    await dev.connect();
    const back = await dev.memRead(await dev.tableAddr(LSM), image.length);
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
}): Promise<FlashResult> {
  const { addr, assoc } = buildGroupTables(opts.links);

  const tun = new KnxIpTunnel(opts.interfaceIp, opts.port);
  await tun.connect();
  const dev = new KnxDevice(tun, opts.ia);
  try {
    await dev.connect();
    const mask = await dev.deviceDescriptor();
    const wantMask = opts.expectedMask.replace(/^MV-/, "");
    if (!wantMask) throw new Error("application mask unknown; refusing to flash");
    if (!mask.includes(wantMask)) throw new Error(`device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);

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
    await flashGroupTables(dev, { addr, assoc, comObj: cur.comObj });

    await sleep(3000);
    await dev.connect();
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
