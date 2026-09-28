import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Project, Device, GroupAddress, GroupRangeNode, CatalogProduct, SpaceNode } from "@busforge/project";
import type { Levels } from "@busforge/knx";
import { ApiError } from "../errors.ts";
import { getProjectChanges, type DeviceChanges } from "./deviceparams.ts";
import { getConnection, type Connection } from "./connections.ts";

// searchText is a server-built, lowercased blob (comment + user-entered text
// parameter values like channel/actuator names) so the device list can search
// deeper than the visible name/address.
export type DeviceWithChanges = Device & { changes: DeviceChanges; searchText: string; secure: boolean };

export interface ProjectSummary { id: string; name: string; deviceCount: number; gaCount: number; snapshotCount: number; buildingCount: number; floorCount: number; roomCount: number; importedAt: number; }

// Count location spaces by category for the dashboard's location axis. "rooms" is
// every space that is not a building or a floor (Room, Corridor, DistributionBoard,
// ...), i.e. the leaf places devices actually live. Works on the parsed tree (a
// .knxproj) and the exported tree (a .busforge), which share the SpaceNode shape.
export function countSpacesByType(locations: SpaceNode[]): { buildingCount: number; floorCount: number; roomCount: number } {
  let buildingCount = 0, floorCount = 0, roomCount = 0;
  const walk = (n: SpaceNode) => {
    if (n.type === "Building") buildingCount++;
    else if (n.type === "Floor") floorCount++;
    else roomCount++;
    n.children.forEach(walk);
  };
  locations.forEach(walk);
  return { buildingCount, floorCount, roomCount };
}
export interface StoredProject {
  id: string;
  name: string;
  connectionId: string | null; // id of the saved connection in use, or null
  groupAddressLevels: Levels;  // group-address style (2 or 3), so the UI formats without guessing
  devices: DeviceWithChanges[];
  groupRanges: GroupRangeNode[];
  locations: SpaceNode[];      // building structure (empty for projects without it)
  gaCount: number;
  secureDeviceCount: number;   // devices with a Data-Secure tool key or factory key in the store
  groupKeyCount: number;       // group addresses with a Data-Secure group key in the store
}

// Insert a project's location tree (depth-first, preserving order) into the
// `spaces`/`space_devices` tables. Shared by import and .busforge re-import so the
// recursive walk and the device-membership rows live in one place.
export function insertSpaces(db: Database, projectId: string, locations: SpaceNode[]): void {
  const insSpace = db.prepare("INSERT INTO spaces (project_id, parent_id, ext_id, type, name, ord) VALUES (?, ?, ?, ?, ?, ?)");
  const insSpaceDev = db.prepare("INSERT INTO space_devices (project_id, space_id, device_id) VALUES (?, ?, ?)");
  const walk = (node: SpaceNode, parentId: number | null, ord: number) => {
    // Persist the source 0.xml id (extId) as ext_id, NOT node.id: a stored tree's node.id
    // is the DB row id, so writing it would clobber the provenance on a .busforge round-trip.
    // (`?? ""` tolerates a pre-extId .busforge export whose payload lacks the field.)
    const sid = Number(insSpace.run(projectId, parentId, node.extId ?? "", node.type, node.name, ord).lastInsertRowid);
    for (const did of node.deviceIds) insSpaceDev.run(projectId, sid, did);
    node.children.forEach((c, i) => walk(c, sid, i));
  };
  locations.forEach((n, i) => walk(n, null, i));
}

// Rebuild a project's location tree (spaces parent_id adjacency + device
// membership). SpaceNode.id is the DB row id (as a string), which the edit/assign
// endpoints address; the source 0.xml Space Id is carried separately in extId
// (from the ext_id column) so it survives a .busforge export round-trip.
export function readSpaces(db: Database, projectId: string): SpaceNode[] {
  const rows = db.query("SELECT id, parent_id AS parentId, ext_id AS extId, type, name FROM spaces WHERE project_id = ? ORDER BY ord, id")
    .all(projectId) as { id: number; parentId: number | null; extId: string; type: string; name: string }[];
  const devRows = db.query("SELECT space_id AS spaceId, device_id AS deviceId FROM space_devices WHERE project_id = ? ORDER BY rowid")
    .all(projectId) as { spaceId: number; deviceId: string }[];
  const nodes = new Map<number, SpaceNode>();
  for (const r of rows) nodes.set(r.id, { id: String(r.id), extId: r.extId, type: r.type, name: r.name, deviceIds: [], children: [] });
  for (const d of devRows) nodes.get(d.spaceId)?.deviceIds.push(d.deviceId);
  const roots: SpaceNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    if (r.parentId == null) roots.push(node);
    else nodes.get(r.parentId)?.children.push(node);
  }
  return roots;
}

// Persist a freshly parsed project (rows only; the caller stores the source file).
export function insertProject(db: Database, id: string, project: Project, sourceFile: string, now: number): void {
  const insProject = db.prepare("INSERT INTO projects (id, name, imported_at, source_file, ga_levels) VALUES (?, ?, ?, ?, ?)");
  const insDevice = db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insRange = db.prepare("INSERT INTO group_ranges (project_id, parent_id, name, range_start, range_end) VALUES (?, ?, ?, ?, ?)");
  const insGa = db.prepare("INSERT INTO group_addresses (project_id, range_id, raw, address, name, dpt) VALUES (?, ?, ?, ?, ?, ?)");
  const insParam = db.prepare("INSERT OR REPLACE INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)");
  const insParamBase = db.prepare("INSERT OR REPLACE INTO device_param_base (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)");
  const insModules = db.prepare("INSERT INTO device_modules (project_id, device_id, instances) VALUES (?, ?, ?)");
  const insLink = db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
  const insLinkBase = db.prepare("INSERT INTO device_link_base (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");

  const insertRange = (node: GroupRangeNode, parentId: number | null) => {
    const rangeId = Number(insRange.run(id, parentId, node.name, node.rangeStart, node.rangeEnd).lastInsertRowid);
    for (const g of node.addresses) insGa.run(id, rangeId, g.raw, g.address, g.name, g.dpt);
    for (const c of node.children) insertRange(c, rangeId);
  };

  // Two DeviceInstances sharing an instance id would each insert a device row and then
  // merge their per-device config (device_parameters etc. join on device_id, last write
  // wins). Surface that as a coded refusal rather than importing a silently-merged device;
  // the partial UNIQUE index on (project_id, instance_id) is the storage-level backstop.
  const seenIds = new Set<string>();
  for (const d of project.devices) {
    if (seenIds.has(d.id)) throw new ApiError("DUPLICATE_DEVICE_INSTANCE", `two devices share the instance id ${d.id}`);
    seenIds.add(d.id);
  }

  db.transaction(() => {
    insProject.run(id, project.name, now, sourceFile, project.groupAddressLevels);
    for (const d of project.devices) insDevice.run(id, d.id, d.ia, d.name, d.productRef, d.appRef, d.manufacturer, d.comment);
    for (const r of project.groupRanges) insertRange(r, null);
    for (const dp of project.deviceParams) for (const v of dp.values) { insParam.run(id, dp.deviceId, v.refId, v.value); insParamBase.run(id, dp.deviceId, v.refId, v.value); }
    for (const dm of project.deviceModules) if (dm.instances.length) insModules.run(id, dm.deviceId, JSON.stringify(dm.instances));
    for (const dl of project.deviceLinks) for (const link of dl.links) link.gaRaws.forEach((raw, slot) => { insLink.run(id, dl.deviceId, link.comObjRefId, slot, raw); insLinkBase.run(id, dl.deviceId, link.comObjRefId, slot, raw); });
    insertSpaces(db, id, project.locations);
  })();
}

// Create an empty project (no devices/GAs), the starting point for authoring from
// the catalog. source_file is left empty, like an import (the DB is the store).
export function createProject(db: Database, id: string, name: string, now: number): void {
  db.prepare("INSERT INTO projects (id, name, imported_at, source_file) VALUES (?, ?, ?, '')").run(id, name, now);
}

// Place a catalog product into a project as a new device instance: allocate the
// next free individual address (area 1, scanning lines then device addresses) and
// a stable instance id, and insert the device row referencing the catalog. No
// parameter rows are seeded (absent == application defaults) and no baseline is
// written (the device is unprogrammed). Returns the new device's instance id + IA.
export function addDevice(db: Database, projectId: string, product: CatalogProduct, name: string): { id: string; ia: string } {
  const used = new Set(
    (db.query("SELECT ia FROM devices WHERE project_id = ?").all(projectId) as { ia: string }[])
      .map((r) => r.ia.split("."))
      .filter((p) => p[0] === "1")
      .map((p) => `${p[1]}.${p[2]}`),
  );
  let ia = "";
  for (let line = 1; line <= 15 && !ia; line++) {
    for (let addr = 1; addr <= 255; addr++) {
      if (!used.has(`${line}.${addr}`)) { ia = `1.${line}.${addr}`; break; }
    }
  }
  if (!ia) throw new ApiError("NO_FREE_IA", "no free individual address in area 1");
  const instanceId = `BF-${randomUUID()}`;
  db.prepare(
    "INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer, comment) VALUES (?, ?, ?, ?, ?, ?, ?, '')",
  ).run(projectId, instanceId, ia, name || product.name, product.productRef, product.appRef, product.manufacturer);
  return { id: instanceId, ia };
}

export function listProjects(db: Database): ProjectSummary[] {
  const rows = db.query(`
    SELECT p.id, p.name, p.imported_at AS importedAt,
      (SELECT COUNT(*) FROM devices d WHERE d.project_id = p.id) AS deviceCount,
      (SELECT COUNT(*) FROM group_addresses g WHERE g.project_id = p.id) AS gaCount,
      (SELECT COUNT(*) FROM snapshots s WHERE s.project_id = p.id) AS snapshotCount,
      (SELECT COUNT(*) FROM spaces s WHERE s.project_id = p.id AND s.type = 'Building') AS buildingCount,
      (SELECT COUNT(*) FROM spaces s WHERE s.project_id = p.id AND s.type = 'Floor') AS floorCount,
      (SELECT COUNT(*) FROM spaces s WHERE s.project_id = p.id AND s.type NOT IN ('Building', 'Floor')) AS roomCount
    FROM projects p ORDER BY p.imported_at DESC
  `).all() as ProjectSummary[];
  return rows;
}

export function getProject(db: Database, id: string): StoredProject | null {
  const p = db.query("SELECT id, name, connection_id AS connectionId, ga_levels AS groupAddressLevels FROM projects WHERE id = ?").get(id) as
    | { id: string; name: string; connectionId: string | null; groupAddressLevels: Levels } | null;
  if (!p) return null;

  const baseDevices = db.query("SELECT instance_id AS id, ia, name, product_ref AS productRef, app_ref AS appRef, manufacturer, comment FROM devices WHERE project_id = ? ORDER BY id").all(id) as Device[];
  const changes = getProjectChanges(db, id);

  // Per-device deep-search text: the user-entered text parameter values (channel
  // and actuator names) plus the device comment. Numeric/enum values (stored as
  // bare integers) are skipped so a search for "1" doesn't match everything.
  const paramText = new Map<string, Set<string>>();
  const paramRows = db.query("SELECT device_id AS deviceId, value FROM device_parameters WHERE project_id = ?").all(id) as { deviceId: string; value: string }[];
  for (const r of paramRows) {
    if (!/[a-z]/i.test(r.value)) continue;
    const set = paramText.get(r.deviceId) ?? new Set<string>();
    set.add(r.value);
    paramText.set(r.deviceId, set);
  }
  const secureIds = new Set((db.query("SELECT device_id AS id FROM device_security WHERE project_id = ?").all(id) as { id: string }[]).map((r) => r.id));
  const devices: DeviceWithChanges[] = baseDevices.map((d) => ({
    ...d,
    changes: changes.get(d.id) ?? { params: 0, links: 0 },
    searchText: [d.comment, ...(paramText.get(d.id) ?? [])].filter(Boolean).join(" ").toLowerCase(),
    secure: secureIds.has(d.id),
  }));

  const rangeRows = db.query("SELECT id, parent_id AS parentId, name, range_start AS rangeStart, range_end AS rangeEnd FROM group_ranges WHERE project_id = ? ORDER BY id").all(id) as
    { id: number; parentId: number | null; name: string; rangeStart: number; rangeEnd: number }[];
  const gaRows = db.query("SELECT range_id AS rangeId, raw, address, name, dpt FROM group_addresses WHERE project_id = ? ORDER BY raw").all(id) as
    ({ rangeId: number } & GroupAddress)[];

  // Rebuild the range tree (parent_id adjacency) and attach addresses.
  const nodes = new Map<number, GroupRangeNode>();
  for (const r of rangeRows) nodes.set(r.id, { id: String(r.id), name: r.name, rangeStart: r.rangeStart, rangeEnd: r.rangeEnd, children: [], addresses: [] });
  const roots: GroupRangeNode[] = [];
  for (const r of rangeRows) {
    const node = nodes.get(r.id)!;
    if (r.parentId == null) roots.push(node);
    else nodes.get(r.parentId)?.children.push(node);
  }
  for (const g of gaRows) {
    nodes.get(g.rangeId)?.addresses.push({ raw: g.raw, address: g.address, name: g.name, dpt: g.dpt });
  }

  // How many devices carry a Data-Secure tool key, so the UI can warn before an
  // unencrypted export leaks them in clear (and badge secure devices later).
  // Devices whose tool key or factory key (certificate) is stored: either one leaves in clear in an
  // export without a password.
  const secureDeviceCount = (db.query("SELECT COUNT(*) AS n FROM (SELECT device_id FROM device_security WHERE project_id = ?1 UNION SELECT device_id FROM device_certificates WHERE project_id = ?1)").get(id) as { n: number }).n;
  const groupKeyCount = (db.query("SELECT COUNT(*) AS n FROM group_keys WHERE project_id = ?").get(id) as { n: number }).n;

  return { id: p.id, name: p.name, connectionId: p.connectionId, groupAddressLevels: p.groupAddressLevels, devices, groupRanges: roots, locations: readSpaces(db, id), gaCount: gaRows.length, secureDeviceCount, groupKeyCount };
}

export function deleteProject(db: Database, id: string): boolean {
  return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
}

export function renameProject(db: Database, id: string, name: string): boolean {
  return db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id).changes > 0;
}

// A group address's identity for the details overlay: its address/name/dpt plus
// the readable range path (ancestor range names, top-down, e.g. ["virtuell",
// "Licht außen"]). Returns null if the project has no such group address.
export interface GaMeta { address: string; name: string; dpt: string; path: string[]; }
export function getGaMeta(db: Database, projectId: string, raw: number): GaMeta | null {
  const ga = db.query("SELECT address, name, dpt, range_id AS rangeId FROM group_addresses WHERE project_id = ? AND raw = ?")
    .get(projectId, raw) as { address: string; name: string; dpt: string; rangeId: number | null } | null;
  if (!ga) return null;
  // Walk parent_id up to the root, then reverse so the path reads top-down.
  const path: string[] = [];
  let id = ga.rangeId;
  while (id != null) {
    const r = db.query("SELECT name, parent_id AS parentId FROM group_ranges WHERE id = ? AND project_id = ?")
      .get(id, projectId) as { name: string; parentId: number | null } | null;
    if (!r) break;
    if (r.name) path.push(r.name);
    id = r.parentId;
  }
  return { address: ga.address, name: ga.name, dpt: ga.dpt, path: path.reverse() };
}

// The distinct application-program refs of a project's devices (used to make an
// export self-contained by resolving each program into the catalog first).
export function listDeviceAppRefs(db: Database, projectId: string): string[] {
  const rows = db.query("SELECT DISTINCT app_ref AS appRef FROM devices WHERE project_id = ?").all(projectId) as { appRef: string }[];
  return rows.map((r) => r.appRef);
}

// Does the project exist? (cheap existence check used by route guards.)
export function projectExists(db: Database, id: string): boolean {
  return !!db.query("SELECT 1 FROM projects WHERE id = ?").get(id);
}

// Resolve a project's active connection (the saved connection it references), or
// null when none is set or the referenced connection was deleted.
export function getProjectConnection(db: Database, id: string): Connection | null {
  const row = db.query("SELECT connection_id AS cid FROM projects WHERE id = ?").get(id) as { cid: string | null } | null;
  if (!row?.cid) return null;
  return getConnection(db, row.cid);
}

// Point a project at a saved connection (or clear it with null). Returns false if
// the project does not exist.
export function setProjectConnection(db: Database, id: string, connectionId: string | null): boolean {
  return db.prepare("UPDATE projects SET connection_id = ? WHERE id = ?").run(connectionId, id).changes > 0;
}

// Set a device's individual address: the address it SHOULD hold, which is what the assignment
// (POST .../assign-ia) then writes into the physical device. Commissioning is not possible
// without choosing the address, so this is part of it, not a nicety.
//
// Two devices in one project must not claim the same address, or the project itself describes a
// bus that cannot work. That is refused here rather than discovered on the bus. Changing the
// address does NOT touch the programmed baseline: the device on the bus still holds whatever it
// holds until an assignment actually moves it, and pretending otherwise would be the fake-green
// this codebase refuses.
export function setDeviceAddress(db: Database, projectId: string, deviceId: string, ia: string): { id: string; ia: string } {
  if (!/^(1[0-5]|[0-9])\.(1[0-5]|[0-9])\.(2[0-4][0-9]|25[0-5]|1?[0-9]?[0-9])$/.test(ia)) {
    throw new ApiError("IA_INVALID", `"${ia}" is not a valid individual address (area.line.device, e.g. 1.2.32)`);
  }
  const dev = db.query("SELECT instance_id FROM devices WHERE project_id = ? AND instance_id = ?").get(projectId, deviceId);
  if (!dev) throw new ApiError("DEVICE_NOT_FOUND", "device not found", 404);
  const taken = db.query("SELECT name FROM devices WHERE project_id = ? AND ia = ? AND instance_id != ?").get(projectId, ia, deviceId) as { name: string } | null;
  if (taken) throw new ApiError("IA_TAKEN", `${ia} is already used by "${taken.name}" in this project`);
  db.prepare("UPDATE devices SET ia = ? WHERE project_id = ? AND instance_id = ?").run(ia, projectId, deviceId);
  return { id: deviceId, ia };
}

// Rename a device row. The name is project bookkeeping and never reaches the hardware: a KNX
// device carries no name, only its individual address, so this touches nothing on the bus and
// nothing that was programmed. It matters after a device is replaced by different hardware,
// where the row keeps the old product's name (see replaceDeviceProduct) and would otherwise
// keep describing a device that is no longer there.
export function renameDevice(db: Database, projectId: string, deviceId: string, name: string): { id: string; name: string } {
  const changed = db.prepare("UPDATE devices SET name = ? WHERE project_id = ? AND instance_id = ?")
    .run(name, projectId, deviceId).changes;
  if (!changed) throw new ApiError("DEVICE_NOT_FOUND", "device not found", 404);
  return { id: deviceId, name };
}
