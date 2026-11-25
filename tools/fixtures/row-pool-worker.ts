// A worker for tools/ets-sweep-workers.test.ts that serves the pool's rows as the sweep's worker does (serveRows)
// without judging one: "identical" at once, "span" after 200 ms with when it ran (as the error text), "slow:<ms>" after
// <ms> ms, "hang" never, "throw" with an error thrown outside the row's promise (a timer's). It
// never dies: a worker thread that ends crashes Bun 1.3.8 (tools/ets-sweep-workers.ts), so the test plays deaths with
// workers of its own.
import { serveRows, type RowJudgement } from "../ets-sweep-workers.ts";

const IDENTICAL: RowJudgement = { verdict: { verdict: "identical" } };
const after = (ms: number) => new Promise((r) => setTimeout(r, ms));

serveRows(async ({ id }) => {
  if (id === "identical") return IDENTICAL;
  // The pool posts an error's stack: here the span alone.
  if (id === "span") { const start = Date.now(); await after(200); const span = JSON.stringify({ start, end: Date.now() }); throw Object.assign(new Error(span), { stack: span }); }
  if (id.startsWith("slow:")) { await after(Number(id.slice(5))); return IDENTICAL; }
  if (id === "throw") setTimeout(() => { throw new Error("thrown outside the row's run"); });
  return new Promise<never>(() => {});
});
