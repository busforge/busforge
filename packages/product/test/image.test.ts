import { test, expect, describe } from "bun:test";
import { buildParameterImage, decodeParameterImage, encodeDpt9, decodeDpt9 } from "../src/image.ts";
import { unmappedParamRefs } from "../src/application.ts";
import type { AppModel, ParamType, Param, ParamRef } from "../src/application.ts";

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
    // Text params are not represented in the image and must not be decoded.
    expect(out.has("R-P-text")).toBe(false);
  });

  test("decodes manufacturer defaults when no instance value is set", () => {
    const out = decodeParameterImage(model(), 4, buildParameterImage(model(), 4, new Map()));
    expect(out.get("R-P-u8")).toBe("0");
    expect(out.get("R-P-float")).toBe("0");
  });
});
