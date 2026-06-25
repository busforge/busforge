import { test, expect, describe } from "bun:test";
import { openDb } from "../src/db/schema.ts";
import {
  detectLevels, formatAddress, mainRangeBounds, midRangeBounds, gaRawInRange, maxSub,
  createGroupRange, renameGroupRange, deleteGroupRange,
  createGroupAddress, updateGroupAddress, deleteGroupAddress,
  countLinksForRaws, rangeLinkImpact,
} from "../src/db/groupedit.ts";
import { createSnapshot, restoreSnapshot } from "../src/db/snapshots.ts";
import type { Database } from "bun:sqlite";

// --- pure address math --------------------------------------------------------

describe("address math", () => {
  test("detectLevels from address segment counts", () => {
    expect(detectLevels([{ address: "0/0/1" }])).toBe(3);
    expect(detectLevels([{ address: "0/1" }])).toBe(2);
    expect(detectLevels([])).toBe(3); // default
  });

  test("formatAddress round-trips the bit grid", () => {
    expect(formatAddress(1, 3)).toBe("0/0/1");
    expect(formatAddress(256, 3)).toBe("0/1/0");
    expect(formatAddress(2048, 3)).toBe("1/0/0");
    expect(formatAddress(2048, 2)).toBe("1/0");
    expect(formatAddress(2049, 2)).toBe("1/1");
  });

  test("range bounds and ga raw", () => {
    expect(mainRangeBounds(1)).toEqual({ start: 2048, end: 4095 });
    expect(midRangeBounds(2048, 2)).toEqual({ start: 2560, end: 2815 }); // 1/2/x
    // 1-based parent start still aligns to the main block.
    expect(midRangeBounds(1, 0)).toEqual({ start: 0, end: 255 });
    expect(gaRawInRange(256, 5, 3)).toBe(261); // middle 1, sub 5 -> 0/1/5
    expect(gaRawInRange(2048, 5, 2)).toBe(2053);
    expect(maxSub(3)).toBe(255);
    expect(maxSub(2)).toBe(2047);
  });
});

// --- CRUD against a real (in-memory) DB ---------------------------------------

function seed(): { db: Database; pid: string } {
  const db = openDb(":memory:");
  const pid = "p1";
  db.prepare("INSERT INTO projects (id, name, imported_at, source_file) VALUES (?, 'P', 1, '')").run(pid);
  // Three-level: main "Licht" (0) > middle "Schalten" (0/0), with one GA 0/0/1.
  const main = Number(db.prepare("INSERT INTO group_ranges (project_id, parent_id, name, range_start, range_end) VALUES (?, NULL, 'Licht', 0, 2047)").run(pid).lastInsertRowid);
  const mid = Number(db.prepare("INSERT INTO group_ranges (project_id, parent_id, name, range_start, range_end) VALUES (?, ?, 'Schalten', 0, 255)").run(pid, main).lastInsertRowid);
  db.prepare("INSERT INTO group_addresses (project_id, range_id, raw, address, name, dpt) VALUES (?, ?, 1, '0/0/1', 'DG Decke', '1.001')").run(pid, mid);
  // A device link onto that GA, with a programmed baseline.
  db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer) VALUES (?, 'D1', '1.1.1', 'Dev', 'PR', 'AR', 1)").run(pid);
  db.prepare("INSERT INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, 'D1', 'O-1', 0, 1)").run(pid);
  db.prepare("INSERT INTO device_link_base (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, 'D1', 'O-1', 0, 1)").run(pid);
  return { db, pid };
}

const midId = (db: Database, pid: string) => (db.query("SELECT id FROM group_ranges WHERE project_id = ? AND name = 'Schalten'").get(pid) as { id: number }).id;
const mainId = (db: Database, pid: string) => (db.query("SELECT id FROM group_ranges WHERE project_id = ? AND name = 'Licht'").get(pid) as { id: number }).id;

describe("range CRUD", () => {
  test("create main + middle groups with derived bounds", () => {
    const { db, pid } = seed();
    const m = createGroupRange(db, pid, null, "Beschattung", 1);
    expect(db.query("SELECT range_start AS s, range_end AS e FROM group_ranges WHERE id = ?").get(m)).toEqual({ s: 2048, e: 4095 });
    const sub = createGroupRange(db, pid, m, "Fahren", 0);
    expect(db.query("SELECT range_start AS s, range_end AS e FROM group_ranges WHERE id = ?").get(sub)).toEqual({ s: 2048, e: 2303 });
  });

  test("rejects a colliding sibling number", () => {
    const { db, pid } = seed();
    expect(() => createGroupRange(db, pid, null, "Dup", 0)).toThrow(); // main 0 already = "Licht"
    expect(() => createGroupRange(db, pid, mainId(db, pid), "Dup", 0)).toThrow(); // middle 0 already = "Schalten"
  });

  test("rejects an out-of-range number", () => {
    const { db, pid } = seed();
    expect(() => createGroupRange(db, pid, null, "X", 99)).toThrow();
    expect(() => createGroupRange(db, pid, mainId(db, pid), "X", 8)).toThrow();
  });

  test("rejects a non-integer number and a middle under a middle", () => {
    const { db, pid } = seed();
    expect(() => createGroupRange(db, pid, null, "X", 1.5)).toThrow();
    // A middle group may only attach to a main group, never below another middle.
    expect(() => createGroupRange(db, pid, midId(db, pid), "X", 1)).toThrow();
  });

  test("rename", () => {
    const { db, pid } = seed();
    const id = midId(db, pid);
    expect(renameGroupRange(db, pid, id, "Schalten neu")).toBe(true);
    expect((db.query("SELECT name FROM group_ranges WHERE id = ?").get(id) as { name: string }).name).toBe("Schalten neu");
  });

  test("delete cascades children, addresses, and live links (baseline kept)", () => {
    const { db, pid } = seed();
    expect(deleteGroupRange(db, pid, mainId(db, pid))).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM group_ranges WHERE project_id = ?").get(pid)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM group_addresses WHERE project_id = ?").get(pid)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM device_links WHERE project_id = ?").get(pid)).toEqual({ n: 0 });
    // Programmed baseline stays, so the removal reads as drift until reflashed.
    expect(db.query("SELECT COUNT(*) AS n FROM device_link_base WHERE project_id = ?").get(pid)).toEqual({ n: 1 });
  });
});

describe("group-address CRUD", () => {
  test("create with derived raw + address", () => {
    const { db, pid } = seed();
    const r = createGroupAddress(db, pid, midId(db, pid), 2, "DG Flur", "1.001");
    expect(r).toEqual({ raw: 2, address: "0/0/2" });
  });

  test("rejects a duplicate address", () => {
    const { db, pid } = seed();
    expect(() => createGroupAddress(db, pid, midId(db, pid), 1, "Dup", "1.001")).toThrow();
  });

  test("rejects a non-integer sub and a non-leaf (main) range", () => {
    const { db, pid } = seed();
    expect(() => createGroupAddress(db, pid, midId(db, pid), 2.5, "X", "1.001")).toThrow();
    // The main range "Licht" has a child middle range, so it is not a leaf.
    expect(() => createGroupAddress(db, pid, mainId(db, pid), 5, "X", "1.001")).toThrow();
  });

  test("update name + dpt", () => {
    const { db, pid } = seed();
    expect(updateGroupAddress(db, pid, 1, "Neu", "1.002")).toBe(true);
    expect(db.query("SELECT name, dpt FROM group_addresses WHERE project_id = ? AND raw = 1").get(pid)).toEqual({ name: "Neu", dpt: "1.002" });
  });

  test("delete removes the GA and its live links", () => {
    const { db, pid } = seed();
    expect(deleteGroupAddress(db, pid, 1)).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM group_addresses WHERE project_id = ?").get(pid)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM device_links WHERE project_id = ?").get(pid)).toEqual({ n: 0 });
  });
});

describe("snapshot undo of structural edits", () => {
  test("restore brings back a deleted GA and its link", () => {
    const { db, pid } = seed();
    const snap = createSnapshot(db, pid, { kind: "manual", reason: "manual" }, 1)!;
    deleteGroupAddress(db, pid, 1);
    expect(db.query("SELECT COUNT(*) AS n FROM group_addresses WHERE project_id = ?").get(pid)).toEqual({ n: 0 });
    restoreSnapshot(db, pid, snap.id, 2);
    expect(db.query("SELECT name, address FROM group_addresses WHERE project_id = ? AND raw = 1").get(pid)).toEqual({ name: "DG Decke", address: "0/0/1" });
    expect(db.query("SELECT COUNT(*) AS n FROM device_links WHERE project_id = ? AND ga_raw = 1").get(pid)).toEqual({ n: 1 });
  });

  test("restore rebuilds a deleted range tree (FK order holds)", () => {
    const { db, pid } = seed();
    const snap = createSnapshot(db, pid, { kind: "manual", reason: "manual" }, 1)!;
    deleteGroupRange(db, pid, mainId(db, pid));
    restoreSnapshot(db, pid, snap.id, 2);
    expect(db.query("SELECT COUNT(*) AS n FROM group_ranges WHERE project_id = ?").get(pid)).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM group_addresses WHERE project_id = ?").get(pid)).toEqual({ n: 1 });
    // The middle range still points at its parent main range.
    const mid = db.query("SELECT parent_id AS p FROM group_ranges WHERE project_id = ? AND name = 'Schalten'").get(pid) as { p: number };
    expect(mid.p).toBe(mainId(db, pid));
  });
});

describe("link impact counts", () => {
  test("counts links onto the affected raws", () => {
    const { db, pid } = seed();
    expect(countLinksForRaws(db, pid, [1])).toBe(1);
    expect(countLinksForRaws(db, pid, [999])).toBe(0);
    expect(rangeLinkImpact(db, pid, mainId(db, pid))).toBe(1);
  });
});
