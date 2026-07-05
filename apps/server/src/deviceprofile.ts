import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnxDevice, SecureSession, iaToNum } from "@busforge/knx";
import {
  classify, parseAppConfig, sameMask,
  type FlashResult, type DeviceReadback, type ParamFlashCtx, type GaFlashCtx, type ReadStateCtx,
  type PersistBackups, type ProgressFn,
} from "@busforge/product";
import { makeTransport } from "./transport.ts";
import type { Connection } from "./db/connections.ts";
import { ApiError } from "./errors.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Server-side glue around the device domain. The profiles themselves (strategy per
// memory model, flash/read bodies, capabilities) live in @busforge/product
// (profiles.ts) and are pure: they receive an already-connected KnxDevice plus
// injected hooks. This module owns only what is genuinely the server\'s:
//   - the transport/session envelope (withDeviceSession: connect, mask gate, teardown)
//   - backup persistence on disk (the product layer only hands over bytes)
//   - the public orchestrators the routes call.
// ─────────────────────────────────────────────────────────────────────────────

// Re-exported for the routes/tests; their home is the product layer.
export {
  classify, classifyByMask, DeviceProfile, SystemBProfile, System7Profile, UnsupportedProfile,
  reconnectAfterRestart, verifySettled,
  type FlashResult, type DeviceReadback, type DeviceCapabilities, type ParamFlashCtx, type GaFlashCtx, type ReadStateCtx,
} from "@busforge/product";

// Credentials for a KNX Data Secure session: the device\'s tool key + serial, from
// the key store. When supplied, the whole session (connect/Sync/read/flash) speaks
// Data Secure transparently.
export interface SecureCreds { toolKey: Buffer; serial: Buffer; }

// Open a connection-oriented link to the device, verify it is the device/application we
// expect, run the model-specific body, and always tear the link down. The mask check is
// the primary safety gate (wrong device or wrong application aborts before any read or
// write); wantMask null = identification session (reading the mask is the goal).
async function withDeviceSession<T>(
  connection: Connection,
  ia: string,
  wantMask: string | null,
  onProgress: ProgressFn | undefined,
  body: (dev: KnxDevice, mask: string) => Promise<T>,
  secure?: SecureCreds,
): Promise<T> {
  const tun = makeTransport(connection);
  onProgress?.("connect");
  await tun.connect();
  const session = secure ? new SecureSession({ toolKey: secure.toolKey, src: tun.assignedIa, dst: iaToNum(ia), serial: secure.serial }) : undefined;
  const dev = new KnxDevice(tun, ia, session);
  try {
    await dev.connect();
    const mask = await dev.deviceDescriptor();
    if (wantMask !== null) {
      // Canonical equality (sameMask), never a substring match: gate logic on the
      // primary wrong-device safety check must not pass on a coincidental substring.
      // sameMask(x, x) is false only for an unparseable mask, i.e. "we don\'t know what
      // application this is" -> refuse before comparing anything.
      if (!sameMask(wantMask, wantMask)) throw new ApiError("MASK_UNKNOWN", "application mask unknown; refusing");
      if (!sameMask(mask, wantMask)) throw new ApiError("MASK_MISMATCH", `device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);
    }
    const result = await body(dev, mask);
    await dev.disconnect(); await tun.disconnect();
    return result;
  } catch (e) {
    try { await dev.disconnect(); } catch {}
    try { await tun.disconnect(); } catch {}
    throw e;
  }
}

// Persist pre-flash device-state backups under the project\'s backup directory. Injected
// into the product profiles (runFlashOp calls it BEFORE any write reaches the device).
function backupPersister(dataDir: string, projectId: string): PersistBackups {
  return (files, representative) => {
    const dir = join(dataDir, "projects", projectId, "backups");
    mkdirSync(dir, { recursive: true });
    for (const b of files) writeFileSync(join(dir, b.file), b.bytes);
    return join(dir, representative);
  };
}

// The server-facing operation inputs: the product ctx minus the injected hook, plus the
// persistence/transport scope (project dir, connection, secure credentials).
type ServerScope = { projectId: string; dataDir: string; ia: string; connection: Connection; secure?: SecureCreds };

// Program a device\'s parameter segment from its stored configuration.
export function flashDeviceParameters(opts: Omit<ParamFlashCtx, "persistBackups"> & ServerScope): Promise<FlashResult> {
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: ParamFlashCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.flashParameters(dev, mask, ctx), opts.secure);
}

// Program a device\'s group-address tables (address + association) from its com-object
// links. Classify from the parsed application (not the mask alone) so the profile carries
// the app\'s declared table capacity (<AddressTable>/<AssociationTable> MaxEntries); the
// GA-flash growth guard depends on it. Without the cfg it would fall back to "no growth
// beyond the current table" and refuse every legitimate add.
export function flashDeviceGroupAddresses(opts: Omit<GaFlashCtx, "persistBackups"> & ServerScope & { appXml: string }): Promise<FlashResult> {
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: GaFlashCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.flashGroupTables(dev, mask, ctx), opts.secure);
}

// Read a device\'s current state back off the bus into a programmed baseline (drift
// detection). Read-only: nothing is written to the device.
export function readDeviceState(opts: ReadStateCtx & { ia: string; appXml: string; connection: Connection; secure?: SecureCreds }): Promise<DeviceReadback> {
  const profile = classify(parseAppConfig(opts.appXml));
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.readState(dev, mask, opts), opts.secure);
}

// Securely identify a KNX Data Secure device: open the secure session (T_Connect + Sync)
// with the device\'s tool key and read its real device descriptor and serial. This is
// what makes a secure device (opaque MV-FFFF to plain reads) recognisable. Read-only; no
// mask gate (identification is what learns the mask). Hardware-verified on an MDT IP
// interface. See docs/knx-secure-design.md.
export function secureIdentify(
  connection: Connection, ia: string, toolKey: Buffer, serial: Buffer,
  onProgress?: ProgressFn,
): Promise<{ mask: string; serial: string }> {
  return withDeviceSession(connection, ia, null, onProgress, async (dev, mask) => {
    const sn = await dev.propRead(0, 11); // device object (0), serial-number property (PID 11)
    return { mask, serial: sn.toString("hex") };
  }, { toolKey, serial });
}
