// Regenerate the golden snapshot for the real catalogue fixtures. Run after an
// intentional, reviewed change to the parser or image projection:
//   bun run packages/product/test/real-catalogue.gen.ts
// It reads the committed fixtures/real/*.xml.gz (no project file needed) and writes
// fixtures/real/golden.json. real-catalogue.test.ts asserts against that golden.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listRealFixtures, readRealFixture, snapshot, REAL_DIR, type AppSnapshot } from "./real-catalogue.snapshot.ts";

const golden: Record<string, AppSnapshot> = {};
for (const name of listRealFixtures()) {
  golden[name] = snapshot(readRealFixture(name));
  console.log(`snapshotted ${name}`);
}
writeFileSync(join(REAL_DIR, "golden.json"), JSON.stringify(golden, null, 2) + "\n");
console.log(`wrote golden.json (${Object.keys(golden).length} apps)`);
