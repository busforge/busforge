import type { Database } from "bun:sqlite";
import { appProgramId, type CatalogProduct } from "@busforge/project";

// Catalog layer: manufacturer application programs, keyed by application-program
// id (the value of appProgramId(appRef)). Global and shared across projects; a
// re-import or a second project using the same product reuses the stored entry.
// We keep the decrypted XML and parse it at runtime, so the parser stays the
// single source of truth (see docs/storage-and-snapshots-design.md, milestone 1).

// Store an application program (idempotent: the XML for a given id is identical
// manufacturer data, so an existing row is left untouched).
export function putAppProgram(db: Database, id: string, xml: string): void {
  db.prepare("INSERT OR IGNORE INTO app_programs (id, xml) VALUES (?, ?)").run(id, xml);
}

// The stored application-program XML for an id, or null when not in the catalog.
export function getAppProgram(db: Database, id: string): string | null {
  const r = db.query("SELECT xml FROM app_programs WHERE id = ?").get(id) as { xml: string } | null;
  return r?.xml ?? null;
}

// Catalog product metadata (the browsable layer for placing devices). Idempotent:
// the first ingest of a (product, app program) wins; richer Hardware.xml data is
// not overwritten by a later minimal backfill. `pin` marks an official-source
// (.knxprod) ingest: the row stays in the catalog independent of any project, and
// re-importing a product that arrived earlier via a project upgrades it to pinned.
export function putCatalogProduct(db: Database, p: CatalogProduct, pin = false): void {
  if (pin) {
    db.prepare(
      "INSERT INTO catalog_products (app_ref, product_ref, app_program_id, manufacturer, name, order_number, hw_version, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(app_ref, product_ref) DO UPDATE SET pinned = 1",
    ).run(p.appRef, p.productRef, p.appProgramId, p.manufacturer, p.name, p.orderNumber, p.hwVersion);
  } else {
    db.prepare(
      "INSERT OR IGNORE INTO catalog_products (app_ref, product_ref, app_program_id, manufacturer, name, order_number, hw_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(p.appRef, p.productRef, p.appProgramId, p.manufacturer, p.name, p.orderNumber, p.hwVersion);
  }
}

// All placeable catalog products, ordered for the device picker.
export function listCatalogProducts(db: Database): CatalogProduct[] {
  return db.query(
    "SELECT app_ref AS appRef, product_ref AS productRef, app_program_id AS appProgramId, manufacturer, name, order_number AS orderNumber, hw_version AS hwVersion FROM catalog_products ORDER BY name, order_number",
  ).all() as CatalogProduct[];
}

// One catalog product by its (appRef, productRef) key, or null.
export function getCatalogProduct(db: Database, appRef: string, productRef: string): CatalogProduct | null {
  return db.query(
    "SELECT app_ref AS appRef, product_ref AS productRef, app_program_id AS appProgramId, manufacturer, name, order_number AS orderNumber, hw_version AS hwVersion FROM catalog_products WHERE app_ref = ? AND product_ref = ?",
  ).get(appRef, productRef) as CatalogProduct | null;
}

// Derive catalog products from already-imported device rows, for projects imported
// before catalog_products existed (their Hardware.xml is no longer kept, so only
// the device's own fields are available: name falls back to the instance name,
// order number and hardware version are unknown). Only products whose application
// program is in the catalog are added, so every entry stays placeable. Idempotent
// (INSERT OR IGNORE on the existing key). Returns the number of rows added.
export function backfillCatalogFromDevices(db: Database): number {
  const stored = new Set((db.query("SELECT id FROM app_programs").all() as { id: string }[]).map((r) => r.id));
  const rows = db.query(
    "SELECT app_ref AS appRef, product_ref AS productRef, manufacturer, MAX(name) AS name FROM devices GROUP BY app_ref, product_ref, manufacturer",
  ).all() as { appRef: string; productRef: string; manufacturer: number; name: string }[];
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const id = appProgramId(r.appRef);
      if (!stored.has(id)) continue; // not placeable without its program XML
      n += db.prepare(
        "INSERT OR IGNORE INTO catalog_products (app_ref, product_ref, app_program_id, manufacturer, name, order_number, hw_version) VALUES (?, ?, ?, ?, ?, '', '')",
      ).run(r.appRef, r.productRef, id, r.manufacturer, r.name ?? "").changes;
    }
  })();
  return n;
}

// Drop catalog entries no longer referenced by any device (ref-counting GC, run
// after a project is deleted). The reference key is appProgramId(appRef), which is
// a code mapping, so the live set is computed in JS rather than SQL. Pinned catalog
// products (ingested from an official .knxprod) are independent GC roots, so their
// program and row survive even with no device using them. Returns the number of
// removed entries.
export function gcAppPrograms(db: Database): number {
  const refs = db.query("SELECT DISTINCT app_ref AS appRef FROM devices").all() as { appRef: string }[];
  const live = new Set(refs.map((r) => appProgramId(r.appRef)));
  for (const r of db.query("SELECT DISTINCT app_program_id AS id FROM catalog_products WHERE pinned = 1").all() as { id: string }[]) live.add(r.id);
  const ids = db.query("SELECT id FROM app_programs").all() as { id: string }[];
  const del = db.prepare("DELETE FROM app_programs WHERE id = ?");
  // A catalog product without its program XML is unplaceable, so drop those rows
  // alongside the program (keeps the "every catalog product is placeable" invariant).
  const delProd = db.prepare("DELETE FROM catalog_products WHERE app_program_id = ?");
  let n = 0;
  db.transaction(() => { for (const { id } of ids) if (!live.has(id)) { del.run(id); delProd.run(id); n++; } })();
  return n;
}
