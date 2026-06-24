#!/usr/bin/env bun
// Byte-verify the image build against the real-device ground-truth corpus produced
// by dump-param-memory.ts. This is the honest correctness check: it compares what
// Busforge BUILDS against what the real hardware HOLDS, not against our own frozen
// golden snapshot. Read-only, offline (no bus): it reads the dumped .bin files.
//
//   bun run tools/verify-images.ts [corpus-dir]
//
// Absolute-segment (MV-0705) devices build via buildAbsoluteSegmentImages; LSM4
// (RelativeSegment) devices via buildParameterImage. Values come from the project
// DB. Reports per-device byte-match and, for context, the union-parameter count
// (the known residual until union placement lands).
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig, parseApplication, buildParameterImage, buildAbsoluteSegmentImages } from "../packages/product/src/index.ts";
import { appProgramId } from "../packages/project/src/index.ts";

const corpus = process.argv[2] ?? "apps/server/data/readback/parammem";
const manifestPath = join(corpus, "manifest.json");
if (!existsSync(manifestPath)) { console.error(`no manifest at ${manifestPath} (run dump-param-memory.ts first)`); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const db = new Database("apps/server/data/busforge.db", { readonly: true });
const projectId = (db.query("SELECT id FROM projects LIMIT 1").get() as any).id;

const cmp = (a: Buffer, b: Buffer) => { let diff = 0, first = -1; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) { diff++; if (first < 0) first = i; } return { diff: diff + Math.abs(a.length - b.length), first, match: a.equals(b) }; };

let okDevices = 0, totalDevices = 0, okSegments = 0, totalSegments = 0;
const fails: any[] = [];

for (const m of manifest.devices) {
  if (!m.segments?.length) continue;
  const dev = db.query("SELECT app_ref, instance_id FROM devices WHERE ia=? AND project_id=?").get(m.ia, projectId) as any;
  if (!dev) continue;
  const appId = appProgramId(dev.app_ref);
  const row = db.query("SELECT xml FROM app_programs WHERE id=?").get(appId) as any;
  if (!row) continue;
  const values = new Map<string, string>();
  for (const r of db.query("SELECT param_ref_id, value FROM device_parameters WHERE project_id=? AND device_id=?").all(projectId, dev.instance_id) as any[]) values.set(r.param_ref_id, r.value);

  // Build the images Busforge would produce for this device.
  const built = new Map<string, Buffer>(); // keyed by segId tail / "LSM4"
  if (m.mask === "MV-07B0" || m.mask === "MV-0701") {
    const model = parseApplication(row.xml);
    for (const lsm of [...new Set(model.segments.map((s) => s.lsm))]) {
      if (model.segments.find((s) => s.lsm === lsm)) { try { built.set("LSM4", buildParameterImage(model, lsm, values)); } catch {} }
    }
  } else {
    try { const app = parseAppConfig(row.xml); for (const img of buildAbsoluteSegmentImages(app, values)) built.set(img.id.split("_").pop()!, img.bytes); }
    catch (e) { console.log(`${m.ia} build error: ${(e as Error).message}`); } // record as NO-BUILD below, do not abort the run
  }

  // Union context (the known residual until union placement).
  const unionParams = [...parseAppConfig(row.xml).params.values()].filter((p) => (p as any).union).length;

  let devMatch = true; const parts: string[] = [];
  for (const seg of m.segments) {
    totalSegments++;
    const key = seg.kind === "relative" ? "LSM4" : seg.segId.split("_").pop();
    const device = readFileSync(join(corpus, seg.file));
    const b = built.get(key);
    if (!b) { devMatch = false; parts.push(`${key}:NO-BUILD`); continue; }
    const r = cmp(b, device);
    if (r.match) { okSegments++; parts.push(`${key}:OK`); }
    else { devMatch = false; parts.push(`${key}:diff${r.diff}@${r.first}`); }
  }
  totalDevices++;
  if (devMatch) okDevices++;
  const line = `${devMatch ? "✓" : "✗"} ${m.ia} ${m.mask} ${appId}  unions=${unionParams}  [${parts.join("  ")}]`;
  console.log(line);
  if (!devMatch) fails.push({ ia: m.ia, mask: m.mask, app: appId, unionParams, parts });
}

console.log(`\nDevices fully byte-matched: ${okDevices}/${totalDevices}   Segments: ${okSegments}/${totalSegments}`);
const cleanFails = fails.filter((f) => f.unionParams === 0);
if (cleanFails.length) { console.log(`\nUNION-FREE devices that still fail (real defects to chase):`); for (const f of cleanFails) console.log(`  ${f.ia} ${f.app}  [${f.parts.join("  ")}]`); }
else console.log(`\nAll union-free devices byte-match. Remaining failures all have union params (the known residual).`);
process.exit(0);
