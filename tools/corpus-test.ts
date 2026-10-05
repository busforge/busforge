// Test registration for tests that read the private corpus (tools/corpus.ts). With the corpus
// present they are ordinary tests. Without it they are registered as skipped under a name that
// says why, and each one is announced on stdout, because `bun test` counts skips but names them
// only on a terminal. tools/corpus-status.ts finds the files that use these by their names.
import { describe, test } from "bun:test";
import { corpusRoot } from "./corpus.ts";

export const NEEDS_CORPUS = "[needs private corpus]";

const announce = (name: string) => console.log(`${NEEDS_CORPUS} not run: ${name}`);

// A test that reads the corpus in its body.
export function corpusTest(name: string, fn: () => void | Promise<unknown>, timeout?: number): void {
  if (corpusRoot() !== null) { test(name, fn, timeout); return; }
  announce(name);
  test.skip(`${NEEDS_CORPUS} ${name}`, fn);
}

// A suite that reads the corpus while it is being collected. Without the corpus its body is not
// run at all; it stands as one skipped test.
export function corpusDescribe(name: string, fn: () => void): void {
  if (corpusRoot() !== null) { describe(name, fn); return; }
  announce(`${name} (whole suite)`);
  test.skip(`${NEEDS_CORPUS} ${name} (whole suite)`, () => {});
}
