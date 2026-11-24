import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RowPool } from "./ets-sweep-workers.ts";
import { tempDir } from "./test-temp.ts";

const FIXTURE = new URL("./fixtures/row-pool-worker.ts", import.meta.url);
const outcome = (p: Promise<unknown>) => p.then((v) => JSON.stringify(v), (e: Error) => `rejected: ${e.message}`);

// The rows themselves are judged through the pool by tools/ets-sweep.test.ts, with the corpus.
describe("the sweep's rows judged in worker threads", () => {
  const pools: RowPool[] = [];
  const pool = (...args: ConstructorParameters<typeof RowPool>) => { const p = new RowPool(...args); pools.push(p); return p; };
  afterAll(() => { for (const p of pools) p.close(); });

  test("a row the worker cannot read is rejected with its error, and the row after it is still judged", async () => {
    const rows = pool(1);
    expect(await outcome(rows.judge("no-variant"))).toContain('rejected: Error: a row is named "<application>/<variant>", not "no-variant"');
    expect(await outcome(rows.judge("a/b/c"))).toContain('not "a/b/c"');
  });

  test("rows run side by side up to the pool's size, the same row twice as two jobs", async () => {
    const rows = pool(2, { worker: FIXTURE });
    const span = (p: Promise<unknown>) => p.then(() => { throw new Error("judged"); }, (e: Error) => JSON.parse(e.message) as { start: number; end: number });
    const [a, b, c] = await Promise.all([rows.judge("span"), rows.judge("span"), rows.judge("span")].map(span));
    // The first two at once, the third only once one of them ended.
    expect(a.start < b.end && b.start < a.end).toBe(true);
    expect(c.start).toBeGreaterThanOrEqual(Math.min(a.end, b.end));
  });

  test("a row whose worker dies is judged again by another worker, and rejected when that one dies too", () => {
    const run = Bun.spawnSync([process.execPath, "run", fileURLToPath(new URL("./fixtures/row-pool-deaths.ts", import.meta.url)), join(tempDir("row-pool-"), "died")], { timeout: 30_000 });
    expect({ exit: run.exitCode, stderr: run.stderr.toString(), stdout: run.stdout.toString().trim().split("\n") }).toEqual({ exit: 0, stderr: "", stdout: [
      '{"verdict":{"verdict":"identical"}}',
      "rejected: the workers judging die died twice; the second: the worker died",
      "rejected: the row's run threw",
      '{"verdict":{"verdict":"identical"}}',
      "rejected: the workers judging identical died twice; the second: …",
    ] });
  });

  test("a row's time is counted from when a worker takes it: one that takes longer is rejected, its worker retired", async () => {
    const rows = pool(1, { worker: FIXTURE, rowTimeoutMs: 300 });
    // The second waits for the first's worker, longer than its own limit, and is judged all the same.
    const [hung, after] = await Promise.all([outcome(rows.judge("hang")), outcome(rows.judge("identical"))]);
    expect([hung, after]).toEqual(["rejected: hang was not judged within 0.3 s of its worker taking it", '{"verdict":{"verdict":"identical"}}']);
  });

  test("closed, it retires its workers, rejects the rows not judged and judges none after", async () => {
    const rows = new RowPool(1, { worker: FIXTURE });
    const [running, waiting] = [outcome(rows.judge("hang")), outcome(rows.judge("identical"))];
    rows.close();
    expect([await running, await waiting, await outcome(rows.judge("identical"))]).toEqual([
      "rejected: the pool was closed: hang is not judged", "rejected: the pool was closed: identical is not judged", "rejected: the pool is closed: identical is not judged",
    ]);
  });

  test("a pool without workers is refused", () => {
    expect(() => new RowPool(0)).toThrow("a pool of 0 workers judges no row");
    expect(() => new RowPool(Number.NaN)).toThrow("a pool of NaN workers judges no row");
  });
});
