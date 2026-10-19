import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import { ApiError, type CfgParamView, type DeviceConfigView } from "../api.ts";
import { AssumeValuesPanel, NeverProgrammedKeptNote, UnprovenAssumptionsNote, UnresolvedNotes, assumeCandidates, assumeList, assumeReducer, assumeRefusal, assumedParams, initialAssumeState, type AssumeState } from "./AssumeValues.tsx";

const p = (over: Partial<CfgParamView>): CfgParamView => ({ refId: "M-1_A-1_P-1_R-1", name: "Rocker function", control: "enum", value: "0", options: [{ value: 0, text: "Switch" }, { value: 2, text: "Dim" }], ...over });
const view = (...params: CfgParamView[]): DeviceConfigView => ({
  hasModules: false,
  blocks: [{ id: "b1", name: "Rocker 1", level: 0, items: params.map((param) => ({ kind: "param" as const, param })) }],
} as DeviceConfigView);

describe("the parameters a read-back can be asked to assume", () => {
  test("are the shown, editable parameters without memory location, enumerated or whole-numbered", () => {
    const c = assumeCandidates(view(
      p({ memoryless: true }),
      p({ refId: "held", memoryless: undefined }),
      p({ refId: "info", memoryless: true, readOnly: true }),
      p({ refId: "count", memoryless: true, control: "number", options: undefined, min: 0, max: 10, value: "3" }),
      p({ refId: "float", memoryless: true, control: "number", float: true, options: undefined }),
      p({ refId: "text", memoryless: true, control: "text", options: undefined }),
      p({ memoryless: true }),
    ));
    expect(c.map((x) => x.refId)).toEqual(["M-1_A-1_P-1_R-1", "count"]);
    expect(c[0]).toMatchObject({ name: "Rocker function", block: "Rocker 1", value: "0" });
  });

  test("only the chosen values are sent, as the server takes them", () => {
    const c = assumeCandidates(view(p({ memoryless: true }), p({ refId: "two", memoryless: true })));
    expect(assumeList(c, { "M-1_A-1_P-1_R-1": "2", two: "" })).toEqual({ assume: [{ paramRefId: "M-1_A-1_P-1_R-1", value: "2" }], invalid: [] });
    expect(assumeList(c, { gone: "1" })).toEqual({ assume: [], invalid: [] });
  });

  test("a number is sent in the server's form, and one the server would refuse is not sent", () => {
    const c = assumeCandidates(view(p({ refId: "n", name: "Count", memoryless: true, control: "number", options: undefined, min: -5, max: 10 })));
    const sent = (raw: string) => assumeList(c, { n: raw });
    expect(sent(" 007 ").assume).toEqual([{ paramRefId: "n", value: "7" }]);
    expect(sent("+3").assume).toEqual([{ paramRefId: "n", value: "3" }]);
    expect(sent("-0").assume).toEqual([{ paramRefId: "n", value: "0" }]);
    expect(sent("-05").assume).toEqual([{ paramRefId: "n", value: "-5" }]);
    for (const bad of ["1.5", "1e1", "11", "-6", "abc", "--1"]) expect(sent(bad)).toEqual({ assume: [], invalid: ["Count"] });
  });
});

describe("the offer on the device page", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));
  const candidates = assumeCandidates(view(p({ memoryless: true })));
  const panel = (over: Partial<Parameters<typeof AssumeValuesPanel>[0]> = {}) => renderToStaticMarkup(
    <AssumeValuesPanel candidates={candidates} unresolved={[18, 20]} choices={{}} onChoose={() => {}} onSubmit={() => {}} pending={false} {...over} />);

  test("names the unresolved objects and offers each parameter, unassumed until chosen", () => {
    const html = panel();
    expect(html).toContain('data-testid="assume-values"');
    expect(html).toContain("18, 20");
    expect(html).toContain("Rocker function");
    expect(html).toContain('data-testid="assume-M-1_A-1_P-1_R-1"');
    expect(html).toContain(">Not assumed</option>");
    expect(html).toContain(">Dim</option>");
    expect(html.match(/<button[^>]*data-testid="assume-submit"[^>]*>/)![0]).toMatch(/ disabled=""/);
  });

  test("a chosen value enables the retry", () => {
    const html = panel({ choices: { "M-1_A-1_P-1_R-1": "2" } });
    expect(html.match(/<button[^>]*data-testid="assume-submit"[^>]*>/)![0]).not.toMatch(/ disabled=""/);
  });

  test("a refused retry says why and names the objects that still do not resolve", () => {
    const e = new ApiError("x", "READBACK_ASSUMPTION_UNRESOLVED", { objects: [20] });
    const html = panel({ error: assumeRefusal(e) });
    expect(html).toContain('data-testid="assume-refused"');
    expect(html).toContain("still shows no object for some of its links");
    expect(html).toContain('data-testid="assume-refused-objects"');
    expect(html).toMatch(/Still unresolved: object\(s\) 20/);
    const other = panel({ error: assumeRefusal(new ApiError("x", "READBACK_ASSUMPTION_IMAGE_DIFFERS")) });
    expect(other).toContain("does not run these values");
    expect(other).not.toContain('data-testid="assume-refused-objects"');
    expect(other).toMatch(/<div role="alert"[^>]*data-testid="assume-refused"/);
  });

  test("each field is labelled with its block and name; a value refused before sending is named", () => {
    expect(panel()).toContain('aria-label="Rocker 1: Rocker function"');
    expect(panel({ error: { message: "", invalid: ["Count"] } })).toContain("Not sent: Count needs a whole number");
  });

  test("names only the objects an assumption can place, and does not offer one for those a revert resolves", () => {
    const html = panel({ unresolved: [18] });
    expect(html).toContain("object(s) 18,");
    expect(html).not.toContain("Revert");
  });

  test("in German too", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = panel();
      expect(html).toContain("Nicht angenommen");
      expect(html).toContain("18, 20");
    } finally { await i18n.changeLanguage("en"); }
  });
});

describe("assumed values the device could not tell apart", () => {
  test("are the rows the view marks assumed, each once, by their label", () => {
    const v: DeviceConfigView = { ...view(p({ refId: "a", name: " Rocker function ", assumed: true }), p({ refId: "b", name: "Other" }), p({ refId: "a", name: "Rocker function", assumed: true })) };
    v.blocks.push({ id: "b2", name: "Rocker 2", level: 0, items: [{ kind: "param", param: p({ refId: "c", name: "LED", assumed: true }) }] });
    expect(assumedParams(v)).toEqual([{ refId: "a", name: "Rocker function" }, { refId: "c", name: "LED" }]);
    expect(assumedParams(undefined)).toEqual([]);
  });

  test("are named as assumed, not proven, and say what ends the mark", () => {
    const html = renderToStaticMarkup(<UnprovenAssumptionsNote params={[{ refId: "a", name: "Rocker function" }, { refId: "c", name: "LED" }]} />);
    expect(html).toContain('data-testid="unproven-assumptions"');
    expect(html).toContain("Assumed, not proven");
    expect(html).toContain("Rocker function, LED");
    expect(html).toContain("proves it");
    expect(html).not.toContain("only on this page");
  });

  test("those on parameters the configuration does not show are counted, not dropped", () => {
    expect(renderToStaticMarkup(<UnprovenAssumptionsNote params={[{ refId: "a", name: "Rocker function" }]} hidden={2} />)).toContain("Rocker function, and 2 parameters this configuration does not show");
    expect(renderToStaticMarkup(<UnprovenAssumptionsNote params={[]} hidden={1} />)).toContain("1 parameter this configuration does not show");
  });

  test("absent where no row is marked", () => {
    expect(renderToStaticMarkup(<UnprovenAssumptionsNote params={[]} />)).toBe("");
  });
});

describe("objects a read leaves unresolved that no assumption places", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));
  const notes = (over: Partial<Parameters<typeof UnresolvedNotes>[0]> = {}) =>
    renderToStaticMarkup(<UnresolvedNotes hidden={[]} unknown={[]} unplacedUnoffered={[]} {...over} />);

  test("those the project's own values hide point to Revert", () => {
    const html = notes({ hidden: [64] });
    expect(html).toContain('data-testid="unresolved-hidden"');
    expect(html).toMatch(/object\(s\) 64,.*Revert/s);
    expect(html).not.toContain('data-testid="unresolved-unknown"');
  });

  test("those the read could not tell, and those no shown parameter could place, are said as such", () => {
    expect(notes({ unknown: [254] })).toMatch(/data-testid="unresolved-unknown".*254/s);
    expect(notes({ unplacedUnoffered: [5] })).toMatch(/data-testid="unresolved-unplaced".*5/s);
    expect(notes()).toBe("");
  });

  test("in German too", async () => {
    await i18n.changeLanguage("de");
    try { expect(notes({ hidden: [64] })).toMatch(/64.*Zurücksetzen/s); } finally { await i18n.changeLanguage("en"); }
  });
});

describe("why a device stays never programmed after a read", () => {
  beforeAll(() => i18n.use(initReactI18next).init({ resources: { en: { translation: en }, de: { translation: de } }, lng: "en", interpolation: { escapeValue: false } }));
  const note = (reasons: Parameters<typeof NeverProgrammedKeptNote>[0]["reasons"]) => renderToStaticMarkup(<NeverProgrammedKeptNote reasons={reasons} />);

  test("each reason is named, the image's with why it was not compared where that has a text, never a raw code", () => {
    const html = note([{ reason: "linksUnresolved" }, { reason: "otherApplication" }, { reason: "imageNotCompared", code: "READBACK_IMAGE_NO_FLASH" }]);
    expect(html).toContain('data-testid="never-programmed-kept"');
    expect(html).toContain("links the device holds do not resolve");
    expect(html).toContain("another application");
    expect(html).toContain(`(${en.errors.READBACK_IMAGE_NO_FLASH})`);
    expect(html).not.toContain("READBACK_IMAGE_NO_FLASH");
    // A code without a text of its own is named through a localized generic text.
    const unknown = note([{ reason: "imageNotCompared", code: "NO_SUCH_CODE" }]);
    expect(unknown).toContain(en.device.neverProgrammedReason.imageNotCompared.replaceAll("'", "&#x27;"));
    expect(unknown).toContain("(error code NO_SUCH_CODE)");
    expect(note([])).toBe("");
  });

  test("every reason the server gives has its text, in both languages", () => {
    for (const reason of ["readIncomplete", "linksUnresolved", "otherApplication", "applicationIdNotReported", "notLoaded", "imageDiffers", "imageNotCompared"] as const) {
      expect([reason, typeof en.device.neverProgrammedReason[reason], typeof de.device.neverProgrammedReason[reason]]).toEqual([reason, "string", "string"]);
    }
  });

  test("in German too", async () => {
    await i18n.changeLanguage("de");
    try {
      expect(note([{ reason: "notLoaded" }])).toContain("LOADED");
      expect(note([{ reason: "imageNotCompared", code: "READBACK_IMAGE_NO_FLASH" }])).toContain(`(${de.errors.READBACK_IMAGE_NO_FLASH})`);
      expect(note([{ reason: "imageNotCompared", code: "NO_SUCH_CODE" }])).toContain("(Fehlercode NO_SUCH_CODE)");
    } finally { await i18n.changeLanguage("en"); }
  });
});

describe("what the device page keeps of a read-back", () => {
  const rb = (readback: DeviceConfigView["readback"], ...params: CfgParamView[]): DeviceConfigView => ({ ...view(...params), readback });
  const ok = (s: AssumeState, deviceId: string, result: DeviceConfigView, assumed = false) =>
    assumeReducer(s, { type: "readOk", deviceId, assumed, result });
  const a = initialAssumeState("A");

  test("another device starts afresh, and a late result or refusal for the one before is ignored", () => {
    const chosen = assumeReducer(assumeReducer(a, { type: "choose", refId: "r", value: "2" }), { type: "readFailed", deviceId: "A", assumed: true, error: new ApiError("x", "READBACK_ASSUMPTION_IMAGE_DIFFERS") });
    expect(chosen.error?.code).toBe("READBACK_ASSUMPTION_IMAGE_DIFFERS");
    const b = assumeReducer(chosen, { type: "device", deviceId: "B" });
    expect(b).toEqual(initialAssumeState("B"));
    expect(ok(b, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 1, unresolvedObjects: [3] }))).toBe(b);
    expect(assumeReducer(b, { type: "readFailed", deviceId: "A", assumed: true, error: new ApiError("x", "Y") })).toBe(b);
    expect(assumeReducer(b, { type: "device", deviceId: "B" })).toBe(b);
  });

  test("a failed read, a revert or a write leaves no unresolved objects of an earlier read standing", () => {
    const s = ok(a, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 1, unresolvedObjects: [64], hiddenObjects: [64] }));
    expect(assumeReducer(s, { type: "readFailed", deviceId: "A", assumed: false, error: new Error("bus") }).lastRead).toBeNull();
    expect(assumeReducer(s, { type: "readFailed", deviceId: "A", assumed: true, error: new Error("refused") }).lastRead).toBe(s.lastRead);
    expect(assumeReducer(s, { type: "stale", deviceId: "B" })).toBe(s);
  });

  test("an edit or a revert keeps the reasons that are facts about the device, and drops those judged against the project", () => {
    const s = ok(a, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 1, unresolvedObjects: [5, 64], unplacedObjects: [5], hiddenObjects: [64], unknownObjects: [7],
      neverProgrammedKept: [{ reason: "linksUnresolved" }, { reason: "otherApplication" }, { reason: "applicationIdNotReported" }, { reason: "notLoaded" }, { reason: "readIncomplete" }, { reason: "imageDiffers" }, { reason: "imageNotCompared", code: "X" }] }));
    expect(assumeReducer(s, { type: "stale", deviceId: "A" }).lastRead).toEqual({ unplaced: [], hidden: [], unknown: [],
      neverProgrammedKept: [{ reason: "otherApplication" }, { reason: "applicationIdNotReported" }, { reason: "notLoaded" }, { reason: "readIncomplete" }] });
    // A verified write can change what the device holds (its application, its load states): nothing of the read stands.
    expect(assumeReducer(s, { type: "written", deviceId: "A" }).lastRead).toBeNull();
    expect(assumeReducer(s, { type: "written", deviceId: "B" })).toBe(s);
  });

  test("a failed plain read clears an earlier refusal; a taken assumption clears the choices", () => {
    const refused = assumeReducer(assumeReducer(a, { type: "choose", refId: "r", value: "2" }), { type: "readFailed", deviceId: "A", assumed: true, error: new ApiError("x", "Y") });
    const failed = assumeReducer(refused, { type: "readFailed", deviceId: "A", assumed: false, error: new Error("bus") });
    expect(failed.error).toBeUndefined();
    expect(failed.choices).toEqual({ r: "2" });
    expect(ok(refused, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 0 }), true).choices).toEqual({});
    expect(ok(refused, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 0 })).choices).toEqual({ r: "2" });
  });

  test("keeps the unresolved objects by what resolves them, and why the device stays never programmed", () => {
    const s = ok(a, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 4, unresolvedObjects: [5, 18, 64, 254], unplacedObjects: [5, 18], hiddenObjects: [64], unknownObjects: [254], neverProgrammedKept: [{ reason: "linksUnresolved" }] }));
    expect(s.lastRead).toEqual({ unplaced: [5, 18], hidden: [64], unknown: [254], neverProgrammedKept: [{ reason: "linksUnresolved" }] });
    expect(ok(s, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 0 })).lastRead).toEqual({ unplaced: [], hidden: [], unknown: [], neverProgrammedKept: [] });
  });

  test("changing a choice clears a refusal made before sending, not one of the server", () => {
    const invalid = assumeReducer(a, { type: "invalid", names: ["Count"] });
    expect(assumeReducer(invalid, { type: "choose", refId: "n", value: "3" }).error).toBeUndefined();
    const refused = assumeReducer(a, { type: "readFailed", deviceId: "A", assumed: true, error: new ApiError("x", "READBACK_ASSUMPTION_IMAGE_DIFFERS") });
    expect(assumeReducer(refused, { type: "choose", refId: "n", value: "3" }).error?.code).toBe("READBACK_ASSUMPTION_IMAGE_DIFFERS");
  });
});
