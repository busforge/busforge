import type { Database } from "bun:sqlite";
import { appProgramId } from "@busforge/project";
import { getAppProgram } from "./catalog.ts";

// A complete, portable, file-independent project artifact: the whole project
// (every instance table, including the programmed baselines and module instances)
// plus the referenced catalog application programs and DCA baggage. This is a
// superset of the snapshot serializer (which captures only the config layer).
// It is our own format, NOT KNX: we are import-only for .knxproj and do not
// re-export it. The bus log and snapshots are deliberately excluded (history,
// not project state). The exported artifact itself is a restore point.

export const EXPORT_VERSION = 1;

export interface ProjectExport {
  busforgeExport: number; // format version
  exportedAt: number;
  project: { name: string; interfaceIp: string; interfacePort: number };
  devices: { id: string; ia: string; name: string; productRef: string; appRef: string; manufacturer: number; comment: string }[];
  groupRanges: { id: number; parentId: number | null; name: string; rangeStart: number; rangeEnd: number }[];
  groupAddresses: { rangeId: number | null; raw: number; address: string; name: string; dpt: string }[];
  deviceParameters: { deviceId: string; paramRefId: string; value: string }[];
  deviceParamBase: { deviceId: string; paramRefId: string; value: string }[];
  deviceLinks: { deviceId: string; comObjRefId: string; slot: number; gaRaw: number }[];
  deviceLinkBase: { deviceId: string; comObjRefId: string; slot: number; gaRaw: number }[];
  deviceModules: { deviceId: string; instances: unknown }[];
  catalog: Record<string, string>; // appProgramId -> application-program XML
  baggage: { name: string; dataBase64: string }[];
}

const paramRows = (db: Database, table: string, projectId: string) =>
  db.query(`SELECT device_id AS deviceId, param_ref_id AS paramRefId, value FROM ${table} WHERE project_id = ? ORDER BY device_id, param_ref_id`)
    .all(projectId) as ProjectExport["deviceParameters"];
const linkRows = (db: Database, table: string, projectId: string) =>
  db.query(`SELECT device_id AS deviceId, com_obj_ref_id AS comObjRefId, slot, ga_raw AS gaRaw FROM ${table} WHERE project_id = ? ORDER BY device_id, com_obj_ref_id, slot`)
    .all(projectId) as ProjectExport["deviceLinks"];

// Serialize a whole project plus its referenced catalog. Returns null for an
// unknown project. The catalog is read from the DB; the caller is expected to
// have ensured it is populated (for legacy projects, by resolving each device's
// app program first, which backfills the catalog).
export function exportProject(db: Database, projectId: string, now: number): ProjectExport | null {
  const project = db.query("SELECT name, interface_ip AS interfaceIp, interface_port AS interfacePort FROM projects WHERE id = ?")
    .get(projectId) as ProjectExport["project"] | null;
  if (!project) return null;

  const devices = db.query("SELECT instance_id AS id, ia, name, product_ref AS productRef, app_ref AS appRef, manufacturer, comment FROM devices WHERE project_id = ? ORDER BY instance_id")
    .all(projectId) as ProjectExport["devices"];
  const groupRanges = db.query("SELECT id, parent_id AS parentId, name, range_start AS rangeStart, range_end AS rangeEnd FROM group_ranges WHERE project_id = ? ORDER BY id")
    .all(projectId) as ProjectExport["groupRanges"];
  const groupAddresses = db.query("SELECT range_id AS rangeId, raw, address, name, dpt FROM group_addresses WHERE project_id = ? ORDER BY raw")
    .all(projectId) as ProjectExport["groupAddresses"];
  const deviceModules = (db.query("SELECT device_id AS deviceId, instances FROM device_modules WHERE project_id = ? ORDER BY device_id")
    .all(projectId) as { deviceId: string; instances: string }[])
    .map((r) => ({ deviceId: r.deviceId, instances: JSON.parse(r.instances) as unknown }));

  // Referenced catalog: one entry per distinct application program the devices use.
  const catalog: Record<string, string> = {};
  for (const d of devices) {
    const cid = appProgramId(d.appRef);
    if (cid in catalog) continue;
    const xml = getAppProgram(db, cid);
    if (xml) catalog[cid] = xml;
  }

  const baggage = (db.query("SELECT name, data FROM device_baggage WHERE project_id = ? ORDER BY name")
    .all(projectId) as { name: string; data: Uint8Array }[])
    .map((r) => ({ name: r.name, dataBase64: Buffer.from(r.data).toString("base64") }));

  return {
    busforgeExport: EXPORT_VERSION,
    exportedAt: now,
    project,
    devices,
    groupRanges,
    groupAddresses,
    deviceParameters: paramRows(db, "device_parameters", projectId),
    deviceParamBase: paramRows(db, "device_param_base", projectId),
    deviceLinks: linkRows(db, "device_links", projectId),
    deviceLinkBase: linkRows(db, "device_link_base", projectId),
    deviceModules,
    catalog,
    baggage,
  };
}
