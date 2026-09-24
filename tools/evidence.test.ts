import { test, expect, describe } from "bun:test";
import { readbackEvidence, etsdiffEvidence, readFirmwareRevision, type ImageComparison } from "./evidence.ts";
import { runEvidence } from "./smoke/evidence.ts";
import { jung400021se } from "./smoke/specs/jung-400021se.ts";

const cmp: ImageComparison = {
  ia: "1.2.54", firmware: { state: "unknown" }, productRef: "M-0162_H-EX_P-EX", hardware2Program: "M-0162_H-EX_HP-0004-11-F245",
  mask: "MV-07B0", match: true, diffBytes: 0, length: 120,
};
const run = { recordedAt: "2026-09-24T12:00:00.000Z", runnerRevision: "b613b88", transport: { kind: "ip-udp" as const, via: "direct" as const }, artifact: "out/1.2.54.device.bin", sha256: "b".repeat(64) };

describe("readback evidence", () => {
  test("a match on a device only ETS ever wrote is reference evidence", () => {
    const r = readbackEvidence(cmp, { configuredBy: "ets", priorBusforgeWrites: "none" }, run);
    expect(r.results.reference.state).toBe("pass");
    expect(r.results.transfer.state).toBe("not-assessed");
    expect(r.origin).toEqual({ configuredBy: "ets", reference: "independently-commissioned-device", priorBusforgeWrites: "none" });
    expect(r.subject.appProgramId).toBe("M-0162_A-0004-11-F245");
  });

  test("a match on a device Busforge wrote is transfer evidence only", () => {
    const r = readbackEvidence(cmp, { configuredBy: "busforge", priorBusforgeWrites: "some" }, run);
    expect([r.results.transfer.state, r.results.reference.state]).toEqual(["pass", "not-assessed"]);
  });

  test("an unknown writer yields neither, whatever the bytes say", () => {
    for (const origin of [{ configuredBy: "unknown" as const, priorBusforgeWrites: "unknown" as const }, { configuredBy: "ets" as const, priorBusforgeWrites: "unknown" as const }]) {
      const r = readbackEvidence(cmp, origin, run);
      expect([r.results.transfer.state, r.results.reference.state]).toEqual(["not-assessed", "not-assessed"]);
    }
  });

  test("a mismatch on an independent device is a reference failure that names drift as a possibility", () => {
    const r = readbackEvidence({ ...cmp, match: false, diffBytes: 3 }, { configuredBy: "ets", priorBusforgeWrites: "none" }, run);
    expect(r.results.reference).toEqual({ state: "fail", detail: "3 of 120 bytes differ; a difference can also be project-versus-device drift" });
  });
});

describe("etsdiff evidence", () => {
  const c = { ia: "1.2.32", productRef: "M-00FA_H-0xA012-1_P-OpenKnxRaumController", hardware2Program: "M-00FA_H-0xA012-1_HP-A012-55-0000", mask: "MV-07B0", divergent: 0, compared: 30, outside: 86, base: 0x54, basePinned: false };
  test("zero divergent writes against a hashed ETS capture is a reference pass", () => {
    const r = etsdiffEvidence(c, { recordedAt: run.recordedAt, runnerRevision: "b613b88", artifact: "capture.log", sha256: "c".repeat(64) });
    expect(r.results.reference).toMatchObject({ state: "pass" });
    expect(r.origin.reference).toBe("ets-capture");
  });
  test("any divergent write is a reference failure", () => {
    const r = etsdiffEvidence({ ...c, divergent: 2 }, { recordedAt: run.recordedAt, runnerRevision: null, artifact: "capture.log", sha256: "c".repeat(64) });
    expect(r.results.reference).toEqual({ state: "fail", detail: "2 of 30 parameter-segment writes differ; 30 writes compared, 86 outside the segment not compared, base 0x54 inferred from the capture" });
  });
  test("no compared write is no evidence", () => {
    expect(() => etsdiffEvidence({ ...c, compared: 0 }, { recordedAt: run.recordedAt, runnerRevision: null, artifact: "capture.log", sha256: "c".repeat(64) })).toThrow("nothing to record");
  });
});

test("an application program id keeps its suffix (Jung ...-O000A)", () => {
  const [r] = runEvidence({ spec: "jung-400021se", channel: "api", startedAt: 0, capabilities: [{ capability: "readParams", channel: "api", state: "pass", detail: "" }], clickThrough: { state: "not-applicable", detail: "" }, behaviours: [] },
    jung400021se, { server: { version: "v1", commit: "a" }, runnerRevision: null, transport: { kind: "unknown", via: "unknown" }, firmware: { state: "unknown" }, source: { artifact: null, sha256: null } });
  expect(r.subject.appProgramId).toBe("M-0004_A-7072-21-99A7-O000A");
});

describe("firmware revision", () => {
  test("a device that answers PID 9 has an observed revision with its source", async () => {
    expect(await readFirmwareRevision({ propReadIfPresent: async (o, p) => (o === 0 && p === 9 ? new Uint8Array([0x12]) : null) }))
      .toEqual({ state: "observed", value: "18", source: "device object PID_FIRMWARE_REVISION (object 0, PID 9)" });
  });
  test("a device without PID 9 stays unknown", async () => {
    expect(await readFirmwareRevision({ propReadIfPresent: async () => null })).toEqual({ state: "unknown" });
  });
});
