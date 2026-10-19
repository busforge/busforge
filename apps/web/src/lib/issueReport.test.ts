import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildIssueDraft, cleanValue, ISSUE_REPOSITORY, MAX_ISSUE_URL, METADATA_FIELDS, REPORT_TEMPLATES, subjectOf, type ReportInput, type ReportSubject } from "./issueReport.ts";

const TEMPLATE_DIR = join(import.meta.dir, "..", "..", "..", "..", ".github", "ISSUE_TEMPLATE");
type FormElement = { type: string; id?: string; attributes: Record<string, unknown> };
type Form = { name: string; description: string; title?: string; body: FormElement[] };
const form = (file: string) => Bun.YAML.parse(readFileSync(join(TEMPLATE_DIR, file), "utf8")) as Form;

const subject: ReportSubject = {
  manufacturerId: "M-0083", manufacturerName: "MDT technologies", orderNumber: "BE-02001.02",
  productRef: "M-0083_H-0123-01_P-BE.2D02001.2E02", appProgramId: "M-0083_A-00B6-32-9642",
};
const version = { version: "v0.1.0-3-gabc1234", commit: "abc1234" };
const params = (url: string) => new URL(url).searchParams;

test("every field a link fills is a text field of its template, and the templates have no upload", () => {
  for (const t of Object.values(REPORT_TEMPLATES)) {
    const f = form(t.file);
    expect(typeof f.name).toBe("string");
    expect(typeof f.description).toBe("string");
    const ids = f.body.map((e) => e.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [...METADATA_FIELDS, t.description]) {
      const el = f.body.find((e) => e.id === id);
      expect(el?.type === "input" || el?.type === "textarea").toBe(true);
    }
    // A public issue never takes the diagnostic package as an upload field.
    expect(f.body.some((e) => e.type === "upload")).toBe(false);
    expect(f.title?.startsWith(t.titlePrefix)).toBe(true);
  }
  // No form in the directory that the app does not know of (config.yml configures the chooser).
  expect(readdirSync(TEMPLATE_DIR).filter((f) => f !== "config.yml").sort()).toEqual(Object.values(REPORT_TEMPLATES).map((t) => t.file).sort());
});

test("the link carries only the template, the title and the approved metadata", () => {
  // A caller handing more than a ReportSubject: none of the extra fields reaches the link.
  const device = { ...subject, ia: "1.1.7", name: "Kitchen dimmer", productName: "Kitchen light", room: "Kitchen", toolKey: "00112233445566778899aabbccddeeff", host: "192.0.2.20" };
  const d = buildIssueDraft({ kind: "problem", version, subject: device });
  const p = params(d.url);
  expect([...p.keys()].sort()).toEqual(["application", "product", "template", "title", "version"]);
  for (const secret of ["1.1.7", "Kitchen", "00112233", "192.0.2"]) expect(decodeURIComponent(d.url)).not.toContain(secret);
  expect(d.url.startsWith(`${ISSUE_REPOSITORY}/issues/new?`)).toBe(true);
  expect(p.get("template")).toBe("problem.yml");
  expect(p.get("title")).toBe("Problem: MDT technologies BE-02001.02");
  expect(p.get("version")).toBe("v0.1.0-3-gabc1234");
  expect(p.get("product")).toBe("MDT technologies BE-02001.02 · M-0083_H-0123-01_P-BE.2D02001.2E02");
  expect(p.get("application")).toBe("M-0083_A-00B6-32-9642");
  expect(d.fields.map((f) => f.id)).toEqual(["version", "product", "application"]);
});

test("feedback goes to its own template, its description to the use field", () => {
  const d = buildIssueDraft({ kind: "feedback", version, subject, description: "Parameters and group addresses for three months." });
  const p = params(d.url);
  expect(p.get("template")).toBe("device-feedback.yml");
  expect(p.get("title")).toBe("Device feedback: MDT technologies BE-02001.02");
  expect(p.get("use")).toBe("Parameters and group addresses for three months.");
  expect(p.has("what")).toBe(false);
});

test("without a device only the version goes in, and the title is left to the user", () => {
  const d = buildIssueDraft({ kind: "problem", version: { version: "dev", commit: "unknown" } });
  const p = params(d.url);
  expect([...p.keys()].sort()).toEqual(["template", "title", "version"]);
  expect(p.get("version")).toBe("dev");
  expect(p.get("title")).toBe("Problem: ");
  expect(d.searchUrl).toBeNull();
  expect(d.withheld).toEqual([]);
});

test("a commit that is not in the version is appended; one that is no commit is withheld", () => {
  expect(params(buildIssueDraft({ kind: "problem", version: { version: "v0.2.0", commit: "1234567" } }).url).get("version")).toBe("v0.2.0 (1234567)");
  const odd = buildIssueDraft({ kind: "problem", version: { version: "v0.2.0", commit: "Kitchen" } });
  expect(params(odd.url).get("version")).toBe("v0.2.0");
  expect(odd.withheld).toEqual(["commit"]);
});

test("ids that are not KNX catalogue ids are withheld, never passed on", () => {
  const d = buildIssueDraft({ kind: "feedback", version, subject: { ...subject, productRef: "Living room <b>", appProgramId: "M-0083_A-00B6 32", manufacturerId: "x", manufacturerName: undefined } });
  const p = params(d.url);
  expect(d.withheld).toEqual(["productRef", "appProgramId"]);
  expect(p.has("application")).toBe(false);
  expect(p.get("product")).toBe("BE-02001.02");
  expect(decodeURIComponent(d.url)).not.toContain("Living");
  expect(d.searchUrl).toBeNull();
});

test("text is encoded so that every character comes back as written", () => {
  const text = "a & b = c # d + e ? f / g %20 h\n\n„Ümlaut“ ✓ 漢字 \"quoted\"";
  const d = buildIssueDraft({ kind: "problem", version, subject: { ...subject, orderNumber: "Tast & Sensor #1 + 50%" }, description: text });
  const p = params(d.url);
  expect(p.get("what")).toBe(text);
  expect(p.get("product")).toContain("Tast & Sensor #1 + 50%");
  // Nothing in the query is left raw that would end it or start a fragment.
  expect(new URL(d.url).hash).toBe("");
});

test("control characters and direction overrides are removed", () => {
  expect(cleanValue("BE\u0000-02\u202E001\u2066.02\u200B\n x")).toBe("BE -02 001 .02 x");
  expect(params(buildIssueDraft({ kind: "problem", version, description: "a\rb\r\nc" }).url).get("what")).toBe("a\nb\nc");
  const d = buildIssueDraft({ kind: "problem", version, description: "line one\r\nline\u202E two\u0007\ttab" });
  expect(params(d.url).get("what")).toBe("line one\nline two\ttab");
});

test("a description that makes the link too long leaves it whole, for copy and paste", () => {
  const base = buildIssueDraft({ kind: "problem", version, subject }).url.length;
  const room = MAX_ISSUE_URL - base - "&what=".length;
  const fits = buildIssueDraft({ kind: "problem", version, subject, description: "x".repeat(room) });
  expect(fits.descriptionInUrl).toBe(true);
  expect(fits.url.length).toBe(MAX_ISSUE_URL);
  const long = "ü".repeat(room); // six characters each once encoded
  const over = buildIssueDraft({ kind: "problem", version, subject, description: long });
  expect(over.descriptionInUrl).toBe(false);
  expect(params(over.url).has("what")).toBe(false);
  expect(over.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
  expect(over.description).toBe(long);
});

test("metadata alone always fits; a value too long for the link is left out, never cut", () => {
  const input: ReportInput = { kind: "feedback", version: { version: "v".repeat(5000), commit: "abc1234" }, subject: { ...subject, manufacturerName: "漢".repeat(5000), orderNumber: "ü".repeat(5000) } };
  const d = buildIssueDraft(input);
  expect(d.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
  expect(d.withheld.sort()).toEqual(["manufacturer", "orderNumber", "version"]);
  expect(params(d.url).has("version")).toBe(false);
  expect(params(d.url).get("product")).toBe(`M-0083 · ${subject.productRef}`);
  // The longest values that are still kept, all non-ASCII: the link stays below the limit.
  const wide = buildIssueDraft({ kind: "problem", version: { version: "ü".repeat(100), commit: "abc1234" }, subject: { ...subject, manufacturerName: "漢".repeat(66), orderNumber: "漢".repeat(66) } });
  expect(wide.withheld).toEqual([]);
  expect(wide.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
  // Characters that encodeURIComponent keeps but the link's encoding triples.
  const quoted = buildIssueDraft({ kind: "problem", version, subject: { ...subject, manufacturerName: "'(".repeat(300), orderNumber: "!~".repeat(300) } });
  expect(quoted.withheld.sort()).toEqual(["manufacturer", "orderNumber"]);
  const near = buildIssueDraft({ kind: "problem", version, subject: { ...subject, manufacturerName: "'".repeat(200), orderNumber: "(".repeat(200) } });
  expect(near.withheld).toEqual([]);
  expect(near.url.length).toBeLessThanOrEqual(MAX_ISSUE_URL);
});

test("a device's report subject takes only the order number from the catalogue, never its product text", () => {
  const device = { productRef: subject.productRef, appRef: "M-0083_H-0123-01_HP-00B6-32-9642", manufacturer: 0x83 };
  const manufacturers = [{ id: "M-0083", name: "MDT technologies" }];
  // A row backfilled from a project's devices: the user's device name as product text, no order number.
  const backfilled = [{ ...device, name: "Kitchen dimmer", orderNumber: "" }];
  const s = subjectOf(device, backfilled, manufacturers);
  expect(s).toEqual({ manufacturerId: "M-0083", manufacturerName: "MDT technologies", orderNumber: "BE-02001.02", productRef: subject.productRef, appProgramId: "M-0083_A-00B6-32-9642" });
  expect(decodeURIComponent(buildIssueDraft({ kind: "feedback", version, subject: s }).url)).not.toContain("Kitchen");
  expect(subjectOf(device, [{ ...device, orderNumber: "BE-02001.02 (catalogue)" }], undefined).orderNumber).toBe("BE-02001.02 (catalogue)");
  expect(subjectOf(device, undefined, undefined).manufacturerName).toBeUndefined();
});

test("related reports are found by the application program id", () => {
  const d = buildIssueDraft({ kind: "feedback", version, subject });
  expect(d.searchUrl).toBe(`${ISSUE_REPOSITORY}/issues?q=is%3Aissue+%22M-0083_A-00B6-32-9642%22`);
  expect(new URL(d.searchUrl!).searchParams.get("q")).toBe("is:issue \"M-0083_A-00B6-32-9642\"");
});
