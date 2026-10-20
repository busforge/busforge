import { test, expect, describe } from "bun:test";
import { runEvidence, specRevision, reportText, serverDataPath, type RunConditions } from "./evidence.ts";
import { serverBuild, transportOf } from "../evidence.ts";
import { gvsAmma } from "./specs/gvs-amma.ts";

const cond: RunConditions = {
  server: { version: "v0.4.136", commit: "abc1234" },
  runnerRevision: "abc1234",
  transport: { kind: "ip-tcp", via: "busforge-bridge" },
  firmware: { state: "unknown" },
  source: { artifact: "tools/smoke/reports/gvs-amma-api-x.json", sha256: "a".repeat(64) },
};
const run = {
  spec: "gvs-amma", channel: "api" as const, ok: true, startedAt: Date.parse("2000-01-01T12:00:00.000Z"),
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
      expect(r.build).toEqual({ server: cond.server, runner: { name: "tools/smoke", revision: "abc1234" }, spec: { name: "gvs-amma", revision: specRevision(gvsAmma) } });
      expect(r.origin).toEqual({ configuredBy: "busforge", reference: "self-written", priorBusforgeWrites: "some" });
      expect(r.recordedAt).toBe("2000-01-01T12:00:00.000Z");
    }
  });

  test("no record claims persistence when the run did not check it", () => {
    for (const r of runEvidence(run, gvsAmma, cond)) expect(r.results.persistence.state).toBe("not-assessed");
  });

  test("an observed reboot with a matching read-back is persistence for this run's passed writes", () => {
    const withLinks = { ...run, capabilities: [run.capabilities[0], { capability: "flashLinks", channel: "api" as const, state: "pass" as const, detail: "linked" }, run.capabilities[2]], behaviours: [] };
    const persisted = { ...withLinks, persistence: { state: "pass" as const, detail: "silent 140 ms after A_Restart, answering again after 5900 ms; equal" } };
    const records = runEvidence(persisted, gvsAmma, cond);
    expect(records.map((r) => [r.scope.operation, r.results.persistence.state])).toEqual([
      ["fullDownload", "pass"],
      ["flashLinks", "pass"],
      // a failed write left nothing of its own to persist
      ["flashParams", "not-assessed"],
    ]);
    expect(records[0].results.persistence).toMatchObject({ method: expect.stringContaining("A_Restart") });
  });

  test("a failed persistence check is recorded as a fail, not dropped", () => {
    const failed = { ...run, behaviours: [], persistence: { state: "fail" as const, detail: "the device never went silent" } };
    expect(runEvidence(failed, gvsAmma, cond).find((r) => r.scope.operation === "fullDownload")!.results.persistence).toEqual({ state: "fail", detail: "the device never went silent" });
  });

  test("a reboot the check could not see is recorded as persistence not assessed, with its reason", () => {
    const unseen = { ...run, behaviours: [], persistence: { state: "not-assessed" as const, detail: "the reboot cannot be seen" } };
    expect(runEvidence(unseen, gvsAmma, cond).find((r) => r.scope.operation === "fullDownload")!.results.persistence).toEqual({ state: "not-assessed", detail: "the reboot cannot be seen" });
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
    expect(serverBuild({ version: "v0.4.136-2-gabc1234-dirty (dev)", commit: "abc1234" })).toEqual({ version: "v0.4.136-2-gabc1234-dirty (dev)", commit: "abc1234-dirty" });
    expect(serverBuild({ version: "v0.4.136", commit: "abc1234" }).commit).toBe("abc1234");
  });

  test("transport is what the saved connection pins, and the route only what the operator declared", () => {
    expect(transportOf("tcp", "busforge-bridge")).toEqual({ kind: "ip-tcp", via: "busforge-bridge" });
    expect(transportOf("auto", undefined)).toEqual({ kind: "unknown", via: "unknown" });
    expect(() => transportOf("udp", "a-bridge")).toThrow("BUSFORGE_BENCH_VIA");
  });
});

describe("smoke report paths", () => {
  test("a backup path the server returns is written from its data directory on", () => {
    expect(serverDataPath("/srv/busforge/data/projects/p1/backups/BF-1-full-17.bin")).toBe("projects/p1/backups/BF-1-full-17.bin");
    expect(serverDataPath("projects/p1/backups/a.bin")).toBe("projects/p1/backups/a.bin");
  });

  test("a backup path of any other shape is refused, not written as it came", () => {
    expect(() => serverDataPath("/srv/busforge/data/elsewhere/a.bin")).toThrow("not <data dir>/projects/<id>/backups/<file>");
    expect(() => serverDataPath("/srv/projects/p1/backups/")).toThrow();
  });

  test("the report rewrites every nested backup path and leaves other strings alone", () => {
    const text = reportText({ capabilities: [{ evidence: { flash: { backup: "/srv/data/projects/p1/backups/x.bin", kind: "flashed" } } }], detail: "/srv/data/projects/p1/backups/x.bin" });
    expect(JSON.parse(text)).toEqual({ capabilities: [{ evidence: { flash: { backup: "projects/p1/backups/x.bin", kind: "flashed" } } }], detail: "/srv/data/projects/p1/backups/x.bin" });
    expect(text.endsWith("}\n")).toBe(true);
  });
});
