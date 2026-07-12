// Authoring the com-object table (L3) for System B.
//
// This is the table a device consults for EVERY group telegram: it says which com-objects exist,
// what each one's datapoint size is, and which of the KNX flags (communication, read, write,
// transmit, update, read-on-init) and which priority it has. Get a byte wrong and the device does
// not fail loudly, it mis-communicates: an object goes deaf, or answers a read it should not, or
// interprets a 2-byte float as a 1-byte scale. The firmware performs NO validation on this table
// (see below), so there is no safety net between this code and a misbehaving device.
//
// WHY WE CAN BUILD IT AT ALL. For proprietary devices the layout had to be reverse-engineered and
// is still only partly understood (docs/device-memory-model.md, MV-0705). OpenKNX devices run the
// OPEN thelsing/knx stack, so the layout is not a guess, it is read off the firmware that consumes
// it. Two independent implementations agree bit for bit:
//
//   thelsing/knx  group_object_table_object.cpp  initGroupObjects(): uint16_t goCount = ntohs(_tableData[0])
//   thelsing/knx  group_object.cpp               responseUpdateEnable() = bit 15 of ntohs(_tableData[_asap]) ...
//   Kaenx         ProgApplication.cs             GenerateComObjectTable(): flags |= (1 << 7) for Update ...
//
// LAYOUT (mask MV-07B0):
//   [count: u16 BE][entry x count], entry = [flags: u8][sizeCode: u8], entry i is com-object i (1-based)
//   flags: bit7 Update | bit6 Transmit | bit5 ReadOnInit | bit4 Write | bit3 Read | bit2 Communication
//          bits1..0 priority (00 System, 01 Normal, 10 Urgent, 11 Low)
//   An all-zero entry is an object that does not communicate: that is how gaps in the numbering,
//   and objects the active configuration does not reach, are represented.
//
// TWO THINGS THE FIRMWARE WILL NOT PROTECT YOU FROM, both deliberate choices here:
//
//   1. `TableObject::loadEvent` accepts whatever bytes it is given. LoadCompleted does not check a
//      length, a checksum or an id. A wrong table is simply believed.
//   2. `knx_facade.h getGroupObject(goNr)` indexes the table with NO bounds check. If the table is
//      shorter than the highest com-object number the firmware actually uses, the device reads and
//      writes past the end of its own heap array. So the table must cover every object the running
//      configuration can address, which is why the count is the highest ACTIVE object number and
//      not merely the number of objects that carry a group address.
import type { AppConfig, ComObjPriority } from "./appconfig.ts";
import type { CfgComObjImage } from "./config.ts";
import { ProductError } from "./errors.ts";

// KNX "value field type" codes (KNX spec 3.5.1, "Value Field Types"), the inverse of the
// firmware's asapValueSize(). Sub-byte sizes are 0..6; byte sizes are NOT a simple offset, the
// table is genuinely irregular (5 bytes is code 15, not 11), which is exactly why it is written
// out rather than computed.
const SIZE_CODE_BY_BITS = new Map<number, number>([
  [1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6],   // 1..7 bits
  [1 * 8, 7], [2 * 8, 8], [3 * 8, 9], [4 * 8, 10],
  [6 * 8, 11], [8 * 8, 12], [10 * 8, 13], [14 * 8, 14],
  [5 * 8, 15], [7 * 8, 16], [9 * 8, 17], [11 * 8, 18], [12 * 8, 19], [13 * 8, 20],
]);
const sizeCodeForBits = (bits: number): number | undefined => {
  const known = SIZE_CODE_BY_BITS.get(bits);
  if (known !== undefined) return known;
  // 15..248 bytes run contiguously from code 21.
  if (bits % 8 === 0 && bits / 8 >= 15 && bits / 8 <= 248) return bits / 8 + 6;
  return undefined;
};

// ETS writes an object's size as a human string ("1 Bit", "2 Bytes", "14 Bytes"). It is the
// authoritative source: in the OpenKNX RaumController 451 of 1255 com-objects carry NO datapoint
// type at all, so deriving the size from the DPT (as Kaenx does) would lose them.
export function objectSizeInBits(objectSize: string): number | undefined {
  const m = /^\s*(\d+)\s+(Bit|Bits|Byte|Bytes)\s*$/i.exec(objectSize);
  if (!m) return undefined;
  const n = Number(m[1]);
  return /^bit/i.test(m[2]) ? n : n * 8;
}

// The two priority bits are the KNX telegram priority classes, encoded exactly as in a frame's
// control byte: 00 system, 01 normal, 10 urgent, 11 low (thelsing/knx knx_types.h Priority, whose
// values 0x0/0x4/0x8/0xC are those bit patterns shifted). ETS names the three an application may
// choose Low, High and Alert, which maps onto them by rank: Low is the lowest class, High the
// ordinary one above it, Alert the urgent one. System is reserved for the stack and no application
// selects it.
//
// Worth knowing when this is next touched: NOTHING in the corpus exercises High or Alert. Every
// com-object in all 13 catalogue fixtures and in the OpenKNX RaumController declares Low (or
// nothing, which means Low). So the first device that uses one is also the device that proves this
// mapping; a wrong priority costs bus arbitration order, not data.
const PRIORITY_BITS: Record<ComObjPriority, number> = { Alert: 0b10, High: 0b01, Low: 0b11 };

// One entry's two bytes. Exported for the tests, which pin the bit positions against the firmware.
export function comObjectEntry(obj: CfgComObjImage): Buffer {
  const bits = objectSizeInBits(obj.objectSize);
  if (bits === undefined) {
    throw new ProductError("COM_OBJECT_SIZE_UNKNOWN",
      `communication object #${obj.number} declares the size "${obj.objectSize}", which Busforge cannot express as a KNX value field type; refusing to write a com-object table with a guessed size`);
  }
  const code = sizeCodeForBits(bits);
  if (code === undefined) {
    throw new ProductError("COM_OBJECT_SIZE_UNKNOWN",
      `communication object #${obj.number} is ${bits} bits, which is not a KNX value field type; refusing to guess`);
  }
  const f = obj.flags;
  const flags =
    (f.update ? 1 << 7 : 0) | (f.transmit ? 1 << 6 : 0) | (f.readOnInit ? 1 << 5 : 0) |
    (f.write ? 1 << 4 : 0) | (f.read ? 1 << 3 : 0) | (f.comm ? 1 << 2 : 0) |
    PRIORITY_BITS[obj.priority];
  return Buffer.from([flags, code]);
}

// Build the whole table from the com-objects the active configuration reaches (the same
// `imageComObjects` projection the staleness gate compares, so what we WRITE and what we CHECK can
// never drift apart).
//
// The count is the highest active object NUMBER, not the number of active objects: entry i is
// object i, so a configuration whose objects are 1, 4 and 137 needs 137 entries with the gaps
// zeroed. This mirrors ETS and Kaenx, and it is what keeps the firmware's unchecked
// getGroupObject(n) inside the array.
export function buildComObjectTable(active: Map<number, CfgComObjImage>): Buffer {
  // Object numbers are 1-based because entry 0 of the table IS the count. An object that resolved
  // to 0 therefore cannot be represented at all: dropping it would leave the association table
  // pointing a group address at the count field, and the download would still verify green,
  // because it compares the device against this very table. Refuse.
  const zero = [...active.values()].find((o) => o.number < 1);
  if (zero) {
    throw new ProductError("COM_OBJECT_NUMBER_INVALID",
      `communication object ${zero.refId} resolves to number ${zero.number}; com-object numbers are 1-based (entry 0 of the table is its count), so this cannot be programmed`);
  }
  if (active.size === 0) {
    throw new ProductError("COM_OBJECT_TABLE_EMPTY",
      "this configuration activates no communication objects, so the device would have nothing to talk with; refusing to write an empty com-object table");
  }
  const count = Math.max(...active.keys());
  const buf = Buffer.alloc(2 + count * 2); // gaps stay 0x0000: an object that does not communicate
  buf.writeUInt16BE(count, 0);
  for (const [number, obj] of active) comObjectEntry(obj).copy(buf, 2 + (number - 1) * 2);
  return buf;
}

// The application's identity stamp (PID_PROGRAM_ID, property 13 of the application object): the
// manufacturer, application number and version the device is being programmed with. A device that
// is later asked to accept a parameter-only download compares against this, which is how it
// notices it is holding a different application than the one being flashed.
export function programIdStamp(app: AppConfig): Buffer {
  const manufacturer = Number.parseInt(String(app.id).split("_")[0].replace("M-", ""), 16);
  return Buffer.from([
    (manufacturer >> 8) & 0xff, manufacturer & 0xff,
    (app.appNumber >> 8) & 0xff, app.appNumber & 0xff,
    app.appVersion & 0xff,
  ]);
}
