import type { Database } from "bun:sqlite";
import { seal, open } from "../secrets.ts";
import { ApiError } from "../errors.ts";

// The KNX Data Secure key store: per-device tool keys, sealed at rest with the
// instance master key (see secrets.ts). The plaintext tool key only exists in
// memory while a secure session uses it; the DB holds the sealed blob. Populated
// at project import from the parsed <Security> elements, by manual deposit, or by
// provisioning. See docs/knx-secure.md.

export type SecuritySource = "import" | "manual" | "provisioned";

// What callers hand in (plaintext key material) and get back (after unsealing).
export interface DeviceSecurityEntry {
  deviceId: string;
  toolKey: Buffer;        // 16-byte AES-128
  serialNumber: Buffer;   // 6-byte device serial (for the Sync request)
  sequenceNumber: string; // group/data counter from the project (NOT tool access)
  source: SecuritySource;
}

// Upsert sealed tool keys for a set of devices. The toolKey is sealed; everything
// else is stored as-is. Idempotent per (project, device).
export function putDeviceSecurity(db: Database, projectId: string, entries: DeviceSecurityEntry[], masterKey: Buffer): void {
  // The single guard that enforces "a secure device lands with a real key" across
  // every population path (import, manual deposit, provisioning, .busforge re-import).
  // A malformed/truncated base64 key would otherwise seal and round-trip silently and
  // only fail later mid secure-session on the bus.
  for (const e of entries) {
    if (e.toolKey.length !== 16) throw new ApiError("SECURE_KEY_BAD", `tool key for ${e.deviceId} must be 16 bytes, got ${e.toolKey.length}`);
    if (e.serialNumber.length !== 6) throw new ApiError("SECURE_KEY_BAD", `device serial for ${e.deviceId} must be 6 bytes, got ${e.serialNumber.length}`);
  }
  const ins = db.prepare(
    "INSERT OR REPLACE INTO device_security (project_id, device_id, tool_key, serial_number, seq_group, source) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const e of entries) ins.run(projectId, e.deviceId, seal(e.toolKey, masterKey), e.serialNumber, e.sequenceNumber, e.source);
  })();
}

// The unsealed security entry for one device, or null when the device has none.
// Unsealing throws a coded error (never returns a wrong key) when the master key
// does not match the sealed blob.
export function getDeviceSecurity(db: Database, projectId: string, deviceId: string, masterKey: Buffer): DeviceSecurityEntry | null {
  const row = db.query("SELECT device_id AS deviceId, tool_key AS toolKey, serial_number AS serialNumber, seq_group AS sequenceNumber, source FROM device_security WHERE project_id = ? AND device_id = ?")
    .get(projectId, deviceId) as { deviceId: string; toolKey: Uint8Array; serialNumber: Uint8Array; sequenceNumber: string; source: SecuritySource } | null;
  if (!row) return null;
  return {
    deviceId: row.deviceId,
    toolKey: open(Buffer.from(row.toolKey), masterKey),
    serialNumber: Buffer.from(row.serialNumber),
    sequenceNumber: row.sequenceNumber,
    source: row.source,
  };
}

// How many sealed tool keys exist across ALL projects. Used at startup to refuse
// booting without the master key that can open them.
export function countSealedToolKeys(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM device_security").get() as { n: number }).n;
}

// Whether one device has a stored tool key, WITHOUT touching key material.
export function isSecureDevice(db: Database, projectId: string, deviceId: string): boolean {
  return db.query("SELECT 1 FROM device_security WHERE project_id = ? AND device_id = ?").get(projectId, deviceId) !== null;
}

// Which devices in a project are secure, WITHOUT touching key material. For the UI
// (badge a device as secure) and to know whether a secure session is needed.
export function listSecureDevices(db: Database, projectId: string): { deviceId: string; source: SecuritySource }[] {
  return db.query("SELECT device_id AS deviceId, source FROM device_security WHERE project_id = ? ORDER BY device_id")
    .all(projectId) as { deviceId: string; source: SecuritySource }[];
}
