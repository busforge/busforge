import type { CfgBlock, CfgItem } from "../api.ts";

// An ETS inline block (Inline="true") is part of its parent's page: it stands among the parent's
// items at its authored place (CfgBlock.at), not after them as a section of its own.

// The inline blocks each block of `blocks` carries on its page, by parent id, in authored order. An
// inline block whose parent is not in `blocks` (a filter dropped it) is not listed: it stands alone.
export function inlineChildren(blocks: CfgBlock[]): Map<string, CfgBlock[]> {
  const ids = new Set(blocks.map((b) => b.id));
  const out = new Map<string, CfgBlock[]>();
  for (const b of blocks) {
    if (!b.inline || !b.parentId || !ids.has(b.parentId)) continue;
    (out.get(b.parentId) ?? out.set(b.parentId, []).get(b.parentId)!).push(b);
  }
  for (const kids of out.values()) kids.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return out;
}

export type FlowPart = { kind: "items"; items: CfgItem[]; from: number } | { kind: "inline"; block: CfgBlock };

// A page's items with its inline blocks placed between them. `from` is the index of the run's first
// item in `items`. An inline block without a place (its parent is no block) follows the items.
export function flowOf(items: CfgItem[], inline: CfgBlock[]): FlowPart[] {
  const parts: FlowPart[] = [];
  let i = 0;
  const run = (end: number) => {
    if (end > i) parts.push({ kind: "items", items: items.slice(i, end), from: i });
    i = Math.max(i, end);
  };
  for (const b of inline) {
    run(Math.min(b.at ?? items.length, items.length));
    parts.push({ kind: "inline", block: b });
  }
  run(items.length);
  return parts;
}

// Where an inline block placed before `original[at]` stands once only `kept` (a subset of `original`,
// same objects, same order) is shown: before the first kept item that followed it.
export function keptAt(original: CfgItem[], kept: CfgItem[], at: number): number {
  const shown = new Set(kept);
  let n = 0;
  for (let i = 0; i < Math.min(at, original.length); i++) if (shown.has(original[i])) n++;
  return n;
}
