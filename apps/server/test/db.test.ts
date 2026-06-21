import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProject } from "@busforge/project";
import { openDb } from "../src/db/schema.ts";
import { insertProject, listProjects, getProject, deleteProject, setInterface } from "../src/db/projects.ts";
import { insertTelegram, recentTelegrams, pruneTelegrams } from "../src/db/telegrams.ts";
import { decodeGroupTpdu } from "../src/telegram.ts";

const sampleXml = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "project", "test", "fixtures", "sample-0.xml"), "utf8");
const demo = () => parseProject(sampleXml, undefined, "Demo");
const fresh = () => openDb(":memory:");

describe("schema/migrations", () => {
  test("openDb is idempotent and sets user_version", () => {
    const db = fresh();
    const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBeGreaterThan(0);
    expect(() => db.query("SELECT * FROM telegrams").all()).not.toThrow();
  });
});

describe("projects", () => {
  test("insert then get rebuilds the parsed shape", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1.knxproj", 1000);
    const p = getProject(db, "p1")!;
    expect(p.name).toBe("Demo");
    expect(p.devices.map((d) => d.ia)).toEqual(["1.1.10", "1.1.11"]);
    expect(p.groupRanges[0].name).toBe("Licht");
    expect(p.groupRanges[0].children[0].name).toBe("Schalten");
    expect(p.groupRanges[0].children[0].addresses.map((g) => g.address)).toEqual(["0/0/1", "0/0/2"]);
    expect(p.gaCount).toBe(2);
  });

  test("list summarizes counts; get returns null for unknown", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    expect(listProjects(db)).toMatchObject([{ id: "p1", name: "Demo", deviceCount: 2, gaCount: 2 }]);
    expect(getProject(db, "ghost")).toBeNull();
  });

  test("interface update", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    expect(setInterface(db, "p1", "1.2.3.4", 3672)).toBe(true);
    expect(getProject(db, "p1")!.interface).toMatchObject({ interfaceIp: "1.2.3.4", port: 3672 });
  });

  test("delete cascades to children", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    insertTelegram(db, "p1", decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 5));
    expect(deleteProject(db, "p1")).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM devices").get()).toMatchObject({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM group_addresses").get()).toMatchObject({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM telegrams").get()).toMatchObject({ n: 0 });
  });
});

describe("telegrams", () => {
  test("recent returns oldest-first and joins the GA name", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    // GA 0/0/1 (raw 1) is "Kitchen On/Off" in the fixture.
    insertTelegram(db, "p1", decodeGroupTpdu(0x1232, 1, Buffer.from([0x00, 0x81]), 10));
    insertTelegram(db, "p1", decodeGroupTpdu(0x1232, 2, Buffer.from([0x00, 0x81]), 20));
    insertTelegram(db, "p1", decodeGroupTpdu(0x1232, 999, Buffer.from([0x00, 0x81]), 30)); // unknown GA
    const recent = recentTelegrams(db, "p1", 10);
    expect(recent.map((t) => t.ts)).toEqual([10, 20, 30]); // oldest first
    expect(recent[0]).toMatchObject({ dst: "0/0/1", name: "Kitchen On/Off" });
    expect(recent[2].name).toBeNull();
  });

  test("recent is scoped per project and honors the limit", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    insertProject(db, "p2", demo(), "/tmp/p2", 1000);
    insertTelegram(db, "p1", decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 1));
    insertTelegram(db, "p2", decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 2));
    expect(recentTelegrams(db, "p1", 10)).toHaveLength(1);
    expect(recentTelegrams(db, "p2", 10)).toHaveLength(1);

    for (let i = 0; i < 5; i++) insertTelegram(db, "p1", decodeGroupTpdu(0, i, Buffer.from([0x00, 0x81]), 100 + i));
    const limited = recentTelegrams(db, "p1", 3);
    expect(limited).toHaveLength(3);
    expect(limited.map((t) => t.ts)).toEqual([102, 103, 104]); // newest 3, oldest-first
  });

  test("prune drops telegrams older than the cutoff", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    insertTelegram(db, "p1", decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 100));
    insertTelegram(db, "p1", decodeGroupTpdu(0, 1, Buffer.from([0x00, 0x81]), 500));
    expect(pruneTelegrams(db, 300)).toBe(1);
    expect(recentTelegrams(db, "p1", 10).map((t) => t.ts)).toEqual([500]);
  });
});
