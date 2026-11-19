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
    expect(group).not.toContain("Switch");
  });

  test("an object the configuration does not place is called by the number its ETS ref names, never by the raw ref", () => {
    const nameless = (comObjRefId: string, unresolved: DroppedLink["unresolved"], unrecoverable: boolean) =>
      entry({ comObjRefId, comObjNumber: null, comObjName: null, functionText: null, unresolved, refusal: unresolved === "refused" ? "PARAM_TEST_UNSUPPORTED" : null, unrecoverable });
    const html = renderToStaticMarkup(<DroppedLinksList links={[
      nameless("O-7_R-7", "notInApplication", true), nameless("MD-1_M-1_MI-2_O-3_R-3", "moduleInstanceGone", true),
      nameless("O-5_R-5", "noApplication", true), nameless("O-6_R-6", "refused", true), nameless("O-4", "notInConfiguration", false),
    ]} />);
    for (const n of [7, 3, 5, 6, 4]) expect(html).toContain(`>Object ${n}</span>`);
    expect(html).not.toMatch(/>[^<]*O-\d+(_R-\d+)?<\/span>/);
  });

  test("a ref of an unknown shape is shown as it is", () => {
    const html = renderToStaticMarkup(<DroppedLinksList links={[entry({ comObjRefId: "X-1", comObjNumber: null, unresolved: "notInApplication", unrecoverable: true })]} />);
    expect(html).toContain(">X-1</span>");
  });

  test("an object no link reaches does not claim its other links were imported, an open one does", () => {
    const imported = "the object&#x27;s other links were imported";
    const lost = (unresolved: DroppedLink["unresolved"]) => entry({ comObjRefId: "O-7_R-7", comObjNumber: null, unresolved, unrecoverable: true });
    for (const unresolved of ["noApplication", "refused", "moduleInstanceGone", "notInApplication"] as const) {
      const html = renderToStaticMarkup(<DroppedLinksList links={[lost(unresolved)]} />);
      expect(html).not.toContain(imported);
      expect(html).toContain("An address is not in the project.");
    }
    expect(renderToStaticMarkup(<DroppedLinksList links={[open]} />)).toContain(imported);
  });

  test("a list of open entries only has no such group", () => {
    expect(renderToStaticMarkup(<DroppedLinksList links={[open]} />)).not.toContain("dropped-unrecoverable");
  });
});
