import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ApiError } from "../errors.ts";

// Editing the building structure (spaces) and device-to-space assignment. Spaces
// are pure project organisation (Building > Floor > Room > ...): they are NOT
// flashed to the bus, so these edits never touch a device's programmed state. A
// device belongs to at most one space, mirroring ETS.

interface SpaceRow { id: number; parentId: number | null; }

function getSpace(db: Database, projectId: string, id: number): SpaceRow | null {
  return db.query("SELECT id, parent_id AS parentId FROM spaces WHERE id = ? AND project_id = ?")
    .get(id, projectId) as SpaceRow | null;
}

// Create a space under `parentId` (or at the root when null). `type` is the ETS
// space type the UI offers per level (Building/Floor/Room/...); it is stored
// as-is. Returns the new row id. New spaces get a generated ext_id (they have no
// 0.xml origin) and sort after existing siblings.
export function createSpace(db: Database, projectId: string, parentId: number | null, type: string, name: string): number {
  if (parentId != null && !getSpace(db, projectId, parentId)) throw new ApiError("SPACE_NOT_FOUND", "parent space not found", 404);
  const ord = (db.query("SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM spaces WHERE project_id = ? AND parent_id IS ?")
    .get(projectId, parentId) as { next: number }).next;
  const r = db.prepare("INSERT INTO spaces (project_id, parent_id, ext_id, type, name, ord) VALUES (?, ?, ?, ?, ?, ?)")
    .run(projectId, parentId, `BF-${randomUUID()}`, type, name, ord);
  return Number(r.lastInsertRowid);
}

// Does the space exist? (cheap existence check used by route guards before the
// destructive delete captures its undo snapshot.)
export function spaceExists(db: Database, projectId: string, id: number): boolean {
  return !!getSpace(db, projectId, id);
}

export function renameSpace(db: Database, projectId: string, id: number, name: string): boolean {
  return db.prepare("UPDATE spaces SET name = ? WHERE id = ? AND project_id = ?").run(name, id, projectId).changes > 0;
}

// Delete a space and everything under it: child spaces and the space_devices
// membership rows go via ON DELETE CASCADE. The devices themselves are NOT
// deleted; they simply become unassigned (and reappear under "Unassigned").
export function deleteSpace(db: Database, projectId: string, id: number): boolean {
  if (!getSpace(db, projectId, id)) return false;
  return db.prepare("DELETE FROM spaces WHERE id = ? AND project_id = ?").run(id, projectId).changes > 0;
}

// How many devices sit in this space's subtree (the delete-confirm impact count).
export function spaceDeviceImpact(db: Database, projectId: string, id: number): number {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    const kids = db.query("SELECT id FROM spaces WHERE project_id = ? AND parent_id = ?").all(projectId, ids[i]) as { id: number }[];
    for (const k of kids) ids.push(k.id);
  }
  const placeholders = ids.map(() => "?").join(",");
  const r = db.query(`SELECT COUNT(*) AS n FROM space_devices WHERE project_id = ? AND space_id IN (${placeholders})`)
    .get(projectId, ...ids) as { n: number };
  return r.n;
}

// Assign a device to a space, or unassign it with spaceId null. A device is in at
// most one space, so any existing membership is cleared first. Returns false if
// the device is not in the project or the target space does not exist.
export function assignDeviceSpace(db: Database, projectId: string, deviceId: string, spaceId: number | null): boolean {
  if (!db.query("SELECT 1 FROM devices WHERE project_id = ? AND instance_id = ?").get(projectId, deviceId)) return false;
  if (spaceId != null && !getSpace(db, projectId, spaceId)) return false;
  return db.transaction(() => {
    db.prepare("DELETE FROM space_devices WHERE project_id = ? AND device_id = ?").run(projectId, deviceId);
    if (spaceId != null) db.prepare("INSERT INTO space_devices (project_id, space_id, device_id) VALUES (?, ?, ?)").run(projectId, spaceId, deviceId);
    return true;
  })();
}
