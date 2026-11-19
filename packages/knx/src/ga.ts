// Group-address formatting and three-level parsing, kept dependency-free (no Buffer, no node
// built-ins) so it can be imported from the browser bundle via the "@busforge/knx/ga" subpath
// as well as from the node side. This is THE single level-aware GA formatter and the single
// three-level range check, so the 5/3/8-bit math lives in exactly one place shared by the
// parser, the server edit endpoints, the web and the tools.

// A project's group-address style: three-level main(5)/middle(3)/sub(8) "m/n/s", or
// two-level main(5)/sub(11) "m/s". ETS's "Free" style is treated as three-level (its
// default display) and is not modelled separately.
export type Levels = 2 | 3;
export function formatGa(raw: number, levels: Levels): string {
  if (levels === 2) return `${(raw >> 11) & 0x1f}/${raw & 0x7ff}`;
  return `${(raw >> 11) & 0x1f}/${(raw >> 8) & 0x7}/${raw & 0xff}`;
}

// The 16-bit value of a three-level group address, or null where a level is out of range:
// main 0-31, middle 0-7, sub 0-255.
export function gaFromLevels(main: number, mid: number, sub: number): number | null {
  return main >= 0 && main <= 31 && mid >= 0 && mid <= 7 && sub >= 0 && sub <= 255 ? (main << 11) | (mid << 8) | sub : null;
}

// The 16-bit value of `s` when all of it is a three-level group address "main/middle/sub", else null.
export function parseGa(s: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{1,3})$/.exec(s);
  return m ? gaFromLevels(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
