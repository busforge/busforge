import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { corpusTest } from "./corpus-test.ts";
import { parseEvidenceBundle } from "../packages/product/src/index.ts";
import { generateBundle, collectRecords, renderPage, bundleText, unescapeKnxId, BUNDLE_PATH, PAGE_PATH } from "./evidence-bundle.ts";

corpusTest("the shipped evidence bundle and docs/compatibility.md match the kept records (else: bun run tools/evidence-bundle.ts --write)", () => {
  const bundle = generateBundle();
  expect(readFileSync(BUNDLE_PATH, "utf8") === bundleText(bundle)).toBe(true);
  expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(bundle));
});

// The part of the check above that needs no catalogue: the Products' capabilities are taken from
// the shipped bundle instead of being derived from their application programs.
test("the shipped evidence bundle holds exactly the kept records, and docs/compatibility.md renders it", () => {
  const shipped = parseEvidenceBundle(JSON.parse(readFileSync(BUNDLE_PATH, "utf8")));
  expect(shipped.records.length).toBeGreaterThan(0);
  expect(shipped.records).toStrictEqual(collectRecords());
  expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(shipped));
});

test("KNX id escapes decode to the order number", () => {
  expect(unescapeKnxId("BE.2D02001.2E02")).toBe("BE-02001.02");
  expect(unescapeKnxId("AMMA.2D04.2F06.2ES")).toBe("AMMA-04/06.S");
});
