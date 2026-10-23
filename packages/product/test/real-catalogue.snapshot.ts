import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseAppConfig } from "../src/appconfig.ts";
import { parseApplication } from "../src/application.ts";
import { buildParameterImage, decodeParameterImage } from "../src/image.ts";
import { buildAbsoluteSegmentTargets } from "../src/deviceimage.ts";
import { planAbsoluteSegmentFlash } from "../src/deviceflash.ts";
import { ProductError } from "../src/errors.ts";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";

// Golden-master snapshot of a manufacturer ApplicationProgram, used to pin the
// parse + image projection against real catalogue data (the catalogue/ files of the private
// corpus, tools/corpus.ts; golden.json under fixtures/real/ holds only hashes). The snapshot is a
// content hash of the byte-relevant image model plus, where a default image builds,
// its byte hash and the decoded read-back hash. For absolute-segment (MV-0705) devices
// it additionally pins the default absolute build (bytes + owned/verify masks) and the
// surgical flash plan shape. A regression in the parser or the projection changes a
// hash and fails real-catalogue.test.ts.

export const REAL_DIR = join(import.meta.dir, "fixtures", "real");
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// The image-model bases a healthy projection can produce (TypeTime is folded into
// Number; IPAddress is a 4-byte host address).
export const IMAGE_BASES = new Set(["Value", "BinaryValue", "Number", "Float", "Text", "IPAddress", "Color", "Other"]);
// The config-layer bases the parser can produce.
export const CONFIG_BASES = new Set(["Value", "BinaryValue", "Number", "Float", "Color", "Text", "Time", "IPAddress", "Other"]);

export interface AppSnapshot {
  shape: { types: number; params: number; refs: number; comObjects: number; segments: number; hasModules: boolean };
  modelHash: string;
  // `refused`: the default image of that segment is refused with this code (a coded ProductError).
  lsms: Record<string, { build: string; decodeHash: string } | { refused: string }>;
  // Absolute-segment (MV-0705) sections, present iff the app declares AbsoluteSegments.
  // Like `lsms`, these are stability locks, not correctness proofs: the hashes pin
  // "the default build/masks/plan have not changed", correctness is pinned separately
  // by the hardware byte-matches (docs/device-memory-model.md).
  // `absolute`: per TARGETED segment (a declared segment no parameter points at builds
  // no image and is deliberately absent) the default-image byte hash plus the
  // owned/verify byte-mask hashes from buildAbsoluteSegmentTargets.
  absolute?: Record<string, { address: number; size: number; build: string; owned: string; verify: string }>;
  // `flashPlan`: the surgical write plan for a default config against an unknown device
  // (planAbsoluteSegmentFlash with no `current` read-back). writtenBytes === ownedBytes
  // in that case, so it is not duplicated here.
  flashPlan?: { segments: number; perSegment: Record<string, { address: number; size: number; ownedBytes: number; skippedUnowned: number }> };
}

export const listRealFixtures = listCatalogue;
export const readRealFixture = catalogueXml;

export function snapshot(xml: string): AppSnapshot {
  const app = parseAppConfig(xml);
  const model = parseApplication(xml);
  // Canonical, order-independent serialization of the byte-relevant model.
  const types = [...model.types.values()].map((t) => `${t.id}|${t.base}|${t.sizeInBit}|${t.signed}`).sort();
  const params = [...model.params.values()].map((p) => `${p.id}|${p.typeId}|${p.offset ?? ""}|${p.bitOffset}|${p.value ?? ""}|${p.codeSegment ?? ""}`).sort();
  const refs = [...model.refs.values()].map((r) => `${r.id}|${r.paramId}|${r.value ?? ""}`).sort();
  const segs = model.segments.map((s) => `${s.id}|${s.lsm}|${s.size}|${sha(s.data.toString("base64"))}`).sort();
  const modelHash = sha(JSON.stringify({ types, params, refs, segs }));

  // Build a default image per segment and pin its bytes + read-back. A refusal with a code is pinned
  // as `refused`, so it cannot appear or vanish unnoticed; any other throw is a real defect (the codec
  // cannot place a real parameter), so it is NOT swallowed and the test fails loudly.
  const lsms: AppSnapshot["lsms"] = {};
  for (const lsm of [...new Set(model.segments.map((s) => s.lsm))].sort((a, b) => a - b)) {
    let img: Buffer;
    try { img = buildParameterImage(model, lsm, new Map()); }
    catch (e) { if (e instanceof ProductError) { lsms[String(lsm)] = { refused: e.code }; continue; } throw e; }
    // The comparator reproduces bare .sort() EXACTLY (it stringifies each entry to "refId,value"
    // and compares those). It is spelled out rather than left implicit because this hash is a
    // stability snapshot: change the order and the hash changes, which would read as "the codec
    // moved" when nothing but the sort did.
    const entries = [...decodeParameterImage(model, lsm, img)];
    entries.sort((a, b) => { const sa = `${a[0]},${a[1]}`, sb = `${b[0]},${b[1]}`; return sa < sb ? -1 : sa > sb ? 1 : 0; });
    const decodeHash = sha(JSON.stringify(entries));
    lsms[String(lsm)] = { build: sha(img.toString("hex")), decodeHash };
  }

  // Absolute-segment (MV-0705) sections. Same default-config stance as `lsms` (empty
  // value map); for a module device buildAbsoluteSegmentTargets re-runs the allocators
  // internally, exactly what the production flash path does when no imported instance
  // set exists, so no resolution logic is added here. Everything is keyed by segment id
  // (order-independent) and emitted in sorted key order (byte-stable golden.json).
  let absolute: AppSnapshot["absolute"];
  let flashPlan: AppSnapshot["flashPlan"];
  if (app.absoluteSegments.length) {
    const maskHash = (m: ReadonlyArray<number | boolean>) => sha(m.map((b) => (b ? "1" : "0")).join(""));
    absolute = {};
    for (const t of [...buildAbsoluteSegmentTargets(app, new Map())].sort((a, b) => a.id.localeCompare(b.id))) {
      absolute[t.id] = { address: t.address, size: t.size, build: sha(t.bytes.toString("hex")), owned: maskHash(t.owned), verify: maskHash(t.verify) };
    }
    const fp = planAbsoluteSegmentFlash(app, new Map(), {});
    const perSegment: NonNullable<AppSnapshot["flashPlan"]>["perSegment"] = {};
    for (const s of [...fp.segments].sort((a, b) => a.id.localeCompare(b.id))) {
      perSegment[s.id] = { address: s.address, size: s.size, ownedBytes: s.ownedBytes, skippedUnowned: s.skippedUnowned };
    }
    flashPlan = { segments: fp.segments.length, perSegment };
  }

  return {
    shape: { types: model.types.size, params: model.params.size, refs: model.refs.size, comObjects: app.comObjects.size, segments: model.segments.length, hasModules: app.hasModules },
    modelHash,
    lsms,
    // Spread keeps the keys entirely absent (not `undefined`) for purely relative
    // fixtures, so golden.json carries no empty placeholder sections.
    ...(absolute && flashPlan ? { absolute, flashPlan } : {}),
  };
}
