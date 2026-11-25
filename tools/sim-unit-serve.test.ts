import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusTest } from "./corpus-test.ts";

// The ETS driver stops the simulator it started on the bench host by its PID with SIGTERM (tools/ets-driver.ts); the
// simulator then ends as on Ctrl-C, its refusals printed.
corpusTest("the simulator ends on SIGTERM and prints its refusals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-unit-serve-"));
  try {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "sim-unit-serve.ts"), "meanwell-knx40e", "--tool", "ETS", "--log", join(dir, "ets.log"), "--port", String(port), "--proxy-port", String(port + 1)], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes(`connects to :${port + 1}`)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the simulator ended before it served: ${out}${await new Response(child.stderr).text()}`);
      out += new TextDecoder().decode(value);
    }
    child.kill("SIGTERM");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(await child.exited).toBe(0);
    expect(out).toContain("no refusals");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
