import type { CfgBlock, CfgItem } from "../api.ts";

// How an ETS Grid/Table ParameterBlock (Layout=) is laid out, and what the parameter filter keeps of a
// block. ETS places a grid's items by Cell="row,column" in the geometry its <Rows>/<Columns> declare.

const placed = (item: CfgItem) => (item.kind === "comObject" || item.kind === "unsupported" ? undefined : item.cell);

export interface GridCells {
  // The items of each cell, keyed "row,col" (authored numbering), in authored order.
  cells: Map<string, CfgItem[]>;
  // The items without a cell (com-objects, an item whose Cell could not be read): they follow the grid.
  loose: CfgItem[];
}

// The cells of a grid block. Several items can land in one cell (two active choose branches), so a cell
// holds a list and drops none, except a separator repeating one the cell already holds: ETS draws the
// items of one cell on top of each other, so two identical labels read as one.
export function gridCells(block: CfgBlock): GridCells {
  const cells = new Map<string, CfgItem[]>();
  const loose: CfgItem[] = [];
  for (const item of block.items) {
    const cell = placed(item);
    if (!cell) { loose.push(item); continue; }
    const key = `${cell.row},${cell.col}`;
    const at = cells.get(key);
    if (!at) { cells.set(key, [item]); continue; }
    if (item.kind === "separator" && at.some((o) => o.kind === "separator" && o.text === item.text && o.uiHint === item.uiHint)) continue;
    at.push(item);
  }
  return { cells, loose };
}

export interface GridColumns {
  // The rendered grid column of each authored column that is shown (1-based, before a Table's caption column).
  col: Map<number, number>;
  // The CSS grid-template-columns of the shown columns, a Table's caption column first.
  template: string;
}

// The columns a grid block shows and how wide each one is, from the cells of the block as configured
// (unfiltered, so a search does not move the columns). A column no item (and, in a Table, no caption)
// occupies is left out: a choose that shows a few of many authored columns would otherwise
// leave a gap per empty column and squeeze the rest. ETS authors widths as percentages that need not add
// up to 100 (OpenKNX calibration grids declare over 200 %), so a percentage is the column's share of the
// free width. A column is never narrower than its content: a label breaks between words, never inside
// one, and a control keeps the minimum width it asks for; a grid that does not fit scrolls in its box.
export function gridColumns(block: CfgBlock, cells: Map<string, CfgItem[]>): GridColumns {
  const used = new Set<number>();
  for (const key of cells.keys()) used.add(Number(key.split(",")[1]));
  if (block.layout === "Table") block.cols?.forEach((c, i) => { if (c.text) used.add(i + 1); });
  const order = [...used].sort((a, b) => a - b);
  const col = new Map(order.map((c, i) => [c, i + 1]));
  const tracks = order.map((c) => `minmax(min-content, ${share(block.cols?.[c - 1]?.width)})`);
  return { col, template: [...(block.layout === "Table" ? ["auto"] : []), ...tracks].join(" ") };
}

// An authored column width as a track's maximum. Anything that is not a plain length would invalidate
// the whole grid-template-columns declaration and collapse the block, so it becomes an auto track.
function share(w?: string): string {
  const pct = w?.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return `${pct[1]}fr`;
  return w && /^\d+(\.\d+)?(px|rem|em)$/.test(w) ? w : "auto";
}

const norm = (s?: string) => (s ?? "").toLowerCase();

// Whether an item matches the search term: a parameter by its text or value, a com-object by its
// function or name, a separator or a button by its label.
export function itemMatches(item: CfgItem, q: string): boolean {
  if (!q) return false;
  switch (item.kind) {
    case "param": return norm(item.param.name).includes(q) || norm(item.param.value).includes(q);
    case "comObject": return norm(item.comObject.functionText || item.comObject.name).includes(q) || norm(item.comObject.name).includes(q);
    case "separator": return norm(item.text).includes(q);
    case "button": return norm(item.button.text).includes(q);
    case "unsupported": return false;
  }
}

// The items of `block` the search term keeps, the same objects in authored order. In a grid a match
// keeps its whole row, so a value stands next to its label and a label next to its values; a match on a
// Table's column caption keeps the whole table. In a list a matching text separator keeps the rows
// below it, up to the next one; any other row is kept when it matches itself.
export function matchingItems(block: CfgBlock, q: string): CfgItem[] {
  if (!q) return [];
  if (block.layout) {
    if (block.layout === "Table" && block.cols?.some((c) => norm(c.text).includes(q))) return block.items;
    const rows = new Set<number>();
    block.rows?.forEach((r, i) => { if (block.layout === "Table" && norm(r.text).includes(q)) rows.add(i + 1); });
    for (const item of block.items) { const cell = placed(item); if (cell && itemMatches(item, q)) rows.add(cell.row); }
    return block.items.filter((item) => { const cell = placed(item); return cell ? rows.has(cell.row) : itemMatches(item, q); });
  }
  let section = false;
  return block.items.filter((item) => {
    if (item.kind === "separator" && item.text && item.uiHint !== "HorizontalRuler") section = itemMatches(item, q);
    return section || itemMatches(item, q);
  });
}
