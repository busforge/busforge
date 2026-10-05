// Regenerate the golden snapshot for the real catalogue fixtures. Run after an
// intentional, reviewed change to the parser or image projection:
//   BUSFORGE_CORPUS=<corpus dir> bun run packages/product/test/real-catalogue.gen.ts
// It reads the catalogue/*.xml.gz of the private corpus (tools/corpus.ts; no project file
// needed) and writes fixtures/real/golden.json; without the corpus it refuses.
// real-catalogue.test.ts asserts against that golden.
//
// Before overwriting, it prints a HUMAN-READABLE diff of what changed against the
// current golden: shape counts, per-segment sizes, owned/skipped byte counts, and
// which opaque byte/mask hashes flipped. golden.json is a stability lock, not a
// device-correctness proof (correctness lives in the hand vectors of image.test.ts
// and the gitignored hardware byte-matches); the diff makes a regeneration reviewable
// so a parser bug cannot be baked into the golden unnoticed behind a sha hash.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listRealFixtures, readRealFixture, snapshot, REAL_DIR, type AppSnapshot } from "./real-catalogue.snapshot.ts";
import { catalogueDir } from "../../../tools/corpus.ts";

const GOLDEN = join(REAL_DIR, "golden.json");

function readOldGolden(): Record<string, AppSnapshot> {
  try { return JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, AppSnapshot>; }
  catch { return {}; } // first generation: no prior golden
}

// Human-readable per-fixture diff. Numeric fields (counts, sizes, byte totals) are shown
// as `old -> new`; opaque hashes (byte images, masks, decode) are shown as CHANGED so the
// reviewer sees WHICH segment's bytes moved even though the value itself is not legible.
function diffSnapshot(a: AppSnapshot | undefined, b: AppSnapshot): string[] {
  if (!a) return ["  NEW fixture"];
  const out: string[] = [];
  for (const k of Object.keys(b.shape) as (keyof AppSnapshot["shape"])[]) {
    if (a.shape[k] !== b.shape[k]) out.push(`  shape.${k}: ${a.shape[k]} -> ${b.shape[k]}`);
  }
  if (a.modelHash !== b.modelHash) out.push("  modelHash: CHANGED (parser/model projection moved)");
  for (const lsm of new Set([...Object.keys(a.lsms), ...Object.keys(b.lsms)])) {
    const oa = a.lsms[lsm], ob = b.lsms[lsm];
    if (!oa) { out.push(`  lsm ${lsm}: ADDED`); continue; }
    if (!ob) { out.push(`  lsm ${lsm}: REMOVED`); continue; }
    if (oa.build !== ob.build) out.push(`  lsm ${lsm}: image bytes CHANGED`);
    if (oa.decodeHash !== ob.decodeHash) out.push(`  lsm ${lsm}: decoded read-back CHANGED`);
  }
  for (const seg of new Set([...Object.keys(a.absolute ?? {}), ...Object.keys(b.absolute ?? {})])) {
    const oa = a.absolute?.[seg], ob = b.absolute?.[seg];
    if (!oa) { out.push(`  absolute ${seg}: ADDED (size ${ob!.size})`); continue; }
    if (!ob) { out.push(`  absolute ${seg}: REMOVED`); continue; }
    if (oa.size !== ob.size) out.push(`  absolute ${seg}: size ${oa.size} -> ${ob.size}`);
    if (oa.build !== ob.build) out.push(`  absolute ${seg}: default image bytes CHANGED`);
    if (oa.owned !== ob.owned) out.push(`  absolute ${seg}: owned mask CHANGED`);
    if (oa.verify !== ob.verify) out.push(`  absolute ${seg}: verify mask CHANGED`);
  }
  for (const seg of new Set([...Object.keys(a.flashPlan?.perSegment ?? {}), ...Object.keys(b.flashPlan?.perSegment ?? {})])) {
    const oa = a.flashPlan?.perSegment[seg], ob = b.flashPlan?.perSegment[seg];
    if (!oa || !ob) { out.push(`  flashPlan ${seg}: ${!oa ? "ADDED" : "REMOVED"}`); continue; }
    if (oa.ownedBytes !== ob.ownedBytes) out.push(`  flashPlan ${seg}: ownedBytes ${oa.ownedBytes} -> ${ob.ownedBytes}`);
    if (oa.skippedUnowned !== ob.skippedUnowned) out.push(`  flashPlan ${seg}: skippedUnowned ${oa.skippedUnowned} -> ${ob.skippedUnowned}`);
  }
  return out;
}

catalogueDir(); // refuses before anything is read or written when the corpus is absent
const old = readOldGolden();
const golden: Record<string, AppSnapshot> = {};
let changed = 0;
for (const name of listRealFixtures()) {
  const snap = snapshot(readRealFixture(name));
  golden[name] = snap;
  const diff = diffSnapshot(old[name], snap);
  if (diff.length) { changed++; console.log(`~ ${name}`); for (const line of diff) console.log(line); }
}
for (const name of Object.keys(old)) if (!(name in golden)) { changed++; console.log(`- ${name}: REMOVED`); }

writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + "\n");
console.log(`\nwrote golden.json (${Object.keys(golden).length} apps, ${changed ? changed + " changed — review the diff above" : "no changes"})`);
