import { test, expect } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, classify, activeColorValues, refuseColorWrites, type ModuleInstance } from "../src/index.ts";
import { catalogueXml, captureText } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// No ETS download captured holds a colour parameter in use, so Busforge writes no colour: every operation that
// would have to write one refuses before it touches the bus.
const untouched = new Proxy({}, { get: (_t, k) => () => { throw new Error(`the device was used: ${String(k)}`); } }) as unknown as KnxDevice;
const refused = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x as { code?: string });
  expect(e?.code).toBe("PARAM_COLOR_UNSUPPORTED");
};

// Theben DALI-Gateway KNX plus (System B): "Colour Control Type" (P-53) = 2 puts an RGB colour of group 1 in use.
corpusDescribe("a colour parameter in use on a System B application", () => {
  const xml = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const COLOUR_TYPE = "M-0048_A-9071-20-F258-O00EF_P-53_R-41";
  const withColour = new Map([[COLOUR_TYPE, "2"]]);
  const [colourRef] = [...activeColorValues(cfg, withColour, [])].map(([ref]) => ref);

  test("the defaults hold no colour in use; the colour control type puts one in use at its default", () => {
    expect(activeColorValues(cfg, new Map(), []).size).toBe(0);
    expect([...activeColorValues(cfg, withColour, [])]).toEqual([[colourRef, "#FF0000"]]);
  });

  test("a full download refuses a colour in use, also at its default, and builds without one", () => {
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params: withColour, links: [], proc })).toThrow(expect.objectContaining({ code: "PARAM_COLOR_UNSUPPORTED" }));
    expect(classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params: new Map(), links: [], proc }).imageBytes).toBeGreaterThan(0);
  });

  test("a parameter flash refuses a colour that changes or comes into use, and passes one the device holds", () => {
    const changed = new Map(withColour).set(colourRef, "#102030");
    expect(() => refuseColorWrites(cfg, withColour, [], { values: withColour, instances: [] })).not.toThrow();
    expect(() => refuseColorWrites(cfg, new Map(withColour).set(colourRef, "#ff0000"), [], { values: withColour, instances: [] })).not.toThrow();
    expect(() => refuseColorWrites(cfg, changed, [], { values: withColour, instances: [] })).toThrow(expect.objectContaining({ code: "PARAM_COLOR_UNSUPPORTED" }));
    expect(() => refuseColorWrites(cfg, withColour, [], { values: new Map(), instances: [] })).toThrow(expect.objectContaining({ code: "PARAM_COLOR_UNSUPPORTED" }));
  });

  test("the parameter and the structural flash refuse a colour change before they use the device", async () => {
    const ctx = { deviceId: "d", appXml: xml, params: new Map(withColour).set(colourRef, "#102030"), baseParams: withColour, moduleInstances: [], dryRun: false, persistBackups: () => "backup" };
    await refused(classify(cfg).flashParameters(untouched, cfg.mask, ctx));
    expect(classify(cfg).capabilities().structuralFlash).toBe(true);
    await refused(classify(cfg).flashStructure(untouched, cfg.mask, { ...ctx, ia: "1.1.1", links: [] }));
  });
});

// MDT BE-06001.02 (System 7) with "Time for long keypress" (P-8) declared an RGB colour: the catalogue's own colour
// parameters lie in module instances the captured configuration does not use.
corpusDescribe("a colour parameter in use on a System 7 application", () => {
  const xml = catalogueXml("M-0083_A-00B4-32-3919.xml.gz").replace(
    'ParameterType="M-0083_A-00B4-32-3919_PT-TimeforLongSwitch0.2C1.2D30s" Text="Time for long keypress (Basic setting)"',
    'ParameterType="M-0083_A-00B4-32-3919_PT-RGBColor" Text="Time for long keypress (Basic setting)"');
  const cfg = parseAppConfig(xml);
  const REF = "M-0083_A-00B4-32-3919_P-8_R-7";

  test("the parameter and the structural flash refuse a colour change before they use the device", async () => {
    const base = new Map([[REF, "#000000"]]);
    expect(activeColorValues(cfg, base, []).get(REF)).toBe("#000000");
    const ctx = { deviceId: "d", appXml: xml, params: new Map([[REF, "#102030"]]), baseParams: base, moduleInstances: [], dryRun: false, persistBackups: () => "backup" };
    await refused(classify(cfg).flashParameters(untouched, cfg.mask, ctx));
    expect(classify(cfg).capabilities().structuralFlash).toBe(true);
    await refused(classify(cfg).flashStructure(untouched, cfg.mask, { ...ctx, ia: "1.1.1", links: [] }));
  });
});

// The MDT BE-06001.02's own colour parameters (RGB, module 2), in an ETS-programmed unit's configuration with channel 1's
// LED set to a colour: the full download, whose parameter segment declares no <Mask>, refuses as well.
corpusDescribe("a catalogue colour in use on a System 7 full download", () => {
  const xml = catalogueXml("M-0083_A-00B4-32-3919.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const fx = JSON.parse(captureText("mdtui-unit-config.json")) as { ia: string; params: [string, string][]; instances: ModuleInstance[] };
  const P = (r: string) => `M-0083_A-00B4-32-3919_${r}`;
  const params = new Map(fx.params);

  test("the project's configuration builds; with a colour in use the download refuses", () => {
    const plan = (p: Map<string, string>) => classify(cfg).planFullDownload(cfg.mask, { ia: fx.ia, params: p, links: [], proc, moduleInstances: fx.instances });
    expect(activeColorValues(cfg, params, fx.instances).size).toBe(0);
    expect(plan(params).imageBytes).toBeGreaterThan(0);
    const coloured = new Map(params).set(P("MD-2_M-2_MI-1_P-24_R-2"), "4").set(P("MD-2_M-2_MI-1_P-20_R-81"), "9");
    expect([...activeColorValues(cfg, coloured, fx.instances).keys()]).toContain(P("MD-2_M-2_MI-1_UP-53_R-100"));
    expect(() => plan(coloured)).toThrow(expect.objectContaining({ code: "PARAM_COLOR_UNSUPPORTED" }));
  });
});
