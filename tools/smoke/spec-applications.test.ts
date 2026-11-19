// A smoke spec names the application its device runs (device.appProgramId), as the server's catalogue and
// the project's device list name it. It is typed into the spec, so this pins it against the private corpus:
// the catalogue holds that program, and every corpus product that is the spec's product runs it.
import { expect } from "bun:test";
import { extractCatalogProducts } from "../../packages/project/src/index.ts";
import { catalogueXml } from "../corpus.ts";
import { bytesOf, corpusArchives, extensionOf } from "../corpus-archives.ts";
import { corpusTest } from "../corpus-test.ts";
import { SPECS } from "./specs/index.ts";

corpusTest("every smoke spec names an application the corpus catalogue holds, and every corpus product of the spec runs it", () => {
  const missing = SPECS.filter((s) => { try { catalogueXml(`${s.device.appProgramId}.xml.gz`); return false; } catch { return true; } });
  expect(missing.map((s) => `${s.id}: ${s.device.appProgramId}`)).toEqual([]);

  const differing: string[] = [];
  const confirmed = new Set<string>();
  for (const file of corpusArchives().filter((f) => extensionOf(f) !== "busforge")) {
    for (const p of extractCatalogProducts(bytesOf(file))) {
      for (const s of SPECS) {
        if (p.appRef !== s.device.appRef || p.productRef !== s.device.productRef) continue;
        if (p.appProgramId === s.device.appProgramId) confirmed.add(s.id);
        else differing.push(`${s.id}: ${file} runs ${p.appProgramId || "none"}, the spec names ${s.device.appProgramId}`);
      }
    }
  }
  expect(differing).toEqual([]);
  // The two OpenKNX room-controller specs name a product no corpus archive lists; the catalogue check above covers them.
  expect(SPECS.filter((s) => !confirmed.has(s.id)).map((s) => s.id).sort()).toEqual(["openknx-raumcontroller", "openknx-raumcontroller-in-service"]);
});
