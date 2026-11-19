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
