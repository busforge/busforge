// Build a device's group address tables from its com-object links. Validated
// byte-for-byte against a real device (System B / mask MV-07B0):
// - Address table:     [count:2][GA:2]xN, GAs sorted ascending.
// - Association table:  [count:2][groupIdx:2][comObjNum:2]xN (long form), entries
//   ordered by com-object number then group index.
//
// The com-object table (flags/size) is NOT built here: it is read from the
// device and written back unchanged, so flashing only re-points which group
// addresses a com-object uses, never its flags.

export interface ComObjectLink { comObjNum: number; gaRaws: number[]; }
export interface GroupTables { addr: Buffer; assoc: Buffer; }

export function buildGroupTables(links: ComObjectLink[]): GroupTables {
  const gas = [...new Set(links.flatMap((l) => l.gaRaws))].sort((a, b) => a - b);
  const idx = new Map(gas.map((g, i) => [g, i + 1])); // 1-based group index

  const addr = Buffer.alloc(2 + gas.length * 2);
  addr.writeUInt16BE(gas.length, 0);
  gas.forEach((g, i) => addr.writeUInt16BE(g, 2 + i * 2));

  const entries = links
    .flatMap((l) => l.gaRaws.map((g) => ({ gi: idx.get(g)!, co: l.comObjNum })))
    .sort((a, b) => a.co - b.co || a.gi - b.gi);
  const assoc = Buffer.alloc(2 + entries.length * 4);
  assoc.writeUInt16BE(entries.length, 0);
  entries.forEach((e, i) => { assoc.writeUInt16BE(e.gi, 2 + i * 4); assoc.writeUInt16BE(e.co, 4 + i * 4); });

  return { addr, assoc };
}
