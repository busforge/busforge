import type { Database } from "bun:sqlite";

// DCA baggage: the BinaryData/UserFiles blobs extracted from a project's inner
// archive at import (e.g. a DALI gateway's backup-store), stored per project and
// served to native DCA-replacement modules. The name is the slash-flattened
// baggage basename; a device's blobs are those whose name starts with its id.

export function putBaggage(db: Database, projectId: string, name: string, data: Buffer): void {
  db.prepare("INSERT OR REPLACE INTO device_baggage (project_id, name, data) VALUES (?, ?, ?)").run(projectId, name, data);
}

// Whether a project has any stored baggage. Lets a reader tell "DB is empty
// because this project genuinely has none" from "this is a pre-DB-baggage
// project" (which then falls back to the on-disk store).
export function projectHasBaggage(db: Database, projectId: string): boolean {
  return !!db.query("SELECT 1 FROM device_baggage WHERE project_id = ? LIMIT 1").get(projectId);
}

// A device's baggage blobs as { name: base64 }, matching the on-disk endpoint's
// shape. Filters by the device-id name prefix, as the file store did.
export function getDeviceBaggage(db: Database, projectId: string, deviceId: string): Record<string, string> {
  const rows = db.query("SELECT name, data FROM device_baggage WHERE project_id = ?").all(projectId) as { name: string; data: Uint8Array }[];
  const out: Record<string, string> = {};
  for (const r of rows) if (r.name.startsWith(`${deviceId}_`)) out[r.name] = Buffer.from(r.data).toString("base64");
  return out;
}
