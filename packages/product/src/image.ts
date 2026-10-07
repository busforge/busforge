import type { AppModel, ParamType } from "./application.ts";
import { ProductError } from "./errors.ts";

// Build the parameter memory image for a load-state-machine segment from the
// default segment data plus the effective parameter values. Effective value =
// device instance value (if set) else parameter-ref value else parameter default.
export function buildParameterImage(model: AppModel, lsm: number, instanceValues: Map<string, string>): Buffer {
  const seg = model.segments.find((s) => s.lsm === lsm);
  if (!seg) throw new Error(`no segment for LSM ${lsm}`);
  if (!Number.isInteger(seg.size) || seg.size < 0) throw new Error(`malformed segment size for LSM ${lsm}: ${seg.size}`);
  const img = Buffer.alloc(seg.size);
  seg.data.copy(img); // start from manufacturer defaults

  for (const ref of model.refs.values()) {
    const param = model.params.get(ref.paramId);
    if (!param || param.offset === undefined) continue;
    if (param.codeSegment && model.segments.find((s) => s.id === param.codeSegment)?.lsm !== lsm) continue;
    // loaded image uses the device instance value if set, else the PARAMETER default;
    // ParameterRef.Value is a planning/UI-layer default, not the image source.
    const v = instanceValues.get(ref.id) ?? param.value;
    if (v === undefined) continue;
    const type = model.types.get(param.typeId);
    if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
    encode(img, param.offset, param.bitOffset, type, v);
  }
  return img;
}

// Read the parameter values back out of a memory image. Inverse of
// buildParameterImage: same ref iteration and skip conditions, so the keys line
// up with what buildParameterImage would write. Only memory-backed numeric/float
// parameters are decodable; text/other types are skipped (left to the caller's
// existing value). Keyed by ParameterRef id.
export function decodeParameterImage(model: AppModel, lsm: number, img: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of model.refs.values()) {
    const param = model.params.get(ref.paramId);
    if (!param || param.offset === undefined) continue;
    if (param.codeSegment && model.segments.find((s) => s.id === param.codeSegment)?.lsm !== lsm) continue;
    const type = model.types.get(param.typeId);
    if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
    const v = decode(img, param.offset, param.bitOffset, type);
    if (v === undefined) continue; // text/other: not represented in the image
    out.set(ref.id, v);
  }
  return out;
}

// Decode parameter values from an MV-0705 absolute segment's image (the read-back
// counterpart of buildAbsoluteSegmentTargets). Same codec as decodeParameterImage but
// keyed off the absolute segment id (those params live in app.absoluteSegments, not the
// relative model.segments, so the lsm filter does not apply). The caller restricts the
// result to the visible/relevant refs for drift detection.
export function decodeAbsoluteImage(model: AppModel, segId: string, img: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of model.refs.values()) {
    const param = model.params.get(ref.paramId);
    if (!param || param.codeSegment !== segId || param.offset === undefined) continue;
    const type = model.types.get(param.typeId);
    if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
    const v = decode(img, param.offset, param.bitOffset, type);
    if (v === undefined) continue; // text/other: not represented in the image
    out.set(ref.id, v);
  }
  return out;
}

// KNX 2-byte float (DPT 9.xxx): bit15 sign, bits14-11 exponent, bits10-0 mantissa.
// value = 0.01 * mantissa * 2^exponent, the mantissa being an 11-bit two's
// complement combined with the sign bit. Reference vectors: 0 -> 0x0000,
// 21.0 -> 0x0C1A, -0.01 -> 0x87FF.
export function encodeDpt9(value: number): number {
  let mant = Math.round(value * 100);
  let exp = 0;
  while (mant > 2047 || mant < -2048) { mant = Math.round(mant / 2); exp++; }
  if (exp > 15) { exp = 15; mant = mant < 0 ? -2048 : 2047; } // saturate beyond representable range
  const sign = mant < 0 ? 0x8000 : 0;
  return sign | ((exp & 0x0f) << 11) | (mant & 0x07ff);
}

export function decodeDpt9(raw: number): number {
  const exp = (raw >> 11) & 0x0f;
  let mant = raw & 0x07ff;
  if (raw & 0x8000) mant -= 2048; // sign bit -> 11-bit two's complement
  return Math.round(mant * (1 << exp)) / 100; // 0.01 resolution, no fp noise
}

// Returns true iff bytes were actually written. The flash path relies on this to
// decide which bytes a parameter OWNS (may be written to the device): a type the
// image does not represent (text/time/color/other) or a malformed value writes
// nothing and must not claim any bytes. See deviceflash.ts.
// Parse a dotted-quad IPv4 string into its 4 octets, or undefined if malformed.
// Strict: exactly four 0-255 integers, no extra parts. Used by the IPAddress codec.
function parseIPv4(s: string): [number, number, number, number] | undefined {
  const parts = s.trim().split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return octets as [number, number, number, number];
}

// Integer-codec width limit and byte-span rule, shared by encode/decode here and the
// ownership mechanics in deviceimage.ts (which previously mirrored them by comment only).
// The integer codec caps at 6 bytes; a wider parameter is either a BinaryValue (its
// enumeration's bytes, binaryValueBytes) or not encodable (see deviceimage.ts).
export const MAX_INT_BYTES = 6;

// How many bytes a parameter field TOUCHES. A field is `sizeInBit` bits starting at bit
// `bitOffset`, counted MSB-first from the byte at its Offset, so it straddles byte boundaries
// whenever bitOffset + sizeInBit is not a multiple of 8, and it spans one byte more than its
// width alone suggests. This used to be `sizeInBit >> 3` (FLOOR, and blind to the bit offset),
// which under-counted every field that is not byte-aligned: a 14-bit field came out as 1 byte.
// Manufacturers pack memory exactly this way (OpenKNX PT-DelayTime = 14 bits at bit 2; Theben
// 493B = 11 bits at bit 5), so the width has to follow the field, not the type alone.
export const byteWidth = (sizeInBit: number, bitOffset = 0): number => Math.max(1, Math.ceil((bitOffset + sizeInBit) / 8));

// The type bases encode() can represent in the parameter image. MUST stay in sync with
// encode() below: everything else (Text, Time, Color, Other) writes nothing
// and therefore is never programmed by a flash. Consumers use this to avoid claiming
// such a parameter as "programmed" (e.g. the post-flash baseline reset).
export const IMAGE_WRITABLE_BASES: ReadonlySet<string> = new Set(["Value", "BinaryValue", "Number", "Float", "IPAddress"]);

// A BinaryValue parameter's bytes: those of the enumeration its value names, as declared. This is the
// schema's definition of the type, not a behaviour read off one application's captures, so it holds
// for every application; the ETS captures of the Theben MIX 2 show ETS writing it (the only
// application of the corpus with a BinaryValue parameter in memory). The
// enumeration's bytes fill the type exactly and start on a byte (the Theben MIX 2 object-link
// tables, 21 to 116 bytes; the hardware-type restrictions, 6 bytes); any other shape, or a value no
// enumeration declares bytes for, has no byte layout ETS is known to write, and is refused.
function binaryValueBytes(type: ParamType, offset: number, bit: number, valStr: string): Buffer {
  const where = `BinaryValue parameter type ${type.id} at offset ${offset}`;
  if (type.littleEndian) throw new ProductError("PARAM_BYTE_ORDER_UNSUPPORTED", `a ${where} in an application with little-endian parameters: its byte layout is not known`);
  const bytes = type.binaryValues?.get(Number(valStr));
  if (!bytes) throw new ProductError("PARAM_BINARY_VALUE_UNDECLARED", `${where}: no enumeration declares bytes for the value "${valStr}"`);
  if (bit !== 0 || type.sizeInBit !== bytes.length * 8) {
    throw new ProductError("PARAM_BINARY_VALUE_UNDECLARED", `${where}: the enumeration's ${bytes.length} bytes do not fill the type's ${type.sizeInBit} bits from bit 0 (bit offset ${bit})`);
  }
  return bytes;
}

export function encode(img: Buffer, offset: number, bit: number, type: ParamType, valStr: string): boolean {
  if (!Number.isFinite(offset)) return false; // malformed memory (no/garbage Offset): no location to write
  if (type.base === "IPAddress") {
    if (type.littleEndian) throw new ProductError("PARAM_BYTE_ORDER_UNSUPPORTED", `an IP address parameter in an application with little-endian parameters (offset ${offset}): its byte layout is not known`);
    const octets = parseIPv4(valStr);
    if (!octets || offset + 4 > img.length) return false; // malformed/short: own nothing
    for (let i = 0; i < 4; i++) img[offset + i] = octets[i]; // 4 bytes, big-endian (a.b.c.d)
    return true;
  }
  if (type.base === "BinaryValue") {
    const bytes = binaryValueBytes(type, offset, bit, valStr);
    if (offset + bytes.length > img.length) throw new ProductError("PARAM_BINARY_VALUE_UNDECLARED", `BinaryValue parameter type ${type.id} at offset ${offset}: its ${bytes.length} bytes reach past the ${img.length}-byte segment`);
    bytes.copy(img, offset);
    return true;
  }
  if (type.base === "Float") {
    if (type.littleEndian) throw new ProductError("PARAM_BYTE_ORDER_UNSUPPORTED", `a float parameter in an application with little-endian parameters (offset ${offset}): its byte layout is not known`);
    const v = Number(valStr);
    if (!Number.isFinite(v)) return false;
    if (type.sizeInBit === 32) { if (offset + 4 <= img.length) { img.writeFloatBE(v, offset); return true; } return false; } // DPT 14 (IEEE-754 Single)
    if (type.sizeInBit === 16) { if (offset + 2 <= img.length) { img.writeUInt16BE(encodeDpt9(v), offset); return true; } return false; } // DPT 9
    // The two KNX TypeFloat encodings are exactly these (Encoding "IEEE-754 Single"/"DPT 9",
    // sized in appconfig). Any other width is a float codec we do not have (e.g. an IEEE-754
    // Double); refuse to own the bytes rather than silently writing a wrong-sized value.
    return false;
  }
  // Only Value (enum/restriction) and Number are integer-coded into the image. Text,
  // Time, Color, IPAddress and other types are NOT represented in the parameter image,
  // so they must not be written here. Keeping this symmetric with decode is what
  // prevents a numeric-looking text value (e.g. "" -> 0, or "123") from being written
  // as a bogus integer, which for a wide text type also overflows the byte writer.
  if (type.base !== "Value" && type.base !== "Number") return false;
  const v = Number(valStr);
  if (!Number.isFinite(v)) return false;

  const { sizeInBit } = type;
  const span = byteWidth(sizeInBit, bit);
  if (span > MAX_INT_BYTES) throw new Error(`integer parameter wider than 48 bits not supported (${sizeInBit} bits at offset ${offset})`);
  if (offset + span > img.length) return false;

  // A value outside its declared type is corrupt input. Masking it into the field would put
  // silently wrong bits on the device, so refuse; the old code got a RangeError out of the
  // byte writer here, which is the same refusal by accident and only for unsigned overflow.
  // Coded, so the HTTP layer surfaces an honest 400 instead of a raw 500 INTERNAL.
  const range = 2 ** sizeInBit;
  const [min, max] = type.signed ? [-(range / 2), range / 2 - 1] : [0, range - 1];
  if (v < min || v > max) {
    throw new ProductError("PARAM_VALUE_OUT_OF_RANGE",
      `parameter value ${v} does not fit its declared ${sizeInBit}-bit type (allowed ${min}..${max})`);
  }
  const field = v < 0 ? v + range : v; // two's complement WITHIN the field's width
  if (type.littleEndian && span > 1) {
    // Least significant byte first. Defined only for a field that fills whole bytes; how a
    // little-endian application packs a field across a byte boundary is not known.
    if (bit !== 0 || sizeInBit % 8 !== 0) throw new ProductError("PARAM_BYTE_ORDER_UNSUPPORTED", `a ${sizeInBit}-bit field at bit ${bit} (offset ${offset}) in an application with little-endian parameters: its byte layout is not known`);
    let rest = field;
    for (let i = 0; i < span; i++) { img[offset + i] = rest % 256; rest = Math.floor(rest / 256); }
    return true;
  }

  // Splice the field into the big-endian word it lives in. KNX numbers BitOffset from the MOST
  // significant bit (big-endian bit order), so a w-bit field at bit b inside a span of n bytes
  // sits shifted left by (n*8 - b - w). Hardware-verified MSB-first (M-0048/M-0081: LSB-first
  // only ever matched byte-aligned devices). Byte arithmetic rather than shifts because a span
  // reaches 48 bits, past what JS bitwise operators handle; every value here stays exact.
  const shift = 2 ** (span * 8 - bit - sizeInBit);
  let word = 0;
  for (let i = 0; i < span; i++) word = word * 256 + img[offset + i];
  word += (field - (Math.floor(word / shift) % range)) * shift; // replace ONLY this field's bits
  for (let i = span - 1; i >= 0; i--) { img[offset + i] = word % 256; word = Math.floor(word / 256); }
  return true;
}

// Inverse of encode. Returns the decoded value as a string, or undefined for
// anything not represented in the image (text/time/other, or a layout the encoder
// would refuse). Read-back is best-effort, so it skips rather than throws.
function decode(img: Buffer, offset: number, bit: number, type: ParamType): string | undefined {
  if (!Number.isFinite(offset)) return undefined;
  if (type.base === "IPAddress") {
    if (offset + 4 > img.length) return undefined;
    return `${img[offset]}.${img[offset + 1]}.${img[offset + 2]}.${img[offset + 3]}`;
  }
  if (type.base === "BinaryValue") {
    if (type.littleEndian || bit !== 0) return undefined; // mirror encode's refusal
    for (const [v, bytes] of type.binaryValues ?? []) {
      if (type.sizeInBit === bytes.length * 8 && offset + bytes.length <= img.length && img.subarray(offset, offset + bytes.length).equals(bytes)) return String(v);
    }
    return undefined;
  }
  if (type.base === "Float") {
    if (type.littleEndian) return undefined; // mirror encode's refusal
    if (type.sizeInBit === 32) return offset + 4 > img.length ? undefined : String(img.readFloatBE(offset));
    if (type.sizeInBit === 16) return offset + 2 > img.length ? undefined : String(decodeDpt9(img.readUInt16BE(offset)));
    return undefined; // unknown float width: no codec (mirrors encode's refusal)
  }
  if (type.base !== "Value" && type.base !== "Number") return undefined; // text/time/other
  const { sizeInBit } = type;
  const span = byteWidth(sizeInBit, bit);
  if (span > MAX_INT_BYTES || offset + span > img.length) return undefined; // mirror encode's refusal
  const range = 2 ** sizeInBit;
  if (type.littleEndian && span > 1) {
    if (bit !== 0 || sizeInBit % 8 !== 0) return undefined; // mirror encode's refusal
    let word = 0;
    for (let i = span - 1; i >= 0; i--) word = word * 256 + img[offset + i];
    const v = type.signed && word >= range / 2 ? word - range : word;
    return String(v);
  }
  // Exact inverse of encode's splice: lift the field out of its big-endian word, MSB-first.
  const shift = 2 ** (span * 8 - bit - sizeInBit);
  let word = 0;
  for (let i = 0; i < span; i++) word = word * 256 + img[offset + i];
  let v = Math.floor(word / shift) % range;
  if (type.signed && v >= range / 2) v -= range; // two's complement within the field
  return String(v);
}
