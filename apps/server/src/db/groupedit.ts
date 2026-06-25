import type { Database } from "bun:sqlite";
import { ApiError } from "../errors.ts";

// Editing the group-address structure (ranges and addresses). KNX group addresses
// are laid out on a fixed bit grid; the project's "level" count (two or three) is
// detected from existing addresses so the same code serves both styles without a
// stored style flag. All raw values are 16-bit (0..65535).
//
//   three-level:  main(5 bits) / middle(3 bits) / sub(8 bits)   -> "m/n/s"
//   two-level:    main(5 bits) / sub(11 bits)                    -> "m/s"

export type Levels = 2 | 3;
const MAIN_BLOCK = 2048; // raw span of one main group (2^11)
const MID_BLOCK = 256; //   raw span of one middle group (2^8)

export const MAX_MAIN = 31;
export const MAX_MID = 7;

// --- pure address math --------------------------------------------------------

// Detect the level count from existing addresses (segment count). Defaults to
// three-level (the common case) when there is nothing to learn from.
export function detectLevels(addresses: { address: string }[]): Levels {
  let max = 0;
  for (const a of addresses) max = Math.max(max, a.address.split("/").length);
  return max === 2 ? 2 : 3;
}

export function formatAddress(raw: number, levels: Levels): string {
  if (levels === 2) return `${raw >> 11}/${raw & 0x7ff}`;
  return `${raw >> 11}/${(raw >> 8) & 0x7}/${raw & 0xff}`;
}

// The raw span [start, end] of a main group.
export function mainRangeBounds(mainNumber: number): { start: number; end: number } {
  const start = mainNumber * MAIN_BLOCK;
  return { start, end: start + MAIN_BLOCK - 1 };
}

// The raw span [start, end] of a middle group, given its parent main group's
// start (aligned down to the main block, so a 1-based range start still works).
export function midRangeBounds(parentStart: number, midNumber: number): { start: number; end: number } {
  const mainBase = Math.floor(parentStart / MAIN_BLOCK) * MAIN_BLOCK;
  const start = mainBase + midNumber * MID_BLOCK;
  return { start, end: start + MID_BLOCK - 1 };
}

// The raw value of a group address inside a leaf range (a middle group for
// three-level, a main group for two-level), given the sub number.
export function gaRawInRange(rangeStart: number, sub: number, levels: Levels): number {
  const block = levels === 3 ? MID_BLOCK : MAIN_BLOCK;
  return Math.floor(rangeStart / block) * block + sub;
}

// Largest sub number a leaf range can hold (block size - 1).
export function maxSub(levels: Levels): number {
  return (levels === 3 ? MID_BLOCK : MAIN_BLOCK) - 1;
}

// --- DB queries ---------------------------------------------------------------

interface RangeRow { id: number; parentId: number | null; rangeStart: number; rangeEnd: number; }

function projectLevels(db: Database, projectId: string): Levels {
  const rows = db.query("SELECT address FROM group_addresses WHERE project_id = ? LIMIT 200").all(projectId) as { address: string }[];
  return detectLevels(rows);
}

function getRange(db: Database, projectId: string, id: number): RangeRow | null {
  return db.query("SELECT id, parent_id AS parentId, range_start AS rangeStart, range_end AS rangeEnd FROM group_ranges WHERE id = ? AND project_id = ?")
    .get(id, projectId) as RangeRow | null;
}

// All group-address raw values under a range, including those in descendant
// ranges (so deleting a main group reaches the addresses in its middle groups).
function gaRawsUnderRange(db: Database, projectId: string, rangeId: number): number[] {
  const ids = [rangeId];
  for (let i = 0; i < ids.length; i++) {
    const kids = db.query("SELECT id FROM group_ranges WHERE project_id = ? AND parent_id = ?").all(projectId, ids[i]) as { id: number }[];
    for (const k of kids) ids.push(k.id);
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.query(`SELECT raw FROM group_addresses WHERE project_id = ? AND range_id IN (${placeholders})`).all(projectId, ...ids) as { raw: number }[];
  return rows.map((r) => r.raw);
}

// --- range CRUD ---------------------------------------------------------------

// Create a (main or middle) group range. `parentId` null adds a main group at the
// given main number; otherwise a middle group at that number under the parent.
// Throws on an out-of-range number or a collision with an existing sibling range.
export function createGroupRange(db: Database, projectId: string, parentId: number | null, name: string, number: number): number {
  const levels = projectLevels(db, projectId);
  if (!Number.isInteger(number)) throw new ApiError("GA_NUMBER_INVALID", "number must be an integer");
  let bounds: { start: number; end: number };
  if (parentId == null) {
    if (number < 0 || number > MAX_MAIN) throw new ApiError("GA_NUMBER_INVALID", `main group must be 0..${MAX_MAIN}`);
    bounds = mainRangeBounds(number);
  } else {
    const parent = getRange(db, projectId, parentId);
    if (!parent) throw new ApiError("GA_RANGE_NOT_FOUND", "parent range not found", 404);
    if (levels !== 3) throw new ApiError("GA_NUMBER_INVALID", "this project has no middle-group level");
    // Middle groups attach to a main group only (no nesting below a middle).
    if (parent.parentId != null) throw new ApiError("GA_NUMBER_INVALID", "a middle group must be created under a main group");
    if (number < 0 || number > MAX_MID) throw new ApiError("GA_NUMBER_INVALID", `middle group must be 0..${MAX_MID}`);
    bounds = midRangeBounds(parent.rangeStart, number);
  }
  // Reject a range that overlaps an existing sibling (same parent).
  const siblings = db.query("SELECT range_start AS rangeStart, range_end AS rangeEnd FROM group_ranges WHERE project_id = ? AND parent_id IS ?")
    .all(projectId, parentId) as { rangeStart: number; rangeEnd: number }[];
  if (siblings.some((s) => bounds.start <= s.rangeEnd && s.rangeStart <= bounds.end))
    throw new ApiError("GA_RANGE_TAKEN", "a range with that number already exists here");
  const r = db.prepare("INSERT INTO group_ranges (project_id, parent_id, name, range_start, range_end) VALUES (?, ?, ?, ?, ?)")
    .run(projectId, parentId, name, bounds.start, bounds.end);
  return Number(r.lastInsertRowid);
}

export function renameGroupRange(db: Database, projectId: string, id: number, name: string): boolean {
  return db.prepare("UPDATE group_ranges SET name = ? WHERE id = ? AND project_id = ?").run(name, id, projectId).changes > 0;
}

// Delete a range and everything under it: child ranges and group addresses go via
// ON DELETE CASCADE; the live device links to those addresses (which have no FK to
// the GA row) are removed here so no device keeps a dangling assignment. The
// programmed link baseline is left intact, so the removal shows up as drift and is
// applied on the next flash.
export function deleteGroupRange(db: Database, projectId: string, id: number): boolean {
  return db.transaction(() => {
    if (!getRange(db, projectId, id)) return false;
    const raws = gaRawsUnderRange(db, projectId, id);
    deleteLinksForRaws(db, projectId, raws);
    db.prepare("DELETE FROM group_ranges WHERE id = ? AND project_id = ?").run(id, projectId);
    return true;
  })();
}

// --- group-address CRUD -------------------------------------------------------

// Create a group address inside a leaf range at the given sub number. Throws on an
// out-of-range sub or a raw that already exists in the project.
export function createGroupAddress(db: Database, projectId: string, rangeId: number, sub: number, name: string, dpt: string): { raw: number; address: string } {
  const levels = projectLevels(db, projectId);
  const range = getRange(db, projectId, rangeId);
  if (!range) throw new ApiError("GA_RANGE_NOT_FOUND", "range not found", 404);
  // Addresses live in leaf ranges (a middle group in three-level, a main group in
  // two-level). Reject a range that still has child ranges, which would otherwise
  // place the address in the wrong block.
  const hasChildren = db.query("SELECT 1 FROM group_ranges WHERE project_id = ? AND parent_id = ? LIMIT 1").get(projectId, rangeId);
  if (hasChildren) throw new ApiError("GA_RANGE_NOT_LEAF", "add addresses to a middle group, not a main group");
  if (!Number.isInteger(sub) || sub < 0 || sub > maxSub(levels)) throw new ApiError("GA_NUMBER_INVALID", `address number must be 0..${maxSub(levels)}`);
  const raw = gaRawInRange(range.rangeStart, sub, levels);
  const exists = db.query("SELECT 1 FROM group_addresses WHERE project_id = ? AND raw = ?").get(projectId, raw);
  if (exists) throw new ApiError("GA_ADDRESS_TAKEN", "that address is already in use");
  const address = formatAddress(raw, levels);
  db.prepare("INSERT INTO group_addresses (project_id, range_id, raw, address, name, dpt) VALUES (?, ?, ?, ?, ?, ?)")
    .run(projectId, rangeId, raw, address, name, dpt);
  return { raw, address };
}

export function updateGroupAddress(db: Database, projectId: string, raw: number, name: string, dpt: string): boolean {
  return db.prepare("UPDATE group_addresses SET name = ?, dpt = ? WHERE project_id = ? AND raw = ?").run(name, dpt, projectId, raw).changes > 0;
}

// Delete a group address and remove the live device links pointing at it (see
// deleteGroupRange for why the baseline is left untouched).
export function deleteGroupAddress(db: Database, projectId: string, raw: number): boolean {
  return db.transaction(() => {
    const r = db.prepare("DELETE FROM group_addresses WHERE project_id = ? AND raw = ?").run(projectId, raw);
    if (r.changes === 0) return false;
    deleteLinksForRaws(db, projectId, [raw]);
    return true;
  })();
}

// How many live device links point at any of these raws (for the delete-confirm
// impact count shown to the user before they commit).
export function countLinksForRaws(db: Database, projectId: string, raws: number[]): number {
  if (raws.length === 0) return 0;
  const placeholders = raws.map(() => "?").join(",");
  const r = db.query(`SELECT COUNT(*) AS n FROM device_links WHERE project_id = ? AND ga_raw IN (${placeholders})`).get(projectId, ...raws) as { n: number };
  return r.n;
}

export function rangeLinkImpact(db: Database, projectId: string, rangeId: number): number {
  return countLinksForRaws(db, projectId, gaRawsUnderRange(db, projectId, rangeId));
}

function deleteLinksForRaws(db: Database, projectId: string, raws: number[]): void {
  if (raws.length === 0) return;
  const placeholders = raws.map(() => "?").join(",");
  db.prepare(`DELETE FROM device_links WHERE project_id = ? AND ga_raw IN (${placeholders})`).run(projectId, ...raws);
}
