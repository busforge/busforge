// ETS's own record of its last download of a device, which it keeps in the project on the
// DeviceInstance: `LoadedImage` (the bytes it loaded) and `CheckSums` (the CRCs the device reported for
// them). ETS keeps both for an application whose load procedure names `LdCtrlLoadImageProp`, for the
// load-state machines 3 and 4 only (docs/verification.md, "ETS's download record").
//
// Both are base64. Nothing here guesses: a record or a value this decoder does not account for, or
// lengths that do not add up to the attribute exactly, is refused with a coded error.
import { inflateRawSync } from "node:zlib";
import { KnxprojError } from "./errors.ts";

// One block of bytes ETS loaded.
//   absolute: `start` is a memory address (System 7 application segments).
//   relative: `start` is an offset into the segment `object`'s table reference (PID 7) points at.
// `mask[i]` is 0xFF where ETS's image defines byte i and 0x00 where it does not; `data[i]` is
// meaningless where the mask is 0x00.
export interface LoadedImageRecord {
  location: "absolute" | "relative";
  object: number;
  start: number;
  data: Buffer;
  mask: Buffer;
}

// The CRC of one region of an object's memory-control block (PID 27), as the device reported it.
// `flag` is 1 where the block reports the region with CRC control 00 and 0 where it reports 01; what ETS
// does with it is not shown.
export interface CheckSumRegion { crc: number; flag: 0 | 1 }
export interface ObjectCheckSums { object: number; regions: CheckSumRegion[] }

// The kinds of record the corpus shows, and the objects it shows them for (load-state machines 3 and 4).
// Every other kind and object is refused.
const KIND_ABSOLUTE = 1;
const KIND_RELATIVE = 12;
const PID_TABLE_REFERENCE = 7;
const DATA_AND_MASK = 0x03;
const RECORDED_OBJECTS = [3, 4];

function base64(attr: string, what: string, code: string): Buffer {
  if (attr.length === 0 || attr.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attr)) {
    throw new KnxprojError(code, `${what} is not base64`);
  }
  return Buffer.from(attr, "base64");
}

// A cursor that refuses to read past the end, so a truncated attribute never decodes as a shorter one.
function reader(buf: Buffer, what: string, code: string) {
  let at = 0;
  const need = (n: number) => {
    if (at + n > buf.length) throw new KnxprojError(code, `${what} ends at byte ${buf.length}, inside a record that needs ${at + n}`);
  };
  return {
    u8: () => { need(1); return buf[at++]; },
    u16: () => { need(2); const v = buf.readUInt16LE(at); at += 2; return v; },
    u32: () => { need(4); const v = buf.readUInt32LE(at); at += 4; return v; },
    bytes: (n: number) => { need(n); const v = Buffer.from(buf.subarray(at, at + n)); at += n; return v; },
    end: () => {
      if (at !== buf.length) throw new KnxprojError(code, `${what} holds ${buf.length - at} byte(s) after its last record`);
    },
  };
}

export function decodeLoadedImage(attr: string): LoadedImageRecord[] {
  const what = "the device's LoadedImage";
  const packed = base64(attr, what, "LOADED_IMAGE_INVALID");
  let raw: Buffer, consumed: number;
  try {
    // `info` reports how much of the input the stream took, so bytes after its end are not ignored.
    const { buffer, engine } = inflateRawSync(packed, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    raw = buffer;
    consumed = engine.bytesWritten;
  } catch {
    throw new KnxprojError("LOADED_IMAGE_INVALID", `${what} is not a deflate stream`);
  }
  if (consumed !== packed.length) throw new KnxprojError("LOADED_IMAGE_INVALID", `${what} holds ${packed.length - consumed} byte(s) after its deflate stream`);
  const r = reader(raw, what, "LOADED_IMAGE_INVALID");
  const major = r.u16(), minor = r.u16();
  if (major !== 1 || minor !== 1) throw new KnxprojError("LOADED_IMAGE_UNSUPPORTED", `${what} has version ${major}.${minor}; only 1.1 is known`);
  const count = r.u32();
  const records: LoadedImageRecord[] = [];
  for (let i = 0; i < count; i++) {
    const kind = r.u32(), object = r.u16(), pid = r.u16(), start = r.u32(), length = r.u32(), content = r.u8();
    const where = `record ${i + 1} of ${what}`;
    if (kind !== KIND_ABSOLUTE && kind !== KIND_RELATIVE) throw new KnxprojError("LOADED_IMAGE_UNSUPPORTED", `${where} is of kind ${kind}; only absolute memory (1) and memory relative to a table reference (12) are known`);
    if (kind === KIND_ABSOLUTE && (object !== 0 || pid !== 0)) throw new KnxprojError("LOADED_IMAGE_UNSUPPORTED", `${where} is absolute memory naming object ${object}, property ${pid}`);
    if (kind === KIND_RELATIVE && !RECORDED_OBJECTS.includes(object)) throw new KnxprojError("LOADED_IMAGE_UNSUPPORTED", `${where} is of object ${object}; only objects 3 and 4 are known`);
    if (kind === KIND_RELATIVE && pid !== PID_TABLE_REFERENCE) throw new KnxprojError("LOADED_IMAGE_UNSUPPORTED", `${where} is relative to property ${pid}, not to the table reference (${PID_TABLE_REFERENCE})`);
    if (content !== DATA_AND_MASK) throw new KnxprojError("LOADED_IMAGE_UNSUPPORTED", `${where} has content flags ${content}; only data with a mask (${DATA_AND_MASK}) is known`);
    const data = r.bytes(length), mask = r.bytes(length);
    const odd = mask.findIndex((b) => b !== 0x00 && b !== 0xff);
    if (odd >= 0) throw new KnxprojError("LOADED_IMAGE_UNSUPPORTED", `${where} masks byte ${odd} with 0x${mask[odd].toString(16)}; only 0x00 and 0xFF are known`);
    records.push({ location: kind === KIND_ABSOLUTE ? "absolute" : "relative", object, start, data, mask });
  }
  r.end();
  return records;
}

export function decodeCheckSums(attr: string): ObjectCheckSums[] {
  const what = "the device's CheckSums";
  const r = reader(base64(attr, what, "CHECKSUMS_INVALID"), what, "CHECKSUMS_INVALID");
  const major = r.u16(), minor = r.u16(), flavour = r.u32();
  if (major !== 1 || minor !== 1 || flavour !== 1) throw new KnxprojError("CHECKSUMS_UNSUPPORTED", `${what} has version ${major}.${minor}, flavour ${flavour}; only 1.1 flavour 1 (memory-control block CRCs) is known`);
  const count = r.u32();
  const objects: ObjectCheckSums[] = [];
  for (let i = 0; i < count; i++) {
    const object = r.u8(), n = r.u32();
    if (!RECORDED_OBJECTS.includes(object)) throw new KnxprojError("CHECKSUMS_UNSUPPORTED", `${what} names object ${object}; only objects 3 and 4 are known`);
    const regions: CheckSumRegion[] = [];
    for (let k = 0; k < n; k++) {
      const flag = r.u8(), crc = r.u16();
      if (flag !== 0 && flag !== 1) throw new KnxprojError("CHECKSUMS_UNSUPPORTED", `region ${k + 1} of object ${object} in ${what} has flag ${flag}; only 0 and 1 are known`);
      regions.push({ crc, flag });
    }
    objects.push({ object, regions });
  }
  r.end();
  return objects;
}
