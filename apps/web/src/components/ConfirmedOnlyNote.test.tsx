import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import type { FlashResult } from "../api.ts";
import { ConfirmedOnlyNote } from "./ConfirmedOnlyNote.tsx";

const flashed = (r: Partial<Extract<FlashResult, { kind: "flashed" }>>): FlashResult =>
  ({ kind: "flashed", mask: "MV-57B0", imageBytes: 120, diffBytes: 3, verified: true, backup: "b", ...r });

describe("the note on bytes resting on the write confirmation alone", () => {
  // The app's own resources over the default instance, as lib/i18n sets them up (it reads the browser's language).
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));

  test("names the bytes and their device addresses, in the warning colour", () => {
    const html = renderToStaticMarkup(<ConfirmedOnlyNote result={flashed({ confirmedOnly: [{ address: 0x4028, length: 20 }, { address: 0x4100, length: 1 }] })} />);
    expect(html).toContain('data-testid="flash-confirmed-only"');
    expect(html).toMatch(/class="[^"]*text-amber-600[^"]*dark:text-amber-400/);
    expect(html).toContain("21 byte(s) at 0x4028-0x403B, 0x4100 the device does not give back when read");
  });

  test("in German too", async () => {
    await i18n.changeLanguage("de");
    try {
      expect(renderToStaticMarkup(<ConfirmedOnlyNote result={flashed({ confirmedOnly: [{ address: 0x4028, length: 20 }] })} />))
        .toContain("20 Byte(s) bei 0x4028-0x403B gibt das Gerät beim Lesen nicht zurück");
    } finally { await i18n.changeLanguage("en"); }
  });

  test("absent where the read-back showed every byte, or the write is not verified", () => {
    expect(renderToStaticMarkup(<ConfirmedOnlyNote result={flashed({})} />)).toBe("");
    expect(renderToStaticMarkup(<ConfirmedOnlyNote result={flashed({ confirmedOnly: [] })} />)).toBe("");
    expect(renderToStaticMarkup(<ConfirmedOnlyNote result={flashed({ verified: false, confirmedOnly: [{ address: 0x4028, length: 20 }] })} />)).toBe("");
  });
});
