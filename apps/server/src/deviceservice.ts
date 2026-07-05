import { existsSync, readFileSync } from "node:fs";
import { appProgramId, readAppProgram, type Project } from "@busforge/project";
import { parseAppConfig, buildDeviceConfig, IMAGE_WRITABLE_BASES, type AppConfig, type ComObjectLink, type ComObjFlags } from "@busforge/product";
import { getAppProgram, putAppProgram } from "./db/catalog.ts";
import { getDeviceParams, getDeviceParamBase, getDeviceModules, getDeviceAppRef, getDeviceForFlash, getSourceFile, getDeviceChangedKeys, getDeviceLinks, getGaLinks } from "./db/deviceparams.ts";
import { projectExists, getGaMeta } from "./db/projects.ts";
import { getDeviceSecurity } from "./db/deviceSecurity.ts";
import { classify, type SecureCreds } from "./deviceprofile.ts";
import { resolveDcaModule } from "./dca.ts";
import { ApiError } from "./errors.ts";
import { fullRef, stripRef } from "./refids.ts";
import type { AppState } from "./app.ts";

// The project-model <-> device-model translation layer: everything that resolves
// a device's application program, builds its config view, and maps between the
// project's stored state and what is read from / flashed to the device. No HTTP
// types in here; failures surface as thrown ApiError (the dispatcher's error
// envelope turns them into the coded JSON responses).

// Data Secure credentials for a device, or undefined for a non-secure one. When a
// device has a stored tool key, every bus session (read or flash) is run securely.
export function secureCredsFor(state: AppState, projectId: string, deviceId: string): SecureCreds | undefined {
  const sec = getDeviceSecurity(state.db, projectId, deviceId, state.masterKey);
  return sec ? { toolKey: sec.toolKey, serial: sec.serialNumber } : undefined;
}

// Resolve a device's application-program XML: from the shared catalog, falling
// back to the stored .knxproj for projects imported before the catalog existed
// (and backfilling the catalog so the next read hits the DB). The catalog is
// keyed by application-program id, so this is shared across devices and projects.
export function resolveAppXml(state: AppState, projectId: string, appRef: string): string | null {
  const id = appProgramId(appRef);
  const cached = getAppProgram(state.db, id);
  if (cached) return cached;
  const sourceFile = getSourceFile(state.db, projectId);
  if (!sourceFile || !existsSync(sourceFile)) return null;
  const xml = readAppProgram(readFileSync(sourceFile), appRef);
  if (xml) putAppProgram(state.db, id, xml);
  return xml;
}

// Gaps an import does not fully cover, surfaced so the device/GA counts are not the
// only success signal: devices whose application program was missing from the archive
// (they import but cannot be opened, configured, or flashed) and group-address link
// tokens that referenced an address not in the tree (silently dropped during parse).
export function importGaps(project: Project, programs: Map<string, string>): { devicesWithoutProgram: { ia: string; name: string }[]; unresolvedLinks: number } {
  const devicesWithoutProgram = project.devices
    .filter((d) => !programs.has(appProgramId(d.appRef)))
    .map((d) => ({ ia: d.ia, name: d.name }));
  return { devicesWithoutProgram, unresolvedLinks: project.unresolvedLinks };
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

// The default value of a parameter (ref/param default, ignoring user overrides),
// resolved from the built config view so module-instance params work too.
export function resolveParamForEdit(state: AppState, projectId: string, deviceId: string, refId: string): { defaultValue?: string; float?: boolean } | undefined {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return undefined;
  const view = buildDeviceConfig(app, getDeviceParams(state.db, projectId, deviceId), undefined, getDeviceModules(state.db, projectId, deviceId));
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param" && it.param.refId === refId) return { defaultValue: it.param.defaultValue, float: it.param.float };
  return undefined;
}

// Build a device's configuration view and overlay each com-object's stored GA link.
// `extra` is merged into the response; typed so the server-side shape cannot silently
// drift from the client's DeviceConfigView contract (api.ts).
export interface ReadbackSummary { readback: { paramsRead: boolean; linksRead: boolean; linkGaps: number } }
export function buildDeviceView(state: AppState, projectId: string, deviceId: string, lang?: string, extra?: ReadbackSummary) {
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
  const rbCaps = classify(app).capabilities(getDeviceParams(db, projectId, deviceId), getDeviceModules(db, projectId, deviceId));
  view.readbackSupport = { params: rbCaps.readParams, links: rbCaps.readLinks };
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
      it.comObject.changed = changed.links.has(key);
    }
  }
  return extra ? { ...view, ...extra } : view;
}

// Parameter refs a flash can never write, among the device's STORED overrides (the rows
// resetParamBase would adopt): memory-backed params whose type base the image codec does
// not represent (text/time/colour/binary/other; IMAGE_WRITABLE_BASES mirrors encode()).
// Resolved on the flat application model, not the visibility-filtered view, so a
// currently-hidden text param is covered too. A ref we cannot resolve at all is kept
// conservatively: we cannot prove the flash wrote it. Memory-less params are NOT kept:
// there is nothing on the device to program or drift, so adopting them is honest.
export function unflashableParamRefs(state: AppState, projectId: string, deviceId: string): Set<string> {
  const refs = new Set<string>();
  const app = loadApp(state, projectId, deviceId);
  const stored = getDeviceParams(state.db, projectId, deviceId);
  if (!app) return new Set(stored.keys());
  for (const refId of stored.keys()) {
    // A module-instance ref (…_MI-n_…) resolves through its ModuleDef ref.
    let resolved: { base: string; hasMemory: boolean } | undefined;
    for (const rid of [refId, refId.replace(/_MI-\d+/, "")]) {
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
  return { address: meta.address, name: meta.name, dpt: meta.dpt, path: meta.path, senders: senders.sort(byIa), receivers: receivers.sort(byIa) } satisfies GaDevicesView;
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

// The parameter refs that make up a device's actual configuration (the config
// view's keys): for module devices these are instance-expanded, so they differ
// from the flat application model. Used to keep read-back drift consistent with
// what the UI shows.
export function deviceParamRefs(state: AppState, projectId: string, deviceId: string): Set<string> {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return new Set();
  const view = buildDeviceConfig(app, getDeviceParams(state.db, projectId, deviceId), undefined, getDeviceModules(state.db, projectId, deviceId));
  const refs = new Set<string>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") refs.add(it.param.refId);
  return refs;
}

const sameGaSet = (a: number[], b: number[]) => { const x = [...a].sort((m, n) => m - n), y = [...b].sort((m, n) => m - n); return x.length === y.length && x.every((v, i) => v === y[i]); };

// Merge a device's read-back links into the sparse link baseline: copy the live
// links, then override only where the device differs. Non-module devices map 1:1,
// so a com-object missing from the device read is genuinely unassigned (cleared).
// Module devices can't reverse instance numbering reliably, so only links that map
// onto a known live com-object are trusted; others are neither invented nor dropped.
// `gaps` counts the device links that were NOT folded into the baseline (module
// device-only links on unknown keys): drift there stays invisible, and the caller
// must surface that instead of presenting the read as a complete links baseline.
export function mergeLinkBaseline(live: Map<string, number[]>, device: Map<string, number[]>, hasModules: boolean): { base: Map<string, number[]>; gaps: number } {
  const base = new Map(live);
  let gaps = 0;
  if (hasModules) {
    for (const [key, dev] of device) {
      if (live.has(key)) { if (!sameGaSet(live.get(key) ?? [], dev)) base.set(key, dev); }
      else gaps++;
    }
  } else {
    for (const key of new Set([...live.keys(), ...device.keys()])) {
      const proj = live.get(key) ?? [];
      const dev = device.get(key) ?? [];
      if (!sameGaSet(proj, dev)) { if (dev.length) base.set(key, dev); else base.delete(key); }
    }
  }
  return { base, gaps };
}

// Turn the links read off a device (keyed by com-object number) into the sparse
// link baseline keyed by stored ref id: copy the live links, then override only
// the com-objects whose device GA set differs from the project, so the live-vs-
// base diff flags exactly the drift. Inverse of resolveDeviceLinks' numbering.
// `gaps` additionally counts device links whose com-object number maps to no known
// ref id at all (stale/foreign associations): they cannot enter the baseline.
export function readbackLinkBase(state: AppState, projectId: string, deviceId: string, deviceLinks: ComObjectLink[]): { base: Map<string, number[]>; gaps: number } {
  const { db } = state;
  const app = loadApp(state, projectId, deviceId);
  if (!app) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project");
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), undefined, getDeviceModules(db, projectId, deviceId));
  // number -> stored ref key. App covers hidden com-objects; the view's
  // module-resolved numbers take precedence.
  const keyByNum = new Map<number, string>();
  for (const [full, cor] of app.comObjectRefs) {
    const num = app.comObjects.get(cor.refId)?.number;
    if (num !== undefined) keyByNum.set(num, stripRef(app.id, full));
  }
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") keyByNum.set(it.comObject.number, stripRef(app.id, it.comObject.refId));

  const device = new Map<string, number[]>();
  let unmapped = 0;
  for (const l of deviceLinks) {
    const key = keyByNum.get(l.comObjNum);
    if (key) device.set(key, l.gaRaws);
    else unmapped++; // association on a com-object number the app model does not know
  }

  const merged = mergeLinkBaseline(getDeviceLinks(db, projectId, deviceId), device, app.hasModules);
  return { base: merged.base, gaps: merged.gaps + unmapped };
}
