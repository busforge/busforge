import type { Database } from "bun:sqlite";
import { appProgramId, type SpaceNode, type GroupAddressSecurity, type DeviceKnxIp } from "@busforge/project";
import { getDeviceKnxIp } from "./deviceparams.ts";
import { getAppProgram, listCatalogBaggage } from "./catalog.ts";
import { readSpaces, getProjectSource, type ImportSource } from "./projects.ts";
import { readProjectProperties, type ProjectProperties } from "./projectProps.ts";
import { open } from "../secrets.ts";
import { listGroupKeyRows } from "./groupKeys.ts";
import { listGroupSenders, listSendSequences } from "./groupSenders.ts";
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
  // neverProgrammed: optional, absent in artifacts from before it was kept (read as false).
  // securityBase: the fingerprint of the security object last verified on a Data Secure device; absent
  // when not known.
  devices: { id: string; ia: string; name: string; productRef: string; appRef: string; manufacturer: number; comment: string; linkBaseGaps?: number; neverProgrammed?: boolean; securityBase?: string }[];
  groupRanges: { id: number; parentId: number | null; name: string; rangeStart: number; rangeEnd: number }[];
  // Building structure (0.xml <Locations>). Optional so artifacts exported before
  // it was carried still import (they re-import with no location grouping).
  spaces?: SpaceNode[];
  groupAddresses: { rangeId: number | null; raw: number; address: string; name: string; dpt: string; security?: GroupAddressSecurity }[];
  deviceParameters: { deviceId: string; paramRefId: string; value: string }[];
  deviceParamBase: { deviceId: string; paramRefId: string; value: string }[];
  deviceLinks: { deviceId: string; comObjRefId: string; slot: number; gaRaw: number }[];
  deviceLinkBase: { deviceId: string; comObjRefId: string; slot: number; gaRaw: number }[];
  deviceModules: { deviceId: string; instances: unknown }[];
  // The com-object flags and priority the project sets per device (device_comobj_overrides), the
  // attributes as ETS stores them. Required: an artifact without it would write every object with its
  // application's flags.
  deviceComObjOverrides: { deviceId: string; seq: number; comObjRefId: string; attrs: Record<string, string> }[];
  // Their programmed baseline (device_comobj_override_base). Required, like the other baselines.
  deviceComObjOverrideBase: { deviceId: string; seq: number; comObjRefId: string; attrs: Record<string, string> }[];
  // Baseline values a read-back took as assumed, not proven (device_param_assumed; value null: the
  // parameter's default). Required, like the baselines they qualify.
  deviceParamAssumed: { deviceId: string; paramRefId: string; value: string | null }[];
  // A KNXnet/IP device's settings from the project (device_knxip, @busforge/project DeviceKnxIp). Optional so
  // artifacts from before they were kept still import; such a device's download that writes them is refused.
  deviceKnxIp?: DeviceKnxIp[];
  catalog: Record<string, string>; // appProgramId -> application-program XML
  // The images the carried programs' TypePicture parameters show (catalog_baggage). Optional so
  // artifacts from before they were kept still import, their pictures then not in the catalogue.
  catalogPictures?: { appProgramId: string; baggageId: string; name: string; dataBase64: string }[];
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
  groupSenders?: { gaRaw: number; ia: string; source: string }[];
  sendSequences?: { ia: string; last: string }[];
  deviceCertificates?: { deviceId: string; fdsk: string; serialNumber: string }[];
  // The file the project was first imported from (see ImportSource). Optional: absent for a project
  // created in busforge, and in artifacts from before it was carried.
  source?: ImportSource;
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
const overrideRows = (db: Database, table: "device_comobj_overrides" | "device_comobj_override_base", projectId: string) =>
  (db.query(`SELECT device_id AS deviceId, seq, com_obj_ref_id AS comObjRefId, attrs FROM ${table} WHERE project_id = ? ORDER BY device_id, seq`)
    .all(projectId) as { deviceId: string; seq: number; comObjRefId: string; attrs: string }[])
    .map((r) => ({ ...r, attrs: JSON.parse(r.attrs) as Record<string, string> }));

export function exportProject(db: Database, projectId: string, now: number, masterKey: Buffer): ProjectExport | null {
  const project = readProjectProperties(db, projectId);
  if (!project) return null;

  const devices = (db.query("SELECT instance_id AS id, ia, name, product_ref AS productRef, app_ref AS appRef, manufacturer, comment, link_base_gaps AS linkBaseGaps, never_programmed AS np, security_base AS sb FROM devices WHERE project_id = ? ORDER BY instance_id")
    .all(projectId) as (ProjectExport["devices"][number] & { np: number; sb: string | null })[])
    .map(({ np, sb, ...d }) => ({ ...d, ...(np ? { neverProgrammed: true } : {}), ...(sb ? { securityBase: sb } : {}) }));
  const groupRanges = db.query("SELECT id, parent_id AS parentId, name, range_start AS rangeStart, range_end AS rangeEnd FROM group_ranges WHERE project_id = ? ORDER BY id")
    .all(projectId) as ProjectExport["groupRanges"];
  const groupAddresses = db.query("SELECT range_id AS rangeId, raw, address, name, dpt, security FROM group_addresses WHERE project_id = ? ORDER BY raw")
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
  const catalogPictures = Object.keys(catalog).sort().flatMap((cid) => [...listCatalogBaggage(db, cid)].sort(([a], [b]) => a.localeCompare(b))
    .map(([baggageId, f]) => ({ appProgramId: cid, baggageId, name: f.name, dataBase64: f.data.toString("base64") })));

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

  const source = getProjectSource(db, projectId);
  const groupKeys = listGroupKeyRows(db, projectId).map((r) => ({ raw: r.raw, key: open(r.key, masterKey).toString("base64"), source: r.source }));
  const deviceCertificates = listDeviceCertificateRows(db, projectId).map((r) => ({ deviceId: r.deviceId, fdsk: open(r.fdsk, masterKey).toString("base64"), serialNumber: r.serialNumber.toString("base64") }));

  return {
    busforgeExport: EXPORT_VERSION,
    exportedAt: now,
    ...(source ? { source } : {}),
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
    deviceComObjOverrides: overrideRows(db, "device_comobj_overrides", projectId),
    deviceComObjOverrideBase: overrideRows(db, "device_comobj_override_base", projectId),
    deviceParamAssumed: db.query("SELECT device_id AS deviceId, param_ref_id AS paramRefId, value FROM device_param_assumed WHERE project_id = ? ORDER BY device_id, param_ref_id")
      .all(projectId) as ProjectExport["deviceParamAssumed"],
    deviceKnxIp: (db.query("SELECT device_id AS deviceId FROM device_knxip WHERE project_id = ? ORDER BY device_id").all(projectId) as { deviceId: string }[])
      .map(({ deviceId }) => ({ deviceId, ...getDeviceKnxIp(db, projectId, deviceId)! })),
    catalog,
    catalogPictures,
    baggage,
    snapshots,
    telegrams,
    deviceSecurity,
    groupKeys,
    groupSenders: listGroupSenders(db, projectId),
    sendSequences: listSendSequences(db, projectId),
    deviceCertificates,
  };
}
