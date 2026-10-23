import { test, expect, setDefaultTimeout } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, classify, activeColorValues, refuseColorWrites, type ModuleInstance } from "../src/index.ts";
import { catalogueXml, captureText } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 0.4 s with the
// file alone (load 5-27) and up to 0.2 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(60_000);

// ETS writes an RGB colour as its three bytes (image.ts colorBytes, shown by its downloads onto the Jung
// 400021SE), and Busforge writes it so on a relative segment (System B). Every other colour has no encoding
// shown: each operation that would have to write one refuses before it touches the bus.
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
  const at = cfg.params.get(cfg.refs.get(colourRef)!.paramId)!.offset!;

  test("the defaults hold no colour in use; the colour control type puts one in use at its default", () => {
    expect(activeColorValues(cfg, new Map(), []).size).toBe(0);
    expect([...activeColorValues(cfg, withColour, [])]).toEqual([[colourRef, "#FF0000"]]);
  });

  test("a full download writes an RGB colour in use as its red, green and blue bytes", () => {
    const image = (params: Map<string, string>) => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params, links: [], proc }).segments.find((s) => s.lsm === 4)!.image;
    expect(image(withColour).subarray(at, at + 3).toString("hex")).toBe("ff0000");
    expect(image(new Map(withColour).set(colourRef, "#102030")).subarray(at, at + 3).toString("hex")).toBe("102030");
  });

  test("a parameter flash takes an RGB colour that changes on this path, and refuses it on a path that writes no colour", () => {
    const changed = new Map(withColour).set(colourRef, "#102030");
    expect(() => refuseColorWrites(cfg, changed, [], true, { values: withColour, instances: [] })).not.toThrow();
    expect(() => refuseColorWrites(cfg, withColour, [], true)).not.toThrow();
    expect(() => refuseColorWrites(cfg, withColour, [], false, { values: withColour, instances: [] })).not.toThrow();
    expect(() => refuseColorWrites(cfg, new Map(withColour).set(colourRef, "#ff0000"), [], false, { values: withColour, instances: [] })).not.toThrow();
    expect(() => refuseColorWrites(cfg, changed, [], false, { values: withColour, instances: [] })).toThrow(expect.objectContaining({ code: "PARAM_COLOR_UNSUPPORTED" }));
    expect(() => refuseColorWrites(cfg, withColour, [], false, { values: new Map(), instances: [] })).toThrow(expect.objectContaining({ code: "PARAM_COLOR_UNSUPPORTED" }));
  });
});

// The same gateway with the RGB colour declared an HSV one (the application's own PT-ColorHSV): no capture shows an
// HSV colour's bytes, so every operation that would write it refuses.
corpusDescribe("an HSV colour in use on a System B application", () => {
  const xml = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz").replace(
    /(<Parameter Id="M-0048_A-9071-20-F258-O00EF_UP-13" [^>]*ParameterType=")[^"]+"/, '$1M-0048_A-9071-20-F258-O00EF_PT-ColorHSV"');
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const withColour = new Map([["M-0048_A-9071-20-F258-O00EF_P-53_R-41", "2"]]);
  const [colourRef] = [...activeColorValues(cfg, withColour, [])].map(([ref]) => ref);

  test("the full download, the parameter and the structural flash refuse it before they use the device", async () => {
    expect(cfg.types.get(cfg.params.get(cfg.refs.get(colourRef)!.paramId)!.typeId)!.colorSpace).toBe("HSV");
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params: withColour, links: [], proc })).toThrow(expect.objectContaining({ code: "PARAM_COLOR_UNSUPPORTED" }));
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
