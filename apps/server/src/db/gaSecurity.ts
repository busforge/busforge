import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { numToGa } from "@busforge/knx";
import type { GroupAddressSecurity } from "@busforge/project";
import { ApiError } from "../errors.ts";
import { putGroupKeys, hasGroupKey, deleteGroupKey } from "./groupKeys.ts";
import { isSecureDevice } from "./deviceSecurity.ts";

// A group address's Data Secure mode and the rules ETS 6.4.1 applies to it (findings.md §22).
// Whether an address is secured is whether the project holds a key for it; the mode decides when
// Busforge makes or drops that key. A device counts as secure when the project holds a tool key for it.
//
// - "auto" (ETS "Automatisch"): an address without a key gets a new one as soon as a secure device is
//   linked to it and every device linked to it is secure. A device without security linked to a
//   secured address turns it plain for every device on it, after the user confirms.
// - "on" ("Erzwungen an"): always keyed; a device without security cannot be linked.
// - "off" ("Erzwungen aus"): never keyed.
//
// A new key, or one dropped, changes the security object of every secure device on the address; they
// need their tables written again, as in ETS.

export function getGaSecurity(db: Database, projectId: string, raw: number): GroupAddressSecurity | null {
  const row = db.query("SELECT security FROM group_addresses WHERE project_id = ? AND raw = ?").get(projectId, raw) as { security: GroupAddressSecurity } | null;
  return row?.security ?? null;
}

// The devices linked to an address, apart from one com-object (the one whose links are being replaced).
function linkedDevices(db: Database, projectId: string, raw: number, except?: { deviceId: string; comObjRefId: string }): string[] {
  const rows = db.query("SELECT DISTINCT device_id AS d FROM device_links WHERE project_id = ? AND ga_raw = ? AND NOT (device_id = ? AND com_obj_ref_id = ?)")
    .all(projectId, raw, except?.deviceId ?? "", except?.comObjRefId ?? "") as { d: string }[];
  return rows.map((r) => r.d);
}

function generateKey(db: Database, projectId: string, raw: number, masterKey: Buffer): void {
  putGroupKeys(db, projectId, [{ raw, key: randomBytes(16), source: "generated" }], masterKey);
}

// Applies the mode rules for a com-object about to be linked to `gaRaws` (its whole new set): makes or
// drops keys, or refuses. Addresses it is already linked to are left alone. Call it in the same
// transaction as the link write.
export function applyLinkSecurity(db: Database, projectId: string, deviceId: string, comObjRefId: string, gaRaws: number[], opts: { allowPlain: boolean }, masterKey: Buffer): void {
  const current = new Set((db.query("SELECT ga_raw AS g FROM device_links WHERE project_id = ? AND device_id = ? AND com_obj_ref_id = ?")
    .all(projectId, deviceId, comObjRefId) as { g: number }[]).map((r) => r.g));
  const secure = isSecureDevice(db, projectId, deviceId);
  for (const raw of new Set(gaRaws)) {
    if (current.has(raw)) continue;
    const mode = getGaSecurity(db, projectId, raw);
    if (mode === null || mode === "off") continue;
    const keyed = hasGroupKey(db, projectId, raw);
    if (!secure) {
      if (mode === "on") {
        throw new ApiError("SECURE_GA_FORCED", `group address ${numToGa(raw)} is forced secure, and this device has no tool key in the project; it cannot be linked to it`, 409);
      }
      if (keyed) {
        if (!opts.allowPlain) {
          throw new ApiError("SECURE_GA_TURNS_PLAIN", `group address ${numToGa(raw)} is secured, and this device has no tool key in the project; linking it turns the address plain for every device on it`, 409);
        }
        deleteGroupKey(db, projectId, raw);
      }
      continue;
    }
    if (keyed) continue;
    const others = linkedDevices(db, projectId, raw, { deviceId, comObjRefId });
    if (mode === "on" || others.every((d) => isSecureDevice(db, projectId, d))) generateKey(db, projectId, raw, masterKey);
  }
}

// Sets an address's mode and brings its key in line: "off" drops it, "on" makes one (refused while a
// device without security is linked), "auto" makes one when devices are linked and all are secure.
export function setGaSecurityMode(db: Database, projectId: string, raw: number, mode: GroupAddressSecurity, masterKey: Buffer): void {
  if (getGaSecurity(db, projectId, raw) === null) throw new ApiError("GA_NOT_FOUND", "group address not found", 404);
  db.transaction(() => {
    const devices = linkedDevices(db, projectId, raw);
    const allSecure = devices.every((d) => isSecureDevice(db, projectId, d));
    if (mode === "on" && !allSecure) {
      throw new ApiError("SECURE_GA_FORCED", `a device without a tool key in the project is linked to group address ${numToGa(raw)}; it cannot be forced secure`, 409);
    }
    db.prepare("UPDATE group_addresses SET security = ? WHERE project_id = ? AND raw = ?").run(mode, projectId, raw);
    const keyed = hasGroupKey(db, projectId, raw);
    if (mode === "off") { if (keyed) deleteGroupKey(db, projectId, raw); return; }
    if (keyed) return;
    if (mode === "on" || (devices.length > 0 && allSecure)) generateKey(db, projectId, raw, masterKey);
  })();
}
