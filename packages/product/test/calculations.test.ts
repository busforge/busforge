import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { parseAppConfig, resolveModuleInstances, classify, parseLoadProcedures, toAppModel } from "../src/index.ts";
import { applyCalculations } from "../src/calculations.ts";
import { buildRelativeSegmentTarget, refuseCalculationWrites } from "../src/deviceimage.ts";
import { scriptRefusal } from "../src/script/index.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { catalogueXml } from "../../../tools/corpus.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): the corpus tests take up to 10.3 s
// with the file alone at load 42 (the four applications parsed once, in the first). Twenty times that.
setDefaultTimeout(210_000);

// A System B product of its own: `a` (shown, default 10) at +0, the calculation's results `b` (shown, read-only) at
// +2, `c` (in no block, LegacyPatchAlways) at +4, `d` (in no block) at +6, `e` (shown, writable) at +8, all 16-bit
// unsigned; `sel` (no memory) steers a choose. The capture comparison of bussard's synthetic product of this shape
// is in tools/bussard-synthetic.test.ts.
const A = "M-0005_A-0C01-01-0001";
const R = (p: string) => `${A}_${p}_R`;
const param = (id: string, name: string, offset: number, extra = "") =>
  `<Parameter Id="${A}_${id}" Name="${name}" ParameterType="${A}_PT-N" Text="${name}" Value="${id === "P-1" ? 10 : 0}" ${extra}><Memory CodeSegment="${A}_RS-1" Offset="${offset}" BitOffset="0"/></Parameter>`;
interface Calc { id?: string; lang?: string; script?: string; func?: string; inputs?: readonly string[]; outputs: readonly string[] }
const appXml = (calcs: Calc[]) => `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0005"><ApplicationPrograms>
<ApplicationProgram Id="${A}" ApplicationNumber="3073" ApplicationVersion="1" ProgramType="ApplicationProgram" MaskVersion="MV-07B0" Name="Calc" LoadProcedureStyle="MergedProcedure" PeiType="0" DefaultLanguage="en-US">
<Static>
  <Code><RelativeSegment Id="${A}_RS-1" Name="main" Size="16" LoadStateMachine="4" Offset="0"><Data>/////////////////////w==</Data></RelativeSegment></Code>
  <ParameterTypes>
    <ParameterType Id="${A}_PT-N" Name="N"><TypeNumber SizeInBit="16" Type="unsignedInt" minInclusive="0" maxInclusive="65535"/></ParameterType>
    <ParameterType Id="${A}_PT-S" Name="S"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="off" Value="0" Id="${A}_PT-S_EN-0"/><Enumeration Text="on" Value="1" Id="${A}_PT-S_EN-1"/></TypeRestriction></ParameterType>
  </ParameterTypes>
  <Parameters>
    ${param("P-1", "a", 0)}${param("P-2", "b", 2, 'Access="Read"')}${param("P-3", "c", 4, 'LegacyPatchAlways="true"')}${param("P-4", "d", 6)}${param("P-5", "e", 8)}
    <Parameter Id="${A}_P-6" Name="sel" ParameterType="${A}_PT-S" Text="sel" Value="0"/>
  </Parameters>
  <ParameterRefs>${["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"].map((p) => `<ParameterRef Id="${R(p)}" RefId="${A}_${p}"/>`).join("")}</ParameterRefs>
  <ParameterCalculations>${calcs.map((c, k) => `<ParameterCalculation Id="${A}_PC-${c.id ?? k + 1}" Name="calc${k + 1}" Language="${c.lang ?? "JavaScript"}"${c.func ? ` LRTransformationFunc="${c.func}"` : ""}>
    ${c.script !== undefined ? `<LRTransformation>${c.script}</LRTransformation>` : ""}
    <LParameters>${(c.inputs ?? ["P-1"]).map((p) => `<ParameterRefRef RefId="${R(p)}"/>`).join("")}</LParameters>
    <RParameters>${c.outputs.map((p) => `<ParameterRefRef RefId="${R(p)}"/>`).join("")}</RParameters>
  </ParameterCalculation>`).join("")}</ParameterCalculations>
  <LoadProcedures><LoadProcedure MergeId="2"><LdCtrlRelSegment LsmIdx="4" Size="16" Mode="1" Fill="255"/></LoadProcedure><LoadProcedure MergeId="4"><LdCtrlWriteRelMem ObjIdx="4" Offset="0" Size="16" Verify="true"/></LoadProcedure></LoadProcedures>
</Static>
<Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="general" Text="General">
  <ParameterRefRef RefId="${R("P-1")}"/><ParameterRefRef RefId="${R("P-2")}"/><ParameterRefRef RefId="${R("P-5")}"/><ParameterRefRef RefId="${R("P-6")}"/>
  <choose ParamRefId="${R("P-6")}"><when test="1"><ParameterRefRef RefId="${R("P-5")}"/></when></choose>
</ParameterBlock></ChannelIndependentBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
const app = (...calcs: Calc[]) => parseAppConfig(appXml(calcs));
const doubled: Calc = { script: "b = a * 2 + 1;\nc = a + 7;", outputs: ["P-2", "P-3"] };
const vals = (o: Record<string, string>) => new Map(Object.entries(o).map(([p, v]) => [R(p), v]));
const segment = (cfg: ReturnType<typeof app>, v: Map<string, string>) => buildRelativeSegmentTarget(cfg, v, 4, { ownIdleUnionDefaults: true })!.bytes.subarray(0, 10).toString("hex");
const refused = (reason: string | RegExp) => expect.objectContaining({ code: "PARAM_CALCULATION_UNSUPPORTED", message: expect.stringMatching(reason) });
const runOf = (cfg: ReturnType<typeof app>, v: Map<string, string>) => applyCalculations(cfg, v, []).runs[0];

describe("a ParameterCalculation", () => {
  test("keeps its results at their stored values while every input is at its default", () => {
    const cfg = app(doubled);
    for (const v of [new Map<string, string>(), vals({ "P-1": "10" })]) {
      const applied = applyCalculations(cfg, v, []);
      expect(applied.runs.map((r) => r.state)).toEqual(["defaults"]);
      expect(applied.values).toBe(v);
      expect(segment(cfg, v)).toBe("000a0000000000000000");
      expect(() => refuseCalculationWrites(cfg, v, [])).not.toThrow();
    }
  });

  test("with an input off its default, computes its results and the image holds them, the hidden LegacyPatchAlways one too", () => {
    const cfg = app(doubled);
    const v = vals({ "P-1": "20" });
    const applied = applyCalculations(cfg, v, []);
    expect(applied.runs[0].state).toBe("computed");
    expect([...applied.computed.keys()]).toEqual([R("P-2"), R("P-3")]);
    expect(segment(cfg, v)).toBe("00140029001b00000000");
    expect(() => refuseCalculationWrites(cfg, v, [])).not.toThrow();
    // A flash from a configuration with another input: the same.
    expect(() => refuseCalculationWrites(cfg, v, [], { values: vals({ "P-1": "30", "P-2": "61", "P-3": "37" }), instances: [] })).not.toThrow();
    // VBScript computes the same.
    const vb = app({ ...doubled, lang: "VBScript", script: "B = A * 2 + 1\nc = a + 7" });
    expect(segment(vb, v)).toBe("00140029001b00000000");
  });

  test("a result placed nowhere active and not LegacyPatchAlways is refused unless it is its default", () => {
    expect(() => refuseCalculationWrites(app({ script: "d = a;", outputs: ["P-4"] }), vals({ "P-1": "20" }), [])).toThrow(refused("no active branch places"));
    expect(() => refuseCalculationWrites(app({ script: "d = 0;", outputs: ["P-4"] }), vals({ "P-1": "20" }), [])).not.toThrow();
  });

  test("a result the user can edit, set to another value than the script computes, is refused", () => {
    const cfg = app({ script: "e = a;", outputs: ["P-5"] });
    expect(() => refuseCalculationWrites(cfg, vals({ "P-1": "20", "P-5": "3" }), [])).toThrow(refused("RLTransformation"));
    expect(() => refuseCalculationWrites(cfg, vals({ "P-1": "20", "P-5": "20" }), [])).not.toThrow();
    // A flash where the stored result is the one the device was programmed with: the input changed, and the script's
    // result replaces it.
    expect(() => refuseCalculationWrites(cfg, vals({ "P-1": "20", "P-5": "3" }), [], { values: vals({ "P-1": "3", "P-5": "3" }), instances: [] })).not.toThrow();
  });

  test("a script that reads a result before setting it, or leaves one unset, is refused: it would keep ETS's earlier result", () => {
    const cfg = app({ script: "b = b + a;", outputs: ["P-2"] });
    expect(runOf(cfg, vals({ "P-1": "20" }))).toMatchObject({ state: "refused", reason: expect.stringContaining("reads its result b before setting it") });
    expect(() => refuseCalculationWrites(cfg, vals({ "P-1": "20" }), [])).toThrow(refused("reads its result b"));
    expect(runOf(app({ lang: "VBScript", script: "b = b + a", outputs: ["P-2"] }), vals({ "P-1": "20" })).reason).toContain("reads its result b before setting it");
    expect(runOf(app({ script: "if (a > 50) b = a;", outputs: ["P-2"] }), vals({ "P-1": "20" })).reason).toContain("leaves its result");
    // Reading a result after the script set it is not reading its history.
    expect(runOf(app({ script: "b = a; b = b + 1;", outputs: ["P-2"] }), vals({ "P-1": "20" })).outputs.get(R("P-2"))).toBe("21");
  });

  test("a result its parameter's type does not take is refused", () => {
    expect(runOf(app({ script: "b = a / 3;", outputs: ["P-2"] }), vals({ "P-1": "20" })).reason).toContain("which its type does not take");
    expect(runOf(app({ script: "b = -a;", outputs: ["P-2"] }), vals({ "P-1": "20" })).reason).toContain("which its type does not take");
    expect(runOf(app({ script: "b = 'x';", outputs: ["P-2"] }), vals({ "P-1": "20" })).reason).toContain("text");
  });

  test("a script outside the subset, a script function, a steering result and a type scripts do not run with are refused", () => {
    expect(runOf(app({ script: "b = foo(a);", outputs: ["P-2"] }), vals({ "P-1": "20" })).reason).toContain("undefined variable foo");
    for (const [calc, reason] of [
      [{ script: "function f() {}", outputs: ["P-2"] }, "outside what Busforge runs"],
      [{ func: "calc", outputs: ["P-2"] }, "LRTransformationFunc"],
      [{ script: "", outputs: ["P-2"] }, "no LRTransformation"],
      [{ script: "sel = 1;", outputs: ["P-6"] }, "decides what else the configuration places"],
      [{ lang: "Python", script: "b = 1", outputs: ["P-2"] }, "unsupported script language"],
    ] as const) {
      const cfg = app(calc);
      expect(runOf(cfg, new Map())).toMatchObject({ state: "refused", reason: expect.stringContaining(reason) });
      // As before the interpreter: refused where an input changes, not where none does.
      expect(() => refuseCalculationWrites(cfg, vals({ "P-1": "20" }), [])).toThrow(refused(reason));
      expect(() => refuseCalculationWrites(cfg, new Map(), [])).not.toThrow();
    }
  });

  test("calculations feeding each other settle in passes; ones that never settle, or disagree, are refused", () => {
    const chain = app({ script: "b = a * 2;", outputs: ["P-2"] }, { script: "c = b + 1;", inputs: ["P-2"], outputs: ["P-3"] });
    expect(segment(chain, vals({ "P-1": "20" }))).toBe("00140028002900000000");
    const loop = app({ script: "c = b + 1;", inputs: ["P-2"], outputs: ["P-3"] }, { script: "b = c + 1;", inputs: ["P-3"], outputs: ["P-2"] });
    const runs = applyCalculations(loop, vals({ "P-2": "5" }), []).runs;
    expect(runs.map((r) => r.reason)).toEqual([expect.stringContaining("did not settle"), expect.stringContaining("did not settle")]);
    expect(() => refuseCalculationWrites(loop, vals({ "P-2": "5" }), [])).toThrow(refused("did not settle"));
    const clash = app({ script: "b = a;", outputs: ["P-2"] }, { script: "b = a + 1;", outputs: ["P-2"] });
    expect(applyCalculations(clash, vals({ "P-1": "20" }), []).runs.map((r) => r.state)).toEqual(["refused", "refused"]);
  });
});

corpusDescribe("the ParameterCalculations of corpus applications", () => {
  const files = ["M-0004_A-7072-21-99A7-O000A.xml.gz", "M-0083_A-00B4-32-3919.xml.gz", "M-0083_A-00B6-32-9642.xml.gz", "M-00FA_A-A012-55-0000.xml.gz"];
  const loaded = new Map<string, { cfg: ReturnType<typeof parseAppConfig>; instances: ReturnType<typeof resolveModuleInstances> }>();
  const load = (file: string) => {
    if (!loaded.has(file)) { const cfg = parseAppConfig(catalogueXml(file)); loaded.set(file, { cfg, instances: cfg.hasModules ? resolveModuleInstances(cfg, new Map()) : [] }); }
    return loaded.get(file)!;
  };

  test("at the application's defaults none runs, so every image is the one built without them", () => {
    for (const file of files) {
      const { cfg, instances } = load(file);
      const values = new Map<string, string>();
      const applied = applyCalculations(cfg, values, instances);
      expect({ file, computed: applied.runs.filter((r) => r.state === "computed").length, same: applied.values === values }).toEqual({ file, computed: 0, same: true });
    }
  });

  test("every inline script of Jung 400021SE and of the MDT BE-06001.02 and BE-02001.02 is within the subset; the OpenKNX RaumController names script functions", () => {
    for (const file of files.slice(0, 3)) for (const c of load(file).cfg.calculations) expect({ file, id: c.id, refusal: scriptRefusal(c.language!, c.lrScript!) }).toEqual({ file, id: c.id, refusal: null });
    const knx = load(files[3]);
    expect(knx.cfg.calculations.length).toBe(898);
    expect(applyCalculations(knx.cfg, new Map(), knx.instances).runs.every((r) => r.state === "refused" && r.reason!.includes("LRTransformationFunc"))).toBe(true);
  });

  test("Jung 400021SE: a dimming channel's time is computed into the parameter its firmware reads, and a full download writes it", () => {
    const { cfg, instances } = load(files[0]);
    const md1 = instances.find((i) => i.id.startsWith("MD-1_"))!;
    const at = (p: string) => `${cfg.id}_${md1.id}_${p}`;
    // P-2 and P-13 enable the channel's dimming function, which places P-9 (the time in ms) and P-12, its result.
    const values = new Map([[at("P-2_R-2"), "1"], [at("P-13_R-15"), "1"], [at("P-9_R-11"), "500"]]);
    const run = applyCalculations(cfg, values, instances).runs.find((r) => r.instance?.id === md1.id && r.label === "E - Dimmen - Millisekunden")!;
    expect([run.state, [...run.outputs]]).toEqual(["computed", [[at("P-12_R-14"), "500"]]]);
    const plan = () => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: values, links: [], proc: parseLoadProcedures(catalogueXml(files[0])) });
    expect(plan).not.toThrow();
    const model = toAppModel(cfg, { includeUnions: true, instances });
    const out = model.params.get(model.refs.get(at("P-12_R-14"))!.paramId)!;
    const target = buildRelativeSegmentTarget(cfg, values, 4, { moduleInstances: instances, ownIdleUnionDefaults: true })!;
    expect(target.bytes.readUInt16BE(out.offset!)).toBe(500);
    // The same time with the dimming function off: its result is placed nowhere active, and is refused.
    const off = new Map([[at("P-9_R-11"), "500"]]);
    expect(() => refuseCalculationWrites(cfg, off, instances)).toThrow(refused("no active branch places"));
  });

  test("MDT BE-06001.02: the counter's calculation sets a parameter that decides what else is placed, and stays refused", () => {
    const { cfg, instances } = load(files[1]);
    expect(applyCalculations(cfg, new Map(), instances).runs.map((r) => r.reason)).toEqual([expect.stringContaining("decides what else"), expect.stringContaining("decides what else")]);
  });
});
