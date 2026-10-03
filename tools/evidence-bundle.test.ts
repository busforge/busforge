import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { generateBundle, renderPage, bundleText, unescapeKnxId, BUNDLE_PATH, PAGE_PATH } from "./evidence-bundle.ts";

test("the shipped evidence bundle and docs/compatibility.md match the kept records (else: bun run tools/evidence-bundle.ts --write)", () => {
  const bundle = generateBundle();
  expect(readFileSync(BUNDLE_PATH, "utf8") === bundleText(bundle)).toBe(true);
  expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(bundle));
});

test("KNX id escapes decode to the order number", () => {
  expect(unescapeKnxId("BE.2D02001.2E02")).toBe("BE-02001.02");
  expect(unescapeKnxId("AMMA.2D04.2F06.2ES")).toBe("AMMA-04/06.S");
});
