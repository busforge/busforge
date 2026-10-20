import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnxDevice, KnxUsbTransport, PID, STATE, lsmState, SecureSession, iaToNum, assignIndividualAddress, readProgModeDevices, activateSecureDevice, readSecurityMode, type SecurityModeReading, type AssignIaResult, type ActivationResult } from "@busforge/knx";
import {
  classify, parseAppConfig, sameMask, planForMask, resolveModuleInstances, type ComObjectLink, type ComObjInstanceOverride, programIdStamp, maskInfo, isMemoryMappedLsm,
  buildDeviceConfig, deviceComObjOverrideRows, placeComObjOverrides, type AppConfig,
  type FlashResult, type DeviceReadback, type ParamFlashCtx, type GaFlashCtx, type FullDownloadCtx, type StructureFlashCtx, type ReadStateCtx,
  type PersistBackups, type ProgressFn, type ConstantDifference,
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
  classify, classifyByMask, DeviceProfile, SystemBProfile, System7Profile, System1Profile, UnsupportedProfile,
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
//
// With an expected mask the link opens at the body's first request to the device, and the body is
// handed that mask (the gate holds the device to it). A device closes a transport connection that
// carries no request for the transport layer's connection timeout (6 s), and over KNXnet/IP UDP the
// gateway closes a channel whose client does not acknowledge within a second (docs/findings.md); what
// a body builds from the application before it touches the device (an image, a configuration, a
// refusal) takes seconds for a large application on a slow host, and runs before the link exists.
async function withDeviceSession<T>(
  connection: Connection,
  ia: string,
  wantMask: string | null,
  onProgress: ProgressFn | undefined,
  body: (dev: KnxDevice, mask: string) => Promise<T>,
  secure?: SecureCreds,
): Promise<T> {
  const tun = makeTransport(connection);
  let dev: KnxDevice | null = null;
  let session: SecureSession | undefined;
  const open = async (): Promise<{ dev: KnxDevice; mask: string }> => {
    onProgress?.("connect");
    await tun.connect();
    session = secure ? new SecureSession({ toolKey: secure.toolKey, src: tun.assignedIa, dst: iaToNum(ia), serial: secure.serial }) : undefined;
    const d = new KnxDevice(tun, ia, session);
    dev = d;
    await d.connect();
    const mask = await d.deviceDescriptor();
    if (wantMask !== null) {
      // Canonical equality (sameMask), never a substring match: gate logic on the
      // primary wrong-device safety check must not pass on a coincidental substring.
      // sameMask(x, x) is false only for an unparseable mask, i.e. "we don\'t know what
      // application this is" -> refuse before comparing anything.
      const refused = maskGate(mask, wantMask, secure !== undefined);
      if (refused) throw refused;
    }
    return { dev: d, mask };
  };
  // An opening still under way when the body ends (a request it did not wait for) is let finish, so the link
  // it opens is closed too.
  let settleOpening: () => Promise<void> = async () => {};
  let failureOf: () => { error: unknown } | null = () => null;
  const teardown = async () => {
    await settleOpening();
    if (!dev) return;
    try { await dev.disconnect(); } catch { /* teardown: the device link may already be gone */ }
    try { await tun.disconnect(); } catch { /* teardown: the transport may already be gone */ }
  };
  try {
    let result: T;
    if (wantMask === null) {
      const opened = await open();
      result = await body(opened.dev, opened.mask);
    } else {
      const lazy = openedOnFirstRequest(open, tun instanceof KnxUsbTransport, secure !== undefined);
      settleOpening = () => lazy.settled();
      failureOf = () => lazy.failure();
      result = await body(lazy.dev, wantMask);
      // A failed opening (the mask gate above all) fails the session even where the body took the
      // failure of the request that opened it as an answer.
      const failed = lazy.failure();
      if (failed) throw failed.error;
    }
    await teardown();
    return result;
  } catch (e) {
    await teardown();
    // A body that turned a failed opening into an error of its own still fails as the opening did.
    throw failureOf()?.error ?? e;
  } finally {
    reportPeerSequence(session, secure?.onPeerSequence);
  }
}

// A KnxDevice whose link opens at its first request, an async method of KnxDevice. The calls that only
// set or read the device object's own state may come before it: the settings are held and applied when
// the link opens, and the reads answer as a device that has done nothing yet. Any other use before the
// link opens is refused; after it everything goes to the device.
export function openedOnFirstRequest(open: () => Promise<{ dev: KnxDevice }>, overUsb: boolean, secured: boolean): { dev: KnxDevice; failure(): { error: unknown } | null; settled(): Promise<void> } {
  let opening: Promise<KnxDevice> | null = null;
  let failure: { error: unknown } | null = null;
  let dev: KnxDevice | null = null;
  const held: ((d: KnxDevice) => void)[] = [];
  const opened = () => opening ??= open().then(
    (o) => { dev = o.dev; for (const apply of held) apply(o.dev); return o.dev; },
    (error: unknown) => { failure = { error }; throw error; },
  );
  const before: Record<string, unknown> = {
    setExtendedMemoryServices: (on: boolean) => { held.push((d) => d.setExtendedMemoryServices(on)); },
    acceptUnprovenRestart: (on: boolean) => { held.push((d) => d.acceptUnprovenRestart(on)); },
    confirmedWrites: () => [],
    clearConfirmedWrites: () => {},
    restartUnproven: false,
    secured,
    overUsb,
  };
  const proto = KnxDevice.prototype as unknown as Record<PropertyKey, unknown>;
  const lazy = new Proxy({} as KnxDevice, {
    get(_t, k) {
      if (dev) {
        const v = (dev as unknown as Record<PropertyKey, unknown>)[k];
        return typeof v === "function" ? v.bind(dev) : v;
      }
      // Not a thenable: an await of the device itself must not open it.
      if (k === "then") return undefined;
      if (typeof k === "string" && Object.hasOwn(before, k)) return before[k];
      const method = typeof k === "string" ? proto[k] : undefined;
      if (typeof method !== "function" || method.constructor.name !== "AsyncFunction") {
        throw new Error(`KnxDevice.${String(k)} used before the device session opened; only a request to the device opens it`);
      }
      return (...args: unknown[]) => opened().then((d) => (method as (...a: unknown[]) => unknown).apply(d, args));
    },
    set(_t, k) {
      throw new Error(`KnxDevice.${String(k)} assigned on a device session; a session's device takes no assignment`);
    },
  });
  return {
    dev: lazy,
    failure: () => failure,
    settled: async () => { await opening?.catch(() => {}); },
  };
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

// The writes that author a com-object table take the device's own com-object flags from the project
// (deviceservice.ts resolveComObjOverrides). Required here, where the product layer lets it be absent,
// so no route can write a table without them.
type ProjectComObjOverrides = { comObjectOverrides: NonNullable<FullDownloadCtx["comObjectOverrides"]> };
// The writes that rewrite the table in a device that holds one also take what the baseline records for
// it (deviceservice.ts resolveComObjOverrideBase), required for the same reason.
type BaselineComObjOverrides = ProjectComObjOverrides & { comObjectOverrideBase: NonNullable<GaFlashCtx["comObjectOverrideBase"]> };

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
export function flashDeviceGroupAddresses(opts: Omit<GaFlashCtx, "persistBackups"> & ServerScope & BaselineComObjOverrides & { appXml: string }): Promise<FlashResult> {
  const refused = refuseSessionWithoutSecurityObject(opts);
  if (refused) return refused;
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: GaFlashCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.flashGroupTables(dev, mask, ctx), opts.secure);
}

// Write a parameter change that alters the com-object table: parameters, the com-object table they
// imply and the group tables, in one bracket (profile.flashStructure).
export function flashDeviceStructure(opts: Omit<StructureFlashCtx, "persistBackups"> & ServerScope & BaselineComObjOverrides): Promise<FlashResult> {
  const refused = refuseSessionWithoutSecurityObject(opts);
  if (refused) return refused;
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: StructureFlashCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.flashStructure(dev, mask, ctx), opts.secure);
}

// Commission a device from nothing: application id, parameter image, com-object table and group
// tables in one bracket. Unlike a parameter download this AUTHORS the com-object table, because a
// virgin device has none to keep. Hardware-verified only where docs/commissioning.md says so.
export function downloadDeviceFull(opts: Omit<FullDownloadCtx, "persistBackups"> & ServerScope & ProjectComObjOverrides): Promise<FlashResult> {
  const refused = refuseSessionWithoutSecurityObject(opts);
  if (refused) return refused;
  const profile = classify(parseAppConfig(opts.appXml));
  const ctx: FullDownloadCtx = { ...opts, persistBackups: backupPersister(opts.dataDir, opts.projectId) };
  return withDeviceSession(opts.connection, opts.ia, profile.mask, opts.onProgress, (dev, mask) => profile.downloadFull(dev, mask, ctx), opts.secure);
}

// Read a device\'s current state back off the bus into a programmed baseline (drift
// detection). Read-only: nothing is written to the device.
export function readDeviceState(opts: ReadStateOpts & { ia: string; connection: Connection; secure?: SecureCreds }): Promise<DeviceStateRead> {
  const cfg = parseAppConfig(opts.appXml);
  const mask = classify(cfg).mask;
  return readStateIn((body) => withDeviceSession(opts.connection, opts.ia, mask, opts.onProgress, body, opts.secure), cfg, opts);
}

// A read-back, and with `holds` set, whether the device holds this configuration in a way a read of
// its values cannot show alone (readStateIn says which session each step runs in):
// - `programIdMatches`: the application id the device reports (PID 13 of the object its mask's master
//   data names for it) equals the application's own stamp; null where the mask names no such object
//   or the device reports none.
// - `loaded`: the load-state machines of its address table, association table, application (and, on
//   System B, its com-object table) are LOADED; an interrupted download leaves one LOADING or ERROR.
// - `imageMatches`: a parameter flash dry run and a group-address flash dry run (the device's own
//   links) under the baseline this read sets (the device's values, the assumed ones and the baseline's
//   own for parameters the device does not hold), which the project takes on revert, both find nothing
//   to write; the second compares the tables a GA flash writes, the com-object table among them where
//   the family writes it. This is what shows a parameter the device does not hold has the value the
//   project gives it, where it decides bytes Busforge writes. Null where the product has no such flash
//   or the check could not run; the reason is in `imageRefused`, its code in `imageRefusedCode` (the
//   error's code, READBACK_IMAGE_NO_FLASH; none for a read that missed a part). `constantsDiffer`: where the image
//   matches, the constant parameters the device differs in, no change (FlashResult.constantsDiffer).
// Where the read covers the com-object table, `comObjOverrideBase` is the flag baseline it sets: the
// stored one (`comObjectOverrideBaseRows`) with each object the configuration of its parameter baseline
// activates set to the flags the device holds (deviceComObjOverrideRows), `comObjFlagsUndecoded` the
// objects whose flags it could not take. The group-address dry run above runs under that baseline, so
// its flags come from the device and show nothing about the parameters (see deviceops.ts distinguishable).
type OverrideRows = { comObjRefId: string; attrs: Record<string, string> }[];
export type ReadStateOpts = ReadStateCtx & { appXml: string; deviceId: string; ia: string; holds?: boolean; comObjectOverrides?: ReadonlyMap<number, ComObjInstanceOverride>; comObjectOverrideBaseRows?: OverrideRows };
export type DeviceStateRead = DeviceReadback & { programIdMatches?: boolean | null; loaded?: boolean; imageMatches?: boolean | null; imageRefused?: string; imageRefusedCode?: string; constantsDiffer?: ConstantDifference[]; comObjOverrideBase?: OverrideRows; comObjFlagsUndecoded?: number[] };
// The read on one device session: every step below on `dev`.
export function readStateOn(dev: KnxDevice, mask: string, opts: ReadStateOpts): Promise<DeviceStateRead> {
  return readStateIn((body) => body(dev, mask), parseAppConfig(opts.appXml), opts);
}

// A device session: `body` runs on the device, and the session ends with it.
type InSession = <T>(body: (dev: KnxDevice, mask: string) => Promise<T>) => Promise<T>;
// The read in sessions that hold only requests to the device: the first reads what the read-back takes
// (profile.readDevice) and, with `holds`, the application id and the load states; the decoding and the
// flag baseline follow once it has closed. The two dry runs need the decoded values, so each runs in a
// session of its own, which opens at its first request (withDeviceSession).
async function readStateIn(inSession: InSession, cfg: AppConfig, opts: ReadStateOpts): Promise<DeviceStateRead> {
  const profile = classify(cfg);
  // What a read cannot show leaves its answer open (null / false) rather than ending a read that has
  // already succeeded; a cancel still ends it.
  const why = (e: unknown) => `${(e as { code?: string }).code ?? "ERROR"}: ${(e as Error).message}`;
  const answer = <T>(p: Promise<T>): Promise<{ value: T } | { error: unknown }> => p.then((value) => ({ value }), (error: unknown) => {
    if (opts.signal?.aborted) throw error;
    return { error };
  });
  const first = await inSession(async (dev, mask) => {
    const decode = await profile.readDevice(dev, mask, opts);
    if (!opts.holds) return { decode, holds: null };
    let programIdMatches: boolean | null = null;
    const holds = await answer((async () => {
      const object = planForMask(mask).applicationObject;
      const id = object === null ? null : await dev.propReadIfPresent(object, PID.PROGRAM_ID);
      programIdMatches = id && id.length ? id.equals(programIdStamp(cfg)) : null;
      const lsms = maskInfo(mask).family === "system-b" ? [1, 2, 3, 4] : [1, 2, 3];
      let all = true;
      for (const obj of lsms) if ((await lsmState(dev, obj, isMemoryMappedLsm(mask))) !== STATE.LOADED) all = false;
      return all;
    })());
    return { decode, holds: { programIdMatches, holds } };
  });
  const read = first.decode();
  const instancesFor = (values: Map<string, string>) => opts.moduleInstances?.length ? opts.moduleInstances : (cfg.hasModules ? resolveModuleInstances(cfg, values) : []);
  let flagBase: { rows: OverrideRows; undecoded: number[] } | undefined;
  let flagsUnreadable: string | undefined;
  if (read.comObjFlags) {
    // On the configuration of the parameter baseline this read sets, where the rows are stored and placed.
    // A baseline the flags cannot be taken over (two rows of one object that disagree) leaves them open.
    try {
      flagBase = deviceComObjOverrideRows(cfg, buildDeviceConfig(cfg, read.paramBase, undefined, instancesFor(read.paramBase)).imageComObjects, read.comObjFlags, opts.comObjectOverrideBaseRows ?? []);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      flagsUnreadable = `${(e as { code?: string }).code ?? "ERROR"}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const flags = flagBase ? { comObjOverrideBase: flagBase.rows, comObjFlagsUndecoded: flagBase.undecoded } : flagsUnreadable ? { comObjFlags: undefined, comObjFlagsUnreadable: flagsUnreadable } : {};
  if (!first.holds) return { ...read, ...flags };
  const { programIdMatches } = first.holds;
  let loaded = false;
  let imageMatches: boolean | null = null;
  let imageRefused: string | undefined;
  let imageRefusedCode: string | undefined;
  let constantsDiffer: ConstantDifference[] = [];
  const refusedBy = (e: unknown) => { imageMatches = null; imageRefused = why(e); imageRefusedCode = (e as { code?: string }).code; };
  if ("error" in first.holds.holds) refusedBy(first.holds.holds.error);
  else {
    loaded = first.holds.holds.value;
    const caps = profile.capabilities();
    if (!read.paramsRead || !read.linksRead) imageRefused = "the read did not cover both parameters and links";
    else if (!caps.flashParams || !caps.flashLinks) { imageRefused = "the product has no parameter or group-address flash to compare with"; imageRefusedCode = "READBACK_IMAGE_NO_FLASH"; }
    else {
      const checked = await answer((async () => {
        const values = read.paramBase;
        const moduleInstances = instancesFor(values);
        const progress = (_p: string, d?: number, t?: number) => opts.onProgress?.("check", d, t);
        const common = { deviceId: opts.deviceId, appXml: opts.appXml, params: values, baseParams: values, moduleInstances, dryRun: true, persistBackups: () => "", signal: opts.signal, onProgress: progress };
        const notCancelled = () => { if (opts.signal?.aborted) throw new ApiError("READ_ABORTED", "read aborted"); };
        notCancelled();
        const par = await inSession((dev, mask) => profile.flashParameters(dev, mask, common));
        if (par.kind === "unchanged") constantsDiffer = par.constantsDiffer ?? [];
        const links: ComObjectLink[] = read.links;
        // Under the flag baseline this read sets, as the parameter dry run runs under its parameter baseline.
        const flagsRead = flagBase ? placeComObjOverrides(cfg, buildDeviceConfig(cfg, values, undefined, moduleInstances), flagBase.rows) : undefined;
        if (par.kind === "unchanged") notCancelled();
        const ga = par.kind === "unchanged" ? await inSession((dev, mask) => profile.flashGroupTables(dev, mask, { ...common, ia: opts.ia, links, comObjectOverrides: flagsRead ?? opts.comObjectOverrides, comObjectOverrideBase: flagsRead })) : null;
        return par.kind === "unchanged" && ga?.kind === "unchanged";
      })());
      if ("error" in checked) refusedBy(checked.error);
      else imageMatches = checked.value;
    }
  }
  return { ...read, ...flags, programIdMatches, loaded, imageMatches, ...(imageRefused ? { imageRefused } : {}), ...(imageRefusedCode ? { imageRefusedCode } : {}), ...(imageMatches === true && constantsDiffer.length ? { constantsDiffer } : {}) };
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
      // in factory state then takes the next Sync on a new connection without answering it (a
      // Jung 400021SE does): close it with a T_Disconnect before the next key is tried.
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
