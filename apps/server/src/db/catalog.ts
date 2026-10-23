import type { Database } from "bun:sqlite";
import { appProgramId, appProgramName, type CatalogProduct } from "@busforge/project";

// Catalog layer: manufacturer application programs, keyed by application-program
// id (the value of appProgramId(appRef)). Global and shared across projects; a
// re-import or a second project using the same product reuses the stored entry.
// We keep the decrypted XML and parse it at runtime, so the parser stays the
// single source of truth (see docs/storage-and-snapshots.md, milestone 1).

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

// Store the images a program's TypePicture parameters show (extractPictureBaggage), after the program
// itself. Idempotent like putAppProgram.
export function putCatalogBaggage(db: Database, appProgramId: string, files: Map<string, { name: string; data: Buffer }>): void {
  const ins = db.prepare("INSERT OR IGNORE INTO catalog_baggage (app_program_id, baggage_id, name, data) VALUES (?, ?, ?, ?)");
  for (const [id, f] of files) ins.run(appProgramId, id, f.name, f.data);
}

// One stored baggage file of a program, or null.
export function getCatalogBaggage(db: Database, appProgramId: string, baggageId: string): { name: string; data: Buffer } | null {
  const r = db.query("SELECT name, data FROM catalog_baggage WHERE app_program_id = ? AND baggage_id = ?").get(appProgramId, baggageId) as { name: string; data: Uint8Array } | null;
  return r ? { name: r.name, data: Buffer.from(r.data) } : null;
}

// Every stored baggage file of a program, by baggage id.
export function listCatalogBaggage(db: Database, appProgramId: string): Map<string, { name: string; data: Buffer }> {
  const rows = db.query("SELECT baggage_id AS id, name, data FROM catalog_baggage WHERE app_program_id = ?").all(appProgramId) as { id: string; name: string; data: Uint8Array }[];
  return new Map(rows.map((r) => [r.id, { name: r.name, data: Buffer.from(r.data) }]));
}

// The image types the picture route serves, by file extension.
export const PICTURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml" };
export const pictureType = (name: string): string | undefined => PICTURE_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];

// The file names of a program's stored baggage, by baggage id.
export function catalogBaggageNames(db: Database, appProgramId: string): Map<string, string> {
  return new Map((db.query("SELECT baggage_id AS id, name FROM catalog_baggage WHERE app_program_id = ?").all(appProgramId) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

// The baggage ids of a program the catalogue holds a file for.
export function catalogBaggageIds(db: Database, appProgramId: string): Set<string> {
  return new Set((db.query("SELECT baggage_id AS id FROM catalog_baggage WHERE app_program_id = ?").all(appProgramId) as { id: string }[]).map((r) => r.id));
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

// Derive catalog products from device rows that have none, for projects whose Hardware.xml was
// not kept (a .busforge archive carries no catalog rows). Only the application program is at hand:
// the name is the manufacturer's name of that program (never a device's own name, which is the
// installer's), order number and hardware version are unknown. Only products whose application
// program is in the catalog are added, so every entry stays placeable. Idempotent (only keys not
// yet in the catalog). Returns the number of rows added.
export function backfillCatalogFromDevices(db: Database): number {
  const stored = new Set((db.query("SELECT id FROM app_programs").all() as { id: string }[]).map((r) => r.id));
  const rows = db.query(
    "SELECT DISTINCT d.app_ref AS appRef, d.product_ref AS productRef, d.manufacturer FROM devices d LEFT JOIN catalog_products c ON c.app_ref = d.app_ref AND c.product_ref = d.product_ref WHERE c.app_ref IS NULL",
  ).all() as { appRef: string; productRef: string; manufacturer: number }[];
  // One parse per program (several products can share one, and a program can be tens of MB). A program
  // whose XML does not parse names nothing here; the picker then shows the product id, and the list of
  // every other product stays available.
  const names = new Map<string, string>();
  const nameOf = (id: string) => {
    if (!names.has(id)) {
      let name = "";
      try { name = appProgramName(getAppProgram(db, id) ?? "", id); }
      catch (e) { console.error(`catalog: application program ${id} does not parse, listed without a name: ${(e as Error).message}`); }
      names.set(id, name);
    }
    return names.get(id)!;
  };
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const id = appProgramId(r.appRef);
      if (!stored.has(id)) continue; // not placeable without its program XML
      n += db.prepare(
        "INSERT OR IGNORE INTO catalog_products (app_ref, product_ref, app_program_id, manufacturer, name, order_number, hw_version) VALUES (?, ?, ?, ?, ?, '', '')",
      ).run(r.appRef, r.productRef, id, r.manufacturer, nameOf(id)).changes;
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
