import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../apps/server/src/db/schema.ts";
import { resolveDataDir } from "../apps/server/src/app.ts";
import { firstProjectId, openServerDb, serverDataDir } from "./serverdb.ts";

const withDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "busforge-serverdb-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("the tools take the data directory from the same resolution as the server", () => {
  expect(serverDataDir({})).toBe(resolveDataDir({}));
  expect(serverDataDir({ BUSFORGE_DATA_DIR: "/tmp/busforge-isolated" })).toBe("/tmp/busforge-isolated");
  expect(() => serverDataDir({ BUSFORGE_DATA_DIR: "" })).toThrow("BUSFORGE_DATA_DIR");
});

test("a tool opens the database of the isolated instance, not the default one", () => {
  withDir((dir) => {
    const seed = openDb(join(dir, "busforge.db"));
    seed.query("INSERT INTO projects (id, name, imported_at, source_file) VALUES ('isolated-project', 'x', 0, 'x.knxproj')").run();
    closeDb(seed);
    const { db, path } = openServerDb({ BUSFORGE_DATA_DIR: dir });
    expect(path).toBe(join(dir, "busforge.db"));
    expect(firstProjectId(db, path)).toBe("isolated-project");
    db.close();
  });
});

test("a data directory without a database is refused and named", () => {
  withDir((dir) => {
    expect(() => openServerDb({ BUSFORGE_DATA_DIR: dir })).toThrow(`no server database at ${join(dir, "busforge.db")}`);
  });
});

test("a database without a project is refused and named", () => {
  withDir((dir) => {
    closeDb(openDb(join(dir, "busforge.db")));
    const { db, path } = openServerDb({ BUSFORGE_DATA_DIR: dir });
    expect(() => firstProjectId(db, path)).toThrow(`the database at ${path} holds no project`);
    db.close();
  });
});
