import { test, expect, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDataDir } from "../src/app.ts";

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

test("the server entry point opens its database in BUSFORGE_DATA_DIR on the port PORT names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "busforge-data-dir-"));
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
    rmSync(dir, { recursive: true, force: true });
  }
});
