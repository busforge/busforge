import type { Database } from "bun:sqlite";
import type { ModuleInstance } from "@busforge/product";

// A device's stored parameter values (ParameterRef id -> value), seeded from the
// project at import and updated by the configuration UI.
export function getDeviceParams(db: Database, projectId: string, deviceId: string): Map<string, string> {
  const rows = db.query("SELECT param_ref_id AS refId, value FROM device_parameters WHERE project_id = ? AND device_id = ?")
    .all(projectId, deviceId) as { refId: string; value: string }[];
  return new Map(rows.map((r) => [r.refId, r.value]));
}

export function setDeviceParam(db: Database, projectId: string, deviceId: string, refId: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)")
    .run(projectId, deviceId, refId, value);
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

// Re-point a com-object to a set of group addresses (replaces its links).
export function setDeviceLink(db: Database, projectId: string, deviceId: string, comObjRefId: string, gaRaws: number[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM device_links WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?").run(projectId, deviceId, comObjRefId);
    const ins = db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    gaRaws.forEach((raw, slot) => ins.run(projectId, deviceId, comObjRefId, slot, raw));
  })();
}

export function getDeviceForFlash(db: Database, projectId: string, deviceId: string): { ia: string; appRef: string } | null {
  const r = db.query("SELECT ia, app_ref AS appRef FROM devices WHERE project_id = ? AND instance_id = ?")
    .get(projectId, deviceId) as { ia: string; appRef: string } | null;
  return r ?? null;
}

export function getSourceFile(db: Database, projectId: string): string | null {
  const r = db.query("SELECT source_file AS sourceFile FROM projects WHERE id = ?").get(projectId) as { sourceFile: string } | null;
  return r?.sourceFile ?? null;
}
