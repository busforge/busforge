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

// Splits `--project <id>` (or `--project=<id>`) out of a tool's arguments; the rest keeps its order for the
// positional ones. A flag without a value or given twice, any other `--` option, and more positional
// arguments than the tool takes are refused rather than taken for a path.
export function takeProjectFlag(args: readonly string[], maxPositional: number): { project: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let project: string | undefined;
  const name = (value: string | undefined) => {
    if (project !== undefined) throw new Error("--project is given twice; name one project");
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error("--project needs a project id");
    project = value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project") name(args[++i]);
    else if (arg.startsWith("--project=")) name(arg.slice("--project=".length));
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}; the only option is --project <id>`);
    else rest.push(arg);
  }
  if (rest.length > maxPositional) throw new Error(`unexpected argument ${rest[maxPositional]}`);
  return { project, rest };
}

// The project the tools work on. A database with one project needs no flag; with several the tool
// refuses until `--project <id>` names one, and lists the ids. An empty database, and an id the
// database does not hold, are refused too.
export function pickProject(db: Database, path: string, requested?: string): { id: string; name: string } {
  const rows = db.query("SELECT id, name FROM projects ORDER BY id").all() as { id: string; name: string }[];
  if (rows.length === 0) throw new Error(`the database at ${path} holds no project`);
  const listing = rows.map((r) => `${r.id} (${r.name})`).join(", ");
  if (requested !== undefined) {
    const row = rows.find((r) => r.id === requested);
    if (!row) throw new Error(`the database at ${path} holds no project ${requested}; it holds: ${listing}`);
    return row;
  }
  if (rows.length > 1) throw new Error(`the database at ${path} holds ${rows.length} projects; name one with --project <id>: ${listing}`);
  return rows[0]!;
}
