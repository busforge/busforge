import { test, expect, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./test-temp.ts";

// Timeouts measured (docs/testing.md, "Timeouts of heavy tests"): the orphaned owner's test takes
// 0.1 s alone; it waits on two Bun starts, which a full check stretches, so it gets the 60 s floor.
setDefaultTimeout(60_000);

const TEMP = join(import.meta.dir, "test-temp.ts");

// The owner is orphaned at once: its shell exits before it does. In the CI container, whose PID 1
// reaps nothing, the ended owner stays a zombie, which the watchdog has to count as ended.
test("the watchdog removes the root of an orphaned owner once the owner has ended", async () => {
  const dir = tempDir("busforge-temp-owner-");
  const script = join(dir, "owner.ts");
  const out = join(dir, "owner.out");
  writeFileSync(script, `import { tempDir } from ${JSON.stringify(TEMP)};\nconsole.log(tempDir("x-"));\n`);
  const sh = Bun.spawnSync(["sh", "-c", '"$0" "$1" >"$2" 2>&1 &', process.execPath, script, out]);
  expect(sh.exitCode).toBe(0);
  const until = Date.now() + 55_000;
  const printed = () => (existsSync(out) ? readFileSync(out, "utf8").trim() : "");
  while (!printed().includes("busforge-run-") && Date.now() < until) await Bun.sleep(100);
  const root = dirname(printed());
  expect(root).toContain("busforge-run-");
  while (existsSync(root) && Date.now() < until) await Bun.sleep(100);
  expect(existsSync(root)).toBe(false);
});

test("the watchdog removes no directory other than a root made for its owner", () => {
  const keep = tempDir("busforge-temp-keep-");
  for (const args of [["watch", "999999", keep], ["watch", "999999", "busforge-run-999999-x"], ["watch", "x", keep], ["remove", "999999", keep]]) {
    const r = Bun.spawnSync([process.execPath, TEMP, ...args]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("usage");
  }
  expect(existsSync(keep)).toBe(true);
});
