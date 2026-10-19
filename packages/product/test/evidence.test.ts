import { test, expect, describe } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseEvidenceRecord, cellState, type EvidenceRecord } from "../src/evidence.ts";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "docs", "evidence", "examples");
const example = async (name: string): Promise<any> => JSON.parse(await Bun.file(join(EXAMPLES, name)).text());
const clone = <T>(v: T): T => structuredClone(v);
const refusal = (raw: unknown) => { try { parseEvidenceRecord(raw); return null; } catch (e) { return (e as { code?: string }).code; } };

describe("evidence record v1", () => {
  test("every documented example is a valid record", async () => {
    for (const file of readdirSync(EXAMPLES)) {
      const raw = await example(file);
      for (const r of Array.isArray(raw) ? raw : [raw]) expect(() => parseEvidenceRecord(r)).not.toThrow();
    }
  });

  test("refuses a record of another schema version", async () => {
    const r = await example("byte-only.json");
    expect(refusal({ ...r, schema: "busforge.evidence/2" })).toBe("EVIDENCE_SCHEMA_UNSUPPORTED");
  });

  test("refuses unknown and missing fields instead of ignoring them", async () => {
    const r = await example("byte-only.json");
    expect(refusal({ ...r, verified: true })).toBe("EVIDENCE_INVALID");
    const { medium: _, ...noMedium } = r;
    expect(refusal(noMedium)).toBe("EVIDENCE_INVALID");
    const bad = clone(r); bad.results.transfer.state = "ok";
    expect(refusal(bad)).toBe("EVIDENCE_INVALID");
  });

  test("a dump Busforge wrote cannot count as an independent reference", async () => {
    const r = await example("self-written-dump.json");
    r.results.reference = { state: "pass", method: "read back equals the built image" };
    expect(refusal(r)).toBe("EVIDENCE_REFERENCE_NOT_INDEPENDENT");
  });

  test("a device Busforge has written to is no longer an independent reference", async () => {
    const r = await example("synthetic-ets-reference.json");
    r.origin.reference = "independently-commissioned-device";
    r.origin.priorBusforgeWrites = "some";
    expect(refusal(r)).toBe("EVIDENCE_REFERENCE_NOT_INDEPENDENT");
    r.origin.priorBusforgeWrites = "unknown";
    expect(refusal(r)).toBe("EVIDENCE_REFERENCE_NOT_INDEPENDENT");
    r.origin.priorBusforgeWrites = "none";
    expect(refusal(r)).toBeNull();
  });

  test("every pass names how it was established", async () => {
    const r = await example("unknown-firmware.json");
    delete r.results.behaviour.method;
    expect(refusal(r)).toBe("EVIDENCE_METHOD_MISSING");
  });

  test("firmware is either unknown or observed with its source, never assumed", async () => {
    const r = await example("unknown-firmware.json");
    r.subject.firmware = { state: "observed", value: "1.2", source: "" };
    expect(refusal(r)).toBe("EVIDENCE_INVALID");
    r.subject.firmware = { state: "assumed", value: "1.2" };
    expect(refusal(r)).toBe("EVIDENCE_INVALID");
    r.subject.firmware = { state: "observed", value: "1.2", source: "PID_FIRMWARE_REVISION read" };
    expect(refusal(r)).toBeNull();
  });

  test("a superseding record must say why", async () => {
    const [, fail] = await example("conflicting-newer.json");
    const rerun = { ...clone(fail), id: "rerun", supersedes: [fail.id], supersedeReason: null };
    expect(refusal(rerun)).toBe("EVIDENCE_INVALID");
  });
});

describe("cellState", () => {
  test("a newer, unexplained failure under the same conditions is a conflict, not a pass", async () => {
    const records = ((await example("conflicting-newer.json")) as unknown[]).map(parseEvidenceRecord);
    expect(cellState(records, "transfer")).toEqual({ state: "conflict", basis: records.map((r) => r.id).reverse() }); // newest first
  });

  test("a failure explained by a superseding record no longer counts", async () => {
    const records: EvidenceRecord[] = ((await example("conflicting-newer.json")) as unknown[]).map(parseEvidenceRecord);
    const [, fail] = records;
    const rerun = parseEvidenceRecord({
      ...clone(fail), id: "gvs-amma-api-rerun", recordedAt: "2000-01-02T08:27:00.873Z",
      results: { ...fail.results, transfer: { state: "pass", method: "owned-byte read-back after each change and revert" } },
      supersedes: [fail.id], supersedeReason: "bench bridge dropped the management connection; rerun on the same build passed",
    });
    expect(cellState([...records, rerun], "transfer")).toEqual({ state: "pass", basis: ["gvs-amma-api-rerun"] });
  });

  test("a newer result under different conditions replaces the older one", async () => {
    const [pass, fail] = ((await example("conflicting-newer.json")) as unknown[]).map(parseEvidenceRecord);
    const fixed = { ...pass, id: "fixed", recordedAt: "2000-01-03T00:00:00.000Z", build: { ...pass.build, server: { version: "0.4.200", commit: "abc1234" } } };
    expect(cellState([pass, fail, fixed], "transfer")).toEqual({ state: "pass", basis: ["fixed"] });
  });

  test("an axis nobody assessed stays not-assessed, and undated records never outrank dated ones", async () => {
    const raw = await example("self-written-dump.json");
    const dump = parseEvidenceRecord({ ...raw, subject: { ...raw.subject, productRef: "M-0162_H-EXAMPLE_P-EXAMPLE" } });
    expect(cellState([dump], "reference")).toEqual({ state: "not-assessed", basis: [] });
    const dated = { ...dump, id: "dated", recordedAt: "2000-01-01T00:00:00.000Z", results: { ...dump.results, transfer: { state: "fail" as const } } };
    expect(cellState([dump, dated], "transfer").basis[0]).toBe("dated");
  });
});

describe("evidence record v1: review edge cases", () => {
  test("refuses an impossible timestamp and a malformed hash", async () => {
    const r = await example("byte-only.json");
    expect(refusal({ ...r, recordedAt: "2000-13-45T99:99:99Z" })).toBe("EVIDENCE_INVALID");
    expect(refusal({ ...r, source: { ...r.source, sha256: "abc" } })).toBe("EVIDENCE_INVALID");
  });

  test("refuses a manufacturer that is not the application program's", async () => {
    const r = await example("byte-only.json");
    r.subject.manufacturer = "M-0083";
    expect(refusal(r)).toBe("EVIDENCE_INVALID");
  });

  test("not-applicable must say why", async () => {
    const r = await example("byte-only.json");
    delete r.results.behaviour.detail;
    expect(refusal(r)).toBe("EVIDENCE_INVALID");
  });

  test("a device Busforge configured is not an independently commissioned one", async () => {
    const r = await example("synthetic-ets-reference.json");
    r.origin = { configuredBy: "busforge", reference: "independently-commissioned-device", priorBusforgeWrites: "none" };
    expect(refusal(r)).toBe("EVIDENCE_REFERENCE_NOT_INDEPENDENT");
  });

  test("a reference pass must point at a retained, hashed artifact", async () => {
    const r = await example("synthetic-ets-reference.json");
    r.source.sha256 = null;
    expect(refusal(r)).toBe("EVIDENCE_REFERENCE_UNRETAINED");
  });

  test("a record cannot supersede itself", async () => {
    const r = await example("byte-only.json");
    expect(refusal({ ...r, supersedes: [r.id], supersedeReason: "x" })).toBe("EVIDENCE_INVALID");
  });
});

describe("cellState: review edge cases", () => {
  const pair = async () => ((await example("conflicting-newer.json")) as unknown[]).map(parseEvidenceRecord);
  const code = (f: () => unknown) => { try { f(); return null; } catch (e) { return (e as { code?: string }).code; } };

  test("orders by time, not by the spelling of the timestamp", async () => {
    const [pass, fail] = await pair();
    const later = { ...pass, id: "later", recordedAt: "2000-01-02T08:15:32.900Z", build: { ...pass.build, server: { version: "1", commit: "b" } } };
    const earlier = { ...fail, recordedAt: "2000-01-02T08:15:32Z", build: { ...fail.build, server: { version: "1", commit: "a" } } };
    expect(cellState([earlier, later], "transfer")).toEqual({ state: "pass", basis: ["later"] });
  });

  test("the same firmware in another key order is the same condition", async () => {
    const [pass, fail] = await pair();
    const fw1 = { state: "observed" as const, value: "1.2", source: "PID 9" };
    const fw2 = JSON.parse('{"source":"PID 9","value":"1.2","state":"observed"}');
    const a = { ...pass, subject: { ...pass.subject, firmware: fw1 } };
    const b = { ...fail, subject: { ...fail.subject, firmware: fw2 } };
    expect(cellState([a, b], "transfer").state).toBe("conflict");
  });

  test("refuses records of different cells, duplicate ids, unknown or circular supersession", async () => {
    const [pass, fail] = await pair();
    expect(code(() => cellState([pass, { ...fail, scope: { ...fail.scope, channel: "ui" } }], "transfer"))).toBe("EVIDENCE_CELL_MIXED");
    expect(code(() => cellState([pass, pass], "transfer"))).toBe("EVIDENCE_CELL_MIXED");
    expect(code(() => cellState([{ ...fail, supersedes: ["nowhere"], supersedeReason: "x" }], "transfer"))).toBe("EVIDENCE_CELL_MIXED");
    const a = { ...pass, supersedes: [fail.id], supersedeReason: "x" }, b = { ...fail, supersedes: [pass.id], supersedeReason: "y" };
    expect(code(() => cellState([a, b], "transfer"))).toBe("EVIDENCE_CELL_MIXED");
  });

  test("evidence from another Product never raises a cell, even on the same KNX Hardware", async () => {
    const [pass, fail] = await pair();
    const variant = { ...fail, subject: { ...fail.subject, productRef: "M-0085_H-AM22AA-16_P-OTHER.20VARIANT" } };
    for (const axis of ["transfer", "reference", "behaviour", "persistence"] as const) {
      expect(code(() => cellState([pass, variant], axis))).toBe("EVIDENCE_CELL_MIXED");
    }
  });

  test("a record that names no Product cannot back a cell", async () => {
    const dump = parseEvidenceRecord(await example("self-written-dump.json"));
    expect(code(() => cellState([dump], "transfer"))).toBe("EVIDENCE_PRODUCT_UNKNOWN");
  });

  test("a superseding record removes others only on the axes it assessed itself", async () => {
    const [pass, fail] = await pair();
    const note = { ...pass, id: "note", recordedAt: "2000-01-03T00:00:00.000Z", supersedes: [fail.id], supersedeReason: "x",
      results: { ...pass.results, transfer: { state: "not-assessed" as const } } };
    expect(cellState([pass, fail, note], "transfer").state).toBe("conflict");
  });
});
