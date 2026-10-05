import type { DiagnosticPackage } from "../api.ts";

// What the review of a diagnostic package shows about it. The file itself is the package as the
// server answered it, the same text in the review and in the saved file.

export const diagnosticFileText = (pkg: DiagnosticPackage) => JSON.stringify(pkg, null, 1);

// busforge-diagnostic-<ia>-<yyyy-mm-dd-hh-mm>.json, in UTC, the same in every language.
export const diagnosticFileName = (pkg: DiagnosticPackage) =>
  `busforge-diagnostic-${pkg.ia}-${new Date(pkg.finishedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;

// "silent": stopped as unresponsive without a single answer (no device at the address, or one that
// is not on the bus), told apart from a device that stopped answering midway.
export type DiagnosticStatusKey = "complete" | "limited" | "silent" | NonNullable<DiagnosticPackage["stop"]>["reason"];
export function diagnosticStatus(pkg: DiagnosticPackage): { key: DiagnosticStatusKey } {
  if (pkg.stop?.reason === "unresponsive" && !pkg.records.some((r) => r.outcome === "bytes")) return { key: "silent" };
  if (pkg.stop) return { key: pkg.stop.reason };
  if (pkg.limits.length > 0) return { key: "limited" };
  return { key: "complete" };
}

export function diagnosticSummary(pkg: DiagnosticPackage): { objects: number; properties: number; memoryBytes: number; gaps: number } {
  const objects = new Set<number>();
  const properties = new Set<string>();
  let memoryBytes = 0;
  let gaps = 0;
  for (const r of pkg.records) {
    if (r.outcome !== "bytes") { gaps++; continue; }
    if (r.space === "property-description" && r.target.propertyIndex === 0 && r.description && r.description.pid !== 0) objects.add(Number(r.target.object));
    if (r.space === "property") properties.add(`${r.target.object}:${r.target.pid}`);
    if (r.space === "memory" || r.space === "memory-extended") memoryBytes += Number(r.target.length);
  }
  return { objects: objects.size, properties: properties.size, memoryBytes, gaps };
}
