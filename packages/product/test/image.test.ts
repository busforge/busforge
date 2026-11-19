import { test, expect, describe } from "bun:test";
import { buildParameterImage, decodeParameterImage, encodeDpt9, decodeDpt9 } from "../src/image.ts";
import { unmappedParamRefs } from "../src/application.ts";
import { parseAppConfig, parseLoadProcedures, classify, resolveModuleInstances, takesValue } from "../src/index.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusTest } from "../../../tools/corpus-test.ts";
import type { AppModel, ParamType, Param, ParamRef } from "../src/application.ts";
import type { CfgType } from "../src/appconfig.ts";

// A minimal application model covering one of each codec path: a bit-field enum,
// an unsigned byte, a signed 16-bit, a 2-byte DPT-9 float, and a text param.
function model(): AppModel {
  const t = (id: string, p: Partial<ParamType>): [string, ParamType] => [id, { id, base: "Number", sizeInBit: 8, signed: false, ...p }];
  const types = new Map<string, ParamType>([
    t("T-enum", { base: "Value", sizeInBit: 2 }),
    t("T-u8", { base: "Number", sizeInBit: 8 }),
    t("T-s16", { base: "Number", sizeInBit: 16, signed: true }),
    t("T-float", { base: "Float", sizeInBit: 16 }),
    t("T-text", { base: "Text", sizeInBit: 80 }),
  ]);
  const p = (id: string, typeId: string, offset: number, value: string, bitOffset = 0): [string, Param] => [id, { id, typeId, value, offset, bitOffset }];
  const params = new Map<string, Param>([
    p("P-enum", "T-enum", 0, "0"),
    p("P-u8", "T-u8", 1, "0"),
    p("P-s16", "T-s16", 2, "0"),
    p("P-float", "T-float", 4, "0"),
    p("P-text", "T-text", 6, "x"),
  ]);
  const refs = new Map<string, ParamRef>(
    [...params.keys()].map((id) => [`R-${id}`, { id: `R-${id}`, paramId: id }]),
  );
  return { mask: "MV-TEST", manufacturer: 0, appNumber: 0, version: 0, types, params, refs, segments: [{ id: "S", lsm: 4, size: 32, data: Buffer.alloc(32) }] };
}

describe("DPT-9 float codec", () => {
  test("known reference vectors", () => {
    expect(encodeDpt9(0)).toBe(0x0000);
    expect(encodeDpt9(21)).toBe(0x0c1a);
    expect(encodeDpt9(-0.01)).toBe(0x87ff);
    expect(decodeDpt9(0x0000)).toBe(0);
    expect(decodeDpt9(0x0c1a)).toBe(21);
    expect(decodeDpt9(0x87ff)).toBe(-0.01);
  });

  test("rounds as ETS writes it: smallest exponent, mantissa rounded once from the decimal value", () => {
    // ETS 6.4.1 downloading the MDT BE-02001.02 (M-0083_A-00B6), input B "Werte senden", DPT 9.004, 1000 Lux:
    // 100000 / 2^6 = 1562.5 -> 1562 = 0x61A, written at 0x44A6 (private corpus
    // internal/captures/progmode-end-2026-11-19/h1-mdt-lux1000-download.log line 351:
    // MEMORY_WRITE 44a4 001d361a0000010000000000).
    expect(encodeDpt9(1000)).toBe(0x361a);
    // Ties to even in both directions and on both signs: ETS 6.4.1, the same input B as
    // "Werte/Szenen umschalten" with four values at 0x44A6, 0x44AA, 0x44AE, 0x44B2 (private corpus
    // internal/captures/restart-end-2026-11-19/, lines 351, 359 and 367 of each log).
    // b1-mdt-lux-ties-download.log, DPT 9.004:
    expect(encodeDpt9(20.51)).toBe(0x0c02); // 2051 / 2 = 1025.5 -> 1026 (half-down: 0C01)
    expect(encodeDpt9(20.53)).toBe(0x0c02); // 2053 / 2 = 1026.5 -> 1026 (half-up: 0C03)
    expect(encodeDpt9(41.02)).toBe(0x1402); // 4102 / 4 = 1025.5 -> 1026
    expect(encodeDpt9(41.03)).toBe(0x1402); // 4103 / 4 = 1025.75 -> 1026 (truncation: 1401)
    // b2-mdt-temp-neg-ties-download.log, DPT 9.001: the magnitude rounds as above, then takes the sign.
    expect(encodeDpt9(-20.51)).toBe(0x8bfe); // -1025.5 -> -1026 (toward zero: 8BFF)
    expect(encodeDpt9(-20.53)).toBe(0x8bfe); // -1026.5 -> -1026 (away from zero or floor: 8BFD)
    expect(encodeDpt9(-41.02)).toBe(0x93fe);
    expect(encodeDpt9(-41.03)).toBe(0x93fe);
    // Values KNXBench reports from ETS 6.4 (its logs are private, so a lead, not our capture): 25000 tells
    // rounding from truncation, 32.45 the decimal value from the double 3245.0000000000005.
    expect(encodeDpt9(32.09)).toBe(0x0e44); // 3209 / 2 = 1604.5 -> 1604
    expect(encodeDpt9(32.45)).toBe(0x0e56); // 3245 / 2 = 1622.5 -> 1622
    expect(encodeDpt9(25000)).toBe(0x5cc5); // 2500000 / 2^11 = 1220.7 -> 1221
    expect(encodeDpt9(-12.5)).toBe(0x831e);
    // Rounded once at the final exponent: 1000000 / 2^9 = 1953.125 -> 1953.
    expect(encodeDpt9(10000)).toBe(0x4fa1);
  });

  test("refuses a value outside the range instead of saturating, 0x7FFF being DPT 9's invalid data", () => {
    // The ends of the range: the largest mantissa at exponent 15, 0x7FFF itself excluded.
    expect(encodeDpt9(670433.28)).toBe(0x7ffe);
    expect(encodeDpt9(-671088.64)).toBe(0xf800);
    for (const v of [670760.96, 670600.01, 1e9, -672000, -1e9, 1e21]) {
      expect(() => encodeDpt9(v)).toThrow(expect.objectContaining({ code: "PARAM_VALUE_OUT_OF_RANGE" }));
    }
    // Judged before the rounding: a value just beyond an end, which would round onto it, is refused too.
    for (const v of [670433.29, 670500, 670597.12, -671088.65, -671200, -671252.48]) {
      expect(() => encodeDpt9(v)).toThrow(expect.objectContaining({ code: "PARAM_VALUE_OUT_OF_RANGE" }));
    }
    expect(encodeDpt9(670433.27)).toBe(0x7ffe); // 67043327 / 2^15 = 2045.99997 -> 2046
  });

  test("a parameter takes no value the float has no code for, so a device holding 0x7FFF holds no value of it", () => {
    const type: CfgType = { id: "T", base: "Float", kind: "TypeFloat", sizeInBit: 16, signed: false, enums: [] };
    expect(takesValue(type, "1000000")).toBe(false);
    expect(takesValue(type, " 670760.96 ")).toBe(false);
    expect(takesValue(type, "21.5")).toBeUndefined();
    expect(takesValue(type, "")).toBeUndefined();
    expect(takesValue({ ...type, sizeInBit: 32 }, "1000000")).toBeUndefined();
    const img = buildParameterImage(model(), 4, new Map());
    img.writeUInt16BE(0x7fff, 4);
    const held = decodeParameterImage(model(), 4, img).get("R-P-float")!;
    expect(takesValue(type, held)).toBe(false); // what the device holds is no value of its parameter
    img.writeUInt16BE(0x7ffe, 4);
    expect(decodeParameterImage(model(), 4, img).get("R-P-float")).toBe("670433.28");
  });

  corpusTest("the MDT BE-02001.02 input B sending 1000 Lux: Busforge's image holds the 12 bytes ETS wrote", () => {
    // ETS's write (private corpus internal/captures/progmode-end-2026-11-19/h1-mdt-lux1000-download.log
    // line 351): input B "send values" (0x44A5 = 1D), DPT 9.004 Lux at its union default 1000 (0x44A6 = 36 1A).
    const A = "M-0083_A-00B6-32-9642";
    const xml = catalogueXml(`${A}.xml.gz`);
    const cfg = parseAppConfig(xml);
    const params = new Map([[`${A}_MD-2_M-3_MI-1_P-24_R-2`, "4"], [`${A}_MD-2_M-3_MI-1_P-20_R-81`, "8"]]);
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.56", params, links: [], moduleInstances: resolveModuleInstances(cfg, params), proc: parseLoadProcedures(xml) });
    const seg = build.segments.find((s) => s.address === 0x4468);
    expect(seg).toBeDefined();
    expect(seg!.image.subarray(0x44a4 - 0x4468, 0x44b0 - 0x4468).toString("hex")).toBe("001d361a0000010000000000");
  });

  test("round-trips values within DPT-9 resolution (0.01 * 2^exp)", () => {
    // Exactly representable values (small exponent); larger magnitudes quantize
    // coarser by design, which is a property of DPT 9, not a codec bug.
    for (const v of [0, 0.5, 21.5, -5.12, 100, -10.24, 20.47, -20.48]) {
      expect(decodeDpt9(encodeDpt9(v))).toBe(v);
    }
  });
});

describe("flash coverage guard (UI/storage vs image must match)", () => {
  test("flags stored refs the image model cannot place (e.g. module-instance values)", () => {
    const m = model();
    const values = new Map([
      ["R-P-u8", "5"], // a real static ref -> mappable
      ["M-X_MD-7_M-19_MI-1_P-1_R-1", "21"], // a channel/module-instance value -> not in the static model
    ]);
    expect(unmappedParamRefs(m, values)).toEqual(["M-X_MD-7_M-19_MI-1_P-1_R-1"]);
  });

  test("a fully-mappable value set is allowed (no unmapped refs)", () => {
    const m = model();
    expect(unmappedParamRefs(m, new Map([["R-P-u8", "5"], ["R-P-enum", "1"]]))).toEqual([]);
  });
});

describe("parameter image codec", () => {
  test("decodeParameterImage inverts buildParameterImage for numeric/float params", () => {
    const vals = new Map([
      ["R-P-enum", "2"],
      ["R-P-u8", "200"],
      ["R-P-s16", "-1000"],
      ["R-P-float", "21.5"],
    ]);
    const img = buildParameterImage(model(), 4, vals);
    const out = decodeParameterImage(model(), 4, img);
    expect(out.get("R-P-enum")).toBe("2");
    expect(out.get("R-P-u8")).toBe("200");
    expect(out.get("R-P-s16")).toBe("-1000");
    expect(out.get("R-P-float")).toBe("21.5");
    // The text param decodes to its characters (codec.test.ts "text parameters", evidence there).
    expect(out.get("R-P-text")).toBe("x");
  });

  test("decodes manufacturer defaults when no instance value is set", () => {
    const out = decodeParameterImage(model(), 4, buildParameterImage(model(), 4, new Map()));
    expect(out.get("R-P-u8")).toBe("0");
    expect(out.get("R-P-float")).toBe("0");
  });

  test("places sub-byte fields MSB-first (KNX big-endian bit order, hardware-verified)", () => {
    // The 2-bit enum at offset 0, BitOffset 0 must land in the TOP two bits of the
    // byte: value 3 -> 0xC0, not 0x03. Verified against real device memory
    // (an M-0048 device went 18 -> 1 byte diff when switched from LSB to MSB; M-0081's
    // byte-aligned image stayed a full match). Pins the convention against regression.
    const img = buildParameterImage(model(), 4, new Map([["R-P-enum", "3"]]));
    expect(img[0]).toBe(0xc0);
  });
});

describe("wide fields that are NOT byte-aligned (bit offset + size not a multiple of 8)", () => {
  // A KNX parameter field occupies `sizeInBit` bits starting at BitOffset, counted MSB-first
  // from the byte at Offset, and may therefore straddle byte boundaries. Manufacturer product
  // databases use this to pack memory: OpenKNX's PT-DelayTime is 14 bits at BitOffset 2, and
  // the Theben 493B has 11-bit fields at BitOffset 5. The codec used to compute a field's width
  // as `sizeInBit >> 3` (FLOOR: 14 bits -> 1 byte) and ignore BitOffset entirely for anything
  // 8 bits or wider, so such a field was written into the wrong bits (and threw a raw
  // RangeError as soon as its value exceeded 255). These pin the general MSB-first layout.
  const wide = (sizeInBit: number, bitOffset: number, signed = false): AppModel => ({
    mask: "MV-TEST", manufacturer: 0, appNumber: 0, version: 0,
    types: new Map([["T", { id: "T", base: "Number" as const, sizeInBit, signed }]]),
    params: new Map([["P", { id: "P", typeId: "T", value: "0", offset: 1, bitOffset }]]),
    refs: new Map([["R", { id: "R", paramId: "P" }]]),
    segments: [{ id: "S", lsm: 4, size: 8, data: Buffer.alloc(8) }],
  });

  test("a 14-bit field at BitOffset 2 spans two bytes and round-trips (OpenKNX PT-DelayTime)", () => {
    const m = wide(14, 2);
    const img = buildParameterImage(m, 4, new Map([["R", "300"]]));
    // 300 = 0b00_0100101100 in the low 14 bits of the 2-byte big-endian word at offset 1.
    expect(img.readUInt16BE(1)).toBe(300);
    expect(decodeParameterImage(m, 4, img).get("R")).toBe("300");
  });

  test("an 11-bit field at BitOffset 5 lands in the low 11 bits of the 2-byte word (Theben 493B)", () => {
    const m = wide(11, 5);
    const img = buildParameterImage(m, 4, new Map([["R", "1000"]]));
    expect(img.readUInt16BE(1) & 0x07ff).toBe(1000);
    expect(decodeParameterImage(m, 4, img).get("R")).toBe("1000");
  });

  test("it writes ONLY its own bits: the neighbouring bits are preserved", () => {
    const m = wide(11, 5);
    m.segments[0].data = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const img = buildParameterImage(m, 4, new Map([["R", "0"]]));
    // Byte 1's top 5 bits belong to other parameters and must survive; the field's own
    // 11 bits (3 low bits of byte 1 + all of byte 2) go to zero.
    expect(img[1]).toBe(0xf8);
    expect(img[2]).toBe(0x00);
    expect(img[0]).toBe(0xff); // untouched
    expect(img[3]).toBe(0xff);
  });

  test("a sub-byte field crossing a byte boundary is placed, not refused", () => {
    const m = wide(4, 6); // bits 6..9: the 2 low bits of byte 1, the 2 high bits of byte 2
    const img = buildParameterImage(m, 4, new Map([["R", "11"]])); // 11 = 0b1011
    expect(img[1] & 0x03).toBe(0b10); // the field's high half
    expect(img[2] & 0xc0).toBe(0b11 << 6); // its low half
    expect(decodeParameterImage(m, 4, img).get("R")).toBe("11");
  });

  test("signed non-aligned fields round-trip through two's complement", () => {
    const m = wide(12, 3, true);
    const img = buildParameterImage(m, 4, new Map([["R", "-500"]]));
    expect(decodeParameterImage(m, 4, img).get("R")).toBe("-500");
  });

  test("a value that does not fit its declared type is REFUSED, never truncated into the wrong bits", () => {
    const m = wide(11, 5);
    expect(() => buildParameterImage(m, 4, new Map([["R", "5000"]]))).toThrow(/out of range|does not fit/i);
  });
});
