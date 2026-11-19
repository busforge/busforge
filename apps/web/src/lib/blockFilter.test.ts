import { describe, expect, test } from "bun:test";
import type { CfgBlock, CfgCell, CfgItem, CfgParamView } from "../api.ts";
import { itemMatches, matchingItems, underMatchingHeading } from "./blockFilter.ts";
import { keptAt } from "./blockFlow.ts";

const sep = (text: string, cell?: CfgCell, uiHint = ""): CfgItem => ({ kind: "separator", text, uiHint, ...(cell ? { cell } : {}) });
const param = (name: string, value: string, cell?: CfgCell): CfgItem =>
  ({ kind: "param", param: { refId: name, name, value, control: "number" } as CfgParamView, ...(cell ? { cell } : {}) });
const grid = (items: CfgItem[], extra: Partial<CfgBlock> = {}): CfgBlock => ({ id: "G", name: "", level: 1, layout: "Grid", items, ...extra });
const list = (items: CfgItem[]): CfgBlock => ({ id: "L", name: "", level: 1, items });
const c = (row: number, col: number): CfgCell => ({ row, col });
// Same objects, same order: what keptAt relies on.
const same = (kept: CfgItem[], expected: CfgItem[]) => {
  expect(kept.length).toBe(expected.length);
  kept.forEach((k, i) => expect(k).toBe(expected[i]));
};

describe("itemMatches", () => {
  test("matches a separator and a button by their labels, a com-object by function text or name", () => {
    expect(itemMatches(sep("Haltedauer"), "halte")).toBe(true);
    expect(itemMatches({ kind: "button", button: { text: "Ermitteln", handler: "h" } }, "ermit")).toBe(true);
    expect(itemMatches({ kind: "comObject", comObject: { number: 1, name: "PM_Out", functionText: "Ausgang" } as never }, "pm_out")).toBe(true);
    expect(itemMatches(sep("Haltedauer"), "")).toBe(false);
  });
});

describe("matchingItems in a grid", () => {
  const label = sep("Haltedauer", c(1, 1));
  const value = param("", "30", c(1, 2));
  const other = sep("Entfernung", c(2, 1));
  const far = param("", "8", c(2, 2));
  test("a matching label keeps its whole row, and a matching value its label", () => {
    const b = grid([label, value, other, far]);
    same(matchingItems(b, "haltedauer"), [label, value]);
    same(matchingItems(b, "30"), [label, value]);
    same(matchingItems(b, "nothing"), []);
  });
  test("a first row of labels only (column headers) stays with any matching row", () => {
    const head = [sep("Eingang", c(1, 1)), sep("KO-Nr.", c(1, 2))];
    const row = [sep("Präsenz", c(2, 1)), param("", "121", c(2, 2))];
    const b = grid([...head, ...row, sep("Sperre", c(3, 1)), param("", "9", c(3, 2))]);
    same(matchingItems(b, "121"), [...head, ...row]);
    same(matchingItems(b, "zzz"), []);
  });
  test("a cell-less item is kept only when it matches itself", () => {
    const co: CfgItem = { kind: "comObject", comObject: { number: 4, name: "Haltedauer Objekt" } as never };
    same(matchingItems(grid([label, value, co, other, far]), "haltedauer"), [label, value, co]);
  });
  test("a Table row caption keeps its row, a column caption the whole table", () => {
    const v1 = param("", "1", c(1, 1)), v2 = param("", "2", c(2, 1));
    const b = grid([v1, v2], { layout: "Table", rows: [{ text: "Erste" }, { text: "Zweite" }], cols: [{ text: "Wert" }] });
    same(matchingItems(b, "zweite"), [v2]);
    same(matchingItems(b, "wert"), [v1, v2]);
  });
  test("the kept items move an inline block's place as keptAt expects", () => {
    const b = grid([label, value, other, far]);
    expect(keptAt(b.items, matchingItems(b, "entfernung"), 4)).toBe(2);
  });
});

describe("matchingItems in a list", () => {
  const a = param("a", "1"), b = param("b", "2"), d = param("d", "3");
  const ruler = sep("", undefined, "HorizontalRuler");
  test("a matching heading keeps the rows below it up to the next heading, across a ruler", () => {
    const block = list([sep("Startverzögerung"), a, ruler, b, sep("Sonst"), d]);
    same(matchingItems(block, "startverz"), [block.items[0], a, ruler, b]);
    same(matchingItems(block, "d"), [d]);
  });
  test("an error note is no heading: it neither ends a section nor starts one", () => {
    const error = sep("Startwert ungültig", undefined, "Error");
    const block = list([sep("Startverzögerung"), a, error, b, sep("Sonst"), d]);
    same(matchingItems(block, "startverz"), [block.items[0], a, error, b]);
    same(matchingItems(list([error, a, b]), "ungültig"), [error]);
  });
});

describe("underMatchingHeading", () => {
  test("names the heading above an inline block's place", () => {
    const block = list([sep("Startverzögerung"), param("a", "1"), sep("Sonst"), param("b", "2")]);
    expect(underMatchingHeading(block, 2, "startverz")).toBe(true);
    expect(underMatchingHeading(block, 4, "startverz")).toBe(false);
    expect(underMatchingHeading(block, 0, "startverz")).toBe(false);
    expect(underMatchingHeading(grid(block.items), 2, "startverz")).toBe(false);
  });
});
