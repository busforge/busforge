import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig } from "../src/appconfig.ts";
import { parseApplication } from "../src/application.ts";
import {
  REAL_DIR, listRealFixtures, readRealFixture, snapshot, IMAGE_BASES, CONFIG_BASES, type AppSnapshot,
} from "./real-catalogue.snapshot.ts";

// Regression coverage against real manufacturer catalogue data: one device per
// manufacturer (Gira, Theben, Basalte, MDT x2, Steinel), gzipped under
// fixtures/real/ with no personal data (manufacturer ApplicationProgram XML only).
// Every parser/projection change is pinned by fixtures/real/golden.json; after an
// intentional change, regenerate with: bun run packages/product/test/real-catalogue.gen.ts
const golden: Record<string, AppSnapshot> = JSON.parse(readFileSync(join(REAL_DIR, "golden.json"), "utf8"));
const fixtures = listRealFixtures();

describe("real catalogue (per-manufacturer regression)", () => {
  test("fixtures and golden stay in lock-step", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6); // one per manufacturer
    expect(Object.keys(golden).sort()).toEqual(fixtures);
    // distinct manufacturers (M-XXXX prefix) are actually distinct
    const manus = new Set(fixtures.map((f) => f.split("_")[0]));
    expect(manus.size).toBe(fixtures.length);
  });

  for (const name of fixtures) {
    describe(name, () => {
      const xml = readRealFixture(name);

      test("parses without throwing and matches the golden snapshot", () => {
        expect(() => parseAppConfig(xml)).not.toThrow();
        expect(() => parseApplication(xml)).not.toThrow();
        expect(snapshot(xml)).toEqual(golden[name]);
      });

      test("every type base is a known enum value (no parser leak)", () => {
        const app = parseAppConfig(xml);
        for (const t of app.types.values()) expect(CONFIG_BASES.has(t.base)).toBe(true);
        const model = parseApplication(xml);
        for (const t of model.types.values()) expect(IMAGE_BASES.has(t.base)).toBe(true);
      });

      test("the image projection drops module-def and union entries", () => {
        const app = parseAppConfig(xml);
        const model = parseApplication(xml);
        // Every projected param/type/ref is a top-level (untagged) one.
        for (const p of model.params.values()) {
          const src = app.params.get(p.id);
          expect(src?.union).toBeFalsy();
          expect(src?.moduleDefId).toBeFalsy();
        }
        for (const t of model.types.values()) expect(app.types.get(t.id)?.moduleDefId).toBeFalsy();
      });
    });
  }
});
