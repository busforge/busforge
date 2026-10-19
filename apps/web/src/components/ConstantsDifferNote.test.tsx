import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import type { FlashResult } from "../api.ts";
import { ConstantsDifferNote } from "./ConstantsDifferNote.tsx";

const unchanged = (r: Partial<Extract<FlashResult, { kind: "unchanged" }>>): FlashResult =>
  ({ kind: "unchanged", mask: "MV-0705", imageBytes: 1024, backup: "b", ...r });
const marker = { paramRefId: "M-0048_A-107E-12-5B58_P-2228_R-2228", label: "Wert $AA, Downloaderkennung" };

describe("the note on an unchanged result that differs in constant parameters", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));

  test("names each parameter, in the warning colour", () => {
    const html = renderToStaticMarkup(<ConstantsDifferNote result={unchanged({ constantsDiffer: [marker, { paramRefId: "x", label: "Other" }] })} />);
    expect(html).toContain('data-testid="flash-constants-differ"');
    expect(html).toMatch(/class="[^"]*text-amber-600[^"]*dark:text-amber-400/);
    expect(html).toContain("Wert $AA, Downloaderkennung, Other");
    expect(html).toContain("That is no change");
  });

  test("in German too", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = renderToStaticMarkup(<ConstantsDifferNote result={unchanged({ constantsDiffer: [marker] })} />);
      expect(html).toContain("Das Gerät weicht nur in Parametern ab");
      expect(html).toContain("Wert $AA, Downloaderkennung");
    } finally { await i18n.changeLanguage("en"); }
  });

  test("absent where nothing differs, or the result is not unchanged", () => {
    expect(renderToStaticMarkup(<ConstantsDifferNote result={unchanged({})} />)).toBe("");
    expect(renderToStaticMarkup(<ConstantsDifferNote result={unchanged({ constantsDiffer: [] })} />)).toBe("");
    expect(renderToStaticMarkup(<ConstantsDifferNote result={{ kind: "dryRun", mask: "MV-0705", imageBytes: 1, diffBytes: 1, backup: "b" }} />)).toBe("");
  });
});
