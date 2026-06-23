import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDaliStore } from "../src/parse.ts";
import { groupLabel, isPopulatedSlot, isPresentEcg } from "../src/model.ts";

// The fixture is a real backup-store recorded from a DALI gateway (UTF-16 XML).
const bytes = readFileSync(join(import.meta.dir, "fixtures", "backup-store.dat"));
const dev = parseDaliStore(bytes);

describe("parseDaliStore (Theben e64)", () => {
  test("decodes the device header from UTF-16 bytes", () => {
    expect(dev.type).toBe("e64");
    expect(dev.individualAddress).toBe("1.2.7");
    expect(dev.project).toBe("house");
    expect(dev.canRestore).toBe(true);
  });

  test("parses the fixed-size DALI tables", () => {
    expect(dev.ecgs).toHaveLength(64);
    expect(dev.devEcgs).toHaveLength(64);
    expect(dev.groups).toHaveLength(16);
    expect(dev.scenes).toHaveLength(16);
  });

  test("reads real fixture names, group links and addresses", () => {
    const e0 = dev.ecgs[0];
    expect(e0).toMatchObject({ index: 0, description: "Bedroom 1", flags: 4, groupIndex: 6 });
    expect(dev.ecgs[1].description).toBe("Kitchen 6");
    // The logical ECG links to a physical slot that carries a real long address.
    const slot = dev.devEcgs.find((d) => d.index === e0.shortAddress)!;
    expect(slot.longAddress).not.toBe("FFFFFF");
    expect(/^[0-9A-Fa-f]{6}$/.test(slot.longAddress)).toBe(true);
  });

  test("group labels resolve and empty slots are detectable", () => {
    expect(groupLabel(dev.groups, dev.ecgs[0].groupIndex)).toBe(dev.groups[6].description);
    expect(dev.devEcgs.filter(isPopulatedSlot).length).toBeGreaterThan(0);
    expect(dev.ecgs.filter(isPresentEcg).length).toBeGreaterThan(0);
  });
});
