import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MASKS, parseAppConfig, type SystemFamily, type MemoryModel } from "@busforge/product";
import { classify, classifyByMask, type DeviceCapabilities } from "../src/deviceprofile.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusTest } from "../../../tools/corpus-test.ts";

const realApp = (n: string) => parseAppConfig(catalogueXml(n));
// The doc cells a device's capabilities() render to. Keeping this here makes the VERDICT
// constant below a PRESENTATION of real capabilities(), not an independent claim.
const cells = (c: DeviceCapabilities): [string, string, string] => [
  c.readParams || c.readLinks ? "✅ params + links" : "❌",
  c.flashParams ? "✅" : "❌",
  c.flashLinks ? "✅" : "❌",
];

// Enforces that docs/device-support.md is in sync with the mask registry: every mask in
// MASKS must appear as a row with the same medium/family/memory-model and the support verdict
// its memory model implies. The doc claims to be "generated from masks.ts"; this test makes
// that claim true (the table is hand-written, but it can no longer drift silently — adding a
// mask or changing a model fails here until the doc is updated). The support verdict is keyed
// by memory model, matching the per-model implementation status in deviceprofile.ts.

const FAMILY_LABEL: Record<SystemFamily, string> = {
  "system-1": "System 1 (BCU1)", "system-2": "System 2 (BCU2)", "system-300": "System 300",
  "system-7": "System 7 (M112)", "system-b": "System B", "coupler": "Coupler",
  "interface": "Interface", "ir-decoder": "IR decoder", "media-coupler": "Media coupler",
  "rf": "RF-only", "dummy": "Dummy", "unknown": "Unknown",
};

// Read-back / flash-params / flash-GA verdict per implemented memory model. Mirrors the
// capabilities() of SystemBProfile (relative), System7Profile (absolute), System1Profile (bcu1), and
// UnsupportedProfile.
const VERDICT: Record<MemoryModel, [read: string, flashP: string, flashGa: string]> = {
  relative: ["✅ params + links", "✅", "✅"],
  absolute: ["✅ params + links", "✅", "✅"],
  bcu1: ["✅ params + links", "❌", "❌"],
  bcu2: ["❌", "❌", "❌"],
  system300: ["❌", "❌", "❌"],
  none: ["❌", "❌", "❌"],
};

const row = (m: (typeof MASKS)[number]): string => {
  const [read, flashP, flashGa] = VERDICT[m.memoryModel];
  return `| \`${m.mask}\` | ${m.medium} | ${FAMILY_LABEL[m.family]} | ${m.memoryModel} | ${read} | ${flashP} | ${flashGa} |`;
};

describe("docs/device-support.md stays in sync with the mask registry", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "device-support.md"), "utf8");

  test.each(MASKS.map((m) => [m.mask, m] as const))("%s has a matching matrix row", (_mask, m) => {
    expect(doc).toContain(row(m));
  });

  // The VERDICT constant is only honest if it reflects what classify().capabilities() actually
  // returns. Pin each implemented memory model to a real device's live capabilities, so a future
  // gate flip (e.g. flashLinks back to false) fails here instead of letting the doc lie.
  corpusTest("VERDICT for each memory model matches classify().capabilities()", () => {
    expect(cells(classify(realApp("M-0048_A-493B-21-B471.xml.gz")).capabilities())).toEqual(VERDICT.relative); // System B
    expect(cells(classify(realApp("M-0083_A-00B4-32-3919.xml.gz")).capabilities())).toEqual(VERDICT.absolute); // System 7
    expect(cells(classify(realApp("M-0083_A-0138-21-F18E-O0072.xml.gz")).capabilities())).toEqual(VERDICT.bcu1); // System 1
  });

  test("VERDICT for an unimplemented family matches classifyByMask().capabilities()", () => {
    // A recognised-but-unimplemented family resolves to UnsupportedProfile: every aspect false.
    expect(cells(classifyByMask("MV-0020").capabilities())).toEqual(VERDICT.bcu2);
  });

  test("the matrix has no rows for masks that are not in the registry", () => {
    const known = new Set(MASKS.map((m) => `\`${m.mask}\``));
    const rowMasks = [...doc.matchAll(/^\| (`MV-[0-9A-F]{4}`) \|/gm)].map((mm) => mm[1]);
    expect(rowMasks.length).toBe(MASKS.length);
    for (const rm of rowMasks) expect(known.has(rm)).toBe(true);
  });
});
