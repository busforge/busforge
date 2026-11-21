import { test, expect, describe } from "bun:test";
import { MASKS, maskInfo, progModeByProperty, verifyModeDeclared, type MaskInfo } from "../src/masks.ts";
import { withVerifyMode } from "../src/deviceflash.ts";
import type { LoadPlan } from "@busforge/knx";

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
  // The exact masks present in the real production projects of the corpus, with the family
  // and memory model each MUST resolve to. MV-0012 is the load-bearing case: it has an
  // AbsoluteSegment and so used to be misrouted into the System 7 (absolute) path, but it
  // is a System 1 / BCU1 device and must resolve to bcu1 (-> the System 1 profile), not absolute.
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

describe("programming mode over a connection", () => {
  test("System B and the property-mapped System 7 masks switch it by PID 54; memory-held and other families do not", () => {
    for (const m of ["MV-07B0", "MV-0705", "MV-57B0", "MV-2705", "07b0"]) expect(progModeByProperty(m)).toBe(true);
    for (const m of ["MV-0701", "MV-0700", "MV-0012", "MV-0010", "MV-0020", "MV-091A", "MV-FFFF", "garbage"]) expect(progModeByProperty(m)).toBe(false);
  });
});

describe("verify mode", () => {
  // The masks whose HawkConfigurationData in the ETS master data carries <Feature Name="VerifyMode" Value="1">.
  test("the masks the master data declares it on, and no other", () => {
    const declared = ["MV-0020", "MV-0021", "MV-0025", "MV-0705", "MV-07B0", "MV-0912", "MV-091A", "MV-1310", "MV-17B0", "MV-2705", "MV-27B0", "MV-2920", "MV-5705", "MV-57B0"];
    expect(MASKS.filter((m) => m.verifyMode).map((m) => m.mask)).toEqual(declared);
    for (const m of ["MV-0700", "MV-0701", "MV-0012", "MV-FFFF", "garbage"]) expect(verifyModeDeclared(m)).toBe(false);
  });

  test("a download switches it on right before its first memory write where the mask declares it", () => {
    const plan: LoadPlan = [
      { op: "unload", lsm: 1 }, { op: "load", lsm: 1 },
      { op: "writeMem", address: 0x4000, bytes: Buffer.from([1]) }, { op: "writeMem", address: 0x4001, bytes: Buffer.from([2]) },
      { op: "loadCompleted", lsm: 1 }, { op: "restart" },
    ];
    expect(withVerifyMode(plan, "MV-0705").map((st) => st.op)).toEqual(["unload", "load", "verifyMode", "writeMem", "writeMem", "loadCompleted", "restart"]);
    expect(withVerifyMode(plan, "MV-0701")).toEqual(plan);
    expect(withVerifyMode([{ op: "restart" }], "MV-07B0")).toEqual([{ op: "restart" }]);
  });
});
