import { test, expect } from "bun:test";
import en from "@/locales/en";
import de from "@/locales/de";
import type { AnalyzeResult } from "../api.ts";
import { importGaps } from "./importGaps.ts";

const base: AnalyzeResult = { kind: "knxproj", name: "p", deviceCount: 1, gaCount: 1, snapshotCount: 0, buildingCount: 0, floorCount: 0, roomCount: 0, modifiedAt: null };

test("an analysis without gaps shows no notice", () => {
  expect(importGaps({ ...base, unresolvedLinks: 0, skippedInstallations: 0, baggageUnreadable: false })).toEqual([]);
});

test("each gap with a count becomes one notice, in display order, and the baggage notice comes last", () => {
  const gaps = importGaps({ ...base, devicesWithoutProgram: [{ ia: "1.1.1", name: "" }], skippedInstallations: 2, unassignedDevices: 1, linksWithoutSender: 3, staleModuleLinks: 4, baggageUnreadable: true });
  expect(gaps).toEqual([
    { key: "import.gapNoProgram", count: 1 },
    { key: "import.gapSkippedInstallations", count: 2 },
    { key: "import.gapUnassignedDevices", count: 1 },
    { key: "import.gapLinksWithoutSender", count: 3 },
    { key: "import.gapStaleModuleLinks", count: 4 },
    { key: "import.gapBaggagePreview", count: undefined },
  ]);
});

test("every notice has an English and a German text", () => {
  const all = importGaps({ ...base, devicesWithoutProgram: [{ ia: "1.1.1", name: "" }], unresolvedLinks: 1, malformedDevices: 1, unresolvedSenders: 1, secureDevicesWithoutSerial: 1, skippedInstallations: 1, unassignedDevices: 1, linksWithoutSender: 1, staleModuleLinks: 1, baggageUnreadable: true });
  expect(all).toHaveLength(10);
  for (const { key } of all) {
    const leaf = key.slice("import.".length) as keyof typeof en.import;
    expect(en.import[leaf]).toBeTruthy();
    expect(de.import[leaf]).toBeTruthy();
  }
});
