import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Project, Device, GroupAddress, GroupRangeNode, CatalogProduct, SpaceNode } from "@busforge/project";
import { getProjectChanges, type DeviceChanges } from "./deviceparams.ts";
import { getConnection, type Connection } from "./connections.ts";

// searchText is a server-built, lowercased blob (comment + user-entered text
// parameter values like channel/actuator names) so the device list can search
// deeper than the visible name/address.
export type DeviceWithChanges = Device & { changes: DeviceChanges; searchText: string };

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
  devices: DeviceWithChanges[];
  groupRanges: GroupRangeNode[];
  locations: SpaceNode[];      // building structure (empty for projects without it)
  gaCount: number;
}

// Insert a project's location tree (depth-first, preserving order) into the
// `spaces`/`space_devices` tables. Shared by import and .busforge re-import so the
// recursive walk and the device-membership rows live in one place.
export function insertSpaces(db: Database, projectId: string, locations: SpaceNode[]): void {
  const insSpace = db.prepare("INSERT INTO spaces (project_id, parent_id, ext_id, type, name, ord) VALUES (?, ?, ?, ?, ?, ?)");
  const insSpaceDev = db.prepare("INSERT INTO space_devices (project_id, space_id, device_id) VALUES (?, ?, ?)");
  const walk = (node: SpaceNode, parentId: number | null, ord: number) => {
    const sid = Number(insSpace.run(projectId, parentId, node.id, node.type, node.name, ord).lastInsertRowid);
    for (const did of node.deviceIds) insSpaceDev.run(projectId, sid, did);
    node.children.forEach((c, i) => walk(c, sid, i));
  };
  locations.forEach((n, i) => walk(n, null, i));
}

// Rebuild a project's location tree (spaces parent_id adjacency + device
// membership). SpaceNode.id is the DB row id (as a string), which the edit/assign
// endpoints address; the source 0.xml Space Id stays in the ext_id column for
// provenance but is not needed by the client.
export function readSpaces(db: Database, projectId: string): SpaceNode[] {
  const rows = db.query("SELECT id, parent_id AS parentId, type, name FROM spaces WHERE project_id = ? ORDER BY ord, id")
    .all(projectId) as { id: number; parentId: number | null; type: string; name: string }[];
  const devRows = db.query("SELECT space_id AS spaceId, device_id AS deviceId FROM space_devices WHERE project_id = ? ORDER BY rowid")
    .all(projectId) as { spaceId: number; deviceId: string }[];
  const nodes = new Map<number, SpaceNode>();
  for (const r of rows) nodes.set(r.id, { id: String(r.id), type: r.type, name: r.name, deviceIds: [], children: [] });
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
  const insProject = db.prepare("INSERT INTO projects (id, name, imported_at, source_file) VALUES (?, ?, ?, ?)");
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

  db.transaction(() => {
    insProject.run(id, project.name, now, sourceFile);
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
  if (!ia) throw new Error("no free individual address in area 1");
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
  const p = db.query("SELECT id, name, connection_id AS connectionId FROM projects WHERE id = ?").get(id) as
    | { id: string; name: string; connectionId: string | null } | null;
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
  const devices: DeviceWithChanges[] = baseDevices.map((d) => ({
    ...d,
    changes: changes.get(d.id) ?? { params: 0, links: 0 },
    searchText: [d.comment, ...(paramText.get(d.id) ?? [])].filter(Boolean).join(" ").toLowerCase(),
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

  return { id: p.id, name: p.name, connectionId: p.connectionId, devices, groupRanges: roots, locations: readSpaces(db, id), gaCount: gaRows.length };
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
