// Group-address formatting, kept dependency-free (no Buffer, no node built-ins) so it can
// be imported from the browser bundle via the "@busforge/knx/ga" subpath as well as from
// the node side. This is THE single level-aware GA formatter, so the 5/3/8-bit math lives
// in exactly one place shared by the parser, the server edit endpoints, and the web.

// A project's group-address style: three-level main(5)/middle(3)/sub(8) "m/n/s", or
// two-level main(5)/sub(11) "m/s". ETS's "Free" style is treated as three-level (its
// default display) and is not modelled separately.
export type Levels = 2 | 3;
export function formatGa(raw: number, levels: Levels): string {
  if (levels === 2) return `${(raw >> 11) & 0x1f}/${raw & 0x7ff}`;
  return `${(raw >> 11) & 0x1f}/${(raw >> 8) & 0x7}/${raw & 0xff}`;
}
