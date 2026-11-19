import type { AnalyzeResult } from "../api.ts";

// What an analysed project leaves out, as import notices with their counts, in display order.
export function importGaps(a: AnalyzeResult) {
  const counts = [
    ["import.gapNoProgram", a.devicesWithoutProgram?.length],
    ["import.gapUnresolvedLinks", a.unresolvedLinks],
    ["import.gapMalformedDevices", a.malformedDevices],
    ["import.gapUnresolvedSenders", a.unresolvedSenders],
    ["import.gapSecureWithoutSerial", a.secureDevicesWithoutSerial],
    ["import.gapSecretsNotImported", a.secretsNotImported],
    ["import.gapSkippedInstallations", a.skippedInstallations],
    ["import.gapUnassignedDevices", a.unassignedDevices],
    ["import.gapLinksWithoutSender", a.linksWithoutSender],
    ["import.gapStaleModuleLinks", a.staleModuleLinks],
  ] as const;
  return [
    ...counts.filter(([, n]) => (n ?? 0) > 0).map(([key, count]) => ({ key, count })),
    ...(a.baggageUnreadable ? [{ key: "import.gapBaggagePreview" as const, count: undefined }] : []),
  ];
}
