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
import type { AppConfig, ComObjFlags, ComObjPriority } from "./appconfig.ts";
import type { CfgComObjImage, DeviceConfigBuild } from "./config.ts";
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
  // A configuration may activate no object at all (every channel disabled): ETS then writes the
  // declared count with every entry 0x0000 (GVS AMMA capture), and so does this. Only an
  // application that declares no object has no table to write.
  if (active.size === 0 && declaredCount < 1) {
    throw new ProductError("COM_OBJECT_TABLE_EMPTY",
      "this application declares no communication objects, so there is no com-object table to write; refusing to write an empty one");
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
//   config byte: bits0-1 priority | 0x04 linked and communication on | 0x08 read | 0x10 write | 0x40 transmit | 0x80 update.
//   (No readOnInit bit, unlike the System B flags byte.) type is the same KNX size code as the
//   System B entry (sizeCodeForBits): 1 bit -> 0x00, 4 bit -> 0x03, 1 byte -> 0x07, 2 bytes -> 0x08.
//
//   - Configured objects (the ones the active configuration reaches, `active` = imageComObjects):
//     config = priority | linked | read | write | transmit | update (0x80) from the resolved flags, as
//     ETS writes them (TheLuxa P300 object 116 0xCB, Meteodata 140 S objects 9 0x97 and 13 0xCF, MDT
//     BE-06001.02 objects 36/39 0xD3 for UpdateFlag="Enabled"); type rewritten from the resolved object
//     size. `linked` = the object carries a group-address link; its 0x04 bit is set only where its
//     communication flag is on too (captures/mdt-be02001-ets-partial-flag-comm-{off,on}.log: ETS keeps
//     the association of a linked object with communication off and clears the bit).
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
      PRIORITY_BITS[obj.priority] | (linked.has(n) && f.comm ? 0x04 : 0) |
      (f.read ? 0x08 : 0) | (f.write ? 0x10 : 0) | (f.transmit ? 0x40 : 0) | (f.update ? 0x80 : 0);
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

// Group-address flash on System 7: the com-object table the device holds, with only the linked bit
// (config 0x04) following `linked` (linkedBitObjects), set on those objects and cleared on the rest. ETS rewrites L3
// on a group-address download on both LSM styles (partial-download captures: the whole table on
// the MDT BE-02001.02, only the two changed config bytes on the ABB US/U 4.2); on a device holding a
// correct table both equal this. `authored`: the objects whose flags or priority the project changed
// since the device was last written, with the flags it gives them; their read, write, transmit and
// update bits and their priority are written as the project gives them, as ETS's group-address
// download writes a flag change (captures/mdt-be02001-ets-partial-flag-{read,update}-{off,on}.log).
// Every other byte stays as the device holds it. Layout as in buildComObjectTableMv0705.
export function withLinkedCommFlags(deviceTable: Buffer, linked: ReadonlySet<number>, authored?: ReadonlyMap<number, CfgComObjImage>): Buffer {
  if (deviceTable.length < 3) throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID", `the com-object table is ${deviceTable.length} B; too short to hold its 3-byte header`);
  const out = Buffer.from(deviceTable);
  const count = out[0];
  if (3 + count * 4 > out.length) throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID", `the com-object table declares ${count} entries but is only ${out.length} B`);
  const beyond = [...linked].filter((n) => n >= count);
  if (beyond.length) throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID", `communication object #${Math.max(...beyond)} is beyond the ${count}-entry com-object table; refusing to link it`);
  const beyondAuthored = [...(authored?.keys() ?? [])].filter((n) => n >= count);
  if (beyondAuthored.length) throw new ProductError("COM_OBJECT_TABLE_TEMPLATE_INVALID", `communication object #${Math.max(...beyondAuthored)} is beyond the ${count}-entry com-object table; refusing to write its flags`);
  for (let n = 0; n < count; n++) {
    const at = 3 + n * 4 + 2;
    const obj = authored?.get(n);
    if (obj) {
      const f = obj.flags;
      out[at] = (out[at] & ~(0x03 | 0x08 | 0x10 | 0x40 | 0x80)) | PRIORITY_BITS[obj.priority] | (f.read ? 0x08 : 0) | (f.write ? 0x10 : 0) | (f.transmit ? 0x40 : 0) | (f.update ? 0x80 : 0);
    }
    if (linked.has(n)) out[at] |= 0x04;
    else out[at] &= ~0x04;
  }
  return out;
}

// The objects whose System 7 linked bit (config 0x04) is set: the linked ones whose communication flag
// is on as `objects` give it (the project's flags over the application's). ETS clears the bit on a
// linked object with communication off and keeps its association
// (captures/mdt-be02001-ets-partial-flag-comm-{off,on}.log).
export function linkedBitObjects(linked: ReadonlySet<number>, objects: ReadonlyMap<number, CfgComObjImage>): Set<number> {
  return new Set([...linked].filter((n) => objects.get(n)?.flags.comm !== false));
}

// ── A device's own com-object flags (project level) ─────────────────────────
//
// ETS lets the project set an object's flags and priority per device, over what the application
// declares, and stores them on the device's ComObjectInstanceRef (ReadFlag, WriteFlag,
// CommunicationFlag, TransmitFlag, UpdateFlag, ReadOnInitFlag as "Enabled"/"Disabled", Priority as
// Low/High/Alert). Its download writes them into the com-object table: on a Gira M-0008 unit object
// 64's config byte is 0x4f where the application's flags give 0x47 (read flag set,
// captures/gira-m0008-ets-partial-revert.log). An absent attribute leaves the application's value.
export interface ComObjInstanceOverride { flags: Partial<ComObjFlags>; priority?: ComObjPriority }

const OVERRIDE_FLAGS: [string, keyof ComObjFlags][] = [
  ["ReadFlag", "read"], ["WriteFlag", "write"], ["CommunicationFlag", "comm"],
  ["TransmitFlag", "transmit"], ["UpdateFlag", "update"], ["ReadOnInitFlag", "readOnInit"],
];
export const COM_OBJ_OVERRIDE_ATTRS: readonly string[] = [...OVERRIDE_FLAGS.map(([a]) => a), "Priority"];

// The override the stored attributes set. A value outside the schema's is refused: a flag guessed
// either way is a wrong bit in the table every group telegram consults.
export function comObjInstanceOverride(attrs: Readonly<Record<string, string>>): ComObjInstanceOverride {
  const out: ComObjInstanceOverride = { flags: {} };
  for (const [attr, value] of Object.entries(attrs)) {
    const flag = OVERRIDE_FLAGS.find(([a]) => a === attr)?.[1];
    if (flag) {
      if (value !== "Enabled" && value !== "Disabled") {
        throw new ProductError("COM_OBJECT_OVERRIDE_INVALID", `the project sets ${attr}="${value}" on a communication object, which is neither Enabled nor Disabled; refusing to guess the flag`);
      }
      out.flags[flag] = value === "Enabled";
    } else if (attr === "Priority") {
      if (value !== "Low" && value !== "High" && value !== "Alert") {
        throw new ProductError("COM_OBJECT_OVERRIDE_INVALID", `the project sets the priority "${value}" on a communication object, which is not one of Low, High, Alert; refusing to guess it`);
      }
      out.priority = value;
    } else {
      throw new ProductError("COM_OBJECT_OVERRIDE_INVALID", `a stored com-object override carries the attribute ${attr}, which is not a flag or the priority`);
    }
  }
  return out;
}

// A project's com-object overrides over a configuration view already built: the stored rows
// (com-object ref ids without the application prefix) placed on the object numbers of `view`.
// The objects the table is written from (imageComObjects) are placed too: an object of a block the
// page does not show is still written.
export function placeComObjOverrides(app: AppConfig, view: Pick<DeviceConfigBuild, "blocks" | "imageComObjects">, rows: readonly { comObjRefId: string; attrs: Readonly<Record<string, string>> }[]): Map<number, ComObjInstanceOverride> {
  const out = new Map<number, ComObjInstanceOverride>();
  const numByRef = new Map<string, number>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") numByRef.set(it.comObject.refId, it.comObject.number);
  for (const o of view.imageComObjects.values()) numByRef.set(o.refId, o.number);
  for (const r of rows) {
    const full = `${app.id}_${r.comObjRefId}`;
    const num = numByRef.get(full);
    if (num === undefined) {
      // An application object, or an object of a module instance (its ref id names the instance,
      // MI-n), that the configuration does not show is not written, and neither is its override.
      if (app.comObjectRefs.has(full) || /(^|_)MI-\d+_/.test(r.comObjRefId)) continue;
      throw new ProductError("COM_OBJECT_OVERRIDE_UNRESOLVED", `the project sets flags on the communication object ${r.comObjRefId}, which this configuration does not resolve to an object of the application; refusing to write the com-object table without them`);
    }
    const o = comObjInstanceOverride(r.attrs);
    const prev = out.get(num);
    if (!prev) { out.set(num, o); continue; }
    const clash = (Object.keys(o.flags) as (keyof typeof o.flags)[]).some((k) => k in prev.flags && prev.flags[k] !== o.flags[k])
      || (o.priority !== undefined && prev.priority !== undefined && o.priority !== prev.priority);
    if (clash) throw new ProductError("COM_OBJECT_OVERRIDE_CONFLICT", `the project sets a flag of communication object #${num} twice, differently; refusing to pick one`);
    out.set(num, { flags: { ...prev.flags, ...o.flags }, priority: o.priority ?? prev.priority });
  }
  return out;
}

// The flags the project gives each object of the configuration, by object number: the
// application's with the project's overrides laid over them, placed as the writes that author the
// com-object table place them (placeComObjOverrides), and the priority likewise. What a family's table
// write derives from the links on top (comobjbuild's communication and linked bits) is not in them.
// `overridden` names the flags the project sets differently from the application, `priorityOverridden`
// says the same of the priority. Refuses as placeComObjOverrides does.
export interface EffectiveComObjFlags { flags: ComObjFlags; overridden: (keyof ComObjFlags)[]; priority: ComObjPriority; priorityOverridden: boolean }
export function effectiveComObjFlags(app: AppConfig, view: Pick<DeviceConfigBuild, "blocks" | "imageComObjects">, rows: readonly { comObjRefId: string; attrs: Readonly<Record<string, string>> }[]): Map<number, EffectiveComObjFlags> {
  const placed = placeComObjOverrides(app, view, rows);
  const out = new Map<number, EffectiveComObjFlags>();
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind !== "comObject") continue;
    const own = it.comObject.flags;
    const p = placed.get(it.comObject.number);
    const o = p?.flags ?? {};
    const overridden = (Object.keys(o) as (keyof ComObjFlags)[]).filter((k) => o[k] !== own[k]);
    const priority = p?.priority ?? it.comObject.priority;
    out.set(it.comObject.number, { flags: { ...own, ...o }, overridden, priority, priorityOverridden: priority !== it.comObject.priority });
  }
  return out;
}

// One edit of an object's flags or priority on the device page, as the attributes the project then
// stores for it (the form ETS keeps on a ComObjectInstanceRef). `live`: what the project stores for
// the object now; `held`: what it stored when the device was last written (its baseline), so a bit set
// back to the device's value takes exactly the form the baseline holds and nothing counts as changed.
// A bit set to the application's value otherwise, or reset (null), drops its attribute; any other
// value is stored as ETS stores it. Refuses a stored value outside the schema, as the writes do.
export interface ComObjOverrideEdit { flags?: Partial<Record<keyof ComObjFlags, boolean | null>>; priority?: ComObjPriority | null }
export function editComObjOverride(
  live: Readonly<Record<string, string>> | undefined, held: Readonly<Record<string, string>> | undefined,
  app: { flags: ComObjFlags; priority: ComObjPriority }, edit: ComObjOverrideEdit,
): Record<string, string> {
  const out: Record<string, string> = { ...live };
  const heldOverride = comObjInstanceOverride(held ?? {});
  comObjInstanceOverride(out);
  const place = (attr: string, value: string | null, appValue: string, heldValue: string | undefined) => {
    const want = value ?? appValue;
    if (want === (heldValue ?? appValue)) {
      if (heldValue === undefined) delete out[attr];
      else out[attr] = heldValue;
    } else if (want === appValue) delete out[attr];
    else out[attr] = want;
  };
  const enabled = (b: boolean) => (b ? "Enabled" : "Disabled");
  for (const [attr, flag] of OVERRIDE_FLAGS) {
    const v = edit.flags?.[flag];
    if (v === undefined) continue;
    place(attr, v === null ? null : enabled(v), enabled(app.flags[flag]), held?.[attr] !== undefined ? enabled(heldOverride.flags[flag]!) : undefined);
  }
  if (edit.priority !== undefined) place("Priority", edit.priority, app.priority, heldOverride.priority);
  return out;
}

// The active objects with the device's own flags and priority laid over the application's. An
// override on an object the configuration does not activate is not written, as the object is not.
export function withInstanceOverrides(active: ReadonlyMap<number, CfgComObjImage>, overrides: ReadonlyMap<number, ComObjInstanceOverride> | undefined): Map<number, CfgComObjImage> {
  const out = new Map(active);
  for (const [n, o] of overrides ?? []) {
    const obj = out.get(n);
    if (!obj) continue;
    out.set(n, { ...obj, flags: { ...obj.flags, ...o.flags }, priority: o.priority ?? obj.priority });
  }
  return out;
}

// ── The flags a device holds in its com-object table ─────────────────────────
//
// What a read of a device's com-object table shows of each object: the flags the table has a bit for
// and that the bit shows, and the priority where its two bits name one of ETS's three classes (00, the
// System class, is the stack's own and no application names it: absent then).
export interface ObservedComObjFlags { flags: Partial<ComObjFlags>; priority?: ComObjPriority }

const PRIORITY_BY_BITS = new Map<number, ComObjPriority>(Object.entries(PRIORITY_BITS).map(([p, b]) => [b, p as ComObjPriority]));

// A System B table (layout in comObjectEntry), by object number. The communication flag is shown only
// on the objects in `linked` (the device's own associations): every write clears it on an object without
// a link, whatever is set (buildComObjectTable).
export function decodeComObjectTable(table: Buffer, linked: ReadonlySet<number>): Map<number, ObservedComObjFlags> {
  const count = table.length >= 2 ? table.readUInt16BE(0) : -1;
  if (count < 0 || table.length < 2 + count * 2) {
    throw new ProductError("COM_OBJECT_TABLE_UNREADABLE", `the device's com-object table is ${table.length} B${count >= 0 ? ` for the ${count} entries it declares` : ""}; refusing to read its flags from it`);
  }
  const out = new Map<number, ObservedComObjFlags>();
  for (let n = 1; n <= count; n++) {
    const b = table[2 + (n - 1) * 2];
    const flags: Partial<ComObjFlags> = { update: !!(b & 0x80), transmit: !!(b & 0x40), readOnInit: !!(b & 0x20), write: !!(b & 0x10), read: !!(b & 0x08) };
    if (linked.has(n)) flags.comm = !!(b & 0x04);
    out.set(n, { flags, priority: PRIORITY_BY_BITS.get(b & 0x03) });
  }
  return out;
}

// A System 7 table (layout in buildComObjectTableMv0705), by object number. Its config byte has no bit
// for read-on-init. Its 0x04 bit is set on a linked object whose communication flag is on, so it shows
// the communication flag only on the objects in `linked` (the device's own associations); on the
// others it is clear whatever is set.
export function decodeComObjectTableMv0705(table: Buffer, linked: ReadonlySet<number>): Map<number, ObservedComObjFlags> {
  const count = table.length >= 3 ? table[0] : -1;
  if (count < 0 || table.length < 3 + count * 4) {
    throw new ProductError("COM_OBJECT_TABLE_UNREADABLE", `the device's com-object table is ${table.length} B${count >= 0 ? ` for the ${count} entries it declares` : ""}; refusing to read its flags from it`);
  }
  const out = new Map<number, ObservedComObjFlags>();
  for (let n = 0; n < count; n++) {
    const b = table[3 + n * 4 + 2];
    const flags: Partial<ComObjFlags> = { read: !!(b & 0x08), write: !!(b & 0x10), transmit: !!(b & 0x40), update: !!(b & 0x80) };
    if (linked.has(n)) flags.comm = !!(b & 0x04);
    out.set(n, { flags, priority: PRIORITY_BY_BITS.get(b & 0x03) });
  }
  return out;
}

type OverrideRow = { comObjRefId: string; attrs: Record<string, string> };
const mergedAttrs = (rows: readonly OverrideRow[]): Record<string, string> => Object.assign({}, ...rows.map((r) => r.attrs));
const sameAttrs = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

// The flag baseline a read of the device's table sets: `held` (the stored rows, ref ids without the
// application prefix) with each object the configuration activates (`active`, by number) set to what the
// device shows, as the attributes ETS stores (editComObjOverride against the held form, so an object the
// device holds as recorded keeps its rows and a bit equal to the application's drops its attribute). A
// bit the device does not show keeps its stored attribute; an object the table does not hold, or holds
// with no priority an application names, keeps its rows and is named in `undecoded`.
export function deviceComObjOverrideRows(
  app: Pick<AppConfig, "id">, active: ReadonlyMap<number, CfgComObjImage>, observed: ReadonlyMap<number, ObservedComObjFlags>, held: readonly OverrideRow[],
): { rows: OverrideRow[]; undecoded: number[] } {
  const heldByRef = new Map<string, OverrideRow[]>();
  for (const r of held) heldByRef.set(r.comObjRefId, [...(heldByRef.get(r.comObjRefId) ?? []), r]);
  for (const [ref, rows] of heldByRef) {
    const clash = rows.some((a) => rows.some((b) => Object.entries(a.attrs).some(([k, v]) => b.attrs[k] !== undefined && b.attrs[k] !== v)));
    if (clash) throw new ProductError("COM_OBJECT_OVERRIDE_CONFLICT", `the baseline sets a flag of communication object ${ref} twice, differently; refusing to take the device's flags over it`);
  }
  const changed = new Map<string, Record<string, string>>();
  const undecoded: number[] = [];
  for (const [n, o] of [...active].sort(([a], [b]) => a - b)) {
    const seen = observed.get(n);
    if (!seen || seen.priority === undefined) { undecoded.push(n); continue; }
    const ref = o.refId.startsWith(`${app.id}_`) ? o.refId.slice(app.id.length + 1) : o.refId;
    const was = mergedAttrs(heldByRef.get(ref) ?? []);
    const now = editComObjOverride(was, was, { flags: o.flags, priority: o.priority }, { flags: seen.flags, priority: seen.priority });
    if (!sameAttrs(now, was)) changed.set(ref, now);
  }
  const rows: OverrideRow[] = [];
  const placed = new Set<string>();
  for (const r of held) {
    const now = changed.get(r.comObjRefId);
    if (!now) { rows.push(r); continue; }
    if (placed.has(r.comObjRefId)) continue;
    placed.add(r.comObjRefId);
    if (Object.keys(now).length) rows.push({ comObjRefId: r.comObjRefId, attrs: now });
  }
  for (const [ref, now] of changed) if (!placed.has(ref) && Object.keys(now).length) rows.push({ comObjRefId: ref, attrs: now });
  return { rows, undecoded };
}

// The objects of `active` (the configuration the device was last written with, by number) whose flags or
// priority the device's table shows otherwise than the baseline records (`base`, the stored overrides
// placed on that configuration, over the application's), or does not hold with a priority an application
// names. With `changing` (per object, the bits a write changes in its entry) only those objects, and only
// those bits: a write that changes a bit the device holds otherwise than recorded would change it silently;
// one that keeps the bit leaves the device's value.
export function comObjFlagsDiffering(
  observed: ReadonlyMap<number, ObservedComObjFlags>, active: ReadonlyMap<number, CfgComObjImage>,
  base: ReadonlyMap<number, ComObjInstanceOverride> | undefined, changing?: ReadonlyMap<number, readonly OverridableBit[]>,
): number[] {
  const expected = withInstanceOverrides(active, base);
  const out: number[] = [];
  for (const [n, o] of [...expected].sort(([a], [b]) => a - b)) {
    const bits = changing?.get(n);
    if (changing && !bits) continue;
    const seen = observed.get(n);
    const asked = (b: OverridableBit) => !bits || bits.includes(b);
    const differs = !seen || (asked("priority") && seen.priority !== o.priority) || (!bits && seen.priority === undefined)
      || (Object.keys(seen.flags) as (keyof ComObjFlags)[]).some((k) => asked(k) && seen.flags[k] !== o.flags[k]);
    if (differs) out.push(n);
  }
  return out;
}

// The flags and priority whose bits differ between two entries' flag bytes (`xor`), by the layout of the
// family's table: System B's flags byte (comObjectEntry) or System 7's config byte (buildComObjectTableMv0705).
const ENTRY_BITS: Record<"systemB" | "system7", [number, keyof ComObjFlags][]> = {
  systemB: [[0x80, "update"], [0x40, "transmit"], [0x20, "readOnInit"], [0x10, "write"], [0x08, "read"], [0x04, "comm"]],
  system7: [[0x80, "update"], [0x40, "transmit"], [0x10, "write"], [0x08, "read"], [0x04, "comm"]],
};
export function changedEntryBits(xor: number, layout: "systemB" | "system7"): OverridableBit[] {
  const out: OverridableBit[] = ENTRY_BITS[layout].filter(([m]) => xor & m).map(([, k]) => k);
  if (xor & 0x03) out.push("priority");
  return out;
}

// Refuse a write that would rewrite the flags of objects `differing` names (comObjFlagsDiffering): where
// the device's table (`observed`) holds them with flags the project does not record, a read-back takes
// them into the baseline (COM_OBJECT_FLAGS_UNKNOWN); where it does not hold them, or holds them with no
// priority an application names, no read-back can (COM_OBJECT_FLAGS_UNREADABLE).
export function refuseUnknownDeviceFlags(differing: readonly number[], observed: ReadonlyMap<number, ObservedComObjFlags>): void {
  if (!differing.length) return;
  const named = (ns: readonly number[]) => ns.slice(0, 8).map((n) => `#${n}`).join(", ") + (ns.length > 8 ? ` and ${ns.length - 8} more` : "");
  const unreadable = differing.filter((n) => observed.get(n)?.priority === undefined);
  if (unreadable.length) {
    throw new ProductError("COM_OBJECT_FLAGS_UNREADABLE", `the device's com-object table does not hold communication object(s) ${named(unreadable)} with flags and a priority an application names, while the configuration it was last written with activates them; this write rewrites the table and a read-back cannot take what it holds there. A full download writes the table whole`);
  }
  throw new ProductError("COM_OBJECT_FLAGS_UNKNOWN", `the device holds flags or a priority on communication object(s) ${named(differing)} other than the project records for it; this write rewrites the com-object table and would change them silently. Read the device back first, so they show as a change`);
}

// Refuse a write whose com-object table cannot carry an override the project sets: one that changes
// a flag or the priority the table has no bit for (the System 7 config byte has none for read-on-init),
// or any override where the write does not author the table at all. Writing on would leave the object behaving as the application
// says while the project says otherwise.
export type OverridableBit = keyof ComObjFlags | "priority";
export function refuseUnwritableOverrides(active: ReadonlyMap<number, CfgComObjImage>, overrides: ReadonlyMap<number, ComObjInstanceOverride> | undefined, writable: readonly OverridableBit[], where: string): void {
  for (const [n, o] of overrides ?? []) {
    const obj = active.get(n);
    if (!obj) continue;
    const changed: OverridableBit[] = (Object.keys(o.flags) as (keyof ComObjFlags)[]).filter((k) => o.flags[k] !== obj.flags[k]);
    if (o.priority !== undefined && o.priority !== obj.priority) changed.push("priority");
    const lost = changed.filter((k) => !writable.includes(k));
    if (lost.length) {
      throw new ProductError("COM_OBJECT_OVERRIDE_UNWRITABLE", `the project sets ${lost.join(", ")} of communication object #${n} differently from the application, and ${where} cannot carry that; refusing to write the object as the application declares it`);
    }
  }
}
