import { describe, expect, test } from "bun:test";
import type { CfgBlock, CfgCell, CfgItem, CfgParamView } from "../api.ts";
import { gridLayout } from "./blockGrid.ts";

const sep = (text: string, cell: CfgCell, uiHint = ""): CfgItem => ({ kind: "separator", text, uiHint, cell });
const param = (name: string, cell: CfgCell): CfgItem => ({ kind: "param", param: { refId: name, name, value: "1", control: "number" } as CfgParamView, cell });
const grid = (items: CfgItem[], extra: Partial<CfgBlock> = {}): CfgBlock => ({ id: "G", name: "", level: 1, layout: "Grid", items, ...extra });
const c = (row: number, col: number): CfgCell => ({ row, col });

describe("gridLayout", () => {
  test("keeps every item of a cell, drops a separator the cell already holds, and lists cell-less items apart", () => {
    const co: CfgItem = { kind: "comObject", comObject: { number: 1, name: "o" } as never };
    const b = grid([sep("1.05", c(1, 6), "Headline"), sep("1.05", c(1, 6), "Headline"), param("a", c(1, 6)), sep("x", c(1, 6)), co]);
    const { cells, loose } = gridLayout(b, b);
    expect(cells.get("1,6")).toEqual([b.items[0], b.items[2], b.items[3]]);
    expect(loose).toEqual([co]);
  });
  test("leaves out the columns no item occupies and shares the width by the percentages when they exceed 100", () => {
    const b = grid([sep("label", c(1, 1)), param("p", c(1, 4))], { cols: [{ width: "80%" }, { width: "6%" }, { width: "5%" }, { width: "30%" }] });
    const { col, template } = gridLayout(b, b);
    expect([...col]).toEqual([[1, 1], [4, 2]]);
    expect(template).toBe("minmax(min-content, 80fr) minmax(min-content, 30fr)");
  });
  test("percentages under 100 leave the rest of the width free", () => {
    const b = grid([sep("a", c(1, 1)), param("b", c(1, 2))], { cols: [{ width: "45%" }, { width: "20.5%" }] });
    expect(gridLayout(b, b).template).toBe("minmax(min-content, 45fr) minmax(min-content, 20.5fr) minmax(0px, 34.5fr)");
  });
  test("a plain length stays, anything else and an undeclared column become auto", () => {
    const b = grid([param("a", c(1, 1)), param("b", c(1, 2)), param("c", c(1, 3))], { cols: [{ width: "120px" }, { width: "*" }] });
    expect(gridLayout(b, b).template).toBe("minmax(min-content, 120px) minmax(min-content, auto) minmax(min-content, auto)");
  });
  test("the columns come from the configured block, the rows from the shown items", () => {
    const b = grid([sep("a", c(1, 1)), param("x", c(1, 3)), sep("b", c(5, 1)), param("y", c(5, 2))]);
    const shown = { ...b, items: [b.items[2], b.items[3]] };
    const { col, row, cells } = gridLayout(shown, b);
    expect([...col]).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect([...row]).toEqual([[5, 1]]);
    expect([...cells.keys()]).toEqual(["5,1", "5,2"]);
  });
  test("a Table keeps its caption column, its captioned columns, and its captioned rows only while nothing is filtered", () => {
    const b = grid([param("a", c(2, 1))], { layout: "Table", cols: [{ text: "A", width: "50%" }, { width: "25%" }, { text: "C", width: "50%" }], rows: [{ text: "R1" }, { text: "R2" }] });
    const all = gridLayout(b, b);
    expect([...all.col]).toEqual([[1, 1], [3, 2]]);
    expect(all.template).toBe("auto minmax(min-content, 50fr) minmax(min-content, 50fr)");
    expect([...all.row]).toEqual([[1, 1], [2, 2]]);
    expect([...gridLayout({ ...b, items: [...b.items] }, b).row]).toEqual([[2, 1]]);
  });
});
