import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import { SourceCodeLink } from "./SourceCodeLink.tsx";

describe("the source code link", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));

  test("is a link to the public repository, opened in a new tab, styled as a button primitive", () => {
    const html = renderToStaticMarkup(<SourceCodeLink />);
    expect(html.startsWith("<a")).toBe(true);
    expect(html).toContain('href="https://github.com/busforge/busforge"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('data-slot="button"');
    expect(html).toContain('data-testid="source-code"');
    expect(html).toContain(">Source code</a>");
    expect(html).toContain('title="Busforge is free software under the GNU AGPL-3.0-or-later"');
  });

  test("takes the footer's text instead of the button's size and colour", () => {
    const c = (/class="([^"]*)"/.exec(renderToStaticMarkup(<SourceCodeLink />))?.[1] ?? "").split(" ");
    for (const own of ["text-inherit", "text-[11px]", "h-auto", "p-0", "cursor-pointer"]) expect(c).toContain(own);
    for (const button of ["text-primary", "text-sm", "h-9", "px-4", "py-2"]) expect(c).not.toContain(button);
  });

  test("in German too", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = renderToStaticMarkup(<SourceCodeLink />);
      expect(html).toContain(">Quelltext</a>");
      expect(html).toContain('title="Busforge ist freie Software unter der GNU AGPL-3.0-or-later"');
    } finally { await i18n.changeLanguage("en"); }
  });
});
