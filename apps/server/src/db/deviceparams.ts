import type { Database } from "bun:sqlite";
import type { ModuleInstance } from "@busforge/product";
import type { CatalogProduct } from "@busforge/project";
import { ApiError } from "../errors.ts";

// A device's stored parameter values (ParameterRef id -> value), seeded from the
// project at import and updated by the configuration UI.
export function getDeviceParams(db: Database, projectId: string, deviceId: string): Map<string, string> {
  const rows = db.query("SELECT param_ref_id AS refId, value FROM device_parameters WHERE project_id = ? AND device_id = ?")
    .all(projectId, deviceId) as { refId: string; value: string }[];
  return new Map(rows.map((r) => [r.refId, r.value]));
}

// The programmed baseline values (set at import/flash). Used to distinguish a real
// edit from a textual-only difference (e.g. a float stored in scientific notation in
// the baseline vs the UI's canonical decimal).
export function getDeviceParamBase(db: Database, projectId: string, deviceId: string): Map<string, string> {
  const rows = db.query("SELECT param_ref_id AS refId, value FROM device_param_base WHERE project_id = ? AND device_id = ?")
    .all(projectId, deviceId) as { refId: string; value: string }[];
  return new Map(rows.map((r) => [r.refId, r.value]));
}

export function setDeviceParam(db: Database, projectId: string, deviceId: string, refId: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)")
    .run(projectId, deviceId, refId, value);
}

// Remove a parameter override so the device falls back to the (sparse) default.
// Used when an edit restores a param to its default, so it stops counting as a
// change (the baseline has no row for default-valued params).
export function deleteDeviceParam(db: Database, projectId: string, deviceId: string, refId: string): void {
  db.prepare("DELETE FROM device_parameters WHERE project_id = ? AND device_id = ? AND param_ref_id = ?")
    .run(projectId, deviceId, refId);
}

// Shape-check a parsed device_modules payload. The JSON is written from
// @busforge/project's ModuleInstanceData (parseDeviceModules) and read back here as
// @busforge/product's structurally-identical ModuleInstance; the two type names are the
// same wire contract, joined only by this stored JSON. A row can only be malformed via
// external tampering or an un-migrated schema change, so a mismatch is a corrupt store,
// not user input: fail loudly here rather than hand a mis-typed object to the image
// builder, where it would explode far from the cause.
function isModuleInstances(x: unknown): x is ModuleInstance[] {
  return Array.isArray(x) && x.every((m) =>
    !!m && typeof m === "object" &&
    typeof (m as ModuleInstance).id === "string" && typeof (m as ModuleInstance).refId === "string" &&
    Array.isArray((m as ModuleInstance).args) &&
    (m as ModuleInstance).args.every((a) => !!a && typeof a.refId === "string" && typeof a.value === "string"));
}

// A device's module instances (resolved arg values), read whole to expand its
// configuration. Empty when the device has no module instances.
export function getDeviceModules(db: Database, projectId: string, deviceId: string): ModuleInstance[] {
  const r = db.query("SELECT instances FROM device_modules WHERE project_id = ? AND device_id = ?")
    .get(projectId, deviceId) as { instances: string } | null;
  if (!r) return [];
  const parsed: unknown = JSON.parse(r.instances);
  if (!isModuleInstances(parsed)) throw new Error(`device_modules row ${projectId}/${deviceId} is not a ModuleInstance[] (corrupt store)`);
  return parsed;
}

export function getDeviceAppRef(db: Database, projectId: string, deviceId: string): string | null {
  const r = db.query("SELECT app_ref AS appRef FROM devices WHERE project_id = ? AND instance_id = ?")
    .get(projectId, deviceId) as { appRef: string } | null;
  return r?.appRef ?? null;
}

// A device's com-object -> GA links (comObjRefId -> ga raws, ordered by slot).
export function getDeviceLinks(db: Database, projectId: string, deviceId: string): Map<string, number[]> {
  const rows = db.query("SELECT com_obj_ref_id AS refId, ga_raw AS gaRaw FROM device_links WHERE project_id = ? AND device_id = ? ORDER BY com_obj_ref_id, slot")
    .all(projectId, deviceId) as { refId: string; gaRaw: number }[];
  const out = new Map<string, number[]>();
  for (const r of rows) { const a = out.get(r.refId) ?? []; a.push(r.gaRaw); out.set(r.refId, a); }
  return out;
}

// Every (device, com-object) pair linked to one group address, across the whole
// project. Used by the GA details overlay to show which devices use the address;
// the com-object's read/write role is resolved from its application program by
// the caller. Keys are stored (stripped) com-object ref ids.
export function getGaLinks(db: Database, projectId: string, raw: number): { deviceId: string; comObjRefId: string }[] {
  return db.query("SELECT DISTINCT device_id AS deviceId, com_obj_ref_id AS comObjRefId FROM device_links WHERE project_id = ? AND ga_raw = ? ORDER BY device_id")
    .all(projectId, raw) as { deviceId: string; comObjRefId: string }[];
}

// Re-point a com-object to a set of group addresses (replaces its links).
export function setDeviceLink(db: Database, projectId: string, deviceId: string, comObjRefId: string, gaRaws: number[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM device_links WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?").run(projectId, deviceId, comObjRefId);
    const ins = db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    gaRaws.forEach((raw, slot) => ins.run(projectId, deviceId, comObjRefId, slot, raw));
  })();
}

// Swap a device's product for a catalog product (the physical device was replaced).
// The row keeps its identity (instance_id, ia, name, comment — and thereby its
// space_devices room assignment, which keys on instance_id); only the product
// columns move. Everything the OLD application owned is dropped: its parameter
// values and module instances are meaningless under the new program, and the new
// hardware was never programmed, so keeping any param/link baseline (or the old
// tool key) would fake a programmed state that does not exist. The caller passes
// the already-validated new link rows (stored ref key -> GA raws); they become the
// device's only config, all of it unprogrammed drift until the first flash.
export function replaceDeviceProduct(db: Database, projectId: string, deviceId: string, product: CatalogProduct, links: Map<string, number[]>): void {
  db.transaction(() => {
    const updated = db.prepare("UPDATE devices SET product_ref = ?, app_ref = ?, manufacturer = ?, link_base_gaps = 0 WHERE project_id = ? AND instance_id = ?")
      .run(product.productRef, product.appRef, product.manufacturer, projectId, deviceId).changes;
    // The route checked existence before parsing the body; if the device vanished in
    // that gap, a 0-row UPDATE would silently commit orphan device_links rows below
    // (device_links has no FK on the device row). Throwing rolls the transaction back.
    if (updated === 0) throw new ApiError("DEVICE_NOT_FOUND", "device not found", 404);
    for (const t of ["device_parameters", "device_param_base", "device_link_base", "device_modules", "device_security", "device_links"]) {
      db.prepare(`DELETE FROM ${t} WHERE project_id = ? AND device_id = ?`).run(projectId, deviceId);
    }
    // DCA baggage is keyed by a `${deviceId}_`-prefixed name, not a device_id column.
    // Match the prefix in JS (mirroring getDeviceBaggage): an instance id routinely
    // contains "_", which SQL LIKE would treat as a wildcard and over-delete.
    const bag = db.query("SELECT name FROM device_baggage WHERE project_id = ?").all(projectId) as { name: string }[];
    const delBag = db.prepare("DELETE FROM device_baggage WHERE project_id = ? AND name = ?");
    for (const { name } of bag) if (name.startsWith(`${deviceId}_`)) delBag.run(projectId, name);
    const ins = db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    for (const [refId, gaRaws] of links) gaRaws.forEach((raw, slot) => ins.run(projectId, deviceId, refId, slot, raw));
  })();
}

export function getDeviceForFlash(db: Database, projectId: string, deviceId: string): { ia: string; appRef: string; name: string; programmingToken: string } | null {
  const r = db.query("SELECT ia, app_ref AS appRef, name, programming_token AS programmingToken FROM devices WHERE project_id = ? AND instance_id = ?")
    .get(projectId, deviceId) as { ia: string; appRef: string; name: string; programmingToken: string } | null;
  return r ?? null;
}

export function getSourceFile(db: Database, projectId: string): string | null {
  const r = db.query("SELECT source_file AS sourceFile FROM projects WHERE id = ?").get(projectId) as { sourceFile: string } | null;
  return r?.sourceFile ?? null;
}

// --- Unprogrammed-change tracking ---------------------------------------------
// A device "has changes" when its live params/links differ from the baseline
// captured at import and refreshed after each successful flash.

// Per-device change counts for a whole project: how many parameters differ from
// their baseline, and how many com-objects have a differing GA-link set.
export interface DeviceChanges { params: number; links: number; }
export function getProjectChanges(db: Database, projectId: string): Map<string, DeviceChanges> {
  const out = new Map<string, DeviceChanges>();
  const bump = (id: string, k: keyof DeviceChanges, n: number) => {
    const c = out.get(id) ?? { params: 0, links: 0 };
    c[k] = n; out.set(id, c);
  };
  // Symmetric difference of (param, value) rows, counted as distinct params. A
  // plain JOIN would miss a param edited from its default: 0.xml is sparse, so
  // such a param has no baseline row and editing it inserts a live-only row.
  const paramRows = db.query(`
    SELECT device_id AS deviceId, COUNT(DISTINCT param_ref_id) AS n FROM (
      SELECT device_id, param_ref_id FROM (
        SELECT device_id, param_ref_id, value FROM device_parameters WHERE project_id = ?
        EXCEPT
        SELECT device_id, param_ref_id, value FROM device_param_base WHERE project_id = ?
      )
      UNION ALL
      SELECT device_id, param_ref_id FROM (
        SELECT device_id, param_ref_id, value FROM device_param_base WHERE project_id = ?
        EXCEPT
        SELECT device_id, param_ref_id, value FROM device_parameters WHERE project_id = ?
      )
    )
    GROUP BY device_id
  `).all(projectId, projectId, projectId, projectId) as { deviceId: string; n: number }[];
  for (const r of paramRows) bump(r.deviceId, "params", r.n);

  // Com-objects whose link set differs = symmetric difference of (com_obj, slot, ga)
  // rows between the live and baseline tables, counted as distinct com-objects.
  const linkRows = db.query(`
    SELECT device_id AS deviceId, COUNT(DISTINCT com_obj_ref_id) AS n FROM (
      SELECT device_id, com_obj_ref_id FROM (
        SELECT device_id, com_obj_ref_id, slot, ga_raw FROM device_links WHERE project_id = ?
        EXCEPT
        SELECT device_id, com_obj_ref_id, slot, ga_raw FROM device_link_base WHERE project_id = ?
      )
      UNION ALL
      SELECT device_id, com_obj_ref_id FROM (
        SELECT device_id, com_obj_ref_id, slot, ga_raw FROM device_link_base WHERE project_id = ?
        EXCEPT
        SELECT device_id, com_obj_ref_id, slot, ga_raw FROM device_links WHERE project_id = ?
      )
    )
    GROUP BY device_id
  `).all(projectId, projectId, projectId, projectId) as { deviceId: string; n: number }[];
  for (const r of linkRows) bump(r.deviceId, "links", r.n);

  return out;
}

// Which of a single device's rows differ from the programmed baseline, so the
// config view can flag the exact edited parameters and com-objects. Param keys
// are the stored full ref ids; link keys are the stored (stripped) com-object
// ref ids, matching how the config view overlays them.
export interface DeviceChangedKeys { params: Set<string>; links: Set<string>; }
export function getDeviceChangedKeys(db: Database, projectId: string, deviceId: string): DeviceChangedKeys {
  // Symmetric difference of (param, value) rows: a param edited from its default
  // has no baseline row, so a plain JOIN would miss it (see getProjectChanges).
  const paramRows = db.query(`
    SELECT param_ref_id FROM (
      SELECT param_ref_id, value FROM device_parameters WHERE project_id = ? AND device_id = ?
      EXCEPT
      SELECT param_ref_id, value FROM device_param_base WHERE project_id = ? AND device_id = ?
    )
    UNION
    SELECT param_ref_id FROM (
      SELECT param_ref_id, value FROM device_param_base WHERE project_id = ? AND device_id = ?
      EXCEPT
      SELECT param_ref_id, value FROM device_parameters WHERE project_id = ? AND device_id = ?
    )
  `).all(projectId, deviceId, projectId, deviceId, projectId, deviceId, projectId, deviceId) as { param_ref_id: string }[];

  const linkRows = db.query(`
    SELECT com_obj_ref_id FROM (
      SELECT com_obj_ref_id, slot, ga_raw FROM device_links WHERE project_id = ? AND device_id = ?
      EXCEPT
      SELECT com_obj_ref_id, slot, ga_raw FROM device_link_base WHERE project_id = ? AND device_id = ?
    )
    UNION
    SELECT com_obj_ref_id FROM (
      SELECT com_obj_ref_id, slot, ga_raw FROM device_link_base WHERE project_id = ? AND device_id = ?
      EXCEPT
      SELECT com_obj_ref_id, slot, ga_raw FROM device_links WHERE project_id = ? AND device_id = ?
    )
  `).all(projectId, deviceId, projectId, deviceId, projectId, deviceId, projectId, deviceId) as { com_obj_ref_id: string }[];

  return {
    params: new Set(paramRows.map((r) => r.param_ref_id)),
    links: new Set(linkRows.map((r) => r.com_obj_ref_id)),
  };
}

// Discard a device's unprogrammed edits: restore the live params/links from the
// programmed baseline. Inverse of resetParamBase/resetLinkBase.
export function revertDevice(db: Database, projectId: string, deviceId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM device_parameters WHERE project_id = ? AND device_id = ?").run(projectId, deviceId);
    db.prepare(`INSERT INTO device_parameters (project_id, device_id, param_ref_id, value)
      SELECT project_id, device_id, param_ref_id, value FROM device_param_base WHERE project_id = ? AND device_id = ?`)
      .run(projectId, deviceId);
    db.prepare("DELETE FROM device_links WHERE project_id = ? AND device_id = ?").run(projectId, deviceId);
    db.prepare(`INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw)
      SELECT project_id, device_id, com_obj_ref_id, slot, ga_raw FROM device_link_base WHERE project_id = ? AND device_id = ?`)
      .run(projectId, deviceId);
  })();
}

// --- Read-back: adopt the device's measured state as the baseline ------------
// Replace a device's parameter/link baseline with values read off the bus. The
// caller passes a sparse map (rows that differ from the project plus the copied
// live rows), so the existing live-vs-base diff then flags exactly the drift.

export function replaceParamBase(db: Database, projectId: string, deviceId: string, values: Map<string, string>): void {
  db.transaction(() => {
    db.prepare("DELETE FROM device_param_base WHERE project_id = ? AND device_id = ?").run(projectId, deviceId);
    const ins = db.prepare("INSERT INTO device_param_base (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)");
    for (const [refId, value] of values) ins.run(projectId, deviceId, refId, value);
  })();
}

export function replaceLinkBase(db: Database, projectId: string, deviceId: string, links: Map<string, number[]>): void {
  db.transaction(() => {
    db.prepare("DELETE FROM device_link_base WHERE project_id = ? AND device_id = ?").run(projectId, deviceId);
    const ins = db.prepare("INSERT INTO device_link_base (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    for (const [refId, gaRaws] of links) gaRaws.forEach((raw, slot) => ins.run(projectId, deviceId, refId, slot, raw));
  })();
}

// Device associations the last read-back could not show (see readbackLinkBase); -1 for a device
// whose links have not been counted since the check was added, which only a read-back resolves.
export function setLinkBaseGaps(db: Database, projectId: string, deviceId: string, gaps: number): void {
  db.prepare("UPDATE devices SET link_base_gaps = ? WHERE project_id = ? AND instance_id = ?").run(gaps, projectId, deviceId);
}
export function getLinkBaseGaps(db: Database, projectId: string, deviceId: string): number {
  const r = db.query("SELECT link_base_gaps AS gaps FROM devices WHERE project_id = ? AND instance_id = ?").get(projectId, deviceId) as { gaps: number } | null;
  return r?.gaps ?? 0;
}

// After a write of the whole group tables the device holds no link outside `keep` (the refs the
// flash wrote, plus the project's own links on hidden objects): drop any other baseline row.
export function keepLinkBaseOnly(db: Database, projectId: string, deviceId: string, keep: Set<string>): void {
  const rows = db.query("SELECT DISTINCT com_obj_ref_id AS k FROM device_link_base WHERE project_id = ? AND device_id = ?").all(projectId, deviceId) as { k: string }[];
  const del = db.prepare("DELETE FROM device_link_base WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?");
  for (const { k } of rows) if (!keep.has(k)) del.run(projectId, deviceId, k);
}

// Discard one parameter's drift: set its live value back to the baseline (the
// value on the device). Deletes the live row if the baseline has none.
export function revertDeviceParam(db: Database, projectId: string, deviceId: string, refId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM device_parameters WHERE project_id = ? AND device_id = ? AND param_ref_id = ?").run(projectId, deviceId, refId);
    db.prepare(`INSERT INTO device_parameters (project_id, device_id, param_ref_id, value)
      SELECT project_id, device_id, param_ref_id, value FROM device_param_base
      WHERE project_id = ? AND device_id = ? AND param_ref_id = ?`).run(projectId, deviceId, refId);
  })();
}

// Discard one com-object's drift: set its live GA links back to the baseline.
export function revertDeviceLink(db: Database, projectId: string, deviceId: string, comObjRefId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM device_links WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?").run(projectId, deviceId, comObjRefId);
    db.prepare(`INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw)
      SELECT project_id, device_id, com_obj_ref_id, slot, ga_raw FROM device_link_base
      WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?`).run(projectId, deviceId, comObjRefId);
  })();
}

// Adopt the verified submission, never the desired values edited while a job was running.
// Unwritten refs retain their previous baseline, including when the submitted map is sparse.
export function resetParamBase(db: Database, projectId: string, deviceId: string, submitted: Map<string, string>, keepDrift = new Set<string>()): void {
  db.transaction(() => {
    const base = getDeviceParamBase(db, projectId, deviceId);
    const next = new Map(submitted);
    for (const ref of keepDrift) {
      const old = base.get(ref);
      if (old === undefined) next.delete(ref);
      else next.set(ref, old);
    }
    replaceParamBase(db, projectId, deviceId, next);
  })();
}

// Only adopted refs were represented in the written group tables. Hidden or unresolved
// links keep their previous baseline; absent submitted links clear the written ref.
export function resetLinkBase(db: Database, projectId: string, deviceId: string, comObjRefIds: string[], submitted: Map<string, number[]>): void {
  db.transaction(() => {
    const del = db.prepare("DELETE FROM device_link_base WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?");
    const ins = db.prepare("INSERT INTO device_link_base (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    for (const ref of comObjRefIds) {
      del.run(projectId, deviceId, ref);
      (submitted.get(ref) ?? []).forEach((raw, slot) => ins.run(projectId, deviceId, ref, slot, raw));
    }
  })();
}
