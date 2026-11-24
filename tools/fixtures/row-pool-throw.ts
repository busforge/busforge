// The pool's answers to a row that throws outside its run's promise and to the row after it on the same worker, one per
// line, for tools/ets-sweep-workers.test.ts, which runs this in a process of its own: under `bun test` a worker's
// process.on("uncaughtException") is not called, and the worker dies of the error instead.
//
//   bun run tools/fixtures/row-pool-throw.ts
import { RowPool } from "../ets-sweep-workers.ts";

const pool = new RowPool(1, { worker: new URL("./row-pool-worker.ts", import.meta.url) });
const outcome = (p: Promise<unknown>) => p.then((v) => JSON.stringify(v), (e: Error) => `rejected: ${e.message.split("\n")[0]}`);
const lines = [await outcome(pool.judge("throw")), await outcome(pool.judge("identical"))];
process.stdout.write(lines.join("\n") + "\n", () => process.exit(0));
