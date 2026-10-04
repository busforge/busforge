import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../src/app.ts";

// Real processes and real signals: the point is that a signal cannot end a write, which an
// in-process test of the queue alone cannot show.
const FIXTURE = join(import.meta.dir, "fixtures", "shutdown-server.ts");
const JOB_MS = 1500;

async function start(jobMs: number, env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "busforge-shutdown-"));
  const proc = Bun.spawn(["bun", FIXTURE], { env: { ...process.env, ...env, DATA_DIR: dataDir, JOB_MS: String(jobMs) }, stdout: "pipe", stderr: "pipe" });
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

// After an exit through the signal handler busforge.db alone must hold every committed write: the
// write-ahead log is gone or empty, and a copy of the database file without its -wal and -shm
// shows the task states.
function expectCheckpointed(dataDir: string, states: Record<string, string>) {
  const wal = join(dataDir, "busforge.db-wal");
  if (existsSync(wal)) expect(statSync(wal).size).toBe(0);
  const lone = join(mkdtempSync(join(tmpdir(), "busforge-lone-db-")), "busforge.db");
  copyFileSync(join(dataDir, "busforge.db"), lone);
  const db = new Database(lone);
  const rows = db.query("SELECT id, state FROM tasks").all() as { id: string; state: string }[];
  db.close();
  expect(Object.fromEntries(rows.map((r) => [r.id, r.state]))).toEqual(states);
}

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
    expectCheckpointed(dataDir, { [running]: "done", [queued]: "cancelled" });

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

  test("a failed shutdown step still checkpoints the database before exiting non-zero", async () => {
    const { proc, dataDir, running, queued } = await start(JOB_MS, { FAIL_BUS_CLOSE: "1" });
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("shutdown cleanup failed");
    expectCheckpointed(dataDir, { [running]: "done", [queued]: "cancelled" });
  }, 15_000);

  test("a checkpoint another connection blocks is reported and exits non-zero", async () => {
    const { proc } = await start(JOB_MS, { HOLD_READER: "1" });
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(1);
    const log = await new Response(proc.stderr).text();
    expect(log).toContain("closing the database failed the database checkpoint did not complete (busy 1,");
  }, 15_000);
});
