import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { corpusPath } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { loadKnxproj } from "../src/knxproj.ts";
import { etsLoadedCompletely } from "../src/parse.ts";

// A real ETS 6 export: the bench Jung 400021SE had a parameter edited after its last download and was
// not downloaded again. ETS dropped its ParametersLoaded flag and kept the other four, so the import
// must not take the project's (edited) values as what the device holds.
corpusDescribe("ETS's load flags in a real export", () => {
  const project = loadKnxproj(readFileSync(corpusPath("captures/bench-ets-project-params-edited-after-download.knxproj")), undefined, "bench");
  const byIa = new Map(project.devices.map((d) => [d.ia, d]));

  test("a device whose parameters were edited after the download is not loaded completely", () => {
    const jung = byIa.get("1.1.204")!;
    expect(jung.etsLoaded).toEqual({ individualAddress: true, mediumConfig: true, application: true, parameters: false, communication: true });
    expect(etsLoadedCompletely(jung)).toBe(false);
  });

  test("the devices downloaded since their last edit are", () => {
    for (const ia of ["1.1.56", "1.1.201", "1.1.203"]) expect(etsLoadedCompletely(byIa.get(ia)!)).toBe(true);
  });
});
