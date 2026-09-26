#!/usr/bin/env bun
// Byte-verify the image build against the real-device ground-truth corpus produced
// by dump-param-memory.ts. This is the honest correctness check: it compares what
// Busforge BUILDS against what the real hardware HOLDS, not against our own frozen
// golden snapshot. Read-only, offline (no bus): it reads the dumped .bin files.
//
//   bun run tools/verify-images.ts [corpus-dir]
//
// Absolute-segment (MV-0705) devices build via buildAbsoluteSegmentTargets; LSM4
// (RelativeSegment) devices via buildRelativeSegmentTarget (the surgical owned-mask
// path the flash uses). Both are owned-scoped. Values come from the project DB.
//
// The match is OWNED-SCOPED: a segment passes when its CONFIG bytes (owned, i.e. the
// bytes we derive from active parameters and would actually flash) equal the device.
// Unowned bytes (manufacturer defaults, erased gaps, inactive-branch parameters) are
// reported as "+Nu" for context but never fail a device: we do not write them, and a
// mismatch there is not config drift (it may even be device-internal runtime state).
// See docs/device-memory-model.md. Also reports the union-parameter count.
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig, buildAbsoluteSegmentTargets, buildRelativeSegmentTarget } from "../packages/product/src/index.ts";
import type { ModuleInstance } from "../packages/product/src/index.ts";
import { appProgramId } from "../packages/project/src/index.ts";

const corpus = process.argv[2] ?? "apps/server/data/readback/parammem";
const manifestPath = join(corpus, "manifest.json");
if (!existsSync(manifestPath)) { console.error(`no manifest at ${manifestPath} (run dump-param-memory.ts first)`); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const db = new Database("apps/server/data/busforge.db", { readonly: true });
const projectId = (db.query("SELECT id FROM projects LIMIT 1").get() as any).id;

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

  // Build the images Busforge would produce for this device. `owned` marks the bytes
  // we positively derive from an active parameter (and would actually flash); null
  // means "treat every byte as owned" (LSM4 ships a full authoritative <Data>, so the
  // whole image is meaningful). For absolute segments, unowned bytes are defaults,
  // gaps, or inactive-branch values we never write, so a mismatch there is not config
  // drift (it may even be device-internal runtime state we must not touch).
  const built = new Map<string, { bytes: Buffer; owned: ReadonlyArray<number | boolean> | null }>(); // keyed by segId tail / "LSM4"
  if (m.mask === "MV-07B0" || m.mask === "MV-0701") {
    // Relative (System B): the SURGICAL target, owned-masked exactly like the flash path
    // (buildRelativeSegmentTarget). This is what makes module devices verify honestly: the
    // ETS-computed "Objektlink" tables and module-displaced channel-variant params are
    // unowned, so a difference there is preserved, never a failure. Module instances come
    // from the project DB (the same source the flash uses).
    try {
      const app = parseAppConfig(row.xml);
      const mi = db.query("SELECT instances FROM device_modules WHERE project_id=? AND device_id=?").get(projectId, dev.instance_id) as any;
      const moduleInstances: ModuleInstance[] = mi ? JSON.parse(mi.instances) : [];
      const target = buildRelativeSegmentTarget(app, values, 4, { moduleInstances });
      if (target) built.set("LSM4", { bytes: target.bytes, owned: target.owned });
    } catch (e) { console.log(`${m.ia} build error: ${(e as Error).message}`); }
  } else {
    try { const app = parseAppConfig(row.xml); for (const t of buildAbsoluteSegmentTargets(app, values)) built.set(t.id.split("_").pop()!, { bytes: t.bytes, owned: t.owned }); }
    catch (e) { console.log(`${m.ia} build error: ${(e as Error).message}`); } // record as NO-BUILD below, do not abort the run
  }

  // Union context (the known residual until union placement).
  const unionParams = [...parseAppConfig(row.xml).params.values()].filter((p) => (p as any).union).length;

  let devMatch = true; const parts: string[] = [];
  for (const seg of m.segments) {
    totalSegments++;
    const key = seg.kind === "relative" ? "LSM4" : seg.segId.split("_").pop();
    const device = readFileSync(join(corpus, seg.file));
    const entry = built.get(key);
    if (!entry) { devMatch = false; parts.push(`${key}:NO-BUILD`); continue; }
    // Owned-scoped comparison. A segment "matches" when the CONFIG bytes (owned, i.e.
    // what we would flash) equal the device. Unowned diffs are surfaced for context but
    // never fail the device: they are defaults/gaps/inactive, possibly runtime state.
    const { bytes: b, owned } = entry;
    let oDiff = 0, uDiff = 0, first = -1;
    const n = Math.min(b.length, device.length);
    for (let i = 0; i < n; i++) {
      if (b[i] === device[i]) continue;
      // Ownership is a bit mask per byte: only a difference in owned bits is a config difference.
      const m = !owned ? 0xff : owned[i] === true ? 0xff : owned[i] === false ? 0 : (owned[i] as number);
      if ((b[i] ^ device[i]) & m) { oDiff++; if (first < 0) first = i; }
      else uDiff++;
    }
    oDiff += Math.abs(b.length - device.length); // a length mismatch is a real (owned) problem
    const note = uDiff ? ` +${uDiff}u` : "";
    if (oDiff === 0) { okSegments++; parts.push(`${key}:OK${note}`); }
    else { devMatch = false; parts.push(`${key}:cfg-diff${oDiff}@${first}${note}`); }
  }
  totalDevices++;
  if (devMatch) okDevices++;
  const line = `${devMatch ? "✓" : "✗"} ${m.ia} ${m.mask} ${appId}  unions=${unionParams}  [${parts.join("  ")}]`;
  console.log(line);
  if (!devMatch) fails.push({ ia: m.ia, mask: m.mask, app: appId, unionParams, parts });
}

console.log(`\nDevices config-matched (owned bytes): ${okDevices}/${totalDevices}   Segments: ${okSegments}/${totalSegments}   ("+Nu" = unowned bytes differ but are never written)`);
const cleanFails = fails.filter((f) => f.unionParams === 0);
if (cleanFails.length) { console.log(`\nUNION-FREE devices that still fail (real defects to chase):`); for (const f of cleanFails) console.log(`  ${f.ia} ${f.app}  [${f.parts.join("  ")}]`); }
else console.log(`\nAll union-free devices byte-match. Remaining failures all have union params (the known residual).`);
process.exit(0);
