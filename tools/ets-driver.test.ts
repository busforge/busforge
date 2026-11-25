import { expect, test } from "bun:test";
import { nextBatchSize } from "./ets-driver.ts";

test("a catalogue batch halves after a refusal and grows from the last size that loaded", () => {
  const walk = (outcomes: ("loaded" | "refused" | "skipped")[], max = 150) => {
    let size = max;
    return outcomes.map((o) => (size = nextBatchSize(size, o, max)));
  };
  // Refused down to 19 rows, which load: the next batches grow from 19, not from 150.
  expect(walk(["refused", "refused", "refused", "loaded", "loaded", "loaded"])).toEqual([75, 38, 19, 24, 30, 38]);
  // A row refused alone stays one row until one loads, then grows by at least a row.
  expect(walk(["refused", "refused", "refused", "refused", "refused", "refused", "refused", "refused", "refused", "loaded", "loaded"])).toEqual([75, 38, 19, 10, 5, 3, 2, 1, 1, 2, 3]);
  // Batches of loaded rows keep the size; growth stops at the maximum.
  expect(walk(["refused", "skipped", "loaded", "loaded", "loaded", "loaded"])).toEqual([75, 75, 94, 118, 148, 150]);
});
