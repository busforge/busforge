import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parseDaliStore } from "../src/parse.ts";
import { groupLabel, isPopulatedSlot, isPresentEcg } from "../src/model.ts";
import { corpusPath } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The fixture is a real backup-store recorded from an e64 (UTF-16 XML). It and the values read
// from it belong to that installation, so both come from the private corpus (tools/corpus.ts).
interface Expected {
  individualAddress: string;
  project: string;
  canRestore: boolean;
  ecg0: { index: number; description: string; flags: number; groupIndex: number };
  ecg1Description: string;
}

corpusDescribe("parseDaliStore (Theben e64)", () => {
  const bytes = readFileSync(corpusPath("dca-theben-dali-e64/backup-store.dat"));
  const want = JSON.parse(readFileSync(corpusPath("dca-theben-dali-e64/backup-store.expected.json"), "utf8")) as Expected;
  // A value missing from the corpus file would quietly weaken an assertion; refuse it instead.
  const shape = (o: object, keys: string[]) => keys.every((k) => (o as Record<string, unknown>)[k] !== undefined);
  if (!shape(want, ["individualAddress", "project", "canRestore", "ecg0", "ecg1Description"]) || !shape(want.ecg0, ["index", "description", "flags", "groupIndex"])) {
    throw new Error("backup-store.expected.json lacks an expected value");
  }
  const dev = parseDaliStore(bytes);

  test("decodes the device header from UTF-16 bytes", () => {
    expect(dev.type).toBe("e64");
    expect(dev.individualAddress).toBe(want.individualAddress);
    expect(dev.project).toBe(want.project);
    expect(dev.canRestore).toBe(want.canRestore);
  });

  test("parses the fixed-size DALI tables", () => {
    expect(dev.ecgs).toHaveLength(64);
    expect(dev.devEcgs).toHaveLength(64);
    expect(dev.groups).toHaveLength(16);
    expect(dev.scenes).toHaveLength(16);
  });

  test("reads real fixture names, group links and addresses", () => {
    const e0 = dev.ecgs[0];
    expect(e0).toMatchObject(want.ecg0);
    expect(dev.ecgs[1].description).toBe(want.ecg1Description);
    // The logical ECG links to a physical slot that carries a real long address.
    const slot = dev.devEcgs.find((d) => d.index === e0.shortAddress)!;
    expect(slot.longAddress).not.toBe("FFFFFF");
    expect(/^[0-9A-Fa-f]{6}$/.test(slot.longAddress)).toBe(true);
  });

  test("group labels resolve and empty slots are detectable", () => {
    expect(groupLabel(dev.groups, dev.ecgs[0].groupIndex)).toBe(dev.groups[want.ecg0.groupIndex].description);
    expect(dev.devEcgs.filter(isPopulatedSlot).length).toBeGreaterThan(0);
    expect(dev.ecgs.filter(isPresentEcg).length).toBeGreaterThan(0);
  });
});
