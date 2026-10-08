import { test, expect, describe } from "bun:test";
import { buildParameterImage, decodeParameterImage } from "../src/image.ts";
import type { AppModel, ParamType, Param, ParamRef, ParamBase } from "../src/application.ts";

// Exhaustive codec coverage for the image path: every integer width and sign, the
// bitfield placement (non-zero bit offsets), both KNX float encodings, the
// text parameters, the not-represented types (Other), and multi-segment routing. The real-catalogue
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
  const def = Buffer.alloc(SEG); def.fill(0xee, 0, 18); // recognizable default
  const m = mk(
    { Tother: { base: "Other", sizeInBit: 32 } },
    { Pother: { type: "Tother", offset: 14, value: "abc" } },
    [{ id: "S", lsm: 4, size: SEG, data: def }],
  );
  test("Other params leave their bytes at the segment default and are absent from decode", () => {
    const img = buildParameterImage(m, 4, new Map());
    expect(img.subarray(14, 18).toString("hex")).toBe("eeeeeeee"); // unwritten
    expect(decodeParameterImage(m, 4, img).has("R-Pother")).toBe(false);
  });
});

// A text parameter's field holds its ASCII characters and zero bytes to the end. Evidence: ETS's image of
// the Theben DALI-Gateway KNX plus's full download, admin password "dali" in 8 bytes = 64 61 6c 69 00 00 00 00
// (private corpus captures/dali-ets6log-fulldownload-real.txt l. 581; on the wire dali-ets-fulldownload-real.log
// writes 64 61 6c 69 at 0x5C48). Every other expectation here is a refusal of what no capture shows.
describe("text parameters", () => {
  const m = () => mk(
    { Ttext: { base: "Text", sizeInBit: 64 }, Ttext240: { base: "Text", sizeInBit: 240 } },
    { Ptext: { type: "Ttext", offset: 0, value: "dali" }, Pempty: { type: "Ttext240", offset: 8, value: "" }, Pnum: { type: "Ttext240", offset: 38, value: "123" } },
    [{ id: "S", lsm: 4, size: 68, data: Buffer.alloc(68) }], // the fields start empty, as in the DALI capture
  );
  // The DALI capture's field: "dali" and four zero bytes. Its empty text field P-822 at +3136..3143 is
  // all zero in the same row (l. 581).
  test("the characters, then zero bytes to the end of the field; an empty value is all zero", () => {
    const img = buildParameterImage(m(), 4, new Map());
    expect(img.subarray(0, 8).toString("hex")).toBe("64616c6900000000");
    expect(img.subarray(8, 38).every((b) => b === 0)).toBe(true);
  });
  // Regression for the MDT IP-interface crash: a numeric-looking text value is text, never an integer
  // (the old encoder did Number("123") and tried to write a 30-byte integer). Same rule as above.
  test("a numeric-looking value is written as its characters", () => {
    const img = buildParameterImage(m(), 4, new Map());
    expect(img.subarray(38, 42).toString("hex")).toBe("31323300");
    expect(img.subarray(42, 68).every((b) => b === 0)).toBe(true);
  });
  test("decode returns what encode wrote", () => {
    expect(roundtrip(m(), { "R-Ptext": "admin", "R-Pempty": "x", "R-Pnum": "1.2.3" })).toMatchObject({ "R-Ptext": "admin", "R-Pempty": "x", "R-Pnum": "1.2.3" });
  });
  test("a field without a closing zero, with a byte beyond ASCII, or with bytes behind the zero, decodes to nothing", () => {
    const img = Buffer.alloc(68);
    img.write("12345678", 0, "latin1");
    img.write("ab\0xyz", 38, "latin1");
    img.write("K\xfcche", 8, "latin1");
    const out = decodeParameterImage(m(), 4, img);
    expect(out.has("R-Ptext")).toBe(false);
    expect(out.has("R-Pempty")).toBe(false);
    expect(out.has("R-Pnum")).toBe(false);
  });
  test("a value that leaves no closing zero byte is refused", () => {
    expect(() => buildParameterImage(m(), 4, new Map([["R-Ptext", "1234567"]]))).not.toThrow();
    expect(() => buildParameterImage(m(), 4, new Map([["R-Ptext", "12345678"]]))).toThrow(/at most 7/);
  });
  test("a character beyond ASCII, or a zero character, is refused", () => {
    expect(() => buildParameterImage(m(), 4, new Map([["R-Ptext", "Küche"]]))).toThrow(/beyond ASCII/);
    expect(() => buildParameterImage(m(), 4, new Map([["R-Ptext", "a\0b"]]))).toThrow(/zero character/);
  });
  // MDT A-0137's <Data> holds "Statuselement00" where the parameter's default is "": no capture shows which
  // ETS writes. A <Data> that holds the default's own bytes is no conflict, whatever value is written.
  test("a field whose <Data> disagrees with the parameter's default is refused, whatever the value", () => {
    const filled = (data: string) => mk({ T: { base: "Text", sizeInBit: 64 } }, { P: { type: "T", offset: 0, value: "dali" } },
      [{ id: "S", lsm: 4, size: 8, data: Buffer.from(data, "hex") }]);
    expect(() => buildParameterImage(filled("5374617475730000"), 4, new Map())).toThrow(/holds 5374617475730000 in its field/);
    expect(() => buildParameterImage(filled("5374617475730000"), 4, new Map([["R-P", "Status"]]))).toThrow(/holds 5374617475730000/);
    expect(buildParameterImage(filled("64616c6900000000"), 4, new Map()).toString("hex")).toBe("64616c6900000000");
    expect(buildParameterImage(filled("64616c6900000000"), 4, new Map([["R-P", "admin"]])).toString("hex")).toBe("61646d696e000000");
  });
  // The check reads the segment's <Data>, not the image being built: two refs of one parameter, one at a new value,
  // pass in either order.
  test("the <Data> check does not depend on the order the parameters are encoded in", () => {
    for (const order of [["R1", "R2"], ["R2", "R1"]]) {
      const m = mk({ T: { base: "Text", sizeInBit: 64 } }, { P: { type: "T", offset: 0, value: "dali" } });
      m.refs = new Map(order.map((id) => [id, { id, paramId: "P" }]));
      expect(() => buildParameterImage(m, 4, new Map([["R1", "admin"]]))).not.toThrow();
    }
  });
  test("a field that is not whole bytes from bit 0 is refused", () => {
    const odd = mk({ T: { base: "Text", sizeInBit: 12 } }, { P: { type: "T", offset: 0, value: "a" } });
    expect(() => buildParameterImage(odd, 4, new Map())).toThrow(/no known byte layout/);
    const shifted = mk({ T: { base: "Text", sizeInBit: 16 } }, { P: { type: "T", offset: 0, bit: 4, value: "a" } });
    expect(() => buildParameterImage(shifted, 4, new Map())).toThrow(/no known byte layout/);
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
  // This used to assert a REFUSAL, on the premise that "ETS never allocates a sub-byte field
  // across a byte boundary". A real product database disproved it: OpenKNX packs fields exactly
  // that way (and the Theben 493B has 11-bit fields at BitOffset 5). The codec now places any
  // field MSB-first across the bytes it spans, so the straddling case is programmed correctly
  // instead of refused. See image.test.ts for the wide non-aligned cases.
  test("a straddling bit field is placed across the boundary, MSB-first", () => {
    const m = mk({ Tb3: { base: "Value", sizeInBit: 3 } }, { P: { type: "Tb3", offset: 0, bit: 6 } }, seg());
    const img = buildParameterImage(m, 4, new Map([["R-P", "5"]])); // 5 = 0b101 over bits 6..8
    expect(img[0] & 0x03).toBe(0b10); // the field's top 2 bits close out byte 0
    expect(img[1] & 0x80).toBe(0b1 << 7); // its last bit opens byte 1
    expect(decodeParameterImage(m, 4, img).get("R-P")).toBe("5");
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

// An application may declare <Options ParameterByteOrder="LittleEndian"> (the ABB US/U 4.2 does):
// ETS then writes a multi-byte parameter least significant byte first (its LED flash time 450 went
// out as c2 01 in an ETS partial download, 2026-09-26).
describe("little-endian parameter byte order", () => {
  const le = { littleEndian: true };
  const m = mk(
    { Tu16: { sizeInBit: 16, ...le }, Ts16: { sizeInBit: 16, signed: true, ...le }, Tu24: { sizeInBit: 24, ...le }, Tu8: { sizeInBit: 8, ...le }, Tb4: { sizeInBit: 4, ...le } },
    { Pu16: { type: "Tu16", offset: 0 }, Ps16: { type: "Ts16", offset: 2 }, Pu24: { type: "Tu24", offset: 4 }, Pu8: { type: "Tu8", offset: 7 }, Pb4: { type: "Tb4", offset: 8, bit: 4 } },
  );
  test("a byte-aligned multi-byte value is written least significant byte first", () => {
    expect(buildHex(m, { "R-Pu16": "450" }).slice(0, 4)).toBe("c201");
    expect(buildHex(m, { "R-Ps16": "-2" }).slice(4, 8)).toBe("feff");
    expect(buildHex(m, { "R-Pu24": "66051" }).slice(8, 14)).toBe("030201");
  });
  test("single-byte and in-byte fields are unaffected, and every value reads back", () => {
    expect(buildHex(m, { "R-Pu8": "171", "R-Pb4": "5" }).slice(14, 18)).toBe("ab05");
    expect(roundtrip(m, { "R-Pu16": "450", "R-Ps16": "-2", "R-Pu24": "66051", "R-Pu8": "171", "R-Pb4": "5" })).toMatchObject({ "R-Pu16": "450", "R-Ps16": "-2", "R-Pu24": "66051", "R-Pu8": "171", "R-Pb4": "5" });
  });
  test("a field that crosses a byte boundary without being byte-aligned is refused: its little-endian layout is unknown", () => {
    const x = mk({ Tu12: { sizeInBit: 12, ...le } }, { Pu12: { type: "Tu12", offset: 0, bit: 2 } });
    expect(() => buildHex(x, { "R-Pu12": "5" })).toThrow(/little-endian/);
  });
  test("a float or an IP address is refused: no capture shows how ETS orders its bytes", () => {
    const x = mk({ Tf: { base: "Float", sizeInBit: 16, ...le }, Tip: { base: "IPAddress", sizeInBit: 32, ...le } }, { Pf: { type: "Tf", offset: 0 }, Pip: { type: "Tip", offset: 4 } });
    expect(() => buildHex(x, { "R-Pf": "1.5" })).toThrow(/little-endian/);
    expect(() => buildHex(x, { "R-Pip": "203.0.113.11" })).toThrow(/little-endian/);
  });
});
