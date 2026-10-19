import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../src/app.ts";
import { createProject } from "../src/db/projects.ts";
import { createGroupAddress, createGroupRange } from "../src/db/groupedit.ts";
import { getGroupKeys, listGroupKeyRows, putGroupKeys } from "../src/db/groupKeys.ts";
import { putDeviceSecurity } from "../src/db/deviceSecurity.ts";
import { setDeviceLink } from "../src/db/deviceparams.ts";
import { getGaSecurity, applyLinkSecurity, setGaSecurityMode } from "../src/db/gaSecurity.ts";

// The rules ETS 6.4.1 was seen to apply to a group address's Data Secure mode (findings §22): a new
// address linked only to secure devices is secured with a new key, a device without security turns an
// "Automatisch" address plain for everyone (after a warning) and cannot be linked to an "Erzwungen
// an" one. A secure device here is one the project holds a tool key for.
describe("group address security", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ga-security-"));
    const state = createState({ dbPath: ":memory:", dataDir: dir });
    const db = state.db;
    createProject(db, "p", "Test", 0);
    const main = createGroupRange(db, "p", null, "Secure", 0);
    const mid = createGroupRange(db, "p", main, "Jung", 0);
    createGroupAddress(db, "p", mid, 1, "Taste 1", "1.001");
    createGroupAddress(db, "p", mid, 2, "Taste 2", "1.001");
    const ins = db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer) VALUES ('p', ?, ?, ?, '', '', 0)");
    for (const [id, ia] of [["JUNG", "1.2.4"], ["GVS", "1.2.3"], ["MDT", "1.2.7"]]) ins.run(id, ia, id);
    const deviceId = (instance: string) => (db.query("SELECT id FROM devices WHERE instance_id = ?").get(instance) as { id: number }).id.toString();
    const ids = { jung: deviceId("JUNG"), gvs: deviceId("GVS"), mdt: deviceId("MDT") };
    putDeviceSecurity(db, "p", [ids.jung, ids.gvs].map((d) => ({ deviceId: d, toolKey: Buffer.alloc(16, 7), serialNumber: Buffer.alloc(6, 1), sequenceNumber: "1", source: "import" as const })), state.masterKey);
    const keys = () => getGroupKeys(db, "p", state.masterKey);
    const link = (device: string, comObj: string, gaRaws: number[], allowPlain = false) => {
      applyLinkSecurity(db, "p", device, comObj, gaRaws, { allowPlain }, state.masterKey);
      setDeviceLink(db, "p", device, comObj, gaRaws);
    };
    return { state, db, ids, keys, link, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  test("secures an automatic address with a new key when only secure devices are linked to it", () => {
    const s = setup();
    s.link(s.ids.gvs, "O-1", [2]);
    const key = s.keys().get(2)!;
    expect(key.length).toBe(16);
    expect(listGroupKeyRows(s.db, "p").find((r) => r.raw === 2)?.source).toBe("generated");
    // A second secure device keeps the key the address already has.
    s.link(s.ids.jung, "O-253", [2]);
    expect(s.keys().get(2)!.equals(key)).toBe(true);
    s.close();
  });

  test("two secured addresses get different keys", () => {
    const s = setup();
    s.link(s.ids.gvs, "O-1", [1]);
    s.link(s.ids.gvs, "O-2", [2]);
    expect(s.keys().get(1)!.equals(s.keys().get(2)!)).toBe(false);
    s.close();
  });

  test("leaves an automatic address plain while a device without security is linked to it", () => {
    const s = setup();
    s.link(s.ids.mdt, "O-0", [1]);
    s.link(s.ids.gvs, "O-1", [1]);
    expect(s.keys().has(1)).toBe(false);
    s.close();
  });

  test("a device without security turns a secured automatic address plain only when that is confirmed", () => {
    const s = setup();
    putGroupKeys(s.db, "p", [{ raw: 1, key: Buffer.alloc(16, 9), source: "import" }], s.state.masterKey);
    s.link(s.ids.gvs, "O-1", [1]);
    expect(() => s.link(s.ids.mdt, "O-0", [1])).toThrow(expect.objectContaining({ code: "SECURE_GA_TURNS_PLAIN", status: 409 }));
    expect(s.keys().has(1)).toBe(true);
    s.link(s.ids.mdt, "O-0", [1], true);
    expect(s.keys().has(1)).toBe(false);
    expect(getGaSecurity(s.db, "p", 1)).toBe("auto");
    s.close();
  });

  test("refuses a device without security on a forced-secure address, confirmed or not", () => {
    const s = setup();
    setGaSecurityMode(s.db, "p", 1, "on", s.state.masterKey);
    expect(s.keys().has(1)).toBe(true);
    for (const allow of [false, true]) {
      expect(() => s.link(s.ids.mdt, "O-0", [1], allow)).toThrow(expect.objectContaining({ code: "SECURE_GA_FORCED", status: 409 }));
    }
    expect(s.keys().has(1)).toBe(true);
    s.close();
  });

  test("a forced-plain address gets no key, whoever is linked", () => {
    const s = setup();
    setGaSecurityMode(s.db, "p", 2, "off", s.state.masterKey);
    s.link(s.ids.gvs, "O-1", [2]);
    expect(s.keys().has(2)).toBe(false);
    s.close();
  });

  test("unlinking and relinking the same address changes nothing", () => {
    const s = setup();
    s.link(s.ids.mdt, "O-0", [1]);
    s.link(s.ids.mdt, "O-0", [1]);
    s.link(s.ids.mdt, "O-0", []);
    expect(s.keys().size).toBe(0);
    s.close();
  });

  describe("changing the mode", () => {
    test("off deletes the key", () => {
      const s = setup();
      s.link(s.ids.gvs, "O-1", [1]);
      setGaSecurityMode(s.db, "p", 1, "off", s.state.masterKey);
      expect(getGaSecurity(s.db, "p", 1)).toBe("off");
      expect(s.keys().has(1)).toBe(false);
      s.close();
    });

    test("on is refused while a device without security is linked", () => {
      const s = setup();
      s.link(s.ids.mdt, "O-0", [1]);
      expect(() => setGaSecurityMode(s.db, "p", 1, "on", s.state.masterKey)).toThrow(expect.objectContaining({ code: "SECURE_GA_FORCED", status: 409 }));
      expect(getGaSecurity(s.db, "p", 1)).toBe("auto");
      s.close();
    });

    test("back to auto secures an address whose linked devices are all secure", () => {
      const s = setup();
      setGaSecurityMode(s.db, "p", 1, "off", s.state.masterKey);
      s.link(s.ids.gvs, "O-1", [1]);
      setGaSecurityMode(s.db, "p", 1, "auto", s.state.masterKey);
      expect(s.keys().has(1)).toBe(true);
      // An unlinked address in auto stays as it is: nothing says whether it is secured.
      setGaSecurityMode(s.db, "p", 2, "off", s.state.masterKey);
      setGaSecurityMode(s.db, "p", 2, "auto", s.state.masterKey);
      expect(s.keys().has(2)).toBe(false);
      s.close();
    });

    test("an unknown address is refused", () => {
      const s = setup();
      expect(() => setGaSecurityMode(s.db, "p", 99, "on", s.state.masterKey)).toThrow(expect.objectContaining({ code: "GA_NOT_FOUND" }));
      s.close();
    });
  });
});
