import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { nextBatchSize, selectionPattern } from "./ets-driver.ts";
import { tempDir } from "./test-temp.ts";

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

test("the grid's selection read from its rows' background: ETS's blue selected, white, stripe grey and hover grey not", () => {
  const dir = tempDir("ets-driver-selection");
  const png = (name: string, rects: [string, number, number][]) => {
    const file = join(dir, name);
    // ETS 6.4.1's colours: selection #DBEAFF, stripe #FBFBFB, row under the mouse #EAEAEA.
    execFileSync("magick", ["-size", "1920x1200", "xc:white", ...rects.flatMap(([c, y0, y1]) => ["-fill", c, "-draw", `rectangle 316,${y0} 1555,${y1}`]), file]);
    return file;
  };
  const region = { x: 900, y: 698, w: 600, h: 100 };
  const three = png("three.png", [["#FBFBFB", 698, 717], ["#DBEAFF", 718, 777]]);
  expect(selectionPattern(three, region)).toBe("00001111111111110000");
  // The same rows with the mouse over the first: that part reads unselected, so the mouse is moved aside first.
  expect(selectionPattern(png("hover.png", [["#EAEAEA", 718, 737], ["#DBEAFF", 738, 777]]), region)).toBe("00000000111111110000");
  // The selection one row down is another pattern.
  expect(selectionPattern(png("down.png", [["#DBEAFF", 738, 797]]), region)).not.toBe(selectionPattern(three, region));
});
