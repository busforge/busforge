// The pool's answers to rows whose worker dies (tools/fixtures/row-pool-worker.ts) or does not load, one per line, for
// tools/ets-sweep-workers.test.ts, which runs this in a process of its own: a worker that dies of an uncaught error
// can crash Bun (1.3) when other test files share the process.
//
//   bun run tools/fixtures/row-pool-deaths.ts <marker file>
import { RowPool } from "../ets-sweep-workers.ts";

const outcome = (p: Promise<unknown>) => p.then((v) => JSON.stringify(v), (e: Error) => `rejected: ${e.message}`);
const pool = new RowPool(1, { worker: new URL("./row-pool-worker.ts", import.meta.url) });
for (const id of [`die-once:${process.argv[2]}`, "die", "error", "identical"]) console.log(await outcome(pool.judge(id)));
pool.close();
// A worker module that does not load: each of its two workers dies of it.
const missing = new RowPool(1, { worker: new URL("./no-such-worker.ts", import.meta.url) });
console.log((await outcome(missing.judge("identical"))).replace(/; the second: .*/s, "; the second: …"));
missing.close();
