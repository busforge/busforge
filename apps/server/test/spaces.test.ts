import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProject } from "@busforge/project";
import { openDb } from "../src/db/schema.ts";
import { insertProject, getProject } from "../src/db/projects.ts";
import { createSpace, renameSpace, deleteSpace, spaceDeviceImpact, assignDeviceSpace } from "../src/db/spaceedit.ts";
import { createSnapshot, restoreSnapshot } from "../src/db/snapshots.ts";
import { exportProject } from "../src/db/exportProject.ts";
import { importProjectExport, validateExport } from "../src/db/importProject.ts";

// sample-0.xml carries a <Locations> block: Building "Haus" > Floor "Erdgeschoss"
// > Room "Küche" containing DI-1; DI-2 is left unassigned. The DB SpaceNode.id is
// the row id (a string), which the edit helpers address.
const xml0 = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-0.xml"), "utf8");

function freshProject() {
  const db = openDb(":memory:");
  insertProject(db, "P", parseProject(xml0, undefined, "x"), "", 1);
  return db;
}

describe("location structure: import + read", () => {
  test("rebuilds the space tree with device membership", () => {
    const db = freshProject();
    const p = getProject(db, "P")!;
    expect(p.locations).toHaveLength(1);
    const building = p.locations[0];
    expect(building).toMatchObject({ type: "Building", name: "Haus", deviceIds: [] });
    const room = building.children[0].children[0];
    expect(room).toMatchObject({ type: "Room", name: "Küche", deviceIds: ["P-TEST-0_DI-1"] });
    // The id is the DB row id, not the source 0.xml Space Id.
    expect(Number(room.id)).toBeGreaterThan(0);
  });
});

const ids = (db: import("bun:sqlite").Database) => {
  const p = getProject(db, "P")!;
  const building = p.locations[0];
  return { building: Number(building.id), floor: Number(building.children[0].id), room: Number(building.children[0].children[0].id) };
};

describe("space CRUD", () => {
  test("creates a child space under a parent", () => {
    const db = freshProject();
    const { floor } = ids(db);
    const id = createSpace(db, "P", floor, "Room", "Bad");
    const rooms = getProject(db, "P")!.locations[0].children[0].children.map((c) => c.name);
    expect(rooms).toContain("Bad");
    expect(id).toBeGreaterThan(0);
  });

  test("renames a space", () => {
    const db = freshProject();
    const { room } = ids(db);
    expect(renameSpace(db, "P", room, "Kochen")).toBe(true);
    expect(getProject(db, "P")!.locations[0].children[0].children[0].name).toBe("Kochen");
  });

  test("delete removes the subtree but leaves its devices (now unassigned)", () => {
    const db = freshProject();
    const { floor, room } = ids(db);
    expect(spaceDeviceImpact(db, "P", room)).toBe(1);
    expect(deleteSpace(db, "P", floor)).toBe(true); // deletes floor + Küche
    const p = getProject(db, "P")!;
    expect(p.locations[0].children).toHaveLength(0);
    expect(p.devices).toHaveLength(2); // the device itself survives
  });

  test("rejects a child under an unknown parent and reports a missing space", () => {
    const db = freshProject();
    expect(() => createSpace(db, "P", 9999, "Room", "Nope")).toThrow();
    expect(renameSpace(db, "P", 9999, "Nope")).toBe(false);
    expect(deleteSpace(db, "P", 9999)).toBe(false);
  });
});

describe("device assignment", () => {
  test("moves a device between spaces (one membership only)", () => {
    const db = freshProject();
    const { room } = ids(db);
    const bad = createSpace(db, "P", ids(db).floor, "Room", "Bad");
    expect(assignDeviceSpace(db, "P", "P-TEST-0_DI-1", bad)).toBe(true);
    const floor = getProject(db, "P")!.locations[0].children[0];
    expect(floor.children.find((c) => c.id === String(room))!.deviceIds).toEqual([]);
    expect(floor.children.find((c) => c.id === String(bad))!.deviceIds).toEqual(["P-TEST-0_DI-1"]);
  });

  test("assigns a previously unassigned device, and unassigns with null", () => {
    const db = freshProject();
    const { room } = ids(db);
    expect(assignDeviceSpace(db, "P", "P-TEST-0_DI-2", room)).toBe(true); // DI-2 had no space
    expect(getProject(db, "P")!.locations[0].children[0].children[0].deviceIds).toContain("P-TEST-0_DI-2");
    expect(assignDeviceSpace(db, "P", "P-TEST-0_DI-2", null)).toBe(true);
    expect(getProject(db, "P")!.locations[0].children[0].children[0].deviceIds).not.toContain("P-TEST-0_DI-2");
  });

  test("refuses an unknown device or space", () => {
    const db = freshProject();
    const { room } = ids(db);
    expect(assignDeviceSpace(db, "P", "NOPE", room)).toBe(false);
    expect(assignDeviceSpace(db, "P", "P-TEST-0_DI-1", 9999)).toBe(false);
  });
});

describe("snapshots capture + restore the building structure", () => {
  test("a restore rebuilds the spaces and memberships as they were", () => {
    const db = freshProject();
    const before = ids(db);
    createSnapshot(db, "P", { kind: "manual", reason: "manual" }, 10);
    const snap = db.query("SELECT id FROM snapshots WHERE project_id = 'P'").get() as { id: string };

    // Mutate: rename the room, move its device away, delete the floor.
    renameSpace(db, "P", before.room, "Kochen");
    deleteSpace(db, "P", before.floor);
    expect(getProject(db, "P")!.locations[0].children).toHaveLength(0);

    const res = restoreSnapshot(db, "P", snap.id, 20);
    expect(res.ok).toBe(true);
    const p = getProject(db, "P")!;
    const room = p.locations[0].children[0].children[0];
    expect(room).toMatchObject({ name: "Küche", deviceIds: ["P-TEST-0_DI-1"] });
  });
});

describe(".busforge export/import carries the structure", () => {
  test("re-imported project has the same tree and memberships", () => {
    const db = freshProject();
    const MK = Buffer.alloc(32, 1);
    const data = exportProject(db, "P", 5, MK)!;
    expect(data.spaces?.length).toBeGreaterThan(0);
    validateExport(data);
    importProjectExport(db, data, "P2", 6, MK);
    const re = getProject(db, "P2")!;
    expect(re.locations[0].name).toBe("Haus");
    expect(re.locations[0].children[0].children[0]).toMatchObject({ name: "Küche", deviceIds: ["P-TEST-0_DI-1"] });
  });

  test("the source 0.xml Space Id (extId) survives the round-trip, not a stale rowid", () => {
    // The old code exported readSpaces (id = rowid) and re-imported by writing node.id
    // into ext_id, replacing the real Space Id with a rowid string every round-trip. With
    // extId carried separately, the source id must come back unchanged after export+import.
    const db = freshProject();
    const MK = Buffer.alloc(32, 1);
    expect(getProject(db, "P")!.locations[0].extId).toBe("P-TEST-0_BP-1");
    const data = exportProject(db, "P", 5, MK)!;
    importProjectExport(db, data, "P2", 6, MK);
    const re = getProject(db, "P2")!;
    expect(re.locations[0].extId).toBe("P-TEST-0_BP-1"); // source id preserved
    expect(re.locations[0].extId).not.toBe(re.locations[0].id); // NOT the rowid
  });
});
