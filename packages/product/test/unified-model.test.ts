import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig } from "../src/appconfig.ts";
import { parseApplication, toAppModel } from "../src/application.ts";
import { buildParameterImage, decodeParameterImage } from "../src/image.ts";

// One parser feeds both the UI (parseAppConfig) and the image (parseApplication is
// now a projection of it). These tests pin the contract that lets the second parser
// be deleted: the image projection drops module-def and union entries and reads the
// memory layout (segment <Data> child, param offsets) so it stays byte-identical to
// the standalone parser it replaced.
const xml = readFileSync(join(import.meta.dir, "fixtures", "sample-image-app.xml"), "utf8");

describe("unified parse -> image projection", () => {
  test("the UI model sees module-def and union params (tagged with provenance)", () => {
    const app = parseAppConfig(xml);
    expect(app.appNumber).toBe(4660);
    // Union param is present for the UI, tagged so the image side can drop it.
    expect(app.params.get("P-union")?.union).toBe(true);
    // Module-def static is merged in for the UI, tagged with the def id.
    const modParam = app.params.get("M-00FA_A-1234-01-ABCD_MD-1_P-1");
    expect(modParam?.moduleDefId).toBe("M-00FA_A-1234-01-ABCD_MD-1");
    // Memory + segment are parsed once, here.
    expect(app.params.get("P-u8")).toMatchObject({ offset: 1, bitOffset: 0, value: "100" });
    expect(app.segments).toHaveLength(1);
    expect(app.segments[0]).toMatchObject({ lsm: 4, size: 8 });
    expect(app.segments[0].data.length).toBe(8); // <Data> child decoded, not empty
  });

  test("the image projection excludes module-def and union entries", () => {
    const model = toAppModel(parseAppConfig(xml));
    expect(model.params.has("P-u8")).toBe(true);
    expect(model.params.has("P-union")).toBe(false); // union param dropped (not byte-placed)
    expect(model.params.has("M-00FA_A-1234-01-ABCD_MD-1_P-1")).toBe(false); // module-def param dropped
    // The top-level ref to the union param is kept (the legacy parser kept all
    // top-level ParameterRefs); since its param is gone, the image builder skips it.
    expect(model.refs.has("P-union_R-1")).toBe(true);
    expect(model.params.get("P-union")).toBeUndefined();
    // Refs/types defined inside the ModuleDef Static are dropped.
    expect(model.refs.has("M-00FA_A-1234-01-ABCD_MD-1_P-1_R-1")).toBe(false);
    expect(model.types.has("M-00FA_A-1234-01-ABCD_MD-1_T-1")).toBe(false);
    expect(model.manufacturer).toBe(0xfa);
  });

  test("builds the expected image from defaults (segment <Data> default preserved where unwritten)", () => {
    const model = parseApplication(xml);
    const img = buildParameterImage(model, 4, new Map());
    // byte0 enum=1 (2-bit), byte1 u8=100, byte2-3 s16=-5, byte4-5 dpt9(21.5),
    // byte6 union EXCLUDED -> stays segment default 0x00, byte7 segment default 0xAB.
    expect(img.toString("hex")).toBe("0164fffb0c3300ab");
  });

  test("decode round-trips the placed numeric/float params, skips the excluded union ref", () => {
    const model = parseApplication(xml);
    const img = buildParameterImage(model, 4, new Map());
    const decoded = decodeParameterImage(model, 4, img);
    expect(decoded.get("P-enum_R-1")).toBe("1");
    expect(decoded.get("P-u8_R-1")).toBe("100");
    expect(decoded.get("P-s16_R-1")).toBe("-5");
    expect(decoded.get("P-float_R-1")).toBe("21.5");
    expect(decoded.has("P-union_R-1")).toBe(false);
  });

  test("an instance value overrides the default at its offset", () => {
    const model = parseApplication(xml);
    const img = buildParameterImage(model, 4, new Map([["P-u8_R-1", "5"]]));
    expect(img[1]).toBe(5); // was the default
  });

  test("unsigned TypeNumber is not misdetected as signed (read-back of high values)", () => {
    const app = parseAppConfig(xml);
    // "unsignedInt" must not match a naive includes("signed"); "signedInt" must.
    expect(app.types.get("T-u8")?.signed).toBe(false);
    expect(app.types.get("T-s16")?.signed).toBe(true);
    // A high unsigned value: encode is unchanged (byte 200), and decode now reads
    // it back as 200 rather than the signed -56 the substring bug produced.
    const model = parseApplication(xml);
    const img = buildParameterImage(model, 4, new Map([["P-u8_R-1", "200"]]));
    expect(img[1]).toBe(200);
    expect(decodeParameterImage(model, 4, img).get("P-u8_R-1")).toBe("200");
  });
});
