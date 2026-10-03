import type { Database } from "bun:sqlite";
import { readBaggage } from "@busforge/project";
import { ApiError } from "../errors.ts";

// DCA baggage: the BinaryData/UserFiles blobs extracted from a project's inner
// archive at import (e.g. a DALI gateway's backup-store), stored per project and
// served to native DCA-replacement modules. The name is the slash-flattened
// baggage basename; a device's blobs are those whose name starts with its id.

const MiB = 1024 * 1024;
export const BAGGAGE_BLOB_LIMIT = 32 * MiB;
export const BAGGAGE_PROJECT_LIMIT = 128 * MiB;

// Refuse an import whose baggage would not fit the limits, before anything is stored: every blob
// sits in one SQLite row and is read whole into memory when a device's baggage is served.
export function checkBaggageSize(blobs: Iterable<{ name: string; bytes: number }>): void {
  let total = 0;
  for (const b of blobs) {
    if (b.bytes > BAGGAGE_BLOB_LIMIT) {
      throw new ApiError("BAGGAGE_TOO_LARGE", `embedded file ${b.name} is ${b.bytes} bytes, over the ${BAGGAGE_BLOB_LIMIT}-byte limit per file`, 413);
    }
    total += b.bytes;
  }
  if (total > BAGGAGE_PROJECT_LIMIT) {
    throw new ApiError("BAGGAGE_TOO_LARGE", `embedded files total ${total} bytes, over the ${BAGGAGE_PROJECT_LIMIT}-byte limit per project`, 413);
  }
}

// A .knxproj's baggage, refused when it is over the limits. Unreadable baggage does not block an
// import; the caller reports it (baggageUnreadable) so the loss is not silent.
export function readCheckedBaggage(bytes: Buffer, password: string | undefined): { baggage: Map<string, Buffer>; baggageUnreadable: boolean } {
  let baggage = new Map<string, Buffer>();
  let baggageUnreadable = false;
  try { baggage = readBaggage(bytes, password); } catch { baggageUnreadable = true; }
  checkBaggageSize([...baggage].map(([name, buf]) => ({ name, bytes: buf.length })));
  return { baggage, baggageUnreadable };
}

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
