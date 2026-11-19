import { test, expect, setDefaultTimeout } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveDataDir, resolvePort } from "../src/app.ts";
import { removeTempDir, tempDir } from "../../../tools/test-temp.ts";

setDefaultTimeout(60_000);

const serverEntry = join(import.meta.dir, "..", "src", "index.ts");

test("the data directory defaults to apps/server/data and BUSFORGE_DATA_DIR replaces it", () => {
  expect(resolveDataDir({})).toBe(resolve(import.meta.dir, "..", "data"));
  expect(resolveDataDir({ BUSFORGE_DATA_DIR: "/tmp/busforge-isolated" })).toBe("/tmp/busforge-isolated");
  expect(resolveDataDir({ BUSFORGE_DATA_DIR: "rel/dir" })).toBe(resolve("rel/dir"));
});

test("an empty BUSFORGE_DATA_DIR is refused instead of falling back to the default directory", () => {
  expect(() => resolveDataDir({ BUSFORGE_DATA_DIR: "" })).toThrow("BUSFORGE_DATA_DIR");
  expect(() => resolveDataDir({ BUSFORGE_DATA_DIR: "  " })).toThrow("BUSFORGE_DATA_DIR");
});

test("PORT defaults to 3000 and anything that is not a port number is refused", () => {
  expect(resolvePort({})).toBe(3000);
  expect(resolvePort({ PORT: "3917" })).toBe(3917);
  expect(resolvePort({ PORT: "0" })).toBe(0);
  for (const bad of ["", "abc", "-1", "65536", "30 00", "3000.5"]) expect(() => resolvePort({ PORT: bad })).toThrow("PORT");
});

test("the server entry point refuses to start on an empty BUSFORGE_DATA_DIR or a bad PORT, with exit code 1", async () => {
  const dir = tempDir("busforge-data-dir-");
  try {
    for (const [name, env] of [["BUSFORGE_DATA_DIR", { BUSFORGE_DATA_DIR: "" }], ["PORT", { BUSFORGE_DATA_DIR: dir, PORT: "" }]] as const) {
      const child = Bun.spawn(["bun", "run", serverEntry], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(err).toContain("refusing to start");
      expect(err).toContain(name);
    }
  } finally {
    removeTempDir(dir);
  }
});

test("the server entry point opens its database in BUSFORGE_DATA_DIR on the port PORT names", async () => {
  const dir = tempDir("busforge-data-dir-");
  const child = Bun.spawn(["bun", "run", serverEntry], {
    env: { ...process.env, BUSFORGE_DATA_DIR: join(dir, "nested"), PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // The first stdout line is "Busforge server on http://localhost:<port>", printed once the
    // database is open and the listener is bound.
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("Busforge server on")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited before listening: ${out}${await new Response(child.stderr).text()}`);
      out += new TextDecoder().decode(value);
    }
    const port = Number(/localhost:(\d+)/.exec(out)?.[1]);
    expect(port).toBeGreaterThan(0);
    expect(existsSync(join(dir, "nested", "busforge.db"))).toBe(true);
    const res = await fetch(`http://localhost:${port}/api/projects`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  } finally {
    child.kill();
    await child.exited;
    removeTempDir(dir);
  }
});
