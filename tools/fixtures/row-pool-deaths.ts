// The pool's answers to rows whose worker dies (tools/fixtures/row-pool-worker.ts), one per line, for
// tools/ets-sweep-workers.test.ts, which runs this in a process of its own: a worker that dies of an uncaught error
// can crash Bun (1.3) when other test files share the process.
//
//   bun run tools/fixtures/row-pool-deaths.ts <marker file>
import { RowPool } from "../ets-sweep-workers.ts";

const pool = new RowPool(1, new URL("./row-pool-worker.ts", import.meta.url));
const outcome = (p: Promise<unknown>) => p.then((v) => JSON.stringify(v), (e: Error) => `rejected: ${e.message}`);
for (const id of [`die-once:${process.argv[2]}`, "die", "error", "identical"]) console.log(await outcome(pool.judge(id)));
