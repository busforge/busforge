import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RowPool } from "./ets-sweep-workers.ts";
import { tempDir } from "./test-temp.ts";

const FIXTURE = new URL("./fixtures/row-pool-worker.ts", import.meta.url);
const outcome = (p: Promise<unknown>) => p.then((v) => JSON.stringify(v), (e: Error) => `rejected: ${e.message}`);

// The rows themselves are judged through the pool by tools/ets-sweep.test.ts, with the corpus.
describe("the sweep's rows judged in worker threads", () => {
  test("a row the worker cannot read is rejected with its error, and the row after it is still judged", async () => {
    const pool = new RowPool(1);
    expect(await outcome(pool.judge("no-variant"))).toContain('rejected: Error: a row is named "<application>/<variant>", not "no-variant"');
    expect(await outcome(pool.judge("a/b/c"))).toContain('not "a/b/c"');
  });

  test("rows run side by side up to the pool's size, the same row twice as two jobs", async () => {
    const pool = new RowPool(2, FIXTURE);
    await pool.judge("identical");
    const t = Date.now();
    expect(await Promise.all([pool.judge("slow"), pool.judge("slow"), pool.judge("slow")].map(outcome))).toEqual(Array(3).fill('{"verdict":"identical"}'));
    // Two at once, then the third: two rounds of 300 ms, not one and not three.
    expect(Date.now() - t).toBeGreaterThanOrEqual(600);
    expect(Date.now() - t).toBeLessThan(900);
  });

  test("a row whose worker dies is judged again by a new worker, and rejected when that one dies too", () => {
    const run = Bun.spawnSync(["bun", "run", new URL("./fixtures/row-pool-deaths.ts", import.meta.url).pathname, join(tempDir("row-pool-"), "died")]);
    expect({ exit: run.exitCode, stdout: run.stdout.toString().trim().split("\n") }).toEqual({ exit: 0, stdout: [
      '{"verdict":"identical"}',
      "rejected: the workers judging die died twice; the second: the worker died",
      "rejected: the row's run threw",
      '{"verdict":"identical"}',
    ] });
  });

  test("a pool without workers is refused", () => {
    expect(() => new RowPool(0)).toThrow("a pool of 0 workers judges no row");
    expect(() => new RowPool(Number.NaN)).toThrow("a pool of NaN workers judges no row");
  });
});
