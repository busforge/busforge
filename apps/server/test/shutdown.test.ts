import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../src/app.ts";

// Real processes and real signals: the point is that a signal cannot end a write, which an
// in-process test of the queue alone cannot show.
const FIXTURE = join(import.meta.dir, "fixtures", "shutdown-server.ts");
const JOB_MS = 1500;

async function start(jobMs: number) {
  const dataDir = mkdtempSync(join(tmpdir(), "busforge-shutdown-"));
  const proc = Bun.spawn(["bun", FIXTURE], { env: { ...process.env, DATA_DIR: dataDir, JOB_MS: String(jobMs) }, stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`fixture ended before it was ready: ${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  const [, running, queued] = out.trim().split(" ");
  return { proc, dataDir, running, queued, startedAt: Date.now() };
}

const alive = (proc: Bun.Subprocess) => proc.exitCode === null && proc.signalCode === null;

describe("shutdown on a signal", () => {
  for (const sig of ["SIGTERM", "SIGINT"] as const) test(`${sig} lets the running write finish and commit, cancels queued work, then exits cleanly`, async () => {
    const { proc, dataDir, running, queued, startedAt } = await start(JOB_MS);
    proc.kill(sig);
    await Bun.sleep(200);
    expect(alive(proc)).toBe(true);
    proc.kill(sig); // a repeated signal does not skip the wait
    await Bun.sleep(200);
    expect(alive(proc)).toBe(true);

    expect(await proc.exited).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(JOB_MS - 100);
    const log = await new Response(proc.stderr).text();
    expect(log).toContain(`received ${sig}, finishing download of 1.1.1 (d1, task ${running})`);
    expect(log).toContain(`received ${sig} again, still finishing`);

    const state = createState({ dataDir });
    expect(state.queue.get(running)).toMatchObject({ state: "done", baselineCommitted: true, outcome: { kind: "flashed", verified: true } });
    expect(state.queue.get(queued)).toMatchObject({ state: "cancelled", errorCode: "TASK_NOT_STARTED" });
    state.db.close();
  }, 15_000);

  test("SIGKILL mid-write leaves the write reported as interrupted on the next start", async () => {
    const { proc, dataDir, running, queued } = await start(60_000);
    proc.kill("SIGKILL");
    await proc.exited;
    const state = createState({ dataDir });
    expect(state.queue.get(running)).toMatchObject({ state: "interrupted", errorCode: "TASK_WRITE_INTERRUPTED", baselineCommitted: false });
    expect(state.queue.get(queued)).toMatchObject({ state: "cancelled", errorCode: "TASK_NOT_STARTED" });
    state.db.close();
  }, 15_000);

  test("SIGTERM with no write running exits at once", async () => {
    const { proc, startedAt } = await start(0);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(await new Response(proc.stderr).text()).toContain("received SIGTERM, exiting");
  }, 15_000);
});
