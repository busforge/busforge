import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig } from "../src/appconfig.ts";
import { buildDeviceConfig, matchTest, resolveLanguage, type CfgParamView, type CfgItem } from "../src/config.ts";

const xml = readFileSync(join(import.meta.dir, "fixtures", "sample-app.xml"), "utf8");
const app = parseAppConfig(xml);
const moduleApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8"));
const accessApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-access-app.xml"), "utf8"));
const unsupportedApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-unsupported-app.xml"), "utf8"));
const orderApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-order-app.xml"), "utf8"));

const params = (v: { blocks: { items: CfgItem[] }[] }) =>
  v.blocks.flatMap((b) => b.items).filter((i): i is { kind: "param"; param: CfgParamView } => i.kind === "param");
const comObjs = (v: { blocks: { items: CfgItem[] }[] }) =>
  v.blocks.flatMap((b) => b.items).filter((i) => i.kind === "comObject");

describe("matchTest grammar", () => {
  test("equality and space-OR", () => {
    expect(matchTest("1", 1)).toBe(true);
    expect(matchTest("1", 2)).toBe(false);
    expect(matchTest("1 2 3", 3)).toBe(true);
    expect(matchTest("1 2 3", 4)).toBe(false);
  });
  test("operators", () => {
    expect(matchTest("<8", 5)).toBe(true);
    expect(matchTest("<8", 8)).toBe(false);
    expect(matchTest(">1", 2)).toBe(true);
    expect(matchTest("<=8", 8)).toBe(true);
    expect(matchTest(">=8", 8)).toBe(true);
    expect(matchTest("!=1", 1)).toBe(false);
    expect(matchTest("!=1", 0)).toBe(true);
  });
});

describe("parseAppConfig", () => {
  test("parses the application metadata and tables", () => {
    expect(app.id).toBe("M-TEST_A-1");
    expect(app.defaultLanguage).toBe("en-US");
    expect(app.hasModules).toBe(false);
    expect(app.types.size).toBe(3);
    expect(app.params.size).toBe(3);
    expect(app.refs.size).toBe(3);
    expect(app.comObjects.size).toBe(1);
    expect(app.languages).toEqual(["de-DE"]);
  });
  test("parses enum options and number ranges", () => {
    expect(app.types.get("M-TEST_A-1_PT-Mode")!.enums.map((e) => e.value)).toEqual([0, 1]);
    expect(app.types.get("M-TEST_A-1_PT-Num")).toMatchObject({ base: "Number", min: 0, max: 100 });
  });
  test("flags a DCA-driven application program (and not a normal one)", () => {
    const dcaXml = `<KNX><ApplicationProgram Id="M-TEST_A-DCA" Name="DALI-Gateway (DCA Version)" VisibleDescription="You need the ETS DCA App installed."><Static/><Dynamic/></ApplicationProgram></KNX>`;
    const dcaApp = parseAppConfig(dcaXml);
    expect(dcaApp.dca?.hint).toBe("You need the ETS DCA App installed.");
    expect(buildDeviceConfig(dcaApp, new Map()).dca?.hint).toBe("You need the ETS DCA App installed.");
    expect(app.dca).toBeUndefined();
    expect(buildDeviceConfig(app, new Map()).dca).toBeUndefined();
  });
});

describe("buildDeviceConfig visibility", () => {
  test("Mode=1 (default) shows Level + the com-object, hides Label", () => {
    const v = buildDeviceConfig(app, new Map());
    const names = params(v).map((p) => p.param.name);
    expect(names).toEqual(["Mode", "Level"]);
    expect(comObjs(v)).toHaveLength(1);

    const mode = params(v)[0].param;
    expect(mode).toMatchObject({ control: "enum", value: "1" });
    expect(mode.options).toEqual([{ value: 0, text: "Off" }, { value: 1, text: "On" }]);

    const level = params(v)[1].param;
    expect(level).toMatchObject({ control: "number", value: "42", min: 0, max: 100, suffix: "%" });
  });

  test("TypeNumber Increment becomes the spinner step and UIHint=Slider a slider", () => {
    const level = params(buildDeviceConfig(app, new Map()))[1].param;
    expect(level.step).toBe(5);
    expect(level.slider).toBe(true);
  });

  test("Mode=0 takes the default branch: shows Label, hides Level + com-object", () => {
    const v = buildDeviceConfig(app, new Map([["M-TEST_A-1_P-1_R-1", "0"]]));
    expect(params(v).map((p) => p.param.name)).toEqual(["Mode", "Label"]);
    expect(comObjs(v)).toHaveLength(0);
    expect(params(v)[1].param).toMatchObject({ control: "text", value: "hello" });
  });

  test("device instance value overrides the default", () => {
    const v = buildDeviceConfig(app, new Map([["M-TEST_A-1_P-2_R-2", "77"]]));
    expect(params(v).find((p) => p.param.name === "Level")!.param.value).toBe("77");
  });

  test("the section heading separator is emitted", () => {
    const v = buildDeviceConfig(app, new Map());
    const sep = v.blocks[0].items.find((i) => i.kind === "separator");
    expect(sep).toMatchObject({ kind: "separator", uiHint: "Headline", text: "Settings" });
  });

  test("com-object resolves flags and DPT", () => {
    const v = buildDeviceConfig(app, new Map());
    const co = comObjs(v)[0] as { comObject: any };
    expect(co.comObject).toMatchObject({ number: 0, functionText: "On/Off", dpt: "DPST-1-1" });
    expect(co.comObject.flags).toEqual({ read: false, write: true, comm: true, transmit: true, update: false, readOnInit: false });
  });

  test("imageComObjects records the reached com-object by resolved number with resolved flags/size", () => {
    const v = buildDeviceConfig(app, new Map());
    const c = v.imageComObjects.get(0);
    expect(c).toBeDefined();
    expect(c).toMatchObject({ number: 0, objectSize: "1 Bit" });
    expect(c!.flags).toEqual({ read: false, write: true, comm: true, transmit: true, update: false, readOnInit: false });
  });
});

// ETS evaluates EVERY matching <when> of a <choose>, not just the first. A single choose
// can drive two independent overlapping placements (the Theben RMG 8 S contact block does
// this for a param + a union member sharing one byte). First-match-wins left the second
// placement unwritten; this is the hardware-confirmed fix. See config.ts selectWhens.
describe("choose evaluates all matching whens (overlapping tests)", () => {
  const overlapXml = `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-9" ApplicationNumber="9" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Overlap" DefaultLanguage="en-US">
    <Static><ParameterTypes>
      <ParameterType Id="M-TEST_A-9_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType>
    </ParameterTypes><Parameters>
      <Parameter Id="M-TEST_A-9_P-1" Name="Sel" ParameterType="M-TEST_A-9_PT-N" Text="Sel" Value="1"><Memory CodeSegment="M-TEST_A-9_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-9_P-2" Name="A" ParameterType="M-TEST_A-9_PT-N" Text="A" Value="0"><Memory CodeSegment="M-TEST_A-9_RS-4" Offset="1" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-9_P-3" Name="B" ParameterType="M-TEST_A-9_PT-N" Text="B" Value="0"><Memory CodeSegment="M-TEST_A-9_RS-4" Offset="2" BitOffset="0" /></Parameter>
    </Parameters><ParameterRefs>
      <ParameterRef Id="M-TEST_A-9_P-1_R-1" RefId="M-TEST_A-9_P-1" />
      <ParameterRef Id="M-TEST_A-9_P-2_R-2" RefId="M-TEST_A-9_P-2" />
      <ParameterRef Id="M-TEST_A-9_P-3_R-3" RefId="M-TEST_A-9_P-3" />
    </ParameterRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-9_PB-1" Name="m" Text="Main">
      <choose ParamRefId="M-TEST_A-9_P-1_R-1">
        <when test="0 1"><ParameterRefRef RefId="M-TEST_A-9_P-2_R-2" /></when>
        <when test="1 2"><ParameterRefRef RefId="M-TEST_A-9_P-3_R-3" /></when>
      </choose>
    </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const overlapApp = parseAppConfig(overlapXml);

  test("Sel=1 matches both overlapping whens: A and B are both placed", () => {
    const v = buildDeviceConfig(overlapApp, new Map([["M-TEST_A-9_P-1_R-1", "1"]]));
    expect(params(v).map((p) => p.param.name)).toEqual(["A", "B"]);
    expect(v.imageValues.has("M-TEST_A-9_P-2_R-2")).toBe(true);
    expect(v.imageValues.has("M-TEST_A-9_P-3_R-3")).toBe(true);
  });

  test("Sel=0 matches only the first when: A placed, B not", () => {
    const v = buildDeviceConfig(overlapApp, new Map([["M-TEST_A-9_P-1_R-1", "0"]]));
    expect(params(v).map((p) => p.param.name)).toEqual(["A"]);
    expect(v.imageValues.has("M-TEST_A-9_P-3_R-3")).toBe(false);
  });

  test("Sel=2 matches only the second when: B placed, A not", () => {
    const v = buildDeviceConfig(overlapApp, new Map([["M-TEST_A-9_P-1_R-1", "2"]]));
    expect(params(v).map((p) => p.param.name)).toEqual(["B"]);
    expect(v.imageValues.has("M-TEST_A-9_P-2_R-2")).toBe(false);
  });
});

// ETS writes an <Assign> target's value to its memory even when the target's own
// ParameterRef is only placed in an inactive branch. A hidden Access="None" param assigned
// from a visible one in the ACTIVE branch must therefore land in imageValues (the image
// set), not only imgEnv. Hardware-confirmed on 1.1.56 (Steinel M-0083).
describe("assign target lands in imageValues (written to memory)", () => {
  const assignXml = `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-8" ApplicationNumber="8" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Assign" DefaultLanguage="en-US">
    <Static><ParameterTypes>
      <ParameterType Id="M-TEST_A-8_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType>
    </ParameterTypes><Parameters>
      <Parameter Id="M-TEST_A-8_P-1" Name="Src" ParameterType="M-TEST_A-8_PT-N" Text="Src" Value="1"><Memory CodeSegment="M-TEST_A-8_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-8_P-2" Name="Hidden" ParameterType="M-TEST_A-8_PT-N" Access="None" Text="Hidden" Value="9"><Memory CodeSegment="M-TEST_A-8_RS-4" Offset="1" BitOffset="0" /></Parameter>
    </Parameters><ParameterRefs>
      <ParameterRef Id="M-TEST_A-8_P-1_R-1" RefId="M-TEST_A-8_P-1" />
      <ParameterRef Id="M-TEST_A-8_P-2_R-2" RefId="M-TEST_A-8_P-2" />
    </ParameterRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-8_PB-1" Name="m" Text="Main">
      <ParameterRefRef RefId="M-TEST_A-8_P-1_R-1" />
      <choose ParamRefId="M-TEST_A-8_P-1_R-1">
        <when test="1"><Assign TargetParamRefRef="M-TEST_A-8_P-2_R-2" SourceParamRefRef="M-TEST_A-8_P-1_R-1" /></when>
        <when test="0"><ParameterRefRef RefId="M-TEST_A-8_P-2_R-2" /></when>
      </choose>
    </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const assignApp = parseAppConfig(assignXml);

  test("Src=1: P-2 is assigned from P-1 (not placed) yet is written with that value", () => {
    const v = buildDeviceConfig(assignApp, new Map([["M-TEST_A-8_P-1_R-1", "1"]]));
    // P-2's own ref sits in the inactive when test="0"; only the Assign in when test="1" runs.
    expect(v.imageValues.get("M-TEST_A-8_P-2_R-2")).toBe("1");
    // It stays hidden from the UI (Access="None").
    expect(params(v).map((p) => p.param.name)).toEqual(["Src"]);
  });

  // A UNION-member assign target is NOT injected into imageValues: union branches overlap one
  // byte and only the actively-placed branch may own it, else two members would claim it.
  const unionAssignXml = `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-7" ApplicationNumber="7" ApplicationVersion="1" MaskVersion="MV-07B0" Name="UA" DefaultLanguage="en-US">
    <Static><ParameterTypes>
      <ParameterType Id="M-TEST_A-7_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType>
    </ParameterTypes><Parameters>
      <Parameter Id="M-TEST_A-7_P-1" Name="Src" ParameterType="M-TEST_A-7_PT-N" Text="Src" Value="1"><Memory CodeSegment="M-TEST_A-7_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Union SizeInBit="8"><Memory CodeSegment="M-TEST_A-7_RS-4" Offset="1" BitOffset="0" />
        <Parameter Id="M-TEST_A-7_P-U" ParameterType="M-TEST_A-7_PT-N" Access="None" Text="U" Value="0" Offset="0" BitOffset="0" /></Union>
    </Parameters><ParameterRefs>
      <ParameterRef Id="M-TEST_A-7_P-1_R-1" RefId="M-TEST_A-7_P-1" />
      <ParameterRef Id="M-TEST_A-7_P-U_R-U" RefId="M-TEST_A-7_P-U" />
    </ParameterRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-7_PB-1" Name="m" Text="Main">
      <ParameterRefRef RefId="M-TEST_A-7_P-1_R-1" />
      <Assign TargetParamRefRef="M-TEST_A-7_P-U_R-U" SourceParamRefRef="M-TEST_A-7_P-1_R-1" />
    </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const unionAssignApp = parseAppConfig(unionAssignXml);

  test("a union-member assign target is NOT recorded in imageValues (overlap-safe)", () => {
    const v = buildDeviceConfig(unionAssignApp, new Map());
    expect(v.imageValues.has("M-TEST_A-7_P-U_R-U")).toBe(false);
  });
});

describe("module instantiation", () => {
  test("parses module defs and detects modules", () => {
    expect(moduleApp.hasModules).toBe(true);
    expect(moduleApp.moduleDefs.size).toBe(1);
    // the module def's static was merged into the shared maps
    expect(moduleApp.params.has("M-TEST_A-2_MD-1_P-1")).toBe(true);
    expect(moduleApp.comObjects.has("M-TEST_A-2_MD-1_O-1")).toBe(true);
  });

  // The fixture's module sits inside a <Repeat> (how real channel devices, e.g.
  // the HMG heating channels, declare replication). These tests therefore also
  // guard that a Repeat is transparent and never swallows its module.
  test("expands each device module instance with rewritten ids, substituted text, and based numbering", () => {
    const instances = [
      { id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "A" }, { refId: "MD-1_A-2", value: "10" }] },
      { id: "MD-1_M-1_MI-2", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "B" }, { refId: "MD-1_A-2", value: "20" }] },
    ];
    const v = buildDeviceConfig(moduleApp, new Map(), undefined, instances);
    // The <Channel Text="Channels"> heading becomes a navigable section (level 0)
    // and the two module instances are its sub-blocks (level 1), {{ChNo}} substituted.
    expect(v.blocks.map((b) => b.name)).toEqual(["Channels", "Channel A", "Channel B"]);
    expect(v.blocks.map((b) => b.level)).toEqual([0, 1, 1]);
    // param ids are rewritten to the instance-scoped form
    const ps = params(v);
    expect(ps.map((p) => p.param.refId)).toEqual(["M-TEST_A-2_MD-1_M-1_MI-1_P-1_R-1", "M-TEST_A-2_MD-1_M-1_MI-2_P-1_R-1"]);
    expect(ps.map((p) => p.param.name)).toEqual(["Channel A enable", "Channel B enable"]);
    // com-object numbers use the instance's resolved base (0 + ObjBase)
    const cos = comObjs(v).map((i) => (i as any).comObject);
    expect(cos.map((c: any) => c.number)).toEqual([10, 20]);
    expect(cos.map((c: any) => c.name)).toEqual(["Ch A switch", "Ch B switch"]);
  });

  test("instance parameter edits target the rewritten id", () => {
    const instances = [{ id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "A" }, { refId: "MD-1_A-2", value: "10" }] }];
    const overrides = new Map([["M-TEST_A-2_MD-1_M-1_MI-1_P-1_R-1", "1"]]);
    const v = buildDeviceConfig(moduleApp, overrides, undefined, instances);
    expect(params(v)[0].param.value).toBe("1");
  });
});

describe("access and text decoding", () => {
  const v = buildDeviceConfig(accessApp, new Map());
  const ps = params(v);

  test("Access=None is hidden, Access=Read is read-only, others editable", () => {
    // Hidden (Access=None) is omitted; Visible, Info, Label remain.
    expect(ps.map((p) => p.param.refId)).toEqual(["M-TEST_A-3_P-1_R-1", "M-TEST_A-3_P-3_R-3", "M-TEST_A-3_P-4_R-4"]);
    expect(ps[0].param.readOnly).toBeFalsy(); // Visible (ReadWrite)
    expect(ps[1].param.readOnly).toBe(true);  // Info (Access=Read)
  });

  test("valid numeric entities decode; out-of-range ones are left intact (no throw)", () => {
    // "Line one&#xA;keep&#x110000;end" -> newline decoded, U+110000 left as-is
    expect(ps[2].param.name).toBe("Line one\nkeep&#x110000;end");
  });
});

describe("localization", () => {
  test("German overrides param and enum text, falls back to base otherwise", () => {
    const v = buildDeviceConfig(app, new Map(), "de-DE");
    const mode = params(v)[0].param;
    expect(mode.name).toBe("Modus");
    expect(mode.options).toEqual([{ value: 0, text: "Off" }, { value: 1, text: "Ein" }]);
    // Level has no translation -> base text
    expect(params(v)[1].param.name).toBe("Level");
  });

  test("a short UI code resolves to the catalogue's full language", () => {
    // "de" must reach the de-DE translations (the UI sends short codes).
    const v = buildDeviceConfig(app, new Map(), "de");
    expect(params(v)[0].param.name).toBe("Modus");
  });

  test("a block with no Text takes its (translated) heading from the referenced parameter", () => {
    // PB-2 has a ParamRefId (-> P-1 "Mode"/"Modus") and no Text of its own.
    const block = (v: ReturnType<typeof buildDeviceConfig>) =>
      v.blocks.find((b) => b.items.some((i) => i.kind === "separator" && i.text === "ref-block-marker"));
    expect(block(buildDeviceConfig(app, new Map(), "en"))?.name).toBe("Mode"); // base text
    expect(block(buildDeviceConfig(app, new Map(), "de"))?.name).toBe("Modus"); // translation
  });

  test("nothing is dropped silently: unknown elements and uneditable types are surfaced", () => {
    const v = buildDeviceConfig(unsupportedApp, new Map());
    const items = v.blocks.flatMap((b) => b.items);
    // The unknown <FancyVendorWidget> becomes a visible marker, not a dropped node.
    const unknown = items.find((i) => i.kind === "unsupported");
    expect(unknown).toMatchObject({ kind: "unsupported", label: "FancyVendorWidget" });
    // Types we cannot edit keep a row with control "unsupported" and a label.
    const byName = (n: string) => items.find((i) => i.kind === "param" && i.param.name === n) as { param: CfgParamView };
    // TypeFloat is editable: a number control flagged float (decimal entry, step="any").
    expect(byName("Temperature").param).toMatchObject({ control: "number", float: true, value: "21" });
    // Supported integer types render as a plain number control (no float flag).
    expect(byName("Level").param).toMatchObject({ control: "number", value: "5" });
    expect(byName("Level").param.float).toBeUndefined();
    // TypeTime is editable: a "time" control that carries the Unit (seconds) for the
    // hh:mm:ss frontend; the value stays the raw integer.
    expect(byName("Switch time").param).toMatchObject({ control: "time", unit: "Seconds", value: "0" });
    // TypeIPAddress is editable: an "ip" control carrying the dotted-quad value.
    expect(byName("DNS server").param).toMatchObject({ control: "ip", value: "203.0.113.1" });
    // A named TypeNone is a read-only display label, not an "unsupported" warning.
    expect(byName("Section heading").param).toMatchObject({ control: "display", readOnly: true });
    // TypeColor RGB is editable: a colour control carrying the stored #RRGGBB value.
    expect(byName("Strip colour").param).toMatchObject({ control: "color", value: "#FF0000" });
    // TypeColor HSV stays unsupported (encoding unverified) with a labelled badge.
    expect(byName("Mood colour").param).toMatchObject({ control: "unsupported", typeLabel: "Color (HSV)" });
  });

  test("sibling blocks are ordered by heading DisplayOrder, not document order (ETS parity)", () => {
    // Document order A, B, C; DisplayOrder 300, 100, 200 -> ETS shows B, C, A.
    const v = buildDeviceConfig(orderApp, new Map());
    expect(v.blocks.map((b) => b.name)).toEqual(["B", "C", "A"]);
  });

  test("resolveLanguage matches exact, then prefix, then falls back to default", () => {
    expect(resolveLanguage(app, "de-DE")).toBe("de-DE"); // exact
    expect(resolveLanguage(app, "de")).toBe("de-DE"); // primary subtag
    expect(resolveLanguage(app, "de-AT")).toBe("de-DE"); // same subtag, different region
    expect(resolveLanguage(app, "en")).toBe("en-US"); // matches the default
    expect(resolveLanguage(app, "fr")).toBe("en-US"); // unknown -> default base text
    expect(resolveLanguage(app, undefined)).toBe("en-US"); // none -> default
  });
});
