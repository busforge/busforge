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
    // byte0 enum=1 (2-bit, MSB-first big-endian bit order -> 1<<6 = 0x40), byte1 u8=100,
    // byte2-3 s16=-5, byte4-5 dpt9(21.5), byte6 union EXCLUDED -> stays segment default
    // 0x00, byte7 segment default 0xAB.
    expect(img.toString("hex")).toBe("4064fffb0c3300ab");
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

// Union parameters whose memory lives on the <Union> element (the MV-0705 model):
// the parameter's own Offset/BitOffset are RELATIVE to the union's shared base. This
// pins the base+relative arithmetic and the includeUnions opt-in that the
// absolute-segment build (deviceimage) relies on.
const unionXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0001"><ApplicationPrograms>
<ApplicationProgram Id="M-0001_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Union Test">
<Static>
<ParameterTypes><ParameterType Id="M-0001_A-0001-01-0001_PT-2"><TypeRestriction Base="Value" SizeInBit="2">
<Enumeration Text="A" Value="0" Id="M-0001_A-0001-01-0001_PT-2_EN-0" DisplayOrder="0"/>
<Enumeration Text="B" Value="3" Id="M-0001_A-0001-01-0001_PT-2_EN-3" DisplayOrder="1"/></TypeRestriction></ParameterType></ParameterTypes>
<Parameters><Union SizeInBit="2">
<Memory CodeSegment="M-0001_A-0001-01-0001_AS-1" Offset="2" BitOffset="3"/>
<Parameter Id="M-0001_A-0001-01-0001_UP-1" ParameterType="M-0001_A-0001-01-0001_PT-2" Text="U1" Value="0" DefaultUnionParameter="true"/>
<Parameter Id="M-0001_A-0001-01-0001_UP-2" ParameterType="M-0001_A-0001-01-0001_PT-2" Text="U2" Value="0" Offset="1" BitOffset="2"/>
</Union></Parameters>
<ParameterRefs>
<ParameterRef Id="M-0001_A-0001-01-0001_UP-1_R-1" RefId="M-0001_A-0001-01-0001_UP-1"/>
<ParameterRef Id="M-0001_A-0001-01-0001_UP-2_R-1" RefId="M-0001_A-0001-01-0001_UP-2"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0001_A-0001-01-0001_AS-1" Address="100" Size="4"><Data>AAAAAA==</Data></AbsoluteSegment></Code>
</Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

describe("union parameters with shared <Union> memory (MV-0705)", () => {
  const U1 = "M-0001_A-0001-01-0001_UP-1", U2 = "M-0001_A-0001-01-0001_UP-2";

  test("places union children at union-base + their relative offset/bit", () => {
    const app = parseAppConfig(unionXml);
    // UP-1: no own Offset/Bit -> sits at the union base (2, bit3).
    expect(app.params.get(U1)).toMatchObject({ union: true, offset: 2, bitOffset: 3, codeSegment: "M-0001_A-0001-01-0001_AS-1" });
    // UP-2: relative Offset 1 / BitOffset 2 add to the base -> (3, bit5).
    expect(app.params.get(U2)).toMatchObject({ union: true, offset: 3, bitOffset: 5 });
  });

  test("toAppModel drops union params by default, keeps them with includeUnions", () => {
    const app = parseAppConfig(unionXml);
    expect(toAppModel(app).params.has(U1)).toBe(false);
    const m = toAppModel(app, { includeUnions: true });
    expect(m.params.get(U1)).toMatchObject({ offset: 2, bitOffset: 3 });
    expect(m.params.get(U2)).toMatchObject({ offset: 3, bitOffset: 5 });
  });
});

// TypeTime (durations/periods) carries no float or enum semantics; ETS stores it in
// the parameter image as a plain unsigned integer. The config layer keeps it as
// "Other" (unsupported UI row) but the image projection must encode it as Number.
// Hardware-verified on M-008E (a 16-bit TypeTime value 60 -> 0x003C matched).
const timeXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="M-0005_A-0001-01-0001" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Time">
<Static>
<ParameterTypes><ParameterType Id="M-0005_A-0001-01-0001_PT-t"><TypeTime SizeInBit="16" Unit="s"/></ParameterType></ParameterTypes>
<Parameters><Parameter Id="M-0005_A-0001-01-0001_P-1" ParameterType="M-0005_A-0001-01-0001_PT-t" Text="Delay" Value="0"><Memory CodeSegment="M-0005_A-0001-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter></Parameters>
<ParameterRefs><ParameterRef Id="M-0005_A-0001-01-0001_P-1_R" RefId="M-0005_A-0001-01-0001_P-1" Value="60"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0005_A-0001-01-0001_AS-1" Address="100" Size="2"/></Code>
</Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("TypeTime projects to a Number base in the image model (config keeps it Other)", () => {
  const app = parseAppConfig(timeXml);
  expect(app.types.get("M-0005_A-0001-01-0001_PT-t")?.base).toBe("Other"); // UI/config unchanged
  const model = toAppModel(app);
  expect(model.types.get("M-0005_A-0001-01-0001_PT-t")?.base).toBe("Number"); // image encodes as int
});
