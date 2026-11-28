import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extractAppPrograms } from "../packages/project/src/index.ts";
import type { CollectPackage } from "../packages/product/src/index.ts";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { SWEEP_DIR, type RowSpec } from "./ets-sweep.ts";
import { collectedUnit, type StateInCaptures } from "./sim-unit-model.ts";
import { SIM_UNITS } from "./sim-units.ts";
import { declaredHardwareType, mismatchLines, productAgainstUnit, productUnit, rerunIdentity, type ProductUnit } from "./sim-unit-product.ts";

// Parsing an application (its product unit, its collected unit) takes up to 6.7 s alone (the OpenKNX
// RaumController's, measured with --reporter=junit, the file alone); twenty times that under a loaded full check
// (docs/testing.md, "Timeouts of heavy tests").
setDefaultTimeout(140_000);

// The lines below are of the form decision 0004 §1 quotes from ETS ("Required data mismatch at
// SystemProperty(0/78)[$0000]: <device> instead of <required>"), the values as contiguous hex; the one line a sweep
// row records (a MEAN WELL unit answering a wrong hardware type) is read in tools/sim-unit-catalogue.test.ts.
const at = (rest: string) => `2026-11-20 10:00:00,000 [12] WARN  Knx.Ets.Hawk.LoadDeviceTask - Required data mismatch at ${rest}`;

describe("ETS's Required data mismatch lines", () => {
  test("are read from a Latin-1 ETS6.log", () => {
    const log = Buffer.from([
      "2026-11-20 09:59:59,000 [12] INFO  Knx.Ets.Hawk.LoadDeviceTask - Ger\u00e4t 1.1.1: inkompatible Produktdaten",
      at("SystemProperty(0/78)[$0000]:  instead of 620100000004"),
      at("SystemProperty(0/15)[$0000]: 0000 instead of 4E58"),
      "",
    ].join("\r\n"), "latin1");
    expect(mismatchLines(log).map((m) => [m.object, m.pid, m.device.toString("hex"), m.required.toString("hex")])).toEqual([
      [0, 78, "", "620100000004"],
      [0, 15, "0000", "4e58"],
    ]);
  });

  test("a line that names a mismatch and does not read as one is refused, not skipped", () => {
    expect(() => mismatchLines(at("Memory(0x4000)[$0000]: 00 instead of 01"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0000]: 00 instead of 6"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(256/78)[$0000]:  instead of 01"))).toThrow("no property service addresses");
    // What no recorded line shows the meaning of: another index, a range, spaced octets.
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0002]:  instead of 01"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0000-$0001]:  instead of 6201"))).toThrow("does not read");
    expect(() => mismatchLines(at("SystemProperty(0/78)[$0000]:  instead of 62 01"))).toThrow("does not read");
  });
});

const app = (name: string) => catalogueXml(name);
const MEANWELL = "M-0162_A-0004-11-F245.xml.gz", DALI = "M-0048_A-9071-20-F258-O00EF.xml.gz", ABB = "M-0002_A-A001-13-63C2.xml.gz";
const given = (u: ProductUnit, key: string) => {
  const v = u.properties.get(key);
  return v && { bytes: v.bytes.toString("hex"), known: v.known.toString("hex"), sources: v.sources.map((s) => s.from === "product" ? s.what : s.line) };
};

corpusDescribe("a unit from its product alone", () => {
  test("takes the mask, the manufacturer and what the application's compares expect, each with its source", () => {
    const meanwell = productUnit(app(MEANWELL));
    expect([meanwell.mask, [...meanwell.properties.keys()]]).toEqual([0x07b0, ["0/12", "0/78"]]);
    expect(given(meanwell, "0/12")).toEqual({ bytes: "0162", known: "ffff", sources: ["the application's manufacturer M-0162"] });
    expect(given(meanwell, "0/78")).toEqual({ bytes: "620100000004", known: "ffffffffffff", sources: ["Property 0/78 (M-0162_A-0004-11-F245_P-42 = 620100000004)"] });
    expect([...productUnit(app(MEANWELL), undefined, { includePropertyHardwareType: false }).properties.keys()]).toEqual(["0/12"]);
    const dali = productUnit(app(DALI));
    expect(given(dali, "0/12")!.sources).toEqual(["the application's manufacturer M-0048, made for M-00EF"]);
    expect(given(dali, "0/78")).toEqual({ bytes: "00907092910000000000", known: "ffffffffffffffffffff", sources: ["LdCtrlCompareProp 0/78 00907092910000000000"] });
    // A masked compare gives only the bits it compares.
    expect(given(productUnit(app(ABB)), "3/13")).toEqual({ bytes: "0000a00100", known: "0000ffff00", sources: ["LdCtrlCompareProp 3/13 0000a00100 mask 0000ffff00"] });
  });

  test("refuses a compare it would read as more than it says", () => {
    const withCompare = (attrs: string) => app(MEANWELL).replace("</LoadProcedure>", `<LdCtrlCompareProp ObjIdx="0" PropId="78" ${attrs} /></LoadProcedure>`);
    expect(() => productUnit(withCompare('StartElement="2" InlineData="1234"'))).toThrow("element addressing");
    expect(() => productUnit(withCompare('InlineData="1234" Mask="gg"'))).toThrow("which is no mask");
    expect(() => productUnit(withCompare('InlineData="1234" Count="2"'))).toThrow("declares Count");
    // A compare that contradicts the application's manufacturer.
    expect(() => productUnit(app(MEANWELL).replace("</LoadProcedure>", '<LdCtrlCompareProp ObjIdx="0" PropId="12" InlineData="0048" /></LoadProcedure>'))).toThrow("property 0/12: octet 0 is 01");
    expect(() => productUnit(app(MEANWELL).replace("</LoadProcedure>", '<LdCtrlCompareMem Address="16384" InlineData="00" /></LoadProcedure>'))).toThrow("holds LdCtrlCompareMem");
    // A BCU1 keeps its identity in memory, not in a device object.
    expect(() => productUnit(app("M-0083_A-0138-21-F18E-O0072.xml.gz"))).toThrow("of family system-1");
    // LdCtrlCompareProp on 0/78 takes precedence over <Property ObjectIndex="0" PropertyId="78"/>.
    expect(given(productUnit(withCompare('InlineData="1234" Mask="ff"')), "0/78")).toEqual({ bytes: "1200", known: "ff00", sources: ["LdCtrlCompareProp 0/78 1234 mask ff"] });
  });
});

describe("hardware type pre-seeding (declaredHardwareType)", () => {
  const wrapApp = (body: string, appExtraAttrs = "") =>
    `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0001"><ApplicationPrograms><ApplicationProgram Id="M-0001_A-0001-10-0001" ApplicationNumber="1" ApplicationVersion="16" ProgramType="ApplicationProgram" MaskVersion="MV-07B0" Name="Test" LoadProcedureStyle="MergedProcedure" DefaultLanguage="en-US"${appExtraAttrs}>${body}</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
  const hwApp = (opts: {
    enums?: { v: number; hex: string }[];
    sizeInBit?: number;
    propAttrs?: string;
    paramValue?: string;
    paramExtraAttrs?: string;
    extraParams?: string;
    refs?: string;
    dynamic?: string;
    calculations?: string;
    moduleDefs?: string;
    appExtraAttrs?: string;
    inUnion?: boolean | "union-prop";
    rawBinaryValue?: string;
  }) => {
    const enums = (opts.enums ?? [{ v: 0, hex: "000102030405" }])
      .map((e) => `<Enumeration Id="M-0001_A-0001-10-0001_PT-HW_EN-${e.v}" Value="${e.v}" Text="HW" BinaryValue="${opts.rawBinaryValue ?? b64(e.hex)}" />`)
      .join("");
    const prop = `<Property ${opts.propAttrs ?? 'ObjectIndex="0" PropertyId="78" Offset="0" BitOffset="0"'} />`;
    const param = `<Parameter Id="M-0001_A-0001-10-0001_P-1" Name="HW" ParameterType="M-0001_A-0001-10-0001_PT-HW" Text="HW" Access="None" Value="${opts.paramValue ?? "0"}"${opts.paramExtraAttrs ?? ""}>${opts.inUnion === "union-prop" ? "" : prop}</Parameter>`;
    const paramBlock = opts.inUnion === "union-prop"
      ? `<Union SizeInBit="48">${prop}${param}</Union>`
      : opts.inUnion ? `<Union SizeInBit="48">${param}</Union>` : param;
    const refs = opts.refs ?? '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" />';
    const dyn = opts.dynamic ?? '<ChannelIndependentBlock><ParameterBlock Id="PB-1" Name="B"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></ParameterBlock></ChannelIndependentBlock>';
    return wrapApp(
      `<Static><ParameterTypes><ParameterType Id="M-0001_A-0001-10-0001_PT-HW" Name="HW"><TypeRestriction Base="BinaryValue" SizeInBit="${opts.sizeInBit ?? 48}">${enums}</TypeRestriction></ParameterType><ParameterType Id="M-0001_A-0001-10-0001_PT-SEL" Name="SEL"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="10" /></ParameterType></ParameterTypes><Parameters>${paramBlock}${opts.extraParams ?? ""}</Parameters><ParameterRefs>${refs}</ParameterRefs>${opts.calculations ?? ""}</Static>${opts.moduleDefs ?? ""}<Dynamic>${dyn}</Dynamic>`,
      opts.appExtraAttrs ?? "",
    );
  };

  test("extracts 6-byte 0/78 from single-enum, multi-enum, Assign, choose on Merker, and ApplicationProgram@HardwareType", () => {
    // 1. Single-enum placed, unplaced, and with Occurrence="0".
    const single = declaredHardwareType(hwApp({ propAttrs: 'ObjectIndex="0" PropertyId="78" Offset="0" BitOffset="0" Occurrence="0"' }));
    expect(single && [single.bytes.toString("hex"), single.what]).toEqual(["000102030405", "Property 0/78 (M-0001_A-0001-10-0001_P-1 = 000102030405)"]);
    const unplacedSingle = declaredHardwareType(hwApp({ dynamic: "" }));
    expect(unplacedSingle?.bytes.toString("hex")).toBe("000102030405");

    // 2. Multi-enum single-ref placed unconditionally.
    const multiSingleRef = declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      paramValue: "1",
    }));
    expect(multiSingleRef?.bytes.toString("hex")).toBe("000102030406");

    // 3. Multi-enum with unconditional top-level <Assign> overriding the parameter default.
    const assigned = declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "0002880f0001" }, { v: 1, hex: "0002880f0002" }],
      paramValue: "1",
      dynamic: '<ChannelIndependentBlock><Assign TargetParamRefRef="M-0001_A-0001-10-0001_P-1_R-1" Value="0" /></ChannelIndependentBlock>',
    }));
    expect(assigned?.bytes.toString("hex")).toBe("0002880f0001");

    // 4. Multi-enum selected by <choose> on a Merker placed AFTER the <choose> (as in M-0001_A-20DF).
    const chosen = declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000a800000a9" }, { v: 1, hex: "000a800000b0" }, { v: 2, hex: "000a800000aa" }],
      paramValue: "0",
      extraParams: '<Parameter Id="M-0001_A-0001-10-0001_P-2" Name="Sel" ParameterType="M-0001_A-0001-10-0001_PT-SEL" Text="" Access="None" Value="1" />',
      refs: '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" /><ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-2" RefId="M-0001_A-0001-10-0001_P-1" Value="2" /><ParameterRef Id="M-0001_A-0001-10-0001_P-2_R-2" RefId="M-0001_A-0001-10-0001_P-2" />',
      dynamic: '<ChannelIndependentBlock><choose ParamRefId="M-0001_A-0001-10-0001_P-2_R-2"><when test="0"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></when><when test="1"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-2" /></when></choose><ParameterBlock Id="PB-1" Name="B"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-2_R-2" /></ParameterBlock></ChannelIndependentBlock>',
    }));
    expect(chosen?.bytes.toString("hex")).toBe("000a800000aa");

    // 5. <ApplicationProgram HardwareType="..."/> (strict 6-byte base64).
    const apHw = declaredHardwareType(wrapApp("<Static />", ` HardwareType="${b64("020f040a0d07")}"`));
    expect(apHw && [apHw.bytes.toString("hex"), apHw.what]).toEqual(["020f040a0d07", "ApplicationProgram HardwareType 020f040a0d07"]);
  });

  test("skips cleanly (returns null) whenever ambiguous or unmodelled", () => {
    // Non-zero Offset / BitOffset / Occurrence, extra attribute, or ObjectType="0" without ObjectIndex.
    expect(declaredHardwareType(hwApp({ propAttrs: 'ObjectIndex="0" PropertyId="78" Offset="1" BitOffset="0"' }))).toBeNull();
    expect(declaredHardwareType(hwApp({ propAttrs: 'ObjectIndex="0" PropertyId="78" Offset="0" BitOffset="1"' }))).toBeNull();
    expect(declaredHardwareType(hwApp({ propAttrs: 'ObjectIndex="0" PropertyId="78" Offset="0" BitOffset="0" Occurrence="1"' }))).toBeNull();
    expect(declaredHardwareType(hwApp({ propAttrs: 'ObjectType="0" PropertyId="78" Offset="0" BitOffset="0"' }))).toBeNull();
    // Non-48-bit SizeInBit or non-6-byte BinaryValue.
    expect(declaredHardwareType(hwApp({ sizeInBit: 32, enums: [{ v: 0, hex: "00010203" }] }))).toBeNull();
    expect(declaredHardwareType(hwApp({ sizeInBit: 64, enums: [{ v: 0, hex: "0001020304050607" }] }))).toBeNull();
    // Inside <Union> (either on <Parameter> or directly on <Union>, including alongside HardwareType), InitialValue set, or two <Property 0/78> parameters.
    expect(declaredHardwareType(hwApp({ inUnion: true }))).toBeNull();
    expect(declaredHardwareType(hwApp({ inUnion: "union-prop", appExtraAttrs: ` HardwareType="${b64("000102030405")}"` }))).toBeNull();
    expect(declaredHardwareType(hwApp({ paramExtraAttrs: ' InitialValue="0"' }))).toBeNull();
    expect(declaredHardwareType(hwApp({
      refs: '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" InitialValue="0" />',
      dynamic: '<ChannelIndependentBlock><Assign TargetParamRefRef="M-0001_A-0001-10-0001_P-1_R-1" Value="0" /></ChannelIndependentBlock>',
    }))).toBeNull();
    expect(declaredHardwareType(hwApp({
      extraParams: '<Parameter Id="M-0001_A-0001-10-0001_P-9" Name="HW2" ParameterType="M-0001_A-0001-10-0001_PT-HW" Text="HW2" Access="None" Value="0"><Property ObjectIndex="0" PropertyId="78" Offset="0" BitOffset="0" /></Parameter>',
    }))).toBeNull();
    // Non-canonical ObjectIndex="00" or PropertyId="078" blocks falling through to ApplicationProgram@HardwareType.
    expect(declaredHardwareType(hwApp({ propAttrs: 'ObjectIndex="00" PropertyId="78" Offset="0" BitOffset="0"', appExtraAttrs: ` HardwareType="${b64("000102030405")}"` }))).toBeNull();
    expect(declaredHardwareType(hwApp({ propAttrs: 'ObjectIndex="0" PropertyId="078" Offset="0" BitOffset="0"', appExtraAttrs: ` HardwareType="${b64("000102030405")}"` }))).toBeNull();
    // Invalid base64 in BinaryValue (Node's permissive decoder would silently strip '!').
    expect(declaredHardwareType(hwApp({ rawBinaryValue: "AAEC!AwQF" }))).toBeNull();
    // Output of a <ParameterCalculation> (e.g. JS script).
    expect(declaredHardwareType(hwApp({
      calculations: '<ParameterCalculations><ParameterCalculation Id="PC-1" Language="JavaScript"><LParameters /><RParameters><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></RParameters><LRTransformation>x = 0;</LRTransformation></ParameterCalculation></ParameterCalculations>',
    }))).toBeNull();
    // <Assign Source=.../>, conflicting active refs, conflicting <Assign>s, unplaced multi-enum, or untaken-branch single-enum.
    expect(declaredHardwareType(hwApp({
      dynamic: '<ChannelIndependentBlock><Assign TargetParamRefRef="M-0001_A-0001-10-0001_P-1_R-1" SourceParamRefRef="M-0001_A-0001-10-0001_P-2_R-2" /></ChannelIndependentBlock>',
    }))).toBeNull();
    expect(declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      dynamic: '<ChannelIndependentBlock><Assign TargetParamRefRef="M-0001_A-0001-10-0001_P-1_R-1" Value="0" /><Assign TargetParamRefRef="M-0001_A-0001-10-0001_P-1_R-1" Value="1" /></ChannelIndependentBlock>',
    }))).toBeNull();
    expect(declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      refs: '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" Value="0" /><ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-2" RefId="M-0001_A-0001-10-0001_P-1" Value="1" />',
      dynamic: '<ChannelIndependentBlock><ParameterBlock Id="PB-1" Name="B"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-2" /></ParameterBlock></ChannelIndependentBlock>',
    }))).toBeNull();
    expect(declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      dynamic: "",
    }))).toBeNull();
    // Single-enum gated behind an untaken <choose> branch must NOT fire the unplaced fallback.
    expect(declaredHardwareType(hwApp({
      extraParams: '<Parameter Id="M-0001_A-0001-10-0001_P-2" Name="Sel" ParameterType="M-0001_A-0001-10-0001_PT-SEL" Text="" Access="None" Value="0" />',
      refs: '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" /><ParameterRef Id="M-0001_A-0001-10-0001_P-2_R-2" RefId="M-0001_A-0001-10-0001_P-2" />',
      dynamic: '<ChannelIndependentBlock><choose ParamRefId="M-0001_A-0001-10-0001_P-2_R-2"><when test="1"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></when></choose></ChannelIndependentBlock>',
    }))).toBeNull();
    // Unplaced non-zero Merker, or Merker only placed inside an untaken <choose> branch, or inside <Repeat Count="0">.
    expect(declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      extraParams: '<Parameter Id="M-0001_A-0001-10-0001_P-2" Name="Sel" ParameterType="M-0001_A-0001-10-0001_PT-SEL" Text="" Access="None" Value="1" />',
      refs: '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" Value="0" /><ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-2" RefId="M-0001_A-0001-10-0001_P-1" Value="1" /><ParameterRef Id="M-0001_A-0001-10-0001_P-2_R-2" RefId="M-0001_A-0001-10-0001_P-2" />',
      dynamic: '<ChannelIndependentBlock><choose ParamRefId="M-0001_A-0001-10-0001_P-2_R-2"><when test="0"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></when><when test="1"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-2" /></when></choose></ChannelIndependentBlock>',
    }))).toBeNull();
    expect(declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      extraParams: '<Parameter Id="M-0001_A-0001-10-0001_P-2" Name="Sel" ParameterType="M-0001_A-0001-10-0001_PT-SEL" Text="" Access="None" Value="1" /><Parameter Id="M-0001_A-0001-10-0001_P-3" Name="Gate" ParameterType="M-0001_A-0001-10-0001_PT-SEL" Text="" Access="None" Value="0" />',
      refs: '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" Value="0" /><ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-2" RefId="M-0001_A-0001-10-0001_P-1" Value="1" /><ParameterRef Id="M-0001_A-0001-10-0001_P-2_R-2" RefId="M-0001_A-0001-10-0001_P-2" /><ParameterRef Id="M-0001_A-0001-10-0001_P-3_R-3" RefId="M-0001_A-0001-10-0001_P-3" />',
      dynamic: '<ChannelIndependentBlock><choose ParamRefId="M-0001_A-0001-10-0001_P-3_R-3"><when test="1"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-2_R-2" /></when></choose><choose ParamRefId="M-0001_A-0001-10-0001_P-2_R-2"><when test="0"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></when><when test="1"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-2" /></when></choose></ChannelIndependentBlock>',
    }))).toBeNull();
    expect(declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      dynamic: '<ChannelIndependentBlock><Repeat Id="R-0" Name="Empty" Count="0"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></Repeat></ChannelIndependentBlock>',
    }))).toBeNull();
    // Selector assigned inside a <ModuleDef>.
    expect(declaredHardwareType(hwApp({
      enums: [{ v: 0, hex: "000102030405" }, { v: 1, hex: "000102030406" }],
      extraParams: '<Parameter Id="M-0001_A-0001-10-0001_P-2" Name="Sel" ParameterType="M-0001_A-0001-10-0001_PT-SEL" Text="" Access="None" Value="0" />',
      refs: '<ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-1" RefId="M-0001_A-0001-10-0001_P-1" Value="0" /><ParameterRef Id="M-0001_A-0001-10-0001_P-1_R-2" RefId="M-0001_A-0001-10-0001_P-1" Value="1" /><ParameterRef Id="M-0001_A-0001-10-0001_P-2_R-2" RefId="M-0001_A-0001-10-0001_P-2" />',
      moduleDefs: '<ModuleDefs><ModuleDef Id="M-0001_A-0001-10-0001_MD-1" Name="M"><Static /><Dynamic><Assign TargetParamRefRef="M-0001_A-0001-10-0001_P-2_R-2" Value="1" /></Dynamic></ModuleDef></ModuleDefs>',
      dynamic: '<ChannelIndependentBlock><choose ParamRefId="M-0001_A-0001-10-0001_P-2_R-2"><when test="0"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-1" /></when><when test="1"><ParameterRefRef RefId="M-0001_A-0001-10-0001_P-1_R-2" /></when></choose></ChannelIndependentBlock>',
    }))).toBeNull();
    // Malformed or conflicting ApplicationProgram@HardwareType.
    expect(declaredHardwareType(wrapApp("<Static />", ' HardwareType="not-b64"'))).toBeNull();
    expect(declaredHardwareType(hwApp({ appExtraAttrs: ` HardwareType="${b64("ffffffffffff")}"` }))).toBeNull();
  });
});

corpusDescribe("hardware type pre-seeding against stored sweep rows", () => {
  test("matches 100% byte-for-byte on every 0/78 identity-loop row and reproduces every pre-seeded 0/78 row", () => {
    const root = corpusPath(SWEEP_DIR);
    let checked = 0, matched = 0, preseeded = 0;
    const extracted = new Map<string, string | null>();
    for (const appName of readdirSync(root).sort()) {
      const ad = join(root, appName);
      if (!statSync(ad).isDirectory()) continue;
      for (const v of readdirSync(ad).sort()) {
        const vd = join(ad, v);
        if (!statSync(vd).isDirectory()) continue;
        const spec = JSON.parse(readFileSync(join(vd, "row.json"), "utf8")) as RowSpec;
        if (typeof spec.unit === "string" || !spec.export) continue;
        const m78 = spec.unit.identity.flatMap((l) => mismatchLines(l)).find((m) => m.object === 0 && m.pid === 78);
        const prop78 = spec.unit.properties["0/78"];
        const isPreseeded = typeof prop78 === "string" && (prop78.startsWith("product: Property 0/78 ") || prop78.startsWith("product: ApplicationProgram HardwareType "));
        if (!m78 && !isPreseeded) continue;
        const raw = readFileSync(join(vd, spec.export));
        const xml = extractAppPrograms(spec.export.endsWith(".gz") ? gunzipSync(raw) : raw, [appName]).get(appName)!;
        const hw = declaredHardwareType(xml);
        extracted.set(appName, hw ? hw.bytes.toString("hex") : null);
        if (m78) {
          checked++;
          if (hw) {
            expect([appName, hw.bytes.toString("hex")]).toEqual([appName, m78.required.toString("hex")]);
            matched++;
          }
        } else {
          expect(hw).not.toBeNull();
          expect(`product: ${hw!.what}`).toBe(prop78);
          preseeded++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(28);
    expect(matched).toBeGreaterThanOrEqual(27);
    expect(preseeded).toBeGreaterThanOrEqual(10);
    // Representative rows from every extraction pattern (single-enum, choose on Merker, Assign, AP@HardwareType, JS calc skip).
    expect(extracted.get("M-00C5_A-0366-11-7FCE")).toBe("0000c5030001");
    expect(extracted.get("M-0001_A-20DF-22-4073-O000A")).toBe("000a800000aa");
    expect(extracted.get("M-002C_A-05E2-10-FC64")).toBe("0067900320a0");
    expect(extracted.get("M-0288_A-F001-10-88F7")).toBe("0002880f0001");
    expect(extracted.get("M-0310_A-0001-10-64AA")).toBe("020f040a0d07");
    // M-021E computes 0/78 via a JavaScript <ParameterCalculation>: skipped cleanly so the identity loop handles it.
    expect(extracted.get("M-021E_A-0016-11-6EC4")).toBeNull();
  });
});

corpusDescribe("the identity loop's rerun step", () => {
  const meanwell = () => productUnit(app(MEANWELL), undefined, { includePropertyHardwareType: false });
  const ok = (r: ReturnType<typeof rerunIdentity>) => { if ("refused" in r) throw new Error(r.refused); return r; };

  test("takes what ETS required where the product does not give it, with the line as its source", () => {
    const line = at("SystemProperty(0/78)[$0000]:  instead of 620100000004");
    const r = ok(rerunIdentity(meanwell(), `${line}\n`));
    expect(given(r.identity, "0/78")).toEqual({ bytes: "620100000004", known: "ffffffffffff", sources: [line] });
    expect(r.learned.map((m) => m.line)).toEqual([line]);
  });

  test("refuses a run whose log names no mismatch, or one it cannot read", () => {
    expect(rerunIdentity(meanwell(), "2026-11-20 10:00:00,000 [12] ERROR Knx.Ets.Hawk.LoadDeviceTask - Timeout")).toEqual({ refused: "the run's ETS6.log names no required data: its failure is not the identity" });
    expect((rerunIdentity(meanwell(), at("SystemProperty(0/78)[$0000]: 00 instead of 6")) as { refused: string }).refused).toContain("does not read");
  });

  test("refuses a mismatch against the product, between two lines, or of another run", () => {
    const refused = (u: ProductUnit, ...lines: string[]) => (rerunIdentity(u, lines.join("\n")) as { refused?: string }).refused;
    // The DALI-Gateway's application gives 0/78 in full.
    expect(refused(productUnit(app(DALI)), at("SystemProperty(0/78)[$0000]: 00907092910000000000 instead of 009070929101"))).toContain("octet 5 is 00");
    expect(refused(meanwell(), at("SystemProperty(0/78)[$0000]:  instead of 620100000004"), at("SystemProperty(0/78)[$0000]:  instead of 620100000005"))).toContain("ETS requires both 620100000004 and 620100000005 in 0/78 in one run: which the unit is to answer is not shown");
    // Two lengths of one property in one run (a 6- and a 10-octet 0/78), the shorter the longer's beginning.
    expect(refused(meanwell(), at("SystemProperty(0/78)[$0000]:  instead of 620100000004"), at("SystemProperty(0/78)[$0000]:  instead of 62010000000400000000"))).toContain("in one run: which the unit is to answer is not shown");
    expect(refused(meanwell(), at("SystemProperty(0/12)[$0000]: 0048 instead of 0162"))).toContain("which this identity does not answer");
    expect(refused(meanwell(), at("SystemProperty(0/12)[$0000]: 0162 instead of 0162"))).toContain("which this identity already answers");
    // A required value the unit's answer begins with, shorter than it: ETS failed on the longer answer.
    expect(refused(meanwell(), at("SystemProperty(0/12)[$0000]: 0162 instead of 01"))).toContain("ETS requires the 1 octets 01 in 0/12, where this identity answers 2 beginning with them: an answer shorter than the unit's is not modelled");
    // Each line is checked against the run's identity, also one whose required value an earlier line already gave.
    expect(refused(meanwell(), at("SystemProperty(0/15)[$0000]:  instead of 0102"), at("SystemProperty(0/15)[$0000]: ff instead of 0102"))).toContain("which this identity does not answer");
  });
});

// The simulated units, each with the collection it is simulated from.
const UNITS: { id: string; collection: string; catalogue: string; stateInCaptures?: StateInCaptures }[] =
  SIM_UNITS.map((s) => ({ id: s.id, collection: s.collection, catalogue: s.catalogue, stateInCaptures: s.memoryMapped || s.propertyMapped ? undefined : s.behaviour.stateInCaptures }));

// What a unit from the product alone gets wrong against the unit from its collection, every difference: the
// manufacturer is right on all of them (on the Jung, the Gira and the DALI-Gateway too, whose applications were made
// for another manufacturer); what the compares and <Property ObjectIndex="0" PropertyId="78"/> give is right but for
// its length where the unit answers fewer octets than a compare declares (the DALI-Gateway, the two MDTs) and the bits
// a mask leaves out (the ABB); everything else a unit answers ETS before a download (serial 0/11, order info 0/15,
// version 0/25, hardware type 0/78 where neither a compare nor <Property 0/78> names it, device control 0/14, maximum
// APDU 0/56, the load states and tables, the descriptions) the product does not give.
const EXPECTED: Record<string, string[]> = {
  "meanwell-knx40e": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/19 0/25 0/51 0/54 0/56 0/83 0/240 1/1 1/5 1/7 1/23 1/27 2/1 2/5 2/7 2/23 2/27 3/1 3/5 3/7 3/23 3/27 4/1 4/5 4/6 4/7 4/13 4/27 5/1 5/5 5/6 5/13 6/1 7/1 7/51 7/52 7/53 7/60",
    "descriptions not given: 110 for 64 object indices",
  ],
  "theben-dali-gateway": [
    "given as the unit holds them: 0/12",
    "0/78 length: product 10 octets 00907092910000000000, unit 6 octets 009070929100",
    "properties not given: 0/1 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/51 0/52 0/54 0/56 0/57 0/58 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 6/202 6/203 6/204 6/205 6/206 6/207 6/208 6/209 6/210 6/211 6/213 6/214 6/216 6/217 6/218 6/219 6/220 6/221 6/224 6/225 6/226 6/227 6/228",
    "descriptions not given: 137 for 64 object indices",
  ],
  "openknx-raumcontroller": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/9 0/11 0/14 0/15 0/25 0/51 0/54 0/56 0/57 0/58 0/71 0/83 1/1 1/5 1/7 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/27 3/28 4/1 4/5 4/7 4/13 4/16 4/27 4/28 5/5 5/13",
    "descriptions not given: 101 for 64 object indices",
  ],
  "theben-mix2-hmg6t": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/83 0/85 0/86 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 7/1 7/5 7/7 7/27 7/52 7/53 7/54 8/1",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000",
  ],
  "jung-400021se": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/71 0/83 0/85 0/86 0/201 0/202 0/203 1/1 1/5 1/7 1/23 1/27 2/1 2/5 2/7 2/23 2/27 3/1 3/5 3/7 3/23 3/27 4/1 4/5 4/6 4/7 4/13 4/16 4/27 5/1 5/5 5/6 5/7 5/13 5/16 5/27 6/1 6/2 7/1 8/1 8/2 8/5 8/7 8/25 8/27 9/1 9/2 9/5 9/7 9/25 9/27 10/1",
    "descriptions not given: 150 for 64 object indices",
    "function-property states not given: 17/1/51 0000",
    "A_MemoryExtended_Read not given",
  ],
  "gvs-amma": [
    "given as the unit holds them: 0/12 4/66",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/78 0/83 0/196 0/197 0/198 0/201 0/203 0/204 0/205 0/206 0/224 1/1 1/5 1/7 1/23 1/27 2/1 2/5 2/7 2/23 2/27 3/1 3/5 3/7 3/23 3/27 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/67 5/1 5/5 5/6 5/13 5/27 6/1 7/1 7/222 11/1 11/222",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000",
  ],
  "abb-usu-4.2": [
    "given as the unit holds them: 0/12",
    "3/13 given in part: product ????a001??, unit 0002a00113",
    "properties not given: 0/1 0/9 0/11 0/14 0/15 0/16 0/25 0/56 0/78 1/1 1/5 1/7 2/1 2/5 2/7 3/1 3/5 3/6 3/7 3/16 3/20 3/204 4/1 4/13",
    "descriptions not given: 85 for 64 object indices",
  ],
  "theben-meteodata-140s": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/78 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/128 5/129 5/130 5/131 5/132 5/133 5/134 5/135 5/144 5/145 5/146 5/147 5/148 5/149 5/160 5/161 5/162 5/163 5/164 5/165 5/166 5/167 5/168 5/169 5/170 5/171 5/172",
    "descriptions not given: 121 for 64 object indices",
  ],
  "mdt-be02001": [
    "given as the unit holds them: 0/12",
    "0/78 length: product 10 octets 0000000002ac00000000, unit 6 octets 0000000002ac",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/19 0/25 0/54 0/56 0/83 0/240 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/51 5/52 5/53 5/60",
    "descriptions not given: 95 for 64 object indices",
  ],
  "gira-ts3": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/201 0/203 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27",
    "descriptions not given: 94 for 64 object indices",
  ],
  "theben-mix2-jmg4t": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/83 0/85 0/86 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 7/1 7/5 7/7 7/27 7/52 7/53 7/54 8/1",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000"
  ],
  "theben-mix2-rmg8t": [
    "given as the unit holds them: 0/12 0/78",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/30 0/51 0/52 0/54 0/56 0/57 0/58 0/71 0/83 0/85 0/86 1/1 1/5 1/7 1/23 1/27 1/28 2/1 2/5 2/7 2/23 2/27 2/28 3/1 3/5 3/7 3/23 3/27 3/28 4/1 4/5 4/6 4/7 4/13 4/16 4/27 4/28 5/1 5/5 5/6 5/7 5/13 5/16 5/27 5/28 6/1 7/1 7/5 7/7 7/27 7/52 7/53 7/54 8/1",
    "descriptions not given: 153 for 64 object indices",
    "function-property states not given: 17/1/51 0000"
  ],
  "auro-m0081": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/78 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27",
    "descriptions not given: 93 for 64 object indices"
  ],
  "theben-theluxa-p300": [
    "given as the unit holds them: 0/12",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/16 0/19 0/25 0/56 0/78 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/16 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/129",
    "descriptions not given: 95 for 64 object indices"
  ],
  "mdt-be06001": [
    "given as the unit holds them: 0/12",
    "0/78 length: product 10 octets 0000000002aa00000000, unit 6 octets 0000000002aa",
    "properties not given: 0/1 0/8 0/9 0/11 0/14 0/15 0/19 0/25 0/54 0/56 0/83 0/240 1/1 1/5 1/7 1/27 2/1 2/5 2/7 2/27 3/1 3/5 3/6 3/13 3/27 4/1 4/5 4/6 4/13 4/27 5/1 5/51 5/52 5/53 5/60",
    "descriptions not given: 95 for 64 object indices"
  ],
};

corpusDescribe("a collected unit's property answered with a count and refused", () => {
  test("is held as refused in either order of the records; an element answered and refused is a contradiction", () => {
    // The GVS AMMA answered 0/224 with count 1 and refused its element 1.
    const gvs = SIM_UNITS.find((u) => u.id === "gvs-amma")!;
    const collection = JSON.parse(readFileSync(corpusPath(gvs.collection), "utf8")) as CollectPackage;
    const xml = app(gvs.catalogue);
    const is224 = (r: CollectPackage["records"][number]) => { const t = r.target as { object?: number; pid?: number }; return r.space === "property" && t.object === 0 && t.pid === 224; };
    const of224 = collection.records.filter(is224);
    expect(of224.map((r) => [(r.target as { start: number }).start, r.outcome])).toEqual([[0, "bytes"], [1, "refused"]]);
    const unit = (records: CollectPackage["records"]) => collectedUnit({ ...collection, records }, xml, (why) => { throw new Error(why); }).objects.get(0)!.get(224);
    const rest = collection.records.filter((r) => !is224(r));
    expect([unit(collection.records), unit([...rest, ...[...of224].reverse()])]).toEqual([{ elements: null, countKnown: false }, { elements: null, countKnown: false }]);
    const answered = { ...of224[1], target: { ...(of224[1].target as object), start: 1 }, outcome: "bytes", bytes: "00" } as CollectPackage["records"][number];
    expect(() => unit([...rest, answered, of224[1]])).toThrow("the unit answered property 0/224 and refused it");
    expect(() => unit([...rest, of224[1], answered])).toThrow("the unit refused property 0/224 and answered it");
  });
});

corpusDescribe("the units from their product against their collection: every difference", () => {
  for (const u of UNITS) test(u.id, () => {
    const collection = JSON.parse(readFileSync(corpusPath(u.collection), "utf8")) as CollectPackage;
    const xml = app(u.catalogue);
    const unit = collectedUnit(collection, xml, (why) => { throw new Error(`${u.id}: ${why}`); }, u.stateInCaptures);
    expect(productAgainstUnit(productUnit(xml), unit)).toEqual(EXPECTED[u.id]);
  });
});
