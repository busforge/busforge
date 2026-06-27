import { test, expect, describe } from "bun:test";
import { MASKS, maskInfo, type MaskInfo } from "../src/masks.ts";

describe("mask registry", () => {
  test("every row is internally consistent (mask string matches hex)", () => {
    for (const info of MASKS) {
      expect(info.mask).toBe(`MV-${info.hex.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  });

  test("masks are unique", () => {
    const seen = new Set(MASKS.map((m) => m.mask));
    expect(seen.size).toBe(MASKS.length);
  });

  test("only application-bearing families carry a real memory model", () => {
    const appModels = new Set<MaskInfo["memoryModel"]>(["absolute", "relative", "bcu1", "bcu2", "system300"]);
    for (const info of MASKS) {
      const isAppFamily = ["system-1", "system-2", "system-300", "system-7", "system-b"].includes(info.family);
      expect(appModels.has(info.memoryModel)).toBe(isAppFamily);
    }
  });

  test("the System 7 and System B families span every medium variant", () => {
    const sys7 = MASKS.filter((m) => m.family === "system-7");
    const sysB = MASKS.filter((m) => m.family === "system-b");
    expect(sys7.every((m) => m.memoryModel === "absolute")).toBe(true);
    expect(sysB.every((m) => m.memoryModel === "relative")).toBe(true);
    // System B exists on all four media (TP 07B0, PL 17B0, RF 27B0, IP 57B0).
    expect(new Set(sysB.map((m) => m.medium))).toEqual(new Set(["TP", "PL", "RF", "IP"]));
  });
});

describe("maskInfo lookup", () => {
  // The exact masks present in the real house production projects, with the family
  // and memory model each MUST resolve to. MV-0012 is the load-bearing case: it has an
  // AbsoluteSegment and so used to be misrouted into the System 7 (absolute) path, but it
  // is a System 1 / BCU1 device and must resolve to bcu1 (-> unsupported), not absolute.
  const PROJECT_MASKS: Array<[string, MaskInfo["family"], MaskInfo["memoryModel"]]> = [
    ["MV-07B0", "system-b", "relative"],
    ["MV-0705", "system-7", "absolute"],
    ["MV-0701", "system-7", "absolute"],
    ["MV-0012", "system-1", "bcu1"],
  ];

  test.each(PROJECT_MASKS)("%s -> %s / %s", (mask, family, memoryModel) => {
    const info = maskInfo(mask);
    expect(info.family).toBe(family);
    expect(info.memoryModel).toBe(memoryModel);
  });

  test("accepts unnormalised forms", () => {
    expect(maskInfo("0705").mask).toBe("MV-0705");
    expect(maskInfo("mv-705").mask).toBe("MV-0705");
    expect(maskInfo("MV-07B0").hex).toBe(0x07b0);
  });

  test("an unrecognised but parseable mask resolves to unknown / no model (honest, no crash)", () => {
    const info = maskInfo("MV-9999");
    expect(info.family).toBe("unknown");
    expect(info.memoryModel).toBe("none");
    expect(info.hex).toBe(0x9999);
  });

  test("an unparseable mask does not throw", () => {
    expect(() => maskInfo("")).not.toThrow();
    expect(maskInfo("garbage").family).toBe("unknown");
  });
});
