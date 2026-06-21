import type { AppModel } from "./application.ts";

// Build the parameter memory image for a load-state-machine segment from the
// default segment data plus the effective parameter values. Effective value =
// device instance value (if set) else parameter-ref value else parameter default.
export function buildParameterImage(model: AppModel, lsm: number, instanceValues: Map<string, string>): Buffer {
  const seg = model.segments.find((s) => s.lsm === lsm);
  if (!seg) throw new Error(`no segment for LSM ${lsm}`);
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
    if (!type || type.sizeInBit === 0) continue;
    encode(img, param.offset, param.bitOffset, type.sizeInBit, type.signed, v);
  }
  return img;
}

function encode(img: Buffer, offset: number, bit: number, sizeInBit: number, signed: boolean, valStr: string) {
  const v = Number(valStr);
  if (!Number.isFinite(v)) return; // text/other params: skip for now
  if (sizeInBit >= 8) {
    const bytes = sizeInBit >> 3;
    if (offset + bytes > img.length) return;
    if (signed && v < 0) img.writeIntBE(v, offset, bytes);
    else img.writeUIntBE(v >>> 0 === v ? v : v, offset, bytes);
  } else {
    if (offset >= img.length) return;
    const mask = (1 << sizeInBit) - 1;
    img[offset] = (img[offset] & ~(mask << bit)) | ((v & mask) << bit);
  }
}
