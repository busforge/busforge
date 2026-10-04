import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../src/app.ts";
import { closeDb } from "../src/db/schema.ts";

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
    const { proc, dataDir, startedAt } = await start(0);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(await new Response(proc.stderr).text()).toContain("received SIGTERM, exiting");
    expectCheckpointed(dataDir, {});
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
    expect(log).toContain("closing the database failed the database checkpoint did not complete (");
  }, 15_000);

  test("a reader that lets go within the busy timeout does not fail the checkpoint", async () => {
    // The reader lives in this process: the checkpoint's busy wait blocks the server's own thread.
    const { proc, dataDir } = await start(0);
    const reader = new Database(join(dataDir, "busforge.db"));
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM tasks").get();
    const signalledAt = Date.now();
    proc.kill("SIGTERM");
    await Bun.sleep(1000);
    reader.exec("COMMIT");
    reader.close();
    expect(await proc.exited).toBe(0);
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(900); // the checkpoint waited for the reader
    expectCheckpointed(dataDir, {});
  }, 15_000);

  test("a reader whose snapshot holds every write keeps the log from being emptied, and says only that", async () => {
    const { proc } = await start(0, { HOLD_READER: "1" });
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("closing the database failed the database checkpoint copied every log frame but could not empty the log");
  }, 15_000);
});

describe("closeDb", () => {
  const withResult = (r: { busy: number; log: number; checkpointed: number }) => {
    let closed = false;
    const db = { exec: () => {}, query: () => ({ get: () => r }), close: () => { closed = true; } } as unknown as Database;
    return { db, closed: () => closed };
  };

  test("refuses to claim anything when the checkpoint could not start", () => {
    const { db, closed } = withResult({ busy: 1, log: -1, checkpointed: -1 });
    expect(() => closeDb(db)).toThrow("the database checkpoint could not start: busforge.db alone may not hold every committed write");
    expect(closed()).toBe(false);
  });

  test("closes after a complete checkpoint", () => {
    const { db, closed } = withResult({ busy: 0, log: 0, checkpointed: 0 });
    closeDb(db);
    expect(closed()).toBe(true);
  });
});
