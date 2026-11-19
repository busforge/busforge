import { describe, expect, test } from "bun:test";
import type { CfgBlock, CfgItem } from "../api.ts";
import { flowOf, inlineChildren, keptAt } from "./blockFlow.ts";

const sep = (text: string): CfgItem => ({ kind: "separator", text, uiHint: "" });
const block = (id: string, extra: Partial<CfgBlock> = {}): CfgBlock => ({ id, name: "", items: [], level: 1, ...extra });

describe("inlineChildren", () => {
  test("groups inline blocks by parent in authored order, leaves pages and orphans out", () => {
    const page = block("P", { level: 0 });
    const a = block("A", { inline: true, at: 2, parentId: "P" });
    const b = block("B", { inline: true, at: 0, parentId: "P" });
    const sub = block("S", { parentId: "P" });
    const orphan = block("O", { inline: true, at: 0, parentId: "gone" });
    const kids = inlineChildren([page, a, b, sub, orphan]);
    expect([...kids.keys()]).toEqual(["P"]);
    expect(kids.get("P")!.map((k) => k.id)).toEqual(["B", "A"]);
  });
});

describe("flowOf", () => {
  const items = [sep("a"), sep("b"), sep("c")];
  test("places each inline block before the item it was authored before", () => {
    const parts = flowOf(items, [block("X", { inline: true, at: 0 }), block("Y", { inline: true, at: 2 })]);
    expect(parts.map((p) => (p.kind === "inline" ? p.block.id : `${p.from}:${p.items.length}`))).toEqual(["X", "0:2", "Y", "2:1"]);
  });
  test("an inline block without a place follows the items", () => {
    const parts = flowOf(items, [block("X", { inline: true })]);
    expect(parts.map((p) => (p.kind === "inline" ? p.block.id : `${p.from}:${p.items.length}`))).toEqual(["0:3", "X"]);
  });
  test("kept whole (a grid), the items stay one run and every inline block follows them", () => {
    const parts = flowOf(items, [block("X", { inline: true, at: 1 })], true);
    expect(parts.map((p) => (p.kind === "inline" ? p.block.id : `${p.from}:${p.items.length}`))).toEqual(["0:3", "X"]);
  });
  test("no inline blocks: one run of all items", () => {
    expect(flowOf(items, [])).toEqual([{ kind: "items", items, from: 0 }]);
  });
});

describe("keptAt", () => {
  test("counts the kept items before the place", () => {
    const items = [sep("a"), sep("b"), sep("c"), sep("d")];
    expect(keptAt(items, [items[0], items[3]], 3)).toBe(1);
    expect(keptAt(items, [], 3)).toBe(0);
    expect(keptAt(items, items, 4)).toBe(4);
  });
});
