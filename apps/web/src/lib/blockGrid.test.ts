import { describe, expect, test } from "bun:test";
import type { CfgBlock, CfgItem, CfgParamView } from "../api.ts";
import { gridCells, gridColumns, itemMatches, matchingItems } from "./blockGrid.ts";

const at = (row: number, col: number) => ({ cell: { row, col } });
const sep = (text: string, cell?: { row: number; col: number }, uiHint = ""): CfgItem => ({ kind: "separator", text, uiHint, ...(cell ? { cell } : {}) });
const param = (name: string, value: string, cell?: { row: number; col: number }): CfgItem =>
  ({ kind: "param", param: { refId: name, name, value, control: "number" } as CfgParamView, ...(cell ? { cell } : {}) });
const grid = (items: CfgItem[], extra: Partial<CfgBlock> = {}): CfgBlock => ({ id: "G", name: "", level: 1, layout: "Grid", items, ...extra });

describe("gridCells", () => {
  test("keeps every item of a cell, drops a separator the cell already holds, and lists cell-less items apart", () => {
    const co: CfgItem = { kind: "comObject", comObject: { number: 1, name: "o" } as never };
    const cells = gridCells(grid([sep("1.05", at(1, 6).cell, "Headline"), sep("1.05", at(1, 6).cell, "Headline"), param("a", "1", at(1, 6).cell), sep("x", at(1, 6).cell), co]));
    expect(cells.cells.get("1,6")!.map((i) => (i.kind === "separator" ? i.text : i.kind))).toEqual(["1.05", "param", "x"]);
    expect(cells.loose).toEqual([co]);
  });
});

describe("gridColumns", () => {
  test("leaves out the columns no item occupies and takes a percentage as a share of the free width", () => {
    const b = grid([sep("label", at(1, 1).cell), param("p", "1", at(1, 4).cell)], { cols: [{ width: "23%" }, { width: "6%" }, { width: "5%" }, { width: "7.5%" }] });
    const { col, template } = gridColumns(b, gridCells(b).cells);
    expect([...col]).toEqual([[1, 1], [4, 2]]);
    expect(template).toBe("minmax(min-content, 23fr) minmax(min-content, 7.5fr)");
  });
  test("a plain length stays, anything else and an undeclared column become auto", () => {
    const b = grid([param("a", "1", at(1, 1).cell), param("b", "1", at(1, 2).cell), param("c", "1", at(1, 3).cell)], { cols: [{ width: "120px" }, { width: "*" }] });
    expect(gridColumns(b, gridCells(b).cells).template).toBe("minmax(min-content, 120px) minmax(min-content, auto) minmax(min-content, auto)");
  });
  test("a Table keeps its caption column and every column that carries a caption", () => {
    const b = grid([param("a", "1", at(1, 1).cell)], { layout: "Table", cols: [{ text: "A", width: "50%" }, { width: "25%" }, { text: "C", width: "25%" }] });
    const { col, template } = gridColumns(b, gridCells(b).cells);
    expect([...col]).toEqual([[1, 1], [3, 2]]);
    expect(template).toBe("auto minmax(min-content, 50fr) minmax(min-content, 25fr)");
  });
});

describe("itemMatches", () => {
  test("matches a separator and a button by their labels", () => {
    expect(itemMatches(sep("Haltedauer"), "halte")).toBe(true);
    expect(itemMatches({ kind: "button", button: { text: "Ermitteln", handler: "h" } }, "ermit")).toBe(true);
    expect(itemMatches(sep("Haltedauer"), "")).toBe(false);
  });
});

describe("matchingItems", () => {
  const label = sep("Haltedauer", at(1, 1).cell);
  const value = param("", "30", at(1, 2).cell);
  const other = sep("Entfernung", at(2, 1).cell);
  const far = param("", "8", at(2, 2).cell);
  test("in a grid a matching label keeps its whole row, and a matching value its label", () => {
    const b = grid([label, value, other, far]);
    expect(matchingItems(b, "haltedauer")).toEqual([label, value]);
    expect(matchingItems(b, "30")).toEqual([label, value]);
    expect(matchingItems(b, "nothing")).toEqual([]);
  });
  test("in a grid a cell-less item is kept only when it matches itself", () => {
    const co: CfgItem = { kind: "comObject", comObject: { number: 4, name: "Haltedauer Objekt" } as never };
    expect(matchingItems(grid([label, value, co, other]), "haltedauer")).toEqual([label, value, co]);
  });
  test("a Table row caption keeps its row, a column caption the whole table", () => {
    const b = grid([value, far], { layout: "Table", rows: [{ text: "Erste" }, { text: "Zweite" }], cols: [{}, { text: "Wert" }] });
    expect(matchingItems(b, "zweite")).toEqual([far]);
    expect(matchingItems(b, "wert")).toEqual([value, far]);
  });
  test("in a list a matching heading keeps the rows below it up to the next heading", () => {
    const a = param("a", "1"), b = param("b", "2"), c = param("c", "3");
    const block: CfgBlock = { id: "L", name: "", level: 1, items: [sep("Startverzögerung"), a, sep("", undefined, "HorizontalRuler"), b, sep("Sonst"), c] };
    expect(matchingItems(block, "startverz")).toEqual([block.items[0], a, block.items[2], b]);
    expect(matchingItems(block, "c")).toEqual([c]);
  });
});
