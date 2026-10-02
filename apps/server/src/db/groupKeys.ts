import type { Database } from "bun:sqlite";
import { seal, open } from "../secrets.ts";
import { ApiError } from "../errors.ts";

// KNX Data Secure group keys: one 16-byte AES-128 key per secured group address, sealed at rest
// with the instance master key like the tool keys (deviceSecurity.ts). A device's security object
// is loaded with the keys of the secured addresses it is linked to. See docs/knx-secure.md.

// "generated": made by Busforge for an address it secured (gaSecurity.ts); the rest as for tool keys.
export type GroupKeySource = "import" | "manual" | "provisioned" | "generated";
export interface GroupKeyEntry { raw: number; key: Buffer; source: GroupKeySource; }

export function putGroupKeys(db: Database, projectId: string, entries: GroupKeyEntry[], masterKey: Buffer): void {
  for (const e of entries) {
    if (!Number.isInteger(e.raw) || e.raw < 0 || e.raw > 0xffff) throw new ApiError("SECURE_KEY_BAD", `group address ${e.raw} is not a 16-bit address`);
    if (e.key.length !== 16) throw new ApiError("SECURE_KEY_BAD", `group key for address ${e.raw} must be 16 bytes, got ${e.key.length}`);
  }
  const ins = db.prepare("INSERT OR REPLACE INTO group_keys (project_id, raw, key, source) VALUES (?, ?, ?, ?)");
  db.transaction(() => {
    for (const e of entries) ins.run(projectId, e.raw, seal(e.key, masterKey), e.source);
  })();
}

// Every group key of a project, unsealed, by raw address.
export function getGroupKeys(db: Database, projectId: string, masterKey: Buffer): Map<number, Buffer> {
  const rows = db.query("SELECT raw, key FROM group_keys WHERE project_id = ?").all(projectId) as { raw: number; key: Uint8Array }[];
  return new Map(rows.map((r) => [r.raw, open(Buffer.from(r.key), masterKey)]));
}

// The sealed rows as stored, for the .busforge export (which unseals them itself).
export function listGroupKeyRows(db: Database, projectId: string): { raw: number; key: Buffer; source: GroupKeySource }[] {
  return (db.query("SELECT raw, key, source FROM group_keys WHERE project_id = ? ORDER BY raw").all(projectId) as { raw: number; key: Uint8Array; source: GroupKeySource }[])
    .map((r) => ({ raw: r.raw, key: Buffer.from(r.key), source: r.source }));
}

export function hasGroupKey(db: Database, projectId: string, raw: number): boolean {
  return db.query("SELECT 1 FROM group_keys WHERE project_id = ? AND raw = ?").get(projectId, raw) !== null;
}

export function deleteGroupKey(db: Database, projectId: string, raw: number): boolean {
  return db.prepare("DELETE FROM group_keys WHERE project_id = ? AND raw = ?").run(projectId, raw).changes > 0;
}

export function countSealedGroupKeys(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM group_keys").get() as { n: number }).n;
}
