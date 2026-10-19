import { test, expect } from "bun:test";
import { previewRuns, previewEffect, previewEach, type IsLive } from "./previewRun.ts";

// A fake bus: each dry-run request waits until the test answers it.
function bus() {
  const sent: { target: string; answer: (r: string) => void }[] = [];
  const settled: string[] = [];
  const dry = (target: string) => new Promise<string>((answer) => { sent.push({ target, answer }); });
  const body = (targets: string[]) => (live: IsLive) =>
    previewEach(targets, dry, (t, r) => { settled.push("ok" in r ? `${t}:${r.ok}` : `${t}:error`); }, live);
  return { sent, settled, body };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("StrictMode's second setup on mount takes over the preview instead of sending it again", async () => {
  const b = bus(); const runs = previewRuns();
  const body = b.body(["params", "ga"]);
  const cleanup = previewEffect(runs, true, "k", body);
  cleanup?.();
  previewEffect(runs, true, "k", body);
  await tick();
  expect(b.sent.map((s) => s.target)).toEqual(["params"]);
  b.sent[0]!.answer("p1"); await tick();
  expect(b.sent.map((s) => s.target)).toEqual(["params", "ga"]);
  b.sent[1]!.answer("g1"); await tick();
  expect(b.settled).toEqual(["params:p1", "ga:g1"]);
});

test("a re-render with unchanged dependencies runs no second preview, also after the first finished", async () => {
  const b = bus(); const runs = previewRuns();
  const body = b.body(["params"]);
  previewEffect(runs, true, "k", body)?.();
  previewEffect(runs, true, "k", body);
  b.sent[0]!.answer("p1"); await tick();
  previewEffect(runs, true, "k", body);
  await tick();
  expect(b.sent).toHaveLength(1);
  expect(b.settled).toEqual(["params:p1"]);
});

test("closing the dialog mid-preview sends no further request and drops the late answer", async () => {
  const b = bus(); const runs = previewRuns();
  const cleanup = previewEffect(runs, true, "k", b.body(["params", "ga"]));
  cleanup?.(); // unmount: no setup follows
  b.sent[0]!.answer("p1"); await tick();
  expect(b.sent).toHaveLength(1);
  expect(b.settled).toEqual([]);
});

test("a changed key stops the stale preview and starts a fresh one whose answers alone land", async () => {
  const b = bus(); const runs = previewRuns();
  const cleanup = previewEffect(runs, true, "dev-a", b.body(["params"]));
  cleanup?.();
  previewEffect(runs, true, "dev-b", b.body(["ga"]));
  b.sent[0]!.answer("stale"); b.sent[1]!.answer("fresh"); await tick();
  expect(b.sent.map((s) => s.target)).toEqual(["params", "ga"]);
  expect(b.settled).toEqual(["ga:fresh"]);
});

test("a preview that was no longer wanted (a foreign write) runs fresh once it is wanted again", async () => {
  const b = bus(); const runs = previewRuns();
  const body = b.body(["params"]);
  const cleanup = previewEffect(runs, true, "k", body);
  b.sent[0]!.answer("before"); await tick();
  cleanup?.();
  previewEffect(runs, false, "k", body)?.();
  previewEffect(runs, true, "k", body);
  b.sent[1]!.answer("after"); await tick();
  expect(b.settled).toEqual(["params:before", "params:after"]);
});

test("a retry replaces the running preview, and the effect's cleanup stops the retry", async () => {
  const b = bus(); const runs = previewRuns();
  const body = b.body(["params", "ga"]);
  const cleanup = previewEffect(runs, true, "k", body);
  runs.start("k", body);
  b.sent[0]!.answer("old"); b.sent[1]!.answer("retried"); await tick();
  expect(b.settled).toEqual(["params:retried"]);
  cleanup?.();
  b.sent[2]!.answer("late"); await tick();
  expect(b.sent).toHaveLength(3);
  expect(b.settled).toEqual(["params:retried"]);
});

test("a failed target settles as its own error and the preview goes on", async () => {
  const runs = previewRuns(); const settled: string[] = [];
  const dry = (t: string) => (t === "params" ? Promise.reject(new Error("timeout")) : Promise.resolve("g"));
  previewEffect(runs, true, "k", (live) => previewEach(["params", "ga"], dry, (t, r) => { settled.push("ok" in r ? `${t}:${r.ok}` : `${t}:error`); }, live));
  await tick(); await tick();
  expect(settled).toEqual(["params:error", "ga:g"]);
});

test("pause() on unmount stops a retry the effect did not start", async () => {
  const b = bus(); const runs = previewRuns();
  const body = b.body(["params", "ga"]);
  previewEffect(runs, false, "k", body); // not wanted (a result on screen): no effect run
  runs.start("k", body); // retry
  runs.pause(); // unmount
  b.sent[0]!.answer("late"); await tick();
  expect(b.sent).toHaveLength(1);
  expect(b.settled).toEqual([]);
});

test("under StrictMode each target is previewed once, also when the dialog renders again after a write", async () => {
  // A second copy of a target's preview would queue on the serial bus behind a write taken meanwhile,
  // and reach a device the write left unloaded.
  const b = bus(); const runs = previewRuns();
  const body = b.body(["params", "ga"]);
  previewEffect(runs, true, "k", body)?.();
  const cleanup = previewEffect(runs, true, "k", body);
  b.sent[0]!.answer("p1"); await tick();
  b.sent[1]!.answer("g1"); await tick();
  cleanup?.();
  previewEffect(runs, true, "k", body);
  await tick();
  expect(b.sent.map((s) => s.target)).toEqual(["params", "ga"]);
  expect(b.settled).toEqual(["params:p1", "ga:g1"]);
});
