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
    expect(byName("Temperature").param).toMatchObject({ control: "unsupported", typeLabel: "Float" });
    expect(byName("Switch time").param).toMatchObject({ control: "unsupported", typeLabel: "Time" });
    // Supported types still render normally.
    expect(byName("Level").param.control).toBe("number");
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
