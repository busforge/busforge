import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig } from "../src/appconfig.ts";
import { buildDeviceConfig, matchTest, resolveLanguage, type CfgParamView, type CfgItem } from "../src/config.ts";
import { buildAbsoluteSegmentTargets, buildRelativeSegmentTarget, constantParams } from "../src/deviceimage.ts";
import { steeringParamIds } from "../src/calculations.ts";

const xml = readFileSync(join(import.meta.dir, "fixtures", "sample-app.xml"), "utf8");
const app = parseAppConfig(xml);
const moduleApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8"));
const accessApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-access-app.xml"), "utf8"));
const unsupportedApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-unsupported-app.xml"), "utf8"));
const orderApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-order-app.xml"), "utf8"));
const gridApp = parseAppConfig(readFileSync(join(import.meta.dir, "fixtures", "sample-grid-app.xml"), "utf8"));

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
    // `=N` is in ETS's own schema for When/@test, next to the bare-integer list form.
    expect(matchTest("=5", 5)).toBe(true);
    expect(matchTest("=5", 4)).toBe(false);
    expect(matchTest("=-1", -1)).toBe(true);
    expect(matchTest("<8", 5)).toBe(true);
    expect(matchTest("<8", 8)).toBe(false);
    expect(matchTest(">1", 2)).toBe(true);
    expect(matchTest("<=8", 8)).toBe(true);
    expect(matchTest(">=8", 8)).toBe(true);
    expect(matchTest("!=1", 1)).toBe(false);
    expect(matchTest("!=1", 0)).toBe(true);
  });
  // A token this grammar does not know used to be skipped, so a `choose` whose every branch
  // tested an unknown form silently fell through to `default` and that branch went into the
  // flashed image. The wrong branch is unobservable in the UI and in the read-back (the device
  // faithfully holds the wrong bytes), so it must refuse instead.
  test("an unsupported token is refused, never treated as no-match", () => {
    expect(() => matchTest("1..3", 2)).toThrow(/1\.\.3/);
    try { matchTest("1..3", 2); } catch (e) { expect((e as { code?: string }).code).toBe("PARAM_TEST_UNSUPPORTED"); }
    // A well-formed token in the same expression does not excuse the unknown one: the branch
    // would still be decided on a partial reading of the condition.
    expect(() => matchTest("1 0x02", 1)).toThrow(/0x02/);
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

  // OpenKNX and Jung applications declare TypeNumber 0..1 with UIHint="CheckBox"; ETS stores 1 for a ticked
  // box over the default 0. A range of other or more than two values names no ticked and unticked value, and a TypeFloat is no TypeNumber.
  test("TypeNumber UIHint=CheckBox becomes a checkbox only for the range 0..1", () => {
    const num = (size: string, range: string) => `<TypeNumber SizeInBit="${size}" Type="unsignedInt" ${range} UIHint="CheckBox" />`;
    const types = [num("8", 'minInclusive="0" maxInclusive="1"'), num("1", 'minInclusive="0" maxInclusive="1"'), num("8", 'minInclusive="0" maxInclusive="2"'), num("8", 'minInclusive="1" maxInclusive="2"'), num("8", ""),
      '<TypeFloat Encoding="DPT 9" minInclusive="0" maxInclusive="1" UIHint="CheckBox" />'];
    const xml = `<KNX><ApplicationProgram Id="M-TEST_A-14" DefaultLanguage="en-US"><Static>
      <Parameters>${types.map((_, i) => `<Parameter Id="M-TEST_A-14_P-${i}" ParameterType="M-TEST_A-14_PT-${i}" Text="P${i}" Value="1" />`).join("")}</Parameters>
      <ParameterRefs>${types.map((_, i) => `<ParameterRef Id="M-TEST_A-14_P-${i}_R-1" RefId="M-TEST_A-14_P-${i}" />`).join("")}</ParameterRefs>
      <ParameterTypes>${types.map((type, i) => `<ParameterType Id="M-TEST_A-14_PT-${i}">${type}</ParameterType>`).join("")}</ParameterTypes>
      </Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-14_PB-1" Text="Page">
        ${types.map((_, i) => `<ParameterRefRef RefId="M-TEST_A-14_P-${i}_R-1" />`).join("")}
      </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></KNX>`;
    const shown = params(buildDeviceConfig(parseAppConfig(xml), new Map()));
    expect(shown.map((p) => [p.param.control, p.param.checkbox])).toEqual([["number", true], ["number", true], ["number", undefined], ["number", undefined], ["number", undefined], ["number", undefined]]);
    expect(params(buildDeviceConfig(app, new Map()))[1].param.checkbox).toBeUndefined();
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
// placement unwritten; this is the hardware-confirmed fix (on an RMG 8 S). See config.ts selectWhens.
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
// set), not only imgEnv. Hardware-confirmed on a Steinel M-0083 device.
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

describe("rejectedRefs: parameters every placement of which lies in a branch not taken", () => {
  const xml = `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-9" ApplicationNumber="9" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Rejected" DefaultLanguage="en-US">
    <Static><ParameterTypes>
      <ParameterType Id="M-TEST_A-9_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="99" /></ParameterType>
    </ParameterTypes><Parameters>
      <Parameter Id="M-TEST_A-9_P-SLOT" Name="Slot" ParameterType="M-TEST_A-9_PT-N" Text="Slot" Value="0" />
      <Parameter Id="M-TEST_A-9_P-M" Name="Merker" ParameterType="M-TEST_A-9_PT-N" Access="None" Text="Merker" Value="1" />
      <Parameter Id="M-TEST_A-9_P-1" Name="InSlot" ParameterType="M-TEST_A-9_PT-N" Text="In slot" Value="2"><Memory CodeSegment="M-TEST_A-9_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-9_P-2" Name="ByMerker" ParameterType="M-TEST_A-9_PT-N" Text="By Merker" Value="3"><Memory CodeSegment="M-TEST_A-9_RS-4" Offset="1" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-9_P-3" Name="Twice" ParameterType="M-TEST_A-9_PT-N" Text="Twice" Value="4"><Memory CodeSegment="M-TEST_A-9_RS-4" Offset="2" BitOffset="0" /></Parameter>
    </Parameters><ParameterRefs>
      <ParameterRef Id="M-TEST_A-9_P-SLOT_R" RefId="M-TEST_A-9_P-SLOT" />
      <ParameterRef Id="M-TEST_A-9_P-M_R" RefId="M-TEST_A-9_P-M" />
      <ParameterRef Id="M-TEST_A-9_P-1_R" RefId="M-TEST_A-9_P-1" />
      <ParameterRef Id="M-TEST_A-9_P-2_R" RefId="M-TEST_A-9_P-2" />
      <ParameterRef Id="M-TEST_A-9_P-3_R" RefId="M-TEST_A-9_P-3" />
    </ParameterRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-9_PB-1" Name="m" Text="Main">
      <ParameterRefRef RefId="M-TEST_A-9_P-SLOT_R" />
      <choose ParamRefId="M-TEST_A-9_P-SLOT_R">
        <when test="&gt;10"><ParameterRefRef RefId="M-TEST_A-9_P-M_R" /></when>
        <when test="4"><ParameterRefRef RefId="M-TEST_A-9_P-1_R" /><ParameterRefRef RefId="M-TEST_A-9_P-3_R" /></when>
      </choose>
      <choose ParamRefId="M-TEST_A-9_P-M_R"><when test="1"><ParameterRefRef RefId="M-TEST_A-9_P-2_R" /><ParameterRefRef RefId="M-TEST_A-9_P-3_R" /></when></choose>
    </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const app = parseAppConfig(xml);
  test("a choose on a set parameter rejects; one on an unset Merker rejects nothing", () => {
    const b = buildDeviceConfig(app, new Map());
    expect(b.imageValues.has("M-TEST_A-9_P-1_R")).toBe(false);
    expect(b.imageValues.has("M-TEST_A-9_P-2_R")).toBe(false);
    expect([...b.rejectedRefs].sort()).toEqual(["M-TEST_A-9_P-1_R", "M-TEST_A-9_P-M_R"]);
  });
  test("a parameter reached is never rejected", () => {
    const b = buildDeviceConfig(app, new Map([["M-TEST_A-9_P-SLOT_R", "4"]]));
    expect(b.imageValues.get("M-TEST_A-9_P-1_R")).toBe("2");
    expect([...b.rejectedRefs].sort()).toEqual(["M-TEST_A-9_P-M_R"]);
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

describe("a Merker computed in a hidden (Access=None) block still gates visible content", () => {
  // The Jung 400021SE pattern: every channel's com-objects hang off a choose on a Merker
  // ("show channel N") that is only PLACED inside an Access="None" block. The display walk hid
  // Access="None" blocks wholesale, so the Merker was never placed, the gate read unset, and the
  // whole channel set (params AND com-objects) vanished from the view — even though the image built
  // them correctly. The walk must run an invisible block's Merker/Assign side effects (respecting the
  // same choose gating), just not display it.
  const merkerGateXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="M-TEST_A-30" ApplicationNumber="30" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Merker Gate" DefaultLanguage="en-US">
  <Static>
    <ParameterTypes>
      <ParameterType Id="M-TEST_A-30_PT-N" Name="N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="100" /></ParameterType>
    </ParameterTypes>
    <Parameters>
      <Parameter Id="M-TEST_A-30_P-1" Name="Visible" ParameterType="M-TEST_A-30_PT-N" Text="Visible" Value="1"><Memory CodeSegment="M-TEST_A-30_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-30_P-M" Name="ShowChannel" ParameterType="M-TEST_A-30_PT-N" Text="" Value="1" Access="None" />
    </Parameters>
    <ParameterRefs>
      <ParameterRef Id="M-TEST_A-30_P-1_R-1" RefId="M-TEST_A-30_P-1" />
      <ParameterRef Id="M-TEST_A-30_P-M_R-2" RefId="M-TEST_A-30_P-M" />
    </ParameterRefs>
    <ComObjectTable>
      <ComObject Id="M-TEST_A-30_O-1" Name="Chan" Number="7" Text="Channel object" FunctionText="sw" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
    </ComObjectTable>
    <ComObjectRefs>
      <ComObjectRef Id="M-TEST_A-30_O-1_R-1" RefId="M-TEST_A-30_O-1" />
    </ComObjectRefs>
  </Static>
  <Dynamic>
    <ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-30_PB-1" Name="main" Text="Main">
        <ParameterRefRef RefId="M-TEST_A-30_P-1_R-1" />
      </ParameterBlock>
      <ParameterBlock Id="M-TEST_A-30_PB-H" Name="hidden" Text="Hidden" Access="None">
        <ParameterRefRef RefId="M-TEST_A-30_P-M_R-2" />
      </ParameterBlock>
      <choose ParamRefId="M-TEST_A-30_P-M_R-2">
        <when test="1">
          <ParameterBlock Id="M-TEST_A-30_PB-C" Name="chan" Text="Channel">
            <ComObjectRefRef RefId="M-TEST_A-30_O-1_R-1" />
          </ParameterBlock>
        </when>
      </choose>
    </ChannelIndependentBlock>
  </Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const merkerGateApp = parseAppConfig(merkerGateXml);

  test("the gated com-object renders because the hidden block placed its Merker", () => {
    const v = buildDeviceConfig(merkerGateApp, new Map());
    const cos = comObjs(v);
    expect(cos.length).toBe(1); // was 0 before the fix (Merker unplaced -> choose fails -> object hidden)
    expect((cos[0] as { comObject: { number: number } }).comObject.number).toBe(7);
    // The Merker itself (Access=None) stays out of the visible parameter list.
    expect(params(v).map((p) => p.param.refId)).toEqual(["M-TEST_A-30_P-1_R-1"]);
  });
});

describe("unplaced memoryless Access=Read Merker in <choose>", () => {
  // Theben M-0048_A-0103-11-72A2 pattern: P-68 is declared Access="Read" with Value="1" and no
  // <Memory>, placed only when a controlling switch is active. When unplaced and unstored, ETS
  // treats it as unset so neither <when test="1"> nor <when test="0"> fires; once placed (or
  // assigned), it evaluates to its value and activates its gated com-object while displaying as
  // read-only. Stored values, sibling ParameterRefs (both mixed-access and multi-ref Access="Read"),
  // and property-backed Access="Read" parameters keep their normal resolution.
  const readMerkerXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="M-TEST_A-31" ApplicationNumber="31" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Read Merker" DefaultLanguage="en-US">
  <Static>
    <ParameterTypes>
      <ParameterType Id="M-TEST_A-31_PT-N" Name="N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="10" /></ParameterType>
    </ParameterTypes>
    <Parameters>
      <Parameter Id="M-TEST_A-31_P-1" Name="Switch" ParameterType="M-TEST_A-31_PT-N" Text="Switch" Value="0"><Memory CodeSegment="M-TEST_A-31_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-31_P-M" Name="ReadMerker" ParameterType="M-TEST_A-31_PT-N" Text="Dimmable" Value="1" Access="Read" />
      <Parameter Id="M-TEST_A-31_P-PROP" Name="PropRead" ParameterType="M-TEST_A-31_PT-N" Text="Prop" Value="1" Access="Read"><Property ObjectIndex="0" PropertyId="1" Offset="0" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-31_P-MIX" Name="Mixed" ParameterType="M-TEST_A-31_PT-N" Text="Mixed" Value="0" />
    </Parameters>
    <ParameterRefs>
      <ParameterRef Id="M-TEST_A-31_P-1_R-1" RefId="M-TEST_A-31_P-1" />
      <ParameterRef Id="M-TEST_A-31_P-M_R-2" RefId="M-TEST_A-31_P-M" />
      <ParameterRef Id="M-TEST_A-31_P-M_R-3" RefId="M-TEST_A-31_P-M" />
      <ParameterRef Id="M-TEST_A-31_P-PROP_R-1" RefId="M-TEST_A-31_P-PROP" />
      <ParameterRef Id="M-TEST_A-31_P-MIX_R-1" RefId="M-TEST_A-31_P-MIX" />
      <ParameterRef Id="M-TEST_A-31_P-MIX_R-2" RefId="M-TEST_A-31_P-MIX" Access="Read" />
    </ParameterRefs>
    <ComObjectTable>
      <ComObject Id="M-TEST_A-31_O-1" Name="Dim" Number="5" Text="Dimming" FunctionText="dim" ObjectSize="4 Bit" DatapointType="DPST-3-7" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
      <ComObject Id="M-TEST_A-31_O-2" Name="Zero" Number="6" Text="Zero" FunctionText="zero" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
      <ComObject Id="M-TEST_A-31_O-3" Name="PropObj" Number="7" Text="Prop" FunctionText="prop" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
      <ComObject Id="M-TEST_A-31_O-4" Name="MixedObj" Number="8" Text="Mixed" FunctionText="mix" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
      <ComObject Id="M-TEST_A-31_O-5" Name="SiblingObj" Number="9" Text="Sib" FunctionText="sib" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
    </ComObjectTable>
    <ComObjectRefs>
      <ComObjectRef Id="M-TEST_A-31_O-1_R-1" RefId="M-TEST_A-31_O-1" />
      <ComObjectRef Id="M-TEST_A-31_O-2_R-1" RefId="M-TEST_A-31_O-2" />
      <ComObjectRef Id="M-TEST_A-31_O-3_R-1" RefId="M-TEST_A-31_O-3" />
      <ComObjectRef Id="M-TEST_A-31_O-4_R-1" RefId="M-TEST_A-31_O-4" />
      <ComObjectRef Id="M-TEST_A-31_O-5_R-1" RefId="M-TEST_A-31_O-5" />
    </ComObjectRefs>
  </Static>
  <Dynamic>
    <ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-31_PB-1" Name="main" Text="Main">
        <ParameterRefRef RefId="M-TEST_A-31_P-1_R-1" />
        <ParameterRefRef RefId="M-TEST_A-31_P-MIX_R-1" />
        <choose ParamRefId="M-TEST_A-31_P-1_R-1">
          <when test="1">
            <ParameterBlock Id="M-TEST_A-31_PB-INL" Name="inl" Inline="true">
              <ParameterRefRef RefId="M-TEST_A-31_P-M_R-2" />
            </ParameterBlock>
          </when>
          <when test="2">
            <Assign TargetParamRefRef="M-TEST_A-31_P-M_R-2" Value="1" />
          </when>
        </choose>
        <choose ParamRefId="M-TEST_A-31_P-M_R-2">
          <when test="1">
            <ComObjectRefRef RefId="M-TEST_A-31_O-1_R-1" />
          </when>
          <when test="0">
            <ComObjectRefRef RefId="M-TEST_A-31_O-2_R-1" />
          </when>
        </choose>
        <choose ParamRefId="M-TEST_A-31_P-M_R-3">
          <when test="1">
            <ComObjectRefRef RefId="M-TEST_A-31_O-5_R-1" />
          </when>
        </choose>
        <choose ParamRefId="M-TEST_A-31_P-PROP_R-1">
          <when test="1">
            <ComObjectRefRef RefId="M-TEST_A-31_O-3_R-1" />
          </when>
        </choose>
        <choose ParamRefId="M-TEST_A-31_P-MIX_R-2">
          <when test="3">
            <ComObjectRefRef RefId="M-TEST_A-31_O-4_R-1" />
          </when>
        </choose>
      </ParameterBlock>
    </ChannelIndependentBlock>
  </Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const readMerkerApp = parseAppConfig(readMerkerXml);

  test("unplaced memoryless Access=Read parameter reads as unset and matches neither test=1 nor test=0; property-backed Access=Read keeps its default", () => {
    const v = buildDeviceConfig(readMerkerApp, new Map());
    // Neither O-1 (test=1), O-2 (test=0), nor O-5 (sibling test=1) activates; O-3 (property-backed) still does.
    expect([...v.imageComObjects.keys()]).toEqual([7]);
    expect(comObjs(v)).toHaveLength(1);
    expect(v.paramValue("M-TEST_A-31_P-M_R-2")).toBeUndefined();
    expect(v.paramValue("M-TEST_A-31_P-PROP_R-1")).toBe("1");
  });

  test("once placed (even in an Inline block), memoryless Access=Read activates its chooses and sibling refs, and renders read-only", () => {
    const v = buildDeviceConfig(readMerkerApp, new Map([["M-TEST_A-31_P-1_R-1", "1"]]));
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([5, 7, 9]);
    const merkerParam = params(v).find((p) => p.param.refId === "M-TEST_A-31_P-M_R-2");
    expect(merkerParam?.param.value).toBe("1");
    expect(merkerParam?.param.readOnly).toBe(true);
    expect(merkerParam?.param.memoryless).toBe(true);
  });

  test("an Assign targeting an unplaced memoryless Access=Read parameter sets it for choose evaluation", () => {
    const v = buildDeviceConfig(readMerkerApp, new Map([["M-TEST_A-31_P-1_R-1", "2"]]));
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([5, 7, 9]);
  });

  test("a stored value on a placed memoryless Access=Read ref is preserved, and a placed sibling overrides a stale value on an unplaced sibling", () => {
    const v = buildDeviceConfig(readMerkerApp, new Map([
      ["M-TEST_A-31_P-1_R-1", "1"],
      ["M-TEST_A-31_P-M_R-2", "2"],
      ["M-TEST_A-31_P-M_R-3", "1"], // stale value on unplaced sibling must not override placed R-2=2
    ]));
    expect([...v.imageComObjects.keys()]).toEqual([7]);
    const merkerParam = params(v).find((p) => p.param.refId === "M-TEST_A-31_P-M_R-2");
    expect(merkerParam?.param.value).toBe("2");
  });

  test("an editable memoryless parameter's Access=Read ref still reads its placed editable sibling's value", () => {
    const v = buildDeviceConfig(readMerkerApp, new Map([["M-TEST_A-31_P-MIX_R-1", "3"]]));
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([7, 8]);
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
    // TypePicture shows its baggage image: a read-only "picture" control naming the image and its alignment.
    expect(byName("Logo").param).toMatchObject({ control: "picture", readOnly: true, picture: { baggageId: "M-TEST_BG--logo.2Epng", align: "Right" } });
    expect(byName("Logo").param.typeLabel).toBeUndefined();
    // A TypePicture that names no image has nothing to show and stays an explicit unsupported row.
    expect(byName("Picture without image").param).toMatchObject({ control: "unsupported", typeLabel: "Picture naming no image" });
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

// ETS grid layouts (OpenKNX RaumController pattern): a ParameterBlock with
// Layout="Grid"/"Table" declares its geometry in <Rows>/<Columns> and every item
// inside places itself with Cell="row,column"; a <Button> names a manufacturer
// <Script> action busforge cannot run.
describe("grid layouts (Rows/Columns/Cell) and Buttons", () => {
  const block = (v: ReturnType<typeof buildDeviceConfig>, name: string) => v.blocks.find((b) => b.name === name)!;
  const grid = (lang?: string) => block(buildDeviceConfig(gridApp, new Map(), lang), "Startup");
  const table = (lang?: string) => block(buildDeviceConfig(gridApp, new Map(), lang), "Groups");

  test("<Rows>/<Columns> are the block's geometry, not unsupported elements", () => {
    const v = buildDeviceConfig(gridApp, new Map());
    // The whole point: no amber "Element Rows/Columns/Button" markers anywhere.
    expect(v.blocks.flatMap((b) => b.items).filter((i) => i.kind === "unsupported")).toEqual([]);
    const g = grid();
    expect(g.layout).toBe("Grid");
    expect(g.rows).toHaveLength(2);
    // A Grid's columns are anonymous geometry: a width, no header caption.
    expect(g.cols).toEqual([{ text: undefined, width: "45%" }, { text: undefined, width: "15%" }, { text: undefined, width: "20%" }]);
  });

  test("items carry their ETS cell, including through a choose branch", () => {
    const items = grid().items;
    const sep = items.find((i): i is Extract<CfgItem, { kind: "separator" }> => i.kind === "separator" && i.text === "Startup delay");
    expect(sep?.cell).toEqual({ row: 1, col: 1 });
    const byName = (n: string) => items.find((i): i is Extract<CfgItem, { kind: "param" }> => i.kind === "param" && i.param.name === n);
    expect(byName("Time")?.cell).toEqual({ row: 1, col: 2 });
    expect(byName("Time base")?.cell).toEqual({ row: 1, col: 3 });
    // Placed by an active <when> INSIDE the grid: the cell must survive the choose walk.
    expect(byName("Extra")?.cell).toEqual({ row: 2, col: 2 });
    // A com-object in a layout block has no Cell (ETS never places one), so it stays
    // unplaced and the renderer keeps it below the grid instead of dropping it.
    const co = items.find((i) => i.kind === "comObject");
    expect(co).toBeDefined();
    expect(co && "cell" in co).toBe(false);
  });

  test("an inactive choose branch places nothing in the grid", () => {
    // P-2 = 0 deselects the <when test="1"> that placed "Extra" at cell 2,2.
    const v = buildDeviceConfig(gridApp, new Map([["M-TEST_A-11_P-2_R-2", "0"]]));
    const items = block(v, "Startup").items;
    expect(items.find((i) => i.kind === "param" && i.param.name === "Extra")).toBeUndefined();
    expect(v.imageValues.has("M-TEST_A-11_P-4_R-4")).toBe(false);
  });

  test("a Table's rows and columns carry the (translated) header captions", () => {
    const t = table();
    expect(t.layout).toBe("Table");
    expect(t.rows?.map((r) => r.text)).toEqual(["Group 1"]);
    expect(t.cols?.map((c) => c.text)).toEqual(["Name", "Comment"]);
    expect(t.cols?.map((c) => c.width)).toEqual(["50%", "50%"]);
    expect(table("de")?.cols?.map((c) => c.text)).toEqual(["Name", "Kommentar"]);
  });

  test("a Button is surfaced as the named script action it is, never as a live control", () => {
    // In a grid cell (with its Cell) and in the plain flow (without one).
    const inCell = table().items.find((i) => i.kind === "button");
    expect(inCell).toEqual({ kind: "button", button: { text: "Replace newlines", handler: "newline" }, cell: { row: 1, col: 3 } });
    const flow = block(buildDeviceConfig(gridApp, new Map()), "Main").items.find((i) => i.kind === "button");
    expect(flow).toEqual({ kind: "button", button: { text: "Read meter", handler: "readMeter" }, cell: undefined });
    // The label is translated like any other ETS text.
    const de = block(buildDeviceConfig(gridApp, new Map(), "de"), "Groups").items.find((i) => i.kind === "button");
    expect(de?.kind === "button" && de.button.text).toBe("Zeilenumbrüche ersetzen");
  });

  // A layout we cannot read must not quietly swallow its own geometry: the block stays a
  // plain list and the <Rows>/<Columns> surface as unsupported, exactly as before support
  // existed. Silently consuming them would hide whatever they carry.
  test("an unreadable grid geometry is refused, not consumed", () => {
    const dyn = (block: string) => `<KNX><ApplicationProgram Id="M-TEST_A-12" DefaultLanguage="en-US"><Static>
      <Parameters><Parameter Id="M-TEST_A-12_P-1" ParameterType="M-TEST_A-12_PT-1" Text="P" Value="1" /></Parameters>
      <ParameterRefs><ParameterRef Id="M-TEST_A-12_P-1_R-1" RefId="M-TEST_A-12_P-1" /></ParameterRefs>
      <ParameterTypes><ParameterType Id="M-TEST_A-12_PT-1"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType></ParameterTypes>
      </Static><Dynamic><ParameterBlock Id="M-TEST_A-12_PB-1" Text="B">${block}</ParameterBlock></Dynamic></ApplicationProgram></KNX>`;
    const items = (xml: string) => buildDeviceConfig(parseAppConfig(xml), new Map()).blocks.flatMap((b) => b.items);
    const labels = (xml: string) => items(xml).filter((i) => i.kind === "unsupported").map((i) => i.label);

    // A <Row> that carries an item is NOT the geometry we understand: refuse the whole
    // grid rather than dropping the item with it.
    const nested = dyn(`<Rows><Row Id="M-TEST_A-12_PB-1_R-1"><ParameterRefRef RefId="M-TEST_A-12_P-1_R-1" /></Row></Rows>
      <Columns><Column Id="M-TEST_A-12_PB-1_C-1" Width="50%" /></Columns>
      <ParameterRefRef RefId="M-TEST_A-12_P-1_R-1" Cell="1,1" />`);
    expect(labels(nested)).toEqual(["Rows", "Columns"]);
    expect(buildDeviceConfig(parseAppConfig(nested), new Map()).blocks[0]?.layout).toBeUndefined();

    // An unknown Layout: keep the block a list AND surface its geometry.
    const unknown = dyn(`<Rows><Row Id="M-TEST_A-12_PB-1_R-1" /></Rows>
      <Columns><Column Id="M-TEST_A-12_PB-1_C-1" Width="50%" /></Columns>
      <ParameterRefRef RefId="M-TEST_A-12_P-1_R-1" Cell="1,1" />`).replace('Id="M-TEST_A-12_PB-1" Text="B"', 'Id="M-TEST_A-12_PB-1" Text="B" Layout="Hexagons"');
    expect(labels(unknown)).toEqual(["Rows", "Columns"]);
    // Either way the parameter itself still renders and still reaches the image.
    expect(items(nested).some((i) => i.kind === "param")).toBe(true);
    expect(buildDeviceConfig(parseAppConfig(unknown), new Map()).imageValues.get("M-TEST_A-12_P-1_R-1")).toBe("1");
  });

  test("a Cell that is not a 1-based row,column leaves the item unplaced (never mis-placed)", () => {
    const xml = readFileSync(join(import.meta.dir, "fixtures", "sample-grid-app.xml"), "utf8")
      .replace('RefId="M-TEST_A-11_P-1_R-1" Cell="1,2"', 'RefId="M-TEST_A-11_P-1_R-1" Cell="0,2"');
    const items = buildDeviceConfig(parseAppConfig(xml), new Map()).blocks.flatMap((b) => b.items);
    const p = items.find((i) => i.kind === "param" && i.param.name === "Time");
    expect(p).toBeDefined(); // still rendered
    expect(p?.kind === "param" && p.cell).toBeUndefined(); // but not placed at row 0
  });

  test("parameters inside a grid block still reach the memory image", () => {
    // The image walk must descend into a Grid/Table block exactly like a list block:
    // a parameter that renders in a cell but never reaches imageValues would be left at
    // the segment default on the device, silently ignoring its configured value.
    const v = buildDeviceConfig(gridApp, new Map([["M-TEST_A-11_P-1_R-1", "42"]]));
    expect(v.imageValues.get("M-TEST_A-11_P-1_R-1")).toBe("42"); // edited, in a cell
    expect(v.imageValues.get("M-TEST_A-11_P-2_R-2")).toBe("1"); // default, in a cell
    expect(v.imageValues.get("M-TEST_A-11_P-4_R-4")).toBe("9"); // in a cell inside a choose
    // Access="None" is hidden from the UI but ETS still writes it: it must be in the
    // image even though it only ever appears in a grid cell.
    expect(v.imageValues.get("M-TEST_A-11_P-3_R-3")).toBe("7");
    expect(block(v, "Startup").items.find((i) => i.kind === "param" && i.param.name === "Internal")).toBeUndefined();
    // A com-object placed inside a grid block reaches the com-object table too.
    expect(v.imageComObjects.get(1)).toMatchObject({ number: 1, objectSize: "1 Bit" });
  });
});

// Inline="true" puts a block on its parent's page, where it stands in the parent's flow (the
// OpenKNX RaumController draws every value-and-unit row as such a grid). It is no page, so its Name,
// an identifier, never becomes a heading.
describe("inline blocks", () => {
  const xml = `<KNX><ApplicationProgram Id="M-TEST_A-13" DefaultLanguage="en-US"><Static>
    <Parameters>${[1, 2, 3, 4].map((i) => `<Parameter Id="M-TEST_A-13_P-${i}" ParameterType="M-TEST_A-13_PT-1" Text="P${i}" Value="1" />`).join("")}</Parameters>
    <ParameterRefs>${[1, 2, 3, 4].map((i) => `<ParameterRef Id="M-TEST_A-13_P-${i}_R-1" RefId="M-TEST_A-13_P-${i}" />`).join("")}</ParameterRefs>
    <ParameterTypes><ParameterType Id="M-TEST_A-13_PT-1"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType></ParameterTypes>
    </Static><Dynamic><ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-13_PB-1" Name="PageName" Text="Page">
        <ParameterSeparator Id="M-TEST_A-13_PS-1" Text="General" UIHint="Headline" />
        <ParameterBlock Id="M-TEST_A-13_PB-2" Name="X_StartupDelay" Inline="true"><ParameterRefRef RefId="M-TEST_A-13_P-1_R-1" /></ParameterBlock>
        <ParameterRefRef RefId="M-TEST_A-13_P-2_R-1" />
        <ParameterBlock Id="M-TEST_A-13_PB-3" Name="X_Table" Text="IO" Inline="true"><ParameterRefRef RefId="M-TEST_A-13_P-3_R-1" /></ParameterBlock>
        <ParameterBlock Id="M-TEST_A-13_PB-4" Name="X_SubPage"><ParameterRefRef RefId="M-TEST_A-13_P-4_R-1" /></ParameterBlock>
      </ParameterBlock>
    </ChannelIndependentBlock></Dynamic></ApplicationProgram></KNX>`;
  const blocks = buildDeviceConfig(parseAppConfig(xml), new Map()).blocks;
  const byId = (n: number) => blocks.find((b) => b.id === `M-TEST_A-13_PB-${n}`)!;

  test("an inline block stands where it is authored among its parent's items", () => {
    expect(byId(1).items.map((i) => (i.kind === "param" ? i.param.name : i.kind))).toEqual(["separator", "P2"]);
    expect(byId(2)).toMatchObject({ inline: true, at: 1, parentId: "M-TEST_A-13_PB-1", level: 1 });
    expect(byId(3)).toMatchObject({ inline: true, at: 2 });
  });

  test("an inline block takes its Text as heading, never its Name", () => {
    expect(byId(2).name).toBe("");
    expect(byId(3).name).toBe("IO");
  });

  test("a block that is not inline stays a page of its own, named as before", () => {
    expect(byId(4).inline).toBeUndefined();
    expect(byId(4).at).toBeUndefined();
    expect(byId(4).name).toBe("X_SubPage");
  });

  // The OpenKNX RaumController's "Kanal 1" page holds nothing but its inline "Konfiguration" block.
  test("a page whose rows all sit in inline blocks stays a page, and its inline blocks stand on it", () => {
    const only = xml.replace(/<ParameterBlock Id="M-TEST_A-13_PB-1"[\s\S]*<\/ParameterBlock>\s*<\/ChannelIndependentBlock>/, `<ParameterBlock Id="M-TEST_A-13_PB-1" Text="Page">
        <ParameterBlock Id="M-TEST_A-13_PB-2" Text="Configuration" Inline="true">
          <ParameterRefRef RefId="M-TEST_A-13_P-1_R-1" />
          <ParameterBlock Id="M-TEST_A-13_PB-3" Inline="true"><ParameterRefRef RefId="M-TEST_A-13_P-2_R-1" /></ParameterBlock>
        </ParameterBlock>
        <ParameterBlock Id="M-TEST_A-13_PB-4" Inline="true" Access="None"><ParameterRefRef RefId="M-TEST_A-13_P-3_R-1" /></ParameterBlock>
      </ParameterBlock></ChannelIndependentBlock>`);
    const v = buildDeviceConfig(parseAppConfig(only), new Map()).blocks;
    expect(v.map((b) => [b.id.slice(-4), b.level, b.parentId?.slice(-4), b.at])).toEqual([
      ["PB-1", 0, undefined, undefined], ["PB-2", 1, "PB-1", 0], ["PB-3", 2, "PB-2", 1],
    ]);
  });

  test("inline blocks at one place keep their authored order, whatever DisplayOrder their named parameters carry", () => {
    const ordered = xml
      .replace('<ParameterRef Id="M-TEST_A-13_P-3_R-1" RefId="M-TEST_A-13_P-3" />', '<ParameterRef Id="M-TEST_A-13_P-3_R-1" RefId="M-TEST_A-13_P-3" DisplayOrder="9" />')
      .replace('<ParameterRef Id="M-TEST_A-13_P-4_R-1" RefId="M-TEST_A-13_P-4" />', '<ParameterRef Id="M-TEST_A-13_P-4_R-1" RefId="M-TEST_A-13_P-4" DisplayOrder="1" />')
      .replace(/<ParameterBlock Id="M-TEST_A-13_PB-1"[\s\S]*<\/ParameterBlock>\s*<\/ChannelIndependentBlock>/, `<ParameterBlock Id="M-TEST_A-13_PB-1" Text="Page">
        <ParameterRefRef RefId="M-TEST_A-13_P-1_R-1" />
        <ParameterBlock Id="M-TEST_A-13_PB-2" Inline="true" ParamRefId="M-TEST_A-13_P-3_R-1"><ParameterRefRef RefId="M-TEST_A-13_P-2_R-1" /></ParameterBlock>
        <ParameterBlock Id="M-TEST_A-13_PB-3" Inline="true" ParamRefId="M-TEST_A-13_P-4_R-1"><ParameterRefRef RefId="M-TEST_A-13_P-3_R-1" /></ParameterBlock>
      </ParameterBlock></ChannelIndependentBlock>`);
    const v = buildDeviceConfig(parseAppConfig(ordered), new Map()).blocks;
    expect(v.filter((b) => b.inline).map((b) => [b.id.slice(-4), b.at])).toEqual([["PB-2", 1], ["PB-3", 1]]);
  });

  // A module's nodes are shared by its instances; each instance's inline block stands after its own rows.
  test("each module instance's inline block stands at its own place", () => {
    const xml = readFileSync(join(import.meta.dir, "fixtures", "sample-module-app.xml"), "utf8")
      .replace(/<ParameterBlock Id="M-TEST_A-2_MD-1_PB-1"[\s\S]*?<\/ParameterBlock>/, `<ParameterRefRef RefId="M-TEST_A-2_MD-1_P-1_R-1" />
        <ParameterBlock Id="M-TEST_A-2_MD-1_PB-2" Inline="true"><ComObjectRefRef RefId="M-TEST_A-2_MD-1_O-1_R-1" /></ParameterBlock>`)
      .replace(/(<Repeat[\s\S]*?<\/Repeat>)/, `<ParameterBlock Id="M-TEST_A-2_PB-9" Text="Page">$1</ParameterBlock>`);
    const instances = [
      { id: "MD-1_M-1_MI-1", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "A" }, { refId: "MD-1_A-2", value: "10" }] },
      { id: "MD-1_M-1_MI-2", refId: "MD-1_M-1", args: [{ refId: "MD-1_A-1", value: "B" }, { refId: "MD-1_A-2", value: "20" }] },
    ];
    const blocks = buildDeviceConfig(parseAppConfig(xml), new Map(), undefined, instances).blocks;
    const page = blocks.find((b) => b.id === "M-TEST_A-2_PB-9")!;
    expect(page.items.map((i) => (i.kind === "param" ? i.param.name : i.kind))).toEqual(["Channel A enable", "Channel B enable"]);
    expect(blocks.filter((b) => b.inline).map((b) => [b.id, b.at])).toEqual([
      ["M-TEST_A-2_MD-1_M-1_MI-1_PB-2", 1], ["M-TEST_A-2_MD-1_M-1_MI-2_PB-2", 2],
    ]);
  });
});

// Several ParameterRefs of one parameter share one value (docs/findings.md §9). Modelled on the Jung
// 400021SE: P-S is shown through R-A (the parameter's default 5) and tested through R-B (Value 0);
// the test on R-B picks one of two union members. The place that shows R-A is a nested block, and
// the test comes after it, so a document-order rule would read R-B differently in the UI walk and
// in the image pass.
describe("ParameterRefs of one parameter share its value", () => {
  const xml = (extraRef = "") => `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-40" ApplicationNumber="40" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Share" DefaultLanguage="en-US">
    <Static><ParameterTypes>
      <ParameterType Id="M-TEST_A-40_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="200" /></ParameterType>
    </ParameterTypes><Parameters>
      <Parameter Id="M-TEST_A-40_P-S" Name="Seconds" ParameterType="M-TEST_A-40_PT-N" Text="Seconds" Value="5"><Memory CodeSegment="M-TEST_A-40_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Union SizeInBit="8"><Memory CodeSegment="M-TEST_A-40_RS-4" Offset="1" BitOffset="0" />
        <Parameter Id="M-TEST_A-40_UP-Hi" ParameterType="M-TEST_A-40_PT-N" Text="ms from 100" Value="100" Offset="0" BitOffset="0" />
        <Parameter Id="M-TEST_A-40_UP-Lo" ParameterType="M-TEST_A-40_PT-N" Text="ms from 0" Value="0" Offset="0" BitOffset="0" />
      </Union>
    </Parameters><ParameterRefs>
      <ParameterRef Id="M-TEST_A-40_P-S_R-A" RefId="M-TEST_A-40_P-S" />
      <ParameterRef Id="M-TEST_A-40_P-S_R-B" RefId="M-TEST_A-40_P-S" Value="0" />
      <ParameterRef Id="M-TEST_A-40_UP-Hi_R-H" RefId="M-TEST_A-40_UP-Hi" />
      <ParameterRef Id="M-TEST_A-40_UP-Lo_R-L" RefId="M-TEST_A-40_UP-Lo" />
    </ParameterRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-40_PB-1" Name="m" Text="Main">
      <ParameterBlock Id="M-TEST_A-40_PB-2" Name="n" Text="Nested"><ParameterRefRef RefId="M-TEST_A-40_P-S_R-A" /></ParameterBlock>
      ${extraRef}
      <choose ParamRefId="M-TEST_A-40_P-S_R-B">
        <when test="0"><ParameterRefRef RefId="M-TEST_A-40_UP-Hi_R-H" /></when>
        <when test="&gt;0"><ParameterRefRef RefId="M-TEST_A-40_UP-Lo_R-L" /></when>
      </choose>
    </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const visible = (v: ReturnType<typeof buildDeviceConfig>) => params(v).map((p) => p.param.refId.split("_").pop() ?? "").sort((a, b) => a.localeCompare(b));

  test("a ref that is only tested reads the shown ref's default, in the UI and in the image alike", () => {
    const v = buildDeviceConfig(parseAppConfig(xml()), new Map());
    expect(visible(v)).toEqual(["R-A", "R-L"]);
    expect([...v.imageValues.keys()].map((k) => k.split("_").pop() ?? "").sort((a, b) => a.localeCompare(b))).toEqual(["R-A", "R-L"]);
  });

  test("a value stored on the shown ref is what the tested ref reads", () => {
    const v = buildDeviceConfig(parseAppConfig(xml()), new Map([["M-TEST_A-40_P-S_R-A", "0"]]));
    expect(visible(v)).toEqual(["R-A", "R-H"]);
  });

  test("the shown ref's stored value wins over a stale one on the tested ref", () => {
    const v = buildDeviceConfig(parseAppConfig(xml()), new Map([["M-TEST_A-40_P-S_R-A", "7"], ["M-TEST_A-40_P-S_R-B", "0"]]));
    expect(visible(v)).toEqual(["R-A", "R-L"]);
  });

  test("a value stored only on a ref that is not shown is not what the shown ref writes, nor what a test reads", () => {
    // ETS writes the shown ref's value, else its default: the Theben Meteodata held a value on an
    // unshown ref of a union member (UP-6673 R-6690 = 5); ETS's full download wrote the shown R-6677's
    // default 1, and ETS-programmed Auros hold the shown ref's default where the project stores a
    // value on an unshown one (docs/findings.md §9).
    const v = buildDeviceConfig(parseAppConfig(xml()), new Map([["M-TEST_A-40_P-S_R-B", "0"]]));
    expect(v.imageValues.get("M-TEST_A-40_P-S_R-A")).toBe("5");
    expect(visible(v)).toEqual(["R-A", "R-L"]);
  });

  test("switching which ref is shown shows the new ref's default, not the value stored on the old one", () => {
    // ETS did so on the Jung 400021SE: setting the minutes to 1 placed the seconds' other ref, whose
    // default 0 ETS then wrote, and its export stored no value for the seconds (findings.md §9).
    const sw = `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
      <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-43" ApplicationNumber="43" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Switch" DefaultLanguage="en-US">
      <Static><ParameterTypes><ParameterType Id="M-TEST_A-43_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="200" /></ParameterType></ParameterTypes>
      <Parameters>
        <Parameter Id="M-TEST_A-43_P-M" Name="Minutes" ParameterType="M-TEST_A-43_PT-N" Text="Minutes" Value="0"><Memory CodeSegment="M-TEST_A-43_RS-4" Offset="0" BitOffset="0" /></Parameter>
        <Parameter Id="M-TEST_A-43_P-S" Name="Seconds" ParameterType="M-TEST_A-43_PT-N" Text="Seconds" Value="5"><Memory CodeSegment="M-TEST_A-43_RS-4" Offset="1" BitOffset="0" /></Parameter>
      </Parameters><ParameterRefs>
        <ParameterRef Id="M-TEST_A-43_P-M_R-M" RefId="M-TEST_A-43_P-M" />
        <ParameterRef Id="M-TEST_A-43_P-S_R-A" RefId="M-TEST_A-43_P-S" />
        <ParameterRef Id="M-TEST_A-43_P-S_R-B" RefId="M-TEST_A-43_P-S" Value="0" />
      </ParameterRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-43_PB-1" Name="m" Text="Main">
        <ParameterRefRef RefId="M-TEST_A-43_P-M_R-M" />
        <choose ParamRefId="M-TEST_A-43_P-M_R-M">
          <when test="0"><ParameterRefRef RefId="M-TEST_A-43_P-S_R-A" /></when>
          <when test="&gt;0"><ParameterRefRef RefId="M-TEST_A-43_P-S_R-B" /></when>
        </choose>
      </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
    const app = parseAppConfig(sw);
    const edited = new Map([["M-TEST_A-43_P-S_R-A", "30"]]);
    expect(buildDeviceConfig(app, edited).imageValues.get("M-TEST_A-43_P-S_R-A")).toBe("30");
    const switched = buildDeviceConfig(app, new Map([...edited, ["M-TEST_A-43_P-M_R-M", "1"]]));
    expect([switched.imageValues.get("M-TEST_A-43_P-S_R-B"), switched.imageValues.has("M-TEST_A-43_P-S_R-A")]).toEqual(["0", false]);
  });

  test("a tested ref whose shown siblings carry different defaults reads its own default, not a value stored on it", () => {
    const v = buildDeviceConfig(parseAppConfig(xml('<ParameterRefRef RefId="M-TEST_A-40_P-S_R-B" />').replace('<ParameterRef Id="M-TEST_A-40_P-S_R-B" RefId="M-TEST_A-40_P-S" Value="0" />', '<ParameterRef Id="M-TEST_A-40_P-S_R-B" RefId="M-TEST_A-40_P-S" Value="0" /><ParameterRef Id="M-TEST_A-40_P-S_R-C" RefId="M-TEST_A-40_P-S" Value="0" />').replace('ParamRefId="M-TEST_A-40_P-S_R-B"', 'ParamRefId="M-TEST_A-40_P-S_R-C"')), new Map([["M-TEST_A-40_P-S_R-C", "9"]]));
    // R-A (5) and R-B (0) are shown; the choose on R-C reads R-C's own default 0, not the 9 stored on it.
    expect(visible(v)).toEqual(["R-A", "R-B", "R-H"]);
  });

  test("with both refs shown and different defaults, each keeps its own (which one ETS uses is unknown)", () => {
    const v = buildDeviceConfig(parseAppConfig(xml('<ParameterRefRef RefId="M-TEST_A-40_P-S_R-B" />')), new Map());
    expect(visible(v)).toEqual(["R-A", "R-B", "R-H"]);
  });
});

test("a placement that never settles is refused, not picked", () => {
  // With R-B stored as 0 (assumption: a stored value on an unplaced parameter still evaluates its
  // choose tests), an unplaced P-1 evaluates R-B as 0 and places its sibling R-A; once R-A is
  // placed, R-B reads R-A's default 1 (ignoring the stale stored 0 on unplaced R-B) and places
  // nothing, which makes R-B read 0 again.
  const xml = `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-41" ApplicationNumber="41" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Cycle" DefaultLanguage="en-US">
    <Static><ParameterTypes>
      <ParameterType Id="M-TEST_A-41_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType>
    </ParameterTypes><Parameters>
      <Parameter Id="M-TEST_A-41_P-1" Name="P" ParameterType="M-TEST_A-41_PT-N" Text="P" Value="0"><Memory CodeSegment="M-TEST_A-41_RS-4" Offset="0" BitOffset="0" /></Parameter>
    </Parameters><ParameterRefs>
      <ParameterRef Id="M-TEST_A-41_P-1_R-A" RefId="M-TEST_A-41_P-1" Value="1" />
      <ParameterRef Id="M-TEST_A-41_P-1_R-B" RefId="M-TEST_A-41_P-1" Value="0" />
    </ParameterRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-TEST_A-41_PB-1" Name="m" Text="Main">
      <choose ParamRefId="M-TEST_A-41_P-1_R-B"><when test="0"><ParameterRefRef RefId="M-TEST_A-41_P-1_R-A" /></when></choose>
    </ParameterBlock></ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  expect(() => buildDeviceConfig(parseAppConfig(xml), new Map([["M-TEST_A-41_P-1_R-B", "0"]]))).toThrow(/does not settle/);
});

describe("unplaced memory-backed and editable memoryless parameters in <choose>", () => {
  // I.Trust 1ITRGV_100 (M-02AA_A-0081-10-72A7-O0085) pattern: P-37 (offset 68, default 1) and
  // P-184 (offset 468, default 1) are normal memory-backed parameters placed only in inactive
  // branches. ETS still writes their default into RelMemory(4) (MinEtsVersion 5.0, no
  // DownloadInvisibleParameters), yet does not match <when test="1"> (or test="0") for their
  // <choose> elements, leaving gated com-objects disabled (00 00). Once placed, heading a reached
  // block, targeted by an active <Assign>, sharing a placed sibling ref, or holding a stored value
  // (assumption for unplaced plain/union parameters), the choose matches. Effective access
  // (ref.access ?? param.access) governs whether a ref is Access="None".
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="M-TEST_A-45" ApplicationNumber="45" ApplicationVersion="1" MaskVersion="MV-07B0" MinEtsVersion="5.0" Name="Unplaced Memory Choose" DefaultLanguage="en-US">
  <Static>
    <Code><RelativeSegment Id="M-TEST_A-45_RS-4" LoadStateMachine="4" Size="6"><Data>AAAAAAAA</Data></RelativeSegment></Code>
    <ParameterTypes>
      <ParameterType Id="M-TEST_A-45_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="15" /></ParameterType>
    </ParameterTypes>
    <Parameters>
      <Parameter Id="M-TEST_A-45_P-SW" Name="Switch" ParameterType="M-TEST_A-45_PT-N" Text="Switch" Value="0"><Memory CodeSegment="M-TEST_A-45_RS-4" Offset="0" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-45_P-M1" Name="MemOne" ParameterType="M-TEST_A-45_PT-N" Text="MemOne" Value="1"><Memory CodeSegment="M-TEST_A-45_RS-4" Offset="1" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-45_P-M0" Name="MemZero" ParameterType="M-TEST_A-45_PT-N" Text="MemZero" Value="0"><Memory CodeSegment="M-TEST_A-45_RS-4" Offset="2" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-45_P-ED" Name="MemlessEdit" ParameterType="M-TEST_A-45_PT-N" Text="MemlessEdit" Value="1" />
      <Parameter Id="M-TEST_A-45_P-SUB" Name="Sub" ParameterType="M-TEST_A-45_PT-N" Text="Sub" Value="7"><Memory CodeSegment="M-TEST_A-45_RS-4" Offset="3" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-45_P-REFNONE" Name="RefNone" ParameterType="M-TEST_A-45_PT-N" Text="RefNone" Value="1"><Memory CodeSegment="M-TEST_A-45_RS-4" Offset="4" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-45_P-REFRW" Name="RefRW" ParameterType="M-TEST_A-45_PT-N" Text="RefRW" Access="None" Value="1"><Memory CodeSegment="M-TEST_A-45_RS-4" Offset="5" BitOffset="0" /></Parameter>
      <Parameter Id="M-TEST_A-45_P-HEAD" Name="Head" ParameterType="M-TEST_A-45_PT-N" Text="Head" Value="1" />
    </Parameters>
    <ParameterRefs>
      <ParameterRef Id="M-TEST_A-45_P-SW_R-1" RefId="M-TEST_A-45_P-SW" />
      <ParameterRef Id="M-TEST_A-45_P-M1_R-1" RefId="M-TEST_A-45_P-M1" />
      <ParameterRef Id="M-TEST_A-45_P-M1_R-2" RefId="M-TEST_A-45_P-M1" />
      <ParameterRef Id="M-TEST_A-45_P-M0_R-1" RefId="M-TEST_A-45_P-M0" />
      <ParameterRef Id="M-TEST_A-45_P-ED_R-1" RefId="M-TEST_A-45_P-ED" />
      <ParameterRef Id="M-TEST_A-45_P-SUB_R-1" RefId="M-TEST_A-45_P-SUB" />
      <ParameterRef Id="M-TEST_A-45_P-REFNONE_R-1" RefId="M-TEST_A-45_P-REFNONE" Access="None" />
      <ParameterRef Id="M-TEST_A-45_P-REFRW_R-1" RefId="M-TEST_A-45_P-REFRW" Access="ReadWrite" />
      <ParameterRef Id="M-TEST_A-45_P-HEAD_R-1" RefId="M-TEST_A-45_P-HEAD" />
    </ParameterRefs>
    <ComObjectTable>
      ${[1, 2, 3, 4, 5, 6, 7].map((n) => `<ComObject Id="M-TEST_A-45_O-${n}" Name="O${n}" Number="${n}" Text="O${n}" FunctionText="" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />`).join("")}
    </ComObjectTable>
    <ComObjectRefs>
      ${[1, 2, 3, 4, 5, 6, 7].map((n) => `<ComObjectRef Id="M-TEST_A-45_O-${n}_R-1" RefId="M-TEST_A-45_O-${n}" />`).join("")}
    </ComObjectRefs>
  </Static>
  <Dynamic>
    <ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-45_PB-1" Name="main" Text="Main" ParamRefId="M-TEST_A-45_P-HEAD_R-1">
        <ParameterRefRef RefId="M-TEST_A-45_P-SW_R-1" />
        <choose ParamRefId="M-TEST_A-45_P-SW_R-1">
          <when test="1"><ParameterRefRef RefId="M-TEST_A-45_P-M1_R-1" /><ParameterRefRef RefId="M-TEST_A-45_P-M0_R-1" /><ParameterRefRef RefId="M-TEST_A-45_P-ED_R-1" /></when>
          <when test="2"><ParameterRefRef RefId="M-TEST_A-45_P-M1_R-2" /></when>
          <when test="3"><Assign TargetParamRefRef="M-TEST_A-45_P-M1_R-1" Value="1" /></when>
          <when test="4">
            <ParameterBlock Id="M-TEST_A-45_PB-H" Name="hidden" Access="None">
              <Assign TargetParamRefRef="M-TEST_A-45_P-M1_R-1" Value="1" />
            </ParameterBlock>
          </when>
        </choose>
        <choose ParamRefId="M-TEST_A-45_P-M1_R-1">
          <when test="1"><ComObjectRefRef RefId="M-TEST_A-45_O-1_R-1" /></when>
          <when test="2"><ParameterRefRef RefId="M-TEST_A-45_P-SUB_R-1" /></when>
        </choose>
        <choose ParamRefId="M-TEST_A-45_P-M1_R-2">
          <when test="1"><ComObjectRefRef RefId="M-TEST_A-45_O-2_R-1" /></when>
        </choose>
        <choose ParamRefId="M-TEST_A-45_P-M0_R-1">
          <when test="0"><ComObjectRefRef RefId="M-TEST_A-45_O-3_R-1" /></when>
        </choose>
        <choose ParamRefId="M-TEST_A-45_P-ED_R-1">
          <when test="1"><ComObjectRefRef RefId="M-TEST_A-45_O-4_R-1" /></when>
        </choose>
        <choose ParamRefId="M-TEST_A-45_P-REFNONE_R-1">
          <when test="1"><ComObjectRefRef RefId="M-TEST_A-45_O-5_R-1" /></when>
        </choose>
        <choose ParamRefId="M-TEST_A-45_P-REFRW_R-1">
          <when test="1"><ComObjectRefRef RefId="M-TEST_A-45_O-6_R-1" /></when>
        </choose>
        <choose ParamRefId="M-TEST_A-45_P-HEAD_R-1">
          <when test="1"><ComObjectRefRef RefId="M-TEST_A-45_O-7_R-1" /></when>
        </choose>
      </ParameterBlock>
    </ChannelIndependentBlock>
  </Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const unplacedApp = parseAppConfig(xml);

  test("unplaced memory-backed and editable memoryless parameters match neither test=1 nor test=0; ref-level Access=None and block headings still evaluate; memory defaults still write", () => {
    const v = buildDeviceConfig(unplacedApp, new Map());
    // O-1..O-4 (unplaced P-M1, P-M0, P-ED) and O-6 (Parameter Access=None overridden by ref Access=ReadWrite) stay off;
    // O-5 (ref Access=None on memory-backed P-REFNONE) and O-7 (block-heading P-HEAD) activate.
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([5, 7]);
    expect(comObjs(v)).toHaveLength(2);
    // The skipped choose on unplaced P-M1 does not mark its untaken <when test="2"> branch (P-SUB) as rejected.
    expect(v.rejectedRefs.has("M-TEST_A-45_P-SUB_R-1")).toBe(false);
    // Parameter memory still writes P-M1's default 1 at offset 1, P-SUB's default 7 at offset 3,
    // P-REFNONE's default 1 at offset 4 (MinEtsVersion 5.0); P-REFRW (Parameter Access=None) stays unowned.
    const target = buildRelativeSegmentTarget(unplacedApp, new Map(), 4, { ownIdleUnionDefaults: true })!;
    expect(target.bytes.toString("hex")).toBe("000100070100");
    expect(target.owned).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0]);
  });

  test("once placed, memory-backed and editable memoryless parameters match their tests and reject untaken branches", () => {
    const v = buildDeviceConfig(unplacedApp, new Map([["M-TEST_A-45_P-SW_R-1", "1"]]));
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(v.rejectedRefs.has("M-TEST_A-45_P-SUB_R-1")).toBe(true);
  });

  test("a placed sibling ParameterRef activates chooses on its unplaced sibling ref", () => {
    const v = buildDeviceConfig(unplacedApp, new Map([["M-TEST_A-45_P-SW_R-1", "2"]]));
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([1, 2, 5, 7]);
  });

  test("an active <Assign> targeting an unplaced memory-backed parameter activates its chooses, also from a nested Access=None block", () => {
    for (const sw of ["3", "4"]) {
      const v = buildDeviceConfig(unplacedApp, new Map([["M-TEST_A-45_P-SW_R-1", sw]]));
      expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([1, 2, 5, 7]);
      expect(comObjs(v)).toHaveLength(4);
    }
  });

  test("a stored value on an unplaced memory-backed parameter activates its chooses (assumption)", () => {
    const v = buildDeviceConfig(unplacedApp, new Map([["M-TEST_A-45_P-M1_R-1", "1"]]));
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([1, 2, 5, 7]);
  });

  test("an unplaced <choose> with an unsupported test token still refuses with PARAM_TEST_UNSUPPORTED", () => {
    const bad = parseAppConfig(xml.replace(`<when test="1"><ComObjectRefRef RefId="M-TEST_A-45_O-1_R-1" /></when>`, `<when test="on"><ComObjectRefRef RefId="M-TEST_A-45_O-1_R-1" /></when>`));
    expect(() => buildDeviceConfig(bad, new Map())).toThrow(expect.objectContaining({ code: "PARAM_TEST_UNSUPPORTED" }));
  });
});

// A choose's default branch belongs to a ParameterRef an active branch places; on a ref nothing places it is not
// taken (bussard's syn-choose-never-shown and syn-choose-per-ref, tools/bussard-com-object-zero.test.ts), while a
// ref heading a reached block counts as placed (the Gira, Theben and ABB page parameters). For an Access="None"
// ref no ETS download shows it: both readings are built, and a configuration they image differently is refused.
describe("a choose on a ParameterRef nothing places", () => {
  const xml = (opts: { access?: string; head?: "page" | "gate"; gateMemory?: boolean; place?: boolean; branch?: string; absolute?: boolean } = {}) => `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-44" ApplicationNumber="44" ApplicationVersion="1" MaskVersion="${opts.absolute ? "MV-0705" : "MV-07B0"}" Name="Unplaced" DefaultLanguage="en-US">
    <Static><ParameterTypes>
      <ParameterType Id="M-TEST_A-44_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType>
      <ParameterType Id="M-TEST_A-44_PT-Page"><TypeNone /></ParameterType>
    </ParameterTypes><Parameters>
      <Parameter Id="M-TEST_A-44_P-G" Name="Gate" ParameterType="M-TEST_A-44_PT-N" Text="Gate" Value="0"${opts.gateMemory ? '><Memory CodeSegment="M-TEST_A-44_RS-4" Offset="1" BitOffset="0" /></Parameter>' : " />"}
      <Parameter Id="M-TEST_A-44_P-Page" Name="Page" ParameterType="M-TEST_A-44_PT-Page" Text="Page" Value="" />
      <Parameter Id="M-TEST_A-44_P-V" Name="Value" ParameterType="M-TEST_A-44_PT-N" Text="Value" Value="3"><Memory CodeSegment="M-TEST_A-44_RS-4" Offset="0" BitOffset="0" /></Parameter>
    </Parameters><ParameterRefs>
      <ParameterRef Id="M-TEST_A-44_P-G_R-1" RefId="M-TEST_A-44_P-G"${opts.access ? ` Access="${opts.access}"` : ""} />
      <ParameterRef Id="M-TEST_A-44_P-Page_R-1" RefId="M-TEST_A-44_P-Page" />
      <ParameterRef Id="M-TEST_A-44_P-V_R-1" RefId="M-TEST_A-44_P-V" />
    </ParameterRefs>
    <Code>${opts.absolute ? '<AbsoluteSegment Id="M-TEST_A-44_RS-4" Address="256" Size="2"><Data>AAA=</Data></AbsoluteSegment>' : '<RelativeSegment Id="M-TEST_A-44_RS-4" LoadStateMachine="4" Size="2"><Data>AAA=</Data></RelativeSegment>'}</Code>
    <ComObjectTable>
      <ComObject Id="M-TEST_A-44_O-1" Name="O1" Number="1" Text="Object 1" FunctionText="" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Enabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
    </ComObjectTable><ComObjectRefs><ComObjectRef Id="M-TEST_A-44_O-1_R-1" RefId="M-TEST_A-44_O-1" /></ComObjectRefs>
    </Static><Dynamic><ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-44_PB-1" Name="m" Text="Main"${opts.head ? ` ParamRefId="${opts.head === "page" ? "M-TEST_A-44_P-Page_R-1" : "M-TEST_A-44_P-G_R-1"}"` : ""}>
        <ParameterRefRef RefId="M-TEST_A-44_P-V_R-1" />
        ${opts.place ? '<ParameterRefRef RefId="M-TEST_A-44_P-G_R-1" />' : ""}
        <choose ParamRefId="${opts.head === "page" ? "M-TEST_A-44_P-Page_R-1" : "M-TEST_A-44_P-G_R-1"}">
          <when test="7"><ParameterSeparator Id="M-TEST_A-44_PS-1" Text="seven" /></when>
          <when default="true">${opts.branch ?? '<ComObjectRefRef RefId="M-TEST_A-44_O-1_R-1" />'}</when>
        </choose>
      </ParameterBlock>
    </ChannelIndependentBlock></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const objects = (v: ReturnType<typeof buildDeviceConfig>) => [[...v.imageComObjects.keys()], comObjs(v).length];

  test("a ref of a shown parameter that nothing places takes no default branch", () => {
    expect(objects(buildDeviceConfig(parseAppConfig(xml()), new Map()))).toEqual([[], 0]);
  });

  test("the same ref, placed, takes it", () => {
    expect(objects(buildDeviceConfig(parseAppConfig(xml({ place: true })), new Map()))).toEqual([[1], 1]);
  });

  test("its tests still count: a value stored on it that matches one takes that branch", () => {
    const v = buildDeviceConfig(parseAppConfig(xml()), new Map([["M-TEST_A-44_P-G_R-1", "7"]]));
    expect(v.blocks.flatMap((b) => b.items).some((i) => i.kind === "separator" && i.text === "seven")).toBe(true);
  });

  test("a page parameter heading a reached block is placed, so its choose takes the default branch", () => {
    expect(objects(buildDeviceConfig(parseAppConfig(xml({ head: "page" })), new Map()))).toEqual([[1], 1]);
  });

  test("any memoryless parameter heading a reached block is placed so, as the ABB US/U 4.2's numeric page parameters", () => {
    expect(objects(buildDeviceConfig(parseAppConfig(xml({ head: "gate" })), new Map()))).toEqual([[1], 1]);
  });

  test("a parameter with memory that only heads a reached block decides no default branch ETS shows: refused where it matters", () => {
    expect(() => buildDeviceConfig(parseAppConfig(xml({ head: "gate", gateMemory: true })), new Map())).toThrow(expect.objectContaining({ code: "CHOOSE_DEFAULT_UNSETTLED" }));
    // Its tests still count, and its value is the one stored on it.
    const v = buildDeviceConfig(parseAppConfig(xml({ head: "gate", gateMemory: true })), new Map([["M-TEST_A-44_P-G_R-1", "7"]]));
    expect(v.blocks.flatMap((b) => b.items).some((i) => i.kind === "separator" && i.text === "seven")).toBe(true);
  });

  test("an Access=\"None\" ref whose default branch changes the image is refused", () => {
    expect(() => buildDeviceConfig(parseAppConfig(xml({ access: "None" })), new Map())).toThrow(expect.objectContaining({ code: "CHOOSE_DEFAULT_UNSETTLED" }));
  });

  test("an Access=\"None\" ref whose default branch leaves the image as it is builds, with the branch shown", () => {
    const app = parseAppConfig(xml({ access: "None", branch: '<ParameterSeparator Id="M-TEST_A-44_PS-2" Text="note" />' }));
    const v = buildDeviceConfig(app, new Map());
    expect(v.blocks.flatMap((b) => b.items).some((i) => i.kind === "separator" && i.text === "note")).toBe(true);
    expect(buildRelativeSegmentTarget(app, new Map(), 4)!.bytes.toString("hex")).toBe("0300");
  });

  test("an Access=\"None\" ref whose default branch changes only a parameter's bytes is refused by the image build", () => {
    const app = parseAppConfig(xml({ access: "None", branch: '<Assign TargetParamRefRef="M-TEST_A-44_P-V_R-1" Value="9" />' }));
    expect(buildDeviceConfig(app, new Map()).imageValues.get("M-TEST_A-44_P-V_R-1")).toBe("9");
    expect(() => buildRelativeSegmentTarget(app, new Map(), 4)).toThrow(expect.objectContaining({ code: "CHOOSE_DEFAULT_UNSETTLED" }));
  });

  test("the same on an absolute segment", () => {
    const branch = (value: string) => `<Assign TargetParamRefRef="M-TEST_A-44_P-V_R-1" Value="${value}" />`;
    expect(() => buildAbsoluteSegmentTargets(parseAppConfig(xml({ access: "None", absolute: true, branch: branch("9") })), new Map())).toThrow(expect.objectContaining({ code: "CHOOSE_DEFAULT_UNSETTLED" }));
    // An Assign of the value the parameter holds anyway leaves the bytes as they are.
    expect(buildAbsoluteSegmentTargets(parseAppConfig(xml({ access: "None", absolute: true, branch: branch("3") })), new Map())[0].bytes.toString("hex")).toBe("0300");
  });
});

// Links are resolved against the view, so every active object needs a place in it. Theben places
// measured-value objects directly under a text-less <Channel> (Meteodata 140 S, TheLuxa P300) and
// shared objects in an Access="None" block (MIX 2 "Gemeinsame Objekte"); ETS links both.
describe("objects outside a shown ParameterBlock", () => {
  const co = (n: number) => `<ComObject Id="M-TEST_A-42_O-${n}" Name="O${n}" Number="${n}" Text="Object ${n}" FunctionText="" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Enabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />`;
  const xml = (dynamic: string) => `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-42" ApplicationNumber="42" ApplicationVersion="1" MaskVersion="MV-07B0" Name="Loose" DefaultLanguage="en-US">
    <Static><ParameterTypes><ParameterType Id="M-TEST_A-42_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType></ParameterTypes>
    <Parameters><Parameter Id="M-TEST_A-42_P-1" Name="P" ParameterType="M-TEST_A-42_PT-N" Text="P" Value="1"><Memory CodeSegment="M-TEST_A-42_RS-4" Offset="0" BitOffset="0" /></Parameter></Parameters>
    <ParameterRefs><ParameterRef Id="M-TEST_A-42_P-1_R-1" RefId="M-TEST_A-42_P-1" /></ParameterRefs>
    <ComObjectTable>${co(0)}${co(1)}${co(2)}${co(3)}</ComObjectTable>
    <ComObjectRefs>${[0, 1, 2, 3].map((n) => `<ComObjectRef Id="M-TEST_A-42_O-${n}_R-${n}" RefId="M-TEST_A-42_O-${n}" />`).join("")}</ComObjectRefs>
    </Static><Dynamic>${dynamic}</Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const numbers = (v: ReturnType<typeof buildDeviceConfig>) =>
    v.blocks.flatMap((b) => b.items.flatMap((i) => (i.kind === "comObject" ? [i.comObject.number] : []))).sort((a, b) => a - b);

  test("objects directly under a channel, behind a choose, and in a hidden block are all listed", () => {
    const v = buildDeviceConfig(parseAppConfig(xml(`<Channel Id="M-TEST_A-42_CH-0" Name="Generic" Text="" Number="0">
      <ComObjectRefRef RefId="M-TEST_A-42_O-0_R-0" />
      <choose ParamRefId="M-TEST_A-42_P-1_R-1"><when test="1"><ComObjectRefRef RefId="M-TEST_A-42_O-1_R-1" /></when></choose>
      <ParameterBlock Id="M-TEST_A-42_PB-1" Name="main" Text="Main"><ParameterRefRef RefId="M-TEST_A-42_P-1_R-1" /><ComObjectRefRef RefId="M-TEST_A-42_O-2_R-2" /></ParameterBlock>
      <ParameterBlock Id="M-TEST_A-42_PB-H" Name="shared" Text="Shared" Access="None"><ComObjectRefRef RefId="M-TEST_A-42_O-3_R-3" /></ParameterBlock>
    </Channel>`)), new Map());
    expect(numbers(v)).toEqual([0, 1, 2, 3]);
    expect([...v.imageComObjects.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    const own = v.blocks.find((b) => b.id === "M-TEST_A-42_CH-0")!;
    expect(own.name).toBe("Generic");
    expect(own.items.map((i) => (i.kind === "comObject" ? i.comObject.number : -1))).toEqual([0, 1, 3]);
  });

  test("an object of a hidden block inside a shown block is listed in the shown block", () => {
    const v = buildDeviceConfig(parseAppConfig(xml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-42_PB-1" Name="main" Text="Main"><ParameterRefRef RefId="M-TEST_A-42_P-1_R-1" />
        <ParameterBlock Id="M-TEST_A-42_PB-H" Name="shared" Text="Shared" Access="None"><ComObjectRefRef RefId="M-TEST_A-42_O-3_R-3" /></ParameterBlock>
      </ParameterBlock>
    </ChannelIndependentBlock>`)), new Map());
    expect(v.blocks.map((b) => [b.name, b.items.map((i) => (i.kind === "comObject" ? i.comObject.number : i.kind))])).toEqual([["Main", ["param", 3]]]);
  });

  test("an object outside every channel and block is refused, not dropped", () => {
    expect(() => buildDeviceConfig(parseAppConfig(xml(`<ComObjectRefRef RefId="M-TEST_A-42_O-0_R-0" />`)), new Map())).toThrow(/outside every channel/);
  });
});

describe("parameters the device does not hold", () => {
  // The demo application with its Mode parameter's <Memory> removed, and its Level parameter located in
  // an interface object property instead: the device holds Level, not Mode.
  const memless = parseAppConfig(xml
    .replace(/(<Parameter Id="M-TEST_A-1_P-1"[^>]*>)\s*<Memory [^>]*\/>/, "$1")
    .replace(/(<Parameter Id="M-TEST_A-1_P-2"[^>]*>)\s*<Memory [^>]*\/>/, '$1<Property ObjectIndex="0" PropertyId="51" Offset="0" BitOffset="0" />'));

  test("are marked memoryless in the view; one in memory or in a property is not", () => {
    const ps = params(buildDeviceConfig(memless, new Map()));
    const byRef = (r: string) => ps.find((p) => p.param.refId === r)!.param;
    expect(byRef("M-TEST_A-1_P-1_R-1").memoryless).toBe(true);
    expect(byRef("M-TEST_A-1_P-2_R-2").memoryless).toBeUndefined();
    expect(params(buildDeviceConfig(app, new Map())).every((p) => p.param.memoryless === undefined)).toBe(true);
  });
});

describe("forward-placed Access=None Merkers and Repeat Count=0", () => {
  // Siemens M-0001_A-20DF-22-4073-O000A / Gira M-0008_A-10D7-11-2783-O000A pattern:
  // <choose ParamRefId="...P-M_R-1"> appears before <ParameterRefRef RefId="...P-M_R-1"/> in
  // document order. Because placement settles before the walks run, the forward-placed Merker
  // resolves to its default (1) rather than 0, while a sibling ref (R-2) of the same generic
  // Access="None" Merker parameter stays independent (Theben 493B MD-7_P-7 pattern).
  const mkXml = (dynamic: string) => `<KNX xmlns="http://knx.org/xml/project/23"><ManufacturerData><Manufacturer RefId="M-TEST">
    <ApplicationPrograms><ApplicationProgram Id="M-TEST_A-46" ApplicationNumber="46" ApplicationVersion="1" MaskVersion="MV-07B0" Name="ForwardMerker" DefaultLanguage="en-US">
    <Static>
      <ParameterTypes><ParameterType Id="M-TEST_A-46_PT-N"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="9" /></ParameterType></ParameterTypes>
      <Parameters>
        <Parameter Id="M-TEST_A-46_P-M" Name="Merker" ParameterType="M-TEST_A-46_PT-N" Text="Merker" Access="None" Value="1" />
        <Parameter Id="M-TEST_A-46_P-OUT" Name="Out" ParameterType="M-TEST_A-46_PT-N" Text="Out" Value="0"><Memory CodeSegment="M-TEST_A-46_RS-4" Offset="0" BitOffset="0" /></Parameter>
        <Parameter Id="M-TEST_A-46_P-Z" Name="ZeroRepeat" ParameterType="M-TEST_A-46_PT-N" Text="ZeroRepeat" Value="5"><Memory CodeSegment="M-TEST_A-46_RS-4" Offset="1" BitOffset="0" /></Parameter>
      </Parameters>
      <ParameterRefs>
        <ParameterRef Id="M-TEST_A-46_P-M_R-1" RefId="M-TEST_A-46_P-M" />
        <ParameterRef Id="M-TEST_A-46_P-M_R-2" RefId="M-TEST_A-46_P-M" />
        <ParameterRef Id="M-TEST_A-46_P-OUT_R-0" RefId="M-TEST_A-46_P-OUT" Value="0" />
        <ParameterRef Id="M-TEST_A-46_P-OUT_R-1" RefId="M-TEST_A-46_P-OUT" Value="2" />
        <ParameterRef Id="M-TEST_A-46_P-OUT_R-2" RefId="M-TEST_A-46_P-OUT" Value="7" />
        <ParameterRef Id="M-TEST_A-46_P-Z_R-1" RefId="M-TEST_A-46_P-Z" />
      </ParameterRefs>
      <ComObjectTable>
        <ComObject Id="M-TEST_A-46_O-1" Name="O1" Number="1" Text="O1" FunctionText="" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Enabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
        <ComObject Id="M-TEST_A-46_O-2" Name="O2" Number="2" Text="O2" FunctionText="" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Enabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" ReadOnInitFlag="Disabled" />
      </ComObjectTable>
      <ComObjectRefs>
        <ComObjectRef Id="M-TEST_A-46_O-1_R-1" RefId="M-TEST_A-46_O-1" />
        <ComObjectRef Id="M-TEST_A-46_O-2_R-1" RefId="M-TEST_A-46_O-2" />
      </ComObjectRefs>
    </Static>
    <Dynamic>${dynamic}</Dynamic>
    </ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

  test("evaluates a <choose> on a forward-placed Access=None Merker at its default in UI and image alike", () => {
    const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-1" Name="h" Access="None">
        <choose ParamRefId="M-TEST_A-46_P-M_R-1">
          <when test="0"><ParameterRefRef RefId="M-TEST_A-46_P-OUT_R-0" /></when>
          <when test="1"><ParameterRefRef RefId="M-TEST_A-46_P-OUT_R-1" /><ComObjectRefRef RefId="M-TEST_A-46_O-1_R-1" /></when>
        </choose>
      </ParameterBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-2" Name="main" Text="Main">
        <ParameterRefRef RefId="M-TEST_A-46_P-M_R-1" />
      </ParameterBlock>
    </ChannelIndependentBlock>`));
    const v = buildDeviceConfig(app, new Map());
    expect(v.imageValues.get("M-TEST_A-46_P-OUT_R-1")).toBe("2");
    expect(v.imageValues.has("M-TEST_A-46_P-OUT_R-0")).toBe(false);
    expect(v.imageValues.get("M-TEST_A-46_P-M_R-1")).toBe("1");
    expect([...v.imageComObjects.keys()]).toEqual([1]);
    expect(comObjs(v).map((c) => c.comObject.number)).toEqual([1]);
    expect(v.rejectedRefs.has("M-TEST_A-46_P-OUT_R-0")).toBe(true);
  });

  test("placing one ParameterRef of an Access=None Merker does not activate an unplaced sibling ref", () => {
    const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-1" Name="main" Text="Main">
        <ParameterRefRef RefId="M-TEST_A-46_P-M_R-2" />
        <choose ParamRefId="M-TEST_A-46_P-M_R-1">
          <when test="1"><ParameterRefRef RefId="M-TEST_A-46_P-OUT_R-1" /><ComObjectRefRef RefId="M-TEST_A-46_O-1_R-1" /></when>
        </choose>
      </ParameterBlock>
    </ChannelIndependentBlock>`));
    const v = buildDeviceConfig(app, new Map());
    expect(v.imageValues.has("M-TEST_A-46_P-OUT_R-1")).toBe(false);
    expect([...v.imageComObjects.keys()]).toEqual([]);
    // Unset Merker choose is unevaluated, so its untaken branch is not marked rejected.
    expect(v.rejectedRefs.has("M-TEST_A-46_P-OUT_R-1")).toBe(false);
  });

  test("an <Assign> before a Merker's <ParameterRefRef> is preserved rather than clobbered by placement", () => {
    const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-1" Name="main" Text="Main">
        <Assign TargetParamRefRef="M-TEST_A-46_P-M_R-1" Value="2" />
        <ParameterRefRef RefId="M-TEST_A-46_P-M_R-1" />
        <choose ParamRefId="M-TEST_A-46_P-M_R-1">
          <when test="1"><ParameterRefRef RefId="M-TEST_A-46_P-OUT_R-1" /></when>
          <when test="2"><ParameterRefRef RefId="M-TEST_A-46_P-OUT_R-2" /></when>
        </choose>
      </ParameterBlock>
    </ChannelIndependentBlock>`));
    const v = buildDeviceConfig(app, new Map());
    expect(v.imageValues.get("M-TEST_A-46_P-OUT_R-2")).toBe("7");
    expect(v.imageValues.has("M-TEST_A-46_P-OUT_R-1")).toBe(false);
  });

  test("Repeat Count=0 skips its subtree in placement, UI, Assigns, image values, com-objects, constantParams, and steeringParamIds", () => {
    const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-1" Name="main" Text="Main">
        <choose ParamRefId="M-TEST_A-46_P-M_R-1">
          <when test="1"><ComObjectRefRef RefId="M-TEST_A-46_O-1_R-1" /></when>
        </choose>
        <Repeat Id="M-TEST_A-46_X-0" Count="0">
          <ParameterRefRef RefId="M-TEST_A-46_P-M_R-1" />
          <ParameterRefRef RefId="M-TEST_A-46_P-Z_R-1" />
          <ComObjectRefRef RefId="M-TEST_A-46_O-2_R-1" />
          <Assign TargetParamRefRef="M-TEST_A-46_P-OUT_R-0" Value="9" />
          <ParameterBlock Id="M-TEST_A-46_PB-Z" Name="zero" Text="Zero">
            <ParameterRefRef RefId="M-TEST_A-46_P-OUT_R-2" />
          </ParameterBlock>
        </Repeat>
      </ParameterBlock>
    </ChannelIndependentBlock>`).replace('Id="M-TEST_A-46_P-Z" Name="ZeroRepeat"', 'Id="M-TEST_A-46_P-Z" Name="ZeroRepeat" Access="None"'));
    const v = buildDeviceConfig(app, new Map());
    expect(v.blocks.map((b) => b.id)).toEqual([]);
    expect(v.imageValues.size).toBe(0);
    expect(v.imageComObjects.size).toBe(0);
    expect(v.rejectedRefs.size).toBe(0);
    expect(constantParams(app).has("M-TEST_A-46_P-Z")).toBe(false);
    expect(steeringParamIds(app).has("M-TEST_A-46_P-OUT")).toBe(false);
  });

  test("invalid Repeat Count values refuse with REPEAT_COUNT_INVALID", () => {
    for (const bad of ["1.5", "-1", "Infinity", "", "abc"]) {
      const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
        <ParameterBlock Id="M-TEST_A-46_PB-1" Name="main" Text="Main">
          <Repeat Id="M-TEST_A-46_X-BAD" Count="${bad}"><ParameterRefRef RefId="M-TEST_A-46_P-Z_R-1" /></Repeat>
        </ParameterBlock>
      </ChannelIndependentBlock>`));
      expect(() => buildDeviceConfig(app, new Map())).toThrow(expect.objectContaining({ code: "REPEAT_COUNT_INVALID" }));
    }
  });

  test("a later <Assign> inside a parent block does not retroactively suppress an earlier <choose>'s nested block in the UI", () => {
    const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-1" Name="parent" Text="Parent">
        <ParameterRefRef RefId="M-TEST_A-46_P-Z_R-1" />
        <choose ParamRefId="M-TEST_A-46_P-M_R-1">
          <when test="1">
            <ParameterBlock Id="M-TEST_A-46_PB-2" Name="child" Text="Child">
              <ComObjectRefRef RefId="M-TEST_A-46_O-1_R-1" />
            </ParameterBlock>
          </when>
        </choose>
        <Assign TargetParamRefRef="M-TEST_A-46_P-M_R-1" Value="0" />
        <ParameterRefRef RefId="M-TEST_A-46_P-M_R-1" />
      </ParameterBlock>
    </ChannelIndependentBlock>`));
    const v = buildDeviceConfig(app, new Map());
    expect(v.blocks.map((b) => b.id)).toEqual(["M-TEST_A-46_PB-1", "M-TEST_A-46_PB-2"]);
    expect([...v.imageComObjects.keys()]).toEqual([1]);
    expect(comObjs(v).map((c) => c.comObject.number)).toEqual([1]);
  });

  test("a self-justifying default branch on an unplaced Access=None Merker refuses with CHOOSE_DEFAULT_UNSETTLED", () => {
    const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-1" Name="main" Text="Main">
        <choose ParamRefId="M-TEST_A-46_P-M_R-1">
          <when test="7"><ParameterRefRef RefId="M-TEST_A-46_P-OUT_R-0" /></when>
          <when default="true">
            <ParameterRefRef RefId="M-TEST_A-46_P-M_R-1" />
            <ComObjectRefRef RefId="M-TEST_A-46_O-1_R-1" />
          </when>
        </choose>
      </ParameterBlock>
    </ChannelIndependentBlock>`));
    expect(() => buildDeviceConfig(app, new Map())).toThrow(expect.objectContaining({ code: "CHOOSE_DEFAULT_UNSETTLED" }));
  });

  test("a self-negating Access=None Merker refuses with CONFIG_NOT_RESOLVABLE", () => {
    const app = parseAppConfig(mkXml(`<ChannelIndependentBlock>
      <ParameterBlock Id="M-TEST_A-46_PB-1" Name="main" Text="Main">
        <choose ParamRefId="M-TEST_A-46_P-M_R-1">
          <when test="0"><ParameterRefRef RefId="M-TEST_A-46_P-M_R-1" /></when>
        </choose>
      </ParameterBlock>
    </ChannelIndependentBlock>`));
    expect(() => buildDeviceConfig(app, new Map())).toThrow(expect.objectContaining({ code: "CONFIG_NOT_RESOLVABLE" }));
  });
});
