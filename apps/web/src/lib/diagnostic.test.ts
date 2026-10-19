import { test, expect, describe } from "bun:test";
import { COLLECT_LIMITS } from "@busforge/product";
import en from "../locales/en.ts";
import de from "../locales/de.ts";
import type { DiagnosticPackage, DiagnosticRecord } from "../api.ts";
import { diagnosticFileName, diagnosticFileText, diagnosticStatus, diagnosticSummary } from "./diagnostic.ts";

const rec = (r: Partial<DiagnosticRecord>): DiagnosticRecord => ({ step: "scan", space: "property", target: {}, source: "device", outcome: "bytes", at: 1, ...r });
const pkg = (over: Partial<DiagnosticPackage> = {}): DiagnosticPackage => ({
  format: "busforge-diagnostic/1", cleaned: { removed: [], notAnonymized: [] }, busforge: { version: "0.0.1", commit: "abc" },
  connection: { kind: "ip", ipTransport: "tcp" }, ia: "1.2.3", mask: "MV-07B0", family: "system-b", secured: false, authorizeLevel: 0, maxApdu: 55,
  plan: null, records: [], limits: [], stop: null, error: null,
  counts: { requests: 0, scanRequests: 0, memoryRequests: 0, memoryBytes: 0, reconnects: 0 },
  startedAt: Date.UTC(2026, 9, 5, 14, 2), finishedAt: Date.UTC(2026, 9, 5, 14, 3, 30), bus: { takenAt: 0, monitorClosedAt: null, releasedAt: 0 },
  ...over,
});
const desc = (pid: number): DiagnosticRecord["description"] => ({ objectIndex: 0, pid, propertyIndex: 0, writable: false, pdt: 4, maxElements: 1, readLevel: 3, writeLevel: 3 });

describe("diagnostic package review", () => {
  test("the file name is English in every language and says device and time", () => {
    expect(diagnosticFileName(pkg())).toBe("busforge-diagnostic-1.2.3-2026-10-05-14-03.json");
  });

  test("the reviewed text is the saved file, the package exactly", () => {
    const p = pkg({ records: [rec({ bytes: "00ff" })] });
    expect(JSON.parse(diagnosticFileText(p))).toEqual(p);
  });

  test("a stop or a limit makes the package incomplete, and says which", () => {
    expect(diagnosticStatus(pkg()).key).toBe("complete");
    expect(diagnosticStatus(pkg({ limits: ["object 3 PID 23: 1024-byte property budget"] })).key).toBe("limited");
    expect(diagnosticStatus(pkg({ stop: { reason: "duration", detail: "x" }, limits: ["y"] })).key).toBe("duration");
    // A device that never answered is told apart from one that stopped answering.
    const stop = { reason: "unresponsive" as const, detail: "x" };
    expect(diagnosticStatus(pkg({ stop, records: [rec({ outcome: "timeout", space: "descriptor" })] })).key).toBe("silent");
    expect(diagnosticStatus(pkg({ stop, records: [rec({ space: "descriptor", bytes: "07b0" })] })).key).toBe("unresponsive");
  });

  test("counts objects, properties, memory bytes and gaps from the records", () => {
    const s = diagnosticSummary(pkg({ records: [
      rec({ space: "property-description", target: { object: 0, propertyIndex: 0 }, description: desc(1) }),
      rec({ space: "property-description", target: { object: 5, propertyIndex: 0 }, description: desc(0) }),
      rec({ space: "property-description", target: { object: 6, propertyIndex: 0 }, description: desc(1) }),
      rec({ target: { object: 0, pid: 11, start: 1, count: 1 }, removed: "serial number, 6 bytes" }),
      rec({ target: { object: 0, pid: 12, start: 0, count: 1 }, bytes: "0001" }),
      rec({ target: { object: 0, pid: 12, start: 1, count: 1 }, bytes: "0085" }),
      rec({ space: "memory", target: { address: 0x4000, length: 10 }, bytes: "00".repeat(10) }),
      rec({ space: "memory-extended", target: { address: 0x10000, length: 48 }, bytes: "00".repeat(48) }),
      rec({ space: "memory", target: { address: 0x4100, length: 1 }, outcome: "refused", raw: "00" }),
      rec({ target: { object: 17, pid: 51 }, outcome: "not-attempted", detail: "security object" }),
    ] }));
    expect(s).toEqual({ objects: 2, properties: 2, memoryBytes: 58, gaps: 2 });
  });

  test("the dialog names the bounds the collector has, in both languages", () => {
    const minutes = String(COLLECT_LIMITS.durationMs / 60_000);
    const failures = String(COLLECT_LIMITS.failuresInARow);
    for (const m of [en, de]) {
      expect(m.diagnostic.consent.limits).toContain(`${minutes} `);
      expect(m.diagnostic.consent.limits).toContain(`${failures} `);
      expect(m.diagnostic.consent.bus).toContain(`${minutes} `);
      expect(m.diagnostic.progress.counters).toContain(`${minutes.padStart(2, "0")}:00`);
      // No byte or request counts in the consent.
      expect(m.diagnostic.consent.limits).not.toMatch(/KB|bytes|Bytes|request|Anfrage/);
      // The review names no byte or request figures of the bounds either.
      expect(JSON.stringify(m.diagnostic.preview.status)).not.toMatch(/\{\{|KB|MiB/);
      // Never called an export.
      expect(JSON.stringify(m.diagnostic)).not.toMatch(/export/i);
    }
  });
});
