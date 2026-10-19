import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LinkEditor } from "./LinkEditor.tsx";

const options = [
  { raw: 2049, address: "1/0/1", name: "Light" },
  { raw: 2050, address: "1/0/2", name: "Central" },
  { raw: 2051, address: "1/0/3", name: "Scene" },
];
const render = (gaRaws: number[]) =>
  renderToStaticMarkup(<TooltipProvider><LinkEditor options={options} gaRaws={gaRaws} onChange={() => {}} testId="link-4" levels={3} /></TooltipProvider>);

describe("a com-object's group addresses on the device page", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));

  test("one address: the single picker, and a way to add another", () => {
    const html = render([2049]);
    expect(html).toContain('data-testid="link-4"');
    expect(html).toContain("1/0/1");
    expect(html).toContain('data-testid="link-4-more"');
    expect(html).not.toContain('data-testid="link-4-ga-0"');
  });

  test("no address: the single picker, nothing to add to", () => {
    const html = render([]);
    expect(html).toContain('data-testid="link-4"');
    expect(html).not.toContain('data-testid="link-4-more"');
  });

  test("several: every address in order, the first marked as the one it sends on", () => {
    const html = render([2051, 2049]);
    const first = html.indexOf('data-testid="link-4-ga-0"'), second = html.indexOf('data-testid="link-4-ga-1"');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(html.slice(first, second)).toContain("1/0/3");
    expect(html.slice(first, second)).toContain('data-testid="link-4-sending"');
    expect(html.slice(second)).toContain("1/0/1");
    expect(html).toContain('data-testid="link-4-send-1"');
    expect(html).not.toContain('data-testid="link-4-send-0"');
    expect(html).toContain('data-testid="link-4-remove-0"');
    expect(html).toContain('data-testid="link-4-remove-1"');
    expect(html).toContain('data-testid="link-4-add"');
  });
});
