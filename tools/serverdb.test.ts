import { test, expect } from "bun:test";
import { join } from "node:path";
import { closeDb, openDb } from "../apps/server/src/db/schema.ts";
import { openServerDb, pickProject, takeProjectFlag } from "./serverdb.ts";
import { removeTempDir, tempDir } from "./test-temp.ts";

const withDir = (run: (dir: string) => void) => {
  const dir = tempDir("busforge-serverdb-");
  try { run(dir); } finally { removeTempDir(dir); }
};

const seedProjects = (dir: string, projects: readonly [id: string, name: string][]) => {
  const seed = openDb(join(dir, "busforge.db"));
  for (const [id, name] of projects) {
    seed.query("INSERT INTO projects (id, name, imported_at, source_file) VALUES (?, ?, 0, 'x.knxproj')").run(id, name);
  }
  closeDb(seed);
};

test("a tool opens the database of the isolated instance and names its only project", () => {
  withDir((dir) => {
    seedProjects(dir, [["isolated-project", "Isolated"]]);
    const { db, path } = openServerDb(dir);
    try {
      expect(path).toBe(join(dir, "busforge.db"));
      expect(pickProject(db, path)).toEqual({ id: "isolated-project", name: "Isolated" });
      expect(pickProject(db, path, "isolated-project")).toEqual({ id: "isolated-project", name: "Isolated" });
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
    try {
      expect(() => pickProject(db, path)).toThrow(`the database at ${path} holds no project`);
      expect(() => pickProject(db, path, "a")).toThrow(`the database at ${path} holds no project`);
    } finally { db.close(); }
  });
});

test("a database with several projects is refused until one is named, and the refusal lists the ids", () => {
  withDir((dir) => {
    seedProjects(dir, [["p-b", "Second"], ["p-a", "First"]]);
    const { db, path } = openServerDb(dir);
    try {
      expect(() => pickProject(db, path)).toThrow(
        `the database at ${path} holds 2 projects; name one with --project <id>: p-a (First), p-b (Second)`,
      );
      expect(pickProject(db, path, "p-b")).toEqual({ id: "p-b", name: "Second" });
    } finally { db.close(); }
  });
});

test("an id the database does not hold is refused, and the refusal lists the ids it holds", () => {
  withDir((dir) => {
    seedProjects(dir, [["p-a", "First"], ["p-b", "Second"]]);
    const { db, path } = openServerDb(dir);
    try {
      expect(() => pickProject(db, path, "p-c")).toThrow(`the database at ${path} holds no project p-c; it holds: p-a (First), p-b (Second)`);
    } finally { db.close(); }
  });
});

test("--project is taken out of the arguments wherever it stands, the positional ones keep their order", () => {
  expect(takeProjectFlag(["192.168.1.2", "out"], 2)).toEqual({ project: undefined, rest: ["192.168.1.2", "out"] });
  expect(takeProjectFlag(["--project", "p-a", "192.168.1.2", "out"], 2)).toEqual({ project: "p-a", rest: ["192.168.1.2", "out"] });
  expect(takeProjectFlag(["192.168.1.2", "--project", "p-a", "out"], 2)).toEqual({ project: "p-a", rest: ["192.168.1.2", "out"] });
  expect(takeProjectFlag(["192.168.1.2", "out", "--project", "p-a"], 2)).toEqual({ project: "p-a", rest: ["192.168.1.2", "out"] });
  expect(takeProjectFlag(["192.168.1.2", "--project=p-a"], 2)).toEqual({ project: "p-a", rest: ["192.168.1.2"] });
});

test("--project without an id, or given twice, is refused", () => {
  expect(() => takeProjectFlag(["--project"], 2)).toThrow("--project needs a project id");
  expect(() => takeProjectFlag(["x", "--project", ""], 2)).toThrow("--project needs a project id");
  expect(() => takeProjectFlag(["--project="], 2)).toThrow("--project needs a project id");
  expect(() => takeProjectFlag(["--project", "--other"], 2)).toThrow("--project needs a project id");
  expect(() => takeProjectFlag(["--project", "a", "--project", "b"], 2)).toThrow("--project is given twice");
  expect(() => takeProjectFlag(["--project", "a", "--project=b"], 2)).toThrow("--project is given twice");
});

test("an unknown option, or more positional arguments than the tool takes, is refused instead of taken for a path", () => {
  expect(() => takeProjectFlag(["x", "--projekt=p-a"], 2)).toThrow("unknown option --projekt=p-a");
  expect(() => takeProjectFlag(["--force"], 1)).toThrow("unknown option --force");
  expect(() => takeProjectFlag(["a", "b", "c"], 2)).toThrow("unexpected argument c");
  expect(() => takeProjectFlag(["a", "b"], 1)).toThrow("unexpected argument b");
});
