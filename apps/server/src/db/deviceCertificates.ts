import type { Database } from "bun:sqlite";
import { seal, open } from "../secrets.ts";
import { ApiError } from "../errors.ts";

// KNX Data Secure device certificates: a secure device's factory default setup key (FDSK) and its
// serial, from the label printed on it, sealed at rest with the instance master key. The FDSK opens
// the first secured session of a factory-fresh device, and again after a master reset.

export interface DeviceCertificateEntry { deviceId: string; fdsk: Buffer; serialNumber: Buffer; }

export function putDeviceCertificate(db: Database, projectId: string, e: DeviceCertificateEntry, masterKey: Buffer): void {
  if (e.fdsk.length !== 16) throw new ApiError("SECURE_KEY_BAD", `the factory key for ${e.deviceId} must be 16 bytes, got ${e.fdsk.length}`);
  if (e.serialNumber.length !== 6) throw new ApiError("SECURE_KEY_BAD", `the device serial for ${e.deviceId} must be 6 bytes, got ${e.serialNumber.length}`);
  db.prepare("INSERT OR REPLACE INTO device_certificates (project_id, device_id, fdsk, serial_number) VALUES (?, ?, ?, ?)")
    .run(projectId, e.deviceId, seal(e.fdsk, masterKey), e.serialNumber);
}

export function getDeviceCertificate(db: Database, projectId: string, deviceId: string, masterKey: Buffer): DeviceCertificateEntry | null {
  const row = db.query("SELECT fdsk, serial_number AS serialNumber FROM device_certificates WHERE project_id = ? AND device_id = ?")
    .get(projectId, deviceId) as { fdsk: Uint8Array; serialNumber: Uint8Array } | null;
  return row ? { deviceId, fdsk: open(Buffer.from(row.fdsk), masterKey), serialNumber: Buffer.from(row.serialNumber) } : null;
}

// The rows as stored, for the .busforge export (which unseals them itself).
export function listDeviceCertificateRows(db: Database, projectId: string): { deviceId: string; fdsk: Buffer; serialNumber: Buffer }[] {
  return (db.query("SELECT device_id AS deviceId, fdsk, serial_number AS serialNumber FROM device_certificates WHERE project_id = ? ORDER BY device_id").all(projectId) as { deviceId: string; fdsk: Uint8Array; serialNumber: Uint8Array }[])
    .map((r) => ({ deviceId: r.deviceId, fdsk: Buffer.from(r.fdsk), serialNumber: Buffer.from(r.serialNumber) }));
}

export function countSealedCertificates(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM device_certificates").get() as { n: number }).n;
}
