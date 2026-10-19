// Build a device's group address tables from its com-object links. Validated
// byte-for-byte against a real device (System B / mask MV-07B0).
//
// LAYOUT AUTHORITY: the count/entry byte widths used here are the same on-device
// layouts the readers in @busforge/knx (grouptable-read.ts) declare as TableLayout
// descriptors (SYSTEM_B_ADDR / SYSTEM_B_ASSOC_LONG / SYSTEM_B_ASSOC_SHORT /
// MV0705_TABLE). grouptables.test.ts asserts this file's arithmetic against those
// descriptors, so a layout change in either place fails the build instead of
// desynchronizing read and write. Layout facts, System B:
// - Address table:     [count:2][GA:2]xN, GAs sorted ascending.
// - Association table:  [count:2][groupIdx:2][comObjNum:2]xN (long form), entries
//   in ETS's order (associations(), below).
//
// The com-object table (flags/size) is NOT built here: it is read from the
// device and written back unchanged, so flashing only re-points which group
// addresses a com-object uses, never its flags.

import { ProductError } from "./errors.ts";

export interface ComObjectLink { comObjNum: number; gaRaws: number[]; }
export interface GroupTables { addr: Buffer; assoc: Buffer; }

// The associations in the order ETS writes them: first each object's first link (first in the project's
// Links) by object number, then every other link by object number and group index. Shown on System 7
// (Gira M-0008, TheLuxa P300, Meteodata 140 S) and System B (Theben MIX 2, Theben DALI-Gateway), contradicted
// by no capture; where every object has one link it is the order by object.
function associations(links: ComObjectLink[], idx: Map<number, number>): { gi: number; co: number }[] {
  const byObject = (a: { gi: number; co: number }, b: { gi: number; co: number }) => a.co - b.co || a.gi - b.gi;
  const all = (from: number) => links.flatMap((l) => l.gaRaws.slice(from).map((g) => ({ gi: idx.get(g)!, co: l.comObjNum })));
  return [...links.filter((l) => l.gaRaws.length > 0).map((l) => ({ gi: idx.get(l.gaRaws[0])!, co: l.comObjNum })).sort(byObject), ...all(1).sort(byObject)];
}

export function buildGroupTables(links: ComObjectLink[]): GroupTables {
  const gas = [...new Set(links.flatMap((l) => l.gaRaws))].sort((a, b) => a - b);
  const idx = new Map(gas.map((g, i) => [g, i + 1])); // 1-based group index

  const addr = Buffer.alloc(2 + gas.length * 2);
  addr.writeUInt16BE(gas.length, 0);
  gas.forEach((g, i) => addr.writeUInt16BE(g, 2 + i * 2));

  const entries = associations(links, idx);
  const assoc = Buffer.alloc(2 + entries.length * 4);
  assoc.writeUInt16BE(entries.length, 0);
  entries.forEach((e, i) => { assoc.writeUInt16BE(e.gi, 2 + i * 4); assoc.writeUInt16BE(e.co, 4 + i * 4); });

  return { addr, assoc };
}

// Build an MV-0705 (System 7) device's group tables from its com-object links. The
// inverse of decodeGroupTablesMv0705, and the System-7 counterpart of buildGroupTables:
//   Address table:     [count:1][own IA:2 BE][GA:2 BE x N]   (count = 1 + N: the IA entry + N GAs)
//   Association table: [count:1][groupIdx:1][comObjNum:1] x M
// `ownIa` is the device's individual address (the first address-table entry). Counts are a
// single byte, so a device with > 254 group addresses or > 255 associations cannot be
// represented; that is far beyond any real TP device but guarded rather than silently wrapped.
export function buildGroupTablesMv0705(links: ComObjectLink[], ownIa: number): GroupTables {
  const gas = [...new Set(links.flatMap((l) => l.gaRaws))].sort((a, b) => a - b);
  const idx = new Map(gas.map((g, i) => [g, i + 1])); // 1-based group index
  const entries = associations(links, idx);
  if (gas.length + 1 > 255 || entries.length > 255) throw new ProductError("GA_TABLE_TOO_LARGE", "MV-0705 group tables exceed the 1-byte count (too many group addresses/associations)");

  const addr = Buffer.alloc(1 + 2 + gas.length * 2);
  addr[0] = 1 + gas.length;
  addr.writeUInt16BE(ownIa & 0xffff, 1);
  gas.forEach((g, i) => addr.writeUInt16BE(g, 3 + i * 2));

  const assoc = Buffer.alloc(1 + entries.length * 2);
  assoc[0] = entries.length;
  entries.forEach((e, i) => { assoc[1 + i * 2] = e.gi; assoc[2 + i * 2] = e.co; });

  return { addr, assoc };
}

// An object's addresses as its association entries list them: the first entry is the address it
// sends on and stays first; the others follow ascending, so the result does not depend on where
// in the table they sit.
const senderFirst = (gaRaws: number[]) => [gaRaws[0], ...gaRaws.slice(1).sort((a, b) => a - b)];

// Read a device's links back out of its group tables. Inverse of
// buildGroupTables: resolve each association's 1-based group index through the
// address table to a GA, then group by com-object number. The caller normalizes
// the long/short association format before passing it in (see readGroupTables).
export function decodeGroupTables(addr: Buffer, assoc: Buffer, longForm: boolean): ComObjectLink[] {
  // The header count comes off the device and is trusted only up to the bytes
  // actually returned: a short or truncated table read (some devices return
  // fewer bytes than requested) must degrade to the readable entries, never read
  // past the buffer and crash the whole read-back.
  const gcount = addr.length >= 2 ? addr.readUInt16BE(0) : 0;
  const gas: number[] = [];
  for (let i = 0; i < gcount && 2 + i * 2 + 2 <= addr.length; i++) gas.push(addr.readUInt16BE(2 + i * 2));

  const acount = assoc.length >= 2 ? assoc.readUInt16BE(0) : 0;
  const width = longForm ? 4 : 2;
  const byCo = new Map<number, number[]>();
  for (let k = 0; k < acount; k++) {
    const off = 2 + k * width;
    if (off + width > assoc.length) break; // truncated table: stop at the last whole entry
    // Long form: [groupIdx:2][comObjNum:2]. Short form: [groupIdx:1][comObjNum:1].
    const gi = longForm ? assoc.readUInt16BE(off) : assoc[off];
    const co = longForm ? assoc.readUInt16BE(off + 2) : assoc[off + 1];
    if (gi < 1 || gi > gas.length) continue; // unused/invalid entry
    const list = byCo.get(co) ?? [];
    list.push(gas[gi - 1]);
    byCo.set(co, list);
  }
  return [...byCo.entries()].map(([comObjNum, gaRaws]) => ({ comObjNum, gaRaws: senderFirst(gaRaws) }));
}

// Decode an MV-0705 (System 7) device's group tables. This mask uses a DIFFERENT layout
// from System B (reverse-engineered byte-for-byte off a real BE-06001.02):
//   Address table:     [count:1][own IA:2 BE][GA:2 BE x (count-1)]  (count includes the IA entry)
//   Association table: [count:1][groupIdx:1][comObjNum:1] x count    (groupIdx 1-based into the GA list)
// The first address-table entry is the device's own individual address, so group index gi
// resolves to the gi-th GA after it. Counts are 1 byte (not the System B 2-byte count), and
// each entry is 2 bytes, so the System B reader misreads the header as a huge count and the
// offsets by one byte. Each object's sending address stays first (senderFirst).
export function decodeGroupTablesMv0705(addr: Buffer, assoc: Buffer): ComObjectLink[] {
  const acount = addr.length >= 1 ? addr[0] : 0; // entries incl. the device IA at index 0
  const gas: number[] = []; // gas[gi] indexed by 1-based group index
  for (let gi = 1; gi < acount && 1 + gi * 2 + 2 <= addr.length; gi++) gas[gi] = addr.readUInt16BE(1 + gi * 2);

  const scount = assoc.length >= 1 ? assoc[0] : 0;
  const byCo = new Map<number, number[]>();
  for (let k = 0; k < scount; k++) {
    const off = 1 + k * 2;
    if (off + 2 > assoc.length) break; // truncated read: stop at the last whole entry
    const gi = assoc[off];
    const co = assoc[off + 1];
    const ga = gas[gi];
    if (ga === undefined) continue; // unused/invalid group index
    const list = byCo.get(co) ?? [];
    list.push(ga);
    byCo.set(co, list);
  }
  return [...byCo.entries()].map(([comObjNum, gaRaws]) => ({ comObjNum, gaRaws: senderFirst(gaRaws) }));
}
