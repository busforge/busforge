import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/schema.ts";
import { createProject } from "../src/db/projects.ts";
import { createState } from "../src/app.ts";
import { seal, open, getMasterKey } from "../src/secrets.ts";
import { putDeviceSecurity, getDeviceSecurity, listSecureDevices } from "../src/db/deviceSecurity.ts";

const KEY = Buffer.alloc(32, 7); // fixed, synthetic master key
const OTHER = Buffer.alloc(32, 9);
const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"); // 16 bytes
const serial = Buffer.from("aabbccddeeff", "hex"); // 6 bytes

describe("secret sealing", () => {
  test("seals and unseals round-trip", () => {
    const blob = seal(toolKey, KEY);
    expect(blob).not.toEqual(toolKey); // sealed, not plaintext
    expect(blob.length).toBeGreaterThan(toolKey.length); // iv+tag overhead
    expect(open(blob, KEY)).toEqual(toolKey);
  });

  test("a wrong master key fails loudly, never returns a wrong key", () => {
    const blob = seal(toolKey, KEY);
    try { open(blob, OTHER); expect.unreachable(); }
    catch (e) { expect((e as { code?: string }).code).toBe("SECRET_UNSEAL_FAILED"); }
  });

  test("a tampered blob fails the auth tag", () => {
    const blob = seal(toolKey, KEY);
    blob[blob.length - 1] ^= 0xff;
    expect(() => open(blob, KEY)).toThrow();
  });

  test("rejects a wrong-length master key with a coded error, not a generic crypto throw", () => {
    for (const fn of [() => seal(toolKey, Buffer.alloc(16)), () => open(seal(toolKey, KEY), Buffer.alloc(16))]) {
      try { fn(); expect.unreachable(); }
      catch (e) { expect((e as { code?: string }).code).toBe("MASTER_KEY_BAD"); }
    }
  });
});

describe("getMasterKey", () => {
  test("accepts a hex env key", () => {
    process.env.BUSFORGE_MASTER_KEY = "aa".repeat(32);
    try { expect(getMasterKey("/nonexistent")).toEqual(Buffer.alloc(32, 0xaa)); }
    finally { delete process.env.BUSFORGE_MASTER_KEY; }
  });

  test("creates and then reuses a master.key file when no env key is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-mk-"));
    try {
      delete process.env.BUSFORGE_MASTER_KEY;
      const k1 = getMasterKey(dir);
      expect(k1.length).toBe(32);
      expect(existsSync(join(dir, "master.key"))).toBe(true);
      expect(getMasterKey(dir)).toEqual(k1); // stable across calls
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("refuses a malformed env key", () => {
    process.env.BUSFORGE_MASTER_KEY = "tooshort";
    try { expect(() => getMasterKey("/nonexistent")).toThrow(/32 bytes/); }
    finally { delete process.env.BUSFORGE_MASTER_KEY; }
  });
});

describe("device_security store", () => {
  const setup = () => {
    const db = openDb(":memory:");
    createProject(db, "proj", "P", 1);
    return db;
  };

  test("stores a tool key sealed and returns it unsealed", () => {
    const db = setup();
    putDeviceSecurity(db, "proj", [{ deviceId: "DI-1", toolKey, serialNumber: serial, sequenceNumber: "42", source: "import" }], KEY);

    const got = getDeviceSecurity(db, "proj", "DI-1", KEY)!;
    expect(got.toolKey).toEqual(toolKey);
    expect(got.serialNumber).toEqual(serial);
    expect(got.sequenceNumber).toBe("42");
    expect(got.source).toBe("import");

    // The raw column is the sealed blob, never the plaintext key.
    const raw = db.query("SELECT tool_key FROM device_security WHERE device_id = 'DI-1'").get() as { tool_key: Uint8Array };
    expect(Buffer.from(raw.tool_key)).not.toEqual(toolKey);
  });

  test("returns null for a device with no key", () => {
    expect(getDeviceSecurity(setup(), "proj", "DI-none", KEY)).toBeNull();
  });

  test("lists secure devices without exposing key material", () => {
    const db = setup();
    putDeviceSecurity(db, "proj", [
      { deviceId: "DI-1", toolKey, serialNumber: serial, sequenceNumber: "1", source: "import" },
      { deviceId: "DI-2", toolKey, serialNumber: serial, sequenceNumber: "2", source: "manual" },
    ], KEY);
    expect(listSecureDevices(db, "proj")).toEqual([
      { deviceId: "DI-1", source: "import" },
      { deviceId: "DI-2", source: "manual" },
    ]);
  });

  test("a key sealed under another instance's master key cannot be opened (no silent wrong key)", () => {
    const db = setup();
    putDeviceSecurity(db, "proj", [{ deviceId: "DI-1", toolKey, serialNumber: serial, sequenceNumber: "1", source: "import" }], KEY);
    expect(() => getDeviceSecurity(db, "proj", "DI-1", OTHER)).toThrow();
  });

  test("upsert replaces an existing entry", () => {
    const db = setup();
    putDeviceSecurity(db, "proj", [{ deviceId: "DI-1", toolKey, serialNumber: serial, sequenceNumber: "1", source: "import" }], KEY);
    const newKey = Buffer.alloc(16, 0xab);
    putDeviceSecurity(db, "proj", [{ deviceId: "DI-1", toolKey: newKey, serialNumber: serial, sequenceNumber: "5", source: "provisioned" }], KEY);
    const got = getDeviceSecurity(db, "proj", "DI-1", KEY)!;
    expect(got.toolKey).toEqual(newKey);
    expect(got.source).toBe("provisioned");
    expect(listSecureDevices(db, "proj")).toHaveLength(1);
  });

  test("refuses a tool key that is not 16 bytes or a serial that is not 6 bytes (no silent bad key)", () => {
    const db = setup();
    expect(() => putDeviceSecurity(db, "proj", [{ deviceId: "DI-1", toolKey: Buffer.alloc(15), serialNumber: serial, sequenceNumber: "1", source: "import" }], KEY)).toThrow(/16 bytes/);
    expect(() => putDeviceSecurity(db, "proj", [{ deviceId: "DI-1", toolKey, serialNumber: Buffer.alloc(5), sequenceNumber: "1", source: "import" }], KEY)).toThrow(/6 bytes/);
    expect(listSecureDevices(db, "proj")).toHaveLength(0); // nothing stored
  });
});

describe("master-key startup guard", () => {
  test("createState refuses to start when sealed keys exist but no master key is available", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bf-seed-"));
    const empty = mkdtempSync(join(tmpdir(), "bf-empty-"));
    const dbPath = join(dataDir, "busforge.db");
    try {
      delete process.env.BUSFORGE_MASTER_KEY;
      const db = openDb(dbPath);
      createProject(db, "p", "P", 1);
      putDeviceSecurity(db, "p", [{ deviceId: "d", toolKey, serialNumber: serial, sequenceNumber: "1", source: "import" }], getMasterKey(dataDir));
      db.close();
      // start against the same DB but a different, key-less data dir -> must refuse,
      // never auto-generate a new key that cannot open the existing sealed rows.
      expect(() => createState({ dbPath, dataDir: empty })).toThrow(/master key/i);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
