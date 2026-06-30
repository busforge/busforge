import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig } from "../src/appconfig.ts";
import { parseApplication, toAppModel, unmappedParamRefs } from "../src/application.ts";
import { resolveModuleInstances } from "../src/modules.ts";
import { buildDeviceConfig } from "../src/config.ts";
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
    // Every distinct application program across all of the owner's projects.
    expect(fixtures.length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(golden).sort()).toEqual(fixtures);
    // covering several manufacturers (M-XXXX prefix)
    const manus = new Set(fixtures.map((f) => f.split("_")[0]));
    expect(manus.size).toBeGreaterThanOrEqual(6);
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

      test("every UI-exposed param is image-placeable (config/image projections stay in lock-step)", () => {
        // Stage-3 coverage lock (docs/ets-coverage.md). The config view (what the UI
        // lets a user edit, hence what can be stored) and the image model (what the
        // codec can place) read one model and project it two ways. Anything the UI
        // exposes must be placeable, else a stored value would be silently dropped and
        // its region reset to default; the flash path enforces this per-device at flash
        // time (deviceprofile.ts via unmappedParamRefs). This lifts that runtime guard
        // to a build-time corpus assertion, so a feature added to one projection but not
        // the other fails the build. NOT literal set equality: the image is a deliberate
        // superset (it also carries Access="None" internal params, union members and
        // all-branch bytes the UI never shows). The direction that matters is coverage,
        // UI-exposed is a subset of image-placeable. Module devices (493B, M-0083) used
        // to fail this until per-instance offsets landed; the device's DEFAULT config is
        // exercised here, the 493B's channel-active path in modules.test.ts.
        const app = parseAppConfig(xml);
        const instances = app.hasModules ? resolveModuleInstances(app, new Map()) : [];
        const view = buildDeviceConfig(app, new Map(), undefined, instances);
        const uiRefs = new Map<string, string>();
        for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") uiRefs.set(it.param.refId, "0");
        expect(uiRefs.size).toBeGreaterThan(0); // every real device exposes params; never pass vacuously
        const model = toAppModel(app, { instances });
        expect(unmappedParamRefs(model, uiRefs)).toEqual([]);
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
