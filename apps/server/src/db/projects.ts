import type { Database } from "bun:sqlite";
import type { Project, Device, GroupAddress, GroupRangeNode } from "@busforge/project";

export interface ProjectSummary { id: string; name: string; deviceCount: number; gaCount: number; importedAt: number; }
export interface ProjectInterface { interfaceIp: string; port: number; }
export interface StoredProject {
  id: string;
  name: string;
  interface: ProjectInterface;
  devices: Device[];
  groupRanges: GroupRangeNode[];
  gaCount: number;
}

// Persist a freshly parsed project (rows only; the caller stores the source file).
export function insertProject(db: Database, id: string, project: Project, sourceFile: string, now: number): void {
  const insProject = db.prepare("INSERT INTO projects (id, name, imported_at, source_file) VALUES (?, ?, ?, ?)");
  const insDevice = db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insRange = db.prepare("INSERT INTO group_ranges (project_id, parent_id, name, range_start, range_end) VALUES (?, ?, ?, ?, ?)");
  const insGa = db.prepare("INSERT INTO group_addresses (project_id, range_id, raw, address, name, dpt) VALUES (?, ?, ?, ?, ?, ?)");
  const insParam = db.prepare("INSERT OR REPLACE INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)");

  const insertRange = (node: GroupRangeNode, parentId: number | null) => {
    const rangeId = Number(insRange.run(id, parentId, node.name, node.rangeStart, node.rangeEnd).lastInsertRowid);
    for (const g of node.addresses) insGa.run(id, rangeId, g.raw, g.address, g.name, g.dpt);
    for (const c of node.children) insertRange(c, rangeId);
  };

  db.transaction(() => {
    insProject.run(id, project.name, now, sourceFile);
    for (const d of project.devices) insDevice.run(id, d.id, d.ia, d.name, d.productRef, d.appRef, d.manufacturer);
    for (const r of project.groupRanges) insertRange(r, null);
    for (const dp of project.deviceParams) for (const v of dp.values) insParam.run(id, dp.deviceId, v.refId, v.value);
  })();
}

export function listProjects(db: Database): ProjectSummary[] {
  const rows = db.query(`
    SELECT p.id, p.name, p.imported_at AS importedAt,
      (SELECT COUNT(*) FROM devices d WHERE d.project_id = p.id) AS deviceCount,
      (SELECT COUNT(*) FROM group_addresses g WHERE g.project_id = p.id) AS gaCount
    FROM projects p ORDER BY p.imported_at DESC
  `).all() as ProjectSummary[];
  return rows;
}

export function getProject(db: Database, id: string): StoredProject | null {
  const p = db.query("SELECT id, name, interface_ip AS ip, interface_port AS port FROM projects WHERE id = ?").get(id) as
    | { id: string; name: string; ip: string; port: number } | null;
  if (!p) return null;

  const devices = db.query("SELECT instance_id AS id, ia, name, product_ref AS productRef, app_ref AS appRef, manufacturer FROM devices WHERE project_id = ? ORDER BY id").all(id) as Device[];

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

  return { id: p.id, name: p.name, interface: { interfaceIp: p.ip, port: p.port }, devices, groupRanges: roots, gaCount: gaRows.length };
}

export function deleteProject(db: Database, id: string): boolean {
  return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
}

export function getInterface(db: Database, id: string): ProjectInterface | null {
  const r = db.query("SELECT interface_ip AS interfaceIp, interface_port AS port FROM projects WHERE id = ?").get(id) as ProjectInterface | null;
  return r ?? null;
}

export function setInterface(db: Database, id: string, interfaceIp: string, port: number): boolean {
  return db.prepare("UPDATE projects SET interface_ip = ?, interface_port = ? WHERE id = ?").run(interfaceIp, port, id).changes > 0;
}
