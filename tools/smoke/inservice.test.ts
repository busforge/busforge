import { test, expect, describe } from "bun:test";
import { gaToNum } from "../../packages/knx/src/index.ts";
import type { CfgItem, DeviceCapabilities, DeviceConfigView } from "../../packages/product/src/index.ts";
import type { FlashResult } from "./client.ts";
import { runInService, planInService, inServiceProblems, inServicePhases, type InServiceIo, type InServiceOptions } from "./inservice.ts";
import { runEvidence, type RunConditions } from "./evidence.ts";
import { openknxRaumControllerInService as spec } from "./specs/openknx-raumcontroller-in-service.ts";
import { SPECS } from "./specs/index.ts";
import type { DeviceSpec } from "./spec.ts";

// A scripted device behind a scripted server, kept as the server keeps them: what the device holds,
// what the project holds, and the baseline the last read-back set. Every call that reaches the
// device is logged, so a test can compare the run's writes with its plan.
const PARAM = spec.inService!.param!.paramRefId;
const OBJ = spec.inService!.link!.comObjRefId;
const OTHER_OBJ = "M-00FA_A-A012-55-0000_O-23_R-300000602";
const STRUCT = "M-00FA_A-A012-55-0000_UP-3001008_R-300100801";
const GA = "15/7/250";
const TEST_GA = gaToNum(GA);

interface Script {
  props?: Record<string, string>;            // "object/pid" → hex the device reports
  params?: Record<string, string>;           // what the device holds
  links?: Record<string, number[]>;
  caps?: Partial<DeviceCapabilities>;
  structuralParams?: string[];               // parameters whose change alters the com-object table
  adoptDryNotUnchanged?: boolean;            // the project, taken over, still differs from the device
  gaFlashUnverified?: boolean;               // the link lands, its verify fails
  answer?: string;                           // what the linked object answers
  sideEffect?: boolean;                      // setting the step's parameter also changes another one
  chanThrowsOnSecondParamFlash?: boolean;    // the channel fails while writing the revert
  rebootThrows?: boolean;
  witnessThrows?: boolean;
  downloadBreaks?: boolean;                  // the full download writes and then breaks off
  wrongRevert?: boolean;                     // the device keeps another value after the revert
  busUsesTestGa?: boolean;                   // another device answers on the test address
  placedWithDefaults?: boolean;              // the fresh project shows the catalogue defaults, which hide a linked object
  hiddenEvenUnderOwnConfig?: boolean;        // a link no configuration of the unit places
}

function scripted(sc: Script = {}) {
  const calls: string[] = [];
  const device: { params: Record<string, string>; links: Record<string, number[]> } = { params: { [PARAM]: "1", [STRUCT]: "1", ...sc.params }, links: { [OBJ]: [], [OTHER_OBJ]: [gaToNum("2/0/10")], ...sc.links } };
  const project: { params: Record<string, string>; links: Record<string, number[]> } = { params: { ...device.params, ...(sc.placedWithDefaults ? { [STRUCT]: "0" } : {}) }, links: structuredClone(device.links) };
  // The server counts a device link on an object the project's parameters hide as unresolved.
  const gaps = () => (sc.hiddenEvenUnderOwnConfig ? 1 : 0) + (project.params[STRUCT] !== device.params[STRUCT] ? 1 : 0);
  let base = { params: { ...device.params }, links: structuredClone(device.links) as Record<string, number[]> };
  let paramFlashes = 0;
  const caps: DeviceCapabilities = { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: false, ...sc.caps };
  const props: Record<string, string> = { "4/13": "00faa01255", "0/25": "0945", ...sc.props };
  const same = (a: number[] = [], b: number[] = []) => a.length === b.length && a.every((g, i) => g === b[i]);
  const paramsDiffer = () => Object.keys(project.params).some((k) => project.params[k] !== device.params[k]);
  const linksDiffer = () => Object.keys(project.links).some((k) => !same(project.links[k], device.links[k]));
  const structural = () => Object.keys(project.params).some((k) => project.params[k] !== device.params[k] && (sc.structuralParams ?? []).includes(k));
  const result = (kind: FlashResult["kind"], extra: Partial<FlashResult> = {}): FlashResult => ({ kind, mask: "MV-07B0", imageBytes: 100, diffBytes: 1, backup: "/data/projects/p/backups/b.json", ...extra });
  const view = (): DeviceConfigView => {
    const items: CfgItem[] = [
      ...Object.keys(project.params).map((refId): CfgItem => ({ kind: "param", param: { refId, name: refId, control: "number", value: project.params[refId], min: 0, max: 16000, changed: project.params[refId] !== base.params[refId] } })),
      ...Object.keys(project.links).map((refId, i): CfgItem => ({ kind: "comObject", comObject: { refId, number: refId === OBJ ? 1 : 23 + i, name: refId, functionText: "", objectSize: "1 Bit", dpt: "", flags: { read: true, write: false, comm: true, transmit: true, update: false, readOnInit: false }, gaRaw: project.links[refId][0] ?? null, gaRaws: [...project.links[refId]], changed: !same(project.links[refId], base.links[refId]) } })),
    ];
    return { blocks: [{ id: "b", name: "b", level: 0, items }], hasModules: false, capabilities: caps };
  };
  const io: InServiceIo = {
    api: {
      readBack: async () => { calls.push("read"); base = { params: { ...device.params }, links: structuredClone(device.links) }; return { paramsRead: true, linksRead: true, linkGaps: gaps() }; },
      revert: async () => { project.params = { ...base.params }; project.links = structuredClone(base.links); },
      getConfig: async () => view(),
      setParam: async (ref, value) => { project.params[ref] = value; },
      setLinks: async (ref, gas) => { project.links[ref] = [...gas]; },
      flashDry: async () => (sc.adoptDryNotUnchanged || paramsDiffer() ? result("dryRun", structural() ? { structural: true } : {}) : result("unchanged")),
      flashGaDry: async () => (linksDiffer() ? result("dryRun") : result("unchanged")),
      downloadDry: async () => result("dryRun"),
      flashReal: async () => { const st = structural(); calls.push(st ? "structuralFlash" : "flashParams"); device.params = { ...project.params }; if (sc.wrongRevert && ++paramFlashes === 2) device.params[PARAM] = "7"; return result("flashed", { verified: true, ...(st ? { structural: true } : {}) }); },
      flashGaReal: async () => { calls.push("flashLinks"); const unverified = sc.gaFlashUnverified && Object.values(project.links).some((l) => l.includes(TEST_GA)); device.links = structuredClone(project.links); return result("flashed", { verified: !unverified }); },
    },
    chan: {
      name: "api",
      setParam: async (ref, value) => { project.params[ref] = value; if (sc.sideEffect && ref === PARAM && value !== device.params[PARAM]) project.params[STRUCT] = "5"; },
      link: async (obj, ga) => { project.links[obj.refId] = [gaToNum(ga)]; },
      flashParams: async () => { if (sc.chanThrowsOnSecondParamFlash && calls.filter((c) => c === "flashParams").length === 1) { calls.push("flashParams"); device.params = { ...project.params }; throw new Error("dialog closed"); } const r = await io.api.flashReal(); return { structural: r.structural === true, result: r }; },
      flashLinks: async () => { const r = await io.api.flashGaReal(); return { structural: false, result: r }; },
      fullDownload: async () => { calls.push("fullDownload"); if (sc.downloadBreaks) throw new Error("TUNNEL_ACK_TIMEOUT: no ack"); device.params = { ...project.params }; device.links = structuredClone(project.links); return { structural: false, result: result("flashed", { verified: true }) }; },
      readBack: () => io.api.readBack(),
    },
    bus: {
      readProperty: async (o, p) => { calls.push(`prop ${o}/${p}`); const v = props[`${o}/${p}`]; return v === undefined ? null : Buffer.from(v, "hex"); },
      groupRead: async (ga) => (sc.witnessThrows && Object.values(device.links).some((l) => l.includes(gaToNum(ga))) ? Promise.reject(new Error("tunnel refused")) : sc.busUsesTestGa ? "00" : Object.values(device.links).some((l) => l.includes(gaToNum(ga))) ? (sc.answer ?? "01") : null),
      listen: async () => null,
      reboot: async () => { calls.push("restart"); if (sc.rebootThrows) throw new Error("tunnel closed"); return { reboot: { rebooted: true, detail: "silent 50 ms after A_Restart, answering again after 900 ms" }, before: new Map([[1, 1], [2, 1], [3, 1], [4, 1]]), after: new Map([[1, 1], [2, 1], [3, 1], [4, 1]]) }; },
    },
    log: () => undefined,
    settle: async () => undefined,
  };
  return { io, calls, device, start: structuredClone(device) };
}
const NO_FULL: InServiceOptions = { fullDownload: false, testGa: GA };
const WRITES = new Set(["flashParams", "flashLinks", "structuralFlash", "fullDownload", "restart"]);
const writesOf = (calls: string[]) => calls.filter((c) => WRITES.has(c));
const planned = (s: DeviceSpec, o: InServiceOptions) => planInService(s, o).filter((p) => p.kind !== "read").map((p) => (p.kind === "restart" ? "restart" : p.op!));

describe("a device in service", () => {
  test("the run makes exactly the writes its plan lists, in that order, and leaves the device as it found it", async () => {
    const { io, calls, device, start } = scripted();
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(planned(spec, NO_FULL));
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams", "flashLinks", "restart", "flashLinks"]);
    expect(device).toEqual(start);
    // The identity is read before the device is touched in any other way.
    expect(calls.slice(0, 2)).toEqual(["prop 4/13", "prop 0/25"]);
    expect(r.capabilities.map((c) => [c.capability, c.state])).toEqual([
      ["fullDownload", "unsafe"], ["flashParams", "pass"], ["flashLinks", "pass"], ["readParams", "pass"], ["readLinks", "pass"],
    ]);
    expect(r.behaviours).toEqual([{ kind: "output", label: "In Betrieb answers on the test link", state: "pass", detail: "the test address answered 0x01", gas: { object: "15/7/250" } }]);
    expect(r.persistence?.state).toBe("pass");
    expect(r.persistenceOf).toBe("flashLinks");
    expect(r.restore?.state).toBe("pass");
    expect(r.found?.params[PARAM]).toBe("1");
    expect(r.found?.links[OTHER_OBJ]).toEqual([gaToNum("2/0/10")]);
    expect(r.found?.backups.length).toBe(2);
  });

  test("another unit stops the run before the server reads or writes anything", async () => {
    const { io, calls } = scripted({ props: { "0/25": "0946" } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.stopped?.phase).toBe("fingerprint");
    expect(r.stopped?.detail).toContain("reads 0946, the spec expects 0945");
    expect(calls).toEqual(["prop 4/13", "prop 0/25"]);
  });

  test("a unit that reports no fingerprint property stops the run too", async () => {
    const { io, calls } = scripted({ props: { "4/13": undefined as unknown as string } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("fingerprint");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a configuration the project cannot take over exactly stops the run before the first write", async () => {
    const { io, calls } = scripted({ adoptDryNotUnchanged: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(writesOf(calls)).toEqual([]);
  });

  test("an object the device holds linked is refused as the link target", async () => {
    const { io, calls } = scripted({ links: { [OBJ]: [gaToNum("3/3/1")] } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("capabilities");
    expect(r.stopped?.detail).toContain("linked on the device");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a test address the device already uses is refused", async () => {
    const { io, calls } = scripted({ links: { [OTHER_OBJ]: [TEST_GA] } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.detail).toContain("already used by object");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a claimed write capability with neither a step nor a reason stops the run before the first write", async () => {
    const { io, calls } = scripted({ caps: { structuralFlash: true } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("capabilities");
    expect(r.stopped?.detail).toContain("structuralFlash");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a parameter step whose change would rewrite the com-object table is not written, and the project is set back", async () => {
    const { io, calls, device, start } = scripted({ structuralParams: [PARAM] });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("flashParams preflight");
    expect(r.stopped?.detail).toContain("structural");
    expect(writesOf(calls)).toEqual([]);
    expect(device).toEqual(start);
    expect(r.restore?.state).toBe("pass");
    // Nothing was transferred, so the stop is no flashParams result.
    expect(r.capabilities.find((c) => c.capability === "flashParams")).toBeUndefined();
  });

  test("a link flash that does not verify is undone with a GA flash, never a download", async () => {
    const { io, calls } = scripted({ gaFlashUnverified: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.stopped?.phase).toBe("flashLinks");
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams", "flashLinks", "flashLinks"]);
    expect(calls).not.toContain("fullDownload");
    expect(r.restore?.state).toBe("pass");
  });

  test("a behaviour the device does not show fails the run, and the link is still taken back", async () => {
    const { io, calls, device, start } = scripted({ answer: "00" });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.behaviours[0].state).toBe("fail");
    expect(writesOf(calls)).toEqual(planned(spec, NO_FULL));
    expect(device).toEqual(start);
  });
});

describe("the general device-in-service spec", () => {
  const full: DeviceSpec = {
    ...spec, id: "general",
    inService: { ...spec.inService!, structural: { paramRefId: STRUCT, value: "0" }, fullDownload: true },
    unsafe: [],
  };
  const allCaps = { structuralFlash: true };

  test("a full download the spec offers runs only when the operator asks for it", async () => {
    const without = scripted({ caps: allCaps, structuralParams: [STRUCT] });
    const r1 = await runInService(full, without.io, NO_FULL);
    expect(r1.ok).toBe(true);
    expect(writesOf(without.calls)).toEqual(planned(full, NO_FULL));
    expect(without.calls).not.toContain("fullDownload");
    expect(r1.capabilities.find((c) => c.capability === "fullDownload")?.state).toBe("unproven");

    const asked = scripted({ caps: allCaps, structuralParams: [STRUCT] });
    const opts = { fullDownload: true, testGa: GA };
    const r2 = await runInService(full, asked.io, opts);
    expect(r2.ok).toBe(true);
    expect(writesOf(asked.calls)).toEqual(planned(full, opts));
    expect(writesOf(asked.calls)).toEqual(["flashParams", "flashParams", "flashLinks", "restart", "flashLinks", "structuralFlash", "structuralFlash", "fullDownload"]);
    expect(r2.capabilities.filter((c) => c.state === "pass").map((c) => c.capability)).toEqual(["flashParams", "flashLinks", "structuralFlash", "fullDownload", "readParams", "readLinks"]);
    expect(asked.device).toEqual(asked.start);
  });

  test("a structural step whose dry run is surgical is refused rather than written as something else", async () => {
    const s = scripted({ caps: allCaps });
    const r = await runInService(full, s.io, NO_FULL);
    expect(r.stopped?.phase).toBe("structuralFlash preflight");
    expect(r.restore?.state).toBe("pass");
    expect(s.device).toEqual(s.start);
  });

  test("a spec with only a parameter step, and no full download on offer, persists nothing and links nothing", async () => {
    const lean: DeviceSpec = { ...spec, id: "lean", behaviours: [], inService: { fingerprint: spec.inService!.fingerprint, param: spec.inService!.param }, unsafe: [{ capability: "flashLinks", reason: "r" }, { capability: "fullDownload", reason: "r" }] };
    const s = scripted();
    const r = await runInService(lean, s.io, NO_FULL);
    expect(r.ok).toBe(true);
    expect(writesOf(s.calls)).toEqual(["flashParams", "flashParams"]);
    expect(r.persistence).toBeUndefined();
    expect(inServicePhases(lean, NO_FULL)).toEqual(["fingerprint", "adopt", "capabilities", "params", "final"]);
  });

  test("a spec step for a capability the product does not claim stops the run", async () => {
    const s = scripted();
    const r = await runInService(full, s.io, NO_FULL);
    expect(r.stopped?.detail).toContain("does not claim structuralFlash");
    expect(writesOf(s.calls)).toEqual([]);
  });

  test("specs that would write beyond their steps are refused before any run", () => {
    const bad: DeviceSpec = { ...spec, id: "bad", precondition: "erase", configure: [{ set: { paramRefId: PARAM, value: "3" } }], fuzz: { gaRange: { main: 1, mid: 1 } }, unsafe: [{ capability: "flashParams", reason: "x" }] };
    const problems = inServiceProblems(bad);
    expect(problems.some((p) => p.includes("precondition"))).toBe(true);
    expect(problems.some((p) => p.includes("configure"))).toBe(true);
    expect(problems.some((p) => p.includes("fuzz"))).toBe(true);
    expect(problems.some((p) => p.includes("flashParams has a step and is declared unsafe"))).toBe(true);
    expect(() => planInService(bad, NO_FULL)).toThrow("not fit for a device in service");
    expect(inServiceProblems({ ...spec, inService: { ...spec.inService!, fingerprint: [{ name: "v", object: 0, pid: 25, expect: "09 45" }] } })).toEqual(['fingerprint v: expect "09 45" is not lower-case hex bytes']);
  });

  test("a link step without the operator's test address stops the run before anything is read", async () => {
    const s = scripted();
    const r = await runInService(spec, s.io, { fullDownload: false });
    expect(r.stopped?.phase).toBe("spec");
    expect(r.stopped?.detail).toContain("--test-ga");
    expect(s.calls).toEqual([]);
    expect(() => planInService(spec, { fullDownload: false, testGa: "1/2" })).toThrow("is not a group address");
  });

  test("every registered device-in-service spec is fit, and no bench spec claims to be one", () => {
    for (const s of SPECS) {
      if (s.provision === "in-service") expect(inServiceProblems(s)).toEqual([]);
      else expect(s.inService).toBeUndefined();
    }
  });
});


describe("a device in service, when something goes wrong", () => {
  test("a unit whose linked objects the catalogue defaults hide is taken over by a second read-back", async () => {
    const { io, calls, device, start } = scripted({ placedWithDefaults: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(calls.slice(2, 4)).toEqual(["read", "read"]);
    expect(device).toEqual(start);
  });

  test("a link that stays unresolved under the unit's own configuration stops the run before any write", async () => {
    const { io, calls } = scripted({ hiddenEvenUnderOwnConfig: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(r.stopped?.detail).toContain("under its own configuration");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a spec ref that matches only by its end is refused before any write", async () => {
    const short: DeviceSpec = { ...spec, inService: { ...spec.inService!, param: { paramRefId: "UP-3001019_R-300101901", value: "2" } } };
    const { io, calls } = scripted();
    const r = await runInService(short, io, NO_FULL);
    expect(r.stopped?.detail).toContain("give the full ref verbatim");
    expect(writesOf(calls)).toEqual([]);
  });

  test("an edit the step did not ask for stops the run before the write that would carry it", async () => {
    const { io, calls, device, start } = scripted({ sideEffect: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("flashParams preflight");
    expect(r.stopped?.detail).toContain("more than this step");
    expect(writesOf(calls)).toEqual([]);
    expect(device).toEqual(start);
  });

  test("a channel that fails while writing the revert leaves the undo to set the parameter back", async () => {
    const { io, calls, device, start } = scripted({ chanThrowsOnSecondParamFlash: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.stopped?.detail).toContain("dialog closed");
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams"]);
    expect(r.restore?.state).toBe("pass");
    expect(device).toEqual(start);
  });

  test("a device that keeps another value after the revert fails the step on the read-back and is written back", async () => {
    const { io, calls, device, start } = scripted({ wrongRevert: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("flashParams");
    expect(r.stopped?.detail).toContain("differs from the project");
    expect(r.capabilities.find((c) => c.capability === "flashParams")?.state).toBe("fail");
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams"]);
    // The undo knows only steps still out; the revert was written, so the device keeps the wrong value
    // and the run says so instead of passing.
    expect(r.ok).toBe(false);
    expect(device).not.toEqual(start);
  });

  test("a restart that breaks off is a harness failure, not a device result, and the link is still taken back", async () => {
    const { io, calls, device, start } = scripted({ rebootThrows: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.persistence).toBeUndefined();
    expect(r.persistenceOf).toBeUndefined();
    expect(r.capabilities.find((c) => c.capability === "harness: persistence")?.state).toBe("fail");
    expect(writesOf(calls)).toEqual(planned(spec, NO_FULL));
    expect(device).toEqual(start);
  });

  test("a witness that breaks off records no behaviour, fails the run, and the link is still taken back", async () => {
    const { io, device, start } = scripted({ witnessThrows: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.behaviours).toEqual([]);
    expect(r.capabilities.some((c) => c.capability.startsWith("harness: witness"))).toBe(true);
    expect(device).toEqual(start);
  });

  test("a test address something on the bus answers on is refused before any write", async () => {
    const { io, calls } = scripted({ busUsesTestGa: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("capabilities");
    expect(r.stopped?.detail).toContain("answers or sends on the test address");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a full download that breaks off is reported as a restore failure, never retried or undone by another download", async () => {
    const offer: DeviceSpec = { ...spec, id: "offer", inService: { ...spec.inService!, fullDownload: true }, unsafe: [] };
    const { io, calls } = scripted({ downloadBreaks: true });
    const r = await runInService(offer, io, { fullDownload: true, testGa: GA });
    expect(r.stopped?.phase).toBe("fullDownload");
    expect(calls.filter((c) => c === "fullDownload")).toEqual(["fullDownload"]);
    expect(r.restore?.state).toBe("fail");
    expect(r.restore?.detail).toContain("unloaded");
  });

  test("a spec without any step is refused", () => {
    expect(inServiceProblems({ ...spec, behaviours: [], inService: { fingerprint: spec.inService!.fingerprint } })).toContain("no step: the run would write nothing and prove nothing");
  });
});

describe("evidence of a device-in-service run", () => {
  const cond: RunConditions = {
    server: { version: "v0.0.0", commit: "abc1234" }, runnerRevision: "abc1234",
    transport: { kind: "ip-tcp", via: "direct" }, firmware: { state: "unknown" },
    source: { artifact: "tools/smoke/reports/x.json", sha256: "a".repeat(64) },
  };
  test("records name the device's own configuration, and persistence only on the write it covered", async () => {
    const { io } = scripted();
    const r = await runInService(spec, io, NO_FULL);
    const records = runEvidence({ spec: spec.id, channel: "api", startedAt: Date.parse("2000-01-01T00:00:00Z"), clickThrough: { state: "not-applicable", detail: "" }, ...r }, spec, cond);
    expect(records.map((x) => [x.scope.operation, x.results.transfer.state, x.results.behaviour.state, x.results.persistence.state])).toEqual([
      ["flashParams", "pass", "not-assessed", "not-assessed"],
      ["flashLinks", "pass", "not-assessed", "pass"],
      ["readParams", "pass", "not-assessed", "not-assessed"],
      ["readLinks", "pass", "not-assessed", "not-assessed"],
      ["flashLinks", "not-assessed", "pass", "not-assessed"],
    ]);
    expect(records[0].scope.configuration).toBe("the device's own configuration, taken over by read-back, then the flashParams driver's own change");
    expect(records[0].origin).toEqual({ configuredBy: "unknown", reference: "self-written", priorBusforgeWrites: "unknown" });
    expect(JSON.stringify(records)).not.toContain(GA);
  });
});
