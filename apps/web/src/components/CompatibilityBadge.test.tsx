import { test, expect, describe, beforeAll, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import type { DeviceConfigView, MatrixOperation, OperationVerdict } from "../api.ts";
import { CompatibilityTable } from "./CompatibilityBadge.tsx";

type Compat = NonNullable<DeviceConfigView["compatibility"]>;
const cell = (transfer: string) => ({ transfer: { state: transfer, basis: [] }, reference: { state: "not-assessed", basis: [] }, behaviour: { state: "not-assessed", basis: [] }, persistence: { state: "not-applicable", basis: [] } });
const tested = { state: "tested", cells: { api: cell("pass"), ui: cell("pass") }, firmware: ["0"] } as unknown as OperationVerdict;
const compat = (over: Partial<Record<MatrixOperation, Partial<OperationVerdict>>> = {}): Compat => {
  const ops: MatrixOperation[] = ["readParams", "readLinks", "flashParams", "flashLinks", "fullDownload", "structuralFlash"];
  return Object.fromEntries(ops.map((op) => [op, { ...tested, ...over[op] }])) as Compat;
};
const KEPT = '<span class="whitespace-nowrap">';
const classesOf = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag} class="([^"]*)"`, "g"))].map((m) => m[1]!.split(" "));

describe("the compatibility popover's table", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));
  afterEach(() => i18n.changeLanguage("en"));

  test("keeps a firmware revision with its word, and an order number or application version whole", () => {
    const html = renderToStaticMarkup(<CompatibilityTable c={compat({
      readLinks: { state: "derived", derivedFrom: "M-0083_H-0000_P-BE.2D02001.2E03", firmware: ["12"] },
      readParams: { state: "otherVersion", otherVersionTested: { productRef: "M-0083_H-0000_P-BE.2D02001.2E02", appProgramId: "M-0083_A-00B6-31-1234" }, firmware: ["0", "1"] },
      fullDownload: { sameAppTestedOn: "M-0083_H-0000_P-BE.2D06001.2E02" },
    })} />);
    expect(html).toContain("firmware 0<");
    expect(html).toContain(`firmware 12 (of ${KEPT}BE-02001.03</span>)`);
    expect(html).toContain(`firmware 0, 1 (with ${KEPT}00B6-31-1234</span>)`);
    expect(html).toContain(`same hardware and application tested as ${KEPT}BE-02001.03</span>`);
    expect(html).toContain(`tested with ${KEPT}00B6-31-1234</span> of this application, on ${KEPT}BE-02001.02</span>`);
    expect(html).toContain(`same application tested on ${KEPT}BE-06001.02</span> (other hardware)`);
  });

  test("does so in German too", async () => {
    await i18n.changeLanguage("de");
    const html = renderToStaticMarkup(<CompatibilityTable c={compat({ readLinks: { state: "derived", derivedFrom: "M-0083_H-0000_P-BE.2D02001.2E03", firmware: ["12"] } })} />);
    expect(html).toContain("Firmware 0<");
    expect(html).toContain(`Firmware 12 (von ${KEPT}BE-02001.03</span>)`);
    expect(html).toContain(`Bytes gehalten <span class="block whitespace-nowrap">(API / UI)</span>`);
  });

  test("shows an order number that decodes to markup as text", () => {
    const html = renderToStaticMarkup(<CompatibilityTable c={compat({ readLinks: { state: "derived", derivedFrom: "M-0083_H-0000_P-A.3Cb.3EB", firmware: [] } })} />);
    expect(html).toContain(`tested as ${KEPT}A&lt;b&gt;B</span>`);
  });

  test("never breaks a state mark or a pair of marks, and breaks a head only before what it covers", () => {
    const html = renderToStaticMarkup(<CompatibilityTable c={compat()} />);
    expect(html).toMatch(/<span class="[^"]*\bwhitespace-nowrap\b[^"]*">.*?tested<\/span>/);
    expect(classesOf(html, "td").filter((c) => c.includes("font-mono") && c.includes("whitespace-nowrap"))).toHaveLength(12);
    expect(html).toContain(`Bytes held <span class="block whitespace-nowrap">(API / UI)</span>`);
    expect(html).toContain(`Survives restart <span class="block whitespace-nowrap">(API / UI)</span>`);
  });

  test("names each pair of marks in the words the popover shows for a state, in the reader's language", async () => {
    const mixed = { state: "conflict", cells: { api: { ...cell("conflict"), persistence: { state: "pass", basis: [] } }, ui: { ...cell("fail"), persistence: { state: "not-assessed", basis: [] } } }, firmware: [] } as unknown as OperationVerdict;
    const labels = () => [...renderToStaticMarkup(<CompatibilityTable c={compat({ readParams: mixed, readLinks: { cells: { api: cell("pass") } } as Partial<OperationVerdict> })} />).matchAll(/<td class="[^"]*"><span aria-hidden="true">[^<]*<\/span><span class="sr-only">([^<]*)<\/span><\/td>/g)].map((m) => m[1]);
    expect(labels().slice(0, 4)).toEqual(["API: contradictory, UI: failed", "API: tested, UI: untested", "API: tested, UI: untested", "API: not applicable, UI: untested"]);
    await i18n.changeLanguage("de");
    expect(labels().slice(0, 4)).toEqual(["API: widersprüchlich, UI: fehlgeschlagen", "API: getestet, UI: ungetestet", "API: getestet, UI: ungetestet", "API: nicht anwendbar, UI: ungetestet"]);
  });

  // Markup only: that the table fits without scrolling sideways at each width is shown in a browser, not here.
  test("gives the state a place under its name for a narrow table and a column of its own for a wide one", () => {
    const html = renderToStaticMarkup(<CompatibilityTable c={compat()} />);
    expect(html.startsWith('<div class="@container">')).toBe(true);
    const wideOnly = (c: string[]) => c.includes("hidden") && c.some((x) => x.endsWith(":table-cell"));
    expect(classesOf(html, "th").filter(wideOnly)).toHaveLength(1);
    expect(classesOf(html, "td").filter(wideOnly)).toHaveLength(6);
    expect(classesOf(html, "div").filter((c) => c.some((x) => x.startsWith("@min-") && x.endsWith(":hidden")))).toHaveLength(6);
  });
});
