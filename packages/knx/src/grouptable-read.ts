import { KnxDevice } from "./device.ts";

// On-device group-table READERS plus the byte-layout facts they share with the
// builders/decoders in @busforge/product (grouptables.ts). The layouts exist in exactly
// two hardware-verified shapes; keeping them as named descriptors here (and asserting
// the product codec against them in grouptables.test.ts) is what ties the read, build,
// decode and write sites to ONE source of truth instead of four hand-synced copies.
//
//   System B (MV-07B0): count is 2 bytes BE; address entries 2 bytes; association
//     entries 4 bytes (long form: [groupIdx:2][comObjNum:2]) or 2 bytes (short form:
//     [groupIdx:1][comObjNum:1]) - detected per device, see readGroupTables.
//   System 7 (MV-0705): count is 1 byte; address and association entries 2 bytes
//     (address table leads with the device's own IA; association = [groupIdx:1][comObjNum:1]).
export interface TableLayout { countBytes: 1 | 2; entryBytes: number; }
export const SYSTEM_B_ADDR: TableLayout = { countBytes: 2, entryBytes: 2 };
export const SYSTEM_B_ASSOC_LONG: TableLayout = { countBytes: 2, entryBytes: 4 };
export const SYSTEM_B_ASSOC_SHORT: TableLayout = { countBytes: 2, entryBytes: 2 };
export const MV0705_TABLE: TableLayout = { countBytes: 1, entryBytes: 2 };

// Coded error the server maps to a localized message (duck-typed `code`, like
// KnxprojError/ProductError). Thrown when a device's tables are not in the expected
// format, so the caller refuses instead of decoding garbage.
export class GroupTableUnreadable extends Error {
  readonly code = "GROUP_TABLE_UNREADABLE";
  constructor(message: string) { super(message); this.name = "GroupTableUnreadable"; }
}

// A group/association table starts with a device-supplied entry count; it must be
// bounded before reading count*width bytes. An MV-0705 device whose table pointer lands
// in parameter memory would otherwise decode to thousands of entries and hang.
const MAX_TABLE_ENTRIES = 2048;

const readCount = (h: Buffer, layout: TableLayout) => (layout.countBytes === 2 ? (h[0] << 8) | h[1] : h[0]);

// Read a System B device's group tables (address, association, com-object), detecting
// the long vs short association format. `skipComObj` omits the (largest) com-object table.
export async function readGroupTables(dev: KnxDevice, onStep?: (done: number, total: number) => void, skipComObj = false): Promise<{ addr: Buffer; assoc: Buffer; comObj: Buffer; long: boolean }> {
  const boundCount = (count: number, what: string): number => {
    if (count > MAX_TABLE_ENTRIES) throw new GroupTableUnreadable(`${what} reports ${count} entries (implausible); this device's group tables are not in the expected System B format`);
    return count;
  };
  const counted = async (obj: number, layout: TableLayout) => {
    const base = await dev.tableAddr(obj);
    const h = await dev.memRead(base, layout.countBytes);
    const count = boundCount(readCount(h, layout), `group object ${obj} table`);
    return dev.memRead(base, layout.countBytes + count * layout.entryBytes);
  };
  const total = skipComObj ? 2 : 3;
  const addr = await counted(1, SYSTEM_B_ADDR);
  onStep?.(1, total);
  const gcount = readCount(addr, SYSTEM_B_ADDR);
  const a2 = await dev.tableAddr(2);
  const ah = await dev.memRead(a2, SYSTEM_B_ASSOC_LONG.countBytes);
  const acount = boundCount(readCount(ah, SYSTEM_B_ASSOC_LONG), "association table");
  let assoc = await dev.memRead(a2, SYSTEM_B_ASSOC_LONG.countBytes + acount * SYSTEM_B_ASSOC_LONG.entryBytes);
  // Long/short detection: in the long form every entry's 2-byte group index must be a
  // valid 1-based index into the address table; a short-form table read as long yields
  // out-of-range indices on the first entry that straddles two real entries.
  let long = true;
  for (let k = 0; k < acount; k++) { const gi = (assoc[2 + k * 4] << 8) | assoc[3 + k * 4]; if (gi < 1 || gi > gcount) { long = false; break; } }
  if (!long) assoc = await dev.memRead(a2, SYSTEM_B_ASSOC_SHORT.countBytes + acount * SYSTEM_B_ASSOC_SHORT.entryBytes);
  onStep?.(2, total);
  const comObj = skipComObj ? Buffer.alloc(0) : await counted(3, SYSTEM_B_ADDR);
  if (!skipComObj) onStep?.(3, total);
  return { addr, assoc, comObj, long };
}

// Read an MV-0705 device's address + association tables. Same property-pointer
// addressing as System B, but the count is a SINGLE byte and each entry is 2 bytes.
export async function readGroupTablesMv0705(dev: KnxDevice, onStep?: (done: number, total: number) => void): Promise<{ addr: Buffer; assoc: Buffer }> {
  const readTable = async (obj: number) => {
    const base = await dev.tableAddr(obj);
    const count = (await dev.memRead(base, MV0705_TABLE.countBytes))[0];
    return dev.memRead(base, MV0705_TABLE.countBytes + count * MV0705_TABLE.entryBytes);
  };
  const addr = await readTable(1); onStep?.(1, 2);
  const assoc = await readTable(2); onStep?.(2, 2);
  return { addr, assoc };
}
