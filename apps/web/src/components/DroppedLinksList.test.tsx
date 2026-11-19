import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import type { DroppedLink } from "@/api.ts";
import { DroppedLinksDetail, DroppedLinksList, DroppedLinksMark } from "./DroppedLinksList.tsx";

const entry = (o: Partial<DroppedLink>): DroppedLink => ({
  deviceId: "D-1", ia: "1.1.5", deviceName: "Actuator", comObjRefId: "O-1_R-1",
  comObjNumber: 1, comObjName: "Switch", functionText: "On/off", unresolved: null, refusal: null, unrecoverable: false,
  reason: "addressNotInProject", gas: [{ etsId: "GA-9", address: null, name: null, inProject: false }], ...o,
});
const open = entry({});
const gone = entry({ comObjRefId: "MD-1_M-1_MI-2_O-1_R-1", comObjNumber: null, comObjName: null, functionText: null, unresolved: "moduleInstanceGone", unrecoverable: true, reason: "moduleInstanceGone" });
const stray = entry({ comObjRefId: "O-7_R-7", comObjNumber: null, comObjName: null, functionText: null, unresolved: "notInApplication", unrecoverable: true });
const mark = (html: string) => /<button[^>]*data-testid="device-dropped-links"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";

describe("the links an import did not take over", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en } }, lng: "en", interpolation: { escapeValue: false } }));

  test("the header warning counts only the entries a link can still close", () => {
    const html = mark(renderToStaticMarkup(<DroppedLinksMark links={[open, gone, stray]} error={null} testId="device-dropped-links" />));
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain(">1</span>");
  });

  test("where no entry can be closed the mark is no warning and has no count, but is still there", () => {
    const html = mark(renderToStaticMarkup(<DroppedLinksMark links={[gone, stray]} error={null} testId="device-dropped-links" />));
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain("Links not imported");
    expect(html).not.toContain("font-mono");
  });

  test("the popover says when an object leaves the list only while one can", () => {
    const leaves = "An object leaves this list once";
    expect(renderToStaticMarkup(<DroppedLinksDetail links={[open, gone]} />)).toContain(leaves);
    expect(renderToStaticMarkup(<DroppedLinksDetail links={[gone]} />)).not.toContain(leaves);
  });

  test("a project without entries shows no mark, a failed load a warning without a count", () => {
    expect(renderToStaticMarkup(<DroppedLinksMark links={[]} error={null} testId="device-dropped-links" />)).toBe("");
    const failed = mark(renderToStaticMarkup(<DroppedLinksMark links={undefined} error={new Error("boom")} testId="device-dropped-links" />));
    expect(failed).toContain('data-tone="warning"');
    expect(failed).not.toContain("font-mono");
  });

  test("the list puts the entries that cannot be restored in their own group, each with its reason", () => {
    const html = renderToStaticMarkup(<DroppedLinksList links={[gone, open, stray]} />);
    const group = /data-testid="dropped-unrecoverable"[\s\S]*$/.exec(html)?.[0] ?? "";
    expect(html.indexOf("Object 1")).toBeLessThan(html.indexOf('data-testid="dropped-unrecoverable"'));
    expect(group).toContain("Cannot be restored");
    expect(group).toContain("The device&#x27;s configuration has no such module instance");
    expect(group).toContain("The device&#x27;s application program has no such object");
    expect(group).not.toContain("Object 1");
  });

  test("a list of open entries only has no such group", () => {
    expect(renderToStaticMarkup(<DroppedLinksList links={[open]} />)).not.toContain("dropped-unrecoverable");
  });
});
