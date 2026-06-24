import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { parseAppConfig } from "../src/appconfig.ts";
import { parseApplication } from "../src/application.ts";
import { buildParameterImage, decodeParameterImage } from "../src/image.ts";

// Golden-master snapshot of a manufacturer ApplicationProgram, used to pin the
// parse + image projection against real catalogue data (one device per
// manufacturer, gzipped under fixtures/real/, no personal data). The snapshot is a
// content hash of the byte-relevant image model plus, where a default image builds,
// its byte hash and the decoded read-back hash. A regression in the parser or the
// projection changes a hash and fails real-catalogue.test.ts.

export const REAL_DIR = join(import.meta.dir, "fixtures", "real");
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// The image-model bases a healthy projection can produce (Time is folded into Other).
export const IMAGE_BASES = new Set(["Value", "Number", "Float", "Text", "Other"]);
// The config-layer bases the parser can produce.
export const CONFIG_BASES = new Set(["Value", "BinaryValue", "Number", "Float", "Color", "Text", "Other"]);

export interface AppSnapshot {
  shape: { types: number; params: number; refs: number; comObjects: number; segments: number; hasModules: boolean };
  modelHash: string;
  lsms: Record<string, { build: string; decodeHash: string }>;
}

export function listRealFixtures(): string[] {
  return readdirSync(REAL_DIR).filter((f) => f.endsWith(".xml.gz")).sort();
}

export function readRealFixture(name: string): string {
  return gunzipSync(readFileSync(join(REAL_DIR, name))).toString("utf8");
}

export function snapshot(xml: string): AppSnapshot {
  const app = parseAppConfig(xml);
  const model = parseApplication(xml);
  // Canonical, order-independent serialization of the byte-relevant model.
  const types = [...model.types.values()].map((t) => `${t.id}|${t.base}|${t.sizeInBit}|${t.signed}`).sort();
  const params = [...model.params.values()].map((p) => `${p.id}|${p.typeId}|${p.offset ?? ""}|${p.bitOffset}|${p.value ?? ""}|${p.codeSegment ?? ""}`).sort();
  const refs = [...model.refs.values()].map((r) => `${r.id}|${r.paramId}|${r.value ?? ""}`).sort();
  const segs = model.segments.map((s) => `${s.id}|${s.lsm}|${s.size}|${sha(s.data.toString("base64"))}`).sort();
  const modelHash = sha(JSON.stringify({ types, params, refs, segs }));

  // Build a default image per segment and pin its bytes + read-back. A throw here is
  // a real defect (the codec cannot place a real parameter), so it is NOT swallowed:
  // the test fails loudly rather than recording the failure as the expected state.
  const lsms: AppSnapshot["lsms"] = {};
  for (const lsm of [...new Set(model.segments.map((s) => s.lsm))].sort((a, b) => a - b)) {
    const img = buildParameterImage(model, lsm, new Map());
    const decodeHash = sha(JSON.stringify([...decodeParameterImage(model, lsm, img)].sort()));
    lsms[String(lsm)] = { build: sha(img.toString("hex")), decodeHash };
  }
  return { shape: { types: model.types.size, params: model.params.size, refs: model.refs.size, comObjects: app.comObjects.size, segments: model.segments.length, hasModules: app.hasModules }, modelHash, lsms };
}
