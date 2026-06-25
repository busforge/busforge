import { test, expect, describe } from "bun:test";
import { buildParameterImage, decodeParameterImage } from "../src/image.ts";
import type { AppModel, ParamType, Param, ParamRef, ParamBase } from "../src/application.ts";

// Exhaustive codec coverage for the image path: every integer width and sign, the
// bitfield placement (non-zero bit offsets), both KNX float encodings, the
// not-represented types (Text/Other), and multi-segment routing. The real-catalogue
// suite pins manufacturer data; this pins the byte-level contract precisely with
// hand-built models, including paths real fixtures may not exercise.

const SEG = 64;
function mk(types: Record<string, Partial<ParamType>>, params: Record<string, { type: string; offset: number; bit?: number; value?: string }>, segs = [{ id: "S", lsm: 4, size: SEG, data: Buffer.alloc(SEG) }]): AppModel {
  const t = new Map<string, ParamType>(Object.entries(types).map(([id, p]) => [id, { id, base: "Number" as ParamBase, sizeInBit: 8, signed: false, ...p }]));
  const p = new Map<string, Param>(Object.entries(params).map(([id, d]) => [id, { id, typeId: d.type, offset: d.offset, bitOffset: d.bit ?? 0, value: d.value }]));
  const r = new Map<string, ParamRef>([...p.keys()].map((id) => [`R-${id}`, { id: `R-${id}`, paramId: id }]));
  return { mask: "MV", manufacturer: 0, appNumber: 0, version: 0, types: t, params: p, refs: r, segments: segs };
}
const buildHex = (m: AppModel, vals: Record<string, string> = {}) =>
  buildParameterImage(m, 4, new Map(Object.entries(vals))).toString("hex");
const roundtrip = (m: AppModel, vals: Record<string, string>) => {
  const img = buildParameterImage(m, 4, new Map(Object.entries(vals)));
  return Object.fromEntries(decodeParameterImage(m, 4, img));
};

describe("integer widths and sign (big-endian)", () => {
  const m = mk(
    { Tu8: { sizeInBit: 8 }, Ts8: { sizeInBit: 8, signed: true }, Tu16: { sizeInBit: 16 }, Ts16: { sizeInBit: 16, signed: true },
      Tu24: { sizeInBit: 24 }, Ts24: { sizeInBit: 24, signed: true }, Tu32: { sizeInBit: 32 }, Tu40: { sizeInBit: 40 }, Tu48: { sizeInBit: 48 } },
    { Pu8: { type: "Tu8", offset: 0 }, Ps8: { type: "Ts8", offset: 1 }, Pu16: { type: "Tu16", offset: 2 }, Ps16: { type: "Ts16", offset: 4 },
      Pu24: { type: "Tu24", offset: 6 }, Ps24: { type: "Ts24", offset: 9 }, Pu32: { type: "Tu32", offset: 12 }, Pu40: { type: "Tu40", offset: 16 }, Pu48: { type: "Tu48", offset: 21 } },
  );

  test("exact big-endian byte layout", () => {
    expect(buildHex(m, { "R-Pu24": "66051" /*0x010203*/ }).slice(12, 18)).toBe("010203");
    expect(buildHex(m, { "R-Ps24": "-1" }).slice(18, 24)).toBe("ffffff");
    expect(buildHex(m, { "R-Pu32": "3735928559" /*0xDEADBEEF*/ }).slice(24, 32)).toBe("deadbeef");
    expect(buildHex(m, { "R-Pu40": "4328719365" /*0x0102030405*/ }).slice(32, 42)).toBe("0102030405");
  });

  test("round-trips every width and sign, incl. negatives and high-unsigned", () => {
    const vals = { "R-Pu8": "200", "R-Ps8": "-128", "R-Pu16": "65535", "R-Ps16": "-5", "R-Pu24": "16777215",
      "R-Ps24": "-8388608", "R-Pu32": "4294967295", "R-Pu40": "1099511627775", "R-Pu48": "281474976710655" };
    expect(roundtrip(m, vals)).toMatchObject(vals);
  });
});

describe("bitfields at non-zero bit offsets", () => {
  const m = mk(
    { Tb1: { base: "Value", sizeInBit: 1 }, Tb2: { base: "Value", sizeInBit: 2 }, Tb3: { base: "Value", sizeInBit: 3 }, Tb4: { base: "Value", sizeInBit: 4 } },
    { Pa: { type: "Tb1", offset: 0, bit: 0 }, Pb: { type: "Tb3", offset: 0, bit: 2 }, Pc: { type: "Tb1", offset: 0, bit: 7 }, Pd: { type: "Tb4", offset: 1, bit: 4 } },
  );
  test("packs multiple fields into the right bits of a byte", () => {
    // MSB-first (KNX big-endian bit order), shift = 8 - bitOffset - width:
    // Pa(1b@bit0)=1 -> 0x80, Pb(3b@bit2)=5 -> 0b101<<3 = 0x28, Pc(1b@bit7)=1 -> 0x01
    // -> 0x80|0x28|0x01 = 0xA9
    expect(buildHex(m, { "R-Pa": "1", "R-Pb": "5", "R-Pc": "1" }).slice(0, 2)).toBe("a9");
    // 4-bit field 0xD at bit4 (MSB-first) -> shift 0 -> low nibble -> 0x0D
    expect(buildHex(m, { "R-Pd": "13" }).slice(2, 4)).toBe("0d");
  });
  test("round-trips each field independently", () => {
    expect(roundtrip(m, { "R-Pa": "1", "R-Pb": "5", "R-Pc": "1", "R-Pd": "9" })).toMatchObject({ "R-Pa": "1", "R-Pb": "5", "R-Pc": "1", "R-Pd": "9" });
  });
});

describe("float encodings", () => {
  const m = mk(
    { T9: { base: "Float", sizeInBit: 16 }, T14: { base: "Float", sizeInBit: 32 } },
    { P9: { type: "T9", offset: 0 }, P14: { type: "T14", offset: 2 } },
  );
  test("DPT9 (2-byte) places and round-trips negatives and the max value", () => {
    expect(buildHex(m, { "R-P9": "21.5" }).slice(0, 4)).toBe("0c33");
    for (const v of ["0", "-0.01", "-5.12", "670760.96"]) // 670760.96 is the DPT9 max (exact)
      expect(roundtrip(m, { "R-P9": v })["R-P9"]).toBe(v);
  });
  test("DPT9 saturates beyond its representable range", () => {
    expect(Number(roundtrip(m, { "R-P9": "1000000000" })["R-P9"])).toBe(670760.96);
  });
  test("DPT14 (4-byte IEEE-754) places and round-trips", () => {
    expect(buildHex(m, { "R-P14": "1.5" }).slice(4, 12)).toBe("3fc00000");
    expect(Number(roundtrip(m, { "R-P14": "-273.15" })["R-P14"])).toBeCloseTo(-273.15, 2);
  });
});

describe("types not represented in the image are neither written nor decoded", () => {
  const def = Buffer.alloc(SEG); def.fill(0xee, 0, 8); // recognizable default
  const m = mk(
    { Ttext: { base: "Text", sizeInBit: 112 }, Tother: { base: "Other", sizeInBit: 32 } },
    { Ptext: { type: "Ttext", offset: 0, value: "hello" }, Pother: { type: "Tother", offset: 14, value: "abc" } },
    [{ id: "S", lsm: 4, size: SEG, data: def }],
  );
  test("Text/Other params leave their bytes at the segment default and are absent from decode", () => {
    const img = buildParameterImage(m, 4, new Map());
    expect(img.subarray(0, 8).toString("hex")).toBe("eeeeeeeeeeeeeeee"); // unwritten
    const decoded = decodeParameterImage(m, 4, img);
    expect(decoded.has("R-Ptext")).toBe(false);
    expect(decoded.has("R-Pother")).toBe(false);
  });

  // Regression for the MDT IP-interface crash: a Text param whose value coerces to a
  // finite number (the empty string -> 0, or a numeric-looking string) must NOT be
  // integer-encoded. The old encoder did Number("")===0 and tried to write a wide
  // integer (e.g. 30 bytes for a 240-bit text), throwing and aborting the flash.
  test("a Text param with a numeric-looking or empty value is never integer-encoded (no crash)", () => {
    const big = mk(
      { Ttext240: { base: "Text", sizeInBit: 240 } },
      { Pempty: { type: "Ttext240", offset: 0, value: "" }, Pnum: { type: "Ttext240", offset: 30, value: "123" } },
      [{ id: "S", lsm: 4, size: SEG, data: Buffer.alloc(SEG).fill(0xcd) }],
    );
    let img!: Buffer;
    expect(() => { img = buildParameterImage(big, 4, new Map()); }).not.toThrow();
    // both text fields stay at the segment default; neither value leaked into bytes
    expect(img.subarray(0, 60).every((b) => b === 0xcd)).toBe(true);
    expect(decodeParameterImage(big, 4, img).size).toBe(0);
  });
});

describe("multi-segment routing", () => {
  const m = mk(
    { Tu8: { sizeInBit: 8 } },
    { Pa: { type: "Tu8", offset: 0 }, Pb: { type: "Tu8", offset: 0 } },
    [{ id: "S3", lsm: 3, size: 4, data: Buffer.alloc(4) }, { id: "S4", lsm: 4, size: 4, data: Buffer.alloc(4) }],
  );
  // route each param to a specific segment via codeSegment
  m.params.get("Pa")!.codeSegment = "S3";
  m.params.get("Pb")!.codeSegment = "S4";
  test("a param is only written into the segment its codeSegment names", () => {
    // Both refs set, but building LSM 4 places only Pb (codeSegment S4); Pa (S3) is skipped.
    const built4 = buildParameterImage(m, 4, new Map([["R-Pa", "170"], ["R-Pb", "187"]]));
    expect(built4[0]).toBe(187);
    const dec4 = decodeParameterImage(m, 4, built4);
    expect(dec4.has("R-Pb")).toBe(true);
    expect(dec4.has("R-Pa")).toBe(false);
  });
});

describe("malformed or unsupported layouts degrade safely (no silent corruption)", () => {
  const seg = (data = Buffer.alloc(4)) => [{ id: "S", lsm: 4, size: data.length, data }];
  test("a non-finite type size is skipped, leaving the bytes untouched", () => {
    const m = mk({ Tbad: { sizeInBit: NaN as unknown as number } }, { P: { type: "Tbad", offset: 0, value: "5" } }, seg(Buffer.alloc(4).fill(0xaa)));
    const img = buildParameterImage(m, 4, new Map());
    expect(img.toString("hex")).toBe("aaaaaaaa");
    expect(decodeParameterImage(m, 4, img).size).toBe(0);
  });
  test("a non-finite offset is skipped, not crashing", () => {
    const m = mk({ Tu8: { sizeInBit: 8 } }, { P: { type: "Tu8", offset: NaN as unknown as number, value: "5" } }, seg());
    expect(() => buildParameterImage(m, 4, new Map())).not.toThrow();
  });
  test("a malformed segment size is a clear error, not a cryptic Buffer crash", () => {
    const m = mk({ Tu8: { sizeInBit: 8 } }, { P: { type: "Tu8", offset: 0 } }, [{ id: "S", lsm: 4, size: NaN as unknown as number, data: Buffer.alloc(0) }]);
    expect(() => buildParameterImage(m, 4, new Map())).toThrow(/malformed segment size/);
  });
  // ETS never allocates a sub-byte field across a byte boundary; refuse loudly rather
  // than silently truncate the high bits (a wrong-bytes flash). This is a by-design
  // refusal of an impossible input, not a deferred bug.
  test("a straddling bit field is refused, not silently truncated", () => {
    const m = mk({ Tb3: { base: "Value", sizeInBit: 3 } }, { P: { type: "Tb3", offset: 0, bit: 6 } }, seg());
    expect(() => buildParameterImage(m, 4, new Map([["R-P", "5"]]))).toThrow(/byte boundary/);
  });
  test("an integer type wider than 48 bits is refused rather than emitting cryptic/truncated bytes", () => {
    const m = mk({ Tw: { base: "Number", sizeInBit: 64 } }, { P: { type: "Tw", offset: 0 } }, seg(Buffer.alloc(16)));
    expect(() => buildParameterImage(m, 4, new Map([["R-P", "1"]]))).toThrow(/wider than 48 bits/);
  });
});

describe("IPAddress codec (4-byte host address)", () => {
  const m = mk({ Tip: { base: "IPAddress", sizeInBit: 32 } }, { P: { type: "Tip", offset: 2 } }, [{ id: "S", lsm: 4, size: 8, data: Buffer.alloc(8) }]);
  test("encodes a dotted quad as 4 big-endian bytes at the offset", () => {
    expect(buildHex(m, { "R-P": "203.0.113.1" }).slice(4, 12)).toBe("cb007101");
    expect(buildHex(m, { "R-P": "255.255.255.0" }).slice(4, 12)).toBe("ffffff00");
  });
  test("round-trips dotted-quad values", () => {
    expect(roundtrip(m, { "R-P": "203.0.113.255" })).toEqual({ "R-P": "203.0.113.255" });
    expect(roundtrip(m, { "R-P": "0.0.0.0" })).toEqual({ "R-P": "0.0.0.0" });
  });
  test("a malformed address writes nothing (owns no bytes)", () => {
    // Octet out of range, wrong part count, and non-numeric all leave the segment blank.
    for (const bad of ["256.0.0.1", "1.2.3", "1.2.3.4.5", "a.b.c.d", ""]) {
      expect(buildHex(m, { "R-P": bad })).toBe("0000000000000000");
    }
  });
});

describe("multiple refs to one param", () => {
  const m = mk({ Tu8: { sizeInBit: 8 } }, { P: { type: "Tu8", offset: 0 } });
  m.refs.set("R-b", { id: "R-b", paramId: "P" }); // a second ref to the same param
  test("both refs decode to the value at the shared offset", () => {
    const img = buildParameterImage(m, 4, new Map([["R-P", "42"]]));
    const dec = decodeParameterImage(m, 4, img);
    expect(dec.get("R-P")).toBe("42");
    expect(dec.get("R-b")).toBe("42");
  });
});
