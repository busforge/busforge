import type { AppModel, ParamType } from "./application.ts";

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

function encode(img: Buffer, offset: number, bit: number, type: ParamType, valStr: string) {
  if (!Number.isFinite(offset)) return; // malformed memory (no/garbage Offset): no location to write
  if (type.base === "Float") {
    const v = Number(valStr);
    if (!Number.isFinite(v)) return;
    if (type.sizeInBit === 32) { if (offset + 4 <= img.length) img.writeFloatBE(v, offset); return; } // DPT 14 (IEEE-754)
    if (offset + 2 <= img.length) img.writeUInt16BE(encodeDpt9(v), offset); // DPT 9
    return;
  }
  // Only Value (enum/restriction) and Number are integer-coded into the image. Text,
  // Time, Color, IPAddress and other types are NOT represented in the parameter image,
  // so they must not be written here. Keeping this symmetric with decode is what
  // prevents a numeric-looking text value (e.g. "" -> 0, or "123") from being written
  // as a bogus integer, which for a wide text type also overflows the byte writer.
  if (type.base !== "Value" && type.base !== "Number") return;
  const v = Number(valStr);
  if (!Number.isFinite(v)) return;
  const sizeInBit = type.sizeInBit;
  if (sizeInBit >= 8) {
    const bytes = sizeInBit >> 3;
    if (offset + bytes > img.length) return;
    // writeUIntBE/IntBE cap at 6 bytes. No manufacturer numeric type exceeds that in
    // practice; refuse loudly rather than emit truncated/cryptic bytes if one appears.
    if (bytes > 6) throw new Error(`integer parameter wider than 48 bits not supported (${sizeInBit} bits at offset ${offset})`);
    if (type.signed && v < 0) img.writeIntBE(v, offset, bytes);
    else img.writeUIntBE(v, offset, bytes);
  } else {
    if (offset >= img.length) return;
    // A sub-byte field crossing a byte boundary; ETS never allocates these, so refuse
    // rather than silently truncate the high bits into one byte.
    if (bit + sizeInBit > 8) throw new Error(`bit field crossing a byte boundary not supported (${sizeInBit} bits at bit ${bit})`);
    const mask = (1 << sizeInBit) - 1;
    img[offset] = (img[offset] & ~(mask << bit)) | ((v & mask) << bit);
  }
}

// Inverse of encode. Returns the decoded value as a string, or undefined for
// anything not represented in the image (text/time/other, or a layout the encoder
// would refuse). Read-back is best-effort, so it skips rather than throws.
function decode(img: Buffer, offset: number, bit: number, type: ParamType): string | undefined {
  if (!Number.isFinite(offset)) return undefined;
  if (type.base === "Float") {
    if (type.sizeInBit === 32) return offset + 4 > img.length ? undefined : String(img.readFloatBE(offset));
    return offset + 2 > img.length ? undefined : String(decodeDpt9(img.readUInt16BE(offset)));
  }
  if (type.base !== "Value" && type.base !== "Number") return undefined; // text/time/other
  const sizeInBit = type.sizeInBit;
  if (sizeInBit >= 8) {
    const bytes = sizeInBit >> 3;
    if (bytes > 6 || offset + bytes > img.length) return undefined; // mirror encode's refusal
    return String(type.signed ? img.readIntBE(offset, bytes) : img.readUIntBE(offset, bytes));
  }
  if (offset >= img.length || bit + sizeInBit > 8) return undefined;
  const mask = (1 << sizeInBit) - 1;
  let v = (img[offset] >> bit) & mask;
  if (type.signed && v & (1 << (sizeInBit - 1))) v -= 1 << sizeInBit; // two's complement
  return String(v);
}
