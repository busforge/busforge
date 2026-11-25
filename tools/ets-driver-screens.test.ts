// The ETS driver's screen readers (tools/ets-driver.ts) on full-resolution screenshots of ETS 6.4.1 that real
// driver runs on the bench host left (the private corpus, DRIVER_SCREENS in tools/corpus.ts; README.md beside them
// says what each shows). Each reader is fed the screenshot whole, as the driver feeds it its screen, and must read
// what the screen shows. They run tesseract and ImageMagick, as the driver does.
import { expect } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { corpusPath, driverScreenFile, type DriverScreen } from "./corpus.ts";
import { corpusTest } from "./corpus-test.ts";
import {
  catalogueDownloadDialog, catalogueGroups, catalogueHeader, cataloguePanelShown, catalogueProducts, catalogueSearchEmpty, compatibilityWarning, dialogBox, dialogText, downloadEnabled, frontTabWidth, LINE_11,
  oneRowSelected, pickCatalogueRow, projectTabs, projectTabShown, propertiesTab, propertiesTable, propertyValue, searchGrid, selectionPattern, treeRowBelow, treeRowIn,
} from "./ets-driver.ts";
import { tempDir } from "./test-temp.ts";

// A copy of the screenshot outside the corpus: the readers write their enlarged copy for OCR beside the file read.
let dir: string | undefined;
const screen = (name: DriverScreen) => {
  dir ??= tempDir("ets-driver-screens-");
  const png = join(dir, `${name}.png`);
  copyFileSync(corpusPath(driverScreenFile(name)), png);
  return png;
};

const PROJECT = "Busforge Sweep";
// OCR and ImageMagick run many times per test: the longest took 10 s alone (the catalogue grid's arrows), room left
// for a loaded machine.
const OCR_TIMEOUT = 60_000;

corpusTest("the tab bar: the project's tabs, and which one stands in front with its close mark", () => {
  // Where the close mark of a tab in front is clicked (closeExtraProjectTabs): 18 px left of where its white ends.
  const closeMark = (png: string, i: number) => {
    const tab = projectTabs(png, PROJECT)[i];
    const width = frontTabWidth(png, tab);
    return width === null ? null : tab.x + width - 18;
  };
  const overview = screen("overview-no-project");
  expect(projectTabShown(overview)).toBe(false);
  expect(projectTabs(overview, PROJECT)).toEqual([]);
  const one = screen("tabs-one-project-line-collapsed");
  expect(projectTabShown(one)).toBe(true);
  expect(projectTabs(one, PROJECT)).toHaveLength(1);
  expect(closeMark(one, 0)).toBe(382);
  // A second tab of the project, as ETS restores one after it crashed: behind the first, then brought to the front.
  const behind = screen("tabs-extra-tab-behind");
  expect(projectTabs(behind, PROJECT)).toHaveLength(2);
  expect([closeMark(behind, 0), closeMark(behind, 1)]).toEqual([382, null]);
  const front = screen("tabs-extra-tab-in-front");
  expect(projectTabs(front, PROJECT)).toHaveLength(2);
  expect([closeMark(front, 0), closeMark(front, 1)]).toEqual([null, 582]);
  // The project's tab on the green, the overview in front: its title (with the views it shows under it) read too.
  const overviewInFront = screen("tabs-overview-in-front");
  expect(projectTabShown(overviewInFront)).toBe(true);
  expect(projectTabs(overviewInFront, PROJECT)).toHaveLength(1);
  expect(closeMark(overviewInFront, 0)).toBeNull();
}, OCR_TIMEOUT);

corpusTest("the topology tree: line 1.1 collapsed, open, selected, and the row under it", () => {
  // findLine11: the tree read in colour, then in grey.
  const line = (png: string) => treeRowIn(png, LINE_11) ?? treeRowIn(png, LINE_11, "gray");
  // The main line collapsed: no line 1.1, nothing under the main line (showTopology opens it).
  const collapsed = screen("tree-main-line-collapsed");
  expect(line(collapsed)).toBeNull();
  const main = treeRowIn(collapsed, /Haupt/);
  expect(main?.cy).toBe(217);
  expect(treeRowBelow(collapsed, main!.cy)).toBeNull();
  // The main line open: line 1.1 under it (here collapsed itself), and nothing under line 1.1.
  const open = screen("tabs-one-project-line-collapsed");
  expect(treeRowBelow(open, treeRowIn(open, /Haupt/)!.cy)?.cy).toBe(241);
  expect(line(open)?.cy).toBe(241);
  expect(treeRowBelow(open, 241)).toBeNull();
  // Line 1.1 selected with its one device under it (lineDeviceRow, selectByAddress): OCR reads the selected row
  // as "111P Line", a tree row's address with stray characters before it.
  const device = screen("tree-line-selected-device-below");
  expect(line(device)?.cy).toBe(240);
  expect(treeRowBelow(device, 240)?.text).toMatch(/^\S*\s?1\.1\.1 6108\/06-BS-500/);
  const tbu1 = screen("catalogue-two-groups-katalog-tab");
  expect(line(tbu1)?.cy).toBe(241);
  expect(treeRowBelow(tbu1, 241)?.text).toMatch(/1\.1\.1 ?TB\/U1/);
  // Line 1.1 selected and empty (the line emptied before an insert).
  const empty = screen("tree-line-selected-empty");
  expect(line(empty)?.cy).toBe(241);
  expect(treeRowBelow(empty, 241)).toBeNull();
}, OCR_TIMEOUT);

corpusTest("the catalogue's search: manufacturers' groups by their arrow, open or closed, and the product rows under them", () => {
  const grid = (png: string) => searchGrid(catalogueHeader(png) ?? { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: -1, text: "no catalogue header" });
  const read = (png: string) => {
    const g = grid(png), groups = catalogueGroups(png, g);
    return { headers: groups.headers.map((r) => Math.round(r.y)), closed: groups.closed.map((r) => Math.round(r.y)), products: catalogueProducts(png, g).map((r) => ({ y: Math.round(r.y), text: r.text })) };
  };
  // Two groups open, six rows each, as ETS lists them for TB/U1. OCR reads the second header's name as two lines
  // ("STOTZ-KO" and the rest, 7 px apart): both stand on the header's arrow.
  for (const name of ["catalogue-two-groups-katalog-tab", "catalogue-two-groups-applikation-tab"] as const) {
    const png = screen(name);
    expect(catalogueHeader(png)?.cy).toBe(661);
    const r = read(png);
    expect(r.closed).toEqual([]);
    expect(r.headers[0]).toBe(710);
    expect(r.headers.slice(1).every((y) => y >= 845 && y <= 853)).toBe(true);
    expect(r.products.map((p) => p.y)).toEqual([731, 751, 771, 791, 811, 831, 874, 894, 914, 934, 954, 974]);
  }
  // The group ETS kept closed from an earlier search: its arrow read closed, no product row.
  expect(read(screen("catalogue-group-closed"))).toEqual({ headers: [711], closed: [711], products: [] });
  // Opened, its one row, whose application's name is digits but for one letter ("S85166100"), is a product.
  const digits = read(screen("catalogue-application-name-digits"));
  expect([digits.headers, digits.closed, digits.products.map((p) => p.y)]).toEqual([[711], [], [731]]);
  expect(digits.products[0].text).toMatch(/85166100/);
  const two = read(screen("properties-fingerprint-misread-2"));
  expect([two.headers, two.closed, two.products.map((p) => p.y)]).toEqual([[710], [], [731, 751]]);
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
  // Two fingerprints OCR misreads at every scale and preparation tried ("1634" for 163A, "DCc3s0" for DC90): the
  // device type and version read exactly, and the row is still the one picked (pickCatalogueRow takes the closest
  // reading; what was inserted is checked on the project's export).
  for (const [name, application] of [["properties-fingerprint-misread-1", "M-0004_A-1471-12-163A-O00F4"], ["properties-fingerprint-misread-2", "M-0006_A-20B3-11-DC90-O000A"]] as const) {
    const [manufacturer, deviceType, version, fingerprint] = app(screen(name)) ?? [];
    expect([deviceType, version]).toEqual(application === "M-0004_A-1471-12-163A-O00F4" ? ["$1471", "1.2"] : ["$20B3", "1.1"]);
    const entry = { orderNumber: "?", manufacturer, deviceType: deviceType!, version: version!, fingerprint: fingerprint! };
    expect(pickCatalogueRow([entry], "?", application)).toMatchObject({ hit: entry, rows: 1 });
  }
  // The panel still on line 1.1 (a click that did not select the catalogue row): no Katalog tab.
  expect(propertiesTab(screen("tabs-one-project-line-collapsed"), "Katalog")).toBeUndefined();
}, OCR_TIMEOUT);

corpusTest("ETS's dialogs: its compatibility warning, after the insert and at the download, and none where it shows none", () => {
  expect(compatibilityWarning(screen("compatibility-warning-insert"))).toBe(true);
  expect(compatibilityWarning(screen("compatibility-warning-download"))).toBe(true);
  const connection = screen("dialog-connection-not-available");
  expect(compatibilityWarning(connection)).toBe(false);
  expect(catalogueDownloadDialog(connection)).toMatchObject({ kind: "other", text: expect.stringMatching(/^Verbindung ausw/) });
  // An unknown dialog's text, as settled names it (here the simulator's connection ETS could not reach).
  expect(dialogText(connection)).toMatch(/^Verbindung ausw\S+ Die Verbindung Sim-MeanWell .* nicht verf/);
  // The question before ETS compresses the project (compressProject goes on only where it says the project closes).
  expect(dialogText(screen("dialog-compress-question"))).toMatch(/Projektdaten komprimieren .*geschlossen werden/);
  for (const name of ["tabs-one-project-line-collapsed", "overview-no-project", "catalogue-two-groups-katalog-tab"] as const) {
    expect(dialogBox(screen(name))).toBeNull();
    expect(dialogText(screen(name))).toBeNull();
  }
}, OCR_TIMEOUT);

corpusTest("the catalogue download: ETS's refusal with its OK, and its progress", () => {
  const refused = catalogueDownloadDialog(screen("catalogue-download-refused"));
  expect(refused).toMatchObject({ kind: "refused", text: expect.stringMatching(/Online-Katalog-Download .*fehlgeschlagen/) });
  // The OK in the dialog's bottom bar, where downloadOutcome clicks it.
  expect(refused?.kind === "refused" && refused.ok && [refused.ok.cx, refused.ok.cy]).toEqual([1243, 695]);
  expect(catalogueDownloadDialog(screen("catalogue-download-progress"))?.kind).toBe("progress");
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
