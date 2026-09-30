import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnxDevice, SecureSession, iaToNum, assignIndividualAddress, readProgModeDevices, activateSecureDevice, readSecurityMode, type SecurityModeReading, type AssignIaResult, type ActivationResult } from "@busforge/knx";
import {
  classify, parseAppConfig, sameMask,
  type FlashResult, type DeviceReadback, type ParamFlashCtx, type GaFlashCtx, type FullDownloadCtx, type ReadStateCtx,
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
  type FlashResult, type DeviceReadback, type DeviceCapabilities, type ParamFlashCtx, type GaFlashCtx, type FullDownloadCtx, type ReadStateCtx,
} from "@busforge/product";

// Credentials for a KNX Data Secure session: the device\'s tool key + serial, from
// the key store. When supplied, the whole session (connect/Sync/read/flash) speaks
// Data Secure transparently. onPeerSequence receives the last sequence the device was seen to send
// in the session, whatever its outcome.
export interface SecureCreds { toolKey: Buffer; serial: Buffer; onPeerSequence?: (sequence: bigint) => void; }

// Hand a finished session's peer sequence to its owner, also after a refusal: it was authenticated
// under the device's own key, so it is that device's counter. The operation's own outcome stands.
function reportPeerSequence(session: SecureSession | undefined, onPeerSequence: ((sequence: bigint) => void) | undefined): void {
  const seq = session?.peerSequence;
  if (seq == null || !onPeerSequence) return;
  try { onPeerSequence(seq); }
  catch (e) { console.error(`[secure] could not record the device's sequence ${seq}:`, e); }
}

// The mask gate. A device in Data Secure mode answers a plain descriptor read with 0xFFFF, so that
// answer in a session without a tool key means the key is missing, not that the device is wrong.
export function maskGate(mask: string, wantMask: string, secured: boolean): ApiError | null {
  if (!sameMask(wantMask, wantMask)) return new ApiError("MASK_UNKNOWN", "application mask unknown; refusing");
  if (!secured && mask === "MV-FFFF") {
    return new ApiError("SECURE_KEY_MISSING", "a KNX Data Secure device answers at this address (descriptor 0xFFFF to a plain request), and the project holds no tool key for it: either the project was imported without its keys, or this is not the expected device", 400);
  }
  if (!sameMask(mask, wantMask)) return new ApiError("MASK_MISMATCH", `device mask ${mask} != expected ${wantMask}; aborting (wrong device or application)`);
  return null;
}

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
      const refused = maskGate(mask, wantMask, secure !== undefined);
      if (refused) throw refused;
    }
    const result = await body(dev, mask);
    await dev.disconnect(); await tun.disconnect();
    return result;
  } catch (e) {
    try { await dev.disconnect(); } catch { /* teardown: the device link may already be gone */ }
    try { await tun.disconnect(); } catch { /* teardown: the transport may already be gone */ }
    throw e;
  } finally {
    reportPeerSequence(session, secure?.onPeerSequence);
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

// A Data Secure device keeps its group keys and per-object security flags in its security
// interface object (type 17). Where the device's memory model does not load that object with the
// group tables (profile.loadsSecurityObject), rewriting its tables or commissioning it would leave
// its keys behind, so those writes refuse it.
export function secureTablesUnsupported(): ApiError {
  return new ApiError("SECURE_TABLES_UNSUPPORTED", "this device runs KNX Data Secure; writing its group tables or commissioning it also needs its security object loaded (group keys, security flags), which busforge does not do for this device family", 400);
}

// Program a device\'s parameter segment from its stored configuration.
export function flashDeviceParameters(opts: Omit<ParamFlashCtx, "persistBackups"> & ServerScope): Promise<FlashResult> {
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: ParamFlashCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.flashParameters(dev, mask, ctx), opts.secure);
}

// A secured session that rewrites a device's group tables must load its security object with
// them; credentials without the group keys would leave the old keys and flags behind the new tables.
function refuseSessionWithoutSecurityObject(opts: { secure?: SecureCreds; security?: unknown }): Promise<never> | null {
  return opts.secure && !opts.security
    ? Promise.reject(new ApiError("SECURE_TABLES_UNSUPPORTED", "a secured write of the group tables was asked for without the group keys its security object is loaded with", 400))
    : null;
}

// Program a device\'s group-address tables (address + association) from its com-object
// links. Classify from the parsed application (not the mask alone) so the profile carries
// the app\'s declared table capacity (<AddressTable>/<AssociationTable> MaxEntries); the
// GA-flash growth guard depends on it. Without the cfg it would fall back to "no growth
// beyond the current table" and refuse every legitimate add.
export function flashDeviceGroupAddresses(opts: Omit<GaFlashCtx, "persistBackups"> & ServerScope & { appXml: string }): Promise<FlashResult> {
  const refused = refuseSessionWithoutSecurityObject(opts);
  if (refused) return refused;
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: GaFlashCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.flashGroupTables(dev, mask, ctx), opts.secure);
}

// Commission a device from nothing: application id, parameter image, com-object table and group
// tables in one bracket. Unlike a parameter download this AUTHORS the com-object table, because a
// virgin device has none to keep. Hardware-verified only where docs/commissioning.md says so.
export function downloadDeviceFull(opts: Omit<FullDownloadCtx, "persistBackups"> & ServerScope): Promise<FlashResult> {
  const refused = refuseSessionWithoutSecurityObject(opts);
  if (refused) return refused;
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: FullDownloadCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.downloadFull(dev, mask, ctx), opts.secure);
}

// Read a device\'s current state back off the bus into a programmed baseline (drift
// detection). Read-only: nothing is written to the device.
export function readDeviceState(opts: ReadStateCtx & { ia: string; appXml: string; connection: Connection; secure?: SecureCreds }): Promise<DeviceReadback> {
  const profile = classify(parseAppConfig(opts.appXml));
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.readState(dev, mask, opts), opts.secure);
}

// Identify a device and read its security mode: its device descriptor, serial and the security
// object's own statement (readSecurityMode). With the device's tool key the session is secured, which
// is what makes a secure device (opaque MV-FFFF to plain reads) recognisable; without one it is plain.
// A secure Sync that gets no answer is checked plainly: a device that states its security mode is off
// is not activated (factory state), which is refused as such instead of as a possibly wrong key.
// Read-only; no mask gate (identification is what learns the mask). See docs/knx-secure.md.
export async function secureIdentify(
  connection: Connection, ia: string, secure: SecureCreds | undefined, onProgress?: ProgressFn,
): Promise<DeviceIdentity> {
  const identify = (creds?: SecureCreds) => withDeviceSession(connection, ia, null, onProgress, async (dev, mask) => {
    // Device object (0), serial-number property (PID 11). A device in secure mode answers a plain
    // read with no element (the Jung 400021SE): no serial then, never an empty one.
    const sn = await dev.propRead(0, 11);
    const securityMode = await readSecurityMode(dev);
    return { secure: creds !== undefined, mask, serial: sn.length > 0 ? sn.toString("hex") : null, securityMode };
  }, creds);
  if (!secure) return identify();
  try {
    return await identify(secure);
  } catch (e) {
    if ((e as { code?: string }).code !== "SECURE_SYNC_NO_RESPONSE") throw e;
    const plain = await identify().catch(() => null);
    if (plain?.securityMode.state === "off") {
      throw new ApiError("SECURE_MODE_OFF", "the device did not answer the secure session request, and read without a key it states its security mode is off: it is not activated (factory state, for example after a master reset); activate it from its device certificate", 400);
    }
    throw e;
  }
}
export interface DeviceIdentity { secure: boolean; mask: string; serial: string | null; securityMode: SecurityModeReading }
// Take a secure device from its factory key to a tool key of busforge's (activateSecureDevice in
// @busforge/knx): every session is opened on its own link, under the key being tried. The new key
// reaches `persistKey` before it is written to the device.
export async function activateDevice(
  connection: Connection, ia: string, cert: { fdsk: Buffer; serial: Buffer }, storedKey: Buffer | undefined,
  persistKey: (key: Buffer) => void, onProgress?: ProgressFn, onPeerSequence?: (sequence: bigint) => void,
): Promise<Omit<ActivationResult, "toolKey">> {
  const links = new Map<KnxDevice, { tun: { disconnect(): Promise<void> }; session: SecureSession }>();
  onProgress?.("activate");
  const r = await activateSecureDevice({
    async open(key, serial) {
      const tun = makeTransport(connection);
      await tun.connect();
      const session = new SecureSession({ toolKey: key, src: tun.assignedIa, dst: iaToNum(ia), serial });
      const dev = new KnxDevice(tun, ia, session);
      // A Sync that gets no answer still leaves the device's transport connection open, and a device
      // in factory state then takes the next Sync on a new connection without answering it (the
      // Jung 400021SE, 2026-09-29): close it with a T_Disconnect before the next key is tried.
      try { await dev.connect(); }
      catch (e) {
        try { await dev.disconnect(); } catch { /* the link may already be gone */ }
        try { await tun.disconnect(); } catch { /* the link may already be gone */ }
        throw e;
      }
      links.set(dev, { tun, session });
      return dev;
    },
    async close(dev) {
      const link = links.get(dev);
      try { await dev.disconnect(); } catch { /* the link may already be gone */ }
      try { await link?.tun.disconnect(); } catch { /* the transport may already be gone */ }
      links.delete(dev);
      // Whatever key a session ran under, the device answered from its one sending counter.
      reportPeerSequence(link?.session, onPeerSequence);
    },
  }, { fdsk: cert.fdsk, serial: cert.serial, storedKey, persistKey });
  return { outcome: r.outcome };
}

// Give a device its physical address. Unlike every other operation here this one CANNOT use
// withDeviceSession: the device is reached by broadcast, precisely because it may not have a
// usable address yet, so there is no address to open a session to and no mask gate to pass.
// It therefore drives the raw transport. All the safety lives in assignIndividualAddress
// (@busforge/knx): exactly one device in programming mode, the target address must be free,
// and the result is proven by talking to the device on its new address. Hardware-verified on a
// virgin device through this endpoint (docs/status.md).
export async function assignDeviceAddress(
  connection: Connection, ia: string, onProgress?: ProgressFn,
): Promise<AssignIaResult> {
  const tun = makeTransport(connection);
  onProgress?.("connect");
  await tun.connect();
  try {
    return await assignIndividualAddress(tun, ia, { onProgress: (phase) => onProgress?.(phase) });
  } finally {
    await tun.disconnect();
  }
}

// Who is currently in programming mode? Read-only broadcast probe; drives the UI that tells
// the user whether they pressed the right button (and, crucially, only one of them).
export async function readDevicesInProgMode(connection: Connection): Promise<string[]> {
  const tun = makeTransport(connection);
  await tun.connect();
  try {
    return await readProgModeDevices(tun);
  } finally {
    await tun.disconnect();
  }
}
