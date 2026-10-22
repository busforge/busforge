import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvidenceRecord, type EvidenceRecord, type AxisState } from "../src/evidence.ts";
import { buildMatrix, hardwareOf, checkEvidenceSet, parseEvidenceBundle, MATRIX_OPERATIONS, EVIDENCE_BUNDLE_SCHEMA, type MatrixProduct } from "../src/compatibility.ts";
import type { DeviceCapabilities } from "../src/config.ts";

const BUNDLE = join(import.meta.dir, "..", "..", "..", "apps", "server", "src", "evidence-bundle.json");
const ALL: DeviceCapabilities = { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: true };

const HW_A = "M-0085_H-AM22AA-16";
const P1 = `${HW_A}_P-AMMA.2D04`; // tested
const P2 = `${HW_A}_P-AMMA.2D06`; // same Hardware, other order number
const P3 = "M-0085_H-OTHER-1_P-X"; // other Hardware
const APP = "M-0085_A-0072-30-69AA";
const APP_NEXT = "M-0085_A-0072-31-69AB";

let seq = 0;
function rec(o: { product?: string; app?: string; op?: string; channel?: "api" | "ui" | "tool"; transfer?: AxisState; at?: string; firmware?: string; supersedes?: string[]; id?: string }): EvidenceRecord {
  const id = o.id ?? `r${++seq}`;
  const transfer = o.transfer ?? "pass";
  return parseEvidenceRecord({
    schema: "busforge.evidence/1", id, recordedAt: o.at ?? "2000-01-02T10:00:00.000Z",
    subject: { manufacturer: "M-0085", productRef: o.product ?? P1, appProgramId: o.app ?? APP, mask: "MV-07B0",
      firmware: o.firmware ? { state: "observed", value: o.firmware, source: "PID 9" } : { state: "unknown" } },
    medium: "TP", transport: { kind: "ip-tcp", via: "direct" },
    build: { server: { version: "v1", commit: "abc" }, runner: null, spec: null },
    scope: { operation: o.op ?? "flashParams", channel: o.channel ?? "api", configuration: "test", configurationFingerprint: null },
    origin: { configuredBy: "busforge", reference: "self-written", priorBusforgeWrites: "some" },
    results: {
      transfer: transfer === "pass" ? { state: "pass", method: "read-back" } : { state: transfer },
      reference: { state: "not-assessed" }, behaviour: { state: "not-assessed" }, persistence: { state: "not-assessed" },
    },
    supersedes: o.supersedes ?? [], supersedeReason: o.supersedes?.length ? "harness fault" : null,
    source: { kind: "manual", artifact: null, sha256: null },
  });
}
const both = (o: Parameters<typeof rec>[0] = {}) => [rec({ ...o, channel: "api" }), rec({ ...o, channel: "ui" })];
const product = (productRef: string, appProgramId = APP, capabilities = ALL): MatrixProduct => ({ productRef, appProgramId, capabilities });
const op = (records: EvidenceRecord[], p: MatrixProduct, operation: keyof DeviceCapabilities = "flashParams") =>
  buildMatrix(records, [p])[0].operations[operation];

describe("buildMatrix", () => {
  test("an operation is tested only with a transfer pass in both the api and the ui channel", () => {
    expect(op(both(), product(P1)).state).toBe("tested");
    const apiOnly = op([rec({ channel: "api" })], product(P1));
    expect(apiOnly.state).toBe("eligible");
    expect(apiOnly.cells.api?.transfer.state).toBe("pass"); // its own evidence stays visible
  });

  test("a Product without evidence is eligible where capabilities allow, refused where not", () => {
    const row = buildMatrix([], [product(P1, APP, { ...ALL, structuralFlash: false })])[0];
    expect(row.operations.flashParams.state).toBe("eligible");
    expect(row.operations.structuralFlash.state).toBe("refused");
    expect(row.hardwareRef).toBe(HW_A);
  });

  test("same Hardware and application version tested elsewhere is derived, never tested", () => {
    const v = buildMatrix(both(), [product(P2), product(P1)])[0].operations.flashParams;
    expect(v.state).toBe("derived");
    expect(v.derivedFrom).toBe(P1);
    expect(v.cells).toEqual({});
  });

  test("the same application on other Hardware is only a hint", () => {
    const v = buildMatrix(both(), [product(P3), product(P1)])[0].operations.flashParams;
    expect(v.state).toBe("eligible");
    expect(v.sameAppTestedOn).toBe(P1);
  });

  test("another application version gets neither derived nor a hint", () => {
    const v = op(both(), product(P2, APP_NEXT));
    expect(v.state).toBe("eligible");
    expect(v.derivedFrom).toBeUndefined();
    expect(v.sameAppTestedOn).toBeUndefined();
    expect(op(both(), product(P1, APP_NEXT)).state).toBe("eligible"); // the tested Product itself, on a changed application
  });

  test("a Product's own failure is not hidden behind a tested sibling", () => {
    const records = [...both(), rec({ product: P2, channel: "api", transfer: "fail" }), rec({ product: P2, channel: "ui" })];
    expect(buildMatrix(records, [product(P2), product(P1)])[0].operations.flashParams.state).toBe("failed");
  });

  test("a sibling's test does not hide the Product's own tool-channel failure", () => {
    expect(op([...both(), rec({ product: P2, channel: "tool", transfer: "fail" })], product(P2)).state).toBe("failed");
  });

  test("a Product's own api pass without ui is derived when its sibling is tested, and carries the sibling's firmware", () => {
    expect(op([...both({ firmware: "2.1" }), rec({ product: P2, channel: "api" })], product(P2)).state).toBe("eligible"); // P1 not passed in
    const rows = buildMatrix([...both({ firmware: "2.1" }), rec({ product: P2, channel: "api" })], [product(P2), product(P1)]);
    expect(rows[0].operations.flashParams).toMatchObject({ state: "derived", derivedFrom: P1, firmware: ["2.1"] });
    expect(rows[0].operations.flashParams.cells.api?.transfer.state).toBe("pass");
  });

  test("a record of a Product the caller does not know raises nothing", () => {
    expect(op(both({ product: `${HW_A}_P-TYPO` }), product(P2)).state).toBe("eligible");
  });

  test("a refusal outranks the Product's own newer failure", () => {
    expect(op([...both(), rec({ channel: "ui", transfer: "fail", at: "2000-01-04T10:00:00.000Z" })], product(P1, APP, { ...ALL, flashParams: false })).state).toBe("refused");
  });

  test("superseded evidence no longer counts", () => {
    const old = both({ at: "2000-01-02T10:00:00.000Z" });
    const revoked = rec({ channel: "ui", transfer: "fail", at: "2000-01-03T10:00:00.000Z", supersedes: [old[1].id] });
    expect(op([...old, revoked], product(P1)).state).toBe("failed");
  });

  test("opposite results under the same conditions are a conflict", () => {
    const records = [...both(), rec({ channel: "api", transfer: "fail", at: "2000-01-03T10:00:00.000Z" })];
    expect(op(records, product(P1)).state).toBe("conflict");
  });

  test("a policy refusal after a pass refuses, and keeps the evidence visible", () => {
    const v = op(both(), product(P1, APP, { ...ALL, flashParams: false }));
    expect(v.state).toBe("refused");
    expect(v.cells.api?.transfer.state).toBe("pass");
  });

  test("firmware stays as recorded: unknown is reported, not assumed", () => {
    expect(op(both(), product(P1)).firmware).toEqual(["unknown"]);
    expect(op(both({ firmware: "2.1" }), product(P1)).firmware).toEqual(["2.1"]);
  });

  test("refuses a record without a Product and a Product id without its Hardware", () => {
    const r = rec({}) as any;
    r.subject.productRef = null;
    expect(() => buildMatrix([r], [product(P1)])).toThrow("names no Product");
    expect(() => hardwareOf("M-0085_A-0072-30-69AA")).toThrow("is not a <Hardware>_P-<Product> id");
  });
});

describe("the shipped evidence bundle", () => {
  const load = async (): Promise<EvidenceRecord[]> => (JSON.parse(readFileSync(BUNDLE, "utf8")) as { records: unknown[] }).records.map(parseEvidenceRecord);

  // Capabilities are all allowed here: this checks the evidence side; the shipped matrix (18b) pairs
  // the records with each Product's real capabilities().
  test("each Product with records has the state its runs give every operation", async () => {
    const records = await load();
    const owners = [...new Map(records.map((r) => [`${r.subject.productRef}|${r.subject.appProgramId}`, r])).values()];
    // Per Product, the full download and the structural flash as its smoke runs drove them: the bench
    // Products every operation, the structural flash only where it is offered (the GVS's firmware rule
    // refuses it); units in service the full download where their runs requested it, the structural
    // flash where their spec has the step (the RMG 8 T's step has no run yet, the OpenKNX's firmware rule refuses it); the MDT IP Interface Secure has no
    // group objects, so no GA flash; the MDT IP Interface/Router's product refuses the full download (tunnelling
    // entries) and the structural flash, so its runs drive neither. The MEAN WELL power supply has no smoke run: its records are API
    // runs driven by hand, in one channel, whose newest parameter flash ended in an error, and no read.
    type Driven = Partial<Record<"readParams" | "readLinks" | "flashParams" | "flashLinks", "tested" | "eligible" | "failed">> & { fullDownload: "tested" | "eligible"; structuralFlash: "tested" | "eligible" };
    const expected: Record<string, Driven> = {
      "M-0002_H-2.20.2F.2F.20GHQ.20631.200070-1_P-GH.20Q631.200070.20R0111": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_P-400021SE": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0083_H-182-0_P-BE.2D02001.2E02": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0085_H-AM22AA-16_P-AMMA.2D04.2F06.2ES": { fullDownload: "tested", structuralFlash: "eligible" },
      "M-0048_H-9070929-1-O00EF_P-9070929": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0081_H-GeneratedNumber.2D22017-0_P-180.2D02": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0008_H-8.20.2F.2F.20zxy3.20xx-1_P-5133.2000": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0048_H-1019610-1_P-1019610": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0083_H-180-0_P-BE.2D06001.2E02": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0048_H-4930240-2_P-4930240": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0048_H-4930250-2_P-4930250": { fullDownload: "tested", structuralFlash: "tested" },
      "M-0048_H-4930200-2_P-4930200": { fullDownload: "tested", structuralFlash: "eligible" },
      "M-00FA_H-0xA012-1_P-OpenKnxRaumController": { fullDownload: "tested", structuralFlash: "eligible" },
      "M-0083_H-135-3_P-SCN.2DIP000.2E03": { fullDownload: "eligible", structuralFlash: "eligible" },
      "M-0083_H-135-3-O0072_P-SCN.2DIP000.2E03": { flashLinks: "eligible", fullDownload: "tested", structuralFlash: "eligible" },
      "M-0162_H-KNX.2D40E.2D1280D-1_P-KNX.2D40E.2D1280D": {
        readParams: "eligible", readLinks: "eligible", flashParams: "failed", flashLinks: "eligible", fullDownload: "eligible", structuralFlash: "eligible",
      },
    };
    expect(owners).toHaveLength(Object.keys(expected).length);
    expect(new Set(owners.map((r) => r.subject.productRef))).toEqual(new Set(Object.keys(expected)));
    const rows = buildMatrix(records, owners.map((r) => product(r.subject.productRef!, r.subject.appProgramId)));
    for (const row of rows) {
      const want = { readParams: "tested", readLinks: "tested", flashParams: "tested", flashLinks: "tested", ...expected[row.productRef]! };
      for (const [o, state] of Object.entries(want)) {
        expect(`${row.productRef} ${o} ${row.operations[o as keyof typeof row.operations].state}`).toBe(`${row.productRef} ${o} ${state}`);
      }
      expect(Object.keys(row.operations)).toEqual([...MATRIX_OPERATIONS]);
    }
  });
});

describe("a shipped evidence set", () => {
  const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code; } };

  test("names the record at fault: a repeated id, a supersession of another cell or of nothing", () => {
    const [a, b] = both();
    expect(code(() => checkEvidenceSet([a, { ...a }]))).toBe("EVIDENCE_SET_INVALID");
    const crossCell = rec({ channel: "api", op: "flashLinks", at: "2000-01-04T10:00:00.000Z", supersedes: [b.id], id: "cross" });
    expect(() => checkEvidenceSet([a, b, crossCell])).toThrow("cross: supersedes");
    expect(code(() => checkEvidenceSet([rec({ supersedes: ["nowhere"], at: "2000-01-04T10:00:00.000Z" })]))).toBe("EVIDENCE_SET_INVALID");
    expect(code(() => checkEvidenceSet([a, rec({ channel: "api", at: "2000-01-01T10:00:00.000Z", supersedes: [a.id] })]))).toBe("EVIDENCE_SET_INVALID");
  });

  test("a bundle lists every Product that has records, with every capability", () => {
    const records = both();
    expect(parseEvidenceBundle({ schema: EVIDENCE_BUNDLE_SCHEMA, products: [product(P1)], records }).records).toHaveLength(2);
    expect(code(() => parseEvidenceBundle({ schema: EVIDENCE_BUNDLE_SCHEMA, products: [], records }))).toBe("EVIDENCE_BUNDLE_INVALID");
    const { structuralFlash: _, ...partial } = ALL;
    expect(code(() => parseEvidenceBundle({ schema: EVIDENCE_BUNDLE_SCHEMA, products: [{ productRef: P1, appProgramId: APP, capabilities: partial }], records }))).toBe("EVIDENCE_BUNDLE_INVALID");
    expect(code(() => parseEvidenceBundle({ schema: "other", products: [], records: [] }))).toBe("EVIDENCE_BUNDLE_INVALID");
  });
});
