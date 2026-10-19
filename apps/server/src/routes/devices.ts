import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { buildDeviceConfig, editComObjOverride, type ComObjFlags, type ComObjOverrideEdit } from "@busforge/product";
import { addDevice, setDeviceAddress, renameDevice, projectExists, getGaMeta } from "../db/projects.ts";
import { getAppProgram, getCatalogProduct } from "../db/catalog.ts";
import { getDeviceBaggage, projectHasBaggage } from "../db/baggage.ts";
import { getDeviceParams, setDeviceParam, deleteDeviceParam, getDeviceModules, setDeviceLink, getDeviceForFlash, getDeviceLinks, replaceDeviceProduct, revertDevice, revertDeviceParam, revertDeviceLink, getDeviceComObjOverrides, getDeviceComObjOverrideBase, setDeviceComObjOverride, revertDeviceComObjFlags } from "../db/deviceparams.ts";
import { appProgramId } from "@busforge/project";
import { buildDeviceView, loadApp, loadCatalogApp, mapLinksForReplace, resolveParamForEdit, deviceComObjFlags, type ReplaceMappingEntry } from "../deviceservice.ts";
import { fullRef, stripRef } from "../refids.ts";
import { json, err, text } from "../httputil.ts";
import type { AppState } from "../app.ts";
import { applyLinkSecurity } from "../db/gaSecurity.ts";

// Device placement + configuration editing: config view, DCA baggage, parameter
// and link edits, and the revert endpoints.
export async function handle(req: Request, url: URL, seg: string[], state: AppState): Promise<Response | null> {
  const { db } = state;
  const id = seg[2];

  // /api/projects/:id/devices  (POST: place a catalog product as a new device)
  if (seg.length === 4 && seg[3] === "devices" && req.method === "POST") {
    if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    const body = (await req.json().catch(() => ({}))) as { appRef?: string; productRef?: string; name?: unknown };
    if (!body.appRef || !body.productRef) return err("DEVICE_FIELDS_REQUIRED", "appRef and productRef required");
    const product = getCatalogProduct(db, body.appRef, body.productRef);
    if (!product) return err("CATALOG_PRODUCT_NOT_FOUND", "product not in catalog", 404);
    if (!getAppProgram(db, product.appProgramId)) return err("APP_PROGRAM_MISSING", "application program not in catalog", 404);
    const device = addDevice(db, id, product, text(body.name));
    return json(device, 201);
  }

  // /api/projects/:id/devices/:deviceId         -> rename the device row.
  // /api/projects/:id/devices/:deviceId/config?lang=
  // /api/projects/:id/devices/:deviceId/address  -> set the address this device SHOULD hold.
  // The name and the address are model state only. Writing the address into the physical device
  // is a separate, explicit step (POST .../assign-ia); the name is never written at all, because
  // a KNX device carries none. Neither route touches the bus or a programmed baseline.
  if (seg.length === 5 && seg[3] === "devices" && req.method === "PATCH") {
    if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    // Anything that is not a string is a missing name, not a crash: trimming a number here
    // would surface as a 500 carrying handler source text.
    const name = text(body.name);
    if (!name) return err("DEVICE_NAME_REQUIRED", "a device name is required");
    return json(renameDevice(db, id, decodeURIComponent(seg[4]), name));
  }

  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "address" && req.method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as { ia?: unknown };
    const ia = text(body.ia);
    if (!ia) return err("IA_REQUIRED", "an individual address is required");
    return json(setDeviceAddress(db, id, decodeURIComponent(seg[4]), ia));
  }

  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "config" && req.method === "GET") {
    return json(buildDeviceView(state, id, decodeURIComponent(seg[4]), url.searchParams.get("lang") ?? undefined));
  }

  // /api/projects/:id/devices/:deviceId/baggage  -> DCA config blobs for this
  // device (base64), consumed by native DCA-replacement modules.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "baggage" && req.method === "GET") {
    const deviceId = decodeURIComponent(seg[4]);
    // DB is authoritative for projects imported with DB baggage; fall back to the
    // on-disk store only for legacy projects that have no baggage rows at all.
    if (projectHasBaggage(db, id)) return json(getDeviceBaggage(db, id, deviceId));
    const bagDir = join(state.dataDir, "projects", id, "baggage");
    const out: Record<string, string> = {};
    if (existsSync(bagDir)) {
      for (const f of readdirSync(bagDir)) {
        if (f.startsWith(`${deviceId}_`)) out[f] = readFileSync(join(bagDir, f)).toString("base64");
      }
    }
    return json(out);
  }
  // /api/projects/:id/devices/:deviceId/params
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "params" && req.method === "PUT") {
    const deviceId = decodeURIComponent(seg[4]);
    const body = (await req.json()) as { paramRefId?: string; value?: string; lang?: string };
    if (!body.paramRefId || body.value === undefined) return err("PARAM_FIELDS_REQUIRED", "paramRefId and value required");
    const value = String(body.value);
    // If the value equals the parameter's default, drop the override instead of
    // storing it, so restoring the default clears the "changed" marker (the
    // sparse baseline has no row for default-valued params). A float default is
    // stored in scientific notation; compare it numerically so the canonical decimal
    // the UI sends still collapses to it.
    const pv = resolveParamForEdit(state, id, deviceId, body.paramRefId);
    const def = pv?.defaultValue;
    const isDefault = def !== undefined && (value === def || (pv?.float === true && Number(value) === Number(def)));
    if (isDefault) deleteDeviceParam(db, id, deviceId, body.paramRefId);
    else setDeviceParam(db, id, deviceId, body.paramRefId, value);
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  // /api/projects/:id/devices/:deviceId/links  -> set a com-object's group addresses, in order: the
  // first is the address it sends on, the others it listens to
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "links" && req.method === "PUT") {
    const deviceId = decodeURIComponent(seg[4]);
    // allowPlain: the user confirmed that linking a device without security turns a secured
    // automatic address plain (gaSecurity.ts).
    const body = (await req.json()) as { comObjRefId?: string; gaRaws?: number[]; lang?: string; allowPlain?: boolean };
    if (!body.comObjRefId || !Array.isArray(body.gaRaws)) return err("COMOBJ_FIELDS_REQUIRED", "comObjRefId and gaRaws required");
    const app = loadApp(state, id, deviceId);
    if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
    // Accept the full (view) ref id or the stored stripped key.
    const key = stripRef(app.id, body.comObjRefId);
    // Validate the target com-object actually exists in this device's active config. Without
    // this, a bogus ref is stored and then silently dropped at flash (selectFlashLinks finds no
    // number) or would build an association to a non-existent com-object. Refuse instead.
    const linkView = buildDeviceConfig(app, getDeviceParams(db, id, deviceId), body.lang, getDeviceModules(db, id, deviceId));
    const knownComObjs = new Set<string>();
    for (const b of linkView.blocks) for (const it of b.items) if (it.kind === "comObject") knownComObjs.add(it.comObject.refId);
    if (!knownComObjs.has(fullRef(app.id, key))) return err("COMOBJ_NOT_FOUND", "no such communication object on this device");
    if (!body.gaRaws.every((g) => Number.isInteger(g))) return err("COMOBJ_FIELDS_REQUIRED", "gaRaws must be group address numbers");
    const gaRaws = body.gaRaws;
    // The same address twice would give the object two association entries for one address.
    if (new Set(gaRaws).size !== gaRaws.length) return err("LINK_GA_DUPLICATE", "a group address appears twice in the object's links");
    const unknown = gaRaws.find((g) => !getGaMeta(db, id, g));
    if (unknown !== undefined) return err("GA_NOT_FOUND", `group address ${unknown} is not in the project`, 404);
    db.transaction(() => {
      applyLinkSecurity(db, id, deviceId, key, gaRaws, { allowPlain: body.allowPlain === true }, state.masterKey);
      setDeviceLink(db, id, deviceId, key, gaRaws);
    })();
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  // /api/projects/:id/devices/:deviceId/comobject-flags  -> set a com-object's flags and priority over
  // the application's, per device, as ETS stores them (ComObjectInstanceRef). `flags`: per flag true,
  // false, or null for the application's value; `priority` likewise. Only the bits the device's full
  // download writes are accepted (DeviceConfigView.comObjFlagsEditable).
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "comobject-flags" && req.method === "PUT") {
    const deviceId = decodeURIComponent(seg[4]);
    const body = (await req.json().catch(() => ({}))) as { comObjRefId?: unknown; flags?: unknown; priority?: unknown; lang?: string };
    const edit = comObjOverrideEdit(body);
    if (typeof body.comObjRefId !== "string" || !edit) return err("COMOBJ_FLAGS_INVALID", "comObjRefId and flags (true, false or null per flag) or a priority (Low, High, Alert or null) required");
    const app = loadApp(state, id, deviceId);
    if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const key = stripRef(app.id, body.comObjRefId);
    const view = buildDeviceConfig(app, getDeviceParams(db, id, deviceId), body.lang, getDeviceModules(db, id, deviceId));
    const obj = view.blocks.flatMap((b) => b.items).find((it) => it.kind === "comObject" && it.comObject.refId === fullRef(app.id, key));
    if (!obj || obj.kind !== "comObject") return err("COMOBJ_NOT_FOUND", "no such communication object on this device");
    const placed = deviceComObjFlags(state, id, deviceId, app, view);
    if (placed.refused) return err(placed.refused, "the flags this project sets on the device's communication objects cannot be placed; refusing to edit them", 409);
    const editable = new Set<string>(buildDeviceView(state, id, deviceId).comObjFlagsEditable ?? []);
    const asked = [...Object.keys(edit.flags ?? {}), ...(edit.priority !== undefined ? ["priority"] : [])];
    const refused = asked.filter((k) => !editable.has(k));
    if (refused.length) return err("COM_OBJECT_FLAG_NOT_EDITABLE", `this device's downloads cannot write ${refused.join(", ")} of a communication object as the project sets it`);
    const merged = (rows: { comObjRefId: string; attrs: Record<string, string> }[]) => {
      const own = rows.filter((r) => r.comObjRefId === key);
      return own.length ? Object.assign({}, ...own.map((r) => r.attrs)) as Record<string, string> : undefined;
    };
    const attrs = editComObjOverride(merged(getDeviceComObjOverrides(db, id, deviceId)), merged(getDeviceComObjOverrideBase(db, id, deviceId)),
      { flags: obj.comObject.flags, priority: obj.comObject.priority }, edit);
    setDeviceComObjOverride(db, id, deviceId, key, attrs);
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  // /api/projects/:id/devices/:deviceId/revert-comobject-flags  -> discard one com-object's flag edit
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert-comobject-flags" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const app = loadApp(state, id, deviceId);
    if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const body = (await req.json().catch(() => ({}))) as { comObjRefId?: string; lang?: string };
    if (!body.comObjRefId) return err("COMOBJ_REF_REQUIRED", "comObjRefId required");
    revertDeviceComObjFlags(db, id, deviceId, stripRef(app.id, body.comObjRefId));
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  // /api/projects/:id/devices/:deviceId/replace  -> swap the device's product for a
  // catalog product because the physical device was replaced. The row keeps its
  // identity (IA, name, comment, room); its GA links migrate through an explicit,
  // TOTAL com-object mapping the UI collects; the old application's parameters and
  // programmed baselines are dropped (the new hardware was never programmed, so a
  // carried-over baseline would fake a programmed state).
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "replace" && req.method === "POST") {
    if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    const deviceId = decodeURIComponent(seg[4]);
    const current = getDeviceForFlash(db, id, deviceId);
    if (!current) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const body = (await req.json().catch(() => ({}))) as { appRef?: string; productRef?: string; mapping?: unknown; lang?: string };
    const mappingShapeOk = Array.isArray(body.mapping) &&
      (body.mapping as { from?: unknown; to?: unknown }[]).every((m) => !!m && typeof m === "object" && typeof m.from === "string" && (m.to === null || typeof m.to === "string"));
    if (!body.appRef || !body.productRef || !mappingShapeOk) {
      return err("REPLACE_FIELDS_REQUIRED", "appRef, productRef and a mapping of { from, to | null } entries are required");
    }
    const product = getCatalogProduct(db, body.appRef, body.productRef);
    if (!product) return err("CATALOG_PRODUCT_NOT_FOUND", "product not in catalog", 404);
    const newApp = loadCatalogApp(state, product.appProgramId);
    if (!newApp) return err("APP_PROGRAM_MISSING", "application program not in catalog", 404);
    const newLinks = mapLinksForReplace(
      appProgramId(current.appRef), // the stored link keys are stripped against the OLD program id
      newApp,
      getDeviceLinks(db, id, deviceId),
      body.mapping as ReplaceMappingEntry[],
    );
    replaceDeviceProduct(db, id, deviceId, product, newLinks);
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  // /api/projects/:id/devices/:deviceId/revert  -> discard unprogrammed edits
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    if (!getDeviceForFlash(db, id, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const body = (await req.json().catch(() => ({}))) as { lang?: string };
    revertDevice(db, id, deviceId);
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  // /api/projects/:id/devices/:deviceId/revert-param  -> discard one param's drift
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert-param" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    if (!getDeviceForFlash(db, id, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const body = (await req.json().catch(() => ({}))) as { paramRefId?: string; lang?: string };
    if (!body.paramRefId) return err("PARAM_REF_REQUIRED", "paramRefId required");
    revertDeviceParam(db, id, deviceId, body.paramRefId);
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  // /api/projects/:id/devices/:deviceId/revert-link  -> discard one com-object's drift
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert-link" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const app = loadApp(state, id, deviceId);
    if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const body = (await req.json().catch(() => ({}))) as { comObjRefId?: string; lang?: string };
    if (!body.comObjRefId) return err("COMOBJ_REF_REQUIRED", "comObjRefId required");
    const key = stripRef(app.id, body.comObjRefId);
    revertDeviceLink(db, id, deviceId, key);
    return json(buildDeviceView(state, id, deviceId, body.lang));
  }

  return null;
}

const FLAG_KEYS: readonly (keyof ComObjFlags)[] = ["read", "write", "comm", "transmit", "update", "readOnInit"];
// The edit a request body asks for, or null where it is malformed or asks nothing.
function comObjOverrideEdit(body: { flags?: unknown; priority?: unknown }): ComObjOverrideEdit | null {
  const out: ComObjOverrideEdit = {};
  if (body.flags !== undefined) {
    if (!body.flags || typeof body.flags !== "object" || Array.isArray(body.flags)) return null;
    const flags: NonNullable<ComObjOverrideEdit["flags"]> = {};
    for (const [k, v] of Object.entries(body.flags)) {
      if (!FLAG_KEYS.includes(k as keyof ComObjFlags) || (v !== null && typeof v !== "boolean")) return null;
      flags[k as keyof ComObjFlags] = v;
    }
    out.flags = flags;
  }
  if (body.priority !== undefined) {
    if (body.priority !== null && body.priority !== "Low" && body.priority !== "High" && body.priority !== "Alert") return null;
    out.priority = body.priority;
  }
  return Object.keys(out.flags ?? {}).length || out.priority !== undefined ? out : null;
}
