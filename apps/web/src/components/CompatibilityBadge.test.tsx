import { test, expect, describe, beforeAll, afterAll } from "bun:test";
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

describe("the compatibility popover's table", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));
  afterAll(() => i18n.changeLanguage("en"));

  test("keeps a firmware revision with its word, and an order number or application version whole", () => {
    const html = renderToStaticMarkup(<CompatibilityTable c={compat({
      readLinks: { state: "derived", derivedFrom: "M-0083_H-0000_P-BE.2D02001.2E03", firmware: ["12"] },
      readParams: { state: "otherVersion", otherVersionTested: { productRef: "M-0083_H-0000_P-BE.2D02001.2E02", appProgramId: "M-0083_A-00B6-31-1234" }, firmware: ["0", "1"] },
    })} />);
    expect(html).toContain(`${KEPT}firmware 0</span>`);
    expect(html).toContain(`${KEPT}firmware 12</span> (of ${KEPT}BE-02001.03</span>)`);
    expect(html).toContain(`${KEPT}firmware 0, 1</span> (with ${KEPT}00B6-31-1234</span>)`);
    expect(html).toContain(`same hardware and application tested as ${KEPT}BE-02001.03</span>`);
    expect(html).toContain(`tested with ${KEPT}00B6-31-1234</span> of this application, on ${KEPT}BE-02001.02</span>`);
  });

  test("does so in German too", async () => {
    await i18n.changeLanguage("de");
    const html = renderToStaticMarkup(<CompatibilityTable c={compat({ readLinks: { state: "derived", derivedFrom: "M-0083_H-0000_P-BE.2D02001.2E03", firmware: ["12"] } })} />);
    expect(html).toContain(`${KEPT}Firmware 0</span>`);
    expect(html).toContain(`${KEPT}Firmware 12</span> (von ${KEPT}BE-02001.03</span>)`);
    expect(html).toContain(`Bytes gehalten <span class="block whitespace-nowrap">(API / UI)</span>`);
    await i18n.changeLanguage("en");
  });

  test("never breaks a state mark or a pair of marks, and breaks a head only before what it covers", () => {
    const html = renderToStaticMarkup(<CompatibilityTable c={compat()} />);
    expect(html).toMatch(/<span class="inline-flex items-center gap-1 whitespace-nowrap text-ok">.*?tested<\/span>/);
    expect(html.match(/<td class="[^"]*font-mono whitespace-nowrap"/g)).toHaveLength(12);
    expect(html).toContain(`Bytes held <span class="block whitespace-nowrap">(API / UI)</span>`);
    expect(html).toContain(`Survives restart <span class="block whitespace-nowrap">(API / UI)</span>`);
  });

  test("states each operation under its name where the popover is narrow, in a column of its own where it is wide", () => {
    const html = renderToStaticMarkup(<CompatibilityTable c={compat()} />);
    expect(html.startsWith('<div class="@container">')).toBe(true);
    expect(html).toContain('<th class="hidden pb-1 text-left font-normal @min-[22rem]:table-cell">State</th>');
    expect(html.match(/<td class="py-1 pr-2">Read parameters<div class="@min-\[22rem\]:hidden"><span class="inline-flex/g)).toHaveLength(1);
    expect(html.match(/<td class="hidden py-1 pr-2 @min-\[22rem\]:table-cell"><span class="inline-flex/g)).toHaveLength(6);
  });
});
