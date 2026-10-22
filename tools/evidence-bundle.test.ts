import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { corpusTest } from "./corpus-test.ts";
import { parseEvidenceBundle, parseEvidenceRecord, type EvidenceRecord, type MatrixProduct } from "../packages/product/src/index.ts";
import { generateBundle, renderPage, bundleText, unescapeKnxId, publicRecords, checkPublicRecord, groupAddresses, BUNDLE_PATH, PAGE_PATH } from "./evidence-bundle.ts";

corpusTest("the shipped evidence bundle and docs/compatibility.md match the kept records (else: bun run tools/evidence-bundle.ts --write)", () => {
  const bundle = generateBundle();
  expect(readFileSync(BUNDLE_PATH, "utf8") === bundleText(bundle)).toBe(true);
  expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(bundle));
}, 30_000); // reads and checks every kept record and its application: 3.1-3.5 s in a full check, 9.9 s in one at load 52

// The part of the check above that needs no corpus: the shipped bundle is valid, carries nothing
// that identifies a run or an installation, and docs/compatibility.md renders it.
test("the shipped evidence bundle holds only public records, and docs/compatibility.md renders it", () => {
  const shipped = parseEvidenceBundle(JSON.parse(readFileSync(BUNDLE_PATH, "utf8")));
  expect(shipped.records.length).toBeGreaterThan(0);
  for (const r of shipped.records) checkPublicRecord(r);
  expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(shipped));
});

test("Products that share an order number get distinct headings on the page", () => {
  const caps = { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: true };
  const page = renderPage({ schema: "busforge.evidence-bundle/1", records: [], products: [
    { productRef: "M-0002_H-1_P-ORDER.2D1", appProgramId: "M-0002_A-0001-10-0000", capabilities: caps },
    { productRef: "M-0002_H-1-O0072_P-ORDER.2D1", appProgramId: "M-0002_A-0002-10-0000", capabilities: caps },
    { productRef: "M-0002_H-2_P-ORDER.2D1", appProgramId: "M-0002_A-0002-10-0000", capabilities: caps },
    { productRef: "M-0002_H-1_P-ORDER.2D2", appProgramId: "M-0002_A-0001-10-0000", capabilities: caps },
  ] });
  expect(page.split("\n").filter((l) => l.startsWith("## "))).toEqual([
    "## M-0002 ORDER-1, application program M-0002_A-0001-10-0000",
    "## M-0002 ORDER-1, application program M-0002_A-0002-10-0000, hardware M-0002_H-1-O0072",
    "## M-0002 ORDER-1, application program M-0002_A-0002-10-0000, hardware M-0002_H-2",
    "## M-0002 ORDER-2",
  ]);
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

  // A group address an installation uses must not ship in any form the records write one in. Only a run
  // of a bench smoke spec may name that spec's addresses, and an etsdiff comparison the bench captures' 3/3/x.
  describe("group addresses", () => {
    const run = (spec: string | null, configuration: string, detail = "ok", kind = "smoke-report") => record("run-1", "2000-01-01T00:00:00.000Z", { transfer: { state: "pass", method: "read-back", detail } }, {
      build: { server: null, runner: { name: "tools/smoke", revision: null }, spec: spec === null ? null : { name: spec, revision: null } },
      scope: { operation: "fullDownload", channel: "api", configuration, configurationFingerprint: null },
      source: { kind, artifact: null, sha256: null },
    });
    const ships = (r: EvidenceRecord) => { checkPublicRecord({ ...r, recordedAt: null, build: { ...r.build, server: null } }); return true; };

    test("found three-level, and as a raw value where the text says it is one", () => {
      expect(groupAddresses("linked object 3 → 1/1/1; 31/7/255 and 0/0/1")).toEqual([0x0901, 0xffff, 0x0001]);
      expect(groupAddresses("links #2->0x1b06, #6->0x0a01")).toEqual([0x1b06, 0x0a01]);
      expect(groupAddresses("GA 0x0a01, group address 2561, (project 6913, differs)")).toEqual([0x0a01, 2561, 6913]);
      expect(groupAddresses("links #2->0x1b01+0x0a01, #3->0x0a02; group addresses 0x0a03, 0x0a04")).toEqual([0x1b01, 0x0a01, 0x0a02, 0x0a03, 0x0a04]);
      expect(groupAddresses("no response on 1/2/3. Then 1/2/4-1/2/5")).toEqual([0x0a03, 0x0a04, 0x0a05]);
    });
    test("not found in what only looks like one", () => {
      for (const t of [
        "229 bytes compared (L4 parameter segment 0/229, L3 com-object table 0/2656)", "AMMA-04/06.S fullDownload",
        "links #11->1 group address, #13->1 group address", "the test address answered 0x0258", "32/0/1 and 1/8/1 and 1/1/256",
        "GA flash, 3 B", "did not resolve to a group address",
      ]) expect([t, groupAddresses(t)]).toEqual([t, []]);
    });
    test("a record of a unit in service, or of any other source, ships none", () => {
      expect(() => ships(run("auro-m0081-in-service", "spec baseline", "1/6/4 answered 0x00"))).toThrow("names group address 1/6/4");
      expect(() => ships(run(null, "links #2->0x0a01", "ok", "readback-tool"))).toThrow("names group address 1/2/1");
      expect(() => ships(run("test-spec", "spec baseline", "the device does not carry it (project 6913, differs from device: true)"))).toThrow("names group address 3/3/1");
    });
    test("an etsdiff comparison names only the bench captures' 3/3/x", () => {
      expect(ships(run(null, "application defaults, links #0->0x1b01, #6->0x1b05", "ok", "etsdiff"))).toBe(true);
      expect(() => ships(run(null, "application defaults, links #2->0x0a01", "ok", "etsdiff"))).toThrow("names group address 1/2/1");
    });
    test("a bench spec's run names the addresses that spec names or its fuzz range generates, no others", () => {
      expect(ships(run("gvs-amma", "spec baseline", "3 transitions tracked on 1/2/3→1/2/9"))).toBe(true);
      expect(ships(run("jung-400021se-secure", "behaviour securedOutput: K1 answers a secured read on 0/0/1", "0/0/1 answered 0x00"))).toBe(true);
      expect(() => ships(run("gvs-amma", "spec baseline", "linked object 2 → 1/6/2"))).toThrow("names group address 1/6/2");
      expect(() => ships(run("jung-400021se", "spec baseline", "0/0/1 answered 0x00"))).toThrow("names group address 0/0/1");
      expect(() => ships(run("gvs-amma", "spec baseline", "the device does not carry it (project 3329, differs from device: true)"))).toThrow("names group address 1/5/1");
      expect(() => ships(run("gvs-amma", "spec baseline", "links #2->0x0a01+0x0d01"))).toThrow("names group address 1/5/1");
      expect(ships(run("gvs-amma", "spec baseline", "the device does not carry it (project 2561, differs from device: true)"))).toBe(true);
    });
    test("a record of another source that names a bench spec gets none of its addresses", () => {
      expect(() => ships(run("gvs-amma", "spec baseline", "1/2/1 answered 0x00", "readback-tool"))).toThrow("names group address 1/2/1");
    });
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
