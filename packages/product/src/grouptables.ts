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

// Read a device's links back out of its group tables. Inverse of
// buildGroupTables: resolve each association's 1-based group index through the
// address table to a GA, then group by com-object number. The caller normalizes
// the long/short association format before passing it in (see readGroupTables).
// gaRaws are sorted ascending so the result is stable regardless of table order.
export function decodeGroupTables(addr: Buffer, assoc: Buffer, longForm: boolean): ComObjectLink[] {
  const gcount = addr.readUInt16BE(0);
  const gas: number[] = [];
  for (let i = 0; i < gcount; i++) gas.push(addr.readUInt16BE(2 + i * 2));

  const acount = assoc.readUInt16BE(0);
  const width = longForm ? 4 : 2;
  const byCo = new Map<number, number[]>();
  for (let k = 0; k < acount; k++) {
    const off = 2 + k * width;
    // Long form: [groupIdx:2][comObjNum:2]. Short form: [groupIdx:1][comObjNum:1].
    const gi = longForm ? assoc.readUInt16BE(off) : assoc[off];
    const co = longForm ? assoc.readUInt16BE(off + 2) : assoc[off + 1];
    if (gi < 1 || gi > gas.length) continue; // unused/invalid entry
    const list = byCo.get(co) ?? [];
    list.push(gas[gi - 1]);
    byCo.set(co, list);
  }
  return [...byCo.entries()].map(([comObjNum, gaRaws]) => ({ comObjNum, gaRaws: gaRaws.sort((a, b) => a - b) }));
}
