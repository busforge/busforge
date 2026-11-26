// The ETS driver's screen readers (tools/ets-driver.ts) on full-resolution screenshots of ETS 6.4.1 that real
// driver runs on the bench host left (the private corpus, DRIVER_SCREENS in tools/corpus.ts; README.md beside them
// says what each shows). Each reader is fed the screenshot whole, as the driver feeds it its screen, and must read
// what the screen shows. They run tesseract and ImageMagick, as the driver does.
import { expect } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { corpusPath, driverScreenFile, type DriverScreen } from "./corpus.ts";
import { corpusTest } from "./corpus-test.ts";
import {
  catalogueDownloadDialog, catalogueGroups, catalogueHeader, cataloguePanelShown, catalogueProducts, catalogueSearchEmpty, compatibilityRefusalWhy, compatibilityWarning, dialogBox, dialogButton, dialogText, downloadEnabled, frontTabWidth, LINE_11,
  isCatalogueProgress, keepCompatibilityDialog, keepScreen, moveScreen, oneRowSelected, pickCatalogueRow, projectTabs, projectTabShown, propertiesTab, propertiesTable, propertyValue, SCREEN_FORMAT, searchGrid, selectionPattern, sidecarOf, step, treeRowBelow, treeRowIn,
} from "./ets-driver.ts";
import { tempDir } from "./test-temp.ts";

// The readers only read the screenshot (their enlarged copies for OCR go to the system's temporary directory).
const screen = (name: DriverScreen) => corpusPath(driverScreenFile(name));

const PROJECT = "Busforge Sweep";
// OCR and ImageMagick run many times per test: the longest took 10 s alone (the catalogue grid's arrows), room left
// for a loaded machine.
const OCR_TIMEOUT = 60_000;

// Positions OCR places a word at, held to the screen within 2 px (another tesseract build may shift a box by a
// pixel); a value off by more, or missing, shows as itself.
const expectNear = (got: readonly (number | null | undefined)[], want: readonly number[]) =>
  expect(got.map((g, i) => (typeof g === "number" && Math.abs(g - want[i]) <= 2 ? want[i] : g))).toEqual([...want]);

corpusTest("the tab bar: the project's tabs, and which one stands in front with its close mark", () => {
  // Each tab read, and where its close mark is clicked where it stands in front (closeExtraProjectTabs): 18 px left
  // of where its white ends.
  const closeMarks = (png: string) => projectTabs(png, PROJECT).map((tab) => {
    const width = frontTabWidth(png, tab);
    return width === null ? null : tab.x + width - 18;
  });
  const overview = screen("overview-no-project");
  expect(projectTabShown(overview)).toBe(false);
  expect(closeMarks(overview)).toEqual([]);
  const one = screen("tabs-one-project-line-collapsed");
  expect(projectTabShown(one)).toBe(true);
  expect(closeMarks(one)).toEqual([382]);
  // A second tab of the project, as ETS restores one after it crashed: behind the first, then brought to the front.
  expect(closeMarks(screen("tabs-extra-tab-behind"))).toEqual([382, null]);
  expect(closeMarks(screen("tabs-extra-tab-in-front"))).toEqual([null, 582]);
  // Another project whose name begins the same ("Busforge Sweep (2)") beside it: projectTabs reads both, so
  // closeExtraProjectTabs clicks the second and checks ETS's window title before closing it.
  expect(closeMarks(screen("tabs-other-project-same-prefix"))).toEqual([382, null]);
  // The project's tab on the green, the overview in front: its title (with the views it shows under it) read too.
  const overviewInFront = screen("tabs-overview-in-front");
  expect(projectTabShown(overviewInFront)).toBe(true);
  expect(closeMarks(overviewInFront)).toEqual([null]);
}, OCR_TIMEOUT);

corpusTest("the topology tree: line 1.1 collapsed, open, selected, and the row under it", () => {
  // findLine11: the tree read in colour, then in grey.
  const line = (png: string) => treeRowIn(png, LINE_11) ?? treeRowIn(png, LINE_11, "gray");
  // The main line collapsed: no line 1.1, nothing under the main line (showTopology opens it).
  const collapsed = screen("tree-main-line-collapsed");
  expect(line(collapsed)).toBeNull();
  const main = treeRowIn(collapsed, /Haupt/);
  expectNear([main?.cy], [217]);
  expect(treeRowBelow(collapsed, main!.cy)).toBeNull();
  // The main line open: line 1.1 under it (here collapsed itself), and nothing under line 1.1.
  const open = screen("tabs-one-project-line-collapsed");
  expectNear([treeRowBelow(open, treeRowIn(open, /Haupt/)!.cy)?.cy, line(open)?.cy], [241, 241]);
  expect(treeRowBelow(open, line(open)!.cy)).toBeNull();
  // Line 1.1 selected with its one device under it (lineDeviceRow, selectByAddress): OCR reads the selected row
  // as "111P Line", a tree row's address with stray characters before it.
  const device = screen("tree-line-selected-device-below");
  expectNear([line(device)?.cy], [240]);
  expect(treeRowBelow(device, line(device)!.cy)?.text).toMatch(/^\S*\s?1\.1\.1 6108\/06-BS-500/);
  // An explicit tree region narrows or extends the scan (used for the lower half of the tree when the catalogue panel is closed).
  expect(treeRowIn(device, /1\.1\.1/, undefined, { x: 0, y: 250, w: 315, h: 40 })?.text).toMatch(/1\.1\.1/);
  expect(treeRowIn(device, /1\.1\.1/, undefined, { x: 0, y: 300, w: 315, h: 40 })).toBeNull();
  const tbu1 = screen("catalogue-two-groups-katalog-tab");
  expectNear([line(tbu1)?.cy], [241]);
  expect(treeRowBelow(tbu1, line(tbu1)!.cy)?.text).toMatch(/1\.1\.1 ?TB\/U1/);
  // Line 1.1 selected and empty (the line emptied before an insert).
  const empty = screen("tree-line-selected-empty");
  expectNear([line(empty)?.cy], [241]);
  expect(treeRowBelow(empty, line(empty)!.cy)).toBeNull();
}, OCR_TIMEOUT);

corpusTest("the catalogue's search: manufacturers' groups by their arrow, open or closed, and the product rows under them", () => {
  // Every screen here shows the catalogue panel's header at y 661, under which the search's grid begins.
  const read = (png: string) => {
    const header = catalogueHeader(png);
    if (!header) throw new Error(`${png}: no catalogue header read`);
    expectNear([header.cy], [661]);
    const g = searchGrid(header), groups = catalogueGroups(png, g);
    return { headers: groups.headers.map((r) => Math.round(r.y)), closed: groups.closed.map((r) => Math.round(r.y)), products: catalogueProducts(png, g).map((r) => ({ y: Math.round(r.y), text: r.text })) };
  };
  // Two groups open, six rows each, as ETS lists them for TB/U1. OCR reads the second header's name as two lines
  // ("STOTZ-KO" and the rest, 7 px apart): within half a row of each other, they are one header.
  for (const name of ["catalogue-two-groups-katalog-tab", "catalogue-two-groups-applikation-tab"] as const) {
    const r = read(screen(name));
    expect(r.closed).toEqual([]);
    expectNear(r.headers, [710, 846]);
    expectNear(r.products.map((p) => p.y), [731, 751, 771, 791, 811, 831, 874, 894, 914, 934, 954, 974]);
  }
  // The group ETS kept closed from an earlier search: its arrow read closed, no product row.
  const closed = read(screen("catalogue-group-closed"));
  expectNear([...closed.headers, ...closed.closed], [711, 711]);
  expect(closed.products).toEqual([]);
  // Opened, its one row, whose application's name is digits but for one letter ("S85166100"), is a product.
  const digits = read(screen("catalogue-application-name-digits"));
  expect(digits.closed).toEqual([]);
  expectNear([...digits.headers, ...digits.products.map((p) => p.y)], [711, 731]);
  expect(digits.products[0].text).toMatch(/85166100/);
  const two = read(screen("properties-fingerprint-misread-2"));
  expect(two.closed).toEqual([]);
  expectNear([...two.headers, ...two.products.map((p) => p.y)], [710, 731, 751]);
  // A search with more hits than the grid shows at once: rows reach past grid.y + grid.h - 30 (refused in insertProduct).
  const overflowPng = screen("catalogue-search-overflow");
  const overflow = read(overflowPng), overflowGrid = searchGrid(catalogueHeader(overflowPng)!);
  expect(catalogueSearchEmpty(overflowPng)).toBe(false);
  expect(overflow.closed).toEqual([]);
  expect(overflow.headers.length).toBe(2);
  expect(Math.max(...overflow.products.map((p) => p.y))).toBeGreaterThan(overflowGrid.y + overflowGrid.h - 30);
}, OCR_TIMEOUT);

corpusTest("the properties panel of a catalogue row: its tabs, the order number, and the application's manufacturer, device type, version and fingerprint", () => {
  const tabValues = (png: string, tab: string, labels: string[]) => {
    const t = propertiesTab(png, tab);
    if (!t) return null;
    const lines = propertiesTable(png, t);
    return labels.map((l) => propertyValue(lines, l));
  };
  const app = (png: string) => tabValues(png, "Applikation", ["Hersteller", "Gerätetyp", "Programmversion", "Fingerprint"]);
  expect(tabValues(screen("catalogue-two-groups-katalog-tab"), "Katalog", ["Bestellnummer"])).toEqual(["TB/U1"]);
  expect(app(screen("catalogue-two-groups-applikation-tab"))).toEqual(["ABB AG - STOTZ-KONTAKT", "$4201", "1.3", "6B9E"]);
  expect(app(screen("tree-line-selected-device-below"))).toEqual(["ABB AG - STOTZ-KONTAKT", "$0806", "3.0", "CC72"]);
  expect(app(screen("properties-fingerprint-leading-zero"))).toEqual(["GIRA Giersiepen", "$5014", "1.1", "0883"]);
  expect(app(screen("properties-hex-values"))).toEqual(["GEWISS", "$5222", "1.2", "B809"]);
  // Two fingerprints OCR has misread ("1634" for 163A without binary thresholding, "DCc90" for DC90): the
  // manufacturer, device type and version read exactly, and the fingerprint read stays closer to the application's
  // than to another application's at the same type and version ("EEEE", 4 edits from either), so pickCatalogueRow
  // takes the row (what was inserted is then checked on the project's export). A fingerprint read as nothing would
  // stand as far from both, and be refused.
  for (const [name, application, want] of [
    ["properties-fingerprint-misread-1", "M-0004_A-1471-12-163A-O00F4", ["Albrecht Jung", "$1471", "1.2"]],
    ["properties-fingerprint-misread-2", "M-0006_A-20B3-11-DC90-O000A", ["Berker", "$20B3", "1.1"]],
  ] as const) {
    const [manufacturer, deviceType, version, fingerprint] = app(screen(name)) ?? [];
    expect([manufacturer, deviceType, version]).toEqual([...want]);
    const entry = { orderNumber: "?", manufacturer: manufacturer!, deviceType: deviceType!, version: version!, fingerprint: fingerprint! };
    const other = { ...entry, fingerprint: "EEEE" };
    expect(pickCatalogueRow([other, entry], "?", application)).toMatchObject({ hit: entry, rows: 1 });
  }
  // The panel still on line 1.1 (a click that did not select the catalogue row): no Katalog or Applikation tab.
  expect(propertiesTab(screen("tabs-one-project-line-collapsed"), "Katalog")).toBeNull();
  expect(propertiesTab(screen("tabs-one-project-line-collapsed"), "Applikation")).toBeNull();
}, OCR_TIMEOUT);

corpusTest("ETS's dialogs: its compatibility warning, after the insert and at the download, and none where it shows none", () => {
  for (const [name, moment] of [["compatibility-warning-insert", "after the insert"], ["compatibility-warning-download", "at the download"]] as const) {
    const png = screen(name);
    step(moment === "after the insert" ? "insert" : "download");
    const box = dialogBox(png)!;
    expect(box).not.toBeNull();
    expect(compatibilityWarning(png, box)).toBe(true);
    const dir = tempDir("ets-driver-compat-");
    const why = keepCompatibilityDialog(dir, png, box, moment);
    expect(why).toBe(compatibilityRefusalWhy(moment));
    const kept = join(dir, "dialog.png");
    expect(readFileSync(kept)).toEqual(readFileSync(png));
    const sidecar = JSON.parse(readFileSync(sidecarOf(kept), "utf8"));
    expect(sidecar).toMatchObject({ format: SCREEN_FORMAT, step: moment === "after the insert" ? "insert" : "download", why: `driver-refused: ${why}`, from: `${name}.png` });
    expect(sidecar.readings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reader: "compatibilityWarning", screen: `${name}.png`, read: true }),
      expect.objectContaining({ reader: "dialogText", screen: `${name}.png`, read: expect.stringMatching(/Kompatibilit/) }),
    ]));
  }
  const connection = screen("dialog-connection-not-available");
  expect(compatibilityWarning(connection)).toBe(false);
  expect(catalogueDownloadDialog(connection)).toMatchObject({ kind: "other", text: expect.stringMatching(/^Verbindung ausw/) });
  // An unknown dialog's text, as settled names it (here the simulator's connection ETS could not reach).
  expect(dialogText(connection)).toMatch(/^Verbindung ausw\S+ Die Verbindung Sim-MeanWell .* nicht verf/);
  // The question before ETS compresses the project (compressProject goes on only where it says the project closes).
  expect(dialogText(screen("dialog-compress-question"))).toMatch(/Projektdaten komprimieren .*geschlossen werden/);
  // ETS's project password prompt at the insert of a Data Secure product: not a compatibility warning, cancelled via Abbrechen.
  const pw = screen("dialog-project-password"), pwBox = dialogBox(pw)!;
  expect(pwBox).not.toBeNull();
  expect(compatibilityWarning(pw, pwBox)).toBe(false);
  expect(dialogText(pw, pwBox)).toMatch(/Projektpasswort setzen.*Busforge Sweep/);
  const cancel = dialogButton(pw, pwBox, "Abbrechen");
  expect(cancel && cancel.cx >= 1210 && cancel.cx <= 1285 && cancel.cy >= 795 && cancel.cy <= 815).toBe(true);
  for (const name of ["tabs-one-project-line-collapsed", "overview-no-project", "catalogue-two-groups-katalog-tab"] as const) {
    expect(dialogBox(screen(name))).toBeNull();
    expect(dialogText(screen(name))).toBeNull();
  }
}, OCR_TIMEOUT);

corpusTest("the catalogue download: ETS's refusal with its OK, and its progress", () => {
  const png = screen("catalogue-download-refused");
  const refused = catalogueDownloadDialog(png);
  expect(refused).toMatchObject({ kind: "refused", text: expect.stringMatching(/Online-Katalog-Download .*fehlgeschlagen/) });
  // The OK in the dialog's bottom bar, where downloadOutcome clicks it: its label spans x 1233-1253, y 686-704.
  const ok = dialogButton(png, refused!.box, "OK");
  expect(ok && ok.cx >= 1233 && ok.cx <= 1253 && ok.cy >= 686 && ok.cy <= 704).toBe(true);
  expect(catalogueDownloadDialog(screen("catalogue-download-progress"))?.kind).toBe("progress");
  // waitNoDialog's test of a dialog it waits out: the progress dialog is one, the refusal ("Der Produktdownload aus
  // dem Online-Katalog ist fehlgeschlagen") none, however much of the progress dialog's text it shares.
  expect(isCatalogueProgress(dialogText(screen("catalogue-download-progress"))!)).toBe(true);
  expect(isCatalogueProgress(refused!.text)).toBe(false);
}, OCR_TIMEOUT);

corpusTest("the catalogue's search over rows whose product data ETS has not loaded: product rows marked so, not group headers", () => {
  // A search for STEINEL: one group open, its rows each with the cloud of a product whose data ETS has not loaded in
  // front of the product's icon, where a group header has its arrow.
  const png = screen("catalogue-rows-not-loaded");
  const header = catalogueHeader(png)!;
  expectNear([header.cy], [661]);
  const grid = searchGrid(header), groups = catalogueGroups(png, grid), products = catalogueProducts(png, grid);
  expectNear(groups.headers.map((r) => r.y), [710]);
  expect(groups.closed).toEqual([]);
  // Every row the grid shows whole under the header (the last one stands cut off by the grid's end).
  expectNear(products.map((r) => r.y).slice(0, 21), Array.from({ length: 21 }, (_, i) => 731 + 20 * i));
  expect(products.every((r) => !r.loaded)).toBe(true);
  // A loaded row reads as loaded.
  const loaded = screen("catalogue-two-groups-katalog-tab");
  expect(catalogueProducts(loaded, searchGrid(catalogueHeader(loaded)!)).map((r) => r.loaded)).toEqual(Array(12).fill(true));
}, OCR_TIMEOUT);

corpusTest("a screenshot the driver keeps gets a sidecar: the step, why, and what the step's readers read", () => {
  const png = screen("tabs-extra-tab-behind");
  step("the sidecar's test");
  const tabs = projectTabs(png, PROJECT);
  const kept = keepScreen(join(tempDir("ets-driver-sidecar-"), "dialog.png"), png, "a reason");
  expect(readFileSync(kept)).toEqual(readFileSync(png));
  const sidecar = JSON.parse(readFileSync(sidecarOf(kept), "utf8"));
  expect(sidecar).toMatchObject({ format: SCREEN_FORMAT, step: "the sidecar's test", why: "a reason", from: "tabs-extra-tab-behind.png" });
  expect(sidecar.readings).toEqual([{ reader: "projectTabs", screen: "tabs-extra-tab-behind.png", args: [PROJECT], read: JSON.parse(JSON.stringify(tabs)) }]);
  // A new step starts without the readings of the one before; a screenshot kept without a reason has no `why`.
  step("the next step");
  const next = JSON.parse(readFileSync(sidecarOf(keepScreen(join(tempDir("ets-driver-sidecar-"), "failure.png"), png)), "utf8"));
  expect(next).toMatchObject({ step: "the next step", readings: [] });
  expect("why" in next).toBe(false);
  // A tree reader's pattern is kept as its source; a grid reader's rows without OCR's words (their text holds them).
  step("the grid's step");
  const grid = screen("catalogue-two-groups-katalog-tab");
  treeRowIn(grid, LINE_11);
  catalogueProducts(grid, searchGrid(catalogueHeader(grid)!));
  const moved = join(tempDir("ets-driver-sidecar-"), "refused-rows-0-9.png");
  // A kept screenshot moved, as a refused batch's is, takes its sidecar along.
  moveScreen(keepScreen(join(dirname(moved), "refused-download.png"), grid), moved);
  const gridSidecar = JSON.parse(readFileSync(sidecarOf(moved), "utf8"));
  expect(gridSidecar.readings.map((r: { reader: string; args?: unknown[] }) => [r.reader, r.args?.[0]])).toEqual([["treeRowIn", String(LINE_11)], ["catalogueHeader", undefined], ["catalogueProducts", expect.anything()]]);
  expect(JSON.stringify(gridSidecar)).not.toContain('"words"');
  // A sidecar that cannot be written (here a directory in its place) fails nothing: the screenshot stays kept.
  const dir = tempDir("ets-driver-sidecar-");
  mkdirSync(join(dir, "dialog.json"));
  expect(readFileSync(keepScreen(join(dir, "dialog.png"), png))).toEqual(readFileSync(png));
  expect(() => sidecarOf(join(dir, "dialog.jpg"))).toThrow("a kept screenshot is a .png");
}, OCR_TIMEOUT);

corpusTest("the catalogue panel before the download: shown, its search empty or not", () => {
  // The whole catalogue, its search empty, as downloadCatalogue needs it; a search for an order number; no project.
  const whole = screen("catalogue-one-row-selected");
  expect([cataloguePanelShown(whole), catalogueSearchEmpty(whole)]).toEqual([true, true]);
  const searched = screen("catalogue-two-groups-katalog-tab");
  expect([cataloguePanelShown(searched), catalogueSearchEmpty(searched)]).toEqual([true, false]);
  const overview = screen("overview-no-project");
  expect([cataloguePanelShown(overview), catalogueSearchEmpty(overview)]).toEqual([false, false]);
}, OCR_TIMEOUT);

corpusTest("the catalogue grid's selection: one row, rows, a row at the grid's bottom edge; Herunterladen enabled or not", () => {
  const one = screen("catalogue-one-row-selected");
  expect(oneRowSelected(selectionPattern(one))).toBe(true);
  expect(downloadEnabled(one)).toBe(true);
  // A row whose product data ETS holds already: Herunterladen disabled.
  const loaded = screen("catalogue-one-row-loaded");
  expect(oneRowSelected(selectionPattern(loaded))).toBe(true);
  expect(downloadEnabled(loaded)).toBe(false);
  expect(selectionPattern(screen("catalogue-rows-selected"))).toMatch(/^0+1{6,}0+$/);
  // A selected row at the grid's bottom edge may be the visible end of a longer selection.
  const edge = selectionPattern(screen("catalogue-selection-bottom-edge"));
  expect(edge).toMatch(/^0+1{1,5}$/);
  expect(oneRowSelected(edge)).toBe(false);
});
