import type { Database } from "bun:sqlite";
import { appProgramId } from "@busforge/project";

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

// Drop catalog entries no longer referenced by any device (ref-counting GC, run
// after a project is deleted). The reference key is appProgramId(appRef), which is
// a code mapping, so the live set is computed in JS rather than SQL. Returns the
// number of removed entries.
export function gcAppPrograms(db: Database): number {
  const refs = db.query("SELECT DISTINCT app_ref AS appRef FROM devices").all() as { appRef: string }[];
  const live = new Set(refs.map((r) => appProgramId(r.appRef)));
  const ids = db.query("SELECT id FROM app_programs").all() as { id: string }[];
  const del = db.prepare("DELETE FROM app_programs WHERE id = ?");
  let n = 0;
  db.transaction(() => { for (const { id } of ids) if (!live.has(id)) { del.run(id); n++; } })();
  return n;
}
