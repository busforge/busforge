import type { Database } from "bun:sqlite";
import { appProgramId, type SpaceNode } from "@busforge/project";
import { getAppProgram } from "./catalog.ts";
import { readSpaces } from "./projects.ts";
import { readProjectProperties, type ProjectProperties } from "./projectProps.ts";
import { open } from "../secrets.ts";
import { listGroupKeyRows } from "./groupKeys.ts";
import { listDeviceCertificateRows } from "./deviceCertificates.ts";
import type { TelegramSecurity } from "../telegram.ts";

// A complete, portable, file-independent project artifact: the whole project
// (every instance table, including the programmed baselines and module instances)
// plus the referenced catalog application programs and DCA baggage, the restore
// points (snapshots) and the recorded bus log. Everything that makes up the
// project travels with it. It is our own format, NOT KNX: we are import-only for
// .knxproj and do not re-export it. Local-only metadata (source_file path,
// imported_at) and the derived catalog_products rows are not carried; the latter
// are rebuilt from the devices on import.

export const EXPORT_VERSION = 1;

export interface ProjectExport {
  busforgeExport: number; // format version
  exportedAt: number;
  project: ProjectProperties; // see projectProps.ts: the one shared definition
  // linkBaseGaps: device associations the last read-back could not show (-1: not counted yet).
  // Optional so artifacts exported before it existed still import (as 0).
  devices: { id: string; ia: string; name: string; productRef: string; appRef: string; manufacturer: number; comment: string; linkBaseGaps?: number }[];
  groupRanges: { id: number; parentId: number | null; name: string; rangeStart: number; rangeEnd: number }[];
  // Building structure (0.xml <Locations>). Optional so artifacts exported before
  // it was carried still import (they re-import with no location grouping).
  spaces?: SpaceNode[];
  groupAddresses: { rangeId: number | null; raw: number; address: string; name: string; dpt: string }[];
  deviceParameters: { deviceId: string; paramRefId: string; value: string }[];
  deviceParamBase: { deviceId: string; paramRefId: string; value: string }[];
  deviceLinks: { deviceId: string; comObjRefId: string; slot: number; gaRaw: number }[];
  deviceLinkBase: { deviceId: string; comObjRefId: string; slot: number; gaRaw: number }[];
  deviceModules: { deviceId: string; instances: unknown }[];
  catalog: Record<string, string>; // appProgramId -> application-program XML
  baggage: { name: string; dataBase64: string }[];
  // Restore points and the recorded bus log. Optional so an artifact from before
  // these were added (a plain .busforge.json) still imports.
  snapshots?: { label: string; kind: string; reason: string; createdAt: number; schemaVersion: number; payload: string }[];
  telegrams?: { ts: number; src: string; dstRaw: number; kind: string; data: string; security?: TelegramSecurity }[];
  // KNX Data Secure tool keys. The keys are carried in CLEARTEXT here (base64),
  // unsealed from the master key, so the project is never separated from its keys.
  // The only protection is the .busforge container password; an unencrypted export
  // therefore exposes them, which the UI must warn about before exporting. Optional
  // so artifacts from before secure support still import. See docs/knx-secure.md.
  deviceSecurity?: { deviceId: string; toolKey: string; serialNumber: string; sequenceNumber: string; source: string }[];
  groupKeys?: { raw: number; key: string; source: string }[];
  deviceCertificates?: { deviceId: string; fdsk: string; serialNumber: string }[];
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
export function exportProject(db: Database, projectId: string, now: number, masterKey: Buffer): ProjectExport | null {
  const project = readProjectProperties(db, projectId);
  if (!project) return null;

  const devices = db.query("SELECT instance_id AS id, ia, name, product_ref AS productRef, app_ref AS appRef, manufacturer, comment, link_base_gaps AS linkBaseGaps FROM devices WHERE project_id = ? ORDER BY instance_id")
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

  // Restore points (full config-layer payloads) and the recorded bus log, in
  // chronological order so the re-imported project keeps the same history.
  const snapshots = db.query("SELECT label, kind, reason, created_at AS createdAt, schema_version AS schemaVersion, payload FROM snapshots WHERE project_id = ? ORDER BY created_at, rowid")
    .all(projectId) as ProjectExport["snapshots"];
  const telegrams = (db.query("SELECT ts, src, dst_raw AS dstRaw, kind, data, security FROM telegrams WHERE project_id = ? ORDER BY ts, id")
    .all(projectId) as (NonNullable<ProjectExport["telegrams"]>[number] & { security: TelegramSecurity | null })[])
    .map(({ security, ...t }) => (security ? { ...t, security } : t));

  // Tool keys, unsealed from the master key into cleartext base64 for portability
  // (the importing instance re-seals under its own master key). Carried always.
  const deviceSecurity = (db.query("SELECT device_id AS deviceId, tool_key AS toolKey, serial_number AS serialNumber, seq_group AS sequenceNumber, source FROM device_security WHERE project_id = ? ORDER BY device_id")
    .all(projectId) as { deviceId: string; toolKey: Uint8Array; serialNumber: Uint8Array; sequenceNumber: string; source: string }[])
    .map((r) => ({ deviceId: r.deviceId, toolKey: open(Buffer.from(r.toolKey), masterKey).toString("base64"), serialNumber: Buffer.from(r.serialNumber).toString("base64"), sequenceNumber: r.sequenceNumber, source: r.source }));

  const groupKeys = listGroupKeyRows(db, projectId).map((r) => ({ raw: r.raw, key: open(r.key, masterKey).toString("base64"), source: r.source }));
  const deviceCertificates = listDeviceCertificateRows(db, projectId).map((r) => ({ deviceId: r.deviceId, fdsk: open(r.fdsk, masterKey).toString("base64"), serialNumber: r.serialNumber.toString("base64") }));

  return {
    busforgeExport: EXPORT_VERSION,
    exportedAt: now,
    project,
    devices,
    groupRanges,
    spaces: readSpaces(db, projectId),
    groupAddresses,
    deviceParameters: paramRows(db, "device_parameters", projectId),
    deviceParamBase: paramRows(db, "device_param_base", projectId),
    deviceLinks: linkRows(db, "device_links", projectId),
    deviceLinkBase: linkRows(db, "device_link_base", projectId),
    deviceModules,
    catalog,
    baggage,
    snapshots,
    telegrams,
    deviceSecurity,
    groupKeys,
    deviceCertificates,
  };
}
