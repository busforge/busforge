import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { KnxprojError } from "../src/errors.ts";
import { decodeCheckSums, decodeLoadedImage } from "../src/loadedimage.ts";

// Attributes built from the layout ETS writes (docs/verification.md, "ETS's download record"):
// LoadedImage = base64(raw deflate([u16 1][u16 1][u32 count] then per record
// [u32 kind][u16 object][u16 pid][u32 start][u32 length][u8 content][data][mask])), little-endian.
interface Rec { kind: number; object: number; pid: number; start: number; data: number[]; mask: number[]; content?: number }
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const imageBytes = (recs: Rec[], version = [1, 1]) => Buffer.concat([
  u16(version[0]), u16(version[1]), u32(recs.length),
  ...recs.flatMap((r) => [u32(r.kind), u16(r.object), u16(r.pid), u32(r.start), u32(r.data.length), Buffer.from([r.content ?? 3]), Buffer.from(r.data), Buffer.from(r.mask)]),
]);
const image = (raw: Buffer) => deflateRawSync(raw).toString("base64");
// CheckSums = base64([u16 1][u16 1][u32 flavour][u32 count] then per object [u8 object][u32 n] and n x [u8 flag][u16 crc]).
const sums = (objects: { object: number; regions: [number, number][] }[], flavour = 1) => Buffer.concat([
  u16(1), u16(1), u32(flavour), u32(objects.length),
  ...objects.flatMap((o) => [Buffer.from([o.object]), u32(o.regions.length), ...o.regions.map(([flag, crc]) => Buffer.concat([Buffer.from([flag]), u16(crc)]))]),
]).toString("base64");

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(KnxprojError); return (e as KnxprojError).code; }
  return expect.unreachable("expected a refusal") as never;
}

describe("LoadedImage", () => {
  test("a relative record per segment and an absolute one per address, each with its mask", () => {
    const recs = decodeLoadedImage(image(imageBytes([
      { kind: 12, object: 3, pid: 7, start: 0, data: [0, 2, 0x4f, 0x07], mask: [0xff, 0xff, 0xff, 0xff] },
      { kind: 12, object: 4, pid: 7, start: 26, data: [9, 0], mask: [0xff, 0x00] },
      { kind: 1, object: 0, pid: 0, start: 0x444e, data: [1, 0, 0x30], mask: [0xff, 0xff, 0x00] },
    ])));
    expect(recs.map((r) => ({ ...r, data: [...r.data], mask: [...r.mask] }))).toEqual([
      { location: "relative", object: 3, start: 0, data: [0, 2, 0x4f, 0x07], mask: [0xff, 0xff, 0xff, 0xff] },
      { location: "relative", object: 4, start: 26, data: [9, 0], mask: [0xff, 0x00] },
      { location: "absolute", object: 0, start: 0x444e, data: [1, 0, 0x30], mask: [0xff, 0xff, 0x00] },
    ]);
  });

  test("an attribute that is no base64 or no deflate stream is refused", () => {
    expect(codeOf(() => decodeLoadedImage("not base64!"))).toBe("LOADED_IMAGE_INVALID");
    expect(codeOf(() => decodeLoadedImage(""))).toBe("LOADED_IMAGE_INVALID");
    expect(codeOf(() => decodeLoadedImage(Buffer.from("plain bytes, no deflate").toString("base64")))).toBe("LOADED_IMAGE_INVALID");
  });

  test("lengths that do not add up to the attribute are refused, short or long", () => {
    const whole = imageBytes([{ kind: 12, object: 4, pid: 7, start: 0, data: [1, 2, 3], mask: [0xff, 0xff, 0xff] }]);
    expect(codeOf(() => decodeLoadedImage(image(whole.subarray(0, whole.length - 1))))).toBe("LOADED_IMAGE_INVALID");
    expect(codeOf(() => decodeLoadedImage(image(Buffer.concat([whole, Buffer.from([0])]))))).toBe("LOADED_IMAGE_INVALID");
    // bytes after the deflate stream
    expect(codeOf(() => decodeLoadedImage(Buffer.concat([deflateRawSync(whole), Buffer.from("junk")]).toString("base64")))).toBe("LOADED_IMAGE_INVALID");
    // a count that promises a record the attribute does not hold
    const twice = Buffer.from(whole); twice.writeUInt32LE(2, 4);
    expect(codeOf(() => decodeLoadedImage(image(twice)))).toBe("LOADED_IMAGE_INVALID");
  });

  test("every record the corpus does not show is refused, not skipped", () => {
    const one = (r: Partial<Rec>) => image(imageBytes([{ kind: 12, object: 4, pid: 7, start: 0, data: [1], mask: [0xff], ...r }]));
    expect(codeOf(() => decodeLoadedImage(one({ kind: 5, object: 6, pid: 54 })))).toBe("LOADED_IMAGE_UNSUPPORTED"); // a property value
    expect(codeOf(() => decodeLoadedImage(one({ kind: 4 })))).toBe("LOADED_IMAGE_UNSUPPORTED");
    expect(codeOf(() => decodeLoadedImage(one({ kind: 1, object: 3, pid: 0 })))).toBe("LOADED_IMAGE_UNSUPPORTED");
    expect(codeOf(() => decodeLoadedImage(one({ pid: 5 })))).toBe("LOADED_IMAGE_UNSUPPORTED");
    expect(codeOf(() => decodeLoadedImage(one({ object: 1 })))).toBe("LOADED_IMAGE_UNSUPPORTED"); // the address table
    expect(codeOf(() => decodeLoadedImage(one({ content: 1 })))).toBe("LOADED_IMAGE_UNSUPPORTED"); // data without a mask
    expect(codeOf(() => decodeLoadedImage(one({ mask: [0x0f] })))).toBe("LOADED_IMAGE_UNSUPPORTED");
    expect(codeOf(() => decodeLoadedImage(image(imageBytes([], [2, 0]))))).toBe("LOADED_IMAGE_UNSUPPORTED");
  });
});

describe("CheckSums", () => {
  test("one CRC per memory-control-block region, per object, with its flag", () => {
    expect(decodeCheckSums(sums([{ object: 3, regions: [[1, 0x2416]] }, { object: 4, regions: [[1, 0xba8f], [0, 0xdcbd]] }]))).toEqual([
      { object: 3, regions: [{ flag: 1, crc: 0x2416 }] },
      { object: 4, regions: [{ flag: 1, crc: 0xba8f }, { flag: 0, crc: 0xdcbd }] },
    ]);
  });

  test("another flavour, an unknown flag and lengths that do not add up are refused", () => {
    expect(codeOf(() => decodeCheckSums(sums([{ object: 6, regions: [[1, 1]] }], 3)))).toBe("CHECKSUMS_UNSUPPORTED");
    expect(codeOf(() => decodeCheckSums(sums([{ object: 4, regions: [[2, 1]] }])))).toBe("CHECKSUMS_UNSUPPORTED");
    expect(codeOf(() => decodeCheckSums(sums([{ object: 2, regions: [[1, 1]] }])))).toBe("CHECKSUMS_UNSUPPORTED");
    const whole = Buffer.from(sums([{ object: 4, regions: [[1, 0x1234]] }]), "base64");
    expect(codeOf(() => decodeCheckSums(whole.subarray(0, whole.length - 1).toString("base64")))).toBe("CHECKSUMS_INVALID");
    expect(codeOf(() => decodeCheckSums(Buffer.concat([whole, Buffer.from([0, 0, 0])]).toString("base64")))).toBe("CHECKSUMS_INVALID");
    expect(codeOf(() => decodeCheckSums("%%%%"))).toBe("CHECKSUMS_INVALID");
  });
});
