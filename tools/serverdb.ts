// The server database and data directory the tools read: the ones of the server the same
// environment would start, so BUSFORGE_DATA_DIR points a tool at an isolated instance exactly as it
// points the server (docs/development.md, "An isolated instance").
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../apps/server/src/app.ts";

export function serverDataDir(env: Record<string, string | undefined> = process.env): string {
  return resolveDataDir(env);
}

// Opens the database read-only. A directory without one is refused: opening it would otherwise fail
// with SQLite's bare "unable to open database file", with no word on which directory was meant.
export function openServerDb(env: Record<string, string | undefined> = process.env): { db: Database; path: string } {
  const path = join(serverDataDir(env), "busforge.db");
  if (!existsSync(path)) throw new Error(`no server database at ${path} (BUSFORGE_DATA_DIR ${env.BUSFORGE_DATA_DIR === undefined ? "is unset, the default directory is used" : "names this directory"})`);
  return { db: new Database(path, { readonly: true }), path };
}

// The id of the project the tools work on: the first one, as they always did. An empty database is
// refused instead of failing on the missing row.
export function firstProjectId(db: Database, path: string): string {
  const row = db.query("SELECT id FROM projects LIMIT 1").get() as { id: string } | null;
  if (!row) throw new Error(`the database at ${path} holds no project`);
  return row.id;
}
