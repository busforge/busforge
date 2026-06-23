import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseProject } from "@busforge/project";
import { openDb } from "../src/db/schema.ts";
import { insertProject, listProjects, getProject, deleteProject, setInterface } from "../src/db/projects.ts";
import { insertTelegram, recentTelegrams, pruneTelegrams } from "../src/db/telegrams.ts";
import { getDeviceModules, getDeviceLinks, setDeviceLink, getDeviceParams, setDeviceParam, getProjectChanges, getDeviceChangedKeys, revertDevice, revertDeviceParam, revertDeviceLink, replaceParamBase, replaceLinkBase, resetParamBase, resetLinkBase } from "../src/db/deviceparams.ts";
import { serializeConfig, createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from "../src/db/snapshots.ts";
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

  test("flags the exact edited rows", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1";
    expect(getDeviceChangedKeys(db, "p1", dev)).toMatchObject({ params: new Set(), links: new Set() });

    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7"); // edited from default
    setDeviceLink(db, "p1", dev, "O-1_R-1", [9]);          // re-pointed link
    const changed = getDeviceChangedKeys(db, "p1", dev);
    expect(changed.params.has("M-X_A-1_P-9_R-1")).toBe(true);
    expect(changed.links.has("O-1_R-1")).toBe(true);
    expect(changed.params.size).toBe(1);
    expect(changed.links.size).toBe(1);
  });

  test("revert restores params and links to the baseline", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1"; // baseline link O-1_R-1 -> [1, 2]
    const baseLinks = getDeviceLinks(db, "p1", dev).get("O-1_R-1");

    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    setDeviceLink(db, "p1", dev, "O-1_R-1", [9]);
    expect(getProjectChanges(db, "p1").get(dev)).toBeDefined();

    revertDevice(db, "p1", dev);
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();
    expect(getDeviceParams(db, "p1", dev).has("M-X_A-1_P-9_R-1")).toBe(false); // edited-from-default row removed
    expect(getDeviceLinks(db, "p1", dev).get("O-1_R-1")).toEqual(baseLinks);    // link set restored
  });

  test("read-back baseline surfaces param drift; per-row revert adopts the device value", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1";
    // Simulate a read-back result: the device drifted on a default param. The
    // baseline is the live rows plus that override (what the server stores).
    const base = new Map(getDeviceParams(db, "p1", dev));
    base.set("M-X_A-1_P-9_R-1", "7");
    replaceParamBase(db, "p1", dev, base);

    const changed = getDeviceChangedKeys(db, "p1", dev);
    expect(changed.params.has("M-X_A-1_P-9_R-1")).toBe(true);
    expect(changed.params.size).toBe(1);

    revertDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1"); // adopt the device value
    expect(getDeviceParams(db, "p1", dev).get("M-X_A-1_P-9_R-1")).toBe("7");
    expect(getDeviceChangedKeys(db, "p1", dev).params.size).toBe(0);
  });

  test("read-back baseline surfaces link drift; per-row revert adopts the device links", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1"; // baseline link O-1_R-1 -> [1, 2]
    const base = new Map(getDeviceLinks(db, "p1", dev));
    base.set("O-1_R-1", [9]); // device points the com-object at a different GA
    replaceLinkBase(db, "p1", dev, base);

    expect(getDeviceChangedKeys(db, "p1", dev).links.has("O-1_R-1")).toBe(true);

    revertDeviceLink(db, "p1", dev, "O-1_R-1");
    expect(getDeviceLinks(db, "p1", dev).get("O-1_R-1")).toEqual([9]);
    expect(getDeviceChangedKeys(db, "p1", dev).links.size).toBe(0);
  });

  test("device searchText indexes text params, skips numbers", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1";
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-50_R-1", "Wohnzimmer Heizung");
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-51_R-1", "600");
    const d = getProject(db, "p1")!.devices.find((x) => x.id === dev)!;
    expect(d.searchText).toContain("wohnzimmer heizung"); // user-entered channel name
    expect(d.searchText).not.toContain("600");            // bare numeric value skipped
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

describe("snapshots", () => {
  const dev = "P-TEST-0_DI-1"; // demo fixture: link O-1_R-1 -> [1, 2]

  test("serialize captures params, links and project meta", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    setInterface(db, "p1", "203.0.113.15", 3672);
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    const cfg = serializeConfig(db, "p1");
    expect(cfg.project).toMatchObject({ name: "Demo", interfaceIp: "203.0.113.15", interfacePort: 3672 });
    expect(cfg.deviceParameters).toContainEqual({ deviceId: dev, paramRefId: "M-X_A-1_P-9_R-1", value: "7" });
    expect(cfg.deviceLinks).toContainEqual({ deviceId: dev, comObjRefId: "O-1_R-1", slot: 0, gaRaw: 1 });
  });

  test("restore rolls the config back to a captured point", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const base = createSnapshot(db, "p1", { kind: "manual", label: "base", reason: "manual" }, 1000)!;
    expect(base.label).toBe("base");

    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    setDeviceLink(db, "p1", dev, "O-1_R-1", [9]);
    expect(getProjectChanges(db, "p1").get(dev)).toBeDefined();

    expect(restoreSnapshot(db, "p1", base.id, 2000)).toBe(true);
    expect(getDeviceParams(db, "p1", dev).has("M-X_A-1_P-9_R-1")).toBe(false); // edit gone
    expect(getDeviceLinks(db, "p1", dev).get("O-1_R-1")).toEqual([1, 2]);        // link restored
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();               // matches baseline again
  });

  test("restore is undoable: it first captures the current state", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const base = createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 1000)!;
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");

    restoreSnapshot(db, "p1", base.id, 2000);
    const list = listSnapshots(db, "p1");
    const undo = list.find((s) => s.reason === "before-restore")!;
    expect(undo).toBeDefined();
    // The undo point holds the edited value; restoring it brings the edit back.
    restoreSnapshot(db, "p1", undo.id, 3000);
    expect(getDeviceParams(db, "p1", dev).get("M-X_A-1_P-9_R-1")).toBe("7");
  });

  test("restore leaves the programmed baseline untouched (drift stays truthful)", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const clean = createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 1000)!;
    // Program a value: baseline := edited. Then restore the clean snapshot.
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    resetParamBase(db, "p1", dev);
    restoreSnapshot(db, "p1", clean.id, 2000);
    // Live is back to clean, but the baseline still says "7", so it shows as drift.
    expect(getDeviceParams(db, "p1", dev).has("M-X_A-1_P-9_R-1")).toBe(false);
    expect(getDeviceChangedKeys(db, "p1", dev).params.has("M-X_A-1_P-9_R-1")).toBe(true);
  });

  test("auto snapshots dedup against the latest; manual ones never do", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    expect(createSnapshot(db, "p1", { kind: "auto", reason: "before-flash" }, 1000)).not.toBeNull();
    expect(createSnapshot(db, "p1", { kind: "auto", reason: "before-flash" }, 1001)).toBeNull(); // identical -> skipped
    expect(listSnapshots(db, "p1")).toHaveLength(1);
    // Manual is always stored, even with an identical payload.
    expect(createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 1002)).not.toBeNull();
    expect(listSnapshots(db, "p1")).toHaveLength(2);
  });

  test("auto snapshots are pruned to the ring buffer; manual survive", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const keep = createSnapshot(db, "p1", { kind: "manual", label: "keep", reason: "manual" }, 1000)!;
    for (let i = 0; i < 25; i++) {
      setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", String(i)); // distinct payload each round
      createSnapshot(db, "p1", { kind: "auto", reason: "before-flash" }, 2000 + i);
    }
    const list = listSnapshots(db, "p1");
    expect(list.filter((s) => s.kind === "auto")).toHaveLength(20); // AUTO_KEEP
    expect(list.find((s) => s.id === keep.id)).toBeDefined();        // manual untouched
  });

  test("delete removes one; restore/delete of an unknown id report failure", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const s = createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 1000)!;
    expect(deleteSnapshot(db, "p1", s.id)).toBe(true);
    expect(listSnapshots(db, "p1")).toHaveLength(0);
    expect(deleteSnapshot(db, "p1", s.id)).toBe(false);
    expect(restoreSnapshot(db, "p1", "ghost", 2000)).toBe(false);
  });

  test("snapshots cascade on project delete", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 1000);
    deleteProject(db, "p1");
    expect(db.query("SELECT COUNT(*) AS n FROM snapshots").get()).toMatchObject({ n: 0 });
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
