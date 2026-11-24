import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { RowPool, type RowAnswer, type RowRequest, type RowWorker } from "./ets-sweep-workers.ts";

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

  test("a row whose worker dies is judged again by another worker, and rejected when that one dies too", async () => {
    // Deaths played by workers without a thread (a real one that dies crashes Bun 1.3.8): each row id says what the
    // n-th worker started does with it.
    let started = 0;
    const spawn = (): RowWorker => {
      const n = ++started, w = new EventEmitter() as EventEmitter & RowWorker;
      const die = (why: string) => { w.emit("error", new Error(why)); w.emit("exit", 1); };
      Object.assign(w, { ref: () => w, unref: () => w, postMessage: ({ job, id }: RowRequest) => queueMicrotask(() => {
        if (id === "missing") die("ModuleNotFound");
        else if (id === "die" || (id === "die-once" && n === 1)) die(`worker ${n} died`);
        else if (id === "error") w.emit("message", { job, error: "the row's run threw" } satisfies RowAnswer);
        else w.emit("message", { job, judgement: { verdict: { verdict: "identical" } } } satisfies RowAnswer);
      }) });
      return w;
    };
    const rows = pool(1, { spawn });
    const judged: string[] = [];
    for (const id of ["die-once", "die", "error", "identical", "missing"]) judged.push(await outcome(rows.judge(id)));
    expect(judged).toEqual([
      '{"verdict":{"verdict":"identical"}}',
      "rejected: the workers judging die died twice; the second: worker 3 died",
      "rejected: the row's run threw",
      '{"verdict":{"verdict":"identical"}}',
      "rejected: the workers judging missing died twice; the second: ModuleNotFound",
    ]);
    // Each death took its worker out of the pool; the row on, or the next, took a new one: five deaths, five workers.
    expect(started).toBe(5);
  });

  test("an error a row throws outside its run fails the row, and its worker judges the next", () => {
    const run = Bun.spawnSync([process.execPath, "run", fileURLToPath(new URL("./fixtures/row-pool-throw.ts", import.meta.url))], { timeout: 30_000 });
    expect({ exit: run.exitCode, stderr: run.stderr.toString(), stdout: run.stdout.toString().trim().split("\n") }).toEqual({ exit: 0, stderr: "", stdout: [
      "rejected: Error: thrown outside the row's run", '{"verdict":{"verdict":"identical"}}',
    ] });
  });

  test("a worker that cannot be started or take a row fails that row, not the pool", async () => {
    let n = 0;
    const spawn = (): RowWorker => {
      if (++n === 1) throw new Error("no thread to start");
      const w = new EventEmitter() as EventEmitter & RowWorker;
      Object.assign(w, { ref: () => w, unref: () => w, postMessage: ({ job, id }: RowRequest) => {
        if (id === "uncloneable") throw new Error("the row cannot be posted");
        queueMicrotask(() => w.emit("message", { job, judgement: { verdict: { verdict: "identical" } } } satisfies RowAnswer));
      } });
      return w;
    };
    const rows = pool(1, { spawn });
    expect([await outcome(rows.judge("a")), await outcome(rows.judge("uncloneable")), await outcome(rows.judge("b"))]).toEqual([
      "rejected: no thread to start", "rejected: the row cannot be posted", '{"verdict":{"verdict":"identical"}}',
    ]);
  });

  test("a row's time is counted from when a worker takes it: one that takes longer is rejected, its worker's place held until its row ends", async () => {
    // Two rows of 200 ms on one worker, each within 300 ms of its own start, the second 400 ms after it was asked for.
    const rows = pool(1, { worker: FIXTURE, rowTimeoutMs: 300 });
    const spans = await Promise.all([rows.judge("span"), rows.judge("span")].map((p) => p.then(() => "judged", (e: Error) => (e.message.startsWith("{") ? "judged" : e.message))));
    expect(spans).toEqual(["judged", "judged"]);
    // A row of 600 ms is rejected at 300 ms; the row after it waits for the place its worker holds until 600 ms.
    const start = Date.now();
    const [slow, after] = await Promise.all([outcome(rows.judge("slow:600")), rows.judge("identical").then((v) => ({ v, at: Date.now() - start }))]);
    expect([slow, after.v]).toEqual(["rejected: slow:600 was not judged within 0.3 s of its worker taking it", { verdict: { verdict: "identical" } }]);
    expect(after.at).toBeGreaterThanOrEqual(550);
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
