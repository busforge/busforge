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
    expect(html.indexOf("Switch")).toBeGreaterThan(-1);
    expect(html.indexOf("Switch")).toBeLessThan(html.indexOf('data-testid="dropped-unrecoverable"'));
    expect(group).toContain("Cannot be restored");
    expect(group).toContain("The device&#x27;s configuration has no such module instance");
    expect(group).toContain("The device&#x27;s application program has no such object");
    expect(group).not.toContain("Switch");
  });

  test("an object the application declares is called by its own number and texts, whatever digit its ETS ref carries", () => {
    // Declared with Number 14 under the id O-4: the number comes from the server, never from the ref.
    const known = entry({ comObjRefId: "O-4", comObjNumber: 14, comObjName: "Scene", functionText: "Recall", unresolved: "notInConfiguration" });
    const refused = entry({ comObjRefId: "O-1_R-1", comObjNumber: 0, comObjName: "Switch", functionText: "On/off", unresolved: "refused", refusal: "PARAM_TEST_UNSUPPORTED", unrecoverable: true });
    const html = renderToStaticMarkup(<DroppedLinksList links={[known, refused]} />);
    expect(html).toContain(">Object 14</span>");
    expect(html).toContain(">Scene · Recall</span>");
    expect(html).toContain(">Object 0</span>");
    expect(html).toContain("Object not shown by the device&#x27;s current configuration");
    expect(html).not.toContain("Object from ETS");
    expect(html).not.toContain(">Object 4<");
    expect(html).not.toContain(">O-4<");
  });

  test("an object nothing names a number for is no invented one: it is called an object from ETS, with its ref beside it", () => {
    const nameless = (comObjRefId: string, unresolved: DroppedLink["unresolved"]) => entry({ comObjRefId, comObjNumber: null, comObjName: null, functionText: null, unresolved, unrecoverable: true });
    const refs = ["O-7_R-7", "MD-14_M-40_MI-3_O-2-5_R-19", "X-1"];
    const html = renderToStaticMarkup(<DroppedLinksList links={[nameless(refs[0], "notInApplication"), nameless(refs[1], "moduleInstanceGone"), nameless(refs[2], "noApplication")]} />);
    for (const ref of refs) expect(html).toContain(`>${ref}</span>`);
    expect(html.match(/>Object from ETS<\/span>/g)).toHaveLength(3);
    expect(html).not.toMatch(/>Object \d+</);
  });

  test("an object no link reaches does not claim its other links were imported, an open one does", () => {
    const imported = "the object&#x27;s other links were imported";
    const lost = (unresolved: DroppedLink["unresolved"]) => entry({ comObjRefId: "O-7_R-7", comObjNumber: null, unresolved, unrecoverable: true });
    for (const unresolved of ["noApplication", "refused", "moduleInstanceGone", "notInApplication"] as const) {
      const html = renderToStaticMarkup(<DroppedLinksList links={[lost(unresolved)]} />);
      expect(html).not.toContain(imported);
      expect(html).toContain("An address is not in the project; the object&#x27;s other links are kept, never programmed.");
    }
    expect(renderToStaticMarkup(<DroppedLinksList links={[open]} />)).toContain(imported);
  });

  test("a module-instance reason is told as of the import, so it holds where the instance exists now", () => {
    const now = entry({ comObjRefId: "MD-1_M-1_MI-2_O-1_R-1", comObjNumber: null, unresolved: "notInApplication", unrecoverable: true, reason: "moduleInstanceGone" });
    const html = renderToStaticMarkup(<DroppedLinksList links={[now]} />);
    expect(html).toContain("At import the device had no module instance for this object");
    expect(html).not.toContain("no longer has");
  });

  test("a list of open entries only has no such group", () => {
    expect(renderToStaticMarkup(<DroppedLinksList links={[open]} />)).not.toContain("dropped-unrecoverable");
  });
});
