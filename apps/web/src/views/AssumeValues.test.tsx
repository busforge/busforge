import { test, expect, describe, beforeAll } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";
import { ApiError, type CfgParamView, type DeviceConfigView } from "../api.ts";
import { AssumeValuesPanel, UnprovenAssumptionsNote, assumeCandidates, assumeList, assumeReducer, assumeRefusal, initialAssumeState, type AssumeState } from "./AssumeValues.tsx";

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

  test("objects left after taken values are given both possible causes, neither as certain", () => {
    for (const msg of [en.device.assumeTakenUnresolved, de.device.assumeTakenUnresolved]) expect(msg).toMatch(/(may|können).*(Revert|Zurücksetzen).*(may not|konnte)/s);
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
  test("are named by their label as assumed, not proven", () => {
    const html = renderToStaticMarkup(<UnprovenAssumptionsNote params={[{ refId: "M-1_A-1_P-1_R-1", name: "Rocker function" }, { refId: "unknown-ref" }]} />);
    expect(html).toContain('data-testid="unproven-assumptions"');
    expect(html).toContain("Assumed, not proven");
    expect(html).toContain("Rocker function, a parameter not shown in this configuration");
    expect(html).not.toContain("unknown-ref");
    expect(html).toContain("shows only on this page since that read");
  });

  test("absent where every assumption was shown", () => {
    expect(renderToStaticMarkup(<UnprovenAssumptionsNote params={[]} />)).toBe("");
  });
});

describe("what the device page keeps of a read-back", () => {
  const rb = (readback: DeviceConfigView["readback"], ...params: CfgParamView[]): DeviceConfigView => ({ ...view(...params), readback });
  const ok = (s: AssumeState, deviceId: string, result: DeviceConfigView, sent: string[] = [], before?: DeviceConfigView) =>
    assumeReducer(s, { type: "readOk", deviceId, sent, result, before });
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

  test("a failed plain read clears an earlier refusal; a taken assumption clears the choices", () => {
    const refused = assumeReducer(assumeReducer(a, { type: "choose", refId: "r", value: "2" }), { type: "readFailed", deviceId: "A", assumed: true, error: new ApiError("x", "Y") });
    const failed = assumeReducer(refused, { type: "readFailed", deviceId: "A", assumed: false, error: new Error("bus") });
    expect(failed.error).toBeUndefined();
    expect(failed.choices).toEqual({ r: "2" });
    expect(ok(refused, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 0 }), ["r"]).choices).toEqual({});
  });

  test("an unproven value is named from the view after or before the read, else not at all; an edit drops it", () => {
    const r = rb({ paramsRead: true, linksRead: true, linkGaps: 1, unresolvedObjects: [7], unprovenAssumptions: ["after", "before", "nowhere"] }, p({ refId: "after", name: "Shown after" }));
    const s = ok(a, "A", r, ["after", "before", "nowhere"], view(p({ refId: "before", name: "Shown before" })));
    expect(s.lastRead).toEqual({ unresolved: [7], unproven: [{ refId: "after", name: "Shown after" }, { refId: "before", name: "Shown before" }, { refId: "nowhere", name: undefined }] });
    const edited = assumeReducer(s, { type: "paramChanged", deviceId: "A", refId: "before" });
    expect(edited.lastRead?.unproven.map((u) => u.refId)).toEqual(["after", "nowhere"]);
    expect(assumeReducer(edited, { type: "paramChanged", deviceId: "B", refId: "after" })).toBe(edited);
    expect(assumeReducer(edited, { type: "paramChanged", deviceId: "A", refId: "other" })).toBe(edited);
  });

  test("a later read decides only the parameters it assumed; a plain read keeps every unproven value", () => {
    const read = (unprovenAssumptions: string[], extra = {}) => rb({ paramsRead: true, linksRead: true, linkGaps: 0, unprovenAssumptions, ...extra }, p({ refId: "x", name: "X" }), p({ refId: "y", name: "Y" }));
    const names = (s: AssumeState) => s.lastRead?.unproven.map((u) => u.name);
    const x = ok(a, "A", read(["x"]), ["x"]);
    expect(names(x)).toEqual(["X"]);
    const xy = ok(x, "A", read(["y"]), ["y"]);
    expect(names(xy)).toEqual(["X", "Y"]);
    const plain = ok(xy, "A", rb({ paramsRead: true, linksRead: true, linkGaps: 2, unresolvedObjects: [4] }));
    expect(plain.lastRead).toEqual({ unresolved: [4], unproven: xy.lastRead!.unproven });
    expect(names(ok(plain, "A", read([]), ["x"]))).toEqual(["Y"]);
  });

  test("changing a choice clears a refusal made before sending, not one of the server", () => {
    const invalid = assumeReducer(a, { type: "invalid", names: ["Count"] });
    expect(assumeReducer(invalid, { type: "choose", refId: "n", value: "3" }).error).toBeUndefined();
    const refused = assumeReducer(a, { type: "readFailed", deviceId: "A", assumed: true, error: new ApiError("x", "READBACK_ASSUMPTION_IMAGE_DIFFERS") });
    expect(assumeReducer(refused, { type: "choose", refId: "n", value: "3" }).error?.code).toBe("READBACK_ASSUMPTION_IMAGE_DIFFERS");
  });
});
