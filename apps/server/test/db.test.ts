import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseProject } from "@busforge/project";
import { openDb } from "../src/db/schema.ts";
import { insertProject, listProjects, getProject, deleteProject, setInterface } from "../src/db/projects.ts";
import { insertTelegram, recentTelegrams, pruneTelegrams } from "../src/db/telegrams.ts";
import { getDeviceModules, getDeviceLinks, setDeviceLink, getDeviceParams, setDeviceParam, getProjectChanges, resetParamBase, resetLinkBase } from "../src/db/deviceparams.ts";
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

  test("migrates an iteration-2 database in place (adds instance_id + device_parameters)", () => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-mig-"));
    const path = join(dir, "old.db");
    // Simulate an iteration-2 DB: devices without instance_id, at user_version 1.
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE devices (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, ia TEXT NOT NULL, name TEXT NOT NULL, product_ref TEXT NOT NULL, app_ref TEXT NOT NULL, manufacturer INTEGER NOT NULL);
      PRAGMA user_version = 1;`);
    old.close();

    const db = openDb(path); // should run the new migration: ALTER + device_parameters
    expect(() => db.query("SELECT instance_id FROM devices").all()).not.toThrow();
    expect(() => db.query("SELECT * FROM device_parameters").all()).not.toThrow();
    db.close();
    rmSync(dir, { recursive: true, force: true });
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

  test("seeds and reads a device's module instances", () => {
    const xml0 = `<?xml version="1.0" encoding="utf-8"?>
      <KNX xmlns="http://knx.org/xml/project/23"><Project Id="P"><Installations><Installation><Topology>
        <Area Address="1"><Line Address="1"><DeviceInstance Id="DI-9" Address="5" ProductRefId="M-X_H-1_P-1" Hardware2ProgramRefId="M-X_H-1_HP-1">
          <ModuleInstances>
            <ModuleInstance Id="MD-1_M-1_MI-1" RefId="MD-1_M-1"><Arguments>
              <Argument RefId="MD-1_A-1" Value="A" /><Argument RefId="MD-1_A-2" Value="10" />
            </Arguments></ModuleInstance>
          </ModuleInstances>
        </DeviceInstance></Line></Area>
      </Topology></Installation></Installations></Project></KNX>`;
    const proj = parseProject(xml0, undefined, "x");
    const db = fresh();
    insertProject(db, "p1", proj, "/tmp/p1", 1000);
    expect(getDeviceModules(db, "p1", "DI-9")).toEqual([
      { id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "A" }, { refId: "MD-1_A-2", value: "10" }] },
    ]);
    expect(getDeviceModules(db, "p1", "ghost")).toEqual([]);
  });

  test("device links round-trip and re-point replaces", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    // seeded from the fixture: DI-1 O-1_R-1 -> [1, 2]
    expect(getDeviceLinks(db, "p1", "P-TEST-0_DI-1").get("O-1_R-1")).toEqual([1, 2]);
    // re-point replaces the link (slot order preserved)
    setDeviceLink(db, "p1", "P-TEST-0_DI-1", "O-1_R-1", [9]);
    expect(getDeviceLinks(db, "p1", "P-TEST-0_DI-1").get("O-1_R-1")).toEqual([9]);
  });

  test("fresh import reports no per-device changes", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    for (const d of getProject(db, "p1")!.devices) expect(d.changes).toEqual({ params: 0, links: 0 });
  });

  test("tracks parameter changes and resets on flash", () => {
    const xml0 = `<?xml version="1.0" encoding="utf-8"?>
      <KNX xmlns="http://knx.org/xml/project/23"><Project Id="P"><Installations><Installation><Topology>
        <Area Address="1"><Line Address="1"><DeviceInstance Id="DI-9" Address="5" ProductRefId="M-X_H-1_P-1" Hardware2ProgramRefId="M-X_H-1_HP-1">
          <ParameterInstanceRefs>
            <ParameterInstanceRef RefId="M-X_A-1_P-1_R-1" Value="600" />
            <ParameterInstanceRef RefId="M-X_A-1_P-2_R-1" Value="1" />
          </ParameterInstanceRefs>
        </DeviceInstance></Line></Area>
      </Topology></Installation></Installations></Project></KNX>`;
    const db = fresh();
    insertProject(db, "p1", parseProject(xml0, undefined, "x"), "/tmp/p1", 1000);
    const dev = "DI-9";
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined(); // clean

    setDeviceParam(db, "p1", dev, "M-X_A-1_P-1_R-1", "60");
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ params: 1 });

    // Editing back to the baseline value is not a change.
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-1_R-1", "600");
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();

    // Flashing (baseline := current) clears the marker.
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-1_R-1", "60");
    resetParamBase(db, "p1", dev);
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();

    // A param edited from its DEFAULT (never seeded into the baseline, since
    // 0.xml is sparse) still counts as a change.
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ params: 1 });
  });

  test("tracks link changes and resets on flash", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1"; // seeded from the fixture: O-1_R-1 -> [1, 2]
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();

    setDeviceLink(db, "p1", dev, "O-1_R-1", [9]);
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ links: 1 });

    resetLinkBase(db, "p1", dev);
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();
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
  test("recent returns oldest-first with formatted dst", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    insertTelegram(db, "p1", decodeGroupTpdu(0x1232, 1, Buffer.from([0x00, 0x81]), 10));
    insertTelegram(db, "p1", decodeGroupTpdu(0x1232, 2, Buffer.from([0x00, 0x81]), 20));
    insertTelegram(db, "p1", decodeGroupTpdu(0x1232, 3, Buffer.from([0x00, 0x81]), 30));
    const recent = recentTelegrams(db, "p1", 10);
    expect(recent.map((t) => t.ts)).toEqual([10, 20, 30]); // oldest first
    expect(recent[0]).toMatchObject({ dst: "0/0/1", dstRaw: 1, kind: "GroupValueWrite" });
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
