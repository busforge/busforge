import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../apps/server/src/db/schema.ts";
import { firstProject, openServerDb } from "./serverdb.ts";

const withDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "busforge-serverdb-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("a tool opens the database of the isolated instance and names its project", () => {
  withDir((dir) => {
    const seed = openDb(join(dir, "busforge.db"));
    seed.query("INSERT INTO projects (id, name, imported_at, source_file) VALUES ('isolated-project', 'Isolated', 0, 'x.knxproj')").run();
    closeDb(seed);
    const { db, path } = openServerDb(dir);
    try {
      expect(path).toBe(join(dir, "busforge.db"));
      expect(firstProject(db, path)).toEqual({ id: "isolated-project", name: "Isolated" });
    } finally { db.close(); }
  });
});

test("a data directory without a database is refused and named, and is not created", () => {
  withDir((dir) => {
    const missing = join(dir, "nope");
    expect(() => openServerDb(missing)).toThrow(`no server database at ${join(missing, "busforge.db")}`);
    expect(Bun.file(missing).size).toBe(0);
  });
});

test("a database without a project is refused and named", () => {
  withDir((dir) => {
    closeDb(openDb(join(dir, "busforge.db")));
    const { db, path } = openServerDb(dir);
    try { expect(() => firstProject(db, path)).toThrow(`the database at ${path} holds no project`); } finally { db.close(); }
  });
});
