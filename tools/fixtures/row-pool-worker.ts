// A worker for tools/ets-sweep-workers.test.ts that speaks the pool's protocol without judging a row: "identical"
// answers at once, "slow" after 300 ms, "error" with an error, "die" dies of an uncaught error; "die-once:<file>"
// dies the first time (leaving <file>) and answers the second.
import { existsSync, writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import type { RowAnswer, RowRequest } from "../ets-sweep-workers.ts";

parentPort!.on("message", ({ job, id }: RowRequest) => {
  const answer = (a: RowAnswer) => parentPort!.postMessage(a);
  if (id === "identical") answer({ job, verdict: { verdict: "identical" } });
  else if (id === "slow") setTimeout(() => answer({ job, verdict: { verdict: "identical" } }), 300);
  else if (id === "error") answer({ job, error: "the row's run threw" });
  else if (id === "die") setTimeout(() => { throw new Error("the worker died"); });
  else if (id.startsWith("die-once:")) {
    const marker = id.slice("die-once:".length);
    if (!existsSync(marker)) { writeFileSync(marker, ""); setTimeout(() => { throw new Error("the worker died"); }); return; }
    answer({ job, verdict: { verdict: "identical" } });
  }
});
