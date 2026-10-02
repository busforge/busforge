import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION } from "./schema.ts";
import type { GroupAddressSecurity } from "@busforge/project";
import { readProjectProperties, applyProjectProperties, type ProjectProperties } from "./projectProps.ts";
import { ApiError } from "../errors.ts";

// ETS-style restore points. A snapshot freezes the project's CONFIG layer only:
// the project properties (see projectProps.ts), parameter values, and
// group-address links/structure. The application-program model is resolved at
// runtime, and the programmed baselines describe the physical device, so neither
// belongs in a config restore point.

export type SnapshotKind = "manual" | "auto";
export type SnapshotReason = "manual" | "before-flash" | "before-flash-ga" | "before-download" | "before-restore" | "before-ga-edit" | "before-space-edit";

// Metadata for the history list (everything but the payload).
export interface SnapshotMeta {
  id: string;
  label: string;
  kind: SnapshotKind;
  reason: SnapshotReason;
  createdAt: number;
  schemaVersion: number;
}

// The frozen config layer. Stored as JSON in a single column. `groupRanges` and
// `groupAddresses` capture the group-address structure so structural edits
// (rename/add/delete of ranges and addresses) are undoable; older snapshots
// predate these fields, so restore treats them as optional.
export interface SnapshotPayload {
  project: ProjectProperties; // see projectProps.ts: the one shared definition
  deviceParameters: { deviceId: string; paramRefId: string; value: string }[];
  deviceLinks: { deviceId: string; comObjRefId: string; slot: number; gaRaw: number }[];
  groupRanges?: { id: number; parentId: number | null; name: string; rangeStart: number; rangeEnd: number }[];
  groupAddresses?: { id: number; rangeId: number | null; raw: number; address: string; name: string; dpt: string; security?: GroupAddressSecurity }[];
  // Building structure + device-to-space membership, so location edits (add/rename/
  // delete a space, move a device) are undoable. Optional: snapshots taken before
  // this capture leave the current structure in place on restore.
  spaces?: { id: number; parentId: number | null; extId: string; type: string; name: string; ord: number }[];
  spaceDevices?: { spaceId: number; deviceId: string }[];
}

// How many automatic snapshots to keep per project (ring buffer). Manual
// snapshots are never pruned.
const AUTO_KEEP = 20;

// Serialize the current config layer of a project into a snapshot payload.
export function serializeConfig(db: Database, projectId: string): SnapshotPayload {
  const project = readProjectProperties(db, projectId);
  if (!project) throw new ApiError("PROJECT_NOT_FOUND", `project ${projectId} not found`, 404);
  const deviceParameters = db.query("SELECT device_id AS deviceId, param_ref_id AS paramRefId, value FROM device_parameters WHERE project_id = ? ORDER BY device_id, param_ref_id")
    .all(projectId) as SnapshotPayload["deviceParameters"];
  const deviceLinks = db.query("SELECT device_id AS deviceId, com_obj_ref_id AS comObjRefId, slot, ga_raw AS gaRaw FROM device_links WHERE project_id = ? ORDER BY device_id, com_obj_ref_id, slot")
    .all(projectId) as SnapshotPayload["deviceLinks"];
  // Ordered by id so parent ranges precede their children on restore (FK-safe).
  const groupRanges = db.query("SELECT id, parent_id AS parentId, name, range_start AS rangeStart, range_end AS rangeEnd FROM group_ranges WHERE project_id = ? ORDER BY id")
    .all(projectId) as NonNullable<SnapshotPayload["groupRanges"]>;
  const groupAddresses = db.query("SELECT id, range_id AS rangeId, raw, address, name, dpt, security FROM group_addresses WHERE project_id = ? ORDER BY id")
    .all(projectId) as NonNullable<SnapshotPayload["groupAddresses"]>;
  // Ordered by id so a parent space precedes its children on restore (FK-safe).
  const spaces = db.query("SELECT id, parent_id AS parentId, ext_id AS extId, type, name, ord FROM spaces WHERE project_id = ? ORDER BY id")
    .all(projectId) as NonNullable<SnapshotPayload["spaces"]>;
  const spaceDevices = db.query("SELECT space_id AS spaceId, device_id AS deviceId FROM space_devices WHERE project_id = ? ORDER BY space_id, device_id")
    .all(projectId) as NonNullable<SnapshotPayload["spaceDevices"]>;
  return { project, deviceParameters, deviceLinks, groupRanges, groupAddresses, spaces, spaceDevices };
}

const rowToMeta = (r: { id: string; label: string; kind: string; reason: string; created_at: number; schema_version: number }): SnapshotMeta =>
  ({ id: r.id, label: r.label, kind: r.kind as SnapshotKind, reason: r.reason as SnapshotReason, createdAt: r.created_at, schemaVersion: r.schema_version });

export function listSnapshots(db: Database, projectId: string): SnapshotMeta[] {
  const rows = db.query("SELECT id, label, kind, reason, created_at, schema_version FROM snapshots WHERE project_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(projectId) as Parameters<typeof rowToMeta>[0][];
  return rows.map(rowToMeta);
}

// The most recent snapshot's payload (raw JSON string), used for dedup.
function latestPayload(db: Database, projectId: string): string | null {
  const r = db.query("SELECT payload FROM snapshots WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(projectId) as { payload: string } | null;
  return r?.payload ?? null;
}

// Insert a snapshot of the current config. Returns its metadata, or null when an
// automatic snapshot is skipped because it would be identical to the latest one
// (so repeated flashes without edits don't pile up noise). Manual snapshots are
// always stored. Auto snapshots are pruned to the ring-buffer size afterwards.
export function createSnapshot(
  db: Database, projectId: string,
  opts: { label?: string; kind: SnapshotKind; reason: SnapshotReason }, now: number,
): SnapshotMeta | null {
  return db.transaction(() => {
    const payload = JSON.stringify(serializeConfig(db, projectId));
    if (opts.kind === "auto" && latestPayload(db, projectId) === payload) return null;
    const id = randomUUID();
    db.prepare("INSERT INTO snapshots (id, project_id, label, kind, reason, created_at, schema_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, opts.label ?? "", opts.kind, opts.reason, now, SCHEMA_VERSION, payload);
    if (opts.kind === "auto") pruneAuto(db, projectId);
    return { id, label: opts.label ?? "", kind: opts.kind, reason: opts.reason, createdAt: now, schemaVersion: SCHEMA_VERSION };
  })();
}

// Drop the oldest automatic snapshots beyond the ring-buffer size. Manual
// snapshots are exempt.
function pruneAuto(db: Database, projectId: string): void {
  db.prepare(`
    DELETE FROM snapshots WHERE id IN (
      SELECT id FROM snapshots WHERE project_id = ? AND kind = 'auto'
      ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(projectId, AUTO_KEEP);
}

export function deleteSnapshot(db: Database, projectId: string, id: string): boolean {
  return db.prepare("DELETE FROM snapshots WHERE id = ? AND project_id = ?").run(id, projectId).changes > 0;
}

// Restore a snapshot: first capture the current state as an undo point, then
// rewrite the project's config layer (properties, params, links) from the
// payload. The programmed baselines are deliberately left untouched, so the
// post-restore change indicators still reflect drift against the device.
export function restoreSnapshot(db: Database, projectId: string, id: string, now: number): { ok: boolean; gaStructureRestored: boolean } {
  const row = db.query("SELECT payload, schema_version AS schemaVersion FROM snapshots WHERE id = ? AND project_id = ?")
    .get(id, projectId) as { payload: string; schemaVersion: number } | null;
  if (!row) return { ok: false, gaStructureRestored: false };
  // A restore point from a newer busforge (carried in a .busforge artifact) may hold configuration
  // this version does not know, which the restore below would drop without a word. Older ones are
  // restorable because every payload change so far only added optional fields; a change that is not
  // additive has to upgrade older payloads here, keyed on their schema version.
  if (row.schemaVersion > SCHEMA_VERSION) {
    throw new ApiError("SNAPSHOT_SCHEMA_NEWER", `this restore point was taken by a newer busforge (schema ${row.schemaVersion}, this one runs ${SCHEMA_VERSION}); restoring it could drop configuration this version does not know`, 409);
  }
  const payload = JSON.parse(row.payload) as SnapshotPayload;
  // Snapshots taken before GA-structure capture carry no group ranges/addresses, so the
  // restore leaves the current structure in place. Report that so the caller can tell the
  // user the group structure was NOT part of this restore point, instead of implying a
  // full rollback succeeded.
  const gaStructureRestored = !!(payload.groupRanges && payload.groupAddresses);
  db.transaction(() => {
    // Make the restore itself undoable.
    createSnapshot(db, projectId, { kind: "auto", reason: "before-restore" }, now);

    applyProjectProperties(db, projectId, payload.project);

    db.prepare("DELETE FROM device_parameters WHERE project_id = ?").run(projectId);
    const insParam = db.prepare("INSERT INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)");
    for (const p of payload.deviceParameters) insParam.run(projectId, p.deviceId, p.paramRefId, p.value);

    db.prepare("DELETE FROM device_links WHERE project_id = ?").run(projectId);
    const insLink = db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    for (const l of payload.deviceLinks) insLink.run(projectId, l.deviceId, l.comObjRefId, l.slot, l.gaRaw);

    // Group-address structure: only rewritten for snapshots that captured it. Ids are
    // NOT re-inserted verbatim: group_ranges.id / group_addresses.id are GLOBAL autoincrement
    // keys, and a snapshot carried inside a .busforge artifact holds the SOURCE db's ids, so
    // reusing them would collide with another project's rows in the importing db (and even in
    // the same db after rowid reuse). We let sqlite assign fresh ids and remap the payload's
    // parent/range references through an idMap (payload is id-ordered, so a parent is always
    // mapped before its child needs it), exactly as importProjectExport does for a live import.
    if (payload.groupRanges && payload.groupAddresses) {
      db.prepare("DELETE FROM group_addresses WHERE project_id = ?").run(projectId);
      db.prepare("DELETE FROM group_ranges WHERE project_id = ?").run(projectId);
      const rangeIdMap = new Map<number, number>(); // payload range id -> new row id
      const insRange = db.prepare("INSERT INTO group_ranges (project_id, parent_id, name, range_start, range_end) VALUES (?, ?, ?, ?, ?)");
      for (const r of payload.groupRanges) {
        const parent = r.parentId == null ? null : rangeIdMap.get(r.parentId) ?? null;
        const newId = Number(insRange.run(projectId, parent, r.name, r.rangeStart, r.rangeEnd).lastInsertRowid);
        rangeIdMap.set(r.id, newId);
      }
      const insGa = db.prepare("INSERT INTO group_addresses (project_id, range_id, raw, address, name, dpt, security) VALUES (?, ?, ?, ?, ?, ?, ?)");
      // A payload captured before the column existed holds only addresses that were 'auto'.
      for (const g of payload.groupAddresses) insGa.run(projectId, g.rangeId == null ? null : rangeIdMap.get(g.rangeId) ?? null, g.raw, g.address, g.name, g.dpt, g.security ?? "auto");
    }

    // Building structure: only rewritten for snapshots that captured it. spaces.id is a global
    // key too, so it is remapped on restore for the same reason as the group ranges above.
    if (payload.spaces && payload.spaceDevices) {
      db.prepare("DELETE FROM space_devices WHERE project_id = ?").run(projectId);
      db.prepare("DELETE FROM spaces WHERE project_id = ?").run(projectId);
      const spaceIdMap = new Map<number, number>(); // payload space id -> new row id
      const insSpace = db.prepare("INSERT INTO spaces (project_id, parent_id, ext_id, type, name, ord) VALUES (?, ?, ?, ?, ?, ?)");
      for (const s of payload.spaces) {
        const parent = s.parentId == null ? null : spaceIdMap.get(s.parentId) ?? null;
        const newId = Number(insSpace.run(projectId, parent, s.extId, s.type, s.name, s.ord).lastInsertRowid);
        spaceIdMap.set(s.id, newId);
      }
      const insSd = db.prepare("INSERT INTO space_devices (project_id, space_id, device_id) VALUES (?, ?, ?)");
      for (const sd of payload.spaceDevices) {
        const sid = spaceIdMap.get(sd.spaceId);
        if (sid !== undefined) insSd.run(projectId, sid, sd.deviceId);
      }
    }
  })();
  return { ok: true, gaStructureRestored };
}
