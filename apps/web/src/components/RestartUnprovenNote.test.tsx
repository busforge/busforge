import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import type { FlashResult } from "../api.ts";
import { RestartUnprovenNote } from "./RestartUnprovenNote.tsx";

const flashed = (r: Partial<Extract<FlashResult, { kind: "flashed" }>>): FlashResult =>
  ({ kind: "flashed", mask: "MV-07B0", imageBytes: 212, diffBytes: 2, verified: true, backup: "b", ...r });

describe("the note on a restart the device did not confirm", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));

  test("says what is missing, in the warning colour", () => {
    const html = renderToStaticMarkup(<RestartUnprovenNote result={flashed({ restartUnproven: true })} />);
    expect(html).toContain('data-testid="flash-restart-unproven"');
    expect(html).toMatch(/class="[^"]*text-amber-600[^"]*dark:text-amber-400/);
    expect(html).toContain("The device did not confirm its restart");
    expect(html).toContain("is not proven");
  });

  test("in German too", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = renderToStaticMarkup(<RestartUnprovenNote result={flashed({ restartUnproven: true })} />);
      expect(html).toContain("Das Gerät hat seinen Neustart nicht bestätigt");
      expect(html).toContain("dauerhaft übernommen hat, ist aber nicht belegt");
    } finally { await i18n.changeLanguage("en"); }
  });

  test("absent where the restart was proven, or the write is not verified", () => {
    expect(renderToStaticMarkup(<RestartUnprovenNote result={flashed({})} />)).toBe("");
    expect(renderToStaticMarkup(<RestartUnprovenNote result={flashed({ verified: false, restartUnproven: true })} />)).toBe("");
  });
});
