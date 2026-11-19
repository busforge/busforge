import { test, expect, describe, beforeAll } from "bun:test";
import { createInstance } from "i18next";
import en from "@/locales/en";
import de from "@/locales/de";

const i18n = createInstance();

// The product badge (components/CompatibilityBadge.tsx) keeps its own text short; what it leaves out is in
// its popover.
describe("the product badge's words", () => {
  beforeAll(() => i18n.init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));

  test("name the transfer axis shortly, and the popover says it in full", () => {
    expect(i18n.t("compat.badge", { summary: i18n.t("compat.summary.tested") })).toBe("Product: Transfer tested");
    expect(i18n.t("compat.testedDetail")).toBe("The transfer is tested on this product for every operation Busforge supports for this device.");
    expect(i18n.t("compat.badge", { lng: "de", summary: i18n.t("compat.summary.tested", { lng: "de" }) })).toBe("Produkt: Übertragung getestet");
  });
});
