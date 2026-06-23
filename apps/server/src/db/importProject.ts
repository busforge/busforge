import type { Database } from "bun:sqlite";
import { ApiError } from "../errors.ts";
import { putAppProgram } from "./catalog.ts";
import { putBaggage } from "./baggage.ts";
import { EXPORT_VERSION, type ProjectExport } from "./exportProject.ts";

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
  const project = d.project as { name?: unknown; interfaceIp?: unknown; interfacePort?: unknown } | null | undefined;
  if (!project || typeof project !== "object" || typeof project.name !== "string"
    || typeof project.interfaceIp !== "string" || typeof project.interfacePort !== "number") {
    throw new ApiError("BUSFORGE_INVALID", "missing or malformed project");
  }
  for (const key of ["devices", "groupRanges", "groupAddresses", "deviceParameters", "deviceParamBase", "deviceLinks", "deviceLinkBase", "deviceModules", "baggage"]) {
    if (!Array.isArray(d[key])) throw new ApiError("BUSFORGE_INVALID", `missing ${key}`);
  }
  if (!d.catalog || typeof d.catalog !== "object") throw new ApiError("BUSFORGE_INVALID", "missing catalog");
}

// Recreate the project from a validated artifact under id `id`. One transaction.
export function importProjectExport(db: Database, data: ProjectExport, id: string, now: number): void {
  db.transaction(() => {
    db.prepare("INSERT INTO projects (id, name, imported_at, source_file, interface_ip, interface_port) VALUES (?, ?, ?, '', ?, ?)")
      .run(id, data.project.name, now, data.project.interfaceIp, data.project.interfacePort);

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
  })();
}
