import { expect, test } from "bun:test";
import { editDistance, LINE_11, nextBatchSize, oneRowSelected, pickCatalogueRow, selectedSamples } from "./ets-driver.ts";

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
  const pick = (entries: ReturnType<typeof e>[], orderNumber: string, application: string) => {
    const r = pickCatalogueRow(entries, orderNumber, application);
    return "refused" in r ? r : { row: entries.indexOf(r.hit), rows: r.rows, exact: r.exact };
  };
  // ETS's search for TB/U1 lists both ABB brands' rows at 1.3 and 1.7 and the TB/U12.7 ones, as on the bench host; the
  // two 1.3 fingerprints are the list's (6B9E read in ETS's properties panel), the others stand in for any. Each
  // application by its fingerprint.
  const tbu1 = [e("TB/U1", "$4201", "1.3", "D98E", 731), e("TB/U1", "$4201", "1.7", "2C3A", 751), e("TB/U12.7", "$4202", "1.3", "11AF", 771),
    e("TB/U1", "$4201", "1.3", "6B9E", 873), e("TB/U1", "$4201", "1.7", "88D1", 893)];
  expect(pick(tbu1, "TB/U1", "M-0002_A-4201-13-6B9E-O0007")).toEqual({ row: 3, rows: 1, exact: true });
  expect(pick(tbu1, "TB/U1", "M-0007_A-4201-13-D98E")).toEqual({ row: 0, rows: 1, exact: true });
  // Fingerprints OCR misread (as the runner's acceptance batch read them): the one row at the type and version, and
  // one application in two catalogue items read alike, are taken, not exact (the insert is checked on the export).
  expect(pick([e("4093KRMTSD", "$1471", "1.2", "1634", 700)], "4093KRMTSD", "M-0004_A-1471-12-163A-O00F4")).toEqual({ row: 0, rows: 1, exact: false });
  expect(pick([e("75314019", "$20B3", "1.1", "DCc3s0", 700), e("75314019", "$20B3", "1.1", "DCc3s0", 720)], "75314019", "M-0006_A-20B3-11-DC90-O000A")).toEqual({ row: 0, rows: 2, exact: false });
  // Two applications at one type and version, one fingerprint misread: the closer reading; two readings as close
  // are refused.
  expect(pick([e("TB/U1", "$4201", "1.3", "D9BE", 731), e("TB/U1", "$4201", "1.3", "6B93E", 873)], "TB/U1", "M-0002_A-4201-13-6B9E-O0007")).toEqual({ row: 1, rows: 1, exact: false });
  expect(pick([e("X", "$4201", "1.3", "6B0E", 731), e("X", "$4201", "1.3", "6B9F", 873)], "X", "M-0002_A-4201-13-6B9E-O0007")).toEqual({ refused: "2 catalogue rows with order number X at $4201 1.3 read no fingerprint closest to 6B9E alone (read: X $4201 1.3 6B0E; X $4201 1.3 6B9F)" });
  // Order numbers that differ only where OCR confuses letters pass alike; the application tells them apart, and OCR's
  // "S" for the device type's "$" and O for 0 are read as meant.
  const folded = [e("GH Q631 0070 RO111", "S0A01", "1.3", "1111", 700), e("GH Q631 0070 R0111", "$A001", "1.3", "63C2", 720)];
  expect(pick(folded, "GH Q631 0070 R0111", "M-0002_A-A001-13-63C2")).toEqual({ row: 1, rows: 1, exact: true });
  // A version or device type that differs is never taken.
  expect("refused" in pickCatalogueRow([e("X1", "$A0B1", "1.2", "1234", 700), e("X1", "$A0B2", "1.1", "1234", 720)], "X1", "M-00FA_A-A0B1-11-1234")).toBe(true);
  expect(editDistance("DC390", "DC90")).toBe(1);
  expect(editDistance("", "6B9E")).toBe(4);
});

test("line 1.1's row of the topology tree, as OCR reads the tree's rows", () => {
  // Recorded on the bench host: line 1.1 plain, selected ("111P Line"), and the rows around it.
  for (const line of ["v EE 11 TP Linie", "v EB 11TP Linie", "v ES 111P Line"]) expect(LINE_11.test(line)).toBe(true);
  for (const other of ["TIT 0.0 IP Backbone-Linie", "v [&] 1.0 IP Hauptiinie", "Y [J LO IP Hauptiinie", "BS © Keiner Linie zugewiesen", "BS 1 Programmieren notwendig",
    "J 1.1.1 6108/06-BS-500 Tasterankopplung 2-fa", "{J 1.1.1TB/U1 Tacteo Bedienelement 1-fach"]) expect(LINE_11.test(other)).toBe(false);
  // A device whose name ends as a line's does: its address says it is a device.
  expect(LINE_11.test("{J 1.1.20 KNX Line")).toBe(false);
});
