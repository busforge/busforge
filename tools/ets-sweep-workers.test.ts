import { describe, expect, test } from "bun:test";
import { judgeRows } from "./ets-sweep-workers.ts";

// The rows themselves are judged through the pool by tools/ets-sweep.test.ts, with the corpus.
describe("the sweep's rows judged in worker threads", () => {
  test("a row the worker cannot read is rejected with its error, and the rows after it are still judged", async () => {
    const judged = judgeRows(["no-variant", "a/b/c"], 1);
    const error = (id: string) => judged.get(id)!.then(() => "judged", (e: Error) => e.message);
    expect(await error("no-variant")).toContain('a row is named "<application>/<variant>", not "no-variant"');
    expect(await error("a/b/c")).toContain('a row is named "<application>/<variant>", not "a/b/c"');
  });
});
