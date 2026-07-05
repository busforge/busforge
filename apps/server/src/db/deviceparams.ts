import type { Database } from "bun:sqlite";
import type { ModuleInstance } from "@busforge/product";

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

// The application program ref for a device (to locate its app XML), and the
// project's stored source-file path.
export function getDeviceModules(db: Database, projectId: string, deviceId: string): ModuleInstance[] {
  const r = db.query("SELECT instances FROM device_modules WHERE project_id = ? AND device_id = ?")
    .get(projectId, deviceId) as { instances: string } | null;
  return r ? (JSON.parse(r.instances) as ModuleInstance[]) : [];
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

export function getDeviceForFlash(db: Database, projectId: string, deviceId: string): { ia: string; appRef: string; name: string } | null {
  const r = db.query("SELECT ia, app_ref AS appRef, name FROM devices WHERE project_id = ? AND instance_id = ?")
    .get(projectId, deviceId) as { ia: string; appRef: string; name: string } | null;
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

// Mark a device's parameters as programmed (baseline := current live values).
// `keepDrift` refs are exempt: their old baseline rows survive untouched. Used for
// params the flash can never write (memory-backed text/colour): adopting their live
// value into the baseline would clear a "changed" chip for a value that never reached
// the device.
export function resetParamBase(db: Database, projectId: string, deviceId: string, keepDrift?: Set<string>): void {
  const keep = [...(keepDrift ?? [])];
  const notIn = keep.length ? ` AND param_ref_id NOT IN (${keep.map(() => "?").join(",")})` : "";
  db.transaction(() => {
    db.prepare(`DELETE FROM device_param_base WHERE project_id = ? AND device_id = ?${notIn}`).run(projectId, deviceId, ...keep);
    db.prepare(`INSERT INTO device_param_base (project_id, device_id, param_ref_id, value)
      SELECT project_id, device_id, param_ref_id, value FROM device_parameters WHERE project_id = ? AND device_id = ?${notIn}`)
      .run(projectId, deviceId, ...keep);
  })();
}

// Mark a device's GA links as programmed (baseline := current live links).
// Re-baseline ONLY the com-object refs whose links were actually flashed to the device.
// A GA flash skips links whose com-object is not in the active view (hidden, or a module
// synthetic ref the flat tables cannot resolve); those were NOT written, so they must stay
// as drift rather than be adopted into the baseline (which would falsely report them in sync).
export function resetLinkBase(db: Database, projectId: string, deviceId: string, comObjRefIds: string[]): void {
  db.transaction(() => {
    const del = db.prepare("DELETE FROM device_link_base WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?");
    const ins = db.prepare(`INSERT INTO device_link_base (project_id, device_id, com_obj_ref_id, slot, ga_raw)
      SELECT project_id, device_id, com_obj_ref_id, slot, ga_raw FROM device_links WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?`);
    for (const ref of comObjRefIds) { del.run(projectId, deviceId, ref); ins.run(projectId, deviceId, ref); }
  })();
}
