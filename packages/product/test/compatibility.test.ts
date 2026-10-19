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
  test("the four bench Products are tested for every operation their smoke runs drove", async () => {
    const records = await load();
    const owners = [...new Map(records.map((r) => [`${r.subject.productRef}|${r.subject.appProgramId}`, r])).values()];
    expect(owners).toHaveLength(4);
    const rows = buildMatrix(records, owners.map((r) => product(r.subject.productRef!, r.subject.appProgramId)));
    for (const row of rows) {
      for (const o of ["readParams", "readLinks", "flashParams", "flashLinks", "fullDownload"] as const) {
        expect(`${row.productRef} ${o} ${row.operations[o].state}`).toBe(`${row.productRef} ${o} tested`);
      }
      // The structural flash was driven on the Jung and the MDT only; the others never ran it.
      const structural = row.productRef.startsWith("M-0004_") || row.productRef.startsWith("M-0083_") ? "tested" : "eligible";
      expect(`${row.productRef} structuralFlash ${row.operations.structuralFlash.state}`).toBe(`${row.productRef} structuralFlash ${structural}`);
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
