import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KnxIpTunnel, KnxDevice, flashParameters, appId } from "@busforge/knx";
import { parseApplication, buildParameterImage } from "@busforge/product";
import { readAppProgram } from "@busforge/project";

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
