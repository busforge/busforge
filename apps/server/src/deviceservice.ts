import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { iaToNum, numToGa, SENDER_ENTRY } from "@busforge/knx";
import { appProgramId, readAppProgram, type Project } from "@busforge/project";
import { parseAppConfig, buildDeviceConfig, buildSecurityObject, comObjectUniverse, comObjInstanceOverride, IMAGE_WRITABLE_BASES, type ComObjInstanceOverride, type AppConfig, type ComObjectLink, type ComObjFlags, type DeviceConfigView, type DeviceConfigBuild, type MatrixOperation, type OperationState, type DeviceReadbackInfo, type SecureTablesCtx, type OtherDevice } from "@busforge/product";
import { getAppProgram, putAppProgram } from "./db/catalog.ts";
import { getDeviceParams, getDeviceParamBase, getDeviceModules, getDeviceAppRef, getDeviceProductRef, getDeviceForFlash, getSourceFile, getDeviceChangedKeys, getDeviceLinks, getGaLinks, getLinkBaseGaps, getDeviceComObjOverrides } from "./db/deviceparams.ts";
import { deviceCompatibility } from "./compatibility.ts";
import { isUntestedAcknowledged } from "./db/untestedAcks.ts";
import { projectExists, getGaMeta } from "./db/projects.ts";
import { getDeviceSecurity, isSecureDevice, setDeviceSequence } from "./db/deviceSecurity.ts";
import { sendersByGroup, listGroupSenders, type SenderSource } from "./db/groupSenders.ts";
import { getGroupKeys } from "./db/groupKeys.ts";
import { classify, type SecureCreds } from "./deviceprofile.ts";
import { resolveDcaModule } from "./dca.ts";
import { ApiError, errorCode } from "./errors.ts";
import { fullRef, stripRef } from "./refids.ts";
import type { AppState } from "./app.ts";

// A device's stored parameter overrides / module instances, read once so a flash and its
// post-flash baseline decision share one consistent snapshot (see unwrittenParamRefs).
type StoredParams = Map<string, string>;
type StoredModules = ReturnType<typeof getDeviceModules>;

// The project-model <-> device-model translation layer: everything that resolves
// a device's application program, builds its config view, and maps between the
// project's stored state and what is read from / flashed to the device. No HTTP
// types in here; failures surface as thrown ApiError (the dispatcher's error
// envelope turns them into the coded JSON responses).

// Data Secure credentials for a device, or undefined for a non-secure one. When a
// device has a stored tool key, every bus session (read or flash) is run securely.
export function secureCredsFor(state: AppState, projectId: string, deviceId: string): SecureCreds | undefined {
  const sec = getDeviceSecurity(state.db, projectId, deviceId, state.masterKey);
  return sec ? { toolKey: sec.toolKey, serial: sec.serialNumber, onPeerSequence: (seq) => setDeviceSequence(state.db, projectId, deviceId, seq) } : undefined;
}

// What a write of a device's group tables needs when the device runs Data Secure: the session
// credentials, the project's group keys its security object is loaded with, the senders the project
// assigns to each group address, and the other devices of the project linked to its secured addresses.
// Empty otherwise.
// models: the other devices' models, shared across calls that read one project state (securityChanges).
export function secureTablesFor(state: AppState, projectId: string, deviceId: string, models = new Map<string, OtherDeviceModel | null>()): { secure?: SecureCreds; security?: SecureTablesCtx } {
  // An address whose mode and key disagree (a snapshot restores the mode, never the key) would reach
  // the device secured against "off", or plain against "on".
  const mismatch = state.db.query("SELECT l.ga_raw AS g, a.security AS mode FROM device_links l JOIN group_addresses a ON a.project_id = l.project_id AND a.raw = l.ga_raw WHERE l.project_id = ? AND l.device_id = ? AND ((a.security = 'on') <> EXISTS (SELECT 1 FROM group_keys k WHERE k.project_id = l.project_id AND k.raw = l.ga_raw)) AND a.security <> 'auto' LIMIT 1")
    .get(projectId, deviceId) as { g: number; mode: string } | null;
  if (mismatch?.mode === "on") {
    throw new ApiError("SECURE_GA_FORCED_WITHOUT_KEY", `group address ${numToGa(mismatch.g)} is forced secure but the project holds no key for it; set its security to always secured again to give it one`, 409);
  }
  if (mismatch) {
    throw new ApiError("SECURE_GA_OFF_WITH_KEY", `group address ${numToGa(mismatch.g)} is set to never secured but the project holds a key for it; set its security to never secured again to drop the key`, 409);
  }
  const secure = secureCredsFor(state, projectId, deviceId);
  if (!secure) {
    // Without a tool key the tables would go out plain, and a secured address would reach the device
    // with no key and no security flag: it would talk plaintext where its peers expect security.
    const keys = getGroupKeys(state.db, projectId, state.masterKey);
    const secured = [...getDeviceLinks(state.db, projectId, deviceId).values()].flat().find((g) => keys.has(g));
    if (secured !== undefined) {
      throw new ApiError("SECURE_GA_WITHOUT_DEVICE_KEY", `this device is linked to the secured group address ${numToGa(secured)} but the project holds no tool key for it (not a secure device, or one ETS never commissioned); its tables are not written plain`, 409);
    }
    return {};
  }
  const groupKeys = getGroupKeys(state.db, projectId, state.masterKey);
  const senders = new Map([...sendersByGroup(state.db, projectId)].map(([ga, ias]) => [ga, ias.map(iaToNum)]));
  // Per secured address of this device, the other devices linked to it, each as a sender with the
  // sequence number the project holds for it, or with the reason it cannot be classed as one. Only an
  // object's first (sending) address counts as transmitting, and only while the object is in its
  // device's active configuration; a link of a device the project no longer holds is no one.
  const otherDevices = new Map<number, OtherDevice[]>();
  const own = new Set([...getDeviceLinks(state.db, projectId, deviceId).values()].flat().filter((g) => groupKeys.has(g)));
  if (own.size === 0) return { secure, security: { groupKeys, senders, otherDevices } };
  const rows = state.db.query("SELECT device_id AS deviceId, com_obj_ref_id AS refId, slot, ga_raw AS g FROM device_links WHERE project_id = ? AND device_id <> ?")
    .all(projectId, deviceId) as { deviceId: string; refId: string; slot: number; g: number }[];
  const devices = models;
  const deviceInfo = (id: string): OtherDeviceModel | null => {
    if (devices.has(id)) return devices.get(id)!;
    const dev = getDeviceForFlash(state.db, projectId, id);
    let info: OtherDeviceModel | null = null;
    if (dev) {
      const seq = getDeviceSecurity(state.db, projectId, id, state.masterKey)?.sequenceNumber ?? "";
      info = { ia: iaToNum(dev.ia), sequence: /^\d+$/.test(seq) ? BigInt(seq) : null, objs: null, active: new Set(), failure: null };
      try {
        const app = loadApp(state, projectId, id);
        const view = app ? buildDeviceConfig(app, getDeviceParams(state.db, projectId, id), undefined, getDeviceModules(state.db, projectId, id)) : null;
        if (app && view) {
          info.objs = comObjsByKey(app, view);
          for (const bl of view.blocks) for (const it of bl.items) if (it.kind === "comObject") info.active.add(stripRef(app.id, it.comObject.refId));
        }
      } catch (e) {
        info.failure = `its configuration could not be built (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    devices.set(id, info);
    return info;
  };
  const found = new Map<number, Map<string, OtherDevice>>();
  for (const r of rows) {
    if (!own.has(r.g)) continue;
    const d = deviceInfo(r.deviceId);
    if (!d) continue;
    const byDevice = found.get(r.g) ?? new Map<string, OtherDevice>();
    found.set(r.g, byDevice);
    byDevice.set(r.deviceId, classifyOtherLink(byDevice.get(r.deviceId) ?? { ia: d.ia, transmits: false, sequence: d.sequence, unresolved: null }, d, r));
  }
  for (const [g, byDevice] of found) otherDevices.set(g, [...byDevice.values()]);
  return { secure, security: { groupKeys, senders, otherDevices } };
}

// The fingerprint of what a Data Secure device's security object holds for the project as it stands:
// the group key table (keys under their address-table indices), the senders it lists, and which objects
// are secured, from the inputs and builder the GA flash and full download load it with (sized to the
// highest linked object rather than the device's declared count, which only the device knows). Sequence
// numbers are left out: they move with every session, the device keeps its own. null for a device
// without a tool key, or whose memory model does not load the object (its tables are refused instead).
// Throws, as the load would, when the object cannot be decided.
export function securityFingerprint(state: AppState, projectId: string, deviceId: string, models?: Map<string, OtherDeviceModel | null>): string | null {
  if (!isSecureDevice(state.db, projectId, deviceId)) return null;
  const app = loadApp(state, projectId, deviceId);
  if (!app) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project", 404);
  if (!classify(app).loadsSecurityObject) return null;
  const dev = getDeviceForFlash(state.db, projectId, deviceId);
  const resolved = resolveDeviceLinks(state, projectId, deviceId);
  if (!dev || !resolved) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project", 404);
  return securityFingerprintOf(resolved.links, secureTablesFor(state, projectId, deviceId, models).security, dev.ia);
}
export function securityFingerprintOf(links: ComObjectLink[], security: SecureTablesCtx | undefined, ia: string): string | null {
  if (!security) return null;
  const count = Math.max(0, ...links.map((l) => l.comObjNum));
  const so = buildSecurityObject(links, count, security.groupKeys, { byGa: security.senders ?? new Map(), ownIa: iaToNum(ia), otherDevices: security.otherDevices ?? new Map() });
  const senders = Buffer.from(so.senders);
  for (let i = 0; i < senders.length; i += SENDER_ENTRY) senders.fill(0, i + 2, i + SENDER_ENTRY);
  const secured = [...so.goFlags].flatMap((f, i) => (f ? [i + 1] : []));
  const h = createHash("sha256");
  for (const part of [so.groupKeys, senders, Buffer.from(secured.join(","))]) h.update(Buffer.from([part.length >> 8, part.length & 0xff])).update(part);
  return h.digest("hex").slice(0, 32);
}

// Per secure device whose security object differs from the one last verified on it ("changed"), or
// where that cannot be told ("unknown": no fingerprint was ever recorded, or the object cannot be
// decided for the project as it stands). A key or sender change made through any path shows here,
// on every device it reaches. A device never programmed is flagged as such already and left out.
export function securityChanges(state: AppState, projectId: string): Map<string, "changed" | "unknown"> {
  const out = new Map<string, "changed" | "unknown">();
  const rows = state.db.query("SELECT d.instance_id AS id, d.security_base AS base FROM devices d JOIN device_security s ON s.project_id = d.project_id AND s.device_id = d.instance_id WHERE d.project_id = ? AND d.never_programmed = 0")
    .all(projectId) as { id: string; base: string | null }[];
  const models = new Map<string, OtherDeviceModel | null>();
  for (const r of rows) {
    let now: string | null;
    try { now = securityFingerprint(state, projectId, r.id, models); } catch (e) {
      // A coded refusal (the object cannot be decided) is "unknown"; anything else is a bug and surfaces.
      if (!errorCode(e)) throw e;
      out.set(r.id, "unknown");
      continue;
    }
    if (now === null) continue;
    if (r.base === null) out.set(r.id, "unknown");
    else if (r.base !== now) out.set(r.id, "changed");
  }
  return out;
}

// The security tables a write loads, with the fingerprint of the object they make, so the baseline a
// verified write records is exactly what it wrote. The fingerprint is null when the object cannot be
// fingerprinted (the write then refuses on the same inputs).
export function securityTablesWithFingerprint(state: AppState, projectId: string, deviceId: string, links: ComObjectLink[], ia: string): { ctx: ReturnType<typeof secureTablesFor>; fingerprint: string | null } {
  const ctx = secureTablesFor(state, projectId, deviceId);
  let fingerprint: string | null = null;
  try { fingerprint = securityFingerprintOf(links, ctx.security, ia); } catch (e) { if (!errorCode(e)) throw e; }
  return { ctx, fingerprint };
}

// Record the fingerprint of the object a verified write loaded (null: not known).
export function setSecurityBase(state: AppState, projectId: string, deviceId: string, fingerprint: string | null): void {
  state.db.prepare("UPDATE devices SET security_base = ? WHERE project_id = ? AND instance_id = ?").run(fingerprint, projectId, deviceId);
}

// What the sender rule knows about another device of the project linked to a secured address.
export interface OtherDeviceModel {
  ia: number;
  sequence: bigint | null;
  objs: Map<string, { number: number; flags: ComObjFlags }> | null; // null: no application program
  active: Set<string>;   // keys of the objects in its active configuration
  failure: string | null; // its configuration could not be built
}
// Fold one link of that device to the secured address into what is known about it. It transmits
// there when a visible object with the communication and transmit flags has this address first
// (its sending address). Anything that cannot be decided is recorded as unresolved, and the first
// reason stays: such a device is refused, never left out.
export function classifyOtherLink(cur: OtherDevice, d: OtherDeviceModel, link: { refId: string; slot: number }): OtherDevice {
  const why = (): string | null => {
    if (d.failure) return d.failure;
    if (!d.objs) return "its application program is not available";
    const co = d.objs.get(link.refId);
    if (!co) return `its linked object ${link.refId} is not in its application program`;
    if (!d.active.has(link.refId)) return `its linked object #${co.number} is hidden by its parameters`;
    if (co.flags.transmit && link.slot === 0 && !co.flags.comm) return `its linked object #${co.number} transmits with its communication flag off`;
    return null;
  };
  const reason = cur.unresolved ?? why();
  const co = d.objs?.get(link.refId);
  const transmits = cur.transmits || (reason === null && !!co && co.flags.transmit && co.flags.comm && link.slot === 0);
  // ETS was seen not to list an object that only receives (write flag, no read or transmit flag,
  // 2026-10-01). Not seen: one that answers reads there, and a transmitting one with the address only as
  // a further address. An object with its communication flag off sends nothing and receives nothing.
  const unclearHere = reason === null && co && co.flags.comm && !(co.flags.transmit && link.slot === 0)
    ? (co.flags.read && link.slot === 0 ? `its linked object #${co.number} answers reads there`
      : co.flags.transmit ? `its linked object #${co.number} transmits, but this is not its sending address` : null)
    : null;
  return { ...cur, transmits, unresolved: reason, unclear: cur.unclear ?? unclearHere };
}

// Resolve a device's application-program XML: from the shared catalog, falling
// back to the stored .knxproj for projects imported before the catalog existed
// (and backfilling the catalog so the next read hits the DB). The catalog is
// keyed by application-program id, so this is shared across devices and projects.
export function resolveAppXml(state: AppState, projectId: string, appRef: string): string | null {
  const found = lookupAppXml(state, projectId, appRef);
  if (found && !found.cached) putAppProgram(state.db, appProgramId(appRef), found.xml);
  return found?.xml ?? null;
}
// The same lookup without backfilling the catalog, for an operation that must not write the database.
export function lookupAppXml(state: AppState, projectId: string, appRef: string): { xml: string; cached: boolean } | null {
  const cached = getAppProgram(state.db, appProgramId(appRef));
  if (cached) return { xml: cached, cached: true };
  const sourceFile = getSourceFile(state.db, projectId);
  if (!sourceFile || !existsSync(sourceFile)) return null;
  const xml = readAppProgram(readFileSync(sourceFile), appRef);
  return xml ? { xml, cached: false } : null;
}

// Gaps an import does not fully cover, surfaced so the device/GA counts are not the
// only success signal: devices whose application program was missing from the archive
// (they import but cannot be opened, configured, or flashed), group-address link tokens
// that referenced an address not in the tree (silently dropped during parse), and
// DeviceInstances the parser dropped as unkeyable/unaddressable (missing Id or address), bus
// interfaces assigned to a group address whose own address could not be resolved, and secure devices
// ETS never commissioned, imported without their tool key.
export function importGaps(project: Project, programs: Map<string, string>): { devicesWithoutProgram: { ia: string; name: string }[]; unresolvedLinks: number; malformedDevices: number; unresolvedSenders: number; secureDevicesWithoutSerial: number } {
  const devicesWithoutProgram = project.devices
    .filter((d) => !programs.has(appProgramId(d.appRef)))
    .map((d) => ({ ia: d.ia, name: d.name }));
  return { devicesWithoutProgram, unresolvedLinks: project.unresolvedLinks, malformedDevices: project.malformedDevices, unresolvedSenders: project.unresolvedSenders, secureDevicesWithoutSerial: project.secureDevicesWithoutSerial };
}

// Load and cache a device's parsed application program from the catalog.
export function loadApp(state: AppState, projectId: string, deviceId: string): AppConfig | null {
  const appRef = getDeviceAppRef(state.db, projectId, deviceId);
  if (!appRef) return null;
  const cacheKey = appProgramId(appRef); // catalog is global, immutable once stored
  let app = state.appCache.get(cacheKey);
  if (!app) {
    const xml = resolveAppXml(state, projectId, appRef);
    if (!xml) return null;
    app = parseAppConfig(xml);
    state.appCache.set(cacheKey, app);
  }
  return app;
}

// Load and cache a catalog application program by its program id, with no device or
// project involved (the catalog is global). The XML of a large application runs to
// tens of MB (the OpenKNX RaumController is ~75 MB) and parseAppConfig walks all of
// it, so the parse happens at most once per process per program; every later call is
// a cache hit.
export function loadCatalogApp(state: AppState, programId: string): AppConfig | null {
  let app = state.appCache.get(programId);
  if (!app) {
    const xml = getAppProgram(state.db, programId);
    if (!xml) return null;
    app = parseAppConfig(xml);
    state.appCache.set(programId, app);
  }
  return app;
}

// The default value of a parameter (ref/param default, ignoring user overrides),
// resolved from the built config view so module-instance params work too.
export function resolveParamForEdit(state: AppState, projectId: string, deviceId: string, refId: string): { defaultValue?: string; float?: boolean } | undefined {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return undefined;
  const view = buildDeviceConfig(app, getDeviceParams(state.db, projectId, deviceId), undefined, getDeviceModules(state.db, projectId, deviceId));
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param" && it.param.refId === refId) return { defaultValue: it.param.defaultValue, float: it.param.float };
  return undefined;
}

// Build a device's configuration view and overlay each com-object's stored GA link. The result is
// the serializable wire view (DeviceConfigView, imported from @busforge/product), the SAME type
// the web client reads, so a field renamed on either side is a compile error rather than a client
// silently reading undefined. `extra` (a read-back summary) is merged in on the read-back route;
// ReadbackSummary.readback and DeviceConfigView.readback share DeviceReadbackInfo for that reason.
// A device's matrix state for one operation and whether the user acknowledged its Product as
// untested in this project. Null when the device or its application program is unknown.
export function untestedStatus(state: AppState, projectId: string, deviceId: string, op: MatrixOperation):
  { productRef: string; appProgramId: string; state: OperationState; acknowledged: boolean } | null {
  const productRef = getDeviceProductRef(state.db, projectId, deviceId);
  const app = loadApp(state, projectId, deviceId);
  if (!productRef || !app) return null;
  const verdict = deviceCompatibility(productRef, app.id, classify(app).capabilities())[op];
  return { productRef, appProgramId: app.id, state: verdict.state, acknowledged: verdict.state === "tested" || isUntestedAcknowledged(state.db, projectId, productRef, app.id) };
}

export interface ReadbackSummary { readback: DeviceReadbackInfo }
export function buildDeviceView(state: AppState, projectId: string, deviceId: string, lang?: string, extra?: ReadbackSummary): DeviceConfigView {
  const { db } = state;
  if (!getDeviceForFlash(db, projectId, deviceId)) throw new ApiError("DEVICE_NOT_FOUND", "device not found", 404);
  const app = loadApp(state, projectId, deviceId);
  if (!app) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project", 404);
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), lang, getDeviceModules(db, projectId, deviceId));
  // Offer a native DCA-replacement module if one matches this app program.
  const module = resolveDcaModule(app.id, app.appVersion);
  if (module) view.dca = { ...(view.dca ?? { hint: "" }), module };
  // Honest read-back capability: which aspects (parameters / group-address links)
  // can be verified against the device. When false, the change indicators reflect
  // edits-vs-import only and were NEVER confirmed against the hardware, so the UI
  // must say so rather than imply a verified "no changes".
  const caps = classify(app).capabilities();
  view.readbackSupport = { params: caps.readParams, links: caps.readLinks };
  // A secure device's group tables and commissioning also need its security object, which only
  // some memory models load; on the others the UI must not offer either.
  view.capabilities = isSecureDevice(db, projectId, deviceId) && !classify(app).loadsSecurityObject ? { ...caps, flashLinks: false, fullDownload: false, structuralFlash: false } : caps;
  view.refusals = Object.fromEntries(Object.entries(classify(app).operationRefusals()).map(([op, r]) => [op, r.code]));
  view.fullDownloadLoadsApplication = view.capabilities.fullDownload && classify(app).fullDownloadLoadsApplication();
  const productRef = getDeviceProductRef(db, projectId, deviceId);
  if (productRef) {
    view.compatibility = deviceCompatibility(productRef, app.id, view.capabilities);
    view.untestedAcknowledged = isUntestedAcknowledged(db, projectId, productRef, app.id);
  }
  const links = getDeviceLinks(db, projectId, deviceId);
  const changed = getDeviceChangedKeys(db, projectId, deviceId);
  // For float params the override/baseline strings can differ purely in form (the UI
  // writes a canonical decimal, ETS stored scientific notation), which the string-based
  // change detection flags as drift. Compare those numerically so an unchanged float is
  // not shown as edited.
  const overrides = getDeviceParams(db, projectId, deviceId);
  const baseline = getDeviceParamBase(db, projectId, deviceId);
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind === "param") {
      let isChanged = changed.params.has(it.param.refId);
      if (isChanged && it.param.float) {
        const o = overrides.get(it.param.refId), bv = baseline.get(it.param.refId);
        if (o !== undefined && bv !== undefined && Number(o) === Number(bv)) isChanged = false;
      }
      it.param.changed = isChanged;
    } else if (it.kind === "comObject") {
      const key = stripRef(app.id, it.comObject.refId);
      it.comObject.gaRaw = links.get(key)?.[0] ?? null;
      it.comObject.gaRaws = links.get(key) ?? [];
      it.comObject.changed = changed.links.has(key);
    }
  }
  // Project the internal build to the serializable wire view: imageValues / imageComObjects are
  // Maps (JSON.stringify would ship them as `{}`) and are server-internal, so they never cross the
  // wire. Only the fields the client's DeviceConfigView declares are returned.
  const wire: DeviceConfigView = { blocks: view.blocks, hasModules: view.hasModules, dca: view.dca, readbackSupport: view.readbackSupport, capabilities: view.capabilities, refusals: view.refusals, compatibility: view.compatibility, untestedAcknowledged: view.untestedAcknowledged, linkBaseGaps: getLinkBaseGaps(db, projectId, deviceId) };
  return extra ? { ...wire, ...extra } : wire;
}

// Parameter refs a flash can never write, among the device's STORED overrides (the rows
// resetParamBase would adopt): memory-backed params whose type base the image codec does
// not represent (text/time/colour/binary/other; IMAGE_WRITABLE_BASES mirrors encode()).
// Resolved on the flat application model, not the visibility-filtered view, so a
// currently-hidden text param is covered too. A ref we cannot resolve at all is kept
// conservatively: we cannot prove the flash wrote it. Memory-less params are NOT kept:
// there is nothing on the device to program or drift, so adopting them is honest.
// `params` lets the caller pass a snapshot read once before a flash, so the "unwritten"
// decision matches the exact values the flash used even if a concurrent edit lands mid-flash.
export function unflashableParamRefs(state: AppState, projectId: string, deviceId: string, params?: StoredParams): Set<string> {
  const refs = new Set<string>();
  const app = loadApp(state, projectId, deviceId);
  const stored = params ?? getDeviceParams(state.db, projectId, deviceId);
  if (!app) return new Set(stored.keys());
  for (const refId of stored.keys()) {
    // A module-instance ref (…_MD-x_M-k_MI-n_…) resolves through its ModuleDef ref (…_MD-x_…),
    // the inverse of the instance id the module expansion prefixes (application.ts).
    let resolved: { base: string; hasMemory: boolean } | undefined;
    for (const rid of [refId, refId.replace(/_M-\d+_MI-\d+/, "")]) {
      const ref = app.refs.get(rid);
      const param = ref ? app.params.get(ref.paramId) : undefined;
      const t = param ? app.types.get(param.typeId) : undefined;
      if (param && t) { resolved = { base: t.base, hasMemory: param.hasMemory }; break; }
    }
    if (!resolved) refs.add(refId);
    else if (resolved.hasMemory && !IMAGE_WRITABLE_BASES.has(resolved.base)) refs.add(refId);
  }
  return refs;
}

// Stored param refs a parameter flash did NOT write, so resetParamBase must keep them as
// drift instead of adopting them into the baseline. A stored override goes unwritten for
// two reasons: (1) its type is not image-representable (unflashableParamRefs), or (2) it is
// currently HIDDEN, i.e. not in the active config view, so the image builder skipped it
// (deviceimage.ts: `active.get(ref.id) === undefined` keeps the <Data> default rather than
// writing the override). Adopting either into the baseline would clear a "changed" chip for
// a value that never reached the device; on re-activating the branch the device still holds
// its default. Mirrors the links side (resetLinkBase adopts only actually-flashed refs). The
// active set is the flashed configuration's view (deviceParamRefs).
// `params`/`modules`: pass the snapshot the flash used (read once before enqueue) so the
// baseline decision cannot diverge from the flashed image when a param edit lands while the
// flash runs on the bus (the GA path resolves flashedRefIds pre-enqueue for the same reason).
export function unwrittenParamRefs(state: AppState, projectId: string, deviceId: string, params?: StoredParams, modules?: StoredModules): Set<string> {
  const stored = params ?? getDeviceParams(state.db, projectId, deviceId);
  const mods = modules ?? getDeviceModules(state.db, projectId, deviceId);
  // Evaluate at adoption: earlier queued jobs may have learned new baseline refs since
  // submission. Visibility still comes from the submitted values, never concurrent edits.
  // Sparse submissions may remove an override without making its device field observable.
  const candidates = new Map([...getDeviceParamBase(state.db, projectId, deviceId), ...stored]);
  const keep = unflashableParamRefs(state, projectId, deviceId, candidates);
  const active = deviceParamRefs(state, projectId, deviceId, stored, mods);
  for (const refId of candidates.keys()) {
    if (!active.has(refId)) keep.add(refId);
  }
  return keep;
}

// One device's communication object on a group address, for the GA details
// overlay. `flags` carries the KNX read/write/transmit semantics so the UI can
// split senders (transmit) from receivers (write).
interface GaComObj {
  deviceId: string; deviceName: string; ia: string;
  comObjName: string; functionText: string; comObjNumber: number;
  flags: ComObjFlags;
}
export interface GaDevicesView {
  address: string; name: string; dpt: string; path: string[];
  senders: GaComObj[];
  receivers: GaComObj[];
  // Whether the project holds a Data Secure key for the address, and the individual addresses it
  // assigns as senders besides the linked objects (bus interfaces; groupSenders.ts).
  secured: boolean;
  interfaceSenders: { ia: string; source: SenderSource }[];
}

// A device's com-objects keyed by their stored (stripped) ref id, carrying the
// resolved name and read/write flags. Built from the flat application model so
// hidden objects are covered too, then overridden by the module-resolved config
// view (translated names, module-instance numbering). Mirrors buildDeviceView's
// key stripping (stripRef).
function comObjsByKey(app: AppConfig, view: ReturnType<typeof buildDeviceConfig>): Map<string, { name: string; functionText: string; number: number; flags: ComObjFlags }> {
  const out = new Map<string, { name: string; functionText: string; number: number; flags: ComObjFlags }>();
  for (const [full, ref] of app.comObjectRefs) {
    const obj = app.comObjects.get(ref.refId);
    if (!obj) continue;
    out.set(stripRef(app.id, full), {
      name: ref.text ?? obj.text ?? obj.name,
      functionText: ref.functionText ?? obj.functionText,
      number: obj.number,
      flags: { ...obj.flags, ...ref.flags },
    });
  }
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind !== "comObject") continue;
    out.set(stripRef(app.id, it.comObject.refId), {
      name: it.comObject.name, functionText: it.comObject.functionText, number: it.comObject.number, flags: it.comObject.flags,
    });
  }
  return out;
}

// Which devices use a group address, split by role. A linked com-object is a
// sender when it has the transmit flag (it writes the address on change) and a
// receiver when it has the write flag (it consumes writes); an object with both
// appears in both lists. Links whose com-object resolves to neither flag fall
// back to the receiver list (e.g. a read-only responder), so nothing is dropped.
export function buildGaDevicesView(state: AppState, projectId: string, raw: number, lang?: string): GaDevicesView {
  const { db } = state;
  if (!projectExists(db, projectId)) throw new ApiError("PROJECT_NOT_FOUND", "project not found", 404);
  const meta = getGaMeta(db, projectId, raw);
  if (!meta) throw new ApiError("GA_NOT_FOUND", "group address not found", 404);

  // Group the project-wide links by device, so each device's app is built once.
  const byDevice = new Map<string, string[]>();
  for (const l of getGaLinks(db, projectId, raw)) {
    const a = byDevice.get(l.deviceId) ?? [];
    a.push(l.comObjRefId);
    byDevice.set(l.deviceId, a);
  }

  const senders: GaComObj[] = [];
  const receivers: GaComObj[] = [];
  for (const [deviceId, refIds] of byDevice) {
    const dev = getDeviceForFlash(db, projectId, deviceId);
    const app = loadApp(state, projectId, deviceId);
    if (!dev || !app) continue; // a stale link to a removed device/app: skip, don't fail the overlay
    const comObjs = comObjsByKey(app, buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), lang, getDeviceModules(db, projectId, deviceId)));
    for (const refId of refIds) {
      const co = comObjs.get(refId);
      if (!co) continue; // link to a com-object absent from the app model: skip
      const entry: GaComObj = { deviceId, deviceName: dev.name, ia: dev.ia, comObjName: co.name, functionText: co.functionText, comObjNumber: co.number, flags: co.flags };
      if (co.flags.transmit) senders.push(entry);
      if (co.flags.write) receivers.push(entry);
      else if (!co.flags.transmit) receivers.push(entry);
    }
  }
  const byIa = (a: GaComObj, b: GaComObj) => a.ia.localeCompare(b.ia, undefined, { numeric: true });
  const secured = getGroupKeys(db, projectId, state.masterKey).has(raw);
  const interfaceSenders = listGroupSenders(db, projectId).filter((s) => s.gaRaw === raw).map(({ ia, source }) => ({ ia, source }));
  return { address: meta.address, name: meta.name, dpt: meta.dpt, path: meta.path, senders: senders.sort(byIa), receivers: receivers.sort(byIa), secured, interfaceSenders } satisfies GaDevicesView;
}

// Choose which stored com-object links to program into the device's association
// table. A link is flashed only when its com-object is in the active view
// (visible under the current parameter values); every other stored link is
// skipped. This matches ETS, which drops a hidden object's group address from
// the device. The skipped link stays in the project (device_links) and returns
// to the device the next time the parameters re-activate the object, so nothing
// is lost. We deliberately do not try to tell a "hidden" link from a corrupt one
// and block the flash on it: that distinction is not reliably computable here
// (module com-objects use synthetic per-instance ref ids absent from the flat
// com-object tables, and objects behind an inactive choose branch are never
// enumerated), and the safe default for any unresolved link is to leave it
// stored and unflashed, never to abort the whole flash. `stored` keys are
// stripped ref ids; `numByRef` is keyed by the full `${appId}_${refId}` form.
export function selectFlashLinks(
  stored: Map<string, number[]>,
  numByRef: Map<string, number>,
  appId: string,
): ComObjectLink[] {
  const links: ComObjectLink[] = [];
  for (const [refId, gaRaws] of stored) {
    const num = numByRef.get(fullRef(appId, refId));
    if (num !== undefined) links.push({ comObjNum: num, gaRaws });
  }
  return links;
}

// Resolve a device's stored links to (comObjNum -> GAs) for flashing the group
// tables. Com-object numbers come from the (module-resolved) config view.
export function resolveDeviceLinks(state: AppState, projectId: string, deviceId: string): { mask: string; links: ComObjectLink[]; flashedRefIds: string[] } | null {
  const { db } = state;
  const app = loadApp(state, projectId, deviceId);
  if (!app) return null;
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), undefined, getDeviceModules(db, projectId, deviceId));
  const numByRef = new Map<string, number>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") numByRef.set(it.comObject.refId, it.comObject.number);
  const links = selectFlashLinks(getDeviceLinks(db, projectId, deviceId), numByRef, app.id);
  // A GA flash rewrites the WHOLE address+association table, so every com-object resolvable in
  // the active view is authoritatively written — whether it has links now or had them removed
  // (an empty link is also "written"). Those are the refs whose baseline may be reset. Refs NOT
  // in the view (hidden/unresolvable) are absent from the table, were not written, and must stay
  // as drift. Deriving from the view (not from stored links) is what keeps a fully-removed link
  // from being stuck as false drift.
  const flashedRefIds = [...numByRef.keys()].map((full) => stripRef(app.id, full));
  return { mask: app.mask, links, flashedRefIds };
}

// The com-object flags and priority the project sets on the device, by the object number of its
// configuration, for the writes that author the com-object table. An override on an application
// com-object the configuration hides is left out, as the object is. One that names no com-object of
// the application, or two that set one object differently, cannot be placed, and the write is
// refused rather than made with the application's flags.
export function resolveComObjOverrides(state: AppState, projectId: string, deviceId: string): Map<number, ComObjInstanceOverride> {
  const { db } = state;
  const rows = getDeviceComObjOverrides(db, projectId, deviceId);
  if (!rows.length) return new Map();
  const app = loadApp(state, projectId, deviceId);
  if (!app) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project", 404);
  return placeComObjOverrides(app, buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), undefined, getDeviceModules(db, projectId, deviceId)), rows);
}

// resolveComObjOverrides over a configuration view already built: the stored rows (com-object ref
// ids as in device_links) placed on the object numbers of `view`.
// The objects the table is written from (imageComObjects) are placed too: an object of a block the
// page does not show is still written.
export function placeComObjOverrides(app: AppConfig, view: Pick<DeviceConfigBuild, "blocks" | "imageComObjects">, rows: readonly { comObjRefId: string; attrs: Readonly<Record<string, string>> }[]): Map<number, ComObjInstanceOverride> {
  const out = new Map<number, ComObjInstanceOverride>();
  const numByRef = new Map<string, number>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") numByRef.set(it.comObject.refId, it.comObject.number);
  for (const o of view.imageComObjects.values()) numByRef.set(o.refId, o.number);
  for (const r of rows) {
    const full = fullRef(app.id, r.comObjRefId);
    const num = numByRef.get(full);
    if (num === undefined) {
      // An application object, or an object of a module instance (its ref id names the instance,
      // MI-n), that the configuration does not show is not written, and neither is its override.
      if (app.comObjectRefs.has(full) || /(^|_)MI-\d+_/.test(r.comObjRefId)) continue;
      throw new ApiError("COM_OBJECT_OVERRIDE_UNRESOLVED", `the project sets flags on the communication object ${r.comObjRefId}, which this configuration does not resolve to an object of the application; refusing to write the com-object table without them`, 400);
    }
    const o = comObjInstanceOverride(r.attrs);
    const prev = out.get(num);
    if (!prev) { out.set(num, o); continue; }
    const clash = (Object.keys(o.flags) as (keyof typeof o.flags)[]).some((k) => k in prev.flags && prev.flags[k] !== o.flags[k])
      || (o.priority !== undefined && prev.priority !== undefined && o.priority !== prev.priority);
    if (clash) throw new ApiError("COM_OBJECT_OVERRIDE_CONFLICT", `the project sets a flag of communication object #${num} twice, differently; refusing to pick one`, 400);
    out.set(num, { flags: { ...prev.flags, ...o.flags }, priority: o.priority ?? prev.priority });
  }
  return out;
}

// One row of a "replace device" com-object mapping: `from` is a com-object ref of the
// OLD application that currently holds GA links, `to` the ComObjectRef of the NEW
// application that inherits them (null = deliberately drop the link). Both sides
// accept the full or the stored (stripped) ref form, symmetric with PUT links.
export interface ReplaceMappingEntry { from: string; to: string | null }

// Validate a replace mapping against the device's current links and the new
// application, and resolve it into the new device_links rows (stored ref key -> GA
// raws, slots preserved). The mapping must be TOTAL over the current links: the UI
// always sends every row, so a missing row is a client bug, and silently keeping or
// dropping an unmentioned link is exactly how group addresses would get lost quietly.
// Every failure is a coded refusal; nothing is skipped or merged.
export function mapLinksForReplace(
  oldAppId: string,
  newApp: AppConfig,
  currentLinks: Map<string, number[]>,
  mapping: ReplaceMappingEntry[],
): Map<string, number[]> {
  // The full ComObjectRef universe of the new app, NOT the visibility-gated view:
  // a migrated link may target an object that only becomes visible once the new
  // device's channel parameters are set (GA-preserve semantics). Computed even for
  // an all-null mapping, so replacing with a module-def product refuses consistently
  // instead of depending on what the mapping happens to contain.
  const universe = new Set(comObjectUniverse(newApp).map((e) => e.refId));

  const out = new Map<string, number[]>();
  const seen = new Set<string>();
  const targets = new Set<string>();
  for (const m of mapping) {
    const fromKey = stripRef(oldAppId, m.from);
    if (seen.has(fromKey)) throw new ApiError("REPLACE_MAPPING_DUPLICATE", `the mapping lists ${m.from} twice`);
    seen.add(fromKey);
    const gaRaws = currentLinks.get(fromKey);
    if (!gaRaws) throw new ApiError("REPLACE_LINK_UNKNOWN", `${m.from} is not a linked com-object of this device`);
    if (m.to === null) continue; // deliberately dropped
    const toKey = stripRef(newApp.id, m.to);
    if (!universe.has(fullRef(newApp.id, toKey))) {
      throw new ApiError("REPLACE_COMOBJ_NOT_IN_APP", `${m.to} is not a communication object of the new application`);
    }
    // Two old refs on one target would collide on (com_obj_ref_id, slot): every
    // link's slots start at 0, so any two non-empty GA sets overlap. Refuse rather
    // than merge two link sets nobody asked to merge.
    if (targets.has(toKey)) throw new ApiError("REPLACE_MAPPING_COLLISION", `two links map to the same target com-object ${m.to}`);
    targets.add(toKey);
    out.set(toKey, gaRaws);
  }
  for (const key of currentLinks.keys()) {
    if (!seen.has(key)) {
      throw new ApiError("REPLACE_MAPPING_INCOMPLETE", `the mapping does not cover the linked com-object ${key}; every current link needs an explicit target (or null to drop it)`);
    }
  }
  return out;
}

// The parameter refs that make up a device's actual configuration (the config
// view's keys): for module devices these are instance-expanded, so they differ
// from the flat application model. Used to keep read-back drift consistent with
// what the UI shows.
export function deviceParamRefs(state: AppState, projectId: string, deviceId: string, params?: StoredParams, modules?: StoredModules): Set<string> {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return new Set();
  const view = buildDeviceConfig(app, params ?? getDeviceParams(state.db, projectId, deviceId), undefined, modules ?? getDeviceModules(state.db, projectId, deviceId));
  const refs = new Set<string>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") refs.add(it.param.refId);
  return refs;
}

// The param refs a configuration shows and the refs active in its image (hidden Merker included).
export function deviceConfigRefs(state: AppState, projectId: string, deviceId: string, params: StoredParams, modules?: StoredModules): { shown: Set<string>; active: Set<string> } {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return { shown: new Set(), active: new Set() };
  const view = buildDeviceConfig(app, params, undefined, modules ?? getDeviceModules(state.db, projectId, deviceId));
  const shown = new Set<string>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") shown.add(it.param.refId);
  return { shown, active: new Set(view.imageValues.keys()) };
}

const sameGaSet = (a: number[], b: number[]) => { const x = [...a].sort((m, n) => m - n), y = [...b].sort((m, n) => m - n); return x.length === y.length && x.every((v, i) => v === y[i]); };

// Merge a device's read-back links into the sparse link baseline: copy the live
// links, then override only where the device differs. When the device's com-object
// numbering is known (`observable` given: the keys the device's configuration places),
// a com-object missing from the device read is genuinely unassigned and is cleared, but
// only where the device could show a link at all; a live link on an object the device's
// configuration hides stays (unobservable, not absent). Without known numbering (a module
// device whose own configuration was not read) only links that map onto a known live
// com-object are trusted; others are neither invented nor dropped.
// `gaps` counts the device links that were NOT folded into the baseline: drift there
// stays invisible, and the caller must surface that instead of presenting the read as a
// complete links baseline.
export function mergeLinkBaseline(live: Map<string, number[]>, device: Map<string, number[]>, observable?: Set<string>): { base: Map<string, number[]>; gaps: number } {
  const base = new Map(live);
  let gaps = 0;
  if (!observable) {
    for (const [key, dev] of device) {
      if (live.has(key)) { if (!sameGaSet(live.get(key) ?? [], dev)) base.set(key, dev); }
      else gaps++;
    }
  } else {
    for (const key of new Set([...live.keys(), ...device.keys()])) {
      const proj = live.get(key) ?? [];
      const dev = device.get(key);
      if (dev === undefined && !observable.has(key)) continue;
      if (!sameGaSet(proj, dev ?? [])) { if (dev?.length) base.set(key, dev); else base.delete(key); }
    }
  }
  return { base, gaps };
}

// The com-object a stored ref key names, without the ComObjectRef variant: "O-133_R-300101304"
// and "O-133_R-300101301" are two presentations of one object.
const objectOf = (key: string) => key.replace(/_R-[^_]+$/, "");

// Turn the links read off a device (keyed by com-object number) into the sparse
// link baseline keyed by stored ref id: copy the live links, then override only
// the com-objects whose device GA set differs from the project, so the live-vs-
// base diff flags exactly the drift. Inverse of resolveDeviceLinks' numbering.
//
// A number names a com-object only under a configuration: module instances shift their objects,
// and parameters choose which objects exist. With `deviceConfig` (the configuration the same read
// converged on, DeviceReadback.deviceConfig) numbers resolve through the objects that
// configuration places; where the project's configuration places the same object at that number,
// the project's ref variant is kept, so a link both sides hold is not drift. Without it, only the
// project's view places numbers, and module links outside the live links stay gaps.
//
// `gaps` counts device links left invisible: a number no configuration places (a module
// template object only exists shifted per instance, so its bare number places nothing), and a
// link on an object the project's configuration does not show, which enters the baseline but
// cannot appear on the device page.
export function readbackLinkBase(state: AppState, projectId: string, deviceId: string, deviceLinks: ComObjectLink[], deviceConfig?: Map<string, string>): { base: Map<string, number[]>; gaps: number } {
  const { db } = state;
  const app = loadApp(state, projectId, deviceId);
  if (!app) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project");
  const modules = getDeviceModules(db, projectId, deviceId);
  const placed = (params: Map<string, string>) => {
    const byNum = new Map<number, string>();
    for (const b of buildDeviceConfig(app, params, undefined, modules).blocks) for (const it of b.items) {
      if (it.kind === "comObject") byNum.set(it.comObject.number, stripRef(app.id, it.comObject.refId));
    }
    return byNum;
  };
  const projNum = placed(getDeviceParams(db, projectId, deviceId));
  const devNum = deviceConfig ? placed(deviceConfig) : projNum;
  // Objects with an absolute number keep it under every configuration, so a hidden one still
  // names its object. A module (BaseNumber) object is numbered only inside an instance.
  const flatNum = new Map<number, string>();
  for (const [full, cor] of app.comObjectRefs) {
    const co = app.comObjects.get(cor.refId);
    if (co && !co.baseNumber) flatNum.set(co.number, stripRef(app.id, full));
  }
  const keyAt = (n: number): string | undefined => {
    const dev = devNum.get(n) ?? flatNum.get(n);
    if (!dev) return undefined;
    const proj = projNum.get(n);
    return proj && objectOf(proj) === objectOf(dev) ? proj : dev;
  };
  const shown = new Set(projNum.values());

  const device = new Map<string, number[]>();
  let unplaced = 0, hidden = 0;
  for (const l of deviceLinks) {
    const key = keyAt(l.comObjNum);
    if (!key) { unplaced++; continue; }
    device.set(key, l.gaRaws);
    if (!shown.has(key)) hidden++;
  }
  const numberingKnown = !app.hasModules || deviceConfig !== undefined;
  const observable = numberingKnown ? new Set([...devNum.keys()].map((n) => keyAt(n)!)) : undefined;
  const merged = mergeLinkBaseline(getDeviceLinks(db, projectId, deviceId), device, observable);
  return { base: merged.base, gaps: merged.gaps + unplaced + (numberingKnown ? hidden : 0) };
}
