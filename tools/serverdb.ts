// The server database the tools read: the one in the data directory the same environment would start
// the server with (BUSFORGE_DATA_DIR, else apps/server/data). A relative BUSFORGE_DATA_DIR resolves
// against the directory the tool runs in, so give an absolute one to name the server's directory.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Runs a step whose refusal ends the tool: the message goes to stderr and the exit code is 2, like the
// tools' usage errors, instead of an uncaught error with a stack trace.
export function refusing<T>(step: () => T): T {
  try { return step(); } catch (e) { console.error((e as Error).message); process.exit(2); }
}

// Opens the database read-only. A directory without one is refused: opening it would otherwise fail
// with SQLite's bare "unable to open database file", with no word on which directory was meant.
export function openServerDb(dataDir: string): { db: Database; path: string } {
  const path = join(dataDir, "busforge.db");
  if (!existsSync(path)) throw new Error(`no server database at ${path}; BUSFORGE_DATA_DIR names the data directory (unset: apps/server/data)`);
  return { db: new Database(path, { readonly: true }), path };
}

// The project the tools work on: the first one, as they always did. An empty database is refused
// instead of failing on the missing row.
export function firstProject(db: Database, path: string): { id: string; name: string } {
  const row = db.query("SELECT id, name FROM projects LIMIT 1").get() as { id: string; name: string } | null;
  if (!row) throw new Error(`the database at ${path} holds no project`);
  return row;
}
