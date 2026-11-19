import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { iaToNum } from "../packages/knx/src/index.ts";
import { parseAppConfig, buildRelativeSegmentTarget, initialValues } from "../packages/product/src/index.ts";
import { BUSSARD_SYNTHETIC_TESTED, bussardApplication, bussardCapture, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { memoryImage, parseCapture, reportedTableReferences } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";

// bussard's ETS 6.4.1 captures of its synthetic text products (MIT, Tom Bocklisch; the corpus's
// captures/external/bussard-synthetic/README.md), each a System B (MV-07B0) device added to a de-DE ETS project and
// downloaded at that state into a simulator at 1.1.1: the bytes ETS wrote into the text parameter's field (at +3 of
// the parameter segment) against those of Busforge's image of a device placed in the same language.
const DEVICE = iaToNum("1.1.1");

corpusDescribe("bussard's synthetic captures: a text parameter beyond ASCII against ETS", () => {
  const cases: [product: string, construct: string, size: number, text: string][] = [
    ["syn-text-undeclared", "no TextParameterEncoding: the default \"Störung\" in ISO 8859-1", 14, "Störung"],
    ["syn-text-initialvalue", "TextParameterEncoding utf-8: the de-DE translation of the InitialValue, in UTF-8", 20, "Bussardhorst Süd"],
  ];
  for (const [product, construct, size, text] of cases) {
    test(`${product}: ${construct}`, () => {
      const entry = BUSSARD_SYNTHETIC_TESTED.find(([p]) => p === product)!;
      const cfg = parseAppConfig(readFileSync(corpusPath(bussardApplication(...entry)), "utf8"));
      const params = initialValues(cfg, "de-DE");
      const target = buildRelativeSegmentTarget(cfg, params, 4)!;
      const cap = parseCapture(pcapToLog(readFileSync(corpusPath(bussardCapture(product, "defaults")))), DEVICE);
      const base = reportedTableReferences(cap).get(4)!;
      const ets = memoryImage(cap.writes);
      const etsField = Buffer.from(Array.from({ length: size }, (_, i) => ets.get(base + 3 + i)!));
      expect(etsField.subarray(0, etsField.indexOf(0)).toString(cfg.textParameterEncoding === "utf-8" ? "utf8" : "latin1")).toBe(text);
      expect(Buffer.from(target.bytes.subarray(3, 3 + size)).toString("hex")).toBe(etsField.toString("hex"));
      expect(target.owned.slice(3, 3 + size).every((m) => m === 0xff)).toBe(true);
    });
  }

  test("placed in the application's default language, the device starts at the untranslated InitialValue, here its default", () => {
    const entry = BUSSARD_SYNTHETIC_TESTED.find(([p]) => p === "syn-text-initialvalue")!;
    const cfg = parseAppConfig(readFileSync(corpusPath(bussardApplication(...entry)), "utf8"));
    expect([...initialValues(cfg, "de-DE").values()]).toEqual(["Bussardhorst Süd"]);
    expect(initialValues(cfg, "en").size).toBe(0); // InitialValue and Value are both "Buzzard nest"
  });
});
