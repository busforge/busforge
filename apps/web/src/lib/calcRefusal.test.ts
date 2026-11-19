import { describe, expect, test } from "bun:test";
import i18next from "i18next";
import { CALC_REFUSAL_TEXT, type CalcRefusalCode } from "@busforge/product";
import en from "@/locales/en";
import de from "@/locales/de";
import { calcRefusalReason } from "./calcRefusal.ts";

// Every reason the product package gives has its text (a compile error otherwise).
const covered: Record<CalcRefusalCode, string> = en.device.calcRefusal;
const codes = Object.keys(CALC_REFUSAL_TEXT) as CalcRefusalCode[];

describe("the reason Busforge does not run a calculation", () => {
  const i18n = i18next.createInstance();
  void i18n.init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } });

  test("is named in the user's language, with the values its text names", () => {
    const refusal = { code: "typeRejects" as const, params: { value: "6.666", ref: "P-2_R-2" } };
    expect(calcRefusalReason(i18n.getFixedT("de"), refusal)).toBe("sie berechnet 6.666 für P-2_R-2, und diesen Wert nimmt sein Typ nicht an");
    expect(calcRefusalReason(i18n.getFixedT("en"), refusal)).toBe("it computes 6.666 for P-2_R-2, which its type does not take");
  });

  test("in English, worded as the server words it", () => {
    for (const code of codes) expect([code, covered[code]]).toEqual([code, CALC_REFUSAL_TEXT[code].replace(/\{(\w+)\}/g, "{{$1}}")]);
  });

  test("in German, filling each value the English text names", () => {
    const names = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const code of codes) expect([code, names(de.device.calcRefusal[code])]).toEqual([code, names(en.device.calcRefusal[code])]);
  });
});
