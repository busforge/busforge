import { expect, test } from "bun:test";
import { nextBatchSize, selectedSamples } from "./ets-driver.ts";

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

test("the grid's selection read from magick's samples of its rows' background", () => {
  // magick's txt: output of ETS 6.4.1's colours: white, stripe grey #FBFBFB, row under the mouse #EAEAEA, selected #DBEAFF.
  const txt = (pixels: string[]) => ["# ImageMagick pixel enumeration: 1,4,0,255,srgb", ...pixels.map((p, y) => `0,${y}: ${p}`), ""].join("\n");
  const white = "(255,255,255)  #FFFFFF  white", stripe = "(251,251,251)  #FBFBFB  srgb(251,251,251)";
  const hover = "(234,234,234)  #EAEAEA  srgb(234,234,234)", selected = "(219,234,255)  #DBEAFF  srgb(219,234,255)";
  expect(selectedSamples(txt([white, selected, selected, stripe]))).toBe("0110");
  // The row under the mouse reads unselected, so the mouse is moved aside before the grid is read.
  expect(selectedSamples(txt([white, hover, selected, stripe]))).toBe("0010");
  expect(() => selectedSamples(txt(["(255)  #FFFFFF  gray(255)"]))).toThrow("no pixel in magick's line");
});
