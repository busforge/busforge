import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { appProgramId } from "@busforge/project";
import { ApiError } from "../errors.ts";
import { putAppProgram } from "./catalog.ts";
import { putBaggage } from "./baggage.ts";
import { insertSpaces } from "./projects.ts";
import { applyProjectProperties } from "./projectProps.ts";
import { EXPORT_VERSION, type ProjectExport } from "./exportProject.ts";
import { putDeviceSecurity, type SecuritySource } from "./deviceSecurity.ts";

// Re-import a .busforge project artifact (the inverse of exportProject): recreate
// the whole project under a fresh id, restore its referenced catalog application
// programs and DCA baggage. The catalog programs are restored as ordinary (unpinned)
// app_programs; their browsable catalog_products rows are derived on demand by the
// device-backfill, exactly like any project import.
//
// group_ranges.id is a global autoincrement, so the stored ids cannot be reused
// verbatim. We remap old -> new as we insert. The export orders ranges by id, and a
// parent always has a lower id than its children (insert order), so a single forward
// pass sees every parent before its children.

// Validate the parsed artifact enough to trust its shape, throwing a coded ApiError
// the API surfaces as a 400. Everything importProjectExport dereferences is checked
// here so a malformed (but version-1) artifact fails cleanly rather than crashing
// mid-insert; the row contents themselves are inserted as-is (our own serializer).
export function validateExport(data: unknown): asserts data is ProjectExport {
  if (!data || typeof data !== "object") throw new ApiError("BUSFORGE_INVALID", "not a busforge artifact");
  const d = data as Record<string, unknown>;
  if (d.busforgeExport !== EXPORT_VERSION) {
    throw new ApiError("BUSFORGE_VERSION_UNSUPPORTED", `unsupported export version ${String(d.busforgeExport)} (expected ${EXPORT_VERSION})`);
  }
  const project = d.project as { name?: unknown; connectionId?: unknown } | null | undefined;
  if (!project || typeof project !== "object" || typeof project.name !== "string") {
    throw new ApiError("BUSFORGE_INVALID", "missing or malformed project");
  }
  // connectionId is optional (absent in pre-connection artifacts); if present it
  // must be a string or null. Older artifacts may also carry now-ignored
  // interfaceIp/interfacePort fields; those are simply not read.
  if (project.connectionId !== undefined && project.connectionId !== null && typeof project.connectionId !== "string") {
    throw new ApiError("BUSFORGE_INVALID", "malformed project connectionId");
  }
  for (const key of ["devices", "groupRanges", "groupAddresses", "deviceParameters", "deviceParamBase", "deviceLinks", "deviceLinkBase", "deviceModules", "baggage"]) {
    if (!Array.isArray(d[key])) throw new ApiError("BUSFORGE_INVALID", `missing ${key}`);
  }
  // Validate each device's identity/reference fields so a crafted artifact fails as a clean
  // 400 rather than crashing later: busforgeGaps calls appProgramId(appRef).split(...) and
  // importProjectExport binds these into insDev, both of which throw a generic 500 on a
  // missing field. Everything dereferenced downstream is a string.
  const seenDeviceIds = new Set<string>();
  for (const dev of d.devices as Record<string, unknown>[]) {
    if (typeof dev.id !== "string" || typeof dev.ia !== "string" || typeof dev.name !== "string" || typeof dev.appRef !== "string") {
      throw new ApiError("BUSFORGE_INVALID", "malformed device entry");
    }
    // Duplicate instance ids would merge their per-device config last-wins on insert; refuse
    // with the same coded error the knxproj import uses (insertProject), so both paths fail
    // cleanly before touching the DB instead of hitting the raw unique index mid-transaction.
    if (seenDeviceIds.has(dev.id)) throw new ApiError("DUPLICATE_DEVICE_INSTANCE", `two devices share the instance id ${dev.id}`);
    seenDeviceIds.add(dev.id);
  }
  // Optional arrays: absent is fine, but a present non-array must fail cleanly as
  // a 400 rather than throwing mid-insert and surfacing as a generic 500.
  for (const key of ["snapshots", "telegrams", "spaces", "deviceSecurity"]) {
    if (d[key] !== undefined && !Array.isArray(d[key])) throw new ApiError("BUSFORGE_INVALID", `malformed ${key}`);
  }
  // Validate each security entry's shape so a crafted artifact fails as a clean 400
  // (not a generic 500 from Buffer.from(undefined) mid-insert). Key/serial byte lengths
  // are enforced by putDeviceSecurity, the one guard shared by every population path.
  for (const s of (d.deviceSecurity as Record<string, unknown>[] | undefined) ?? []) {
    if (typeof s.deviceId !== "string" || typeof s.toolKey !== "string" || typeof s.serialNumber !== "string" || typeof s.sequenceNumber !== "string") {
      throw new ApiError("BUSFORGE_INVALID", "malformed deviceSecurity entry");
    }
    if (s.source !== undefined && !["import", "manual", "provisioned"].includes(s.source as string)) {
      throw new ApiError("BUSFORGE_INVALID", "malformed deviceSecurity source");
    }
  }
  if (!d.catalog || typeof d.catalog !== "object") throw new ApiError("BUSFORGE_INVALID", "missing catalog");
}

// Gaps in a .busforge artifact, the analogue of importGaps for the knxproj path: devices
// whose application program is not in the carried catalog. They re-import as un-configurable
// husks, e.g. because the source project already had husk devices, or a legacy project's
// source_file was gone when it was exported so exportProject could not backfill the catalog.
// Derived from the artifact itself (device appRef vs catalog keys), so it needs no
// export-format change and stays in sync with what importProjectExport actually stores.
export function busforgeGaps(data: ProjectExport): { devicesWithoutProgram: { ia: string; name: string }[] } {
  const devicesWithoutProgram = data.devices
    .filter((d) => !Object.hasOwn(data.catalog, appProgramId(d.appRef))) // hasOwn, not `in`: catalog is stored by own keys (Object.entries), so a prototype key like "toString" is NOT a match
    .map((d) => ({ ia: d.ia, name: d.name }));
  return { devicesWithoutProgram };
}

// Recreate the project from a validated artifact under id `id`. One transaction.
// masterKey re-seals the imported tool keys under THIS instance's key.
export function importProjectExport(db: Database, data: ProjectExport, id: string, now: number, masterKey: Buffer): void {
  db.transaction(() => {
    // Insert the bare row, then apply the shared project properties (name +
    // connection reference, FK-safe) the same way snapshot restore does.
    db.prepare("INSERT INTO projects (id, name, imported_at, source_file) VALUES (?, ?, ?, '')")
      .run(id, data.project.name, now);
    applyProjectProperties(db, id, data.project);

    const insDev = db.prepare("INSERT INTO devices (project_id, instance_id, ia, name, product_ref, app_ref, manufacturer, comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const d of data.devices) insDev.run(id, d.id, d.ia, d.name, d.productRef, d.appRef, d.manufacturer, d.comment);

    const insRange = db.prepare("INSERT INTO group_ranges (project_id, parent_id, name, range_start, range_end) VALUES (?, ?, ?, ?, ?)");
    const idMap = new Map<number, number>(); // exported range id -> new row id
    for (const r of data.groupRanges) {
      const parent = r.parentId == null ? null : idMap.get(r.parentId) ?? null;
      const newId = Number(insRange.run(id, parent, r.name, r.rangeStart, r.rangeEnd).lastInsertRowid);
      idMap.set(r.id, newId);
    }
    const insGa = db.prepare("INSERT INTO group_addresses (project_id, range_id, raw, address, name, dpt) VALUES (?, ?, ?, ?, ?, ?)");
    for (const g of data.groupAddresses) insGa.run(id, g.rangeId == null ? null : idMap.get(g.rangeId) ?? null, g.raw, g.address, g.name, g.dpt);

    insertSpaces(db, id, data.spaces ?? []);

    const insParam = db.prepare("INSERT OR REPLACE INTO device_parameters (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)");
    for (const p of data.deviceParameters) insParam.run(id, p.deviceId, p.paramRefId, p.value);
    const insParamBase = db.prepare("INSERT OR REPLACE INTO device_param_base (project_id, device_id, param_ref_id, value) VALUES (?, ?, ?, ?)");
    for (const p of data.deviceParamBase) insParamBase.run(id, p.deviceId, p.paramRefId, p.value);

    const insLink = db.prepare("INSERT OR REPLACE INTO device_links (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    for (const l of data.deviceLinks) insLink.run(id, l.deviceId, l.comObjRefId, l.slot, l.gaRaw);
    const insLinkBase = db.prepare("INSERT OR REPLACE INTO device_link_base (project_id, device_id, com_obj_ref_id, slot, ga_raw) VALUES (?, ?, ?, ?, ?)");
    for (const l of data.deviceLinkBase) insLinkBase.run(id, l.deviceId, l.comObjRefId, l.slot, l.gaRaw);

    const insMod = db.prepare("INSERT INTO device_modules (project_id, device_id, instances) VALUES (?, ?, ?)");
    for (const m of data.deviceModules) insMod.run(id, m.deviceId, JSON.stringify(m.instances));

    for (const [cid, xml] of Object.entries(data.catalog)) putAppProgram(db, cid, xml);
    for (const b of data.baggage) putBaggage(db, id, b.name, Buffer.from(b.dataBase64, "base64"));

    // Restore points and the recorded bus log. Snapshot ids are regenerated (the
    // column is a global primary key, so reusing them would collide if the same
    // artifact is imported twice); telegram ids are autoincremented.
    const insSnap = db.prepare("INSERT INTO snapshots (id, project_id, label, kind, reason, created_at, schema_version, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const s of data.snapshots ?? []) insSnap.run(randomUUID(), id, s.label, s.kind, s.reason, s.createdAt, s.schemaVersion, s.payload);
    const insTel = db.prepare("INSERT INTO telegrams (project_id, ts, src, dst_raw, kind, data) VALUES (?, ?, ?, ?, ?, ?)");
    for (const tg of data.telegrams ?? []) insTel.run(id, tg.ts, tg.src, tg.dstRaw, tg.kind, tg.data);

    // KNX Data Secure tool keys: re-sealed under this instance's master key.
    if (data.deviceSecurity?.length) {
      putDeviceSecurity(db, id, data.deviceSecurity.map((s) => ({
        deviceId: s.deviceId,
        toolKey: Buffer.from(s.toolKey, "base64"),
        serialNumber: Buffer.from(s.serialNumber, "base64"),
        sequenceNumber: s.sequenceNumber,
        source: (s.source as SecuritySource) || "import",
      })), masterKey);
    }
  })();
}
