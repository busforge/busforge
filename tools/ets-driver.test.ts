import { expect, test } from "bun:test";
import { nextBatchSize, oneRowSelected, pickCatalogueRow, selectedSamples } from "./ets-driver.ts";

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

test("one row selected: one run of selected samples, a row high at most", () => {
  expect(oneRowSelected("0000111100000")).toBe(true);
  expect(oneRowSelected("0000111110000")).toBe(true);
  // Two rows, or two runs, or nothing.
  expect(oneRowSelected("00001111111100")).toBe(false);
  expect(oneRowSelected("0011000011000")).toBe(false);
  expect(oneRowSelected("0000000000000")).toBe(false);
  // A run at the grid's edge may be the visible end of a longer selection.
  expect(oneRowSelected("1111000000000")).toBe(false);
  expect(oneRowSelected("0000000001111")).toBe(false);
});

test("the catalogue row inserted: the one whose read application is the row's, whatever else the search lists", () => {
  const e = (orderNumber: string, deviceType: string, version: string, fingerprint: string, y: number) => ({ orderNumber, deviceType, version, fingerprint, y });
  // ETS's search for TB/U1 lists both ABB brands' rows at 1.3 and 1.7 and the TB/U12.7 ones, as on the bench host; the
  // two 1.3 fingerprints are the list's (6B9E read in ETS's properties panel), the others stand in for any. The
  // STOTZ-KONTAKT application by its fingerprint, the one ETS's product store holds.
  const tbu1 = [e("TB/U1", "$4201", "1.3", "D98E", 731), e("TB/U1", "$4201", "1.7", "2C3A", 751), e("TB/U12.7", "$4202", "1.3", "11AF", 771),
    e("TB/U1", "$4201", "1.3", "6B9E", 873), e("TB/U1", "$4201", "1.7", "88D1", 893)];
  expect(pickCatalogueRow(tbu1, "TB/U1", "M-0002_A-4201-13-6B9E-O0007", false)).toEqual({ hit: tbu1[3], rows: 1 });
  expect(pickCatalogueRow(tbu1, "TB/U1", "M-0007_A-4201-13-D98E", false)).toEqual({ hit: tbu1[0], rows: 1 });
  // Order numbers that differ only where OCR confuses letters pass alike; the application tells them apart, and OCR's
  // "S" for the device type's "$" and O for 0 are read as meant.
  const folded = [e("GH Q631 0070 RO111", "S0A01", "1.3", "1111", 700), e("GH Q631 0070 R0111", "$A001", "1.3", "63C2", 720)];
  expect(pickCatalogueRow(folded, "GH Q631 0070 R0111", "M-0002_A-A001-13-63C2", false)).toEqual({ hit: folded[1], rows: 1 });
  // One application in two catalogue items: the first row, both counted.
  const twice = [e("4093KRMTSD", "$1471", "1.2", "163A", 700), e("4093KRMTSD", "$1471", "1.2", "163A", 720)];
  expect(pickCatalogueRow(twice, "4093KRMTSD", "M-0004_A-1471-12-163A-O00F4", false)).toEqual({ hit: twice[0], rows: 2 });
  // Another build (an own unit's OpenKNX release): the one row at its type and version, only where asked.
  const build = [e("OpenKnxRaumController", "$A0B1", "1.1", "9999", 700)];
  expect(pickCatalogueRow(build, "OpenKnxRaumController", "M-00FA_A-A0B1-11-1234", true)).toEqual({ hit: build[0], rows: 1 });
  expect(pickCatalogueRow(build, "OpenKnxRaumController", "M-00FA_A-A0B1-11-1234", false)).toEqual({ refused: "no catalogue row with order number OpenKnxRaumController runs M-00FA_A-A0B1-11-1234 (read: OpenKnxRaumController $A0B1 1.1 9999)" });
  // A version or device type that differs is never taken as another build.
  expect("refused" in pickCatalogueRow([e("X1", "$A0B1", "1.2", "1234", 700)], "X1", "M-00FA_A-A0B1-11-1234", true)).toBe(true);
});
