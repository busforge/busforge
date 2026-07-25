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
//      writes past the end of its own heap array. So the table must cover every object the firmware
//      can address, which is the highest com-object number the application DECLARES (across every
//      choose branch and module instance), NOT merely the highest number the current configuration
//      activates. Sizing it to the active maximum was hardware-fatal: the OpenKNX RaumController
//      declares objects up to 1359 and its modules address them by fixed number, so a table claiming
//      only 138 (the highest active object of a near-default config) sent the firmware off the end of
//      its group-object array on boot, and the device death-looped and reverted to factory. ETS sizes
//      to 1359. The declared maximum comes from buildDeviceConfig (maxComObjectNumber).
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

// Build the whole table. The ENTRIES come from the com-objects the active configuration reaches
// (the same `imageComObjects` projection the staleness gate compares, so what we WRITE and what we
// CHECK can never drift apart); every other slot, including objects the configuration does not
// reach, stays 0x0000.
//
// The LENGTH is `declaredCount`, the highest com-object number the application declares (from
// buildDeviceConfig.maxComObjectNumber), NOT the highest active number: entry i is object i, and the
// firmware indexes the table by fixed object number with no bounds check, so it must be as long as
// the firmware's own group-object array (see the header note). `declaredCount` is always >= the
// highest active number (active objects are a subset of declared), but we Math.max defensively so a
// malformed count can never truncate an active entry.
//
// `linked` is the set of com-object numbers that carry a group-address link (the same objects the
// association table connects). ETS clears the Communication flag on every object WITHOUT a link: an
// object with no association cannot communicate, so the flag would be meaningless, and ETS leaves it
// off. We match that byte for byte (hardware-verified against the ETS-programmed RaumController: the
// only difference from ETS was this flag on the unlinked objects; clearing it made the table
// identical). The object stays fully present (its size and every other flag), it just does not
// advertise communication. All other flags come straight from the resolved declaration.
export function buildComObjectTable(active: Map<number, CfgComObjImage>, declaredCount: number, linked: ReadonlySet<number>): Buffer {
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
  const count = Math.max(declaredCount, ...active.keys()); // never shorter than the highest active entry
  const buf = Buffer.alloc(2 + count * 2); // gaps stay 0x0000: an object that does not communicate
  buf.writeUInt16BE(count, 0);
  for (const [number, obj] of active) {
    // Clear Communication on an object with no group-address link, exactly as ETS does.
    const entry = linked.has(number) ? obj : { ...obj, flags: { ...obj.flags, comm: false } };
    comObjectEntry(entry).copy(buf, 2 + (number - 1) * 2);
  }
  return buf;
}

// Author the com-object table (L3) for a property-mapped System 7 device (mask MV-0705).
//
// UNLIKE System B, MV-0705 does not rebuild L3 from scratch. The app program's <ComObjectTable>
// AbsoluteSegment carries a base64 <Data> blob that is the manufacturer's COMPLETE static image of
// L3 (header, and every entry's data pointer, type and a template config byte). ETS writes that
// image, then overlays only the dynamic state per entry. So this takes the template and changes only
// the config byte (and, for configured objects, the type byte from the resolved size). Reverse-
// engineered in docs/device-memory-model.md and byte-verified against two ETS full-download captures
// of an MDT BE-02001.02 (docs/commissioning.md).
//
// LAYOUT (mask MV-0705): [count: u8][ramEnd: u16 BE] then one 4-byte entry per com-object, entry i is
// com-object i (0-based, so entry 0 is a real object, not the count): [dataPtr: u16 BE][config: u8][type: u8].
//   config byte: bits0-1 priority | 0x04 linked | 0x08 read | 0x10 write | 0x40 transmit | 0x80 unconfigured.
//   (No update / readOnInit bit, unlike the System B flags byte.) type is the same KNX size code as
//   the System B entry (sizeCodeForBits): 1 bit -> 0x00, 4 bit -> 0x03, 1 byte -> 0x07, 2 bytes -> 0x08.
//
//   - Configured objects (the ones the active configuration reaches, `active` = imageComObjects):
//     config = priority | linked | read | write | transmit from the resolved flags, 0x80 cleared;
//     type rewritten from the resolved object size. `linked` = the object carries a group-address link.
//   - Unconfigured objects (every other entry): keep the template entry verbatim, only clear the
//     linked bit (a stale linked bit in the manufacturer template must not survive).
export function buildComObjectTableMv0705(template: Buffer, active: Map<number, CfgComObjImage>, linked: ReadonlySet<number>): Buffer {
  if (template.length < 3) {
    throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID",
      `the MV-0705 com-object table template is ${template.length} B; too short to hold even the 3-byte header, refusing to author L3 from it`);
  }
  const out = Buffer.from(template); // preserve header, data pointers, and inactive entries verbatim
  const count = out[0];
  // Every configured or linked object must fall inside the template's declared entry count. An object
  // numbered >= count gets no L3 entry here, yet buildGroupTablesMv0705 would still emit its
  // association, pointing a group address past the device's L3 array (the death-loop class System B's
  // buildComObjectTable guards against). Refuse rather than author a table that silently omits it.
  // This also pins the 0-based number -> slot mapping below (`active.get(n)` / `linked.has(n)`): entry n
  // is com-object n, reverse-engineered and byte-verified on the MDT BE-02001.02. A manufacturer that
  // numbered its MV-0705 objects from 1 would trip this guard or shift the whole table by one slot, so
  // any non-MDT MV-0705 product is UNPROVEN until byte-checked on it (docs/commissioning.md).
  const beyond = [...active.keys(), ...linked].filter((n) => n >= count);
  if (beyond.length) {
    throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID",
      `communication object #${Math.max(...beyond)} is beyond the ${count}-entry MV-0705 template; refusing to author an L3 that omits it while its association would still be written`);
  }
  for (let n = 0; n < count; n++) {
    const cfgOff = 3 + n * 4 + 2; // header 3 B, entry 4 B, config is the 3rd byte, type the 4th
    if (cfgOff + 1 >= out.length) {
      throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID",
        `the MV-0705 com-object table template declares ${count} entries but is only ${out.length} B; refusing to author a truncated L3`);
    }
    const obj = active.get(n);
    if (!obj) { out[cfgOff] &= ~0x04; continue; } // unconfigured: template, minus any stale linked bit
    const bits = objectSizeInBits(obj.objectSize);
    const code = bits === undefined ? undefined : sizeCodeForBits(bits);
    if (code === undefined) {
      throw new ProductError("COM_OBJECT_SIZE_UNKNOWN",
        `communication object #${n} declares the size "${obj.objectSize}", which Busforge cannot express as a KNX value field type; refusing to write an L3 entry with a guessed size`);
    }
    const f = obj.flags;
    out[cfgOff] =
      PRIORITY_BITS[obj.priority] | (linked.has(n) ? 0x04 : 0) |
      (f.read ? 0x08 : 0) | (f.write ? 0x10 : 0) | (f.transmit ? 0x40 : 0); // 0x80 (unconfigured) dropped
    out[cfgOff + 1] = code;
  }
  return out;
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
