import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Project, Device, GroupAddress, GroupRangeNode, CatalogProduct } from "@busforge/project";
import { getProjectChanges, type DeviceChanges } from "./deviceparams.ts";
import { getConnection, type Connection } from "./connections.ts";

// searchText is a server-built, lowercased blob (comment + user-entered text
// parameter values like channel/actuator names) so the device list can search
// deeper than the visible name/address.
export type DeviceWithChanges = Device & { changes: DeviceChanges; searchText: string };

export interface ProjectSummary { id: string; name: string; deviceCount: number; gaCount: number; snapshotCount: number; importedAt: number; }
export interface StoredProject {
  id: string;
  name: string;
  connectionId: string | null; // id of the saved connection in use, or null
  devices: DeviceWithChanges[];
  groupRanges: GroupRangeNode[];
  gaCount: number;
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
      (SELECT COUNT(*) FROM snapshots s WHERE s.project_id = p.id) AS snapshotCount
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

  return { id: p.id, name: p.name, connectionId: p.connectionId, devices, groupRanges: roots, gaCount: gaRows.length };
}

export function deleteProject(db: Database, id: string): boolean {
  return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
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
