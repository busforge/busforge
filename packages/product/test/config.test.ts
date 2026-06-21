import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig } from "../src/appconfig.ts";
import { buildDeviceConfig, matchTest, type CfgParamView, type CfgItem } from "../src/config.ts";

const xml = readFileSync(join(import.meta.dir, "fixtures", "sample-app.xml"), "utf8");
const app = parseAppConfig(xml);

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
    expect(co.comObject.flags).toEqual({ read: false, write: true, comm: true, transmit: true, update: false });
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
});
