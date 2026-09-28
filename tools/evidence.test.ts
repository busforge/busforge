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
  const c = {
    ia: "1.1.56", productRef: "M-0083_H-182-0_P-BE.2D02001.2E02", hardware2Program: "M-0083_A-00B6-32-9642", mask: "MV-0705",
    configuration: "application defaults, no links", compared: 274, divergent: 0, etsOutside: 0, busforgeOnly: 0, uncomparedSegments: 0,
    segments: ["AS-4000 0/1", "AS-4468 0/168"], exclusions: [],
  };
  const r0 = { recordedAt: run.recordedAt, runnerRevision: "b613b88", artifact: "capture.log", sha256: "c".repeat(64) };
  test("every compared byte equal against a hashed ETS capture is a reference pass", () => {
    const r = etsdiffEvidence(c, r0);
    expect(r.results.reference).toMatchObject({ state: "pass" });
    expect(r.origin.reference).toBe("ets-capture");
    expect(r.subject.appProgramId).toBe("M-0083_A-00B6-32-9642");
    expect(r.scope.operation).toBe("fullDownload");
  });
  test("any divergent byte is a reference failure", () => {
    const r = etsdiffEvidence({ ...c, divergent: 1 }, r0);
    expect(r.results.reference).toEqual({ state: "fail", detail: "1 of 274 compared bytes differ; 274 bytes compared (AS-4000 0/1, AS-4468 0/168)" });
  });
  test("an ETS byte outside Busforge's image or an unplaced segment is no pass either", () => {
    expect(etsdiffEvidence({ ...c, etsOutside: 2 }, r0).results.reference.state).toBe("fail");
    expect(etsdiffEvidence({ ...c, uncomparedSegments: 1 }, r0).results.reference.state).toBe("fail");
  });
  test("exclusions and bytes only Busforge writes are named in the detail", () => {
    const r = etsdiffEvidence({ ...c, busforgeOnly: 2, exclusions: ["11 bytes: control register"] }, r0);
    expect(r.results.reference).toMatchObject({ state: "pass", detail: "274 bytes compared (AS-4000 0/1, AS-4468 0/168); excluded by rule: 11 bytes: control register; 2 bytes Busforge writes that ETS does not are not covered" });
  });
  test("no compared byte is no evidence", () => {
    expect(() => etsdiffEvidence({ ...c, compared: 0 }, r0)).toThrow("nothing to record");
  });
  test("a partial download is recorded against the flash operation that writes its segments", () => {
    const r = etsdiffEvidence({ ...c, operation: "flashLinks" }, r0);
    expect(r.scope).toMatchObject({ operation: "flashLinks", configuration: "application defaults, no links; ETS partial download against Busforge's configuration image (not the flash operation's write set), the group tables" });
    expect(r.results.reference).toMatchObject({ state: "pass", method: expect.stringContaining("ETS partial download wrote to the group tables") });
    expect(r.id).toBe(`etsdiff-flashLinks-1.1.56-${run.recordedAt}`);
    expect(r.scope.configuration).toContain("not the flash operation's write set");
  });
  test("a partial parameter record names the parameter segments, and fails like any other", () => {
    expect(etsdiffEvidence({ ...c, operation: "flashParams" }, r0).results.reference)
      .toMatchObject({ method: expect.stringContaining("wrote to the parameter segments") });
    expect(etsdiffEvidence({ ...c, operation: "flashParams", divergent: 3 }, r0).results.reference).toMatchObject({ state: "fail" });
  });
  test("an operation ETS touched but that could not be compared is a failed record", () => {
    const r = etsdiffEvidence({ ...c, operation: "flashLinks", compared: 0, uncomparedSegments: 1, segments: ["L2 not compared, address unknown"] }, r0);
    expect(r.results.reference).toMatchObject({ state: "fail", detail: expect.stringContaining("1 segments could not be placed") });
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
