import { test, expect, describe } from "bun:test";
import { gaToNum } from "../../packages/knx/src/index.ts";
import type { CfgItem, DeviceCapabilities, DeviceConfigView } from "../../packages/product/src/index.ts";
import type { FlashResult } from "./client.ts";
import { runInService, planInService, inServiceProblems, inServicePhases, whatResolves, type InServiceIo, type InServiceOptions } from "./inservice.ts";
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
  answersOnReadAddress?: boolean;            // the object answers a read of an added address there, not on its first
  foreignReadOfOwn?: boolean;                // another client reads one of the object's own addresses while the witness waits
  answersWithoutTestAddress?: boolean;       // the object's first address answers the witness's read even once the test address is gone
  controlRead?: "throws" | "unattributable"; // the witness's control read after the removal cannot decide
  unlinkThrows?: boolean;                    // the GA flash that takes the test address back breaks off
  sideEffect?: boolean;                      // setting the step's parameter also changes another one
  chanThrowsOnSecondParamFlash?: boolean;    // the channel fails while writing the revert
  rebootThrows?: boolean;
  rebootUnproven?: boolean;
  unloadedAfterReboot?: boolean;
  witnessThrows?: boolean;
  downloadBreaks?: boolean;                  // the full download writes and then breaks off
  wrongRevert?: boolean;                     // the device keeps another value after the revert
  busUsesTestGa?: boolean;                   // another device answers on the test address
  placedWithDefaults?: boolean;              // the fresh project shows the catalogue defaults, which hide a linked object
  hiddenEvenUnderOwnConfig?: boolean;        // a link no configuration of the unit places
  unknownLinks?: boolean;                    // a link the read cannot tell what places
  noReadFlag?: boolean;                      // the link step's object has no read flag
  memoryless?: string;                       // the value of MEMLESS the unit runs (its links resolve only under it)
  flagsNotTaken?: { flagsUnreadable?: string; flagsUndecoded?: number[] }; // the read-back could not take the com-object table's flags
  route?: { interfaceIa: string | null; interfaceSerial: string | null; tunnelIa: string }; // what the interface reports for itself
  mem?: Record<number, string>;              // device memory by address, hex
  system1?: boolean;                         // a System 1 unit: no GA flash, a download that always writes, a run error byte
  runErrorAfter?: number;                    // the run error byte after the reboot
  gaInProject?: boolean;                     // the project already holds the test address
  // A field the unit stores and reads as FF (the MDT IP Interface/Router's web interface password): every
  // parameter dry run differs there, named in readsFF; a parameter write rests there on its confirmation
  // alone, unless `givenBack` (the unit returns the bytes once written: it held FF, not the project's value).
  // `leftAfterFirst`: after the first parameter write the dry runs and writes leave the bytes
  // (FlashResult.leftFF), the project's value there being the one the first wrote, as the server does once
  // the write has set its baseline. `leftAlways`: every write leaves them, the first included.
  writeOnly?: { at: number; length: number; givenBack?: boolean; moreDiffers?: boolean; leftAfterFirst?: boolean; leftAlways?: boolean };
}

function scripted(sc: Script = {}) {
  let controlReads = 0;
  const calls: string[] = [];
  const device: { params: Record<string, string>; links: Record<string, number[]> } = { params: { [PARAM]: "1", [STRUCT]: "1", ...sc.params }, links: { [OBJ]: [], [OTHER_OBJ]: [gaToNum("2/0/10")], ...sc.links } };
  const project: { params: Record<string, string>; links: Record<string, number[]> } = { params: { ...device.params, ...(sc.placedWithDefaults ? { [STRUCT]: "0" } : {}), ...(sc.memoryless ? { [MEMLESS]: "1" } : {}) }, links: structuredClone(device.links) };
  // The server counts a device link on an object the project's parameters hide as unresolved.
  const memlessWrong = (v = project.params[MEMLESS]) => sc.memoryless !== undefined && v !== sc.memoryless;
  // The server's split of the unresolved links: object 1 unplaced while MEMLESS is wrong, 2 hidden by the
  // project's STRUCT, 3 unplaced under any configuration, 4 unknown.
  const split = () => {
    const unplaced = [...(memlessWrong() ? [1] : []), ...(sc.hiddenEvenUnderOwnConfig ? [3] : [])];
    const hidden = project.params[STRUCT] !== device.params[STRUCT] ? [2] : [];
    // Where the read cannot tell, every unresolved link is unknown and none is split further.
    if (sc.unknownLinks) return { unplaced: [], hidden: [], unknown: [4], all: [4] };
    return { unplaced, hidden, unknown: [] as number[], all: [...unplaced, ...hidden].sort((a, b) => a - b) };
  };
  const gaps = () => split().all.length;
  // A read-back leaves the baseline of MEMLESS as it was; only an accepted assumption sets it.
  let memlessBase = sc.memoryless ? "1" : undefined;
  const withMemless = (p: Record<string, string>) => (memlessBase === undefined ? p : { ...p, [MEMLESS]: memlessBase });
  let base = { params: withMemless({ ...device.params }), links: structuredClone(device.links) as Record<string, number[]> };
  let paramFlashes = 0;
  let paramWrites = 0;
  // The step's object on the device after each GA flash.
  const objOnDevice: number[][] = [];
  const caps: DeviceCapabilities = { readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: false, ...sc.caps };
  const props: Record<string, string> = { "4/13": "00faa01255", "0/25": "0945", ...sc.props };
  const same = (a: number[] = [], b: number[] = []) => a.length === b.length && a.every((g, i) => g === b[i]);
  const paramsDiffer = () => Object.keys(project.params).some((k) => (k === MEMLESS ? memlessWrong() : project.params[k] !== device.params[k]));
  const linksDiffer = () => Object.keys(project.links).some((k) => !same(project.links[k], device.links[k]));
  const structural = () => Object.keys(project.params).some((k) => project.params[k] !== device.params[k] && (sc.structuralParams ?? []).includes(k));
  const result = (kind: FlashResult["kind"], extra: Partial<FlashResult> = {}): FlashResult => ({ kind, mask: "MV-07B0", imageBytes: 100, diffBytes: 1, backup: "/data/projects/p/backups/b.json", ...extra });
  // System 1's download is written whatever it finds: its dry run says how many bytes differ.
  const sys1Dry = (): FlashResult => result("dryRun", { alwaysWrite: true, diffBytes: sc.adoptDryNotUnchanged || paramsDiffer() ? 3 : 0 });
  const plain: string[] = [];
  const ffRange = sc.writeOnly ? [{ address: sc.writeOnly.at, length: sc.writeOnly.length }] : undefined;
  const ffDry = (r: FlashResult): FlashResult => (!ffRange ? r
    : sc.writeOnly!.leftAfterFirst && paramWrites > 0 ? { ...r, leftFF: ffRange }
    : { ...r, kind: "dryRun", diffBytes: (r.kind === "dryRun" ? r.diffBytes! : 0) + ffRange[0].length + (sc.writeOnly!.moreDiffers ? 1 : 0), readsFF: ffRange });
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
        const sp = split();
        return {
          paramsRead: true, linksRead: true, linkGaps: n,
          ...(n ? { unresolvedObjects: sp.all, ...(sp.unplaced.length ? { unplacedObjects: sp.unplaced } : {}), ...(sp.hidden.length ? { hiddenObjects: sp.hidden } : {}), ...(sp.unknown.length ? { unknownObjects: sp.unknown } : {}) } : {}),
          flagsRead: !sc.flagsNotTaken?.flagsUnreadable, ...sc.flagsNotTaken,
        };
      },
      revert: async () => { project.params = { ...base.params }; project.links = structuredClone(base.links); },
      getConfig: async () => view(),
      setParam: async (ref, value) => { project.params[ref] = value; },
      ensureGa: async () => undefined,
      hasGa: async (ga) => sc.gaInProject === true && ga === GA,
      setGaPlain: async (ga) => { plain.push(ga); },
      setLinks: async (ref, gas) => { project.links[ref] = [...gas]; },
      flashDry: async () => ffDry(sc.system1 ? sys1Dry() : sc.adoptDryNotUnchanged || paramsDiffer() ? result("dryRun", structural() ? { structural: true } : {}) : result("unchanged")),
      // As the server's flash-ga route: a pending parameter change that alters the com-object table
      // makes it the structural flash.
      flashGaDry: async () => { if (sc.system1) throw Object.assign(new Error("no capture shows a System 1 group-address download"), { code: "SYSTEM1_GROUP_TABLES_UNCAPTURED" }); return structural() ? result("dryRun", { structural: true }) : linksDiffer() ? result("dryRun") : result("unchanged"); },
      downloadDry: async () => (sc.system1 ? sys1Dry() : result("dryRun")),
      flashReal: async () => { const st = structural(); calls.push(st ? "structuralFlash" : "flashParams"); device.params = Object.fromEntries(Object.entries(project.params).filter(([k]) => k !== MEMLESS)); if (sc.wrongRevert && ++paramFlashes === 2) device.params[PARAM] = "7"; return result("flashed", { verified: true, ...(st ? { structural: true } : {}), ...(ffRange && !sc.writeOnly!.givenBack ? (sc.writeOnly!.leftAlways || (sc.writeOnly!.leftAfterFirst && ++paramWrites > 1) ? { leftFF: ffRange } : { confirmedOnly: ffRange }) : {}) }); },
      flashGaReal: async () => { if (sc.unlinkThrows && calls.includes("flashLinks")) throw new Error("TUNNEL_ACK_TIMEOUT: no ack"); calls.push("flashLinks"); const unverified = sc.gaFlashUnverified && Object.values(project.links).some((l) => l.includes(TEST_GA)); device.links = structuredClone(project.links); objOnDevice.push([...device.links[OBJ]]); return result("flashed", { verified: !unverified }); },
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
      readMemory: async (address, length) => { calls.push(`mem ${address.toString(16)}`); const v = sc.mem?.[address]; if (v === undefined) throw new Error("no such memory"); return Buffer.from(v, "hex").subarray(0, length); },
      route: async () => { calls.push("route"); return sc.route ?? { interfaceIa: "1.1.250", interfaceSerial: "00fa00000001", tunnelIa: "1.1.251" }; },
      groupRead: async (ga) => (sc.witnessThrows && Object.values(device.links).some((l) => l.includes(gaToNum(ga))) ? Promise.reject(new Error("tunnel refused")) : sc.busUsesTestGa ? "00" : Object.values(device.links).some((l) => l.includes(gaToNum(ga))) ? (sc.answer ?? "01") : null),
      // As findings.md §36: the object holding the read address answers on its first association.
      groupReadAnsweredOn: async (readGa, ownGas) => {
        if (sc.witnessThrows) throw new Error("tunnel refused");
        if (sc.controlRead && ++controlReads === 2) { if (sc.controlRead === "throws") throw new Error("tunnel refused"); return { value: null, unattributable: true }; }
        const holder = Object.values(device.links).find((l) => l.includes(gaToNum(readGa)));
        const answers = (sc.answersWithoutTestAddress || (holder !== undefined && !sc.answersOnReadAddress)) && (holder ?? device.links[OBJ])[0] === gaToNum(ownGas[0]);
        return { value: answers ? (sc.answer ?? "01") : null, unattributable: sc.foreignReadOfOwn === true };
      },
      listen: async () => null,
      reboot: async () => {
        calls.push("restart");
        if (sc.rebootThrows) throw new Error("tunnel closed");
        const reboot = sc.rebootUnproven
          ? { rebooted: false, unproven: true as const, detail: "the reboot cannot be seen" }
          : { rebooted: true, detail: "silent 50 ms after A_Restart, answering again after 900 ms" };
        if (sc.system1) return { reboot, runError: { before: 0xff, after: sc.runErrorAfter ?? 0xff } };
        return { reboot, before: new Map([[1, 1], [2, 1], [3, 1], [4, 1]]), after: new Map([[1, 1], [2, 1], [3, 1], [4, sc.unloadedAfterReboot ? 0 : 1]]) };
      },
    },
    log: () => undefined,
    settle: async () => undefined,
  };
  return { io, calls, device, start: structuredClone(device), objOnDevice, plain };
}
const NO_FULL: InServiceOptions = { fullDownload: false, testGa: GA };
const WRITES = new Set(["flashParams", "flashLinks", "structuralFlash", "fullDownload", "restart"]);
const writesOf = (calls: string[]) => calls.filter((c) => WRITES.has(c));
const planned = (s: DeviceSpec, o: InServiceOptions) => planInService(s, o).filter((p) => p.kind !== "read").map((p) => (p.kind === "restart" ? "restart" : p.op!));

describe("a unit with a field it does not give back", () => {
  const FF = { at: 0x1512, length: 20 };

  test("the adoption takes a parameter dry run that differs only where the unit reads FF, names the bytes, and each parameter write shows them on its confirmation alone", async () => {
    const { io, calls, device, start } = scripted({ writeOnly: FF });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams", "flashLinks", "restart", "flashLinks"]);
    expect(r.found?.readsFF).toEqual([{ address: 0x1512, length: 20 }]);
    expect(r.capabilities.find((c) => c.capability === "flashParams")?.detail).toContain("verified, 0x1512-0x1525 written from the project on the write confirmation alone");
    expect(r.restore).toEqual({ state: "pass", detail: "the device holds the configuration it was found with: parameter flash dry run differs only at the bytes taken as not given back (0x1512-0x1525), which the run's parameter writes set to the project's value: what the unit held there before is not known, GA flash dry run unchanged" });
    expect(device).toEqual(start);
  });

  test("a parameter write that leaves the bytes after the first wrote them passes, and says so", async () => {
    const { io, calls, device, start } = scripted({ writeOnly: { ...FF, leftAfterFirst: true } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams", "flashLinks", "restart", "flashLinks"]);
    const detail = r.capabilities.find((c) => c.capability === "flashParams")?.detail;
    expect(detail).toContain("0x1512-0x1525 written from the project on the write confirmation alone)");
    expect(detail).toContain("0x1512-0x1525 left alone, unchanged since the last programming");
    expect(r.restore?.detail).toContain("parameter flash dry run unchanged, leaving the bytes taken as not given back (0x1512-0x1525), which the run's parameter writes set to the project's value: what the unit held there before is not known");
    expect(device).toEqual(start);
  });

  test("an undo after the first parameter write wrote the bytes says they hold the project's value", async () => {
    const { io } = scripted({ writeOnly: { ...FF, leftAfterFirst: true }, chanThrowsOnSecondParamFlash: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("flashParams");
    expect(r.restore?.state).toBe("pass");
    expect(r.restore?.detail).toContain("leaving the bytes taken as not given back (0x1512-0x1525), which the run's parameter write set to the project's value: what the unit held there before is not known");
  });

  test("a first parameter write that leaves the bytes stops the run: nothing shows them as not given back", async () => {
    const { io, calls } = scripted({ writeOnly: { ...FF, leftAlways: true } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("flashParams");
    expect(r.stopped?.detail).toContain("the run's first write that reached them left them alone");
    expect(writesOf(calls)[0]).toBe("flashParams");
  });

  test("a parameter write that reads the bytes back stops the run: the unit held FF there, not the configuration taken over", async () => {
    const { io, calls } = scripted({ writeOnly: { ...FF, givenBack: true } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.stopped?.phase).toBe("flashParams");
    expect(r.stopped?.detail).toContain("took the bytes at 0x1512-0x1525 as not given back by the unit, but this write read every byte back");
    expect(r.stopped?.detail).toContain("now holds the project's value there; the value found is in the server's backups");
    // The undo writes the step's parameter back; its write reads the bytes back as well, and says so.
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams"]);
    expect(r.restore?.state).toBe("fail");
    expect(r.restore?.detail).toContain("parameter revert: the adoption took the bytes at 0x1512-0x1525 as not given back");
  });

  test("a dry run that differs beyond the bytes read as FF stops the adoption", async () => {
    const { io, calls } = scripted({ writeOnly: { ...FF, moreDiffers: true } });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(r.stopped?.detail).toContain("the parameter flash dry run reports dryRun with 21 differing byte(s) (read as FF at 0x1512-0x1525)");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a spec without a parameter write cannot show the bytes, so the adoption stops", async () => {
    const noParam: DeviceSpec = { ...spec, inService: { ...spec.inService!, param: undefined } };
    const { io, calls } = scripted({ writeOnly: FF });
    const r = await runInService(noParam, io, NO_FULL);
    expect(r.stopped).toEqual({ phase: "adopt", detail: "the parameter flash dry run differs only where the unit reads FF (0x1512-0x1525), and this spec has no parameter write that would show them as bytes the unit does not give back" });
    expect(writesOf(calls)).toEqual([]);
  });
});

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
    expect(calls.slice(0, 3)).toEqual(["route", "prop 4/13", "prop 0/25"]);
    expect(r.capabilities.map((c) => [c.capability, c.state])).toEqual([
      ["fullDownload", "unproven"], ["flashParams", "pass"], ["flashLinks", "pass"], ["readParams", "pass"], ["readLinks", "pass"],
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
    expect(calls).toEqual(["route", "prop 4/13", "prop 0/25"]);
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
    expect(calls.slice(3, 5)).toEqual(["read", "read"]);
    expect(device).toEqual(start);
  });

  test("a link that stays unresolved under the unit's own configuration stops the run before any write", async () => {
    const { io, calls } = scripted({ hiddenEvenUnderOwnConfig: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(r.stopped?.detail).toContain("under its own configuration");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a link the read cannot place is named as such, without proposing an assumption", async () => {
    const { io, calls } = scripted({ unknownLinks: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.stopped?.detail).toBe("1 association(s) of the device did not resolve under its own configuration (object(s) 4); a GA flash would drop them. Object(s) 4: the read could not tell what places them");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a read-back that could not take the com-object table's flags stops the run before any write", async () => {
    for (const flagsNotTaken of [{ flagsUnreadable: "DEVICE_NOT_PROGRAMMED: no com-object table" }, { flagsUndecoded: [23] }]) {
      const { io, calls } = scripted({ flagsNotTaken });
      const r = await runInService(spec, io, NO_FULL);
      expect(r.stopped?.phase).toBe("adopt");
      expect(r.stopped?.detail).toContain(flagsNotTaken.flagsUnreadable ? "DEVICE_NOT_PROGRAMMED" : "object(s) 23");
      expect(writesOf(calls)).toEqual([]);
    }
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

  // A reboot the check cannot see after a negatively confirmed restart (the MEAN WELL power supply,
  // persistence.test.ts): the load states and the configuration are still read. If they hold, the step
  // is not assessed and the run stays green; if not, it fails as any persistence step does.
  test("a reboot the check cannot see leaves persistence not assessed when what is read back holds, and the run passes", async () => {
    const { io, calls, device, start } = scripted({ rebootUnproven: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.persistence).toMatchObject({ state: "not-assessed", detail: expect.stringMatching(/^the reboot cannot be seen; .*LOADED.*; .*equal to the project/) });
    expect(r.persistenceOf).toBe("flashLinks");
    expect(r.ok).toBe(true);
    expect(writesOf(calls)).toEqual(planned(spec, NO_FULL));
    expect(device).toEqual(start);
  });
  test("a reboot the check cannot see, with a load object no longer LOADED after it, is a persistence failure", async () => {
    const { io } = scripted({ rebootUnproven: true, unloadedAfterReboot: true });
    const r = await runInService(spec, io, NO_FULL);
    expect(r.persistence?.state).toBe("fail");
    expect(r.ok).toBe(false);
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

  test("the witness reads the test address and takes the answer on the object's own first address", async () => {
    const own = [gaToNum("2/0/1"), gaToNum("3/0/1")];
    const { io } = scripted({ links: { [OBJ]: own } });
    const r = await runInService(add, io, NO_FULL);
    expect(r.ok).toBe(true);
    expect(r.behaviours.map((b) => [b.state, b.detail])).toEqual([["pass", "the object's first address answered the read of the test address with 0x01, and left the same read unanswered once the test address was removed"]]);
    expect(planInService(add, NO_FULL).map((p) => p.text).join("\n")).toContain("answered on the object's own first address");
  });

  test("an answer on the first address that stays once the test address is removed is not the test address's: the behaviour fails", async () => {
    const { io, device, start } = scripted({ links: { [OBJ]: [OWN] }, answersWithoutTestAddress: true });
    const r = await runInService(add, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.behaviours.map((b) => b.state)).toEqual(["fail"]);
    expect(r.behaviours[0].detail).toContain("after the test address was removed, so the answer is not the test address's");
    expect(device).toEqual(start);
  });

  test("a control read that cannot decide records no behaviour, a harness failure, and the link is taken back", async () => {
    for (const controlRead of ["throws", "unattributable"] as const) {
      const { io, device, start } = scripted({ links: { [OBJ]: [OWN] }, controlRead });
      const r = await runInService(add, io, NO_FULL);
      expect(r.ok).toBe(false);
      expect(r.behaviours).toEqual([]);
      expect(r.capabilities.find((c) => c.capability.startsWith("harness: witness"))?.detail).toContain("control read after the removal");
      expect(device).toEqual(start);
    }
  });

  test("a pass is not recorded when the run stops before the control read", async () => {
    const { io } = scripted({ links: { [OBJ]: [OWN] }, unlinkThrows: true });
    const r = await runInService(add, io, NO_FULL);
    expect(r.stopped?.phase).toBe("flashLinks");
    expect(r.behaviours).toEqual([]);
  });

  test("a wrong value fails at once, without the control read", async () => {
    const { io } = scripted({ links: { [OBJ]: [OWN] }, answer: "00" });
    const r = await runInService(add, io, NO_FULL);
    expect(r.behaviours.map((b) => [b.state, b.detail])).toEqual([["fail", "the object's first address answered the read of the test address with 0x00, expected 0x01"]]);
  });

  test("an answer only on the test address itself is not the object's answer: the behaviour fails, the link is taken back", async () => {
    const { io, device, start } = scripted({ links: { [OBJ]: [OWN] }, answersOnReadAddress: true });
    const r = await runInService(add, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.behaviours.map((b) => [b.state, b.detail])).toEqual([["fail", "no GroupValueResponse on the object's first address to the read of the test address"]]);
    expect(device).toEqual(start);
  });

  test("another client reading the object's own address meanwhile leaves the answer unattributed: no behaviour, a harness failure", async () => {
    const { io, device, start } = scripted({ links: { [OBJ]: [OWN] }, foreignReadOfOwn: true });
    const r = await runInService(add, io, NO_FULL);
    expect(r.ok).toBe(false);
    expect(r.behaviours).toEqual([]);
    expect(r.capabilities.find((c) => c.capability.startsWith("harness: witness"))?.detail).toContain("so no answer can be attributed to its read");
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
    expect(inServiceProblems(system7([APP7, { name: "firmware", object: 0, pid: 9, expect: "06" }], "MV-0025"))).toEqual([
      "no fingerprint rule for mask MV-0025 (family system-2); add one to FINGERPRINT_RULES from a read-only collection of a unit",
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
    expect(r.stopped?.detail).toBe("1 association(s) of the device did not resolve under its own configuration (object(s) 1); a GA flash would drop them. Object(s) 1: no object of the device's own configuration takes them, only a value of a parameter without a memory location can place them: give its value in assumeParams");
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

describe("what can resolve the links a read-back left unresolved", () => {
  test("proposes an assumption only for objects the device's own configuration does not place", () => {
    expect(whatResolves({ unplacedObjects: [5], hiddenObjects: [64], unknownObjects: [254] }, false)).toBe(
      "Object(s) 5: no object of the device's own configuration takes them, only a value of a parameter without a memory location can place them: give its value in assumeParams. "
      + "Object(s) 64: the device's configuration places them, the project's own values hide them. Object(s) 254: the read could not tell what places them");
  });
  test("says the assumed values did not place them where the run assumed values", () => {
    expect(whatResolves({ unplacedObjects: [5] }, true)).toBe("Object(s) 5: no object of the device's own configuration takes them, only a value of a parameter without a memory location can place them: the assumed values do not; another such parameter's value may");
  });
  test("proposes nothing where the read-back does not split them", () => {
    expect(whatResolves({}, false)).toBe("The read-back did not say what can resolve them");
  });
});

describe("a device in service: the interface the run goes through", () => {
  const behind = (restart: "drops" | "keeps"): DeviceSpec => ({ ...spec, inService: { ...spec.inService!, ipInterface: { ia: "1.1.250", restart, shown: "a run through it" } } });

  test("the route is asked first and recorded", async () => {
    const { io, calls } = scripted();
    const r = await runInService(spec, io, NO_FULL);
    expect(calls[0]).toBe("route");
    expect(r.route).toBe("interface 1.1.250 (serial 00fa00000001), tunnel address 1.1.251");
  });

  test("a unit whose restart drops an interface's tunnels is refused through that interface, before it is read", async () => {
    const { io, calls } = scripted();
    const r = await runInService(behind("drops"), io, NO_FULL);
    expect(r.stopped).toEqual({ phase: "fingerprint", detail: "the run goes through 1.1.250, whose tunnels a restart of this unit drops, the run's own included; reach the unit through another interface" });
    expect(calls).toEqual(["route"]);
  });

  test("the unit itself, reported as the interface, is refused as the interface would be", async () => {
    const { io, calls } = scripted({ route: { interfaceIa: spec.device.ia, interfaceSerial: null, tunnelIa: "1.1.251" } });
    const r = await runInService(behind("drops"), io, NO_FULL);
    expect(r.stopped?.detail).toBe(`the run goes through ${spec.device.ia}, this unit, whose restart drops the tunnels of the interface it shares its housing with, the run's own included; reach the unit through another interface`);
    expect(calls).toEqual(["route"]);
  });

  test("an interface that does not say which it is cannot show the run avoids that one", async () => {
    const { io, calls } = scripted({ route: { interfaceIa: null, interfaceSerial: null, tunnelIa: "1.1.100" } });
    const r = await runInService(behind("drops"), io, NO_FULL);
    expect(r.stopped?.detail).toContain("reports no individual address of its own");
    expect(calls).toEqual(["route"]);
  });

  test("through another interface the run goes on; through one whose tunnels the restart keeps, too", async () => {
    const other = scripted({ route: { interfaceIa: "1.1.249", interfaceSerial: null, tunnelIa: "1.1.100" } });
    expect((await runInService(behind("drops"), other.io, NO_FULL)).ok).toBe(true);
    const same = scripted();
    expect((await runInService(behind("keeps"), same.io, NO_FULL)).ok).toBe(true);
  });

  test("the plan names the route and the refusal", () => {
    expect(planInService(behind("drops"), NO_FULL).find((p) => p.text.startsWith("route:"))?.text).toBe("route: the individual address the interface reports for itself (KNXnet/IP device information) and the run's tunnel address; refused when the interface is 1.1.250, whose tunnels a restart of this unit drops");
  });

  test("an interface named by something other than an individual address, or without where it was shown, is refused", () => {
    expect(inServiceProblems({ ...spec, inService: { ...spec.inService!, ipInterface: { ia: "gateway", restart: "keeps", shown: "" } } })).toEqual([
      'ipInterface: "gateway" is not an individual address',
      "ipInterface: say where what a restart does to the interface's tunnels was shown",
    ]);
  });
});

describe("a device in service with KNX Data Secure", () => {
  const secure: DeviceSpec = { ...spec, inService: { ...spec.inService!, dataSecure: true } };
  const WITH_FILE: InServiceOptions = { ...NO_FULL, knxproj: "installation.knxproj" };

  test("the installation's project file is required, and taken only for such a unit", async () => {
    expect(() => planInService(secure, NO_FULL)).toThrow("its keys come from the installation's project file (--knxproj=<file>");
    expect(() => planInService(spec, WITH_FILE)).toThrow("--knxproj is read for a Data Secure unit's keys only");
    const { io, calls } = scripted();
    expect((await runInService(secure, io, NO_FULL)).stopped?.phase).toBe("spec");
    expect(calls).toEqual([]);
  });

  test("the test address goes out plain, and the run passes", async () => {
    const { io, plain } = scripted();
    const r = await runInService(secure, io, WITH_FILE);
    expect(r.ok).toBe(true);
    expect(plain).toEqual([GA]);
    expect(planInService(secure, WITH_FILE).some((p) => p.text === `${GA} set to plain in the project (Data Secure off), so the unit takes it without a key and the witness reads it plainly`)).toBe(true);
  });

  test("a test address the installation's project holds is refused before any write", async () => {
    const { io, calls, plain } = scripted({ gaInProject: true });
    const r = await runInService(secure, io, WITH_FILE);
    expect(r.stopped).toEqual({ phase: "capabilities", detail: "the test address is a group address of the installation's project; give one the installation does not use" });
    expect(writesOf(calls)).toEqual([]);
    expect(plain).toEqual([]);
  });
});

describe("a device in service: System 1", () => {
  const APP1 = { name: "application id", memory: 0x0104, length: 4, expect: "83013821" };
  const sys1: DeviceSpec = {
    ...spec, device: { ...spec.device, mask: "MV-0012" }, behaviours: [], unsafe: [],
    inService: { fingerprint: [APP1], param: spec.inService!.param!, fullDownload: true },
  };
  const SYS1 = { system1: true, caps: { flashLinks: false, structuralFlash: false }, mem: { 0x0104: "83013821" }, links: { [OTHER_OBJ]: [] } };
  const FULL: InServiceOptions = { fullDownload: true };

  test("the fingerprint is the application id in memory; a property fingerprint, or a range of another length, is refused", () => {
    expect(inServiceProblems(sys1)).toEqual([]);
    expect(inServiceProblems({ ...sys1, inService: { ...sys1.inService!, fingerprint: [{ name: "version", object: 0, pid: 25, expect: "0945" }] } })).toEqual(["the fingerprint lacks the application id: on system-1 it is memory 0x0104, 4 byte(s)"]);
    expect(inServiceProblems({ ...sys1, inService: { ...sys1.inService!, fingerprint: [{ ...APP1, expect: "8301" }] } })).toEqual(["fingerprint application id: expect holds 2 byte(s), the range 4"]);
  });

  test("no GA flash dry run, a download that always writes taken as nothing to write when no byte differs, persistence by the run error", async () => {
    const { io, calls, device, start } = scripted(SYS1);
    const r = await runInService(sys1, io, FULL);
    expect(r.stopped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(calls.slice(0, 2)).toEqual(["route", "mem 104"]);
    expect(writesOf(calls)).toEqual(planned(sys1, FULL));
    expect(writesOf(calls)).toEqual(["flashParams", "flashParams", "fullDownload", "restart"]);
    expect(r.persistence).toEqual({ state: "pass", detail: "silent 50 ms after A_Restart, answering again after 900 ms; the run error read FF before the restart and after the reboot; parameters and links read back equal to the project after the reboot" });
    expect(r.persistenceOf).toBe("fullDownload");
    expect(r.restore).toEqual({ state: "pass", detail: "the device holds the configuration it was found with: parameter flash dry run finds no byte that differs" });
    expect(r.capabilities.find((c) => c.capability === "flashLinks")).toBeUndefined();
    expect(device).toEqual(start);
  });

  test("a download that always writes and finds bytes that differ stops the adoption", async () => {
    const { io, calls } = scripted({ ...SYS1, adoptDryNotUnchanged: true });
    const r = await runInService(sys1, io, FULL);
    expect(r.stopped?.phase).toBe("adopt");
    expect(r.stopped?.detail).toContain("the parameter flash dry run reports dryRun with 3 differing byte(s)");
    expect(writesOf(calls)).toEqual([]);
  });

  test("a run error that is not FF after the reboot fails persistence", async () => {
    const { io } = scripted({ ...SYS1, runErrorAfter: 0x00 });
    const r = await runInService(sys1, io, FULL);
    expect(r.persistence).toMatchObject({ state: "fail", detail: expect.stringContaining("after the reboot the run error reads 00, not FF") });
    expect(r.ok).toBe(false);
  });
});

describe("a weather station in service: the weather guard", () => {
  const station: DeviceSpec = { ...spec, id: "station", inService: { ...spec.inService!, weatherGuard: true } };
  const GUARDED: InServiceOptions = { ...NO_FULL, weatherGuard: "wind:31/7/240:9,rain:31/7/241" };
  // The guard's addresses answer from `weather`, called with the number of the guard check (from 1);
  // each check is logged as "guard" before the reads it makes.
  const withWeather = (sc: Script, weather: (check: number) => { wind: string | null; rain: string | null }) => {
    const s = scripted(sc);
    const bus = { ...s.io.bus };
    let checks = 0;
    // The guard takes only the unit's own answer, as groupReadAnsweredOn gives it.
    s.io.bus.groupReadAnsweredOn = async (readGa, ownGas) => {
      if (readGa === "31/7/240") { checks++; s.calls.push("guard"); return { value: weather(checks).wind, unattributable: false }; }
      if (readGa === "31/7/241") return { value: weather(checks).rain, unattributable: false };
      return bus.groupReadAnsweredOn(readGa, ownGas);
    };
    return s;
  };
  const CALM = { wind: "00c8", rain: "00" };
  const guardAndWrites = (calls: string[]) => calls.filter((c) => c === "guard" || WRITES.has(c));

  test("the guard reads before the channel and before every write and restart, and the run passes in calm weather", async () => {
    const { io, calls, device, start } = withWeather({}, () => CALM);
    const r = await runInService(station, io, GUARDED);
    expect(r.ok).toBe(true);
    expect(guardAndWrites(calls)).toEqual(["guard", "guard", "flashParams", "guard", "flashParams", "guard", "flashLinks", "guard", "restart", "guard", "flashLinks"]);
    // Before the channel means before anything reaches the unit.
    expect(calls.indexOf("guard")).toBeLessThan(calls.indexOf("route"));
    expect(device).toEqual(start);
    expect(planInService(station, GUARDED).find((p) => p.text.startsWith("weather guard"))?.text).toBe("weather guard, before the channel and before every write and restart (the undo's included): wind 31/7/240 must answer below 70 % of 9 m/s, rain 31/7/241 must answer 0; an address the unit itself does not answer stops the run");
  });

  test("wind near the threshold before the restart stops the run there, and the undo writes nothing while it holds", async () => {
    const { io, calls, device, start } = withWeather({}, (n) => (n >= 5 ? { wind: "0276", rain: "00" } : CALM));
    const r = await runInService(station, io, GUARDED);
    expect(r.ok).toBe(false);
    expect(r.stopped?.phase).toBe("weather guard");
    expect(r.stopped?.detail).toContain("before the restart: wind 6.3 m/s is at or above 70 % of the alarm threshold 9 m/s");
    expect(guardAndWrites(calls)).toEqual(["guard", "guard", "flashParams", "guard", "flashParams", "guard", "flashLinks", "guard", "guard"]);
    expect(r.persistence).toBeUndefined();
    expect(r.restore?.state).toBe("fail");
    expect(r.restore?.detail).toContain("undo aborted: before the GA flash: wind 6.3 m/s");
    expect(device).not.toEqual(start);
  });

  test("once the weather has calmed, the undo takes the link back", async () => {
    const { io, calls, device, start } = withWeather({}, (n) => (n === 5 ? { wind: "00c8", rain: "01" } : CALM));
    const r = await runInService(station, io, GUARDED);
    expect(r.ok).toBe(false);
    expect(r.stopped?.detail).toContain("before the restart: rain is set");
    expect(guardAndWrites(calls)).toEqual(["guard", "guard", "flashParams", "guard", "flashParams", "guard", "flashLinks", "guard", "guard", "flashLinks"]);
    expect(r.restore?.state).toBe("pass");
    expect(device).toEqual(start);
  });

  test("a stop before the full download writes nothing and is no broken-off download", async () => {
    const offer: DeviceSpec = { ...station, inService: { ...station.inService!, fullDownload: true }, unsafe: [] };
    const full: InServiceOptions = { ...GUARDED, fullDownload: true };
    // Checks: channel, the two parameter flashes, GA flash, restart, unlink; the seventh is the download's.
    const { io, calls, device, start } = withWeather({}, (n) => (n === 7 ? { wind: "0276", rain: "00" } : CALM));
    const r = await runInService(offer, io, full);
    expect(r.stopped?.phase).toBe("weather guard");
    expect(r.stopped?.detail).toContain("before the full download: wind 6.3 m/s");
    expect(guardAndWrites(calls)).toEqual(["guard", "guard", "flashParams", "guard", "flashParams", "guard", "flashLinks", "guard", "restart", "guard", "flashLinks", "guard"]);
    expect(r.restore?.detail ?? "").not.toContain("broke off");
    expect(device).toEqual(start);
  });

  test("in calm weather the full download goes out after its own check", async () => {
    const offer: DeviceSpec = { ...station, inService: { ...station.inService!, fullDownload: true }, unsafe: [] };
    const { io, calls } = withWeather({}, () => CALM);
    const r = await runInService(offer, io, { ...GUARDED, fullDownload: true });
    expect(r.ok).toBe(true);
    expect(guardAndWrites(calls).slice(-2)).toEqual(["guard", "fullDownload"]);
  });

  test("an address that does not answer stops the run before anything reaches the unit", async () => {
    const { io, calls } = withWeather({}, () => ({ wind: "00c8", rain: null }));
    const r = await runInService(station, io, GUARDED);
    expect(r.stopped).toEqual({ phase: "weather guard", detail: "before the channel: rain did not answer from the station (read: wind 2 m/s (limit 6.3))" });
    expect(calls).toEqual(["guard"]);
  });

  test("a guard read that breaks off stops the run, naming the address by its name only", async () => {
    const { io, calls } = withWeather({}, () => CALM);
    const bus = { ...io.bus };
    io.bus.groupReadAnsweredOn = async (readGa, ownGas) => { if (readGa === "31/7/241") throw new Error("tunnel refused"); return bus.groupReadAnsweredOn(readGa, ownGas); };
    const r = await runInService(station, io, GUARDED);
    expect(r.stopped).toEqual({ phase: "weather guard", detail: "before the channel: the read of rain broke off: tunnel refused" });
    expect(calls).toEqual(["guard"]);
  });

  test("a weather station needs the guard, and only a weather station takes one", () => {
    expect(() => planInService(station, NO_FULL)).toThrow("the unit is a weather station");
    expect(() => planInService(spec, GUARDED)).toThrow("--weather-guard is read for a weather station only");
    expect(() => planInService(station, { ...NO_FULL, weatherGuard: "rain:31/7/241" })).toThrow("no wind address");
  });
});
