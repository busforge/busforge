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
// A parameter without a memory location: no read-back sees it, and its catalogue default ("1") hides
// an object the unit links.
const MEMLESS = "M-00FA_A-A012-55-0000_UP-3001009_R-300100901";
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
  noReadFlag?: boolean;                      // the link step's object has no read flag
  memoryless?: string;                       // the value of MEMLESS the unit runs (its links resolve only under it)
}

function scripted(sc: Script = {}) {
  const calls: string[] = [];
  const device: { params: Record<string, string>; links: Record<string, number[]> } = { params: { [PARAM]: "1", [STRUCT]: "1", ...sc.params }, links: { [OBJ]: [], [OTHER_OBJ]: [gaToNum("2/0/10")], ...sc.links } };
  const project: { params: Record<string, string>; links: Record<string, number[]> } = { params: { ...device.params, ...(sc.placedWithDefaults ? { [STRUCT]: "0" } : {}), ...(sc.memoryless ? { [MEMLESS]: "1" } : {}) }, links: structuredClone(device.links) };
  // The server counts a device link on an object the project's parameters hide as unresolved.
  const memlessWrong = (v = project.params[MEMLESS]) => sc.memoryless !== undefined && v !== sc.memoryless;
  const gaps = () => (sc.hiddenEvenUnderOwnConfig ? 1 : 0) + (project.params[STRUCT] !== device.params[STRUCT] ? 1 : 0) + (memlessWrong() ? 1 : 0);
  // A read-back leaves the baseline of MEMLESS as it was; only an accepted assumption sets it.
  let memlessBase = sc.memoryless ? "1" : undefined;
  const withMemless = (p: Record<string, string>) => (memlessBase === undefined ? p : { ...p, [MEMLESS]: memlessBase });
  let base = { params: withMemless({ ...device.params }), links: structuredClone(device.links) as Record<string, number[]> };
  let paramFlashes = 0;
  // The step's object on the device after each GA flash.
  const objOnDevice: number[][] = [];
  const caps: DeviceCapabilities = { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: false, ...sc.caps };
  const props: Record<string, string> = { "4/13": "00faa01255", "0/25": "0945", ...sc.props };
  const same = (a: number[] = [], b: number[] = []) => a.length === b.length && a.every((g, i) => g === b[i]);
  const paramsDiffer = () => Object.keys(project.params).some((k) => (k === MEMLESS ? memlessWrong() : project.params[k] !== device.params[k]));
  const linksDiffer = () => Object.keys(project.links).some((k) => !same(project.links[k], device.links[k]));
  const structural = () => Object.keys(project.params).some((k) => project.params[k] !== device.params[k] && (sc.structuralParams ?? []).includes(k));
  const result = (kind: FlashResult["kind"], extra: Partial<FlashResult> = {}): FlashResult => ({ kind, mask: "MV-07B0", imageBytes: 100, diffBytes: 1, backup: "/data/projects/p/backups/b.json", ...extra });
  const view = (): DeviceConfigView => {
    const items: CfgItem[] = [
      ...Object.keys(project.params).map((refId): CfgItem => ({ kind: "param", param: { refId, name: refId, control: "number", value: project.params[refId], min: 0, max: 16000, changed: project.params[refId] !== base.params[refId] } })),
      ...Object.keys(project.links).map((refId, i): CfgItem => ({ kind: "comObject", comObject: { refId, number: refId === OBJ ? 1 : 23 + i, name: refId, functionText: "", objectSize: "1 Bit", dpt: "", flags: { read: !(sc.noReadFlag && refId === OBJ), write: false, comm: true, transmit: true, update: false, readOnInit: false }, priority: "Low", gaRaw: project.links[refId][0] ?? null, gaRaws: [...project.links[refId]], changed: !same(project.links[refId], base.links[refId]) } })),
    ];
    return { blocks: [{ id: "b", name: "b", level: 0, items }], hasModules: false, capabilities: caps };
  };
  const io: InServiceIo = {
    api: {
      readBack: async (assume) => {
        calls.push("read");
        for (const a of assume ?? []) {
          if (a.paramRefId !== MEMLESS) throw Object.assign(new Error(`${a.paramRefId} has a memory location`), { code: "READBACK_ASSUMPTION_HAS_MEMORY" });
          if (memlessWrong(a.value)) throw Object.assign(new Error("under the assumed values the device's configuration still shows no object for its links on object(s) 1"), { code: "READBACK_ASSUMPTION_UNRESOLVED" });
        }
        for (const a of assume ?? []) { project.params[MEMLESS] = a.value; memlessBase = a.value; }
        base = { params: withMemless({ ...device.params }), links: structuredClone(device.links) };
        const n = gaps();
        return { paramsRead: true, linksRead: true, linkGaps: n, ...(n ? { unresolvedObjects: [1] } : {}) };
      },
      revert: async () => { project.params = { ...base.params }; project.links = structuredClone(base.links); },
      getConfig: async () => view(),
      setParam: async (ref, value) => { project.params[ref] = value; },
      ensureGa: async () => undefined,
      setLinks: async (ref, gas) => { project.links[ref] = [...gas]; },
      flashDry: async () => (sc.adoptDryNotUnchanged || paramsDiffer() ? result("dryRun", structural() ? { structural: true } : {}) : result("unchanged")),
      // As the server's flash-ga route: a pending parameter change that alters the com-object table
      // makes it the structural flash.
      flashGaDry: async () => (structural() ? result("dryRun", { structural: true }) : linksDiffer() ? result("dryRun") : result("unchanged")),
      downloadDry: async () => result("dryRun"),
      flashReal: async () => { const st = structural(); calls.push(st ? "structuralFlash" : "flashParams"); device.params = Object.fromEntries(Object.entries(project.params).filter(([k]) => k !== MEMLESS)); if (sc.wrongRevert && ++paramFlashes === 2) device.params[PARAM] = "7"; return result("flashed", { verified: true, ...(st ? { structural: true } : {}) }); },
      flashGaReal: async () => { calls.push("flashLinks"); const unverified = sc.gaFlashUnverified && Object.values(project.links).some((l) => l.includes(TEST_GA)); device.links = structuredClone(project.links); objOnDevice.push([...device.links[OBJ]]); return result("flashed", { verified: !unverified }); },
    },
    chan: {
      name: "api",
      setParam: async (ref, value) => { project.params[ref] = value; if (sc.sideEffect && ref === PARAM && value !== device.params[PARAM]) project.params[STRUCT] = "5"; },
      link: async (obj, ga) => { project.links[obj.refId] = [gaToNum(ga)]; },
      addLink: async (obj, ga, own) => { calls.push("chan.addLink"); project.links[obj.refId] = [...own, gaToNum(ga)]; },
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
  return { io, calls, device, start: structuredClone(device), objOnDevice };
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
    expect(inServiceProblems({ ...spec, inService: { ...spec.inService!, fingerprint: [spec.inService!.fingerprint[0], { name: "v", object: 0, pid: 25, expect: "09 45" }] } })).toEqual(['fingerprint v: expect "09 45" is not lower-case hex bytes']);
  });

  test("a link step without the operator's test address stops the run before anything is read", async () => {
    const s = scripted();
    const r = await runInService(spec, s.io, { fullDownload: false });
    expect(r.stopped?.phase).toBe("spec");
    expect(r.stopped?.detail).toContain("--test-ga");
    expect(s.calls).toEqual([]);
    expect(() => planInService(spec, { fullDownload: false, testGa: "1/2" })).toThrow("is not a group address");
  });

  test("no spec is registered twice, and no two specs share an id", () => {
    expect(SPECS.filter((s, i) => SPECS.indexOf(s) !== i).map((s) => s.id)).toEqual([]);
    const ids = SPECS.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
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

describe("a device in service: the test address added to a linked object", () => {
  const OWN = gaToNum("2/0/1");
  const add: DeviceSpec = { ...spec, id: "add", inService: { ...spec.inService!, link: { comObjRefId: OBJ, addToLinked: true } } };

  test("the object keeps its own address while the test address is placed behind it, and holds exactly its own afterwards", async () => {
    const { io, calls, device, start, objOnDevice } = scripted({ links: { [OBJ]: [OWN] } });
    const r = await runInService(add, io, NO_FULL);
    expect(r.stopped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(planned(add, NO_FULL));
    expect(objOnDevice).toEqual([[OWN, TEST_GA], [OWN]]);
    expect(device).toEqual(start);
    // The addition goes through the channel under test (the device page's editor on the ui channel).
    expect(calls.filter((c) => c === "chan.addLink")).toHaveLength(1);
    expect(r.behaviours.map((b) => b.state)).toEqual(["pass"]);
    expect(r.capabilities.find((c) => c.capability === "flashLinks")?.detail).toContain("beside its 1 own address(es), own sending address first");
    const plan = planInService(add, NO_FULL).map((p) => p.text).join("\n");
    expect(plan).toContain("gets 15/7/250 added behind its own addresses");
    expect(plan).toContain("lies above every address of the object");
  });

  // The scripted read-back keeps the project's order, the server's keeps each object's first address
  // first and sorts the others; the two agree because the test address must lie above the object's own.
  test("an object with several own addresses keeps all of them, in their order, beside another object's", async () => {
    const own = [gaToNum("2/0/1"), gaToNum("3/0/1")];
    const { io, calls, device, start, objOnDevice } = scripted({ links: { [OBJ]: own, [OTHER_OBJ]: [gaToNum("4/0/1")] } });
    const r = await runInService(add, io, NO_FULL);
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(planned(add, NO_FULL));
    expect(objOnDevice).toEqual([[...own, TEST_GA], own]);
    expect(device).toEqual(start);
  });

  test("an object the device holds unlinked is refused, since the step was written for a linked one", async () => {
    const { io, calls } = scripted();
    const r = await runInService(add, io, NO_FULL);
    expect(r.stopped?.phase).toBe("capabilities");
    expect(r.stopped?.detail).toContain("is unlinked on the device");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a test address below one the object holds is refused, so the object keeps sending on its own", async () => {
    const { io, calls } = scripted({ links: { [OBJ]: [gaToNum("15/7/251")] } });
    const r = await runInService(add, io, NO_FULL);
    expect(r.stopped?.phase).toBe("capabilities");
    expect(r.stopped?.detail).toContain("lies below an address object 1 holds");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a link flash that does not verify is undone to the object's own address, never a download", async () => {
    const { io, calls, device, start, objOnDevice } = scripted({ links: { [OBJ]: [OWN] }, gaFlashUnverified: true });
    const r = await runInService(add, io, NO_FULL);
    expect(r.stopped?.phase).toBe("flashLinks");
    expect(calls).not.toContain("fullDownload");
    expect(objOnDevice.at(-1)).toEqual([OWN]);
    expect(r.restore?.state).toBe("pass");
    expect(device).toEqual(start);
  });

  test("a heartbeat cannot witness an address added behind the object's own", () => {
    const hb: DeviceSpec = { ...add, behaviours: [{ kind: "heartbeat", label: "hb", comObjRefId: OBJ, windowMs: 1000 }] };
    expect(inServiceProblems(hb).some((p) => p.includes("sends on its first address only"))).toBe(true);
  });

  test("an output witness on an object without the read flag is refused before any write", async () => {
    const { io, calls } = scripted({ noReadFlag: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("capabilities");
    expect(r.stopped?.detail).toContain("no read flag");
    expect(writesOf(calls)).toEqual([]);
  });
});

describe("a device in service: expected parameter values", () => {
  const withExpect = (value: string, paramRefId = STRUCT): DeviceSpec => ({ ...spec, id: "expect", inService: { ...spec.inService!, expectParams: [{ name: "module type", paramRefId, value }] } });

  test("a configuration holding the expected values runs as before", async () => {
    const s = withExpect("1");
    const { io, calls, device, start } = scripted();
    const r = await runInService(s, io, NO_FULL);
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(planned(s, NO_FULL));
    expect(device).toEqual(start);
    expect(planInService(s, NO_FULL).find((p) => p.phase === "adopt")?.text).toContain("(module type) = 1");
  });

  test("another value stops the run after the adoption and before the first write or bus probe", async () => {
    const { io, calls } = scripted();
    const r = await runInService(withExpect("6"), io, NO_FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(r.stopped?.detail).toBe("module type: the device holds 1, the spec expects 6: not the unit or configuration this spec was written for");
    expect(writesOf(calls)).toEqual([]);
    expect(r.restore).toBeUndefined();
  });

  test("an expected parameter the configuration does not show, or names only by its end, stops the run", async () => {
    const missing = scripted();
    expect((await runInService(withExpect("1", `${STRUCT}9`), missing.io, NO_FULL)).stopped?.detail).toContain("is not visible");
    const tail = scripted();
    expect((await runInService(withExpect("1", "UP-3001008_R-300100801"), tail.io, NO_FULL)).stopped?.detail).toContain("give the full ref verbatim");
    expect(writesOf([...missing.calls, ...tail.calls])).toEqual([]);
  });

  test("an expected value without a name or value is refused", () => {
    expect(inServiceProblems(withExpect(""))).toEqual(["expectParams: an entry needs a name, a paramRefId and a value (module type)"]);
  });

  test("a parameter expected twice is refused", () => {
    const twice: DeviceSpec = { ...spec, inService: { ...spec.inService!, expectParams: [{ name: "a", paramRefId: STRUCT, value: "1" }, { name: "b", paramRefId: STRUCT, value: "2" }] } };
    expect(inServiceProblems(twice)).toEqual([`expectParams names ${STRUCT} more than once`]);
  });
});

describe("a device in service: the fingerprint each family gives", () => {
  const system7 = (fingerprint: NonNullable<DeviceSpec["inService"]>["fingerprint"], mask = "MV-0705"): DeviceSpec =>
    ({ ...spec, device: { ...spec.device, mask }, inService: { ...spec.inService!, fingerprint } });
  const APP7 = { name: "application id", object: 3, pid: 13, expect: "0081fe0111" };

  test("System 7: the application id on object 3 and the firmware revision (PID 9)", () => {
    expect(inServiceProblems(system7([APP7, { name: "firmware", object: 0, pid: 9, expect: "06" }]))).toEqual([]);
  });

  test("System 7: PID 25, which its units refuse, is refused, and so is the application id on another object", () => {
    expect(inServiceProblems(system7([{ ...APP7, object: 4 }, { name: "version", object: 0, pid: 25, expect: "0945" }]))).toEqual([
      "the fingerprint lacks the application id: on system-7 it is object 3 PID 13",
      "the fingerprint lacks the version: on system-7 it is object 0 PID 9",
      "object 0 PID 25: system-7 units refuse it, the version is object 0 PID 9",
    ]);
  });

  test("System B: the application id on object 4 and the version (PID 25); PID 9 is refused", () => {
    expect(inServiceProblems(spec)).toEqual([]);
    const withPid9: DeviceSpec = { ...spec, inService: { ...spec.inService!, fingerprint: [...spec.inService!.fingerprint, { name: "firmware", object: 0, pid: 9, expect: "01" }] } };
    expect(inServiceProblems(withPid9)).toEqual(["object 0 PID 9: system-b units refuse it, the version is object 0 PID 25"]);
  });

  test("a family without a rule is refused rather than guessed", () => {
    expect(inServiceProblems(system7([APP7, { name: "firmware", object: 0, pid: 9, expect: "06" }], "MV-0012"))).toEqual([
      "no fingerprint rule for mask MV-0012 (family system-1); add one to FINGERPRINT_RULES from a read-only collection of a unit",
    ]);
    expect(inServiceProblems(system7([APP7], "MV-0700"))).toEqual(["mask MV-0700 declares no interface object carrying the application id, so the fingerprint cannot name the application"]);
  });
});

describe("a device in service: parameters without a memory location", () => {
  const withAssume = (value: string, paramRefId = MEMLESS): DeviceSpec => ({ ...spec, id: "assume", inService: { ...spec.inService!, assumeParams: [{ name: "rocker function", paramRefId, value }] } });

  test("read back alone, the unit's link stays unresolved and the run says which object and what to give", async () => {
    const { io, calls } = scripted({ memoryless: "2" });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(r.stopped?.detail).toBe("1 association(s) of the device did not resolve under its own configuration (object(s) 1); a GA flash would drop them. A parameter without a memory location may hide their objects: give its value in assumeParams");
    expect(writesOf(calls)).toEqual([]);
  });

  test("with the unit's value assumed, the run takes it over and runs as planned", async () => {
    const s = withAssume("2");
    const { io, calls, device, start } = scripted({ memoryless: "2" });
    const r = await runInService(s, io, NO_FULL);
    expect(r.stopped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(planned(s, NO_FULL));
    expect(device).toEqual(start);
    expect(r.found?.params[MEMLESS]).toBe("2");
    expect(planInService(s, NO_FULL).find((p) => p.phase === "adopt")?.text).toContain("assuming UP-3001009_R-300100901 (rocker function) = 2");
  });

  test("another value is refused by the read-back, before any write", async () => {
    const { io, calls } = scripted({ memoryless: "2" });
    const r = await runInService(withAssume("3"), io, NO_FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(r.stopped?.detail).toContain("READBACK_ASSUMPTION_UNRESOLVED");
    expect(r.stopped?.detail).toContain("object(s) 1");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a parameter with a memory location is refused by the read-back, before any write", async () => {
    const { io, calls } = scripted({ memoryless: "2" });
    const r = await runInService(withAssume("1", STRUCT), io, NO_FULL);
    expect(r.stopped?.detail).toContain("READBACK_ASSUMPTION_HAS_MEMORY");
    expect(writesOf(calls)).toEqual([]);
  });

  test("an assumed parameter named twice, without a value, also expected, or a step's own, is refused before any run", () => {
    const base = spec.inService!;
    const a = { name: "f", paramRefId: MEMLESS, value: "2" };
    expect(inServiceProblems({ ...spec, inService: { ...base, assumeParams: [a, a] } })).toEqual([`assumeParams names ${MEMLESS} more than once`]);
    expect(inServiceProblems({ ...spec, inService: { ...base, assumeParams: [{ ...a, value: "" }] } })).toEqual(["assumeParams: an entry needs a name, a paramRefId and a value (f)"]);
    expect(inServiceProblems({ ...spec, inService: { ...base, assumeParams: [a], expectParams: [a] } })).toEqual([`${MEMLESS} is both assumed and expected; an assumed value is the one the run takes over`]);
    expect(inServiceProblems({ ...spec, inService: { ...base, assumeParams: [{ ...a, paramRefId: PARAM }] } })).toEqual([`${PARAM} is assumed and a step's parameter; a step writes a parameter with a memory location`]);
  });
});
