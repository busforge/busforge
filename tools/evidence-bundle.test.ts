import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { corpusTest } from "./corpus-test.ts";
import { parseEvidenceBundle, parseEvidenceRecord, type EvidenceRecord, type MatrixProduct } from "../packages/product/src/index.ts";
import { generateBundle, renderPage, bundleText, unescapeKnxId, publicRecords, checkPublicRecord, BUNDLE_PATH, PAGE_PATH } from "./evidence-bundle.ts";

corpusTest("the shipped evidence bundle and docs/compatibility.md match the kept records (else: bun run tools/evidence-bundle.ts --write)", () => {
  const bundle = generateBundle();
  expect(readFileSync(BUNDLE_PATH, "utf8") === bundleText(bundle)).toBe(true);
  expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(bundle));
});

// The part of the check above that needs no corpus: the shipped bundle is valid, carries nothing
// that identifies a run or an installation, and docs/compatibility.md renders it.
test("the shipped evidence bundle holds only public records, and docs/compatibility.md renders it", () => {
  const shipped = parseEvidenceBundle(JSON.parse(readFileSync(BUNDLE_PATH, "utf8")));
  expect(shipped.records.length).toBeGreaterThan(0);
  for (const r of shipped.records) checkPublicRecord(r);
  expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(shipped));
});

test("KNX id escapes decode to the order number", () => {
  expect(unescapeKnxId("BE.2D02001.2E02")).toBe("BE-02001.02");
  expect(unescapeKnxId("AMMA.2D04.2F06.2ES")).toBe("AMMA-04/06.S");
});

describe("the shipped records", () => {
  const PRODUCT: MatrixProduct = {
    productRef: "M-0002_H-TEST_P-ORDER.2D1", appProgramId: "M-0002_A-0001-10-0000",
    capabilities: { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: true },
  };
  const NOT = { state: "not-assessed" };
  const record = (id: string, recordedAt: string, results: Record<string, unknown>, extra: Record<string, unknown> = {}): EvidenceRecord => parseEvidenceRecord({
    schema: "busforge.evidence/1", id, recordedAt,
    subject: { manufacturer: "M-0002", productRef: PRODUCT.productRef, appProgramId: PRODUCT.appProgramId, mask: "MV-07B0", firmware: { state: "unknown" } },
    medium: "TP", transport: { kind: "ip-tcp", via: "busforge-bridge" },
    build: { server: { version: "v1.0.0-3-gabc1234", commit: "abc1234" }, runner: { name: "tools/smoke", revision: "abc1234" }, spec: { name: "test-spec", revision: "0123456789ab" } },
    scope: { operation: "fullDownload", channel: "api", configuration: "spec baseline", configurationFingerprint: null },
    origin: { configuredBy: "busforge", reference: "self-written", priorBusforgeWrites: "some" },
    results: { transfer: NOT, reference: NOT, behaviour: NOT, persistence: NOT, ...results },
    supersedes: [], supersedeReason: null,
    source: { kind: "smoke-report", artifact: "tools/smoke/reports/run.json", sha256: "a".repeat(64) },
    ...extra,
  });
  const pass = { state: "pass", method: "read-back" };

  test("only the deciding record of a cell ships, without its run time, build, supersessions or report", () => {
    const old = record("run-1", "2000-01-01T00:00:00.000Z", { transfer: { state: "fail", detail: "no response" } });
    const fixed = record("run-2", "2000-01-02T00:00:00.000Z", { transfer: pass, persistence: pass }, { supersedes: ["run-1"], supersedeReason: "harness fault" });
    const shipped = publicRecords([old, fixed], [PRODUCT]);
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toMatchObject({
      id: "ORDER-1 fullDownload api transfer+persistence", recordedAt: null,
      build: { server: null, runner: { name: "tools/smoke", revision: null }, spec: { name: "test-spec", revision: null } },
      supersedes: [], supersedeReason: null, source: { kind: "smoke-report", artifact: null, sha256: null },
      results: fixed.results,
    });
  });

  test("a reference pass keeps the artifact and hash it was compared with", () => {
    const ref = record("etsdiff-1", "2000-01-01T00:00:00.000Z", { reference: pass }, {
      scope: { operation: "fullDownload", channel: "tool", configuration: "application defaults", configurationFingerprint: null },
      origin: { configuredBy: "ets", reference: "ets-capture", priorBusforgeWrites: "none" },
      source: { kind: "etsdiff", artifact: "captures/device-ets-fulldownload.log", sha256: "b".repeat(64) },
    });
    expect(publicRecords([ref], [PRODUCT])[0].source).toEqual({ kind: "etsdiff", artifact: "captures/device-ets-fulldownload.log", sha256: "b".repeat(64) });
  });

  test("records that need their run times to decide a cell are refused, not shipped", () => {
    // Under different transports a pass and a fail are no conflict: the newest run decides transfer.
    // Without run times the two could no longer be told apart, and the error names the cell.
    const older = record("run-1", "2000-01-01T00:00:00.000Z", { transfer: { state: "fail", detail: "no response" }, behaviour: pass }, { transport: { kind: "ip-udp", via: "direct" } });
    const newer = record("run-2", "2000-01-02T00:00:00.000Z", { transfer: pass });
    expect(() => publicRecords([older, newer], [PRODUCT])).toThrow("would not decide ORDER-1 fullDownload api transfer as the kept records do (it needs the order of run times to decide)");
  });

  test("a conflict is refused by name: its records cannot be ordered without run times", () => {
    const older = record("run-1", "2000-01-01T00:00:00.000Z", { transfer: { state: "fail", detail: "no response" }, behaviour: pass });
    const newer = record("run-2", "2000-01-02T00:00:00.000Z", { transfer: pass });
    expect(() => publicRecords([older, newer], [PRODUCT])).toThrow("ORDER-1 fullDownload api transfer is a conflict");
  });

  test("a shipped record naming an installation's address, a date or a host path is refused", () => {
    const at = (configuration: string) => record("run-1", "2000-01-01T00:00:00.000Z", { transfer: pass }, { scope: { operation: "fullDownload", channel: "api", configuration, configurationFingerprint: null } });
    expect(() => publicRecords([at("device 1.1.7")], [PRODUCT])).toThrow("an individual address");
    expect(() => publicRecords([at("run of 2000-01-01")], [PRODUCT])).toThrow("a date");
    expect(() => publicRecords([at("report in /home/someone/x.json")], [PRODUCT])).toThrow("a host path");
    expect(publicRecords([at("spec baseline (2 configure steps)")], [PRODUCT])).toHaveLength(1);
  });

  test("the firmware's source and the spec's name are checked as well", () => {
    const firmware = { state: "observed", value: "5", source: "read on 2000-01-01" };
    const withFirmware = record("run-1", "2000-01-01T00:00:00.000Z", { transfer: pass }, {
      subject: { manufacturer: "M-0002", productRef: PRODUCT.productRef, appProgramId: PRODUCT.appProgramId, mask: "MV-07B0", firmware },
    });
    expect(() => publicRecords([withFirmware], [PRODUCT])).toThrow("a date");
    const withSpec = record("run-1", "2000-01-01T00:00:00.000Z", { transfer: pass }, {
      build: { server: null, runner: { name: "tools/smoke", revision: null }, spec: { name: "unit 1.1.7", revision: null } },
    });
    expect(() => publicRecords([withSpec], [PRODUCT])).toThrow("an individual address");
  });
});
