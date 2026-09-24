import { test, expect, describe } from "bun:test";
import { runEvidence, specRevision, type RunConditions } from "./evidence.ts";
import { serverBuild, transportOf } from "../evidence.ts";
import { gvsAmma } from "./specs/gvs-amma.ts";

const cond: RunConditions = {
  server: { version: "v0.4.136", commit: "e6991a0" },
  runnerRevision: "e6991a0",
  transport: { kind: "ip-tcp", via: "busforge-bridge" },
  firmware: { state: "unknown" },
  source: { artifact: "tools/smoke/reports/gvs-amma-api-x.json", sha256: "a".repeat(64) },
};
const run = {
  spec: "gvs-amma", channel: "api" as const, ok: true, startedAt: Date.parse("2026-09-24T12:00:00.000Z"),
  capabilities: [
    { capability: "fullDownload", channel: "api" as const, state: "pass" as const, detail: "downloaded verified" },
    { capability: "readParams", channel: "api" as const, state: "pass" as const, detail: "read" },
    { capability: "flashParams", channel: "api" as const, state: "fail" as const, detail: "no reliable response (device not answering)" },
    { capability: "flashLinks", channel: "api" as const, state: "unsafe" as const, detail: "not on the bench" },
  ],
  clickThrough: { state: "not-applicable" as const, detail: "no UI surface in the api channel" },
  behaviours: [{ kind: "inputToOutput", label: "switch drives status", state: "pass" as const, detail: "tracked 3 transitions" }],
  refusals: [{ capability: "x", state: "pass" as const, detail: "refused" }],
};

describe("smoke evidence records", () => {
  test("one valid record per observed capability and behaviour, carrying the run's conditions", () => {
    const records = runEvidence(run, gvsAmma, cond);
    expect(records.map((r) => [r.scope.operation, r.results.transfer.state, r.results.behaviour.state])).toEqual([
      ["fullDownload", "pass", "not-assessed"],
      ["readParams", "pass", "not-assessed"],
      ["flashParams", "fail", "not-assessed"],
      ["flashLinks", "not-assessed", "pass"],
    ]);
    for (const r of records) {
      expect(r.subject).toMatchObject({ manufacturer: "M-0085", productRef: gvsAmma.device.productRef, appProgramId: "M-0085_A-0072-30-69AA", mask: "MV-07B0" });
      expect(r.build).toEqual({ server: cond.server, runner: { name: "tools/smoke", revision: "e6991a0" }, spec: { name: "gvs-amma", revision: specRevision(gvsAmma) } });
      expect(r.origin).toEqual({ configuredBy: "busforge", reference: "self-written", priorBusforgeWrites: "some" });
      expect(r.recordedAt).toBe("2026-09-24T12:00:00.000Z");
    }
  });

  test("no record claims persistence: whether a write restarted the device is not known here", () => {
    for (const r of runEvidence(run, gvsAmma, cond)) expect(r.results.persistence.state).toBe("not-assessed");
  });

  test("a read says it was decoded, not compared", () => {
    const read = runEvidence(run, gvsAmma, cond).find((r) => r.scope.operation === "readParams")!;
    expect(read.results.transfer).toMatchObject({ state: "pass", method: expect.stringContaining("not compared") });
  });

  test("a behaviour observed on addresses the download committed is evidence for the download", () => {
    const spec = { ...gvsAmma, behaviours: gvsAmma.behaviours.map((b) => (b.kind === "inputToOutput" ? { ...b, inGa: "1/2/2", outGa: "1/2/3" } : b)) };
    const records = runEvidence({ ...run, capabilities: [run.capabilities[0]] }, spec, cond);
    expect(records.map((r) => r.scope.operation)).toEqual(["fullDownload", "fullDownload"]);
    expect(records[1].results.behaviour.state).toBe("pass");
    // Without this run's download, an earlier build committed those addresses: no record.
    expect(runEvidence({ ...run, capabilities: [] }, spec, cond)).toEqual([]);
  });

  test("an aborted run and an unexercised capability write no device record", () => {
    const aborted = { ...run, ok: false, capabilities: [{ capability: "preflight", channel: "api" as const, state: "fail" as const, detail: "BUSFORGE_BENCH_HOST is not set" }], behaviours: [] };
    expect(runEvidence(aborted, gvsAmma, cond)).toEqual([]);
  });

  test("a clicked-through UI is transfer evidence for the ui channel", () => {
    const ui = { ...run, channel: "ui" as const, capabilities: [], behaviours: [], clickThrough: { state: "pass" as const, detail: "565 params rendered" } };
    expect(runEvidence(ui, gvsAmma, cond).map((r) => [r.scope.operation, r.scope.channel, r.results.transfer.state])).toEqual([["uiClickThrough", "ui", "pass"]]);
  });

  test("the spec revision changes with the spec and nothing else", () => {
    expect(specRevision(gvsAmma)).toBe(specRevision(structuredClone(gvsAmma)));
    expect(specRevision({ ...gvsAmma, unsafe: [{ capability: "flashLinks", reason: "x" }] })).not.toBe(specRevision(gvsAmma));
  });

  test("a dev server with local changes is not the commit it was started from", () => {
    expect(serverBuild({ version: "v0.4.136-2-ge6991a0-dirty (dev)", commit: "e6991a0" })).toEqual({ version: "v0.4.136-2-ge6991a0-dirty (dev)", commit: "e6991a0-dirty" });
    expect(serverBuild({ version: "v0.4.136", commit: "e6991a0" }).commit).toBe("e6991a0");
  });

  test("transport is what the saved connection pins, and the route only what the operator declared", () => {
    expect(transportOf("tcp", "busforge-bridge")).toEqual({ kind: "ip-tcp", via: "busforge-bridge" });
    expect(transportOf("auto", undefined)).toEqual({ kind: "unknown", via: "unknown" });
    expect(() => transportOf("udp", "a-bridge")).toThrow("BUSFORGE_BENCH_VIA");
  });
});
