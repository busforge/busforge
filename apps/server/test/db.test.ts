import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseProject } from "@busforge/project";
import { openDb, SCHEMA_VERSION } from "../src/db/schema.ts";
import { insertProject, listProjects, getProject, deleteProject, setProjectConnection, getProjectConnection } from "../src/db/projects.ts";
import { listConnections, getConnection, createConnection, updateConnection, deleteConnection, type ConnectionInput } from "../src/db/connections.ts";
import { insertTelegram, recentTelegrams, pruneTelegrams } from "../src/db/telegrams.ts";
import { getDeviceModules, getDeviceLinks, setDeviceLink, getDeviceParams, getDeviceParamBase, setDeviceParam, getProjectChanges, getDeviceChangedKeys, revertDevice, revertDeviceParam, revertDeviceLink, replaceParamBase, replaceLinkBase, resetParamBase, resetLinkBase, setLinkBaseGaps, getLinkBaseGaps, getDeviceComObjOverrides, replaceDeviceProduct, getDeviceComObjOverrideBase, setDeviceComObjOverride, revertDeviceComObjFlags, resetComObjOverrideBase } from "../src/db/deviceparams.ts";
import { serializeConfig, createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot } from "../src/db/snapshots.ts";
import { putAppProgram, getAppProgram, putCatalogProduct, listCatalogProducts, getCatalogProduct, backfillCatalogFromDevices, gcAppPrograms } from "../src/db/catalog.ts";
import { createProject, addDevice } from "../src/db/projects.ts";
import { putBaggage, getDeviceBaggage, projectHasBaggage, checkBaggageSize } from "../src/db/baggage.ts";
import { exportProject } from "../src/db/exportProject.ts";
import { importProjectExport, validateExport, busforgeGaps } from "../src/db/importProject.ts";
import { putDeviceSecurity, getDeviceSecurity } from "../src/db/deviceSecurity.ts";
import { putGroupKeys, getGroupKeys } from "../src/db/groupKeys.ts";
import { putGroupSenders, listGroupSenders, addGroupSender, removeGroupSender, sendersByGroup, nextSendSequence } from "../src/db/groupSenders.ts";
import { deleteGroupAddress } from "../src/db/groupedit.ts";
import { appProgramId } from "@busforge/project";
import { decodeGroupTpdu, undecodedSecureTelegram } from "../src/telegram.ts";

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
    // projects carries the migration-0 columns (incl. interface_ip/port) a real
    // user_version-1 DB would have, so the later drop-inline-columns migration applies; telegrams
    // and group_addresses (also from migration 0) take their security columns.
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, imported_at INTEGER, source_file TEXT, interface_ip TEXT NOT NULL DEFAULT '', interface_port INTEGER NOT NULL DEFAULT 3671);
      CREATE TABLE devices (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, ia TEXT NOT NULL, name TEXT NOT NULL, product_ref TEXT NOT NULL, app_ref TEXT NOT NULL, manufacturer INTEGER NOT NULL);
      CREATE TABLE telegrams (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, ts INTEGER NOT NULL, src TEXT NOT NULL, dst_raw INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE group_addresses (project_id TEXT NOT NULL, raw INTEGER NOT NULL);
      PRAGMA user_version = 1;`);
    old.close();

    const db = openDb(path); // should run the new migration: ALTER + device_parameters
    expect(() => db.query("SELECT instance_id FROM devices").all()).not.toThrow();
    expect(() => db.query("SELECT * FROM device_parameters").all()).not.toThrow();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the instance-id unique migration collapses pre-existing duplicate rows instead of bricking", () => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-dup-"));
    const path = join(dir, "dup.db");
    // A DB one version BEFORE the unique-index migration, already holding two device rows
    // that share a real instance id (a malformed import from before the guard existed). A
    // raw CREATE UNIQUE INDEX over them would throw and brick startup; the migration must
    // first collapse the duplicate group to one row.
    const old = new Database(path, { create: true });
    // Minimal connections, telegrams and group_addresses tables are present so the trailing
    // ip_transport and security ALTERs apply; production has it from the transport-aware migration long before this point.
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, imported_at INTEGER, source_file TEXT);
      CREATE TABLE devices (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL DEFAULT '', ia TEXT NOT NULL, name TEXT NOT NULL, product_ref TEXT NOT NULL, app_ref TEXT NOT NULL, manufacturer INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '');
      CREATE TABLE connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 3671, usb_vendor_id INTEGER, usb_product_id INTEGER, usb_serial TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE telegrams (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, ts INTEGER NOT NULL, src TEXT NOT NULL, dst_raw INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE device_link_base (project_id TEXT NOT NULL, device_id TEXT NOT NULL, com_obj_ref_id TEXT NOT NULL, slot INTEGER NOT NULL, ga_raw INTEGER NOT NULL);
      CREATE TABLE group_addresses (project_id TEXT NOT NULL, raw INTEGER NOT NULL);
      INSERT INTO projects (id,name,imported_at,source_file) VALUES ('p','x',1,'');
      INSERT INTO devices (project_id,instance_id,ia,name,product_ref,app_ref,manufacturer) VALUES ('p','DI-1','1.1.1','a','','',0),('p','DI-1','1.1.2','b','','',0),('p','','1.1.3','c','','',0),('p','','1.1.4','d','','',0);
      PRAGMA user_version = 16;`);
    old.close();
    // Runs the pending tail: the instance-id dedup+unique-index migration (version 17), the
    // ga_levels column add, and the ip_transport column add. The ALTERs adjust the minimal
    // projects/connections tables harmlessly; the dedup is what this test asserts.
    const db = openDb(path);
    const dupRows = db.query("SELECT ia FROM devices WHERE project_id='p' AND instance_id='DI-1'").all() as { ia: string }[];
    expect(dupRows).toEqual([{ ia: "1.1.1" }]); // lowest-rowid survivor kept, the other dropped
    // The two legacy '' rows are untouched (partial index excludes them).
    expect((db.query("SELECT COUNT(*) AS n FROM devices WHERE project_id='p' AND instance_id=''").get() as { n: number }).n).toBe(2);
    // And the index is now active: a fresh real-id collision is rejected.
    const ins = db.prepare("INSERT INTO devices (project_id,instance_id,ia,name,product_ref,app_ref,manufacturer) VALUES ('p','DI-9',?, 'n','','',0)");
    ins.run("1.1.5");
    expect(() => ins.run("1.1.6")).toThrow();
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
    expect(getProject(db, "p1")!.groupAddressLevels).toBe(3); // sample has no style -> default
  });

  test("group-address style persists through insert -> getProject and .busforge round-trip", () => {
    const projectXml = `<KNX xmlns="http://knx.org/xml/project/23"><Project Id="P"><ProjectInformation Name="Two" GroupAddressStyle="TwoLevel" /></Project></KNX>`;
    const proj = parseProject(sampleXml, projectXml, "Two");
    expect(proj.groupAddressLevels).toBe(2);
    const db = fresh();
    insertProject(db, "p1", proj, "/tmp/p1", 1000);
    expect(getProject(db, "p1")!.groupAddressLevels).toBe(2); // survives the knxproj import
    // And the .busforge export carries it (ProjectProperties), so a re-import keeps two-level.
    const MK = Buffer.alloc(32, 7);
    const data = exportProject(db, "p1", 5, MK)!;
    importProjectExport(db, data, "p2", 6, MK);
    expect(getProject(db, "p2")!.groupAddressLevels).toBe(2);
  });

  test("the com-object flags a project sets survive the import and a .busforge round-trip; a product replacement drops them", () => {
    const xml = sampleXml.replace(/<ComObjectInstanceRef RefId="([^"]+)"/, '<ComObjectInstanceRef RefId="$1" ReadFlag="Enabled" Priority="High"');
    const proj = parseProject(xml, undefined, "Demo");
    const [dev] = proj.deviceComObjOverrides;
    expect(dev.overrides).toHaveLength(1);
    const db = fresh();
    insertProject(db, "p1", proj, "/tmp/p1", 1000);
    const want = [{ comObjRefId: dev.overrides[0].comObjRefId, attrs: { ReadFlag: "Enabled", Priority: "High" } }];
    expect(getDeviceComObjOverrides(db, "p1", dev.deviceId)).toEqual(want);
    const MK = Buffer.alloc(32, 7);
    const data = exportProject(db, "p1", 5, MK)!;
    expect(data.deviceComObjOverrides).toEqual([{ deviceId: dev.deviceId, seq: 0, ...want[0] }]);
    importProjectExport(db, data, "p2", 6, MK);
    expect(getDeviceComObjOverrides(db, "p2", dev.deviceId)).toEqual(want);
    // an artifact without them is refused, not imported as "none set"
    const { deviceComObjOverrides: _, ...without } = data;
    expect(() => validateExport(without)).toThrow(expect.objectContaining({ code: "BUSFORGE_INVALID" }));
    expect(() => validateExport({ ...data, deviceComObjOverrides: [{ deviceId: "d", seq: 0, comObjRefId: "r", attrs: { ReadFlag: 1 } }] })).toThrow(expect.objectContaining({ code: "BUSFORGE_INVALID" }));
    replaceDeviceProduct(db, "p1", dev.deviceId, { productRef: "M-1_H-1_HP-1", appRef: "M-1_A-1-1-0", manufacturer: 1 } as Parameters<typeof replaceDeviceProduct>[3], new Map());
    expect(getDeviceComObjOverrides(db, "p1", dev.deviceId)).toEqual([]);
  });

  test("an edited com-object flag counts as a change until it is written; revert and the baseline follow it", () => {
    const xml = sampleXml.replace(/<ComObjectInstanceRef RefId="([^"]+)"/, '<ComObjectInstanceRef RefId="$1" ReadFlag="Enabled" Priority="High"');
    const proj = parseProject(xml, undefined, "Demo");
    const [dev] = proj.deviceComObjOverrides;
    const ref = dev.overrides[0].comObjRefId;
    const db = fresh();
    insertProject(db, "p1", proj, "/tmp/p1", 1000);
    // the import is what the device holds
    expect(getDeviceComObjOverrideBase(db, "p1", dev.deviceId)).toEqual(getDeviceComObjOverrides(db, "p1", dev.deviceId));
    expect(getDeviceChangedKeys(db, "p1", dev.deviceId).flags.size).toBe(0);
    expect(getProjectChanges(db, "p1").get(dev.deviceId)).toBeUndefined();

    setDeviceComObjOverride(db, "p1", dev.deviceId, ref, { ReadFlag: "Disabled" });
    expect(getDeviceComObjOverrides(db, "p1", dev.deviceId)).toEqual([{ comObjRefId: ref, attrs: { ReadFlag: "Disabled" } }]);
    expect([...getDeviceChangedKeys(db, "p1", dev.deviceId).flags]).toEqual([ref]);
    expect(getProjectChanges(db, "p1").get(dev.deviceId)?.flags).toBe(1);
    // an object the project sets nothing on any more keeps no row
    setDeviceComObjOverride(db, "p1", dev.deviceId, "O-9_R-9", {});
    expect(getDeviceComObjOverrides(db, "p1", dev.deviceId)).toHaveLength(1);

    revertDeviceComObjFlags(db, "p1", dev.deviceId, ref);
    expect(getDeviceChangedKeys(db, "p1", dev.deviceId).flags.size).toBe(0);
    setDeviceComObjOverride(db, "p1", dev.deviceId, ref, {});
    revertDevice(db, "p1", dev.deviceId);
    expect(getDeviceComObjOverrides(db, "p1", dev.deviceId)).toEqual(getDeviceComObjOverrideBase(db, "p1", dev.deviceId));

    // a verified write adopts what it was submitted with
    setDeviceComObjOverride(db, "p1", dev.deviceId, ref, { WriteFlag: "Disabled" });
    const submitted = getDeviceComObjOverrides(db, "p1", dev.deviceId);
    setDeviceComObjOverride(db, "p1", dev.deviceId, ref, { TransmitFlag: "Disabled" });
    resetComObjOverrideBase(db, "p1", dev.deviceId, submitted);
    expect(getDeviceComObjOverrideBase(db, "p1", dev.deviceId)).toEqual(submitted);
    expect(getDeviceChangedKeys(db, "p1", dev.deviceId).flags.size).toBe(1);

    // the .busforge round-trip carries the baseline, a product replacement drops it
    const MK = Buffer.alloc(32, 7);
    const data = exportProject(db, "p1", 5, MK)!;
    importProjectExport(db, data, "p2", 6, MK);
    expect(getDeviceComObjOverrideBase(db, "p2", dev.deviceId)).toEqual(submitted);
    const { deviceComObjOverrideBase: _, ...without } = data;
    expect(() => validateExport(without)).toThrow(expect.objectContaining({ code: "BUSFORGE_INVALID" }));
    replaceDeviceProduct(db, "p1", dev.deviceId, { productRef: "M-1_H-1_HP-1", appRef: "M-1_A-1-1-0", manufacturer: 1 } as Parameters<typeof replaceDeviceProduct>[3], new Map());
    expect(getDeviceComObjOverrideBase(db, "p1", dev.deviceId)).toEqual([]);
  });

  test("a snapshot carries the com-object flags a project sets, and a restore brings them back", () => {
    const xml = sampleXml.replace(/<ComObjectInstanceRef RefId="([^"]+)"/, '<ComObjectInstanceRef RefId="$1" ReadFlag="Enabled" Priority="High"');
    const proj = parseProject(xml, undefined, "Demo");
    const [dev] = proj.deviceComObjOverrides;
    const db = fresh();
    insertProject(db, "p1", proj, "/tmp/p1", 1000);
    const want = getDeviceComObjOverrides(db, "p1", dev.deviceId);
    expect(serializeConfig(db, "p1").deviceComObjOverrides).toEqual([{ deviceId: dev.deviceId, ...want[0] }]);
    createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 2000);
    const snap = listSnapshots(db, "p1")[0];
    db.prepare("DELETE FROM device_comobj_overrides WHERE project_id = ?").run("p1");
    restoreSnapshot(db, "p1", snap.id, 3000);
    expect(getDeviceComObjOverrides(db, "p1", dev.deviceId)).toEqual(want);
    // a restore point taken before snapshots carried them leaves the current ones in place
    const old = { ...serializeConfig(db, "p1"), deviceComObjOverrides: undefined };
    db.prepare("INSERT INTO snapshots (id, project_id, label, kind, reason, created_at, schema_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old", "p1", "", "manual", "manual", 4000, SCHEMA_VERSION, JSON.stringify(old));
    restoreSnapshot(db, "p1", "old", 5000);
    expect(getDeviceComObjOverrides(db, "p1", dev.deviceId)).toEqual(want);
  });

  test("a device's link-baseline gaps survive a .busforge round-trip", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    setLinkBaseGaps(db, "p1", "P-TEST-0_DI-1", 3);
    const MK = Buffer.alloc(32, 7);
    const data = exportProject(db, "p1", 5, MK)!;
    importProjectExport(db, data, "p2", 6, MK);
    expect([getLinkBaseGaps(db, "p2", "P-TEST-0_DI-1"), getLinkBaseGaps(db, "p2", "P-TEST-0_DI-2")]).toEqual([3, 0]);
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

  test("two devices sharing an instance id are refused, not silently merged", () => {
    // A malformed 0.xml with two DeviceInstances under the same Id. Without the guard both
    // rows import and their device_parameters merge last-wins (device_id collides); the guard
    // refuses the import with a coded error instead.
    const xml0 = `<?xml version="1.0" encoding="utf-8"?>
      <KNX xmlns="http://knx.org/xml/project/23"><Project Id="P"><Installations><Installation><Topology>
        <Area Address="1"><Line Address="1">
          <DeviceInstance Id="DI-DUP" Address="5" ProductRefId="M-X_H-1_P-1" Hardware2ProgramRefId="M-X_H-1_HP-1" />
          <DeviceInstance Id="DI-DUP" Address="6" ProductRefId="M-X_H-1_P-1" Hardware2ProgramRefId="M-X_H-1_HP-1" />
        </Line></Area>
      </Topology></Installation></Installations></Project></KNX>`;
    const proj = parseProject(xml0, undefined, "x");
    expect(proj.devices.length).toBe(2); // parser keeps both; the store is where the clash surfaces
    const db = fresh();
    const code = (() => { try { insertProject(db, "p1", proj, "/tmp/p1", 1000); return null; } catch (e) { return (e as { code?: string }).code; } })();
    expect(code).toBe("DUPLICATE_DEVICE_INSTANCE");
    // Nothing was persisted (the pre-check runs before the insert transaction opens).
    expect(db.query("SELECT COUNT(*) AS n FROM devices WHERE project_id = 'p1'").get()).toEqual({ n: 0 });
  });

  test("the partial unique index tolerates legacy empty instance ids", () => {
    // Rows from before instance_id was populated carry '' and must not collide under the
    // WHERE instance_id != '' partial index; only real ids are constrained.
    const db = fresh();
    db.prepare("INSERT INTO projects (id, name, imported_at, source_file) VALUES ('p1','x',1,'')").run();
    const ins = db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer, comment) VALUES ('p1','', ?, 'n','', '', 0, '')");
    expect(() => { ins.run("1.1.1"); ins.run("1.1.2"); }).not.toThrow();
    // But two real ids that collide DO trip the index.
    const insId = db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer, comment) VALUES ('p1','DI-1', ?, 'n','', '', 0, '')");
    insId.run("1.1.3");
    expect(() => insId.run("1.1.4")).toThrow();
  });

  test("getDeviceModules rejects a corrupt device_modules row instead of miscasting it", () => {
    const db = fresh();
    db.prepare("INSERT INTO projects (id, name, imported_at, source_file) VALUES ('p1','x',1,'')").run();
    // A row whose JSON is well-formed JSON but NOT a ModuleInstance[] (args entry missing
    // `value`). The blind cast would have handed this straight to the image builder, where it
    // would fail far from the cause; the shape guard makes it fail loudly at the read boundary.
    db.prepare("INSERT INTO device_modules (project_id, device_id, instances) VALUES ('p1','DI-1',?)")
      .run(JSON.stringify([{ id: "MI-1", refId: "M-1", args: [{ refId: "A-1" }] }]));
    expect(() => getDeviceModules(db, "p1", "DI-1")).toThrow("corrupt store");
  });

  test("a project with duplicate com-object RefIds inserts without colliding on the link PK", () => {
    // Two ComObjectInstanceRefs sharing a RefId would, unmerged, produce two (refId, slot)
    // rows that collide on the device_links PK and abort the whole import. The parser merges
    // them; this drives that merged output through the real insert path to prove no throw.
    const dup = sampleXml.replace(
      '<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-2" />',
      '<ComObjectInstanceRef RefId="O-1_R-1" Links="GA-1 GA-2" /><ComObjectInstanceRef RefId="O-1_R-1" Links="GA-2" />',
    );
    const db = fresh();
    expect(() => insertProject(db, "pdup", parseProject(dup, undefined, "x"), "/tmp/pdup", 1000)).not.toThrow();
    expect(getDeviceLinks(db, "pdup", "P-TEST-0_DI-1").get("O-1_R-1")).toEqual([1, 2, 2]);
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
    for (const d of getProject(db, "p1")!.devices) expect(d.changes).toEqual({ params: 0, links: 0, flags: 0, neverProgrammed: false });
  });

  test("a device ETS never loaded imports as never programmed", () => {
    const db = fresh();
    const xml = readFileSync(join(import.meta.dir, "../../../packages/project/test/fixtures/sample-0.xml"), "utf8")
      .replace(/(Id="P-TEST-0_DI-2"[^>]*?) ApplicationProgramLoaded="true"/, "$1");
    insertProject(db, "p1", parseProject(xml, undefined, "x"), "/tmp/p1", 1000);
    const flags = Object.fromEntries(getProject(db, "p1")!.devices.map((d) => [d.id, d.changes.neverProgrammed]));
    expect(flags).toEqual({ "P-TEST-0_DI-1": false, "P-TEST-0_DI-2": true });
  });

  test("a device without an application program (a power supply) is not seeded as never programmed", () => {
    const db = fresh();
    const xml = readFileSync(join(import.meta.dir, "../../../packages/project/test/fixtures/sample-0.xml"), "utf8")
      .replace(/(Id="P-TEST-0_DI-2"[^>]*?) ApplicationProgramLoaded="true"([^>]*?) Hardware2ProgramRefId="[^"]*"/, "$1$2");
    insertProject(db, "p1", parseProject(xml, undefined, "x"), "/tmp/p1", 1000);
    const dev = getProject(db, "p1")!.devices.find((d) => d.id === "P-TEST-0_DI-2")!;
    expect(dev.appRef).toBe("");
    expect(dev.changes.neverProgrammed).toBe(false);
  });

  test("tracks parameter changes and resets on flash", () => {
    const xml0 = `<?xml version="1.0" encoding="utf-8"?>
      <KNX xmlns="http://knx.org/xml/project/23"><Project Id="P"><Installations><Installation><Topology>
        <Area Address="1"><Line Address="1"><DeviceInstance Id="DI-9" Address="5" ApplicationProgramLoaded="true" ProductRefId="M-X_H-1_P-1" Hardware2ProgramRefId="M-X_H-1_HP-1">
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
    resetParamBase(db, "p1", dev, getDeviceParams(db, "p1", dev));
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();

    // A param edited from its DEFAULT (never seeded into the baseline, since
    // 0.xml is sparse) still counts as a change.
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ params: 1 });

    // keepDrift: a ref the flash could not write keeps its old baseline row, so its
    // "changed" marker survives the reset, while everything else is adopted.
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-1_R-1", "61");
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ params: 2 });
    resetParamBase(db, "p1", dev, getDeviceParams(db, "p1", dev), new Set(["M-X_A-1_P-9_R-1"]));
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ params: 1 }); // only the kept-drift ref remains changed
  });

  test("tracks link changes and resets on flash", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1"; // seeded from the fixture: O-1_R-1 -> [1, 2]
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();

    setDeviceLink(db, "p1", dev, "O-1_R-1", [9]);
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ links: 1 });

    resetLinkBase(db, "p1", dev, ["O-1_R-1"], getDeviceLinks(db, "p1", dev));
    expect(getProjectChanges(db, "p1").get(dev)).toBeUndefined();
  });

  test("resetLinkBase re-baselines ONLY the flashed refs; a skipped link stays drift", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1";
    setDeviceLink(db, "p1", dev, "O-1_R-1", [9]); // this one gets flashed
    setDeviceLink(db, "p1", dev, "O-2_R-2", [5]); // this one was skipped at flash (e.g. hidden com-object)
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ links: 2 });

    resetLinkBase(db, "p1", dev, ["O-1_R-1"], getDeviceLinks(db, "p1", dev)); // only the flashed ref is baselined
    // The skipped link must NOT be adopted into the baseline (no fake "in sync"): drift remains.
    expect(getProjectChanges(db, "p1").get(dev)).toMatchObject({ links: 1 });
    expect(getDeviceChangedKeys(db, "p1", dev).links.has("O-2_R-2")).toBe(true);
    expect(getDeviceChangedKeys(db, "p1", dev).links.has("O-1_R-1")).toBe(false);
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

  test("getDeviceParamBase exposes the baseline; a float differs from its canonical form only textually", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1";
    const ref = "M-X_A-1_P-9_R-1";
    // ETS stores a float baseline in scientific notation; the UI writes the canonical
    // decimal. The string-based change detection flags this as drift, which the config
    // view suppresses by comparing the baseline (from getDeviceParamBase) numerically.
    const base = new Map(getDeviceParams(db, "p1", dev));
    base.set(ref, "1.500000000000000E+001");
    replaceParamBase(db, "p1", dev, base);
    setDeviceParam(db, "p1", dev, ref, "15");

    expect(getDeviceParamBase(db, "p1", dev).get(ref)).toBe("1.500000000000000E+001");
    // string compare flags it changed; numeric compare (what the config view does) does not
    expect(getDeviceChangedKeys(db, "p1", dev).params.has(ref)).toBe(true);
    expect(Number("15")).toBe(Number("1.500000000000000E+001"));
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

  test("project references a saved connection", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    createConnection(db, "c1", { name: "GW", type: "ip", host: "1.2.3.4", port: 3672, ipTransport: "auto", usbVendorId: null, usbProductId: null, usbSerial: null }, 1000);
    expect(setProjectConnection(db, "p1", "c1")).toBe(true);
    expect(getProject(db, "p1")!.connectionId).toBe("c1");
    expect(getProjectConnection(db, "p1")).toMatchObject({ id: "c1", host: "1.2.3.4", port: 3672 });
    // deleting the connection clears the reference (ON DELETE SET NULL)
    deleteConnection(db, "c1");
    expect(getProjectConnection(db, "p1")).toBeNull();
    expect(getProject(db, "p1")!.connectionId).toBeNull();
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

describe("project export", () => {
  const MK = Buffer.alloc(32, 1); // synthetic instance master key

  test("serializes the whole project plus referenced catalog and baggage", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1";
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    resetParamBase(db, "p1", dev, getDeviceParams(db, "p1", dev)); // adopt as baseline so the export carries baselines too
    putBaggage(db, "p1", `${dev}_x.bin`, Buffer.from("zz"));
    const appRefs = (db.query("SELECT DISTINCT app_ref AS a FROM devices WHERE project_id = 'p1'").all() as { a: string }[]).map((r) => r.a);
    for (const ar of appRefs) putAppProgram(db, appProgramId(ar), `<ApplicationProgram id="${appProgramId(ar)}"/>`);

    const ex = exportProject(db, "p1", 5000, MK)!;
    expect(ex.busforgeExport).toBe(1);
    expect(ex.exportedAt).toBe(5000);
    expect(ex.project.name).toBe("Demo");
    expect(ex.devices.length).toBe(2);
    expect(ex.groupAddresses).toHaveLength(2);
    expect(ex.deviceParameters).toContainEqual({ deviceId: dev, paramRefId: "M-X_A-1_P-9_R-1", value: "7" });
    expect(ex.deviceParamBase).toContainEqual({ deviceId: dev, paramRefId: "M-X_A-1_P-9_R-1", value: "7" }); // baselines included for round-trip
    expect(ex.deviceLinks).toContainEqual({ deviceId: dev, comObjRefId: "O-1_R-1", slot: 0, gaRaw: 1 });
    for (const ar of appRefs) expect(ex.catalog[appProgramId(ar)]).toContain("ApplicationProgram"); // referenced programs bundled
    expect(ex.baggage).toContainEqual({ name: `${dev}_x.bin`, dataBase64: Buffer.from("zz").toString("base64") });

    expect(exportProject(db, "ghost", 1, MK)).toBeNull();
  });

  test("carries the active-connection reference; import restores it only if the connection exists", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    createConnection(db, "conn-1", { name: "GW", type: "ip", host: "1.2.3.4", port: 3671, ipTransport: "auto", usbVendorId: null, usbProductId: null, usbSerial: null }, 1000);
    setProjectConnection(db, "p1", "conn-1");
    const ex = exportProject(db, "p1", 5000, MK)!;
    expect(ex.project.connectionId).toBe("conn-1");

    // re-import while the connection still exists -> reference restored
    importProjectExport(db, ex, "p2", 6000, MK);
    expect(getProjectConnection(db, "p2")).toMatchObject({ id: "conn-1" });

    // connection gone (e.g. another machine) -> reference falls away, no FK error
    deleteConnection(db, "conn-1");
    importProjectExport(db, ex, "p3", 7000, MK);
    expect(getProject(db, "p3")!.connectionId).toBeNull();
  });

  test("round-trips Data Secure tool keys through export/import, re-sealed under the importing master key", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const dev = "P-TEST-0_DI-1";
    const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const serial = Buffer.from("aabbccddeeff", "hex");
    putDeviceSecurity(db, "p1", [{ deviceId: dev, toolKey, serialNumber: serial, sequenceNumber: "9", source: "import" }], MK);

    const ex = exportProject(db, "p1", 5000, MK)!;
    // carried in CLEARTEXT base64 (the .busforge container password is the only protection)
    expect(ex.deviceSecurity).toEqual([
      { deviceId: dev, toolKey: toolKey.toString("base64"), serialNumber: serial.toString("base64"), sequenceNumber: "9", source: "import" },
    ]);

    // import under a DIFFERENT instance master key: re-sealed, key reads back correctly
    const MK2 = Buffer.alloc(32, 2);
    importProjectExport(db, ex, "p2", 6000, MK2);
    expect(getDeviceSecurity(db, "p2", dev, MK2)!.toolKey).toEqual(toolKey);
    // and the original master key cannot open the re-sealed copy (no silent wrong key)
    expect(() => getDeviceSecurity(db, "p2", dev, MK)).toThrow();
  });

  test("round-trips the security state of recorded telegrams, and imports a log that has none", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    insertTelegram(db, "p1", decodeGroupTpdu(0x1203, 1, Buffer.from([0x00, 0x81]), 10));
    insertTelegram(db, "p1", { ...decodeGroupTpdu(0x1203, 1, Buffer.from([0x00, 0x80]), 20), security: "decrypted" });
    insertTelegram(db, "p1", undecodedSecureTelegram(0x1203, 1, "noKey", 30));
    const ex = exportProject(db, "p1", 5000, MK)!;
    importProjectExport(db, ex, "p2", 6000, MK);
    expect(recentTelegrams(db, "p2", 10).map((t) => [t.kind, t.raw, t.security])).toEqual([
      ["GroupValueWrite", "01", undefined], ["GroupValueWrite", "00", "decrypted"], ["Unknown", "", "noKey"],
    ]);
    importProjectExport(db, { ...ex, telegrams: ex.telegrams!.map(({ security: _s, ...t }) => t) }, "p3", 7000, MK);
    expect(recentTelegrams(db, "p3", 10).every((t) => t.security === undefined)).toBe(true);
    expect(() => validateExport({ ...ex, telegrams: [{ ...ex.telegrams![0], security: "bogus" as never }] })).toThrow(/malformed telegrams/);
  });

  test("round-trips Data Secure group keys through export/import, re-sealed under the importing master key", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const key = Buffer.alloc(16, 0x5a);
    putGroupKeys(db, "p1", [{ raw: 1, key, source: "import" }], MK);
    const ex = exportProject(db, "p1", 5000, MK)!;
    expect(ex.groupKeys).toEqual([{ raw: 1, key: key.toString("base64"), source: "import" }]);
    const MK2 = Buffer.alloc(32, 2);
    importProjectExport(db, ex, "p2", 6000, MK2);
    expect(getGroupKeys(db, "p2", MK2)).toEqual(new Map([[1, key]]));
    expect(() => getGroupKeys(db, "p2", MK)).toThrow();
  });
});

describe("secured senders", () => {
  test("stores, lists, adds and removes the senders of a group address", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    putGroupSenders(db, "p1", [{ gaRaw: 1, ia: "1.2.250", source: "import" }]);
    addGroupSender(db, "p1", 1, "1.2.3");
    addGroupSender(db, "p1", 2, "1.2.250");
    expect(listGroupSenders(db, "p1")).toEqual([
      { gaRaw: 1, ia: "1.2.3", source: "busforge" }, { gaRaw: 1, ia: "1.2.250", source: "import" }, { gaRaw: 2, ia: "1.2.250", source: "busforge" },
    ]);
    expect(sendersByGroup(db, "p1")).toEqual(new Map([[1, ["1.2.3", "1.2.250"]], [2, ["1.2.250"]]]));
    expect(removeGroupSender(db, "p1", 1, "1.2.3")).toBe(true);
    expect(removeGroupSender(db, "p1", 1, "1.2.3")).toBe(false);
    expect(sendersByGroup(db, "p1").get(1)).toEqual(["1.2.250"]);
  });

  test("refuses an address that is not an individual address", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    expect(() => addGroupSender(db, "p1", 1, "1/2/250")).toThrow(/individual address/);
    expect(() => addGroupSender(db, "p1", 1, "1.1.256")).toThrow(/individual address/);
    expect(() => addGroupSender(db, "p1", 70000, "1.1.1")).toThrow(/group address/);
    expect(() => addGroupSender(db, "p1", 1, "0.0.0")).toThrow(/individual address/);
  });

  test("removing takes the same address written differently", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    addGroupSender(db, "p1", 1, "1.2.250");
    expect(removeGroupSender(db, "p1", 1, "01.2.250")).toBe(true);
  });

  test("the send sequence never repeats and never falls behind the clock", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    expect(nextSendSequence(db, "p1", "1.2.250", 500n)).toBe(500n);
    expect(nextSendSequence(db, "p1", "1.2.250", 400n)).toBe(501n); // clock went back: still ahead of the last
    expect(nextSendSequence(db, "p1", "1.2.250", 900n)).toBe(900n);
    expect(nextSendSequence(db, "p1", "1.2.251", 10n)).toBe(10n); // per sender
  });

  test("round-trips senders and send sequences through export/import", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    putGroupSenders(db, "p1", [{ gaRaw: 1, ia: "1.2.250", source: "import" }]);
    nextSendSequence(db, "p1", "1.2.250", 777n);
    const ex = exportProject(db, "p1", 5000, MK_SENDERS)!;
    expect(ex.groupSenders).toEqual([{ gaRaw: 1, ia: "1.2.250", source: "import" }]);
    expect(ex.sendSequences).toEqual([{ ia: "1.2.250", last: "777" }]);
    importProjectExport(db, ex, "p2", 6000, MK_SENDERS);
    expect(listGroupSenders(db, "p2")).toEqual([{ gaRaw: 1, ia: "1.2.250", source: "import" }]);
    expect(nextSendSequence(db, "p2", "1.2.250", 1n)).toBe(778n);
    expect(() => validateExport({ ...ex, groupSenders: [{ gaRaw: 1, ia: "x", source: "import" }] })).toThrow(/groupSenders/);
    expect(() => validateExport({ ...ex, groupSenders: [{ gaRaw: 1.5, ia: "1.1.1", source: "import" }] })).toThrow(/groupSenders/);
    expect(() => validateExport({ ...ex, groupSenders: [{ gaRaw: 1, ia: "99.99.999", source: "import" }] })).toThrow(/groupSenders/);
    expect(() => validateExport({ ...ex, sendSequences: [{ ia: "1.2.250", last: "281474976710656" }] })).toThrow(/sendSequences/);
  });
});
const MK_SENDERS = Buffer.alloc(32, 9);

describe("device security persistence", () => {
  const MK = Buffer.alloc(32, 3);
  const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const serial = Buffer.from("aabbccddeeff", "hex");
  const dev = "P-TEST-0_DI-1";
  const seed = () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    putDeviceSecurity(db, "p1", [{ deviceId: dev, toolKey, serialNumber: serial, sequenceNumber: "1", source: "import" }], MK);
    return db;
  };

  test("a config snapshot/restore never touches tool keys (device state, not config)", () => {
    const db = seed();
    createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 2000);
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "9"); // change config after the snapshot
    const snap = listSnapshots(db, "p1")[0];
    restoreSnapshot(db, "p1", snap.id, 3000);
    // the key is unchanged: a config rollback can never lose device access
    expect(getDeviceSecurity(db, "p1", dev, MK)!.toolKey).toEqual(toolKey);
  });

  test("group keys are stored sealed and outlive a restore and a deleted address", () => {
    const db = seed();
    const key = Buffer.alloc(16, 0x5a);
    putGroupKeys(db, "p1", [{ raw: 1, key, source: "import" }], MK);
    const raw = db.query("SELECT key FROM group_keys WHERE project_id = 'p1'").get() as { key: Uint8Array };
    expect(Buffer.from(raw.key)).not.toEqual(key);
    createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 2000);
    restoreSnapshot(db, "p1", listSnapshots(db, "p1")[0].id, 3000);
    expect(getGroupKeys(db, "p1", MK)).toEqual(new Map([[1, key]]));
    // An address deleted and brought back by a restore must come back secured, not plain.
    deleteGroupAddress(db, "p1", 1);
    expect(getGroupKeys(db, "p1", MK)).toEqual(new Map([[1, key]]));
  });

  test("refuses a group key that is not 16 bytes", () => {
    expect(() => putGroupKeys(seed(), "p1", [{ raw: 1, key: Buffer.alloc(15), source: "import" }], MK)).toThrow(/16 bytes/);
  });

  test("getProject surfaces secureDeviceCount for the export warning", () => {
    expect(getProject(seed(), "p1")!.secureDeviceCount).toBe(1);
  });

  test("deleting a project cascades its tool keys out of the store", () => {
    const db = seed();
    expect((db.query("SELECT COUNT(*) AS n FROM device_security WHERE project_id = 'p1'").get() as { n: number }).n).toBe(1);
    deleteProject(db, "p1");
    expect((db.query("SELECT COUNT(*) AS n FROM device_security WHERE project_id = 'p1'").get() as { n: number }).n).toBe(0);
  });

  test("validateExport rejects a malformed deviceSecurity entry as a coded 400", () => {
    const base = { busforgeExport: 1, project: { name: "x" }, devices: [], groupRanges: [], groupAddresses: [], deviceParameters: [], deviceParamBase: [], deviceLinks: [], deviceLinkBase: [], deviceModules: [], deviceComObjOverrides: [], deviceComObjOverrideBase: [], baggage: [], catalog: {} };
    expect(() => validateExport({ ...base, deviceSecurity: [{ deviceId: "d" }] })).toThrow(/deviceSecurity/);
    try { validateExport({ ...base, deviceSecurity: [{ deviceId: "d", toolKey: "x", serialNumber: "y", sequenceNumber: "1", source: "bogus" }] }); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("BUSFORGE_INVALID"); }
  });

  test("validateExport rejects a malformed device entry (missing string fields) as a coded 400", () => {
    const base = { busforgeExport: 1, project: { name: "x" }, groupRanges: [], groupAddresses: [], deviceParameters: [], deviceParamBase: [], deviceLinks: [], deviceLinkBase: [], deviceModules: [], deviceComObjOverrides: [], deviceComObjOverrideBase: [], baggage: [], catalog: {} };
    // A version-valid artifact with a device missing appRef must fail cleanly, not crash
    // later in busforgeGaps' appProgramId(appRef).split(...) as a generic 500.
    try { validateExport({ ...base, devices: [{ id: "d", ia: "1.1.1", name: "n" }] }); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("BUSFORGE_INVALID"); }
    // A well-formed device passes.
    expect(() => validateExport({ ...base, devices: [{ id: "d", ia: "1.1.1", name: "n", appRef: "M-1_A-1_1" }] })).not.toThrow();
  });

  test("validateExport rejects a .busforge with duplicate device instance ids (same code as knxproj import)", () => {
    const base = { busforgeExport: 1, project: { name: "x" }, groupRanges: [], groupAddresses: [], deviceParameters: [], deviceParamBase: [], deviceLinks: [], deviceLinkBase: [], deviceModules: [], deviceComObjOverrides: [], deviceComObjOverrideBase: [], baggage: [], catalog: {} };
    // A tampered artifact with two devices sharing an id must fail cleanly with the coded
    // DUPLICATE_DEVICE_INSTANCE before insert, not hit the raw unique index mid-transaction
    // (a generic 500). Both import paths (knxproj + .busforge) refuse consistently.
    const dup = { ...base, devices: [
      { id: "DI-1", ia: "1.1.1", name: "a", appRef: "M-1_A-1_1" },
      { id: "DI-1", ia: "1.1.2", name: "b", appRef: "M-1_A-1_1" },
    ] };
    try { validateExport(dup); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("DUPLICATE_DEVICE_INSTANCE"); }
  });

  test("busforgeGaps: empty catalog match on a prototype-chain key is NOT treated as present", () => {
    // appProgramId("toString") === "toString"; `"toString" in {}` is true (prototype), but
    // importProjectExport stores via Object.entries (own keys only). hasOwn keeps the two in
    // sync: the device is correctly reported as a husk, not silently swallowed.
    const gaps = busforgeGaps({ devices: [{ id: "x", ia: "1.1.1", name: "n", appRef: "toString" }], catalog: {} } as any);
    expect(gaps.devicesWithoutProgram).toEqual([{ ia: "1.1.1", name: "n" }]);
    // A healthy device with its program present reports no gap.
    const ok = busforgeGaps({ devices: [{ id: "x", ia: "1.1.2", name: "m", appRef: "M-TEST_A-1" }], catalog: { "M-TEST_A-1": "<xml/>" } } as any);
    expect(ok.devicesWithoutProgram).toEqual([]);
  });
});

describe("catalog (app programs)", () => {
  test("put then get; put is idempotent and keeps the first XML", () => {
    const db = fresh();
    expect(getAppProgram(db, "M-1_A-1")).toBeNull();
    putAppProgram(db, "M-1_A-1", "<ApplicationProgram>one</ApplicationProgram>");
    expect(getAppProgram(db, "M-1_A-1")).toContain("one");
    // INSERT OR IGNORE: a second put for the same id does not overwrite.
    putAppProgram(db, "M-1_A-1", "<ApplicationProgram>two</ApplicationProgram>");
    expect(getAppProgram(db, "M-1_A-1")).toContain("one");
    expect((db.query("SELECT COUNT(*) AS n FROM app_programs").get() as any).n).toBe(1);
  });
});

describe("catalog (products + placement)", () => {
  const product = (o: Partial<ReturnType<typeof getCatalogProduct>> = {}) => ({
    appRef: "M-9_H-1_HP-1", productRef: "M-9_P-1", appProgramId: "M-9_A-1",
    manufacturer: 9, name: "Demo", orderNumber: "ON-1", hwVersion: "3", ...o,
  });

  test("put/get/list catalog products; put is idempotent", () => {
    const db = fresh();
    expect(getCatalogProduct(db, "M-9_H-1_HP-1", "M-9_P-1")).toBeNull();
    putCatalogProduct(db, product());
    expect(getCatalogProduct(db, "M-9_H-1_HP-1", "M-9_P-1")).toMatchObject({ name: "Demo", orderNumber: "ON-1" });
    putCatalogProduct(db, product({ name: "Renamed" })); // OR IGNORE: first wins
    expect(getCatalogProduct(db, "M-9_H-1_HP-1", "M-9_P-1")!.name).toBe("Demo");
    expect(listCatalogProducts(db)).toHaveLength(1);
  });

  test("backfill adds only products whose app program is stored", () => {
    const db = fresh();
    createProject(db, "p1", "Blank", 1000);
    // Two device rows; only one has a stored program.
    db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer) VALUES ('p1','d1','1.1.1','Switch','M-9_P-1','M-9_H-1_HP-1',9)").run();
    db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer) VALUES ('p1','d2','1.1.2','Dim','M-9_P-2','M-9_H-2_HP-2',9)").run();
    putAppProgram(db, "M-9_A-1", "<ApplicationProgram/>"); // only HP-1's program

    expect(backfillCatalogFromDevices(db)).toBe(1);
    const list = listCatalogProducts(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ appRef: "M-9_H-1_HP-1", name: "Switch", orderNumber: "" });
    expect(backfillCatalogFromDevices(db)).toBe(0); // idempotent
  });

  test("addDevice allocates the next free address and references the catalog", () => {
    const db = fresh();
    createProject(db, "p1", "Blank", 1000);
    putAppProgram(db, "M-9_A-1", "<ApplicationProgram/>");
    putCatalogProduct(db, product());
    const a = addDevice(db, "p1", product(), "");
    const b = addDevice(db, "p1", product(), "Custom name");
    expect(a.ia).toBe("1.1.1");
    expect(b.ia).toBe("1.1.2");
    const rows = db.query("SELECT instance_id AS id, ia, name, app_ref AS appRef FROM devices WHERE project_id='p1' ORDER BY ia").all() as any[];
    expect(rows[0]).toMatchObject({ name: "Demo", appRef: "M-9_H-1_HP-1" }); // falls back to product name
    expect(rows[1].name).toBe("Custom name");
  });

  test("pinned (official-source) products survive gc; unpinned do not", () => {
    const db = fresh();
    putAppProgram(db, "M-9_A-1", "<ApplicationProgram/>");
    putCatalogProduct(db, product(), true); // pinned, no device references it
    expect(gcAppPrograms(db)).toBe(0); // pinned program is a GC root
    expect(listCatalogProducts(db)).toHaveLength(1);
    expect(getAppProgram(db, "M-9_A-1")).not.toBeNull();

    // A second, unpinned program with no device: GC removes it and its row.
    putAppProgram(db, "M-9_A-2", "<ApplicationProgram/>");
    putCatalogProduct(db, product({ appRef: "M-9_H-2_HP-2", productRef: "M-9_P-2", appProgramId: "M-9_A-2" }));
    expect(gcAppPrograms(db)).toBe(1);
    expect(listCatalogProducts(db)).toHaveLength(1); // only the pinned one remains
    expect(getCatalogProduct(db, "M-9_H-1_HP-1", "M-9_P-1")).not.toBeNull();
  });

  test("re-importing a project product from .knxprod upgrades it to pinned", () => {
    const db = fresh();
    putAppProgram(db, "M-9_A-1", "<ApplicationProgram/>");
    putCatalogProduct(db, product());        // arrived via a project import (unpinned)
    putCatalogProduct(db, product(), true);  // later ingested from .knxprod -> pinned
    const pinned = (db.query("SELECT pinned FROM catalog_products WHERE app_ref = ?").get("M-9_H-1_HP-1") as any).pinned;
    expect(pinned).toBe(1);
    expect(gcAppPrograms(db)).toBe(0); // now a GC root
    expect(listCatalogProducts(db)).toHaveLength(1);
  });

  test("gc drops catalog products whose program is no longer referenced", () => {
    const db = fresh();
    createProject(db, "p1", "Blank", 1000);
    putAppProgram(db, "M-9_A-1", "<ApplicationProgram/>");
    putCatalogProduct(db, product());
    addDevice(db, "p1", product(), "");
    expect(gcAppPrograms(db)).toBe(0); // still referenced by the placed device
    expect(listCatalogProducts(db)).toHaveLength(1);

    db.prepare("DELETE FROM devices WHERE project_id='p1'").run();
    expect(gcAppPrograms(db)).toBe(1); // program now orphaned
    expect(getAppProgram(db, "M-9_A-1")).toBeNull();
    expect(listCatalogProducts(db)).toHaveLength(0); // its catalog row went too
  });
});

describe("baggage (DCA blobs)", () => {
  test("put then get filters by device-id prefix; projectHasBaggage reflects presence", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    expect(projectHasBaggage(db, "p1")).toBe(false);

    putBaggage(db, "p1", "DI-1_Dalie64.bin", Buffer.from("aaa"));
    putBaggage(db, "p1", "DI-2_other.bin", Buffer.from("bbb"));
    expect(projectHasBaggage(db, "p1")).toBe(true);

    const got = getDeviceBaggage(db, "p1", "DI-1");
    expect(Object.keys(got)).toEqual(["DI-1_Dalie64.bin"]);
    expect(Buffer.from(got["DI-1_Dalie64.bin"], "base64").toString()).toBe("aaa");
    expect(getDeviceBaggage(db, "p1", "DI-9")).toEqual({}); // no match
  });

  test("an import refuses a blob over 32 MiB or more than 128 MiB of baggage in all", () => {
    const MiB = 1024 * 1024;
    expect(() => checkBaggageSize([{ name: "a", bytes: 32 * MiB }, { name: "b", bytes: 32 * MiB }, { name: "c", bytes: 32 * MiB }, { name: "d", bytes: 32 * MiB }])).not.toThrow();
    expect(catchCode(() => checkBaggageSize([{ name: "big.bin", bytes: 32 * MiB + 1 }]))).toBe("BAGGAGE_TOO_LARGE");
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `b${i}`, bytes: 26 * MiB }));
    expect(catchCode(() => checkBaggageSize(many))).toBe("BAGGAGE_TOO_LARGE");
  });

  test("a .busforge artifact with an oversized baggage blob is refused before anything is stored", () => {
    const base = { busforgeExport: 1, project: { name: "x" }, devices: [], groupRanges: [], groupAddresses: [], deviceParameters: [], deviceParamBase: [], deviceLinks: [], deviceLinkBase: [], deviceModules: [], deviceComObjOverrides: [], deviceComObjOverrideBase: [], catalog: {} };
    const big = Buffer.alloc(32 * 1024 * 1024 + 3).toString("base64");
    expect(catchCode(() => validateExport({ ...base, baggage: [{ name: "DI-1_big.bin", dataBase64: big }] }))).toBe("BAGGAGE_TOO_LARGE");
    expect(() => validateExport({ ...base, baggage: [{ name: "DI-1_ok.bin", dataBase64: Buffer.from("ok").toString("base64") }] })).not.toThrow();
  });
});

function catchCode(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { code?: string }).code; }
  return undefined;
}

describe("snapshots", () => {
  const dev = "P-TEST-0_DI-1"; // demo fixture: link O-1_R-1 -> [1, 2]

  test("serialize captures params, links and project meta", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    const cfg = serializeConfig(db, "p1");
    expect(cfg.project).toMatchObject({ name: "Demo" });
    expect(cfg.deviceParameters).toContainEqual({ deviceId: dev, paramRefId: "M-X_A-1_P-9_R-1", value: "7" });
    expect(cfg.deviceLinks).toContainEqual({ deviceId: dev, comObjRefId: "O-1_R-1", slot: 0, gaRaw: 1 });
  });

  test("refuses a restore point taken by a newer schema, and restores an older one", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const snap = createSnapshot(db, "p1", { kind: "manual", label: "x", reason: "manual" }, 1000)!;
    db.prepare("UPDATE snapshots SET schema_version = ? WHERE id = ?").run(SCHEMA_VERSION + 1, snap.id);
    expect(() => restoreSnapshot(db, "p1", snap.id, 2000)).toThrow(expect.objectContaining({ code: "SNAPSHOT_SCHEMA_NEWER" }));
    expect(listSnapshots(db, "p1")).toHaveLength(1); // refused before its undo point was taken
    db.prepare("UPDATE snapshots SET schema_version = 1 WHERE id = ?").run(snap.id);
    expect(restoreSnapshot(db, "p1", snap.id, 2000).ok).toBe(true);
  });

  test("captures and restores the connection reference (shared project properties)", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    createConnection(db, "c1", { name: "GW", type: "ip", host: "1.2.3.4", port: 3671, ipTransport: "auto", usbVendorId: null, usbProductId: null, usbSerial: null }, 1000);
    setProjectConnection(db, "p1", "c1");
    const snap = createSnapshot(db, "p1", { kind: "manual", label: "with conn", reason: "manual" }, 1000)!;
    expect(serializeConfig(db, "p1").project.connectionId).toBe("c1");

    setProjectConnection(db, "p1", null); // change it away
    expect(restoreSnapshot(db, "p1", snap.id, 2000).ok).toBe(true);
    expect(getProject(db, "p1")!.connectionId).toBe("c1"); // restored

    // FK-safe: if the connection is gone, restore falls back to null, no crash
    setProjectConnection(db, "p1", null);
    deleteConnection(db, "c1");
    expect(restoreSnapshot(db, "p1", snap.id, 3000).ok).toBe(true);
    expect(getProject(db, "p1")!.connectionId).toBeNull();
  });

  test("restore rolls the config back to a captured point", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    const base = createSnapshot(db, "p1", { kind: "manual", label: "base", reason: "manual" }, 1000)!;
    expect(base.label).toBe("base");

    setDeviceParam(db, "p1", dev, "M-X_A-1_P-9_R-1", "7");
    setDeviceLink(db, "p1", dev, "O-1_R-1", [9]);
    expect(getProjectChanges(db, "p1").get(dev)).toBeDefined();

    expect(restoreSnapshot(db, "p1", base.id, 2000).ok).toBe(true);
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
    resetParamBase(db, "p1", dev, getDeviceParams(db, "p1", dev));
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
    expect(restoreSnapshot(db, "p1", "ghost", 2000).ok).toBe(false);
  });

  test("restore reports whether the restore point carried group structure", () => {
    const db = fresh();
    insertProject(db, "p1", demo(), "/tmp/p1", 1000);
    // A modern snapshot captures the GA structure, so restoring it covers the structure.
    const modern = createSnapshot(db, "p1", { kind: "manual", reason: "manual" }, 1000)!;
    expect(restoreSnapshot(db, "p1", modern.id, 2000).gaStructureRestored).toBe(true);
    // An older restore point predates GA-structure capture: restore leaves it unchanged
    // and must say so, not silently imply a full rollback.
    const old = JSON.parse(JSON.stringify(serializeConfig(db, "p1")));
    delete old.groupRanges; delete old.groupAddresses;
    db.prepare("INSERT INTO snapshots (id, project_id, label, kind, reason, created_at, schema_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("old", "p1", "", "manual", "manual", 1500, 1, JSON.stringify(old));
    const r = restoreSnapshot(db, "p1", "old", 3000);
    expect(r.ok).toBe(true);
    expect(r.gaStructureRestored).toBe(false);
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
    insertTelegram(db, "p1", decodeGroupTpdu(0x1203, 1, Buffer.from([0x00, 0x81]), 10));
    insertTelegram(db, "p1", decodeGroupTpdu(0x1203, 2, Buffer.from([0x00, 0x81]), 20));
    insertTelegram(db, "p1", decodeGroupTpdu(0x1203, 3, Buffer.from([0x00, 0x81]), 30));
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

describe("connections", () => {
  const ipInput: ConnectionInput = { name: "Gateway", type: "ip", host: "198.51.100.10", port: 3671, ipTransport: "auto", usbVendorId: null, usbProductId: null, usbSerial: null };
  const usbInput: ConnectionInput = { name: "USB Stick", type: "usb", host: "", port: 3671, ipTransport: "auto", usbVendorId: 0x147b, usbProductId: 0x5120, usbSerial: "ABC123" };

  test("create -> list -> get round-trips both transports", () => {
    const db = fresh();
    const ip = createConnection(db, "c1", ipInput, 1000);
    const usb = createConnection(db, "c2", usbInput, 2000);
    expect(ip).toMatchObject({ id: "c1", name: "Gateway", type: "ip", host: "198.51.100.10", port: 3671, createdAt: 1000 });
    expect(usb).toMatchObject({ id: "c2", type: "usb", usbVendorId: 0x147b, usbProductId: 0x5120, usbSerial: "ABC123" });
    expect(listConnections(db).map((c) => c.id)).toEqual(["c1", "c2"]); // ordered by created_at
    expect(getConnection(db, "c2")).toMatchObject({ name: "USB Stick", usbSerial: "ABC123" });
  });

  test("update changes fields, returns null for unknown id", () => {
    const db = fresh();
    createConnection(db, "c1", ipInput, 1000);
    const updated = updateConnection(db, "c1", { ...ipInput, name: "Renamed", host: "203.0.113.11" });
    expect(updated).toMatchObject({ id: "c1", name: "Renamed", host: "203.0.113.11" });
    expect(updateConnection(db, "nope", ipInput)).toBeNull();
  });

  test("delete removes, returns false for unknown id", () => {
    const db = fresh();
    createConnection(db, "c1", ipInput, 1000);
    expect(deleteConnection(db, "c1")).toBe(true);
    expect(getConnection(db, "c1")).toBeNull();
    expect(deleteConnection(db, "c1")).toBe(false);
  });

  test("round-trips ipTransport and updates it", () => {
    const db = fresh();
    const tcp = createConnection(db, "c1", { ...ipInput, ipTransport: "tcp" }, 1000);
    expect(tcp.ipTransport).toBe("tcp");
    expect(getConnection(db, "c1")!.ipTransport).toBe("tcp");
    const updated = updateConnection(db, "c1", { ...ipInput, ipTransport: "udp" });
    expect(updated!.ipTransport).toBe("udp");
    // The model's own default (carried by ipInput) is 'auto'.
    expect(createConnection(db, "c2", ipInput, 2000).ipTransport).toBe("auto");
  });

  test("migration backfills ip_transport to 'auto' for an existing connection row", () => {
    const dir = mkdtempSync(join(tmpdir(), "busforge-conn-mig-"));
    const path = join(dir, "old.db");
    // A connections table one version BEFORE the ip_transport column, holding a saved IP
    // connection. Opening it must add the column and backfill the legacy row to 'auto'.
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE devices (project_id TEXT, instance_id TEXT, ia TEXT, app_ref TEXT, product_ref TEXT);
      CREATE TABLE connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL DEFAULT '', port INTEGER NOT NULL DEFAULT 3671, usb_vendor_id INTEGER, usb_product_id INTEGER, usb_serial TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE telegrams (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, ts INTEGER NOT NULL, src TEXT NOT NULL, dst_raw INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE device_link_base (project_id TEXT NOT NULL, device_id TEXT NOT NULL, com_obj_ref_id TEXT NOT NULL, slot INTEGER NOT NULL, ga_raw INTEGER NOT NULL);
      CREATE TABLE group_addresses (project_id TEXT NOT NULL, raw INTEGER NOT NULL);
      INSERT INTO connections (id,name,type,host,port,created_at) VALUES ('c1','GW','ip','1.2.3.4',3671,1000);
      INSERT INTO devices (project_id,instance_id,ia) VALUES ('p','read','1.1.1'),('p','never','1.1.2');
      INSERT INTO device_link_base VALUES ('p','read','O-0_R-1',0,1);
      PRAGMA user_version = 18;`);
    old.close();
    const db = openDb(path);
    expect(getConnection(db, "c1")!.ipTransport).toBe("auto");
    // A device holding a link baseline has not had its links counted: unknown (-1) until read back.
    expect(db.query("SELECT instance_id AS d, link_base_gaps AS g FROM devices ORDER BY d").all()).toEqual([{ d: "never", g: 0 }, { d: "read", g: -1 }]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
