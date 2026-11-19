import { test, expect, setDefaultTimeout } from "bun:test";
import { parseAppConfig, parseLoadProcedures, classify, buildDeviceConfig, refuseRawDataWrites } from "../src/index.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 0.5 s with the
// file alone; twenty times that, at least 60 s.
setDefaultTimeout(60_000);

// No ETS download shows a TypeRawData value's bytes (no corpus application declares the type), so no image writes
// one: at its default the segment's <Data> stays where it lies, and every operation that would have to write another
// value refuses (rawdata.ts refuseRawDataWrites). The MEAN WELL power supply (System B, whose full download Busforge
// builds, with a parameter segment <Data>) with one of its active one-byte parameters re-declared as raw data stands
// in for such an application.
corpusDescribe("a TypeRawData parameter on a System B application", () => {
  const A = "M-0085_A-0072-30-69AA";
  const original = parseAppConfig(catalogueXml(`${A}.xml.gz`));
  const [ref, param] = [...buildDeviceConfig(original, new Map()).imageValues.keys()].flatMap((r) => {
    const p = original.params.get(original.refs.get(r)?.paramId ?? "");
    const t = p && original.types.get(p.typeId);
    return p && t && p.offset !== undefined && !p.union && !p.codeSegment?.includes("_AS-") && t.base === "Value" && t.sizeInBit === 8 && p.bitOffset === 0 ? [[r, p] as const] : [];
  })[0];
  const xml = catalogueXml(`${A}.xml.gz`)
    .replace("<ParameterTypes>", `<ParameterTypes><ParameterType Id="${A}_PT-RawTest" Name="RawTest"><TypeRawData MaxSize="5" /></ParameterType>`)
    .replace(new RegExp(`(<Parameter Id="${param.id}" [^>]*ParameterType=")[^"]+"`), `$1${A}_PT-RawTest"`);
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const plan = (params: Map<string, string>) => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params, links: [], proc });
  const changed = new Map([[ref, "0000000201"]]);

  test("the re-declared parameter is raw data, at its default in the defaults", () => {
    expect(cfg.types.get(cfg.params.get(param.id)!.typeId)?.kind).toBe("TypeRawData");
    expect(buildDeviceConfig(cfg, new Map()).imageValues.get(ref)).toBe(param.value!);
  });

  test("at its default a full download keeps the segment's <Data> there", () => {
    const seg = plan(new Map()).segments.find((s) => s.lsm === 4)!;
    const data = cfg.segments.find((s) => s.lsm === 4)!.data;
    expect(data.length).toBeGreaterThan(param.offset!);
    expect(data[param.offset!]).not.toBe(Number(param.value)); // the <Data> byte is not the parameter's default
    expect(seg.image[param.offset!]).toBe(data[param.offset!]);
  });

  test("another value refuses the full download", () => {
    expect(() => plan(changed)).toThrow(expect.objectContaining({ code: "PARAM_RAW_DATA_UNSUPPORTED" }));
  });

  test("a parameter flash refuses a raw-data value the device was not last programmed with, and takes one it was", () => {
    expect(() => refuseRawDataWrites(cfg, changed, [], { values: new Map(), instances: [] })).toThrow(expect.objectContaining({ code: "PARAM_RAW_DATA_UNSUPPORTED" }));
    expect(() => refuseRawDataWrites(cfg, new Map(), [], { values: changed, instances: [] })).toThrow(expect.objectContaining({ code: "PARAM_RAW_DATA_UNSUPPORTED" }));
    expect(() => refuseRawDataWrites(cfg, changed, [], { values: changed, instances: [] })).not.toThrow();
    expect(() => refuseRawDataWrites(cfg, new Map(), [], { values: new Map(), instances: [] })).not.toThrow();
  });
});

// The same rule on System 7 (MV-0705, absolute segments): the MDT BE-02001.02's full download, with one of its
// active one-byte parameters re-declared as raw data.
corpusDescribe("a TypeRawData parameter on a System 7 application", () => {
  const A = "M-0083_A-00B6-32-9642";
  const original = parseAppConfig(catalogueXml(`${A}.xml.gz`));
  const [ref, param] = [...buildDeviceConfig(original, new Map()).imageValues.keys()].flatMap((r) => {
    const p = original.params.get(original.refs.get(r)?.paramId ?? "");
    const t = p && original.types.get(p.typeId);
    return p && t && p.offset !== undefined && !p.union && t.base === "Value" && t.sizeInBit === 8 && p.bitOffset === 0 ? [[r, p] as const] : [];
  })[0];
  const xml = catalogueXml(`${A}.xml.gz`)
    .replace("<ParameterTypes>", `<ParameterTypes><ParameterType Id="${A}_PT-RawTest" Name="RawTest"><TypeRawData MaxSize="5" /></ParameterType>`)
    .replace(new RegExp(`(<Parameter Id="${param.id}" [^>]*ParameterType=")[^"]+"`), `$1${A}_PT-RawTest"`);
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const plan = (params: Map<string, string>) => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params, links: [], proc });

  test("the full download at the default is built, and another value refuses it", () => {
    expect(cfg.mask).toBe("MV-0705");
    expect(cfg.types.get(cfg.params.get(param.id)!.typeId)?.kind).toBe("TypeRawData");
    expect(() => plan(new Map())).not.toThrow();
    expect(() => plan(new Map([[ref, "0000000201"]]))).toThrow(expect.objectContaining({ code: "PARAM_RAW_DATA_UNSUPPORTED" }));
  });
});

// One raw-data parameter behind two ParameterRefs a selector switches between: the refusal compares the parameter's
// value, whichever ref places it, so switching to the other ref at its own default is a change too.
test("a raw-data parameter placed by another ParameterRef than in the configuration the device holds is compared by parameter", () => {
  const A = "M-TEST_A-48";
  const cfg = parseAppConfig(`<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-TEST"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="48" ApplicationVersion="1" MaskVersion="MV-07B0" DefaultLanguage="en-US" Name="Raw refs">
<Static>
<ParameterTypes>
  <ParameterType Id="${A}_PT-Raw" Name="Raw"><TypeRawData MaxSize="5" /></ParameterType>
  <ParameterType Id="${A}_PT-Sel" Name="Sel"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="A" Value="0" Id="${A}_PT-Sel_EN-0" /><Enumeration Text="B" Value="1" Id="${A}_PT-Sel_EN-1" /></TypeRestriction></ParameterType>
</ParameterTypes>
<Parameters>
  <Parameter Id="${A}_P-1" Name="Sel" ParameterType="${A}_PT-Sel" Text="Sel" Value="0"><Memory CodeSegment="${A}_RS-1" Offset="0" BitOffset="0" /></Parameter>
  <Parameter Id="${A}_P-2" Name="Raw" ParameterType="${A}_PT-Raw" Text="Raw" Value="00"><Memory CodeSegment="${A}_RS-1" Offset="1" BitOffset="0" /></Parameter>
</Parameters>
<ParameterRefs><ParameterRef Id="${A}_P-1_R-1" RefId="${A}_P-1" /><ParameterRef Id="${A}_P-2_R-2" RefId="${A}_P-2" /><ParameterRef Id="${A}_P-2_R-3" RefId="${A}_P-2" /></ParameterRefs>
<Code><RelativeSegment Id="${A}_RS-1" Offset="0" Size="8" LoadStateMachine="4" /></Code>
</Static>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="B" Text="B"><ParameterRefRef RefId="${A}_P-1_R-1" />
  <choose ParamRefId="${A}_P-1_R-1"><when test="0"><ParameterRefRef RefId="${A}_P-2_R-2" /></when><when test="1"><ParameterRefRef RefId="${A}_P-2_R-3" /></when></choose>
</ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`);
  const held = new Map([[`${A}_P-2_R-2`, "01"]]);
  expect(() => refuseRawDataWrites(cfg, new Map([[`${A}_P-1_R-1`, "1"]]), [], { values: held, instances: [] })).toThrow(expect.objectContaining({ code: "PARAM_RAW_DATA_UNSUPPORTED" }));
  expect(() => refuseRawDataWrites(cfg, new Map([[`${A}_P-1_R-1`, "1"], [`${A}_P-2_R-3`, "01"]]), [], { values: held, instances: [] })).not.toThrow();
});
