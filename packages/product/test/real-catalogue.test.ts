import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig } from "../src/appconfig.ts";
import { parseApplication, toAppModel, unmappedParamRefs } from "../src/application.ts";
import { resolveModuleInstances } from "../src/modules.ts";
import { buildDeviceConfig } from "../src/config.ts";
import { buildParameterImage, decodeParameterImage, decodeAbsoluteImage, encode } from "../src/image.ts";
import { buildAbsoluteSegmentTargets } from "../src/deviceimage.ts";
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

      test("absolute-segment build + flash plan stay pinned (sections present iff the app declares absolute segments)", () => {
        // Stability lock, not a correctness proof: the golden hashes prove the default
        // absolute build, its owned/verify masks and the surgical flash plan are
        // UNCHANGED since the reviewed regeneration; device-correctness is pinned by
        // the hardware byte-matches (docs/device-memory-model.md). The presence
        // checks are explicit because toEqual treats a missing key like `undefined`:
        // a fixture silently gaining or losing its absolute sections (e.g. the parser
        // dropping AbsoluteSegments) must fail HERE, loudly, not blur through.
        const app = parseAppConfig(xml);
        const snap = snapshot(xml);
        const hasAbs = app.absoluteSegments.length > 0;
        expect(snap.absolute !== undefined).toBe(hasAbs);
        expect(snap.flashPlan !== undefined).toBe(hasAbs);
        expect(golden[name].absolute !== undefined).toBe(hasAbs);
        expect(golden[name].flashPlan !== undefined).toBe(hasAbs);
        if (!hasAbs) return;
        expect(snap.absolute).toEqual(golden[name].absolute!);
        expect(snap.flashPlan).toEqual(golden[name].flashPlan!);
        // Both sections describe the same targeted-segment set (the image build and the
        // flash plan can never drift apart on which segments they cover).
        expect(Object.keys(snap.flashPlan!.perSegment).sort()).toEqual(Object.keys(snap.absolute!).sort());
        expect(snap.flashPlan!.segments).toBe(Object.keys(snap.flashPlan!.perSegment).length);
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

      test("the parameter image codec round-trips on the real model (build -> decode is its own inverse)", () => {
        // Round-trip lock (docs/ets-coverage.md stage 3). The flash-verify path builds an
        // image, flashes, reads it back and decodes to detect drift, so the codec must be
        // its own inverse on the REAL model wiring (actual offsets, types, signedness,
        // sub-byte packing, materialized module instances), not just the synthetic codec
        // model in image.test.ts. Relative (System B) segments: rebuilding from the decoded
        // image must reproduce it byte-for-byte. Absolute (MV-0705) segments: re-encoding
        // every decoded value over a copy must leave the bytes unchanged. This is the
        // self-consistency the verify path relies on (build and read-back agree); directional
        // correctness (MSB-first bit order, DPT-9 vectors) is pinned by image.test.ts and the
        // hardware byte-match. A non-inverse offset/type on any real param shifts a byte here.
        const app = parseAppConfig(xml);
        const instances = app.hasModules ? resolveModuleInstances(app, new Map()) : [];
        let roundTripped = 0;

        // Relative (System B): build from decoded defaults must reproduce the default image.
        const relModel = toAppModel(app, { instances });
        for (const lsm of new Set(relModel.segments.map((s) => s.lsm))) {
          const def = buildParameterImage(relModel, lsm, new Map());
          const stored = decodeParameterImage(relModel, lsm, def);
          // rebuilt == def is strictly stronger than decode(rebuilt) == stored, so assert the bytes.
          expect(buildParameterImage(relModel, lsm, stored).equals(def)).toBe(true);
          roundTripped += stored.size;
        }

        // Absolute (MV-0705): re-encoding every decoded value over a copy is a no-op. Uses the
        // same model shape buildAbsoluteSegmentTargets builds from (includeUnions + instances).
        if (app.absoluteSegments.length) {
          const absModel = toAppModel(app, { includeUnions: true, instances });
          for (const tg of buildAbsoluteSegmentTargets(app, new Map(), { moduleInstances: instances })) {
            // Each re-encode writes the decoded value back to the byte it came from, so it is a
            // no-op against the original regardless of write order or union overlap (idempotent
            // on the copy). A Float (DPT-9 / float32-NaN) param landing on a non-canonical
            // manufacturer <Data>/0xFF default would re-encode to a canonical pattern and flip a
            // byte; none of the 13 fixtures place one, so this stays a clean inverse here. That
            // normalization path is pinned on a synthetic app in deviceimage.test.ts ("a
            // non-canonical DPT-9 <Data> pattern..."), alongside the rounded-default case.
            const stored = decodeAbsoluteImage(absModel, tg.id, tg.bytes);
            const copy = Buffer.from(tg.bytes);
            for (const ref of absModel.refs.values()) {
              const param = absModel.params.get(ref.paramId);
              if (!param || param.codeSegment !== tg.id || param.offset === undefined) continue;
              const type = absModel.types.get(param.typeId);
              if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
              const v = stored.get(ref.id);
              if (v !== undefined) encode(copy, param.offset, param.bitOffset, type, v);
            }
            expect(copy.equals(tg.bytes)).toBe(true);
            roundTripped += stored.size;
          }
        }

        expect(roundTripped).toBeGreaterThan(0); // never vacuous: every real device has placeable params
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
