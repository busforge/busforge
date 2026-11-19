import type { CfgBlock, CfgItem } from "../api.ts";
import { cellOf } from "./blockGrid.ts";

// What the device page's parameter filter keeps of a block.

export const norm = (s?: string) => (s ?? "").toLowerCase();

// Whether an item matches the search term: a parameter by its text or value, a com-object by its
// function text or its name, a separator or a button by its label.
export function itemMatches(item: CfgItem, q: string): boolean {
  if (!q) return false;
  switch (item.kind) {
    case "param": return norm(item.param.name).includes(q) || norm(item.param.value).includes(q);
    case "comObject": return norm(item.comObject.functionText).includes(q) || norm(item.comObject.name).includes(q);
    case "separator": return norm(item.text).includes(q);
    case "button": return norm(item.button.text).includes(q);
    case "unsupported": return false;
  }
}

// A separator the page draws as a section heading in a list: one with text that is neither a ruler nor
// an error note.
const isHeading = (item: CfgItem) => item.kind === "separator" && !!item.text && item.uiHint !== "HorizontalRuler" && item.uiHint !== "Error";

// The items of `block` the search term keeps, the same objects in authored order.
// - In a grid a match keeps its whole row, so a value stands next to its label, and the first row too
//   when it holds only labels (the column headers). A match on a Table's column caption keeps the table.
// - In a list a matching heading keeps the rows below it up to the next heading; any other row is kept
//   when it matches itself.
export function matchingItems(block: CfgBlock, q: string): CfgItem[] {
  if (!q) return [];
  if (block.layout) {
    if (block.layout === "Table" && block.cols?.some((c) => norm(c.text).includes(q))) return block.items;
    const rows = new Set<number>();
    block.rows?.forEach((r, i) => { if (block.layout === "Table" && norm(r.text).includes(q)) rows.add(i + 1); });
    for (const item of block.items) { const cell = cellOf(item); if (cell && itemMatches(item, q)) rows.add(cell.row); }
    const first = Math.min(...block.items.flatMap((i) => cellOf(i)?.row ?? []));
    const header = block.items.every((i) => cellOf(i)?.row !== first || i.kind === "separator");
    if (rows.size > 0 && header) rows.add(first);
    return block.items.filter((item) => { const cell = cellOf(item); return cell ? rows.has(cell.row) : itemMatches(item, q); });
  }
  let section = false;
  return block.items.filter((item) => {
    if (isHeading(item)) section = itemMatches(item, q);
    return section || itemMatches(item, q);
  });
}

// Whether the list heading an inline block stands under (the last heading before `block.items[at]`)
// matches the search term, so the block belongs to that heading's kept rows.
export function underMatchingHeading(block: CfgBlock, at: number, q: string): boolean {
  if (block.layout) return false;
  for (let i = Math.min(at, block.items.length) - 1; i >= 0; i--) if (isHeading(block.items[i])) return itemMatches(block.items[i], q);
  return false;
}
