import type { CfgBlock, CfgCell, CfgItem } from "../api.ts";

// How an ETS Grid/Table ParameterBlock (Layout=) is laid out. ETS places a grid's items by
// Cell="row,column" in the geometry its <Rows>/<Columns> declare.

// Where an item sits in its grid; com-objects and unsupported elements never have a cell.
export const cellOf = (item: CfgItem): CfgCell | undefined => (item.kind === "comObject" || item.kind === "unsupported" ? undefined : item.cell);

export interface GridLayout {
  // The items of each cell, keyed "row,col" (authored numbering), in authored order.
  cells: Map<string, CfgItem[]>;
  // The items without a cell (com-objects, an item whose Cell could not be read): they follow the grid.
  loose: CfgItem[];
  // The rendered grid row and column of each authored row and column that is shown (1-based, before a
  // Table's caption row and column).
  row: Map<number, number>;
  col: Map<number, number>;
  // The CSS grid-template-columns, a Table's caption column first.
  template: string;
}

// The layout of `shown`, the items of `configured` (the block as the configuration shows it) that are on
// screen (the same items when nothing is filtered).
// - Several items can land in one cell (two active choose branches), so a cell holds a list and drops
//   none, except a separator repeating one the cell already holds: ETS draws the items of one cell on top
//   of each other, so two identical labels read as one.
// - The columns come from `configured`, so a search does not move them. A column no item (and, in a
//   Table, no caption) occupies is left out: a choose that shows a few of many authored columns would
//   otherwise leave a gap per empty column and squeeze the rest.
// - The rows are those `shown` occupies, and while `shown` holds the configured items themselves (no
//   filter, or a filter that matched the whole block) a Table's captioned rows too.
// - ETS authors widths as percentages; OpenKNX calibration grids declare over 200 %, so shown columns
//   that add up to more than 100 % share the width in that proportion, and less leaves the rest free.
//   A column is never narrower than its content: a label breaks only between words, a control keeps the
//   minimum width it asks for, and a grid that does not fit scrolls in its box.
export function gridLayout(shown: CfgBlock, configured: CfgBlock): GridLayout {
  const { cells, loose } = gridCells(shown);
  const table = shown.layout === "Table";
  const cols = new Set<number>();
  for (const item of configured.items) { const cell = cellOf(item); if (cell) cols.add(cell.col); }
  if (table) configured.cols?.forEach((c, i) => { if (c.text) cols.add(i + 1); });
  const rows = new Set<number>();
  for (const item of shown.items) { const cell = cellOf(item); if (cell) rows.add(cell.row); }
  if (table && shown.items === configured.items) configured.rows?.forEach((r, i) => { if (r.text) rows.add(i + 1); });
  const colOrder = [...cols].sort((a, b) => a - b);
  const widths = colOrder.map((c) => width(configured.cols?.[c - 1]?.width));
  const pct = widths.reduce((n, w) => n + (w.pct ?? 0), 0);
  const tracks = widths.map((w) => `minmax(min-content, ${w.pct !== undefined ? `${w.pct}fr` : w.track})`);
  // What the shown percentages leave of the width stays free, as in ETS.
  if (pct > 0 && pct < 100) tracks.push(`minmax(0px, ${100 - pct}fr)`);
  return {
    cells, loose,
    row: numbering(rows), col: numbering(cols),
    template: [...(table ? ["auto"] : []), ...tracks].join(" "),
  };
}

function gridCells(block: CfgBlock): Pick<GridLayout, "cells" | "loose"> {
  const cells = new Map<string, CfgItem[]>();
  const loose: CfgItem[] = [];
  for (const item of block.items) {
    const cell = cellOf(item);
    if (!cell) { loose.push(item); continue; }
    const key = `${cell.row},${cell.col}`;
    const at = cells.get(key);
    if (!at) { cells.set(key, [item]); continue; }
    if (item.kind === "separator" && at.some((o) => o.kind === "separator" && o.text === item.text && o.uiHint === item.uiHint)) continue;
    at.push(item);
  }
  return { cells, loose };
}

const numbering = (lines: Set<number>) => new Map([...lines].sort((a, b) => a - b).map((n, i) => [n, i + 1]));

// An authored column width: a percentage, or a track maximum. Anything that is not a plain length would
// invalidate the whole grid-template-columns declaration and collapse the block, so it becomes auto.
function width(w?: string): { pct?: number; track: string } {
  const pct = w?.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return { pct: Number(pct[1]), track: "" };
  return { track: w && /^\d+(\.\d+)?(px|rem|em)$/.test(w) ? w : "auto" };
}
