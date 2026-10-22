import { test, expect, describe } from "bun:test";
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { iaToNum, numToIa, gaToNum, LSM, planSecurityObjectLoad, GROUP_KEY_ENTRY, ownedRuns, planSystemBGaFlash, fillAllocatedRuns, differingRuns, type LoadPlan } from "../packages/knx/src/index.ts";
import { parseAppConfig, classify, parseLoadProcedures, relParamFillByte, flattenSteps, buildRelativeSegmentTarget, mergeRelativeTarget, differingFF, leaveUnreadUnchanged, buildDeviceConfig, buildComObjectTable, buildGroupTables, resolveModuleInstances, absoluteStructuralImages, planAbsoluteStructuralFlash, planRelativeStructuralFlash, declaredMcbWrites, planRelativeParFlash, withClosing, toAppModel, decodeAbsoluteImage, decodeGroupTablesMv0705, buildGroupTablesMv0705, buildAbsoluteSegmentTargets, parameterMemoryBytes, planAbsoluteParFlash, withLinkedCommFlags, planSystem7GaFlash, comObjInstanceOverride, placeComObjOverrides, withConfirmedRestart, withInstanceOverrides, fullDownloadImageCoverage, planSystem1Download, MV0012_DEFAULT_LOAD, absoluteBuildInstances, checkedStamps, buildSecurityObject, writtenGroupKeys, relativeParWriteSet, relativeComObjWriteSet, constantParams, differingConstants, comObjectTableChanges, type KnxIpDevice, type ModuleInstance, type ComObjInstanceOverride, type ImageStamp } from "../packages/product/src/index.ts";
import { catalogueDir, catalogueXml, captureText, capturePath, listCatalogue } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { CollectedUnit, asDevice, type Collection } from "../packages/product/test/collected-unit.ts";
import { parseCapture, parseTunnelFrame, memoryImage, etsAllocations, reportedTableReferences, compareSegments, parseGa, inferBase, captureDevice } from "./etsdiff.ts";

// One proxy log line carrying a KNXnet/IP TUNNELLING_REQUEST with an L_Data frame.
function line(dir: "ETS->BRIDGE" | "BRIDGE->ETS", code: number, src: string, dst: string, tpdu: number[]): string {
  const cemi = [code, 0x00, 0xb0, 0x60, ...u16(iaToNum(src)), ...u16(iaToNum(dst)), tpdu.length - 1, ...tpdu];
  const body = [0x04, 0x01, 0x00, 0x00, ...cemi];
  const frame = [0x06, 0x10, 0x04, 0x20, ...u16(6 + body.length), ...body];
  return `2000-01-01T00:00:00.000Z ${dir} TUNNELLING_REQ req ${src}->${dst} | ${Buffer.from(frame).toString("hex")}`;
}
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const memWrite = (addr: number, data: number[]) => [0x42, 0x80 | data.length, ...u16(addr), ...data];
const memExtWrite = (addr: number, data: number[]) => [0x41, 0xfb, data.length, (addr >> 16) & 0xff, (addr >> 8) & 0xff, addr & 0xff, ...data];
const propWrite = (obj: number, pid: number, data: number[]) => [0x43, 0xd7, obj, pid, 0x10, 0x01, ...data];
const propResponse = (obj: number, pid: number, data: number[]) => [0x43, 0xd6, obj, pid, 0x10, 0x01, ...data];
const DEV = "1.2.3", OTHER = "1.2.4", BRIDGE = "1.2.250";

// The individual address of the device a capture's download went to.
const deviceOf = (file: string) => captureDevice(captureText(file));
// The group addresses of an address table, in table order (ascending, as ETS writes them), from the bytes `at`
// returns by offset into the table. System B: [count:2][GA:2]xN. System 7 (MV-0705, MV-0701): [count:1][own IA:2]
// [GA:2]x(count-1). `n` reads that many entries where the capture does not hold the count (ETS wrote only the bytes
// that differed); where it holds the count, the two must agree. A byte the capture does not hold is refused.
function tableGas(at: (offset: number) => number | undefined, layout: "systemB" | "system7", n?: number): number[] {
  const byte = (o: number) => { const b = at(o); if (b === undefined) throw new Error(`the address table's byte ${o} is not in the capture`); return b; };
  const counted = layout === "systemB" ? (at(0) === undefined || at(1) === undefined ? undefined : (byte(0) << 8) | byte(1)) : at(0) === undefined ? undefined : byte(0) - 1;
  const count = n ?? counted;
  if (count === undefined) throw new Error("the address table's count is not in the capture");
  if (counted !== undefined && counted !== count) throw new Error(`the address table counts ${counted} group addresses, not ${count}`);
  const first = layout === "systemB" ? 2 : 3;
  return Array.from({ length: count }, (_, i) => (byte(first + 2 * i) << 8) | byte(first + 2 * i + 1));
}
const fromMemory = (mem: Map<number, number>, base: number) => (o: number) => mem.get(base + o);
// The one group address of `gas` that no link of `links` uses: the address a download linked anew.
function addedGa(gas: number[], links: { gaRaws: number[] }[]): number {
  const used = new Set(links.flatMap((l) => l.gaRaws));
  const added = gas.filter((g) => !used.has(g));
  if (added.length !== 1 || used.size + 1 !== gas.length) throw new Error(`the table adds ${added.length} group addresses to the ${used.size} linked, not one`);
  return added[0];
}

describe("capture parsing", () => {
  test("both memory write services, only to the device, replayed in order", () => {
    const cap = parseCapture([
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memWrite(0x4000, [1, 2, 3])),
      line("ETS->BRIDGE", 0x11, "0.0.0", OTHER, memWrite(0x4000, [9])),
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memExtWrite(0x10054, [7, 8])),
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memWrite(0x4001, [0xaa])),
      // the bridge's confirmation echoes an ETS request; it is not a second write
      line("BRIDGE->ETS", 0x2e, BRIDGE, DEV, memWrite(0x4002, [0xbb])),
      "2000-01-01T00:00:00.000Z --- ETS connected, bridge up ---",
    ].join("\n"), iaToNum(DEV));
    expect(cap.writes.map((w) => [w.service, w.addr, [...w.data]])).toEqual([
      ["A_Memory_Write", 0x4000, [1, 2, 3]],
      ["A_MemoryExtended_Write", 0x10054, [7, 8]],
      ["A_Memory_Write", 0x4001, [0xaa]],
    ]);
    expect(cap.otherDestination).toBe(1);
    expect([...memoryImage(cap.writes)]).toEqual([[0x4000, 1], [0x4001, 0xaa], [0x4002, 3], [0x10054, 7], [0x10055, 8]]);
  });

  test("an A_Memory_Write of 16 to 63 bytes, its count in the APCI's low six bits", () => {
    const data = Array.from({ length: 52 }, (_, i) => i);
    const cap = parseCapture(line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memWrite(0x5003, data)), iaToNum(DEV));
    expect(cap.writes.map((w) => [w.addr, [...w.data]])).toEqual([[0x5003, data]]);
  });

  test("the device of a capture is the one destination of ETS's memory writes", () => {
    const write = (dst: string) => line("ETS->BRIDGE", 0x11, "0.0.0", dst, memWrite(0x4000, [1]));
    expect(captureDevice([write(DEV), line("ETS->BRIDGE", 0x11, "0.0.0", OTHER, propWrite(0, 14, [4])), write(DEV)].join("\n"))).toBe(iaToNum(DEV));
    expect(() => captureDevice([write(DEV), write(OTHER)].join("\n"))).toThrow(/2 devices/);
    expect(() => captureDevice(line("BRIDGE->ETS", 0x2e, BRIDGE, DEV, memWrite(0x4000, [1])))).toThrow(/0 devices/);
  });

  test("a truncated write is not taken for a shorter one", () => {
    const t = memWrite(0x4000, [1, 2, 3]).slice(0, -1); // count says 3, two bytes follow
    expect(parseCapture(line("ETS->BRIDGE", 0x11, "0.0.0", DEV, t), iaToNum(DEV)).writes).toEqual([]);
  });

  test("allocations and the device's table references come from the property traffic", () => {
    const cap = parseCapture([
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, propWrite(4, 5, [0x03, 0x0b, 0, 0, 0x54, 0x61, 1, 0xff, 0, 0])),
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, propWrite(3, 5, [0x03, 0x0b, 0, 0, 0, 0x10, 0, 0, 0, 0])),
      line("BRIDGE->ETS", 0x29, DEV, "0.0.0", propResponse(4, 7, [0, 0, 0, 0x54])),
      line("BRIDGE->ETS", 0x29, OTHER, "0.0.0", propResponse(3, 7, [0, 0, 0x10, 0])), // another device
    ].join("\n"), iaToNum(DEV));
    expect([...etsAllocations(cap)]).toEqual([[4, { size: 0x5461, fill: 0xff }], [3, { size: 0x10, fill: null }]]);
    expect([...reportedTableReferences(cap)]).toEqual([[4, 0x54]]);
  });
});

describe("segment comparison", () => {
  const seg = (image: number[], address: number | null, lsm = 4) => ({ id: `L${lsm}`, lsm, source: "params" as const, address, image: Buffer.from(image), fillByte: 0 });

  test("an unwritten byte of a filled allocation is compared as the fill", () => {
    const mem = new Map([[0x54, 1]]);
    const r = compareSegments([{ seg: seg([1, 0, 5], null), address: 0x54, baseSource: "t" }], mem, new Map([[4, { size: 3, fill: 0 }]]), []);
    expect(r.segments[0]).toMatchObject({ compared: 3, etsWrote: 1, etsFill: 2 });
    expect(r.segments[0].divergences).toEqual([{ offset: 2, address: 0x56, busforge: 5, ets: 0, etsSource: "fill" }]);
  });

  test("bytes on only one side are reported, not dropped", () => {
    const mem = new Map([[0x100, 1], [0x103, 9], [0x200, 4], [0x104, 0]]);
    const r = compareSegments([{ seg: { ...seg([1, 2, 3], 0x100), fillByte: undefined }, address: 0x100, baseSource: "t" }], mem, new Map(), [{ rule: "control", covers: (a) => a === 0x200 }]);
    expect(r.segments[0]).toMatchObject({ compared: 1, busforgeOnly: [1, 2], etsOnly: [] });
    expect(r.unattributed).toEqual([0x103, 0x104]);
    expect(r.exclusions).toEqual([{ rule: "control", addresses: [0x200] }]);
  });

  test("a segment ETS allocated larger than Busforge's image shows the excess", () => {
    const r = compareSegments([{ seg: seg([0], null), address: 0x10, baseSource: "t" }], new Map([[0x10, 0]]), new Map([[4, { size: 3, fill: 0 }]]), []);
    expect(r.segments[0].etsOnly).toEqual([1, 2]);
  });

  test("a segment without an address is not compared and its ETS bytes stay unattributed", () => {
    const r = compareSegments([{ seg: seg([1], null, 3), address: null, baseSource: "unknown" }], new Map([[0x500, 1]]), new Map(), []);
    expect(r.segments[0].compared).toBe(0);
    expect(r.unattributed).toEqual([0x500]);
  });

  test("the base is where distinctive writes line up", () => {
    const image = Buffer.from([0, 0, 0, 0x11, 0x22, 0x33, 0, 0, 0x44, 0x55, 0x66]);
    expect(inferBase(image, [{ addr: 0x57, data: Buffer.from([0x11, 0x22, 0x33]), service: "A_Memory_Write" }, { addr: 0x5c, data: Buffer.from([0x44, 0x55, 0x66]), service: "A_Memory_Write" }])).toBe(0x54);
    expect(inferBase(image, [{ addr: 0x57, data: Buffer.from([0, 0, 0]), service: "A_Memory_Write" }])).toBeNull();
  });

  test("group addresses in both notations", () => {
    expect([parseGa("2/1/7"), parseGa("2/263"), parseGa("4359")]).toEqual([0x1107, 0x1107, 0x1107]);
    expect(() => parseGa("3/8/1")).toThrow();
  });
});

// Two ETS 6 full downloads of the MDT BE-02001.02 (mask MV-0705) through the logging proxy, trimmed
// to the TUNNELLING_REQ lines: application defaults with no links, and the same with input A's
// object #0 linked to a group address. The debounce time P-7 carries LegacyPatchAlways: its <Data> byte is
// 0x32 (50 ms), and ETS writes the parameter's value 0x1e (30 ms) over it. Neither writes the address
// table's own individual address (bytes 1-2).
corpusDescribe("MDT BE-02001.02 full download against ETS", () => {
  const xml = catalogueXml("M-0083_A-00B6-32-9642.xml.gz");
  const cfg = parseAppConfig(xml);
  const run = (capture: string, links: { comObjNum: number; gaRaws: number[] }[]) => {
    const ia = deviceOf(capture);
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: numToIa(ia), params: new Map(), links, proc: parseLoadProcedures(xml) });
    const cap = parseCapture(captureText(capture), ia);
    return compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "declared" })), memoryImage(cap.writes), etsAllocations(cap), []);
  };
  const summary = (r: ReturnType<typeof run>) => r.segments.map((s) => [s.id.split("_").pop(), s.compared, s.divergences.length, s.busforgeOnly]);

  test("at defaults: every byte ETS wrote matches, the debounce time included", () => {
    const r = run("mdt-be02001-ets-fulldownload-defaults.log", []);
    expect(summary(r)).toEqual([["AS-4000", 1, 0, []], ["AS-4201", 1, 0, []], ["AS-4400", 104, 0, []], ["AS-4468", 168, 0, []]]);
    expect(r.unattributed).toEqual([]);
  });

  test("with one link: the group tables and the linked object's flags match too", () => {
    const linked = "mdt-be02001-ets-fulldownload-linked.log";
    const gas = tableGas(fromMemory(memoryImage(parseCapture(captureText(linked), deviceOf(linked)).writes), 0x4000), "system7");
    expect(gas.length).toBe(1);
    const r = run(linked, [{ comObjNum: 0, gaRaws: gas }]);
    expect(summary(r)).toEqual([["AS-4000", 1, 0, []], ["AS-4000", 2, 0, []], ["AS-4201", 3, 0, []], ["AS-4400", 104, 0, []], ["AS-4468", 168, 0, []]]);
    expect(r.unattributed).toEqual([]);
  });

  test("the linked capture is not matched by a link-less image", () => {
    const r = run("mdt-be02001-ets-fulldownload-linked.log", []);
    expect(r.segments.slice(0, 3).map((s) => s.divergences.length + s.etsOnly.length)).not.toEqual([0, 0, 0]);
  });
});

// ETS 6 full download of the GVS AMMA-04/06.S (System B, fill 0xFF) at application defaults, where
// every output is disabled and no com-object is active; trimmed to the frames to and from the device.
corpusDescribe("GVS AMMA full download against ETS", () => {
  test("every byte matches: silent com-object table, and each idle union holds its default member", () => {
    const xml = catalogueXml("M-0085_A-0072-30-69AA.xml.gz");
    const cfg = parseAppConfig(xml);
    const ia = deviceOf("gvs-amma-ets-fulldownload-defaults.log");
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: numToIa(ia), params: new Map(), links: [], proc: parseLoadProcedures(xml) });
    const cap = parseCapture(captureText("gvs-amma-ets-fulldownload-defaults.log"), ia);
    const refs = reportedTableReferences(cap);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.compared, s.divergences.length])).toEqual([[4, 2816, 0], [3, 1066, 0], [2, 2, 0], [1, 2, 0]]);
    expect(r.unattributed).toEqual([]);
  });
});

// How a download ends: what ETS sends the device after its last LoadCompleted, property writes and the
// restart, in order. The GVS AMMA declares a write of 01 to object 4 PID 67 for every download
// (AppliesTo="all"); ETS sends it there, the device echoes it, and the restart follows.
function etsClosing(text: string, ia: number): string[] {
  const events: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.includes("ETS->BRIDGE") ? line.match(/\| ([0-9a-fA-F]+)\s*$/) : null;
    const fr = m ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group || fr.dst !== ia || fr.tpdu.length < 2) continue;
    const t = fr.tpdu, apci = ((t[0] & 0x03) << 8) | t[1];
    if (apci === 0x3d7 && t.length >= 6) events.push(t[3] === 5 && t[6] === 2 ? "loadCompleted" : `prop ${t[2]}/${t[3]}=${t.subarray(6).toString("hex")}`);
    else if ((apci & 0x3c0) === 0x380) events.push("restart"); // A_Restart, its type in the low bits
  }
  return events.slice(events.lastIndexOf("loadCompleted") + 1);
}
function planClosing(plan: LoadPlan): string[] {
  const at = plan.findLastIndex((st) => st.op === "loadCompleted");
  return plan.slice(at + 1).flatMap((st) => st.op === "writeProp" ? [`prop ${st.obj}/${st.pid}=${st.data.toString("hex")}`] : st.op === "restart" ? ["restart"] : []);
}

corpusDescribe("GVS AMMA: each download closes as ETS's does", () => {
  const xml = catalogueXml("M-0085_A-0072-30-69AA.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const ia = deviceOf("gvs-amma-ets-fulldownload-defaults.log");
  const CLOSING = ["prop 4/67=01", "restart"];

  test("the captures: PID 67 = 01 after the last LoadCompleted, echoed, then the restart", () => {
    for (const f of ["gvs-amma-ets-fulldownload-defaults.log", "gvs-amma-ets-partial-links.log"]) {
      expect(etsClosing(captureText(f), ia)).toEqual(CLOSING);
      expect(parseCapture(captureText(f), ia).propResponses.filter((r) => r.obj === 4 && r.pid === 67).map((r) => r.data.toString("hex"))).toEqual(["01"]);
    }
  });

  test("Busforge's full download ends like ETS's full download", () => {
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: numToIa(ia), params: new Map(), links: [], proc });
    expect(planClosing(build.plan)).toEqual(etsClosing(captureText("gvs-amma-ets-fulldownload-defaults.log"), ia));
  });

  test("Busforge's parameter flash and group-address flash end like ETS's partial download of parameters and links", () => {
    const ets = etsClosing(captureText("gvs-amma-ets-partial-links.log"), ia);
    const par = withClosing(planRelativeParFlash(4, Buffer.alloc(2816), [], 0x4000, Buffer.from("0085007230", "hex"), false), proc, "par");
    const ga = withClosing(planSystemBGaFlash({ addr: Buffer.alloc(4), assoc: Buffer.alloc(4), comObj: Buffer.alloc(4) }, false), cfg.loadProcedures, "grp");
    expect(planClosing(par)).toEqual(ets);
    expect(planClosing(ga)).toEqual(ets);
  });
});

// ETS 6.4.1 partial downloads of the GVS AMMA in Data Secure, one per step: a second address (secured by ETS)
// added to an object, removed again, a plain address linked so that it takes the removed one's index in the
// address table, the two objects' addresses swapped, and ETS's configuration restored
// (gvs-amma-ets6log-keytable-<step>.txt, ETS's own log: it masks PID 53's keys). The unit was read back through a
// secured session before the first and after each, and the plain address driven on the bus
// (gvs-amma-unit-keytable.json; a key only as the first 8 hex digits of its SHA-256).
corpusDescribe("GVS AMMA: the group key table when a secured address goes and a plain one takes its index, against ETS", () => {
  type State = { name: string; addressTable: string[]; assoc: [number, number][]; keyCount: number; keys: [number, string, string][]; senders: string[]; secured: number[] };
  const unit = JSON.parse(captureText("gvs-amma-unit-keytable.json")) as { states: State[]; behaviour: { state: string; sent: string; seen: string }[] };
  const OBJECTS = 532; // PID 61's elements, one per object of the application
  // The security object's elements ETS wrote, per PID: element -> data as hex (null where ETS masks it).
  const etsWrites = (step: string) => {
    const out = new Map<number, Map<number, string | null>>();
    for (const l of captureText(`gvs-amma-ets6log-keytable-${step}.txt`).split(/\r?\n/)) {
      const m = l.match(/Sending Sec_req .*InnerTelegram=PropertyExtValue_WriteCon_req .*ObjectType=17 Instance=1 PID=(\d+) NumberOfElements=(\d+) StartIndex=(\d+) Data=([0-9A-F* ]+?) succeeded/);
      if (!m) continue;
      const [pid, n, start] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const data = m[4].replace(/ /g, "");
      const size = data.length / 2 / n;
      const els = out.get(pid) ?? new Map<number, string | null>();
      for (let k = 0; k < n; k++) els.set(start + k, data.includes("*") ? null : data.slice(2 * size * k, 2 * size * (k + 1)).toLowerCase());
      out.set(pid, els);
    }
    return out;
  };
  // What Busforge loads for a state's links: the secured addresses are the ones the project keys, the senders
  // ETS listed (the tunnel and the Jung, at the sequence ETS gave it).
  const built = (s: State, jungSequence: bigint) => {
    const gaOf = (index: number) => gaToNum(s.addressTable[index - 1]);
    const links = [...new Set(s.assoc.map(([o]) => o))].map((o) => ({ comObjNum: o, gaRaws: s.assoc.filter(([x]) => x === o).map(([, i]) => gaOf(i)) }));
    const keyed = new Map(s.keys.map(([, , ga]) => [gaToNum(ga), Buffer.alloc(16, gaToNum(ga) & 0xff)]));
    const securedGas = new Set(s.assoc.filter(([o]) => s.secured.includes(o)).map(([, i]) => gaOf(i)));
    const keys = new Map([...keyed].filter(([g]) => securedGas.has(g)));
    const first = [...securedGas][0];
    const senders = { byGa: new Map([[first, [iaToNum(s.senders[0])]]]), ownIa: iaToNum("1.1.203"), otherDevices: new Map([[first, [{ ia: iaToNum(s.senders[1]), transmits: true, sequence: jungSequence }]]]) };
    return buildSecurityObject(links, OBJECTS, keys, senders);
  };
  const busforgeWrites = (t: ReturnType<typeof built>) => {
    const out = new Map<number, Map<number, string | null>>();
    for (const st of planSecurityObjectLoad(t)) {
      if (st.op !== "writeSecurityProp") continue;
      const els = out.get(st.pid) ?? new Map<number, string | null>();
      for (let k = 0; k * st.elementSize < st.data.length; k++) els.set(st.start + k, st.data.subarray(k * st.elementSize, (k + 1) * st.elementSize).toString("hex"));
      out.set(st.pid, els);
    }
    return out;
  };
  const steps = unit.states.slice(1);

  test("each download writes ETS's elements of PIDs 54, 53 and 61, and PID 53 never from element 0", () => {
    expect(steps.map((s) => s.name)).toEqual(["add", "remove", "plain", "swap", "restore"]);
    for (const s of steps) {
      const ets = etsWrites(s.name);
      // The Jung's sequence is the one ETS wrote (its project's), so PID 54 compares the senders and their order.
      const jung = BigInt(`0x${ets.get(54)!.get(2)!.slice(4)}`);
      const ours = busforgeWrites(built(s, jung));
      expect([s.name, [...ours.get(54)!]]).toEqual([s.name, [...ets.get(54)!]]);
      expect([s.name, [...ours.get(61)!]]).toEqual([s.name, [...ets.get(61)!]]);
      // ETS masks the keys; the elements it writes, and the address-table index each of ours names, are compared.
      expect([s.name, [...ours.get(53)!.keys()]]).toEqual([s.name, [...ets.get(53)!.keys()]]);
      expect([s.name, [...ours.get(53)!.values()].map((v) => parseInt(v!.slice(0, 4), 16))]).toEqual([s.name, s.keys.slice(0, ours.get(53)!.size).map(([i]) => i)]);
      expect(ets.get(53)!.has(0)).toBe(false);
    }
  });

  test("the unit keeps every key-table element a download does not write, its count never shrinks", () => {
    unit.states.slice(1).forEach((s, i) => {
      const before = unit.states[i];
      const written = new Set(etsWrites(s.name).get(53)!.keys());
      expect([s.name, s.keyCount]).toEqual([s.name, Math.max(before.keyCount, ...written)]);
      for (const [element, entry] of before.keys.entries()) if (!written.has(element + 1)) expect([s.name, element + 1, s.keys[element]]).toEqual([s.name, element + 1, entry]);
    });
  });

  // Busforge compares the entries a load writes (writtenGroupKeys): the rest is the residue ETS leaves, here the
  // removed address's key at the index the plain address took, which the unit works plain.
  test("Busforge's comparison is the unit's table after each download, where a plain address sits on an old key", () => {
    const residue: string[] = [];
    for (const s of steps) {
      const ets = etsWrites(s.name);
      const t = built(s, BigInt(`0x${ets.get(54)!.get(2)!.slice(4)}`));
      const entries = t.groupKeys.length / GROUP_KEY_ENTRY;
      // The unit's table as its tags show it, the built one as its keys show it: same index and same address's key.
      const unitTable = s.keys.map(([i, , ga]) => Buffer.concat([Buffer.from([i >> 8, i & 0xff]), Buffer.alloc(16, gaToNum(ga) & 0xff)]));
      expect([s.name, writtenGroupKeys(Buffer.concat(unitTable), t.groupKeys).equals(t.groupKeys)]).toEqual([s.name, true]);
      expect([s.name, [...t.goFlags].flatMap((f, i) => (f ? [i + 1] : []))]).toEqual([s.name, s.secured]);
      for (const [i, , ga] of s.keys.slice(entries)) if (i <= s.addressTable.length && s.addressTable[i - 1] !== ga) residue.push(`${s.name}:${i}`);
    }
    expect(residue).toEqual(["plain:2", "swap:2"]);
  });

  // In both states with a plain address on the old key: the plain address carries plain telegrams both ways, the
  // secured one stays secured.
  test("the unit works the plain address on the old key plain, in both directions", () => {
    const plain = (s: string) => unit.states.find((x) => x.name === s)!.addressTable[1];
    const secured = unit.states[0].addressTable[0];
    expect(unit.behaviour.map((b) => [b.state, b.sent, b.seen])).toEqual([
      ["plain", `plain GroupValueRead ${plain("plain")}`, `1.1.203 -> ${plain("plain")} plain GroupValueResponse 00`],
      ["plain", `secured GroupValueWrite ${secured} = 1`, `1.1.203 -> ${plain("plain")} plain GroupValueWrite 01`],
      ["plain", `plain GroupValueRead ${plain("plain")}`, `1.1.203 -> ${plain("plain")} plain GroupValueResponse 01`],
      ["plain", `secured GroupValueWrite ${secured} = 0`, `1.1.203 -> ${plain("plain")} plain GroupValueWrite 00`],
      ["plain", `plain GroupValueRead ${plain("plain")}`, `1.1.203 -> ${plain("plain")} plain GroupValueResponse 00`],
      ["swap", `plain GroupValueWrite ${plain("swap")} = 1`, `1.1.203 -> ${secured} secured GroupValueWrite 01 (decrypted with the key of ${secured})`],
      ["swap", `plain GroupValueWrite ${plain("swap")} = 0`, `1.1.203 -> ${secured} secured GroupValueWrite 00 (decrypted with the key of ${secured})`],
    ]);
  });
});

// ETS 6 full download of the Jung 400021SE (System B, module device, segment above 64 KB) at the
// project's configuration: two module instances, no links; trimmed to the frames to and from the device.
corpusDescribe("Jung 400021SE full download against ETS", () => {
  test("every byte matches, including the union a hidden ParameterRef's own default would flip", () => {
    const xml = catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz");
    const cfg = parseAppConfig(xml);
    const ia = deviceOf("jung-400021se-ets-fulldownload.log");
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: numToIa(ia), params: new Map(), links: [], proc: parseLoadProcedures(xml) });
    const cap = parseCapture(captureText("jung-400021se-ets-fulldownload.log"), ia);
    const refs = reportedTableReferences(cap);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.divergences.map((d) => d.offset)])).toEqual([[4, []], [3, []], [2, []], [1, []]]);
  }, 30_000); // the 26.9 MB Jung application: under 1.2 s alone at load 24, 5-10 s in a full check at load 14-36
});

// The group addresses ETS wrote into the address table in a partial download with links, ascending: System B's table
// where the device reported it (PID 7 of LSM 1), System 7's at its declared segment; `n` of them where ETS wrote only
// the bytes that differed and left the count out.
function partialLinkGas(file: string, cfg: ReturnType<typeof parseAppConfig>, n: number): number[] {
  const cap = parseCapture(captureText(file), deviceOf(file));
  const mem = memoryImage(cap.writes);
  const absolute = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.addressSegment);
  if (absolute) return tableGas(fromMemory(mem, absolute.address), "system7", n);
  const at = reportedTableReferences(cap).get(1);
  if (at === undefined) throw new Error(`${file} holds no table reference for the address table`);
  return tableGas(fromMemory(mem, at), "systemB", n);
}

// The bench captures' device and group addresses, pinned independently of the captures: the tests that take them
// from a capture (deviceOf, partialLinkGas) then compare against the addresses the bench project assigned.
corpusDescribe("the bench captures go to the bench devices, on the bench project's addresses", () => {
  test("each capture's memory writes go to its bench device", () => {
    const devices: [string, string[]][] = [
      ["1.1.201", ["abb-usu-4.2-ets-partial-links.log", "abb-usu-4.2-ets-fulldownload-loaded.log"]],
      ["1.1.203", ["gvs-amma-ets-fulldownload-defaults.log", "gvs-amma-ets-partial-links.log"]],
      ["1.1.204", ["jung-400021se-ets-fulldownload.log", "jung-400021se-ets-partial-links.log", "jung-400021se-ets-partial-structure.log"]],
      ["1.1.56", ["mdt-be02001-ets-partial-links.log", "mdt-be02001-ets-fulldownload-b7.log", "mdt-be02001-ets-partial-structure.log"]],
    ];
    for (const [ia, files] of devices) for (const f of files) expect([f, numToIa(deviceOf(f))]).toEqual([f, ia]);
  });

  test("the partial downloads with links wrote the bench project's group addresses", () => {
    const linked: [string, string, string[]][] = [
      ["jung-400021se", "M-0004_A-7072-21-99A7-O000A.xml.gz", ["3/3/2", "3/3/3"]],
      ["abb-usu-4.2", "M-0002_A-A001-13-63C2.xml.gz", ["3/3/4"]],
      ["mdt-be02001", "M-0083_A-00B6-32-9642.xml.gz", ["3/3/1", "3/3/5"]],
      ["gvs-amma", "M-0085_A-0072-30-69AA.xml.gz", ["3/3/6"]],
    ];
    for (const [file, app, gas] of linked) {
      expect([file, partialLinkGas(`${file}-ets-partial-links.log`, parseAppConfig(catalogueXml(app)), gas.length)]).toEqual([file, gas.map(parseGa)]);
    }
    expect(partialLinkGas("jung-400021se-ets-partial-structure.log", parseAppConfig(catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz")), 1)).toEqual([parseGa("0/0/1")]);
  }, 30_000); // the 26.9 MB Jung application: under 1.2 s alone at load 24, 5-10 s in a full check at load 14-36; it builds the bench applications too
});

// ETS 6 partial downloads after linking objects to group addresses (and, on ABB and GVS, enabling
// a channel), trimmed per device. Every byte ETS wrote must equal the image Busforge builds for the
// same configuration: parameters, com-object table and group tables. Each link names its group address
// by its index among the addresses ETS wrote, ascending.
corpusDescribe("partial downloads with links against ETS", () => {
  const real = catalogueXml;
  const cases: { name: string; file: string; app: string; params: [string, string][]; links: [number, number][] }[] = [
    { name: "Jung 400021SE", file: "jung-400021se", app: "M-0004_A-7072-21-99A7-O000A.xml.gz", links: [[253, 0], [254, 1]],
      params: [["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_P-496_R-106", "1"]] },
    { name: "ABB US/U 4.2", file: "abb-usu-4.2", app: "M-0002_A-A001-13-63C2.xml.gz", links: [[1, 0]], params: [["M-0002_A-A001-13-63C2_P-9_R-9", "104"]] },
    { name: "MDT BE-02001.02", file: "mdt-be02001", app: "M-0083_A-00B6-32-9642.xml.gz", links: [[0, 0], [6, 1]], params: [] },
    { name: "GVS AMMA", file: "gvs-amma", app: "M-0085_A-0072-30-69AA.xml.gz", links: [[2, 0]], params: [["M-0085_A-0072-30-69AA_P-20_R-20", "1"], ["M-0085_A-0072-30-69AA_UP-142_R-142", "1"]] },
  ];
  for (const c of cases) {
    test(`${c.name}: every byte ETS wrote matches`, () => {
      const xml = real(c.app);
      const cfg = parseAppConfig(xml);
      const capture = `${c.file}-ets-partial-links.log`, ia = deviceOf(capture);
      const gas = partialLinkGas(capture, cfg, c.links.length);
      const build = classify(cfg).planFullDownload(cfg.mask, { ia: numToIa(ia), params: new Map(c.params), links: c.links.map(([n, g]) => ({ comObjNum: n, gaRaws: [gas[g]] })), proc: parseLoadProcedures(xml) });
      const cap = parseCapture(captureText(capture), ia);
      const refs = reportedTableReferences(cap);
      const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address ?? refs.get(seg.lsm) ?? null, baseSource: "t" })), memoryImage(cap.writes), etsAllocations(cap), []);
      const compared = r.segments.reduce((n, s) => n + s.compared, 0);
      expect(compared).toBeGreaterThan(0);
      expect(r.segments.flatMap((s) => s.divergences.map((d) => `${s.id}+${d.offset}`))).toEqual([]);
    }, 30_000); // the case parses its application: the Jung, under 1 s alone at load 24, 5.9 s in a full check at load 14-36
  }
});

// Two ETS 6 partial downloads onto the MDT BE-02001.02 (System 7, MV-0705), input A's object 0 linked to 0/0/20 and
// 0/0/21. "high": linked first to 0/0/21, so 0/0/21 sends. "low": linked first to 0/0/21, then to 0/0/20, and 0/0/20
// set as the sending address, so the sending address is the lower one and the one linked last. Both times ETS writes
// the sending address's association first, whatever its group index and whenever it was linked.
corpusDescribe("the sending address's association first, against ETS", () => {
  const app = "M-0083_A-00B6-32-9642.xml.gz";
  const [low, high] = [parseGa("0/0/20"), parseGa("0/0/21")];
  const cases = [
    { name: "a sending address above the other", capture: "mdt-be02001-ets-partial-sender-high.log", sending: high, other: low, assoc: [2, 2, 0, 1, 0] },
    { name: "a sending address below the other, linked last", capture: "mdt-be02001-ets-partial-sender-low.log", sending: low, other: high, assoc: [2, 1, 0, 2, 0] },
  ];
  const cfg = () => parseAppConfig(catalogueXml(app));
  const segmentAt = (id: string | undefined) => cfg().absoluteSegments.find((s) => s.id === id)!.address;
  const etsImage = (capture: string) => memoryImage(parseCapture(captureText(capture), deviceOf(capture)).writes);
  const divergences = (capture: string, gaRaws: number[]) => {
    const xml = catalogueXml(app);
    const c = parseAppConfig(xml), ia = deviceOf(capture);
    const build = classify(c).planFullDownload(c.mask, { ia: numToIa(ia), params: new Map(), links: [{ comObjNum: 0, gaRaws }], proc: parseLoadProcedures(xml) });
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address ?? null, baseSource: "t" })), etsImage(capture), etsAllocations(parseCapture(captureText(capture), ia)), []);
    expect(r.segments.reduce((n, s) => n + s.compared, 0)).toBeGreaterThan(0);
    expect([r.unattributed, r.segments.flatMap((s) => s.etsOnly)]).toEqual([[], []]);
    return r.segments.flatMap((s) => s.divergences.map((d) => `${s.id.split("_").pop()}+${d.offset}`));
  };

  for (const c of cases) {
    test(`${c.name}: the capture goes to the bench MDT and holds both addresses`, () => {
      expect(numToIa(deviceOf(c.capture))).toBe("1.1.56");
      expect(partialLinkGas(c.capture, cfg(), 2)).toEqual([low, high]);
    });

    test(`${c.name}: ETS lists the sending address's association first`, () => {
      const at = segmentAt(cfg().groupTables.associationSegment), mem = etsImage(c.capture);
      // [count][group index][object]: the address table is ascending, so index 1 is 0/0/20 and index 2 is 0/0/21.
      expect([0, 1, 2, 3, 4].map((o) => mem.get(at + o))).toEqual(c.assoc);
    });

    test(`${c.name}: Busforge's tables, sending address first, are every byte ETS wrote; the other order is not`, () => {
      expect(divergences(c.capture, [c.sending, c.other])).toEqual([]);
      // The other order swaps the two association entries' group indexes, and nothing else.
      expect(divergences(c.capture, [c.other, c.sending])).toEqual(["AS-4201+1", "AS-4201+3"]);
    });

    test(`${c.name}: decoded as a read-back decodes them, the tables ETS wrote give the sending address first`, () => {
      const k = cfg(), mem = etsImage(c.capture);
      const addrAt = segmentAt(k.groupTables.addressSegment), assocAt = segmentAt(k.groupTables.associationSegment);
      // ETS left the unit's own address (bytes 1-2 of the address table) as the unit held it.
      const ia = deviceOf(c.capture);
      const addr = Buffer.from([mem.get(addrAt)!, ia >> 8, ia & 0xff, ...[3, 4, 5, 6].map((o) => mem.get(addrAt + o)!)]);
      const assoc = Buffer.from([0, 1, 2, 3, 4].map((o) => mem.get(assocAt + o)!));
      expect(decodeGroupTablesMv0705(addr, assoc)).toEqual([{ comObjNum: 0, gaRaws: [c.sending, c.other] }]);
    });
  }
});

// The same partial downloads, for the System B parameter segment: ETS reallocates it without fill
// and writes exactly the bytes its parameter model owns. Busforge's parameter flash, merged over the
// device's segment as the full download left it, must write the same bytes with the same values.
corpusDescribe("System B parameter flash against ETS's partial download", () => {
  const real = catalogueXml;
  const cases: { name: string; app: string; file: string; params: [string, string][] }[] = [
    { name: "Jung 400021SE", app: "M-0004_A-7072-21-99A7-O000A.xml.gz", file: "jung-400021se",
      params: [["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_P-496_R-106", "1"]] },
    { name: "GVS AMMA", app: "M-0085_A-0072-30-69AA.xml.gz", file: "gvs-amma", params: [["M-0085_A-0072-30-69AA_P-20_R-20", "1"], ["M-0085_A-0072-30-69AA_UP-142_R-142", "1"]] },
  ];
  for (const c of cases) {
    test(`${c.name}: the same bytes, with the same values`, () => {
      const xml = real(c.app);
      const cfg = parseAppConfig(xml);
      const capture = `${c.file}-ets-partial-links.log`, ia = deviceOf(capture);
      const before = classify(cfg).planFullDownload(cfg.mask, { ia: numToIa(ia), params: new Map(), links: [], proc: parseLoadProcedures(xml) }).segments.find((s) => s.lsm === 4)!.image;
      const target = buildRelativeSegmentTarget(cfg, new Map(c.params), 4, { ownIdleUnionDefaults: true })!;
      const { image } = mergeRelativeTarget(Buffer.from(before), target);
      const ours = new Map<number, number>();
      for (const r of ownedRuns(image, target.owned)) r.bytes.forEach((b, i) => ours.set(r.offset + i, b));
      const cap = parseCapture(captureText(capture), ia);
      const base = reportedTableReferences(cap).get(4)!;
      const ets = new Map([...memoryImage(cap.writes)].filter(([a]) => a >= base && a < base + target.size).map(([a, b]) => [a - base, b]));
      expect([...ours.keys()].sort((a, b) => a - b)).toEqual([...ets.keys()].sort((a, b) => a - b));
      expect([...ours].filter(([o, b]) => ets.get(o) !== b)).toEqual([]);
    }, 30_000); // the case parses its application: the Jung, under 1 s alone at load 24, 10.2 s in a full check at load 14-36
  }
});

// ETS 6 partial downloads of a change that alters the com-object table. Jung 400021SE: K2
// switched from "Dimmen und Farbtemperatur" back to "Schalten" (secured; decrypted, the security
// object's writes left out). MDT BE-02001.02: input B switched from the two-object short/long function
// back to "Kontaktzustand senden" (object 8 goes), after an ETS full download with the two-object one.
corpusDescribe("structural flash against ETS's partial download", () => {
  const real = catalogueXml;

  // The structural flash is the family's rule: offered on every application tested against an ETS capture of one
  // (this suite, and "structural flash of the revert" in each application's suite), and off on the two firmware
  // stacks shown not to take its bracket (GVS, thelsing/OpenKNX), whose own captures it is therefore not held to.
  test("the structural flash follows the family rule: on every captured application, off on the GVS and OpenKNX firmware", () => {
    const captured = ["M-0004_A-7072-21-99A7", "M-0083_A-00B6-32-9642", "M-0083_A-00B4-32-3919", "M-0081_A-FE01-11-75D9", "M-0008_A-10D7-11-2783",
      "M-0048_A-107E-12-5B58", "M-0048_A-140C-14-EB70", "M-0048_A-493B-21-B471", "M-0048_A-9071-20-F258"];
    for (const id of captured) {
      const file = listCatalogue().find((f) => f.startsWith(id))!;
      expect([id, classify(parseAppConfig(catalogueXml(file))).capabilities().structuralFlash]).toEqual([id, true]);
    }
    expect(classify(parseAppConfig(catalogueXml("M-0085_A-0072-30-69AA.xml.gz"))).capabilities().structuralFlash).toBe(false);
    expect(classify(parseAppConfig(gunzipSync(readFileSync(capturePath("openknx-raumcontroller-5.5.1-app.xml.gz"))).toString("utf8"))).capabilities().structuralFlash).toBe(false);
  }, 60_000); // builds the OpenKNX application and ten others: 2.7 s alone at load 24, 33.4 s in a full check at load 14-36

  test("MDT BE-02001.02: ETS's bracket set, and Busforge writes exactly the bytes ETS changed, with ETS's values", () => {
    const xml = real("M-0083_A-00B6-32-9642.xml.gz");
    const cfg = parseAppConfig(xml);
    const ia = deviceOf("mdt-be02001-ets-fulldownload-b7.log");
    const before = memoryImage(parseCapture(captureText("mdt-be02001-ets-fulldownload-b7.log"), ia).writes);
    const ets = memoryImage(parseCapture(captureText("mdt-be02001-ets-partial-structure.log"), ia).writes);
    const params = new Map<string, string>();
    const instances = resolveModuleInstances(cfg, params);
    const view = buildDeviceConfig(cfg, params, undefined, instances);
    // The device's programmed baseline is the configuration ETS downloaded in full: input B short/long.
    const baseValues = new Map([["M-0083_A-00B6-32-9642_MD-2_M-3_MI-1_P-24_R-2", "7"]]);
    const images = absoluteStructuralImages(cfg, params, [], ia, { baseValues, moduleInstances: instances, comObjectTable: { active: view.imageComObjects, linked: new Set() } });
    // ETS's full download leaves the address table's own individual address to the device (it holds it
    // already), so those two bytes are the only ones the capture does not show; the device holds its own address there.
    const unseen = images.flatMap((w) => Array.from({ length: w.image.length }, (_, i) => w.address + i)).filter((a) => !before.has(a));
    expect(unseen).toEqual([0x4001, 0x4002]);
    before.set(0x4001, ia >> 8).set(0x4002, ia & 0xff);
    const current = new Map(images.map((w) => [w.address, Buffer.from(Array.from({ length: w.image.length }, (_, i) => before.get(w.address + i)!))]));
    const { plan, lsms } = planAbsoluteStructuralFlash(cfg, images, parseLoadProcedures(xml), current, true, instances);
    const ours = new Map<number, number>();
    for (const st of plan) if (st.op === "writeMem") st.bytes.forEach((b, i) => ours.set(st.address + i, b));
    const changedByEts = [...ets].filter(([a, b]) => before.get(a) !== b);
    expect(changedByEts.length).toBeGreaterThan(0);
    expect([...ours].filter(([a, b]) => ets.get(a) !== b)).toEqual([]);
    expect(changedByEts.filter(([a]) => !ours.has(a))).toEqual([]);
    expect(lsms).toEqual([1, 2, 3]);
    // ETS's sequence: both tables unloaded and declared again, the application loaded without either.
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps("mdt-be02001-ets-partial-structure.log", ia)));
  });

  test("Jung 400021SE: every byte ETS wrote matches Busforge's image", () => {
    const xml = real("M-0004_A-7072-21-99A7-O000A.xml.gz");
    const cfg = parseAppConfig(xml);
    const params: [string, string][] = [
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-154_R-220", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-150_R-243", "Taster"],
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-154_R-220", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-150_R-243", "Taster"],
    ];
    const capture = "jung-400021se-ets-partial-structure.log", ia = deviceOf(capture);
    const gas = partialLinkGas(capture, cfg, 1);
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: numToIa(ia), params: new Map(params), links: [{ comObjNum: 253, gaRaws: gas }], proc: parseLoadProcedures(xml) });
    const cap = parseCapture(captureText(capture), ia);
    const refs = reportedTableReferences(cap);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.compared, s.divergences.length])).toEqual([[4, 25, 0], [3, 7, 0], [2, 6, 0], [1, 4, 0]]);
    expect(r.unattributed).toEqual([]);
  }, 30_000); // the 26.9 MB Jung application: under 1.2 s alone at load 24, 5-10 s in a full check at load 14-36

  test("Jung 400021SE: the bracket is ETS's, every object reallocated without fill and the application completed first", () => {
    const xml = real("M-0004_A-7072-21-99A7-O000A.xml.gz");
    const proc = parseLoadProcedures(xml);
    const tables = { params: { image: Buffer.alloc(7701), owned: [], keptAt: 0x16000 }, comObj: { image: Buffer.alloc(2656), owned: [], keptAt: 0x15000 }, addr: Buffer.alloc(4), assoc: Buffer.alloc(6) };
    const sec = { groupKeys: Buffer.alloc(18), goFlags: Buffer.alloc(1), senders: Buffer.alloc(0) };
    const plan = planRelativeStructuralFlash(4, tables, Buffer.from("0004707221", "hex"), true, declaredMcbWrites(proc, 7701, "par"), sec);
    const shape = plan.map((st) => ("lsm" in st ? `${st.op}:${st.lsm}` : st.op === "writeProp" ? `mcb:${st.obj}` : st.op === "writeSecurityProp" ? `sec:${st.pid}` : st.op === "securityLsm" ? `secLsm:${st.event}` : st.op));
    expect(shape).toEqual([
      "unload:4", "unload:3", "unload:2", "unload:1", "secLsm:4",
      "load:4", "alloc:4", "mcb:4", "mcb:4", "load:3", "alloc:3", "load:1", "alloc:1", "load:2", "alloc:2",
      "writeSegmentOwned:4", "writeSegmentOwned:3", "writeSegment:2", "writeSegment:1",
      "secLsm:1", "sec:54", "sec:53", "sec:61", "secLsm:2",
      "stampAppId:4", "loadCompleted:4", "loadCompleted:3", "loadCompleted:2", "loadCompleted:1",
      "assertLoaded:3", "assertLoaded:2", "assertLoaded:1", "restart",
    ]);
    expect(plan.filter((st) => st.op === "alloc").every((st) => st.op === "alloc" && !st.fill)).toBe(true);
  }, 30_000); // the 26.9 MB Jung application: under 1.2 s alone at load 24, 5-10 s in a full check at load 14-36
});

// A System B download's steps from ETS's log, named as planShape names Busforge's. Its CompareProp
// pre-flights are run before the plan (runDeclaredChecks), so they are not steps here.
const etsShape = (file: string) => etsLog(file).steps.flatMap((s): string[] => {
  const a = s.attrs, v = s.verb.replace("LdCtrl", "");
  if (["Connect", "Disconnect", "MapError", "CompareProp"].includes(v)) return [];
  if (a.ObjType === "17") return [v === "WriteProp" ? `sec:${a.PropId}` : `sec${v}`];
  if (v === "WriteProp") return [Number(a.PropId) === 27 ? `mcb:${a.ObjIdx}#${a.StartElement ?? 1}=${(a.InlineData ?? "").slice(0, 16).toLowerCase()}` : `prop ${a.ObjIdx}/${a.PropId}=${(a.InlineData ?? "").toLowerCase()}`];
  if (v === "RelSegment") return [`alloc:${a.LsmIdx}+${a.Size}${a.Mode === "1" ? ` fill ${a.Fill}` : ""}`];
  if (v === "WriteRelMem") return [`write:${a.ObjIdx}`];
  if (v === "LoadImageProp") return [`read ${a.ObjIdx}/${a.PropId}x${a.Count ?? 1}`];
  if (v === "MasterReset") return [`restart confirmed (erase code ${a.EraseCode})`];
  if (v === "Restart") return ["restart"];
  return [`${v[0].toLowerCase()}${v.slice(1)}:${a.LsmIdx}`];
}).filter((s, i, xs) => !(s === "sec:54" && xs[i - 1] === "sec:54"));
const planShape = (plan: LoadPlan) => plan.flatMap((s): string[] => {
  if (s.op === "securityLsm") return [`sec${({ 1: "Load", 2: "LoadCompleted", 4: "Unload" } as Record<number, string>)[s.event]}`];
  if (s.op === "writeSecurityProp") return [`sec:${s.pid}`];
  if (s.op === "writeProp") return [s.pid === 27 ? `mcb:${s.obj}#${s.start ?? 1}=${s.data.toString("hex")}` : `prop ${s.obj}/${s.pid}=${s.data.toString("hex")}`];
  if (s.op === "alloc") return [`alloc:${s.lsm}+${s.size}${s.fill ? ` fill ${s.fillByte ?? 0}` : ""}`];
  if (s.op === "writeSegmentOwned" || s.op === "writeSegment") return [`write:${s.lsm}`];
  if (s.op === "stampAppId") return [`prop ${s.lsm}/13=${s.data.toString("hex")}`];
  if (s.op === "readProp") return [`read ${s.obj}/${s.pid}x${s.count ?? 1}`];
  if (s.op === "assertLoaded") return [];
  if (s.op === "restart") return [s.confirmed ? "restart confirmed (erase code 1)" : "restart"];
  return ["lsm" in s ? `${s.op}:${s.lsm}` : s.op];
}).filter((s, i, xs) => !(s === "sec:54" && xs[i - 1] === "sec:54"));
// Every byte ETS sent to a secured unit, from the plaintext of its memory writes in its log.
const etsWrites = (file: string) => {
  const m = new Map<number, number>();
  for (const l of captureText(file).split(/\r?\n/)) {
    const w = !l.includes("Sending") && l.match(/ Send Sec_req -> .*InnerTelegram=MemoryExtended_Write_req -> \S+ \([^)]*\) Address=\$([0-9A-F]+) Count=\d+ Data=([0-9A-F]+)/);
    if (w) Buffer.from(w[2], "hex").forEach((b, i) => m.set(Number.parseInt(w[1], 16) + i, b));
  }
  return m;
};
// The individual address of the device an ETS log's secured memory writes went to.
const logDevice = (file: string) => {
  const to = new Set(captureText(file).split(/\r?\n/).flatMap((l) => l.match(/ Send Sec_req -> .*InnerTelegram=MemoryExtended_Write_req -> (\d+\.\d+\.\d+) /)?.[1] ?? []));
  if (to.size !== 1) throw new Error(`${file}: the secured memory writes go to ${to.size} devices, not one`);
  return [...to][0];
};
// ETS 6 "Applikationsprogramm" downloads of the Jung 400021SE (PreferPartialDownloadIfApplicationLoaded) on the
// bench unit holding the application, in a row: no change, K1's debounce time 10 -> 20 ms, 20 -> 30 ms with
// object 261 linked to K1's group address too, and the revert. ETS takes the partial form each time ("Trying partial/differential
// download because of PreferPartialDownloadIfApplicationLoaded"). The unit is secured, so the steps and the
// plaintext of every memory write come from ETS's own log. The unit before the first: its read-only read after
// the last (the stamps ETS read before the first and after the last are equal), byte 7700 cleared by the firmware.
corpusDescribe("Jung 400021SE full download on a loaded unit against ETS", () => {
  const xml = catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const K = (s: string) => `M-0004_A-7072-21-99A7-O000A_${s}`;
  const base: [string, string][] = [[K("MD-1_M-100_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-100_MI-1_P-150_R-243"), "Taster"], [K("MD-1_M-200_MI-1_P-154_R-220"), "Taster"], [K("MD-1_M-200_MI-1_P-150_R-243"), "Taster"]];
  const DEBOUNCE = K("MD-1_M-100_MI-1_UP-35_R-137");
  const snapshot = JSON.parse(captureText("jung-400021se-unit-q2.json")) as { segments: Record<string, { at: number; hex: string }>; mcb: Record<string, { size: number; control: number }[]> };
  // The one group address the unit's address table holds, K1's.
  const gas = tableGas((o) => Buffer.from(snapshot.segments[1].hex, "hex")[o], "systemB");
  const K1 = { comObjNum: 253, gaRaws: gas }, K2 = { comObjNum: 261, gaRaws: gas };
  const runs = [
    { log: "jung-400021se-ets6log-q2-nochange.txt", params: base, links: [K1] },
    { log: "jung-400021se-ets6log-q2-param.txt", params: [...base, [DEBOUNCE, "20"]] as [string, string][], links: [K1] },
    { log: "jung-400021se-ets6log-q2-param-link.txt", params: [...base, [DEBOUNCE, "30"]] as [string, string][], links: [K1, K2] },
    { log: "jung-400021se-ets6log-q2-revert.txt", params: base, links: [K1] },
  ];
  const at = (lsm: number) => snapshot.segments[lsm].at;
  const ourWrites = (plan: LoadPlan) => {
    const m = new Map<number, number>();
    for (const s of plan) {
      if (s.op === "writeSegmentOwned") s.image.forEach((b, i) => { if (s.owned[i]) m.set(s.keptAt + i, b); });
      if (s.op === "writeSegment") s.bytes.forEach((b, i) => m.set(at(s.lsm) + i, b));
    }
    return m;
  };

  test("each download is ETS's partial form, step by step and byte by byte", () => {
    expect(gas.length).toBe(1);
    const unit = new Map<number, Buffer>([1, 2, 3, 4].map((l) => [l, Buffer.from(snapshot.segments[l].hex, "hex")]));
    for (const run of runs) {
      const unitMemory = { params: unit.get(4)!, paramsAt: at(4), paramsMcb: snapshot.mcb[4], comObj: unit.get(3)!, comObjAt: at(3), comObjMcb: snapshot.mcb[3] };
      const build = classify(cfg).planFullDownload(cfg.mask, {
        ia: logDevice(run.log), params: new Map(run.params), links: run.links, proc, unitHoldsApplication: true, unitMemory,
        security: { groupKeys: new Map([[gas[0], Buffer.alloc(16, 0x11)]]) },
      });
      expect([run.log, planShape(build.plan)]).toEqual([run.log, etsShape(run.log)]);
      const ets = etsWrites(run.log);
      expect([run.log, [...ourWrites(build.plan)].sort((x, y) => x[0] - y[0])]).toEqual([run.log, [...ets].sort((x, y) => x[0] - y[0])]);
      // The unit after the download: ETS's bytes, the tables as written, and byte 7700 cleared by the firmware.
      for (const l of [1, 2, 3, 4]) {
        const seg = l <= 2 ? build.segments.find((s) => s.lsm === l)!.image : Buffer.from(unit.get(l)!);
        if (l > 2) for (const [a, b] of ets) if (a >= at(l) && a < at(l) + seg.length) seg[a - at(l)] = b;
        unit.set(l, Buffer.from(seg));
      }
      unit.get(4)![7700] = 0;
    }
    // The revert leaves the unit where it started.
    for (const l of [1, 2, 3, 4]) expect(unit.get(l)!.toString("hex")).toBe(snapshot.segments[l].hex);
  });

  // ETS's download with no change still writes the marker P-1 (byte 7700, its own region with CRC control
  // 1) and restarts the unit, as a full download of Busforge's does (above). Busforge's parameter flash
  // writes only a change: the cleared marker alone is none (constantParams), so it is unchanged.
  test("parameter flash with nothing changed: the cleared download marker alone is no change", () => {
    expect(constantParams(cfg).get(K("P-1"))).toBe("1");
    const unit = Buffer.from(snapshot.segments[4].hex, "hex");
    const target = buildRelativeSegmentTarget(cfg, new Map(base), 4, { ownIdleUnionDefaults: true })!;
    const { image, diffBytes } = mergeRelativeTarget(unit, target);
    expect([[...image.keys()].filter((o) => image[o] !== unit[o]), diffBytes]).toEqual([[7700], 0]);
    expect(differingConstants(cfg, target.constants, unit, image).map((c) => c.paramRefId)).toEqual([expect.stringMatching(/_P-1_R-/)]);
  });
});

// ETS 6 full download of the Theben DALI-Gateway KNX plus (System B, PreferPartialDownloadIfApplicationLoaded, not
// secured) on a unit holding the application, project unchanged: the partial form. The unit's com-object
// table reports CRC control 1 and goes whole although unchanged, its application (control 0) has no differing
// byte and is not reloaded, the group tables are written whole.
corpusDescribe("Theben DALI-Gateway full download on a loaded unit against ETS", () => {
  test("ETS's partial form, step by step and byte by byte", () => {
    const fx = JSON.parse(captureText("dali-gateway-unit-fulldownload.json")) as {
      ia: string; params: [string, string][]; instances: ModuleInstance[]; links: { comObjNum: number; gaRaws: number[] }[]; overrides: [number, ComObjInstanceOverride][];
      segments: Record<string, { at: number; hex: string }>; mcb: Record<string, { size: number; control: number }[]>;
    };
    const xml = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz");
    const cfg = parseAppConfig(xml);
    const seg = (l: number) => Buffer.from(fx.segments[l].hex, "hex"), at = (l: number) => fx.segments[l].at;
    const build = classify(cfg).planFullDownload(cfg.mask, {
      ia: fx.ia, params: new Map(fx.params), links: fx.links, moduleInstances: fx.instances, comObjectOverrides: new Map(fx.overrides), proc: parseLoadProcedures(xml),
      unitHoldsApplication: true, unitMemory: { params: seg(4), paramsAt: at(4), paramsMcb: fx.mcb[4], comObj: seg(3), comObjAt: at(3), comObjMcb: fx.mcb[3] },
    });
    expect(planShape(build.plan)).toEqual(etsShape("dali-ets6log-fulldownload.txt"));
    const ours = new Map<number, number>();
    for (const s of build.plan) {
      if (s.op === "writeSegmentOwned") s.image.forEach((b, i) => { if (s.owned[i]) ours.set(s.keptAt + i, b); });
      if (s.op === "writeSegment") s.bytes.forEach((b, i) => ours.set(at(s.lsm) + i, b));
    }
    const ets = memoryImage(parseCapture(captureText("dali-ets-fulldownload.log"), iaToNum(fx.ia)).writes);
    expect(ours.size).toBe(seg(3).length + build.segments.find((s) => s.lsm === 2)!.image.length + build.segments.find((s) => s.lsm === 1)!.image.length);
    expect([...ours].sort((x, y) => x[0] - y[0])).toEqual([...ets].sort((x, y) => x[0] - y[0]));
  });
});

// The CLI's partial mode, end to end: one record per Busforge flash operation that the partial
// download touched, and none for an operation whose segments ETS left alone.
corpusDescribe("etsdiff --partial evidence", () => {
  const realDir = catalogueDir();
  const cli = async (args: string[]) => {
    const out = join(tmpdir(), `etsdiff-partial-${crypto.randomUUID()}.json`);
    const p = Bun.spawnSync(["bun", "run", join(import.meta.dir, "etsdiff.ts"), ...args, "--partial", `--evidence=${out}`], { stdout: "pipe", stderr: "pipe" });
    const written = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as { scope: { operation: string; configuration: string }; results: { reference: { state: string; detail?: string } } }[] : null;
    rmSync(out, { force: true });
    return {
      exitCode: p.exitCode, records: written?.map((r) => [r.scope.operation, r.results.reference.state]) ?? null, details: written?.map((r) => r.results.reference.detail) ?? [],
      configurations: written?.map((r) => r.scope.configuration) ?? [], stderr: p.stderr.toString(),
    };
  };
  // The device and the group addresses of a capture, as the command line names them.
  const target = (file: string, app: string, n: number) => ({
    ia: `--ia=${numToIa(deviceOf(file))}`, gas: partialLinkGas(file, parseAppConfig(catalogueXml(app)), n).map(String),
  });
  test("GVS AMMA: parameters and links, one pass each", async () => {
    const t = target("gvs-amma-ets-partial-links.log", "M-0085_A-0072-30-69AA.xml.gz", 1);
    const r = await cli([capturePath("gvs-amma-ets-partial-links.log"), `--app=${join(realDir, "M-0085_A-0072-30-69AA.xml.gz")}`, t.ia,
      "--param=M-0085_A-0072-30-69AA_P-20_R-20=1", "--param=M-0085_A-0072-30-69AA_UP-142_R-142=1", `--link=2:${t.gas[0]}`]);
    expect([r.exitCode, r.records]).toEqual([0, [["flashParams", "pass"], ["flashLinks", "pass"]]]);
  });
  // An installation's addresses must not reach a shipped record: --redact-addresses names each link's
  // group addresses by their count and leaves everything else of the configuration and the comparison
  // as it is. Five CLI runs; the timeout leaves room for a loaded check run.
  test("GVS AMMA: --redact-addresses names the links without their group addresses, and the comparison is unchanged", async () => {
    const t = target("gvs-amma-ets-partial-links.log", "M-0085_A-0072-30-69AA.xml.gz", 1);
    const ga = `0x${Number(t.gas[0]).toString(16).padStart(4, "0")}`;
    const args = [capturePath("gvs-amma-ets-partial-links.log"), `--app=${join(realDir, "M-0085_A-0072-30-69AA.xml.gz")}`, t.ia,
      "--param=M-0085_A-0072-30-69AA_P-20_R-20=1", "--param=M-0085_A-0072-30-69AA_UP-142_R-142=1", `--link=2:${t.gas[0]}`];
    const listed = await cli(args);
    const redacted = await cli([...args, "--redact-addresses"]);
    expect([listed.exitCode, listed.records]).toEqual([0, [["flashParams", "pass"], ["flashLinks", "pass"]]]);
    expect([redacted.exitCode, redacted.records, redacted.details]).toEqual([listed.exitCode, listed.records, listed.details]);
    expect(listed.configurations.every((c) => c.includes(`#2->${ga}`))).toBe(true);
    expect(redacted.configurations).toEqual(listed.configurations.map((c) => c.replace(`#2->${ga}`, "#2->1 group address")));
    // Without a record to write, the flag has nothing to apply to and is refused.
    const run = (extra: string[]) => {
      const p = Bun.spawnSync(["bun", "run", join(import.meta.dir, "etsdiff.ts"), ...args, "--partial", ...extra], { stdout: "pipe", stderr: "pipe" });
      return [p.exitCode === 0, p.stderr.toString()] as const;
    };
    for (const extra of [["--redact-addresses"], ["--redact-addresses", "--evidence="]]) {
      const [ok, err] = run(extra);
      expect([extra, ok, err.includes("--redact-addresses applies to the evidence record")]).toEqual([extra, false, true]);
    }
    // A misspelt flag is refused, so it cannot leave the addresses in by accident.
    const out = join(tmpdir(), `etsdiff-misspelt-${crypto.randomUUID()}.json`);
    const [ok, err] = run(["--redact-address", `--evidence=${out}`]);
    expect([ok, err.includes("unknown option(s): --redact-address"), existsSync(out)]).toEqual([false, true, false]);
  }, 30_000);
  test("MDT BE-02001.02: links only, so no parameter record", async () => {
    const t = target("mdt-be02001-ets-partial-links.log", "M-0083_A-00B6-32-9642.xml.gz", 2);
    const r = await cli([capturePath("mdt-be02001-ets-partial-links.log"), `--app=${join(realDir, "M-0083_A-00B6-32-9642.xml.gz")}`, t.ia, `--link=0:${t.gas[0]}`, `--link=6:${t.gas[1]}`]);
    expect([r.exitCode, r.records]).toEqual([0, [["flashLinks", "pass"]]]);
  });
  for (const [file, sendingIsHigh] of [["mdt-be02001-ets-partial-sender-high.log", true], ["mdt-be02001-ets-partial-sender-low.log", false]] as const) {
    test(`MDT BE-02001.02: ${file} passes only with its sending address first`, async () => {
      const [low, high] = target(file, "M-0083_A-00B6-32-9642.xml.gz", 2).gas;
      const [sending, other] = sendingIsHigh ? [high, low] : [low, high];
      const run = (gas: string) => cli([capturePath(file), `--app=${join(realDir, "M-0083_A-00B6-32-9642.xml.gz")}`, `--ia=${numToIa(deviceOf(file))}`, `--link=0:${gas}`]);
      const [pass, fail] = [await run(`${sending},${other}`), await run(`${other},${sending}`)];
      expect([pass.exitCode, pass.records]).toEqual([0, [["flashLinks", "pass"]]]);
      expect([fail.exitCode, fail.records]).toEqual([1, [["flashLinks", "fail"]]]);
    });
  }
  test("a configuration ETS did not download fails, and its record says so", async () => {
    const t = target("mdt-be02001-ets-partial-links.log", "M-0083_A-00B6-32-9642.xml.gz", 2);
    const r = await cli([capturePath("mdt-be02001-ets-partial-links.log"), `--app=${join(realDir, "M-0083_A-00B6-32-9642.xml.gz")}`, t.ia, `--link=0:${t.gas[0]}`]);
    expect([r.exitCode, r.records]).toEqual([1, [["flashLinks", "fail"]]]);
  });
  // GVS AMMA (System B): the parameter segment is placed by the device's table reference and
  // matches; ETS also allocated the association table (a fill and no write) but the capture holds
  // no table reference for it, so that segment could not be compared.
  test("a table ETS allocated but the capture cannot place is a failed record, not a silent pass", async () => {
    const xml = catalogueXml("M-0085_A-0072-30-69AA.xml.gz");
    const cfg = parseAppConfig(xml);
    const params = classify(cfg).planFullDownload(cfg.mask, { ia: DEV, params: new Map(), links: [], proc: parseLoadProcedures(xml) }).segments.find((s) => s.lsm === 4)!;
    const base = 0x3fc6;
    const capture = join(tmpdir(), `etsdiff-gvs-${crypto.randomUUID()}.log`);
    writeFileSync(capture, [
      line("BRIDGE->ETS", 0x29, DEV, "0.0.0", propResponse(4, 7, [0, 0, base >> 8, base & 0xff])),
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memWrite(base, [...params.image.subarray(0, 4)])),
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, propWrite(2, 5, [0x03, 0x0b, 0, 0, 0, 0x02, 0, 0, 0, 0])),
    ].join("\n"));
    const r = await cli([capture, `--app=${join(realDir, "M-0085_A-0072-30-69AA.xml.gz")}`, `--ia=${DEV}`]);
    rmSync(capture, { force: true });
    expect([r.exitCode, r.records]).toEqual([1, [["flashParams", "pass"], ["flashLinks", "fail"]]]);
    expect(r.details[1]).toContain("L2 association table not compared, address unknown");
    expect(r.details[1]).toContain("L1 address table not written by this partial download");
  });
});

// What ETS sent to the device from its first load-state event on, as steps: load-state events,
// segment declarations (a stack segment, SegType 1, marked "/t1"), one "write" per run of memory writes, device-control writes, property reads,
// the restart. Its reads before the first event (identity, stamps for its differential download)
// are not part of the procedure.
function captureSteps(file: string, ia: number): string[] {
  const out: string[] = [];
  for (const l of captureText(file).split("\n")) {
    const m = l.includes("ETS->BRIDGE") ? l.match(/\| ([0-9a-fA-F]+)\s*$/) : null;
    const fr = m ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group || fr.dst !== ia || fr.tpdu.length < 2) continue;
    const t = fr.tpdu, apci = ((t[0] & 0x03) << 8) | t[1];
    if (apci === 0x3d7 && t[3] === 5) {
      const d = t.subarray(6);
      out.push(d[0] === 3 ? (d[1] <= 1 ? `absSegment:${t[2]}@${d.readUInt16BE(2)}+${d.readUInt16BE(4)}${d[1] ? "/t1" : ""}` : d[1] === 4 ? `taskCtrl1:${t[2]}=${d.subarray(2).toString("hex")}` : `taskSegment:${t[2]}@${d.readUInt16BE(2)}=${d.subarray(4).toString("hex")}`)
        : `${({ 1: "load", 2: "loadCompleted", 4: "unload" } as Record<number, string>)[d[0]]}:${t[2]}`);
    }
    // A memory-mapped load-state machine (MV-0701) takes the same controls as an 11-byte memory write to
    // 0x0104: the LSM and the event in the first byte, the property form's fields behind a segment-id byte.
    else if ((apci & 0x3c0) === 0x280 && t.readUInt16BE(2) === 0x0104) {
      const d = t.subarray(4), lsm = d[0] >> 4, ev = d[0] & 0x0f;
      out.push(ev === 3 ? (d[1] <= 1 ? `absSegment:${lsm}@${d.readUInt16BE(3)}+${d.readUInt16BE(5)}${d[1] ? "/t1" : ""}` : d[1] === 4 ? `taskCtrl1:${lsm}=${d.subarray(3).toString("hex")}` : `taskSegment:${lsm}@${d.readUInt16BE(3)}=${d.subarray(5).toString("hex")}`)
        : `${({ 1: "load", 2: "loadCompleted", 4: "unload" } as Record<number, string>)[ev]}:${lsm}`);
    }
    else if (!out.length) continue;
    else if (apci === 0x3d7) out.push(`prop ${t[2]}/${t[3]}=${t.subarray(6).toString("hex")}`);
    else if (apci === 0x3d5) {
      // A read sent again right after itself is ETS repeating a request that got no answer in time
      // (gira-m0008-ets-partial-links.log, 3/27 element 6), not a second step.
      const step = `read ${t[2]}/${t[3]}#${((t[4] & 0x0f) << 8) | t[5]}`;
      if (out.at(-1) !== step) out.push(step);
    }
    else if ((apci & 0x3c0) === 0x280) { if (out.at(-1) !== "write") out.push("write"); }
    else if ((apci & 0x3c0) === 0x380) out.push("restart");
  }
  return out;
}
// `propDataMax`: the element data one property response carries on the device (loadrunner splits a
// closing read by it); 10 on a standard-frame device such as every System 7 one here.
function planSteps(plan: LoadPlan, propDataMax = 10): string[] {
  const out: string[] = [];
  for (const s of plan) {
    if (s.op === "absSegment") out.push(`absSegment:${s.lsm}@${s.address}+${s.size}${s.segType ? `/t${s.segType}` : ""}`);
    else if (s.op === "taskSegment") out.push(`taskSegment:${s.lsm}@${s.address}=${Buffer.from([s.peiType, s.manufacturer >> 8, s.manufacturer & 0xff, s.appNumber >> 8, s.appNumber & 0xff, s.version]).toString("hex")}`);
    else if (s.op === "unload" || s.op === "load" || s.op === "loadCompleted") out.push(`${s.op}:${s.lsm}`);
    else if (s.op === "writeMem") { if (out.at(-1) !== "write") out.push("write"); }
    else if (s.op === "readProp") {
      const count = s.count ?? 1, per = s.elementSize ? Math.max(1, Math.floor(propDataMax / s.elementSize)) : count;
      for (let at = s.start; at < s.start + count; at += per) out.push(`read ${s.obj}/${s.pid}#${at}`);
    }
    else if (s.op === "taskCtrl1") out.push(`taskCtrl1:${s.lsm}=${Buffer.from([s.address >> 8, s.address & 0xff, s.count, 0, 0, 0, 0, 0]).toString("hex")}`);
    else if (s.op === "restart") out.push("restart");
    else out.push(s.op);
  }
  return out;
}
// ETS switches the device into verify mode before its first memory write (reads device control,
// object 0 PID 14, and writes it back with bit 0x04 set: 04, or 05 where the read showed the application
// stopped, as on the MDT BE-06001.02 with LSM 3 unloaded or loading) and takes the device's echo of each
// write. Busforge reads every write back instead (KnxDevice.memWrite), the proof the MV-0705 parameter
// flash is hardware-proven on, so this is the one step of ETS's it leaves out.
const VERIFY_READ = "read 0/14#1";
const isVerifyWrite = (s: string) => /^prop 0\/14=[0-9a-f]{2}$/.test(s) && (Number.parseInt(s.slice(-2), 16) & 0x04) !== 0;
const withoutVerifyMode = (steps: string[]) => {
  const at = steps.findIndex(isVerifyWrite);
  expect([steps.filter((s) => s === VERIFY_READ || isVerifyWrite(s)).length, steps[at - 1]]).toEqual([2, VERIFY_READ]);
  return steps.filter((s) => s !== VERIFY_READ && !isVerifyWrite(s));
};
const STAMPS = ["read 1/27#1", "read 2/27#1", ...[1, 2, 3, 4, 5, 6].map((i) => `read 3/27#${i}`)];
const bytesOf = (plan: LoadPlan) => {
  const m = new Map<number, number>();
  for (const s of plan) if (s.op === "writeMem") s.bytes.forEach((b, i) => m.set(s.address + i, b));
  return m;
};
const span = (m: Map<number, number> | number[]) => {
  const xs = (Array.isArray(m) ? m : [...m.keys()]).sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length;) { let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++; out.push(`${xs[i].toString(16)}-${xs[j].toString(16)}`); i = j + 1; }
  return out;
};

// ETS's own log of each download: the steps it executed, and the image it executed them with (a hex
// dump per memory range, "--" where it writes nothing).
const etsLog = (file: string) => {
  const lines = captureText(file).split(/\r?\n/);
  const steps = lines.flatMap((l) => {
    const m = l.match(/ - Executing: <(\w+)([^>]*?)\s*\/>/);
    return m ? [{ verb: m[1], attrs: Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])) }] : [];
  });
  const image = new Map<number, number>();
  let base = -1, inImage = false;
  for (const l of lines) {
    if (l.includes(" - Execute image:")) { inImage = true; continue; }
    if (l.includes(" - Execute procedure:")) inImage = false;
    if (!inImage) continue;
    // A range header: device memory, or a system property ETS writes (SystemProperty(0/78)[...]), whose
    // rows are not memory.
    const range = l.match(/ - (\w+)(?:\([^)]*\))?\[\$([0-9A-F]+)-\$[0-9A-F]+\]:$/);
    if (range) { base = range[1] === "Memory" ? Number.parseInt(range[2], 16) : -1; continue; }
    const row = l.match(/ - {2}([0-9A-F]{4}): ((?:(?:[0-9A-F]{2}|--) ?){1,16})$/);
    if (row && base >= 0) row[2].trim().split(" ").forEach((b, i) => { if (b !== "--") image.set(base + Number.parseInt(row[1], 16) + i, Number.parseInt(b, 16)); });
  }
  // ETS's differential download leaves out of the image (and the dump) the bytes its stamps say the
  // device holds, and logs how many.
  const removed = lines.map((l) => l.match(/Differential Download: removed (\d+) identical bytes/)).find(Boolean);
  return { steps, image, removed: removed ? Number(removed[1]) : 0 };
};

// What a memory-mapped unit held before ETS wrote it: every byte of an A_Memory_Response the unit sent before
// ETS's first write to that byte (ETS reads each block of its image first there).
// `before`: what the unit held where ETS read nothing (its state after the earlier downloads).
function heldBeforeWrite(file: string, ia: number, before: Map<number, number> = new Map()): Map<number, number> {
  const held = new Map<number, number>(before), written = new Set<number>();
  for (const l of captureText(file).split("\n")) {
    const m = l.match(/\| ([0-9a-fA-F]+)\s*$/);
    const fr = m && l.includes("TUNNELLING_REQ") ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group || fr.tpdu.length < 4) continue;
    const t = fr.tpdu, apci = ((t[0] & 0x03) << 8) | t[1], n = t[1] & 0x3f, at = t.readUInt16BE(2);
    if (l.includes("BRIDGE->ETS") && fr.src === ia && (apci & 0x3c0) === 0x240) t.subarray(4, 4 + n).forEach((b, i) => { if (!written.has(at + i)) held.set(at + i, b); });
    if (l.includes("ETS->BRIDGE") && fr.dst === ia && (apci & 0x3c0) === 0x280) for (let i = 0; i < n; i++) written.add(at + i);
  }
  return held;
}
// The bytes a plan's memory writes send with read-compare (differingRuns) against what the unit held, read in
// blocks of 12 bytes (A_Memory_Read on a 15-octet APDU, as ETS reads these devices).
function readCompared(plan: LoadPlan, held: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const st of plan) {
    if (st.op !== "writeMem") continue;
    const have = Buffer.from(Array.from(st.bytes, (_, i) => { const v = held.get(st.address + i); if (v === undefined) throw new Error(`no read of 0x${(st.address + i).toString(16)} before ETS's writes`); return v; }));
    for (const r of differingRuns(st.address, st.bytes, have, 12)) r.bytes.forEach((b, i) => out.set(r.address + i, b));
  }
  return out;
}

// Busforge's System 7 structural flash of the change an ETS revert capture reverses: ETS reverted a
// parameter change and a link change in one partial download, which is the one bracket set ETS runs for
// a change of both (docs/load-procedures.md, "The structural flash"). `device`: what the unit held before
// the revert, by address. `params`/`links`: the configuration the revert downloads; `baseParams`: the one
// the unit was programmed with before it.
function system7StructuralFlash(o: {
  cfg: ReturnType<typeof parseAppConfig>; proc: ReturnType<typeof parseLoadProcedures>; ia: number; device: Map<number, number>;
  params: Map<string, string>; baseParams: Map<string, string>; links: { comObjNum: number; gaRaws: number[] }[];
  overrides?: Parameters<typeof withInstanceOverrides>[1]; moduleInstances?: ModuleInstance[];
}) {
  const instances = o.moduleInstances ?? [];
  const view = buildDeviceConfig(o.cfg, o.params, undefined, instances);
  const comObjectTable = { active: withInstanceOverrides(view.imageComObjects, o.overrides), linked: new Set(o.links.map((l) => l.comObjNum)) };
  const images = absoluteStructuralImages(o.cfg, o.params, o.links, o.ia, { baseValues: o.baseParams, baseInstances: instances, moduleInstances: instances, comObjectTable });
  const current = new Map(images.map((w) => [w.address, Buffer.from(Array.from({ length: w.image.length }, (_, i) => {
    const b = o.device.get(w.address + i);
    if (b === undefined) throw new Error(`the unit's byte at ${(w.address + i).toString(16)} is not known`);
    return b;
  }))]));
  return planAbsoluteStructuralFlash(o.cfg, images, o.proc, current, true, absoluteBuildInstances(o.cfg, o.params, instances));
}
// What a System 7 unit holds: every segment's template, its own individual address in the address
// table, then the bytes of each download in order.
function unitMemory(cfg: ReturnType<typeof parseAppConfig>, ia: number, ...downloads: Map<number, number>[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of cfg.absoluteSegments) s.data.forEach((b, i) => m.set(s.address + i, b));
  const addrAt = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.addressSegment)!.address;
  m.set(addrAt + 1, ia >> 8).set(addrAt + 2, ia & 0xff);
  for (const d of downloads) for (const [a, b] of d) m.set(a, b);
  return m;
}
// The structural flash against the revert: ETS's steps (verify mode aside), every byte Busforge writes
// with ETS's value, and every byte ETS changes on the unit written by Busforge; against ETS's wire exactly
// ETS's bytes.
// `etsImage`: ETS's image from its log, where ETS reads the unit and leaves out on the wire what it
// already holds (Meteodata 140 S); the steps are then compared without their writes.
// Against ETS's wire the bytes are ETS's exactly; against ETS's logged image (a read-compare unit) every byte
// written has ETS's value and every byte ETS changed is written.
function expectRevertForm(plan: LoadPlan, file: string, ia: number, device: Map<number, number>, etsImage?: Map<number, number>) {
  const steps = (x: string[]) => (etsImage ? x.filter((s) => s !== "write") : x);
  expect(steps(planSteps(plan))).toEqual(steps(etsImage ? captureSteps(file, ia) : withoutVerifyMode(captureSteps(file, ia))));
  const ets = etsImage ?? memoryImage(parseCapture(captureText(file), ia).writes);
  const ours = bytesOf(plan);
  expect([...ours].filter(([a, b]) => ets.get(a) !== b)).toEqual([]);
  const changed = [...ets].filter(([a, b]) => device.get(a) !== b);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.filter(([a]) => !ours.has(a))).toEqual([]);
  if (!etsImage) expect([file, [...ours.keys()].sort((x, y) => x - y)]).toEqual([file, [...ets.keys()].sort((x, y) => x - y)]);
}

// ETS 6 full download of the ABB US/U 4.2 (M-0002_A-A001-13-63C2, MV-0701, PreferPartialDownloadIfApplicationLoaded)
// on the bench unit holding this application loaded, project at its defaults: ETS takes the partial form
// ("Trying partial/differential download because of PreferPartialDownloadIfApplicationLoaded"), reloads
// the group tables and writes into the loaded application. Of its data segments ETS's image holds every
// byte a parameter covers and no other: nothing of the code segment AS-4600 or of AS-6F10, which no
// parameter covers. On the wire it reads the unit first and writes only the bytes that differ.
corpusDescribe("ABB US/U 4.2 (M-0002_A-A001-13-63C2) full download on a loaded unit against ETS", () => {
  const xml = catalogueXml("M-0002_A-A001-13-63C2.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const ia = deviceOf("abb-usu-4.2-ets-fulldownload-loaded.log"), IA = numToIa(ia);
  const FILE = "abb-usu-4.2-ets-fulldownload-loaded.log", LOG = etsLog("abb-usu-4.2-ets6log-fulldownload-loaded.txt");
  const build = () => classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: new Map(), links: [], proc, unitHoldsApplication: true });

  test("ETS's log: the partial form, LSM 3 neither unloaded nor declared, each of its segments written into it", () => {
    expect(LOG.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual([
      "LdCtrlConnect", "LdCtrlCompareProp", "LdCtrlUnload1", "LdCtrlUnload2",
      "LdCtrlLoad1", "LdCtrlAbsSegment1", "LdCtrlTaskSegment1", "LdCtrlLoadCompleted1",
      "LdCtrlLoad2", "LdCtrlAbsSegment2", "LdCtrlTaskSegment2", "LdCtrlLoadCompleted2",
      "LdCtrlLoad3", "LdCtrlWriteMem17920", "LdCtrlWriteMem28432", "LdCtrlWriteMem17406", "LdCtrlWriteMem27904", "LdCtrlWriteMem28416",
      "LdCtrlLoadCompleted3", "LdCtrlRestart", "LdCtrlDisconnect",
    ]);
  });

  test("Busforge's partial form writes exactly ETS's image, with its values: no byte of a segment no parameter covers", () => {
    const ours = bytesOf(build().plan);
    expect([...ours].sort(([a], [b]) => a - b)).toEqual([...LOG.image].sort(([a], [b]) => a - b));
    expect(span(ours)).toEqual(["4000-4000", "4200-4200", "43fe-4478", "6d00-6d16", "6d20-6d36", "6d40-6d56", "6d60-6d76", "6d80-6d81", "6d83-6d87", "6f00-6f04"]);
    expect(parameterMemoryBytes(cfg, "M-0002_A-A001-13-63C2_AS-4600", 7790)!.some(Boolean)).toBe(false);
    // What ETS sent on the wire is the part of that image the unit did not hold.
    const wire = new Map([...memoryImage(parseCapture(captureText(FILE), ia).writes)].filter(([a]) => a < 0x0104 || a >= 0x0104 + 11));
    expect(wire.size).toBeGreaterThan(0);
    expect([...wire].filter(([a, b]) => ours.get(a) !== b)).toEqual([]);
    // Read and compared against what the unit held, Busforge's writes are exactly ETS's.
    const held = heldBeforeWrite(FILE, ia);
    expect([...readCompared(build().plan, held)].sort(([a], [b]) => a - b)).toEqual([...wire].sort(([a], [b]) => a - b));
  });

  test("Busforge's partial form: ETS's steps, its writes aside", () => {
    const steps = (x: string[]) => x.filter((s) => s !== "write");
    expect(steps(planSteps(build().plan))).toEqual(steps(captureSteps(FILE, ia)));
  });

  // ETS 6 partial download on the same unit after the defaults' full download (abb-usu-4.2-ets-partial-links.log): object 1
  // linked, and two parameters (UP-341, UP-342) the unit held as 49665 set to 450. ETS reads each block and writes what
  // differs. The project is not in the corpus: the configurations before and after are Busforge's decoding of what the
  // unit held (ETS's reads over the defaults' download) and of what ETS left, the links read from ETS's tables.
  test("structural flash of the partial download: ETS's steps, and read and compared, ETS's bytes", () => {
    const LINKS = "abb-usu-4.2-ets-partial-links.log";
    const wire = memoryImage(parseCapture(captureText(LINKS), ia).writes);
    const template = new Map(cfg.absoluteSegments.flatMap((sg) => Array.from(sg.data, (b, i) => [sg.address + i, b] as [number, number])));
    const defaults = memoryImage(parseCapture(captureText("abb-usu-4.2-ets-fulldownload-defaults.log"), ia).writes);
    const held = heldBeforeWrite(LINKS, ia, new Map([...template, ...defaults]));
    const after = new Map([...held, ...wire]);
    const model = toAppModel(cfg, { includeUnions: true });
    // The value of every parameter active under the configuration, until the active set settles.
    const configOf = (mem: Map<number, number>) => {
      const decoded = new Map<string, string>();
      for (const sg of cfg.absoluteSegments) {
        if (sg.data.length === 0) continue;
        const img = Buffer.from(sg.data);
        for (let i = 0; i < sg.size; i++) { const v = mem.get(sg.address + i); if (v !== undefined) img[i] = v; }
        for (const [r, v] of decodeAbsoluteImage(model, sg.id, img)) decoded.set(r, v);
      }
      let params = new Map<string, string>();
      for (let i = 0; ; i++) {
        const active = new Set(buildDeviceConfig(cfg, params).imageValues.keys());
        const next = new Map([...decoded].filter(([r]) => active.has(r)));
        if (next.size === params.size && [...next].every(([r, v]) => params.get(r) === v)) return params;
        if (i > 16) throw new Error("the configuration read from the capture never settled");
        params = next;
      }
    };
    const params = configOf(after), baseParams = configOf(held);
    expect([...params].filter(([r, v]) => baseParams.get(r) !== v)).toEqual([["M-0002_A-A001-13-63C2_UP-341_R-559", "450"], ["M-0002_A-A001-13-63C2_UP-342_R-558", "450"]]);
    const bytes = (id: string | undefined) => {
      const sg = cfg.absoluteSegments.find((x) => x.id === id)!;
      return Buffer.from(Array.from({ length: sg.size }, (_, i) => after.get(sg.address + i) ?? 0));
    };
    const links = decodeGroupTablesMv0705(bytes(cfg.groupTables.addressSegment), bytes(cfg.groupTables.associationSegment));
    const gas = tableGas(fromMemory(after, cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.addressSegment)!.address), "system7");
    expect(gas.length).toBe(1);
    expect(links).toEqual([{ comObjNum: 1, gaRaws: gas }]);
    expect(classify(cfg).capabilities().structuralFlash).toBe(true);
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device: held, params, baseParams, links });
    const steps = (x: string[]) => x.filter((st) => st !== "write");
    expect(steps(planSteps(plan))).toEqual(steps(captureSteps(LINKS, ia)));
    const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);
    // The memory-mapped load controls at 0x0104 aside, ETS's nine bytes: the address and association table, the
    // config bytes of objects 1 and 3, the two parameters.
    const ets = new Map([...wire].filter(([a]) => a >= 0x4000));
    expect(span(ets)).toEqual(["4003-4004", "4202-4202", "4407-4407", "440f-440f", "6d0a-6d0d"]);
    expect(sorted(readCompared(plan, held))).toEqual(sorted(ets));
  });
});

// ETS 6 downloads of the Gira Tastsensor 3 Komfort (M-0008, MV-0705, DynamicTableManagement): a full
// download, a partial download after one parameter change (status LED on-time 3 s -> 4 s), one after
// linking object 4 to a test group address, and the partial download that reverted
// both (ETS's stamps no longer matched, so it rewrote every table and the whole application image).
// The project is not in the corpus. The configuration is read from what ETS wrote in the revert: the
// links from its tables, the parameter values decoded by Busforge from its application image, so the
// parameter bytes below check Busforge's encoding against its own decoding of ETS's bytes, while the
// tables, the com-object table, the plan and its wire sequence are checked against ETS directly.
// The bytes of ETS's image of the Gira's full download, as the revert writes it (822 bytes).
const GIRA_IMAGE = ["4000-4000", "4003-4023", "41e5-4353", "435c-44af", "44b5-44b8", "44bb-44bb",
  ...[0x44bd, 0x44cd, 0x44dd, 0x44ed, 0x44fd, 0x450d, 0x451d, 0x452d, 0x453d].flatMap((a) => [[a, a + 2], [a + 8, a + 11], [a + 14, a + 14]].map(([x, y]) => `${x.toString(16)}-${y.toString(16)}`)),
  "454d-4550"];
corpusDescribe("Gira Tastsensor 3 Komfort (M-0008) against ETS", () => {
  const xml = catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const ia = deviceOf("gira-m0008-ets-partial-revert.log"), IA = numToIa(ia);
  const revert = memoryImage(parseCapture(captureText("gira-m0008-ets-partial-revert.log"), ia).writes);

  // The configuration ETS downloaded in the revert (the project's), read from its bytes.
  const baseline = (() => {
    const at = (a: number) => revert.get(a)!;
    const count = at(0x4000);
    // ETS leaves the address table's own individual address (bytes 1-2) to the device.
    const addr = Buffer.from(Array.from({ length: 1 + 2 * count }, (_, i) => (i === 1 ? ia >> 8 : i === 2 ? ia & 0xff : at(0x4000 + i))));
    const assocAt = 0x4000 + addr.length;
    const assoc = Buffer.from(Array.from({ length: 1 + 2 * at(assocAt) }, (_, i) => at(assocAt + i)));
    const model = toAppModel(cfg, { includeUnions: true });
    const decoded = new Map<string, string>();
    for (const seg of cfg.absoluteSegments) {
      if (seg.data.length === 0) continue;
      const img = Buffer.from(seg.data);
      for (let i = 0; i < seg.size; i++) { const v = revert.get(seg.address + i); if (v !== undefined) img[i] = v; }
      for (const [r, v] of decodeAbsoluteImage(model, seg.id, img)) decoded.set(r, v);
    }
    // The function of each rocker has no memory location, so no image shows it; the project
    // sets both to "Dimmen" (2), whose objects 18 and 20 ETS links to the dimming addresses. On top of
    // them, the device's configuration as Busforge's read-back finds it (profiles.ts
    // deviceRelevantRefs): the decoded value of every parameter active under it, until the active set
    // settles.
    const project = new Map([["M-0008_A-10D7-11-2783-O000A_P-224_R-224", "2"], ["M-0008_A-10D7-11-2783-O000A_P-2194_R-2194", "2"]]);
    let params = new Map(project);
    for (let i = 0; ; i++) {
      const active = new Set(buildDeviceConfig(cfg, params).imageValues.keys());
      const next = new Map([...project, ...[...decoded].filter(([r]) => active.has(r))]);
      if (next.size === params.size && [...next].every(([r, v]) => params.get(r) === v)) break;
      if (i > 16) throw new Error("the configuration read from the revert never settled");
      params = next;
    }
    return { links: decodeGroupTablesMv0705(addr, assoc), params, addr, assoc };
  })();
  const full = (params: Map<string, string>, links: { comObjNum: number; gaRaws: number[] }[]) =>
    classify(cfg).planFullDownload(cfg.mask, { ia: IA, params, links, proc, unitHoldsApplication: true });

  const etsSteps = (file: string) => captureSteps(file, ia);

  test("the configuration read from the revert: five linked objects, every parameter segment decoded", () => {
    expect(baseline.links.map((l) => l.comObjNum)).toEqual([0, 2, 18, 20, 64]);
    expect(baseline.params.size).toBeGreaterThan(0);
  });

  test("full download: the wire sequence is ETS's, verify mode aside", () => {
    const build = full(baseline.params, baseline.links);
    expect(planSteps(build.plan)).toEqual(withoutVerifyMode(etsSteps("gira-m0008-ets-fulldownload.log")));
    expect(planSteps(build.plan)).toEqual([
      "unload:1", "unload:2",
      "load:1", "absSegment:1@16384+17", "write", "taskSegment:1@16384=00000810d711", "loadCompleted:1",
      "load:2", "absSegment:2@16401+467", "write", "taskSegment:2@16401=00000810d711", "loadCompleted:2",
      "load:3", "write", "loadCompleted:3", ...STAMPS, "restart",
    ]);
  });

  test("full download: every byte ETS wrote matches; ETS leaves out what its stamps say the device holds, Busforge writes its whole image", () => {
    const build = full(baseline.params, baseline.links);
    const cap = parseCapture(captureText("gira-m0008-ets-fulldownload.log"), ia);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.flatMap((s) => s.divergences)).toEqual([]);
    expect(r.segments.flatMap((s) => s.etsOnly)).toEqual([]);
    expect(r.unattributed).toEqual([]);
    // ETS's differential download: of its image it writes the tables and the download marker AS-454E
    // (SegFlags 0, so no stamp tells ETS the device holds it), 37 bytes, and logs the 785 it leaves out.
    // Busforge keeps no stamps and writes the whole image: 822 bytes, exactly those two together.
    for (const f of ["gira-m0008-ets6log-fulldownload.txt", "gira-m0008-ets6log-fulldownload-restore.txt"]) {
      const log = etsLog(f);
      expect([f, log.image.size, log.removed]).toEqual([f, 37, 785]);
      expect(bytesOf(build.plan).size).toBe(log.image.size + log.removed);
      expect([...log.image].filter(([a, b]) => bytesOf(build.plan).get(a) !== b)).toEqual([]);
    }
    expect(memoryImage(cap.writes).size).toBe(37);
    expect(span(bytesOf(build.plan))).toEqual(GIRA_IMAGE);
    expect(span(build.segments.flatMap((s) => Array.from(s.image, (_, i) => s.address! + i)))).toEqual(GIRA_IMAGE);
    expect(build.segments.find((s) => s.source === "assocTable")!.address).toBe(0x4011);
  });

  // Which bytes ETS's image holds (docs/load-procedures.md, "Which bytes ETS writes"): the tables as long
  // as they are built, the address table's own individual address left out (outside AS-4000's Mask);
  // the application stays loaded (ETS's log turns its LdCtrlAbsSegment into LdCtrlWriteMem), so of its
  // data segments only the bytes a parameter covers, though their Masks mark every byte.
  test("Busforge writes no byte ETS's image leaves out: not the 80 of AS-444E no parameter covers, not the com-object table's last 8", () => {
    const ours = bytesOf(full(baseline.params, baseline.links).plan);
    const seg = (id: string) => cfg.absoluteSegments.find((s) => s.id === `M-0008_A-10D7-11-2783-O000A_${id}`)!;
    const p444e = parameterMemoryBytes(cfg, seg("AS-444E").id, 256)!;
    expect(seg("AS-444E").mask!.every((b) => b === 0xff)).toBe(true);
    expect(p444e.filter((c) => !c).length).toBe(80);
    expect(p444e.flatMap((c, i) => (ours.has(0x444e + i) === c ? [] : [i]))).toEqual([]);
    for (const id of ["AS-435C", "AS-4369", "AS-436F", "AS-4439", "AS-454E"]) expect(parameterMemoryBytes(cfg, seg(id).id, seg(id).size)!.every(Boolean)).toBe(true);
    // The com-object table counts 91 objects (0..90, every one the application declares): 3 + 91 * 4 bytes
    // of its 375-byte segment.
    expect(seg("AS-41E5").data[0]).toBe(91);
    expect(span([...ours.keys()].filter((a) => a >= 0x41e5 && a < 0x41e5 + 375))).toEqual(["41e5-4353"]);
    expect([0x4001, 0x4002].filter((a) => ours.has(a))).toEqual([]);
  });

  test("ETS's images: the revert's whole image is Busforge's, the parameter download's before its differential cut is Busforge's parameter bytes", () => {
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: baseline.params, links: baseline.links, proc, comObjectOverrides: object64Read, unitHoldsApplication: true });
    const ours = bytesOf(build.plan);
    const revertLog = etsLog("gira-m0008-ets6log-partial-revert.txt");
    expect(revertLog.removed).toBe(0);
    expect([...ours].sort(([a], [b]) => a - b)).toEqual([...revertLog.image].sort(([a], [b]) => a - b));
    expect([...ours].sort(([a], [b]) => a - b)).toEqual([...revert].sort(([a], [b]) => a - b));
    // The parameter download's image is the application's data segments (no table): 7 bytes written,
    // 414 left out as held, 421 together, the bytes Busforge's full download writes there.
    const params = etsLog("gira-m0008-ets6log-partial-params.txt");
    expect([params.image.size, params.removed]).toEqual([7, 414]);
    expect([...ours.keys()].filter((a) => a >= 0x435c).length).toBe(params.image.size + params.removed);
    expect([...params.image.keys()].filter((a) => a < 0x435c || !ours.has(a))).toEqual([]);
    // ETS's log of every download of this application: it never unloads or declares LSM 3's segments,
    // it writes them into the loaded application.
    for (const f of ["fulldownload", "fulldownload-restore", "partial-params", "partial-links", "partial-revert"]) {
      const steps = etsLog(`gira-m0008-ets6log-${f}.txt`).steps;
      const lsm3 = steps.filter((x) => x.attrs.LsmIdx === "3").map((x) => x.verb);
      expect([f, lsm3.filter((v) => v === "LdCtrlUnload" || v === "LdCtrlAbsSegment")]).toEqual([f, []]);
      expect([f, lsm3.includes("LdCtrlLoad"), steps.filter((x) => x.verb === "LdCtrlWriteMem").map((x) => Number(x.attrs.Address))])
        .toEqual([f, true, [16869, 17244, 17257, 17263, 17465, 17486, 17742]]);
    }
  });

  // Object 64's config byte is 0x4f in ETS's image, where the application's ComObjectRef R-1249
  // declares the read flag off (0x47): the project sets it on this device (ComObjectInstanceRef
  // ReadFlag="Enabled"). The project is not in the corpus, so the override is given here as the import
  // stores it; with it every byte matches, without it exactly that byte does not.
  const object64Read = new Map([[64, comObjInstanceOverride({ ReadFlag: "Enabled" })]]);
  test("the whole application image matches what ETS rewrote in the revert, object 64's project read flag included", () => {
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: baseline.params, links: baseline.links, proc, comObjectOverrides: object64Read, unitHoldsApplication: true });
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), revert, new Map(), []);
    expect(r.segments.flatMap((s) => s.divergences)).toEqual([]);
    expect(r.segments.find((s) => s.id.endsWith("AS-41E5"))!.compared).toBeGreaterThan(3 + 64 * 4 + 2);
    expect(r.unattributed).toEqual([]);
    expect(planSteps(build.plan)).toEqual(withoutVerifyMode(etsSteps("gira-m0008-ets-partial-revert.log")));
    const without = full(baseline.params, baseline.links);
    const w = compareSegments(without.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), revert, new Map(), []);
    expect(w.segments.flatMap((s) => s.divergences.map((d) => [s.id.split("_").pop(), d.offset, d.busforge, d.ets]))).toEqual([["AS-41E5", 3 + 64 * 4 + 2, 0x47, 0x4f]]);
  });

  // Without a record of its last download (the image stamps it read after it) ETS writes its whole parameter
  // image, the 421 bytes its log lists before its differential cut; so does Busforge. With the record ETS wrote
  // 7 of them, the ones it held changed.
  test("parameter flash without a record: ETS's bracket, ETS's whole parameter image, the bytes ETS wrote with their values", () => {
    const ref = [...baseline.params.keys()].find((k) => k.includes("_P-3764_"))!;
    expect(baseline.params.get(ref)).toBe("30");
    const after = new Map(baseline.params).set(ref, "40");
    const current = new Map(buildAbsoluteSegmentTargets(cfg, baseline.params).map((t) => [t.id, t.bytes]));
    const { plan, changedBytes } = planAbsoluteParFlash(cfg, after, proc, current);
    expect(changedBytes).toBe(1);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(etsSteps("gira-m0008-ets-partial-params.log")));
    const ets = memoryImage(parseCapture(captureText("gira-m0008-ets-partial-params.log"), ia).writes);
    const ours = bytesOf(plan);
    expect([...ours].filter(([a, b]) => ets.get(a) !== undefined && ets.get(a) !== b)).toEqual([]);
    expect([...ets.keys()].filter((a) => !ours.has(a))).toEqual([]);
    const fullBuild = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: after, links: baseline.links, proc, comObjectOverrides: object64Read, unitHoldsApplication: true });
    const image = [...bytesOf(fullBuild.plan)].filter(([a]) => a >= 0x435c);
    expect(image.length).toBe(421);
    expect([...ours].sort(([a], [b]) => a - b)).toEqual(image.sort(([a], [b]) => a - b));
  });

  // The group-address flash keeps the com-object table the device holds and changes only the link
  // bits (System7Profile.flashGroupTables). What the device holds there: the segment's template under
  // the bytes ETS wrote in a download (its last 8 bytes, which no ETS image holds, from the template).
  const comObjSeg = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
  const heldComObj = (written: Map<number, number>) => Buffer.from(comObjSeg.data.map((b, i) => written.get(comObjSeg.address + i) ?? b));
  const gaFlash = (links: { comObjNum: number; gaRaws: number[] }[], held: Buffer) => planSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia),
    { address: comObjSeg.address, bytes: withLinkedCommFlags(held, new Set(links.map((l) => l.comObjNum))) });
  // The test group address the links download added: the one address of its table no baseline link uses.
  const TEST_GA = addedGa(tableGas(fromMemory(memoryImage(parseCapture(captureText("gira-m0008-ets-partial-links.log"), ia).writes), 0x4000), "system7"), baseline.links);
  const withTestLink = [...baseline.links, { comObjNum: 4, gaRaws: [TEST_GA] }].sort((a, b) => a.comObjNum - b.comObjNum);
  const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);

  test("group-address flash: tables re-declared where ETS puts them, exactly the bytes of ETS's image, the com-object table with the new link bit", () => {
    const { plan, assocAt, comObjWrites } = gaFlash(withTestLink, heldComObj(revert));
    expect(assocAt).toBe(0x4013);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(etsSteps("gira-m0008-ets-partial-links.log")));
    const ets = memoryImage(parseCapture(captureText("gira-m0008-ets-partial-links.log"), ia).writes);
    const log = etsLog("gira-m0008-ets6log-partial-links.txt");
    const ours = bytesOf(plan);
    // ETS's image of this download is 405 bytes, none removed as held: the address table without its own
    // individual address (17), the association table with ten entries (21), the com-object table to its
    // 91 entries (367). Busforge writes exactly those bytes, with ETS's values, and nothing else: not
    // $4001-$4002, not the com-object segment's 8 bytes behind the table.
    expect([log.image.size, log.removed]).toEqual([405, 0]);
    expect(sorted(ours)).toEqual(sorted(log.image));
    expect(sorted(ours)).toEqual(sorted(ets));
    expect(span([...ours.keys()])).toEqual(["4000-4000", "4003-4027", "41e5-4353"]);
    expect(span(comObjWrites.flatMap((w) => Array.from(w.image, (_, i) => w.address + i)))).toEqual(["41e5-4353"]);
  });

  // The revert removes the link again. ETS's revert rewrote the application's data segments too (its
  // stamps no longer matched); of its writes the group-address flash's share is the tables and the
  // com-object table, which Busforge writes byte for byte, starting from the device ETS's group-address
  // download left. The association table ends at $4023 again, so ETS's group-address download's last 4
  // bytes ($4024-$4027) stay behind it (docs/load-procedures.md, "Tables shrink, their old bytes stay").
  test("group-address flash of the revert: the tables and the com-object table ETS's revert writes, byte for byte, nothing behind them", () => {
    const linksWritten = memoryImage(parseCapture(captureText("gira-m0008-ets-partial-links.log"), ia).writes);
    const { plan, assocAt } = gaFlash(baseline.links, heldComObj(linksWritten));
    expect(assocAt).toBe(0x4011);
    const ours = bytesOf(plan);
    const tablesOf = (m: Map<number, number>) => new Map([...m].filter(([a]) => a < 0x435c));
    expect(sorted(ours)).toEqual(sorted(tablesOf(revert)));
    expect(sorted(ours)).toEqual(sorted(tablesOf(etsLog("gira-m0008-ets6log-partial-revert.txt").image)));
    expect(span([...ours.keys()])).toEqual(["4000-4000", "4003-4023", "41e5-4353"]);
    expect([0x4024, 0x4025, 0x4026, 0x4027].map((a) => linksWritten.get(a))).toEqual([0x06, 0x02, 0x07, 0x02]);
  });

  test("structural flash of the revert: ETS's bracket set, and every byte ETS changed with ETS's value", () => {
    const ref = [...baseline.params.keys()].find((k) => k.includes("_P-3764_"))!;
    const device = unitMemory(cfg, ia, revert, memoryImage(parseCapture(captureText("gira-m0008-ets-partial-params.log"), ia).writes), memoryImage(parseCapture(captureText("gira-m0008-ets-partial-links.log"), ia).writes));
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: baseline.params, baseParams: new Map(baseline.params).set(ref, "40"), links: baseline.links, overrides: object64Read });
    expectRevertForm(plan, "gira-m0008-ets-partial-revert.log", ia, device);
  });

  // Two partial downloads: "Sperrfunktion?" (P-3848, no memory location) switched from "Nein" (0, the
  // catalogue default and the project's) to "Ja" (1), which shows object 54 ("Tasten sperren", unlinked)
  // and the lock function's parameters at their defaults, and back. ETS runs both as the revert's bracket
  // set. Its image changes two bytes: object 54's config byte in the com-object table, and AS-4439
  // offset 0, the lock function's union. ETS's partial downloads send part of the image: "on" the tables'
  // headers, the whole com-object table, AS-4439 and the marker, "off" the same but of the com-object
  // table only object 54's byte; Busforge keeps no stamps and writes the whole 822 bytes.
  const SPERRE_ON = "gira-m0008-ets-partial-sperre-on.log", SPERRE_OFF = "gira-m0008-ets-partial-sperre-off.log";
  const SPERRE = "M-0008_A-10D7-11-2783-O000A_P-3848_R-3848";
  const sperreOn = new Map(baseline.params).set(SPERRE, "1");
  const object54 = comObjSeg.address + 3 + 54 * 4 + 2;
  // The unit's PID 27 stamps in an ETS log: those read before the download, those read after it.
  const stampsOf = (file: string) => {
    const lines = captureText(file).split(/\r?\n/), at = lines.findIndex((l) => l.includes(" - Execute image:"));
    expect(at).toBeGreaterThan(-1);
    const read = (ls: string[]) => ls.flatMap((l) => {
      const m = l.match(/Received PropertyValue_Response_ind .* ObjectIndex=(\d+) PID=27 NumberOfElements=1 StartIndex=(\d+) Data=([0-9A-F]+)/);
      return m ? [`${m[1]}#${m[2]}=${m[3]}`] : [];
    });
    return { before: read(lines.slice(0, at)), after: read(lines.slice(at)) };
  };

  test("Sperrfunktion on and off: object 54 added and removed, so the change takes the structural flash", () => {
    // No memory location, so the configuration read from the revert does not hold it: the default, "Nein".
    expect(baseline.params.has(SPERRE)).toBe(false);
    expect(comObjectTableChanges(cfg, baseline.params, sperreOn).map((c) => [c.number, c.fields])).toEqual([[54, ["added"]]]);
    expect(comObjectTableChanges(cfg, sperreOn, baseline.params).map((c) => [c.number, c.fields])).toEqual([[54, ["removed"]]]);
    expect(classify(cfg).capabilities().structuralFlash).toBe(true);
  });

  test("ETS's logs of the Sperrfunktion on and off: the revert's bracket set, the image of the wire, two bytes apart, the unit as the revert left it", () => {
    const on = etsLog("gira-m0008-ets6log-partial-sperre-on.txt"), off = etsLog("gira-m0008-ets6log-partial-sperre-off.txt");
    const revertLog = etsLog("gira-m0008-ets6log-partial-revert.txt");
    for (const [l, capture] of [[on, SPERRE_ON], [off, SPERRE_OFF]] as const) {
      expect(l.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual(revertLog.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`));
      expect(captureSteps(capture, ia)).toEqual(captureSteps("gira-m0008-ets-partial-revert.log", ia));
      expect([...l.image]).toEqual(sorted(memoryImage(parseCapture(captureText(capture), ia).writes)));
      // The whole image before the differential cut is the revert's 822 bytes.
      expect(l.image.size + l.removed).toBe(revertLog.image.size);
    }
    // "On": the tables, the whole com-object table, AS-4439 offset 0 and the download marker; "off": the
    // tables, object 54's config byte, AS-4439 offset 0 and the marker.
    expect(span(on.image)).toEqual(["4000-4000", "4003-4023", "41e5-4353", "4439-4439", "454e-4550"]);
    expect(span(off.image)).toEqual(["4000-4000", "4003-4023", `${object54.toString(16)}-${object54.toString(16)}`, "4439-4439", "454e-4550"]);
    // Against the revert's image, "on" differs in object 54's config byte (0xdb, the template's 0xdf without
    // the communication flag, as for every object the configuration does not show, to 0x13, its own
    // unlinked) and the lock function's union (0x00 to 0x03); "off" in no byte.
    expect([...on.image].filter(([a, b]) => revertLog.image.get(a) !== b)).toEqual([[object54, 0x13], [0x4439, 0x03]]);
    expect([object54, 0x4439].map((a) => revertLog.image.get(a))).toEqual([0xdb, 0x00]);
    expect(comObjSeg.data[object54 - comObjSeg.address]).toBe(0xdf);
    expect([...off.image].filter(([a, b]) => revertLog.image.get(a) !== b)).toEqual([]);
    // The unit's stamps before "on" are those it showed after ETS's revert, so it held the revert's image;
    // "on" changes the com-object table's (3#1) and AS-4439's (3#5), "off" restores them.
    const r = stampsOf("gira-m0008-ets6log-partial-revert.txt"), sOn = stampsOf("gira-m0008-ets6log-partial-sperre-on.txt"), sOff = stampsOf("gira-m0008-ets6log-partial-sperre-off.txt");
    expect(sOn.before).toEqual(r.after.filter((x) => x.startsWith("3#")));
    expect(sOn.after).toHaveLength(r.after.length);
    expect(sOn.after.filter((x, i) => x !== r.after[i]).map((x) => x.split("=")[0])).toEqual(["3#1", "3#5"]);
    expect(sOff.before).toEqual(sOn.after.filter((x) => x.startsWith("3#")));
    expect(sOff.after).toEqual(r.after);
  });

  // The unit before "on": the revert's whole image (ETS wrote it without a differential cut), as its stamps show.
  const beforeSperre = () => unitMemory(cfg, ia, revert);
  // Busforge's structural flash against an ETS partial download that cut what the unit held: ETS's steps
  // (verify mode aside), the whole image (ETS's before its cut), every byte of ETS's image with ETS's value,
  // and every other byte the unit's own, so on the unit exactly ETS's changes.
  const expectSperreForm = (plan: LoadPlan, capture: string, log: string, device: Map<number, number>) => {
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(capture, ia)));
    const ours = bytesOf(plan), ets = memoryImage(parseCapture(captureText(capture), ia).writes), l = etsLog(log);
    expect(span(ours)).toEqual(GIRA_IMAGE);
    expect(ours.size).toBe(l.image.size + l.removed);
    expect([...ets].filter(([a, b]) => ours.get(a) !== b)).toEqual([]);
    expect([...ours].filter(([a, b]) => !ets.has(a) && device.get(a) !== b)).toEqual([]);
    return sorted(ours).filter(([a, b]) => device.get(a) !== b);
  };

  test("structural flash of the Sperrfunktion on: ETS's steps, ETS's whole image, every byte ETS writes with ETS's value", () => {
    const device = beforeSperre();
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: sperreOn, baseParams: baseline.params, links: baseline.links, overrides: object64Read });
    expect(expectSperreForm(plan, SPERRE_ON, "gira-m0008-ets6log-partial-sperre-on.txt", device)).toEqual([[object54, 0x13], [0x4439, 0x03]]);
  });

  test("structural flash of the Sperrfunktion off: ETS's steps, ETS's whole image, every byte ETS writes with ETS's value", () => {
    const device = unitMemory(cfg, ia, revert, memoryImage(parseCapture(captureText(SPERRE_ON), ia).writes));
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: baseline.params, baseParams: sperreOn, links: baseline.links, overrides: object64Read });
    expect(expectSperreForm(plan, SPERRE_OFF, "gira-m0008-ets6log-partial-sperre-off.txt", device)).toEqual([[object54, 0xdb], [0x4439, 0x00]]);
  });
});

// ETS 6 downloads of the Auro presence detector (M-0081_A-FE01-11-75D9, MV-0705, LdCtrlTaskCtrl1),
// in this order: a full download; a partial download after one parameter change ("led feedback" to
// "no led feedback", AS-4200 offset 7, 01 -> 00); one after adding a test group address as a second
// address on object 10; and one that reverted both (parameters and links in one). ETS runs this application's
// declared steps in their declared order (its ProductProcedure, no PreferPartialDownloadIfApplicationLoaded). The project
// is not in the corpus. The configuration is read from what ETS wrote in the full download: the links
// from its tables, the parameter values decoded by Busforge from the 50 parameter bytes it wrote.
corpusDescribe("Auro presence detector (M-0081_A-FE01-11-75D9) against ETS", () => {
  const xml = catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const FULL = "auro-m0081-ets-fulldownload.log", PARTIAL = "auro-m0081-ets-partial-params.log";
  const ia = deviceOf(FULL), IA = numToIa(ia);
  const LINKS = "auro-m0081-ets-partial-links.log", REVERT = "auro-m0081-ets-partial-revert.log";
  const written = memoryImage(parseCapture(captureText(FULL), ia).writes);
  const paramSeg = cfg.absoluteSegments.find((s) => s.address === 0x4200)!;
  // What the device holds in the parameter segment after ETS's full download: the template, under
  // the bytes ETS wrote.
  const held = Buffer.from(paramSeg.data.map((b, i) => written.get(paramSeg.address + i) ?? b));

  const baseline = (() => {
    const at = (a: number) => written.get(a)!;
    // ETS leaves the address table's own individual address (bytes 1-2, outside the segment's Mask)
    // to the device.
    const addr = Buffer.from(Array.from({ length: 1 + 2 * at(0x4000) }, (_, i) => (i === 1 ? ia >> 8 : i === 2 ? ia & 0xff : at(0x4000 + i))));
    const assoc = Buffer.from(Array.from({ length: 1 + 2 * at(0x402f) }, (_, i) => at(0x402f + i)));
    const decoded = new Map(decodeAbsoluteImage(toAppModel(cfg, { includeUnions: true }), paramSeg.id, held));
    let params = new Map<string, string>();
    for (let i = 0; ; i++) {
      const active = new Set(buildDeviceConfig(cfg, params).imageValues.keys());
      const next = new Map([...decoded].filter(([r]) => active.has(r)));
      if (next.size === params.size && [...next].every(([r, v]) => params.get(r) === v)) break;
      if (i > 16) throw new Error("the configuration read from the full download never settled");
      params = next;
    }
    return { links: decodeGroupTablesMv0705(addr, assoc), params };
  })();
  const full = () => classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: baseline.params, links: baseline.links, proc });
  const LED = "M-0081_A-FE01-11-75D9_P-10";

  // The group addresses of the address table a download wrote, ascending.
  const tableOf = (img: Map<number, number>) => tableGas(fromMemory(img, 0x4000), "system7");

  test("the configuration read from the full download: two linked objects, every parameter decoded", () => {
    const gas = tableOf(written);
    expect(gas.length).toBe(2);
    expect(baseline.links).toEqual([{ comObjNum: 9, gaRaws: [gas[1]] }, { comObjNum: 10, gaRaws: [gas[0]] }]);
    const led = [...baseline.params.keys()].find((k) => k.startsWith(`${LED}_`))!;
    expect(baseline.params.get(led)).toBe("1");
  });

  test("full download: the declared steps in their declared order, as ETS sends them, verify mode aside", () => {
    const build = full();
    expect(planSteps(build.plan)).toEqual(withoutVerifyMode(captureSteps(FULL, ia)));
    const task = "taskSegment:%@%=000081fe0111";
    const t = (l: number, a: number) => task.replace("%", String(l)).replace("%", String(a));
    expect(planSteps(build.plan)).toEqual([
      "unload:1", "unload:2", "unload:3",
      "load:1", "absSegment:1@16384+47", "write", t(1, 16384), "loadCompleted:1",
      "load:2", "absSegment:2@16431+45", "write", t(2, 16431), "loadCompleted:2",
      "load:3", "absSegment:3@1792+250", "absSegment:3@16476+91", "write", "absSegment:3@16896+256", "write",
      t(3, 16567), "taskCtrl1:3=0000000000000000", "loadCompleted:3", "restart",
    ]);
    // Every declaration is the load-state machine's PID 5 write, as in the capture.
    expect(build.plan.filter((s) => (s.op === "absSegment" || s.op === "taskSegment") && s.viaProperty !== true)).toEqual([]);
  });

  test("full download: Busforge writes exactly the bytes ETS writes, with ETS's values", () => {
    const build = full();
    const cap = parseCapture(captureText(FULL), ia);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.flatMap((s) => s.divergences)).toEqual([]);
    expect(r.segments.flatMap((s) => s.busforgeOnly)).toEqual([]);
    expect(r.segments.flatMap((s) => s.etsOnly)).toEqual([]);
    expect(r.unattributed).toEqual([]);
    expect(span(bytesOf(build.plan))).toEqual(["4000-4000", "4003-4006", "402f-4033", "405c-40b6", "4200-4231"]);
    expect(span(build.segments.flatMap((s) => Array.from(s.image, (_, i) => s.address! + i)))).toEqual(span(bytesOf(build.plan)));
    // AS-4200 offset 49 holds a parameter outside the segment's Mask and is written; offsets 3 and 36
    // belong to no parameter and are written because the Mask marks them.
    expect([0x4203, 0x4224, 0x4231].map((a) => [written.get(a), bytesOf(build.plan).get(a)])).toEqual([[1, 1], [3, 3], [0x0a, 0x0a]]);
  });

  test("ETS's log: it executes the declared full steps in their declared order, with the image Busforge writes", () => {
    const log = etsLog("auro-m0081-ets6log-fulldownload.txt");
    const declared = flattenSteps(proc, "full");
    expect(log.steps.map((s) => s.verb)).toEqual(declared.map((s) => s.verb));
    // ETS adds the application id and PEI type to each LdCtrlTaskSegment; every declared attribute is as declared.
    expect(declared.flatMap((d, i) => Object.entries(d.attrs).filter(([k, v]) => log.steps[i].attrs[k] !== v))).toEqual([]);
    expect([...log.image].sort(([a], [b]) => a - b)).toEqual([...bytesOf(full().plan)].sort(([a], [b]) => a - b));
  });

  test("ETS's log of the partial download: every parameter-owned byte, the two no parameter owns left out, nothing of the com-object table", () => {
    const log = etsLog("auro-m0081-ets6log-partial-params.txt");
    expect(log.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual(["LdCtrlConnect", "LdCtrlLoad3", "LdCtrlWriteMem16476", "LdCtrlWriteMem16896", "LdCtrlLoadCompleted3", "LdCtrlRestart", "LdCtrlDisconnect"]);
    expect(span([...log.image.keys()])).toEqual(["4200-4202", "4204-4223", "4225-4231"]);
    expect([...log.image]).toEqual([...memoryImage(parseCapture(captureText(PARTIAL), ia).writes)].sort(([a], [b]) => a - b));
  });

  // ETS writes every byte a parameter's memory covers, AS-4200 offsets 0-49 but 3 and 36, changed or not
  // (parWriteSet); so does Busforge.
  test("parameter flash: ETS's bracket, and exactly the bytes ETS writes, every parameter-covered byte with its value", () => {
    const led = [...baseline.params.keys()].find((k) => k.startsWith(`${LED}_`))!;
    const after = new Map(baseline.params).set(led, "0");
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, after, proc, new Map([[paramSeg.id, held]]));
    expect([changedBytes, unplaceable]).toEqual([1, []]);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(PARTIAL, ia)));
    expect(planSteps(plan)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    const ets = memoryImage(parseCapture(captureText(PARTIAL), ia).writes);
    expect([...bytesOf(plan)].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
    expect(ets.get(0x4207)).toBe(0x00);
  });

  // The com-object table the device holds after ETS's full download, with the link bits of `links`, as
  // the group-address flash builds it from a read of the device (System7Profile.flashGroupTables).
  const comObjSeg = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
  const heldComObj = Buffer.from(comObjSeg.data.map((b, i) => written.get(comObjSeg.address + i) ?? b));
  const gaFlash = (links: { comObjNum: number; gaRaws: number[] }[], deviceComObj: Buffer = heldComObj) =>
    planSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia), { address: comObjSeg.address, bytes: withLinkedCommFlags(deviceComObj, new Set(links.map((l) => l.comObjNum))) });
  // The test group address the links download added: the one address of its table no baseline link uses.
  const TEST_GA = addedGa(tableOf(memoryImage(parseCapture(captureText(LINKS), ia).writes)), baseline.links);
  const second = baseline.links.map((l) => (l.comObjNum === 10 ? { ...l, gaRaws: [...l.gaRaws, TEST_GA] } : l));
  const TABLE_BRACKETS = (t: string) => [
    "unload:1", "unload:2",
    "load:1", "absSegment:1@16384+47", "write", t.replace("%", "1@16384"), "loadCompleted:1",
    "load:2", "absSegment:2@16431+45", "write", t.replace("%", "2@16431"), "loadCompleted:2",
    "load:3", "write", "loadCompleted:3", "restart",
  ];

  test("group-address flash: ETS's partial download, the tables in their declared brackets, the com-object table to its counted entries", () => {
    expect(tableOf(memoryImage(parseCapture(captureText(LINKS), ia).writes))).toEqual([...tableOf(written), TEST_GA].sort((a, b) => a - b));
    const { plan, writes, comObjWrites } = gaFlash(second);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(LINKS, ia)));
    expect(planSteps(plan)).toEqual(TABLE_BRACKETS("taskSegment:%=000081fe0111"));
    const ets = memoryImage(parseCapture(captureText(LINKS), ia).writes);
    const ours = bytesOf(plan);
    expect([...ours].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
    expect(span(ours)).toEqual(["4000-4000", "4003-4008", "402f-4035", "405c-40b6"]);
    // The associations by object, then group index: (2, 9), (1, 10), (3, 10).
    expect(Buffer.from([...ours].filter(([a]) => a >= 0x402f && a <= 0x4035).map(([, b]) => b)).toString("hex")).toBe("030209010a030a");
    // The com-object table ETS writes is the one the device held: object 10 was linked already.
    expect(withLinkedCommFlags(heldComObj, new Set(second.map((l) => l.comObjNum))).equals(heldComObj)).toBe(true);
    expect(span([...writes, ...comObjWrites].flatMap((w) => Array.from(w.image, (_, i) => w.address + i)))).toEqual(span(ours));
  });

  test("the revert: ETS's tables, com-object table and parameter bytes in one bracket are the group-address and the parameter flash's bytes", () => {
    const { plan } = gaFlash(baseline.links);
    // ETS carries the parameter bytes in the same LSM 3 bracket as the com-object table; Busforge runs
    // the group-address flash and the parameter flash, each its own bracket and restart. The sequence
    // of the group-address flash is ETS's, its writes on LSM 3 aside.
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(REVERT, ia)));
    const ets = memoryImage(parseCapture(captureText(REVERT), ia).writes);
    const ga = bytesOf(plan);
    expect([...ga].filter(([a, b]) => ets.get(a) !== b)).toEqual([]);
    // Before the revert the device held "no led feedback" (the partial-params download); the parameter
    // flash writes the one byte back, with ETS's value.
    const before = Buffer.from(held);
    before[7] = 0;
    const par = planAbsoluteParFlash(cfg, baseline.params, proc, new Map([[paramSeg.id, before]]));
    expect(ets.get(0x4207)).toBe(0x01);
    // Every byte ETS writes beyond the tables and the com-object table is a parameter byte, offsets 3 and 36
    // (no parameter) not among them: exactly the parameter flash's bytes, with their values.
    const params = [...ets].filter(([a]) => !ga.has(a));
    expect(span(params.map(([a]) => a))).toEqual(["4200-4202", "4204-4223", "4225-4231"]);
    expect([...bytesOf(par.plan)].sort(([a], [b]) => a - b)).toEqual(params.sort(([a], [b]) => a - b));
  });

  test("structural flash of the revert: ETS's bracket set, and every byte ETS changed with ETS's value", () => {
    const led = [...baseline.params.keys()].find((k) => k.startsWith(`${LED}_`))!;
    const device = unitMemory(cfg, ia, written, memoryImage(parseCapture(captureText(PARTIAL), ia).writes), memoryImage(parseCapture(captureText(LINKS), ia).writes));
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: baseline.params, baseParams: new Map(baseline.params).set(led, "0"), links: baseline.links });
    expectRevertForm(plan, REVERT, ia, device);
  });

  test("a table that shrinks leaves its old bytes behind it, in ETS's download and in Busforge's", () => {
    const links = memoryImage(parseCapture(captureText(LINKS), ia).writes);
    const revert = memoryImage(parseCapture(captureText(REVERT), ia).writes);
    const behind = [0x4007, 0x4008, 0x4034, 0x4035];
    expect(behind.map((a) => links.get(a))).toEqual([TEST_GA >> 8, TEST_GA & 0xff, 0x03, 0x0a]);
    expect(behind.filter((a) => revert.has(a))).toEqual([]);
    const ours = bytesOf(gaFlash(baseline.links).plan);
    expect(behind.filter((a) => ours.has(a))).toEqual([]);
  });

  // Object 9 ("trigger") has the transmit flag and no read flag; with object 10 it is the only object
  // this configuration activates, and both are linked, so the linked bit changes on this unit only by
  // unlinking one of them; the two captures remove object 9's only address and add it back.
  const UNLINK = "auro-m0081-ets-partial-unlink9.log", RELINK = "auro-m0081-ets-partial-relink9.log";
  const configByte = (table: Buffer | Map<number, number>, n: number) => {
    const at = 3 + n * 4 + 2;
    return Buffer.isBuffer(table) ? table[at] : table.get(comObjSeg.address + at);
  };
  const without9 = baseline.links.filter((l) => l.comObjNum !== 9);
  const comObjOf = (img: Map<number, number>) => Buffer.from(Array.from({ length: heldComObj.length }, (_, i) => img.get(comObjSeg.address + i)!));

  test("object 9 transmits only, and the full download links it: config 0x47 (linked, transmit, no read)", () => {
    const objects = buildDeviceConfig(cfg, baseline.params).imageComObjects;
    expect([...objects.keys()].sort((a, b) => a - b)).toEqual([9, 10]);
    expect(objects.get(9)!.flags).toMatchObject({ read: false, transmit: true, comm: true });
    expect([configByte(heldComObj, 9), configByte(heldComObj, 10)]).toEqual([0x47, 0x4f]);
  });

  test("group-address flash that unlinks object 9: ETS's partial download, the linked bit cleared and nothing else", () => {
    const { plan } = gaFlash(without9);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(UNLINK, ia)));
    expect(planSteps(plan)).toEqual(TABLE_BRACKETS("taskSegment:%=000081fe0111"));
    const ets = memoryImage(parseCapture(captureText(UNLINK), ia).writes);
    const ours = bytesOf(plan);
    expect([...ours].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
    expect(span(ours)).toEqual(["4000-4000", "4003-4004", "402f-4031", "405c-40b6"]);
    expect([configByte(ets, 9), configByte(ets, 10)]).toEqual([0x43, 0x4f]);
    // The com-object table differs from the one the device held in object 9's config byte only.
    const after = comObjOf(ets);
    expect([...after].flatMap((b, i) => (b !== heldComObj[i] ? [comObjSeg.address + i] : []))).toEqual([comObjSeg.address + 3 + 9 * 4 + 2]);
  });

  test("group-address flash that links object 9 again: ETS's partial download, from the com-object table ETS's unlink left, the linked bit set", () => {
    const unlinked = comObjOf(memoryImage(parseCapture(captureText(UNLINK), ia).writes));
    expect(configByte(unlinked, 9)).toBe(0x43);
    const { plan } = gaFlash(baseline.links, unlinked);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(RELINK, ia)));
    const ets = memoryImage(parseCapture(captureText(RELINK), ia).writes);
    const ours = bytesOf(plan);
    expect([...ours].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
    expect(span(ours)).toEqual(["4000-4000", "4003-4006", "402f-4033", "405c-40b6"]);
    expect([configByte(ets, 9), configByte(ets, 10)]).toEqual([0x47, 0x4f]);
    // ETS's relink writes the same tables and com-object table as its full download.
    expect([...ets].filter(([a, b]) => written.get(a) !== b)).toEqual([]);
  });

  test("ETS's logs of its group-address downloads (address added, revert, object 9 unlinked and linked again): the table brackets, LSM 3 without unload or TaskCtrl1, the image it wrote", () => {
    for (const [log, capture] of [
      ["auro-m0081-ets6log-partial-links.txt", LINKS], ["auro-m0081-ets6log-partial-revert.txt", REVERT],
      ["auro-m0081-ets6log-partial-unlink9.txt", UNLINK], ["auro-m0081-ets6log-partial-relink9.txt", RELINK],
    ] as const) {
      const l = etsLog(log);
      expect(l.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual([
        "LdCtrlConnect", "LdCtrlUnload1", "LdCtrlUnload2",
        "LdCtrlLoad1", "LdCtrlAbsSegment1", "LdCtrlTaskSegment1", "LdCtrlLoadCompleted1",
        "LdCtrlLoad2", "LdCtrlAbsSegment2", "LdCtrlTaskSegment2", "LdCtrlLoadCompleted2",
        "LdCtrlLoad3", "LdCtrlWriteMem16476", "LdCtrlWriteMem16896", "LdCtrlLoadCompleted3", "LdCtrlRestart", "LdCtrlDisconnect",
      ]);
      expect([...l.image]).toEqual([...memoryImage(parseCapture(captureText(capture), ia).writes)].sort(([a], [b]) => a - b));
    }
  });

  // Two partial downloads after the relink of object 9: "heat alarm" (P-42, AS-4200 offset 41) switched from
  // "disable" to "enable", which activates object 21 ("heat alarm", transmit, unlinked) and the alarm's two
  // parameters at their defaults, and back. Object 21 is in the com-object table at its manufacturer config
  // either way (unlinked, 0x43), so the table bytes do not change; the parameter byte at offset 41 is the one
  // byte of ETS's image that differs. ETS runs both as the revert's one bracket set.
  const HEAT_ON = "auro-m0081-ets-partial-heatalarm-on.log", HEAT_OFF = "auro-m0081-ets-partial-heatalarm-off.log";
  const heatAlarm = [...baseline.params.keys()].find((k) => k.startsWith("M-0081_A-FE01-11-75D9_P-42_"))!;
  const heatOn = new Map(baseline.params).set(heatAlarm, "1");
  // What the unit held before the heat alarm went on: every earlier download in order, the relink last.
  const beforeHeat = () => unitMemory(cfg, ia, written, ...[PARTIAL, LINKS, REVERT, UNLINK, RELINK].map((f) => memoryImage(parseCapture(captureText(f), ia).writes)));

  test("heat alarm on and off: object 21 added and removed, so the change takes the structural flash", () => {
    expect(baseline.params.get(heatAlarm)).toBe("0");
    expect(comObjectTableChanges(cfg, baseline.params, heatOn).map((c) => [c.number, c.fields])).toEqual([[21, ["added"]]]);
    expect(comObjectTableChanges(cfg, heatOn, baseline.params).map((c) => [c.number, c.fields])).toEqual([[21, ["removed"]]]);
    expect(classify(cfg).capabilities().structuralFlash).toBe(true);
  });

  test("ETS's logs of the heat alarm on and off: the revert's bracket set, the image of the wire, offset 41 the one byte apart", () => {
    const on = etsLog("auro-m0081-ets6log-partial-heatalarm-on.txt"), off = etsLog("auro-m0081-ets6log-partial-heatalarm-off.txt");
    for (const [l, capture] of [[on, HEAT_ON], [off, HEAT_OFF]] as const) {
      expect(l.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual(etsLog("auro-m0081-ets6log-partial-revert.txt").steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`));
      expect([...l.image]).toEqual([...memoryImage(parseCapture(captureText(capture), ia).writes)].sort(([a], [b]) => a - b));
    }
    expect([...on.image].filter(([a, b]) => off.image.get(a) !== b)).toEqual([[0x4229, 0x01]]);
    expect([...off.image.keys()]).toEqual([...on.image.keys()]);
    expect([configByte(on.image, 21), configByte(off.image, 21)]).toEqual([0x43, 0x43]);
    // The heat-alarm-off image is the revert's: the unit was configured as after the revert before the change.
    expect([...off.image]).toEqual([...etsLog("auro-m0081-ets6log-partial-revert.txt").image]);
  });

  test("structural flash of the heat alarm on: ETS's steps, and exactly the bytes ETS writes, with ETS's values", () => {
    const device = beforeHeat();
    expect(device.get(0x4229)).toBe(0x00);
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: heatOn, baseParams: baseline.params, links: baseline.links });
    expectRevertForm(plan, HEAT_ON, ia, device);
    expect(planSteps(plan)).toEqual(TABLE_BRACKETS("taskSegment:%=000081fe0111"));
    // The tables, the com-object table to its counted entries, every parameter-owned byte (offsets 3 and 36 own none).
    expect(span(bytesOf(plan))).toEqual(["4000-4000", "4003-4006", "402f-4033", "405c-40b6", "4200-4202", "4204-4223", "4225-4231"]);
    expect([...memoryImage(parseCapture(captureText(HEAT_ON), ia).writes)].filter(([a, b]) => device.get(a) !== b)).toEqual([[0x4229, 0x01]]);
  });

  test("structural flash of the heat alarm off: ETS's steps, and exactly the bytes ETS writes, with ETS's values", () => {
    const device = unitMemory(cfg, ia, beforeHeat(), memoryImage(parseCapture(captureText(HEAT_ON), ia).writes));
    expect(device.get(0x4229)).toBe(0x01);
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: baseline.params, baseParams: heatOn, links: baseline.links });
    expectRevertForm(plan, HEAT_OFF, ia, device);
    expect(planSteps(plan)).toEqual(TABLE_BRACKETS("taskSegment:%=000081fe0111"));
    // The tables, the com-object table to its counted entries, every parameter-owned byte (offsets 3 and 36 own none).
    expect(span(bytesOf(plan))).toEqual(["4000-4000", "4003-4006", "402f-4033", "405c-40b6", "4200-4202", "4204-4223", "4225-4231"]);
    expect([...memoryImage(parseCapture(captureText(HEAT_OFF), ia).writes)].filter(([a, b]) => device.get(a) !== b)).toEqual([[0x4229, 0x00]]);
  });
});

// ETS 6 downloads of the Theben TheLuxa P300 (M-0048_A-107E-12-5B58, MV-0705, LdCtrlTaskCtrl1 Address
// 17875 Count 1, DynamicTableManagement), in this order: a full download; a partial download after one
// parameter change ("Temperature calibration in 0.1 °C", AS-4800 offset 19, 0 -> 1); one after linking
// object 16 ("C1 Block", unlinked before) to a test group address; and one that reverted
// both. ETS runs the full download's declared steps in their declared order (no PreferPartialDownloadIfApplicationLoaded),
// but declares the two table segments as one region, as on the Gira (DynamicTableManagement="true"). The
// project is not in the corpus. The configuration is read from what ETS wrote in the full download: the
// links from its tables, the parameter values decoded by Busforge from the 576-byte parameter segment.
corpusDescribe("Theben TheLuxa P300 (M-0048_A-107E-12-5B58) against ETS", () => {
  const xml = catalogueXml("M-0048_A-107E-12-5B58.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const FULL = "theluxa-p300-ets-fulldownload.log", PARTIAL = "theluxa-p300-ets-partial-params.log";
  const ia = deviceOf(FULL), IA = numToIa(ia);
  const LINKS = "theluxa-p300-ets-partial-links.log", REVERT = "theluxa-p300-ets-partial-revert.log";
  const written = memoryImage(parseCapture(captureText(FULL), ia).writes);
  const paramSeg = cfg.absoluteSegments.find((s) => s.address === 0x4800)!;
  const comObjSeg = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
  const segOf = (seg: typeof paramSeg, img: Map<number, number>) => Buffer.from(seg.data.map((b, i) => img.get(seg.address + i) ?? b));
  // What the device holds in the parameter and com-object segments after ETS's full download: both
  // written whole.
  const held = segOf(paramSeg, written), heldComObj = segOf(comObjSeg, written);

  const baseline = (() => {
    const at = (a: number) => written.get(a)!;
    // ETS leaves the address table's own individual address (bytes 1-2) to the device.
    const addr = Buffer.from(Array.from({ length: 1 + 2 * at(0x4000) }, (_, i) => (i === 1 ? ia >> 8 : i === 2 ? ia & 0xff : at(0x4000 + i))));
    const assocAt = 0x4000 + addr.length;
    const assoc = Buffer.from(Array.from({ length: 1 + 2 * at(assocAt) }, (_, i) => at(assocAt + i)));
    const decoded = new Map(decodeAbsoluteImage(toAppModel(cfg, { includeUnions: true }), paramSeg.id, held));
    let params = new Map<string, string>();
    for (let i = 0; ; i++) {
      const active = new Set(buildDeviceConfig(cfg, params).imageValues.keys());
      const next = new Map([...decoded].filter(([r]) => active.has(r)));
      if (next.size === params.size && [...next].every(([r, v]) => params.get(r) === v)) break;
      if (i > 16) throw new Error("the configuration read from the full download never settled");
      params = next;
    }
    return { links: decodeGroupTablesMv0705(addr, assoc), params };
  })();
  const full = () => classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: baseline.params, links: baseline.links, proc });
  const TEMP = "M-0048_A-107E-12-5B58_P-2234";
  const tempRef = () => [...baseline.params.keys()].find((k) => k.startsWith(`${TEMP}_`))!;

  const tableOf = (img: Map<number, number>) => tableGas(fromMemory(img, 0x4000), "system7");

  test("the configuration read from the full download: object 6 on three addresses, the temperature calibration 0", () => {
    const gas = tableOf(written);
    expect(gas.length).toBe(3);
    expect(baseline.links).toEqual([{ comObjNum: 6, gaRaws: gas }]);
    expect(baseline.params.get(tempRef())).toBe("0");
  });

  const task = (l: number, a: number) => `taskSegment:${l}@${a}=000048107e12`;
  test("full download: the declared steps in their declared order, the tables re-declared as one region, TaskCtrl1 as ETS sends it", () => {
    const build = full();
    expect(planSteps(build.plan)).toEqual(withoutVerifyMode(captureSteps(FULL, ia)));
    expect(planSteps(build.plan)).toEqual([
      "unload:1", "unload:2", "unload:3",
      "load:1", "absSegment:1@16384+9", "write", task(1, 16384), "loadCompleted:1",
      "load:2", "absSegment:2@16393+1011", "write", task(2, 16393), "loadCompleted:2",
      "load:3", "absSegment:3@1792+248", "absSegment:3@17404+500", "write", "absSegment:3@18432+576", "write",
      task(3, 17894), "taskCtrl1:3=45d3010000000000", "loadCompleted:3", "restart",
    ]);
    expect(build.plan.filter((s) => (s.op === "absSegment" || s.op === "taskSegment") && s.viaProperty !== true)).toEqual([]);
  });

  test("full download: Busforge writes exactly the bytes ETS writes, with ETS's values", () => {
    const build = full();
    const ours = bytesOf(build.plan);
    const log = etsLog("theluxa-p300-ets6log-fulldownload.txt");
    // Not differential: 1090 bytes, the address table without its own individual address (AS-4000
    // declares no <Mask>), the association table behind it, the com-object table's segment whole (the
    // table's 117 entries and the application data behind them), the parameter segment whole, nothing
    // of the RAM segment AS-0700 (its <Mask> marks no byte).
    expect([log.image.size, log.removed]).toEqual([1090, 0]);
    expect(sorted(ours)).toEqual(sorted(log.image));
    expect(sorted(ours)).toEqual(sorted(written));
    expect(span(ours)).toEqual(["4000-4000", "4003-400f", "43fc-45ef", "4800-4a3f"]);
    expect(span(build.segments.flatMap((s) => Array.from(s.image, (_, i) => s.address! + i)))).toEqual(span(ours));
    expect(cfg.absoluteSegments.find((s) => s.address === 0x4000)!.mask).toBeUndefined();
  });

  test("ETS's log: the declared full steps in their declared order, the table segments re-declared", () => {
    const log = etsLog("theluxa-p300-ets6log-fulldownload.txt");
    const declared = flattenSteps(proc, "full");
    expect(log.steps.map((s) => s.verb)).toEqual(declared.map((s) => s.verb));
    // ETS adds the application id and PEI type to each LdCtrlTaskSegment; the table segments' Address and
    // Size, and their task segments' Address, are the region's. Every other declared attribute is as declared.
    const diffs = declared.flatMap((d, i) => Object.entries(d.attrs).filter(([k, v]) => log.steps[i].attrs[k] !== v).map(([k]) => `${d.verb}${d.attrs.LsmIdx}.${k}=${log.steps[i].attrs[k]}`));
    expect(diffs).toEqual(["LdCtrlAbsSegment1.Size=9", "LdCtrlAbsSegment2.Address=16393", "LdCtrlAbsSegment2.Size=1011", "LdCtrlTaskSegment2.Address=16393"]);
  });

  test("ETS's log of the parameter download: every parameter-covered byte of AS-4800, nothing of the com-object table", () => {
    const log = etsLog("theluxa-p300-ets6log-partial-params.txt");
    expect(log.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual(["LdCtrlConnect", "LdCtrlLoad3", "LdCtrlWriteMem17404", "LdCtrlWriteMem18432", "LdCtrlLoadCompleted3", "LdCtrlRestart", "LdCtrlDisconnect"]);
    const covered = parameterMemoryBytes(cfg, paramSeg.id, paramSeg.size)!;
    expect(sorted(log.image).map(([a]) => a)).toEqual(covered.flatMap((c, i) => (c ? [paramSeg.address + i] : [])));
    expect(log.image.size).toBe(338);
    expect(sorted(log.image)).toEqual(sorted(memoryImage(parseCapture(captureText(PARTIAL), ia).writes)));
  });

  // AS-4800 offset 0 is P-2228 "Hilfsparameter Download Erkennung" (Access="None", value $AA): ETS writes
  // AA in every download, and the unit clears it to 00 once it has seen the download (every read of the
  // unit after one of ETS's downloads holds 00 there). What the unit holds after ETS's full download:
  const onUnit = Buffer.from(held);
  onUnit[0] = 0x00;

  test("parameter flash: ETS's bracket, and exactly the bytes ETS writes, the changed byte and the download marker among them", () => {
    expect(held[0]).toBe(0xaa);
    const after = new Map(baseline.params).set(tempRef(), "1");
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, after, proc, new Map([[paramSeg.id, onUnit]]));
    expect([changedBytes, unplaceable]).toEqual([2, []]);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(PARTIAL, ia)));
    expect(planSteps(plan)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    const ets = memoryImage(parseCapture(captureText(PARTIAL), ia).writes);
    expect([...bytesOf(plan)].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
    expect([ets.get(0x4800), ets.get(0x4813)]).toEqual([0xaa, 0x01]);
  });

  test("parameter flash with nothing changed: the cleared download marker alone is no change, nothing is written", () => {
    expect(constantParams(cfg).get("M-0048_A-107E-12-5B58_P-2228")).toBe("170");
    const { plan, changedBytes, constantsDiffer } = planAbsoluteParFlash(cfg, baseline.params, proc, new Map([[paramSeg.id, onUnit]]));
    expect([changedBytes, bytesOf(plan).size]).toEqual([0, 0]);
    expect(constantsDiffer.map((c) => c.paramRefId)).toEqual([expect.stringMatching(/^M-0048_A-107E-12-5B58_P-2228_R-/)]);
  });

  const gaFlash = (links: { comObjNum: number; gaRaws: number[] }[], deviceComObj: Buffer) => planSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia),
    { address: comObjSeg.address, bytes: withLinkedCommFlags(deviceComObj, new Set(links.map((l) => l.comObjNum))) });
  // The test group address the links download added: the one address of its table no baseline link uses.
  const TEST_GA = addedGa(tableOf(memoryImage(parseCapture(captureText(LINKS), ia).writes)), baseline.links);
  const withTestLink = [...baseline.links, { comObjNum: 16, gaRaws: [TEST_GA] }];
  const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);
  const TABLES = (addrSize: number) => [
    "unload:1", "unload:2",
    "load:1", `absSegment:1@16384+${addrSize}`, "write", task(1, 16384), "loadCompleted:1",
    "load:2", `absSegment:2@${16384 + addrSize}+${1020 - addrSize}`, "write", task(2, 16384 + addrSize), "loadCompleted:2",
    "load:3", "write", "loadCompleted:3", "restart",
  ];

  test("group-address flash: tables re-declared where ETS puts them, exactly the bytes of ETS's image, the com-object table to its 117 entries with the new link bit", () => {
    const { plan, assocAt, comObjWrites } = gaFlash(withTestLink, heldComObj);
    expect(assocAt).toBe(0x400b);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(LINKS, ia)));
    expect(planSteps(plan)).toEqual(TABLES(11));
    const ets = memoryImage(parseCapture(captureText(LINKS), ia).writes);
    const log = etsLog("theluxa-p300-ets6log-partial-links.txt");
    const ours = bytesOf(plan);
    expect([log.image.size, log.removed]).toEqual([489, 0]);
    expect(sorted(ours)).toEqual(sorted(log.image));
    expect(sorted(ours)).toEqual(sorted(ets));
    expect(span(ours)).toEqual(["4000-4000", "4003-4013", "43fc-45d2"]);
    expect(span(comObjWrites.flatMap((w) => Array.from(w.image, (_, i) => w.address + i)))).toEqual(["43fc-45d2"]);
    // Each object's first link first: (1, 6), (4, 16), then object 6's others (2, 6), (3, 6).
    expect(Buffer.from(Array.from({ length: 9 }, (_, i) => ours.get(0x400b + i)!)).toString("hex")).toBe("040106041002060306");
    // Object 16's config byte gains the linked bit, nothing else in the table changes.
    const cfgByte = comObjSeg.address + 3 + 16 * 4 + 2;
    expect([heldComObj[cfgByte - comObjSeg.address], ours.get(cfgByte)]).toEqual([0x1b, 0x1f]);
  });

  test("group-address flash of the revert: the tables and the com-object table ETS's revert writes, byte for byte", () => {
    const linksWritten = memoryImage(parseCapture(captureText(LINKS), ia).writes);
    const { plan, assocAt } = gaFlash(baseline.links, segOf(comObjSeg, new Map([...written, ...linksWritten])));
    expect(assocAt).toBe(0x4009);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(REVERT, ia)));
    expect(planSteps(plan)).toEqual(TABLES(9));
    const ours = bytesOf(plan);
    const revert = memoryImage(parseCapture(captureText(REVERT), ia).writes);
    const tablesOf = (m: Map<number, number>) => new Map([...m].filter(([a]) => a < 0x4800));
    expect(sorted(ours)).toEqual(sorted(tablesOf(revert)));
    expect(sorted(ours)).toEqual(sorted(tablesOf(etsLog("theluxa-p300-ets6log-partial-revert.txt").image)));
    expect(span(ours)).toEqual(["4000-4000", "4003-400f", "43fc-45d2"]);
    // The parameter bytes of the revert are exactly the parameter flash's, the changed byte back with ETS's
    // value; every one of them is the full download's.
    const before = Buffer.from(onUnit);
    before[19] = 1;
    const par = planAbsoluteParFlash(cfg, baseline.params, proc, new Map([[paramSeg.id, before]]));
    expect(sorted(bytesOf(par.plan))).toEqual(sorted(new Map([...revert].filter(([a]) => a >= 0x4800))));
    expect([revert.get(0x4800), revert.get(0x4813)]).toEqual([0xaa, 0x00]);
    expect([...revert].filter(([a, b]) => a >= 0x4800 && written.get(a) !== b)).toEqual([]);
  });

  test("structural flash of the revert: ETS's bracket set, and every byte ETS changed with ETS's value", () => {
    const cleared = new Map([[0x4800, 0x00]]);
    const device = unitMemory(cfg, ia, written, cleared, memoryImage(parseCapture(captureText(PARTIAL), ia).writes), cleared, memoryImage(parseCapture(captureText(LINKS), ia).writes), cleared);
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: baseline.params, baseParams: new Map(baseline.params).set(tempRef(), "1"), links: baseline.links });
    expectRevertForm(plan, REVERT, ia, device);
  });

  test("a table that shrinks leaves its old bytes behind it, in ETS's download and in Busforge's", () => {
    const links = memoryImage(parseCapture(captureText(LINKS), ia).writes);
    const revert = memoryImage(parseCapture(captureText(REVERT), ia).writes);
    const behind = [0x4010, 0x4011, 0x4012, 0x4013];
    expect(behind.map((a) => links.get(a))).toEqual([0x02, 0x06, 0x03, 0x06]);
    expect(behind.filter((a) => revert.has(a))).toEqual([]);
    expect(behind.filter((a) => bytesOf(gaFlash(baseline.links, heldComObj).plan).has(a))).toEqual([]);
  });

  test("ETS's logs of its group-address downloads: the table brackets re-declared, LSM 3 without unload or TaskCtrl1, the image it wrote", () => {
    for (const [log, capture, addrSize] of [["theluxa-p300-ets6log-partial-links.txt", LINKS, 11], ["theluxa-p300-ets6log-partial-revert.txt", REVERT, 9]] as const) {
      const l = etsLog(log);
      expect(l.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}${s.verb === "LdCtrlAbsSegment" ? `@${s.attrs.Address}+${s.attrs.Size}` : ""}`)).toEqual([
        "LdCtrlConnect", "LdCtrlUnload1", "LdCtrlUnload2",
        "LdCtrlLoad1", `LdCtrlAbsSegment1@16384+${addrSize}`, "LdCtrlTaskSegment1", "LdCtrlLoadCompleted1",
        "LdCtrlLoad2", `LdCtrlAbsSegment2@${16384 + addrSize}+${1020 - addrSize}`, "LdCtrlTaskSegment2", "LdCtrlLoadCompleted2",
        "LdCtrlLoad3", "LdCtrlWriteMem17404", "LdCtrlWriteMem18432", "LdCtrlLoadCompleted3", "LdCtrlRestart", "LdCtrlDisconnect",
      ]);
      expect(sorted(l.image)).toEqual(sorted(memoryImage(parseCapture(captureText(capture), ia).writes)));
    }
  });
});

// ETS 6 downloads of the Theben Meteodata 140 S (M-0048_A-140C-14-EB70, MV-0701, memory-mapped load-state
// machines, LdCtrlTaskCtrl1 Address 18155 Count 1, DynamicTableManagement), in this order: a full download;
// a partial download after one parameter change ("Temperature calibration in 0.1 °C", P-2234 at AS-4800
// offset 4, 0 -> 1); one after linking object 23 ("C1 Brightness threshold", unlinked before) to a test
// group address; and one that reverted both. Every load control is the 11-byte memory write
// to 0x0104. ETS reads each block of its image first and writes only the bytes that differ, so the wire
// holds few writes; ETS's own log holds the image it compared against, and that is what Busforge's plan
// is checked against. The configuration is read from that image: the links from its tables, the parameter
// values decoded by Busforge from the parameter segment.
corpusDescribe("Theben Meteodata 140 S (M-0048_A-140C-14-EB70) against ETS", () => {
  const xml = catalogueXml("M-0048_A-140C-14-EB70.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const FULL = "meteodata-140s-ets-fulldownload.log", PARTIAL = "meteodata-140s-ets-partial-params.log";
  const ia = deviceOf(FULL), IA = numToIa(ia);
  const LINKS = "meteodata-140s-ets-partial-links.log", REVERT = "meteodata-140s-ets-partial-revert.log";
  const fullLog = etsLog("meteodata-140s-ets6log-fulldownload.txt");
  const paramSeg = cfg.absoluteSegments.find((s) => s.address === 0x4800)!;
  const comObjSeg = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
  const segOf = (seg: typeof paramSeg, img: Map<number, number>) => Buffer.from(seg.data.map((b, i) => img.get(seg.address + i) ?? b));
  const heldComObj = segOf(comObjSeg, fullLog.image);
  const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);
  // The memory ETS wrote, without the load controls it wrote to 0x0104.
  const wire = (f: string) => new Map([...memoryImage(parseCapture(captureText(f), ia).writes)].filter(([a]) => a >= 0x1c00));

  const baseline = (() => {
    const at = (a: number) => fullLog.image.get(a)!;
    const addr = Buffer.from(Array.from({ length: 1 + 2 * at(0x4000) }, (_, i) => (i === 1 ? ia >> 8 : i === 2 ? ia & 0xff : at(0x4000 + i))));
    const assocAt = 0x4000 + addr.length;
    const assoc = Buffer.from(Array.from({ length: 1 + 2 * at(assocAt) }, (_, i) => at(assocAt + i)));
    // Parameters live in AS-4800 and AS-4C00. Three that decide what is placed have no memory, so no
    // image shows them; they are seeded with the values the project holds, read from its export
    // (private corpus): the "Channel function" of C2 (P-7060, 3: wind) and of C3 (P-7152, 4: rain), and
    // "Telegram type C19.1" (P-8146, 2). A wrong value would move the active parameters and show as a byte mismatch below.
    const model = toAppModel(cfg, { includeUnions: true });
    const seeded: [string, string][] = [["M-0048_A-140C-14-EB70_P-7060_R-7060", "3"], ["M-0048_A-140C-14-EB70_P-7152_R-7152", "4"], ["M-0048_A-140C-14-EB70_P-8146_R-8146", "2"]];
    const decoded = new Map([...seeded, ...[0x4800, 0x4c00].flatMap((at) => { const seg = cfg.absoluteSegments.find((s) => s.address === at)!; return [...decodeAbsoluteImage(model, seg.id, segOf(seg, fullLog.image))]; })]);
    let params = new Map<string, string>(seeded);
    for (let i = 0; ; i++) {
      const active = new Set(buildDeviceConfig(cfg, params).imageValues.keys());
      const next = new Map([...decoded].filter(([r]) => active.has(r)));
      if (next.size === params.size && [...next].every(([r, v]) => params.get(r) === v)) break;
      if (i > 16) throw new Error("the configuration read from the full download never settled");
      params = next;
    }
    return { links: decodeGroupTablesMv0705(addr, assoc), params };
  })();
  const full = () => classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: baseline.params, links: baseline.links, proc });
  const task = (l: number, a: number) => `taskSegment:${l}@${a}=000048140c14`;

  test("full download: the declared steps in their declared order, over 0x0104, the tables as one region, TaskCtrl1 as ETS sends it", () => {
    const build = full();
    const ets = captureSteps(FULL, ia).filter((s) => s !== "write");
    expect(planSteps(build.plan).filter((s) => s !== "write")).toEqual(ets);
    expect(planSteps(build.plan)).toEqual([
      "unload:1", "unload:2", "unload:3",
      "load:1", "absSegment:1@16384+41", "write", task(1, 16384), "loadCompleted:1",
      "load:2", "absSegment:2@16425+983", "write", task(2, 16425), "loadCompleted:2",
      "load:3", "absSegment:3@7168+432", "absSegment:3@17408+958", "write", "absSegment:3@18432+1024", "write", "absSegment:3@19456+1024", "write",
      task(3, 18356), "taskCtrl1:3=46eb010000000000", "loadCompleted:3", "restart",
    ]);
    expect(build.plan.filter((s) => (s.op === "absSegment" || s.op === "taskSegment") && s.viaProperty === true)).toEqual([]);
  });

  test("full download: Busforge's image is ETS's, byte for byte", () => {
    const ours = bytesOf(full().plan);
    const diff = [...new Set([...ours.keys(), ...fullLog.image.keys()])].filter((a) => ours.get(a) !== fullLog.image.get(a)).sort((a, b) => a - b);
    expect(diff.map((a) => `${a.toString(16)}:${fullLog.image.get(a)?.toString(16)}/${ours.get(a)?.toString(16)}`)).toEqual([]);
    expect(sorted(ours)).toEqual(sorted(fullLog.image));
  });

  // ETS reads each block of its image first and writes the bytes that differ; so does Busforge on this mask.
  test("full download: read and compared, exactly the bytes ETS writes", () => {
    const ours = readCompared(full().plan, heldBeforeWrite(FULL, ia));
    expect(sorted(ours)).toEqual(sorted(wire(FULL)));
    expect(sorted(ours).map(([a, b]) => `${a.toString(16)}=${b.toString(16)}`)).toEqual(["4000=14", "4800=aa"]);
  });

  test("ETS's log: the declared full steps in their declared order, the table segments re-declared", () => {
    const declared = flattenSteps(proc, "full");
    expect(fullLog.steps.map((s) => s.verb)).toEqual(declared.map((s) => s.verb));
    const diffs = declared.flatMap((d, i) => Object.entries(d.attrs).filter(([k, v]) => fullLog.steps[i].attrs[k] !== v).map(([k]) => `${d.verb}${d.attrs.LsmIdx}.${k}=${fullLog.steps[i].attrs[k]}`));
    expect(diffs).toEqual(["LdCtrlAbsSegment1.Size=41", "LdCtrlAbsSegment2.Address=16425", "LdCtrlAbsSegment2.Size=983", "LdCtrlTaskSegment2.Address=16425"]);
  });

  test("full download: what ETS's image holds besides the tables, the com-object table's segment and the masked parameter bytes", () => {
    // ETS reads its whole image and writes what differs (the wire holds 0x4000 and the 0x4800 marker), as
    // Busforge does (readCompared above). Not differential by stamps: no bytes removed.
    expect(fullLog.removed).toBe(0);
    expect(span(new Map([...fullLog.image].filter(([a]) => a < 0x4400)))).toEqual(["4000-4000", "4003-404f", "41ff-4200"]);
    expect(span(new Map([...fullLog.image].filter(([a]) => a >= 0x4400 && a < 0x4800)))).toEqual(["4400-47bd"]);
    expect(span(new Map([...fullLog.image].filter(([a]) => a >= 0x4c00)))).toEqual(["4c00-4c1f"]);
    expect([...fullLog.image.keys()].filter((a) => a < 0x4000)).toEqual([]); // nothing of the RAM segment AS-1C00
    expect([...wire(FULL)]).toEqual([[0x4000, 0x14], [0x4800, 0xaa]]);
  });

  // AS-4800 offset 0 is P-2228 "Downloaderkennung" (Access="None", $AA): ETS writes AA in every download,
  // the unit clears it to 00.
  const onUnit = segOf(paramSeg, fullLog.image);
  onUnit[0] = 0x00;
  const otherParams = cfg.absoluteSegments.find((s) => s.address === 0x4c00)!;
  const held4c = segOf(otherParams, fullLog.image);
  const TEMP = "M-0048_A-140C-14-EB70_P-2234";
  const tempRef = () => [...baseline.params.keys()].find((k) => k.startsWith(`${TEMP}_`))!;

  test("parameter flash: ETS's bracket over 0x0104, the changed byte and the download marker, as ETS writes them", () => {
    expect(baseline.params.get(tempRef())).toBe("0");
    const after = new Map(baseline.params).set(tempRef(), "1");
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, after, proc, new Map([[paramSeg.id, onUnit], [otherParams.id, held4c]]));
    expect([changedBytes, unplaceable]).toEqual([2, []]);
    expect(planSteps(plan)).toEqual(captureSteps(PARTIAL, ia));
    expect(planSteps(plan)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    expect([...bytesOf(plan)]).toEqual([[0x4800, 0xaa], [0x4804, 0x01]]);
    expect([...wire(PARTIAL)]).toEqual([[0x4800, 0xaa], [0x4804, 0x01]]);
  });

  test("parameter flash with nothing changed: the cleared download marker alone is no change, nothing is written", () => {
    expect(constantParams(cfg).get("M-0048_A-140C-14-EB70_P-2228")).toBe("170");
    const { plan, changedBytes, constantsDiffer } = planAbsoluteParFlash(cfg, baseline.params, proc, new Map([[paramSeg.id, onUnit], [otherParams.id, held4c]]));
    expect([changedBytes, bytesOf(plan).size]).toEqual([0, 0]);
    expect(constantsDiffer.map((c) => c.paramRefId)).toEqual([expect.stringMatching(/^M-0048_A-140C-14-EB70_P-2228_R-/)]);
  });

  const gaFlash = (links: { comObjNum: number; gaRaws: number[] }[], deviceComObj: Buffer) => planSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia),
    { address: comObjSeg.address, bytes: withLinkedCommFlags(deviceComObj, new Set(links.map((l) => l.comObjNum))) });
  // The test group address the links download added: the one address of its image's table no baseline link uses.
  const TEST_GA = addedGa(tableGas(fromMemory(etsLog("meteodata-140s-ets6log-partial-links.txt").image, 0x4000), "system7"), baseline.links);
  const withTestLink = [...baseline.links, { comObjNum: 23, gaRaws: [TEST_GA] }];
  const TABLES = (addrSize: number) => [
    "unload:1", "unload:2",
    "load:1", `absSegment:1@16384+${addrSize}`, "write", task(1, 16384), "loadCompleted:1",
    "load:2", `absSegment:2@${16384 + addrSize}+${1024 - addrSize}`, "write", task(2, 16384 + addrSize), "loadCompleted:2",
    "load:3", "write", "loadCompleted:3", "restart",
  ];

  test("group-address flash: the tables re-declared over 0x0104 where ETS puts them, exactly ETS's image, the com-object table to its 186 entries", () => {
    const { plan, assocAt, comObjWrites } = gaFlash(withTestLink, heldComObj);
    expect(assocAt).toBe(0x402b);
    expect(planSteps(plan)).toEqual(TABLES(43));
    expect(planSteps(plan).filter((s) => s !== "write")).toEqual(captureSteps(LINKS, ia).filter((s) => s !== "write"));
    const log = etsLog("meteodata-140s-ets6log-partial-links.txt");
    const ours = bytesOf(plan);
    expect(log.removed).toBe(0);
    expect(sorted(ours)).toEqual(sorted(log.image));
    expect(span(ours)).toEqual(["4000-4000", "4003-4053", "4400-46ea"]);
    expect(span(comObjWrites.flatMap((w) => Array.from(w.image, (_, i) => w.address + i)))).toEqual(["4400-46ea"]);
    // Read and compared, the bytes on the wire are ETS's.
    // Where neither ETS read nor a download wrote, the unit holds the segment's <Data>.
    const template = new Map(cfg.absoluteSegments.flatMap((sg) => Array.from(sg.data, (b, i) => [sg.address + i, b] as [number, number])));
    expect(sorted(readCompared(plan, heldBeforeWrite(LINKS, ia, new Map([...template, ...fullLog.image]))))).toEqual(sorted(wire(LINKS)));
    // Object 23's config byte gains the linked bit, nothing else in the table changes.
    const cfgByte = comObjSeg.address + 3 + 23 * 4 + 2;
    expect([heldComObj[cfgByte - comObjSeg.address], ours.get(cfgByte)]).toEqual([0x4b, 0x4f]);
    const written = wire(LINKS);
    expect([...written].filter(([a, b]) => ours.get(a) !== b)).toEqual([]);
  });

  test("group-address flash of the revert: the tables and the com-object table ETS's revert holds, byte for byte", () => {
    const linksLog = etsLog("meteodata-140s-ets6log-partial-links.txt");
    const { plan, assocAt } = gaFlash(baseline.links, segOf(comObjSeg, new Map([...fullLog.image, ...linksLog.image])));
    expect(assocAt).toBe(0x4029);
    expect(planSteps(plan)).toEqual(TABLES(41));
    const ours = bytesOf(plan);
    const revertLog = etsLog("meteodata-140s-ets6log-partial-revert.txt");
    const tablesOf = (m: Map<number, number>) => new Map([...m].filter(([a]) => a < 0x4800));
    expect(sorted(ours)).toEqual(sorted(tablesOf(revertLog.image)));
    expect(span(ours)).toEqual(["4000-4000", "4003-404f", "4400-46ea"]);
    const revertWire = new Map([...wire(REVERT)].filter(([a]) => a < 0x4800));
    expect(sorted(readCompared(plan, heldBeforeWrite(REVERT, ia, new Map([...fullLog.image, ...linksLog.image]))))).toEqual(sorted(revertWire));
    // The revert's parameter bytes: the parameter flash writes the one byte back with the marker.
    const before = Buffer.from(onUnit);
    before[4] = 1;
    const par = planAbsoluteParFlash(cfg, baseline.params, proc, new Map([[paramSeg.id, before], [otherParams.id, held4c]]));
    expect([...bytesOf(par.plan)]).toEqual([[0x4800, 0xaa], [0x4804, 0x00]]);
    const written = wire(REVERT);
    expect([written.get(0x4800), written.get(0x4804)]).toEqual([0xaa, 0x00]);
  });

  test("structural flash of the revert: ETS's bracket set, and every byte ETS changed with ETS's value", () => {
    const cleared = new Map([[0x4800, 0x00]]);
    const device = unitMemory(cfg, ia, fullLog.image, cleared, wire(PARTIAL), cleared, wire(LINKS), cleared);
    const { plan } = system7StructuralFlash({ cfg, proc, ia, device, params: baseline.params, baseParams: new Map(baseline.params).set(tempRef(), "1"), links: baseline.links });
    expectRevertForm(plan, REVERT, ia, device, etsLog("meteodata-140s-ets6log-partial-revert.txt").image);
  });

  test("a table that shrinks leaves its old bytes behind it, in ETS's download and in Busforge's", () => {
    const revert = wire(REVERT);
    const behind = [0x4050, 0x4051, 0x4052, 0x4053];
    expect(behind.filter((a) => revert.has(a))).toEqual([]);
    expect(behind.filter((a) => bytesOf(gaFlash(baseline.links, heldComObj).plan).has(a))).toEqual([]);
  });

  test("a <Mask> shorter than its segment that marks a byte, and table <Data> reaching past the declared region, are refused", () => {
    const fresh = () => parseAppConfig(xml);
    const plan = (c: ReturnType<typeof parseAppConfig>) => classify(c).planFullDownload(c.mask, { ia: IA, params: baseline.params, links: baseline.links, proc });
    const marked = fresh();
    const ram = marked.absoluteSegments.find((s) => s.address === 0x1c00)!;
    ram.mask = Buffer.from(ram.mask!); ram.mask[0] = 0xff;
    expect(() => plan(marked)).toThrow(/FULL_DOWNLOAD_SEGMENT_UNKNOWN|<Mask>/);
    const longer = fresh();
    const as4000 = longer.absoluteSegments.find((s) => s.address === 0x4000)!;
    as4000.data = Buffer.concat([as4000.data, Buffer.from([0x00])]);
    as4000.size += 1;
    as4000.mask = Buffer.concat([as4000.mask!, Buffer.from([0xff])]);
    expect(() => plan(longer)).toThrow(/reaches past the size its load procedure declares/);
  });

  test("ETS's logs of its group-address downloads: the table brackets re-declared, LSM 3 without unload or TaskCtrl1", () => {
    for (const [log, addrSize] of [["meteodata-140s-ets6log-partial-links.txt", 43], ["meteodata-140s-ets6log-partial-revert.txt", 41]] as const) {
      const l = etsLog(log);
      const steps = l.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}${s.verb === "LdCtrlAbsSegment" ? `@${s.attrs.Address}+${s.attrs.Size}` : ""}`);
      expect(steps.slice(0, 12)).toEqual([
        "LdCtrlConnect", "LdCtrlUnload1", "LdCtrlUnload2",
        "LdCtrlLoad1", `LdCtrlAbsSegment1@16384+${addrSize}`, "LdCtrlTaskSegment1", "LdCtrlLoadCompleted1",
        "LdCtrlLoad2", `LdCtrlAbsSegment2@${16384 + addrSize}+${1024 - addrSize}`, "LdCtrlTaskSegment2", "LdCtrlLoadCompleted2",
        "LdCtrlLoad3",
      ]);
      expect(steps.filter((s) => s.startsWith("LdCtrlTaskCtrl1") || s.startsWith("LdCtrlUnload3"))).toEqual([]);
    }
  });
});


// ETS 6 downloads of the three products of the Theben MIX 2 application (M-0048_A-493B-21-B471, MV-07B0,
// System B, module slots, two declared memory-control-block regions), one unit each: HMG 6 T,
// JMG 4 T, RMG 8 T. On each, in this order: a full download; a
// partial download after one parameter change; one after linking one unlinked object to a test group address; and
// one that reverted both. The configuration ETS downloaded is the project's, taken from its export
// before the run without names (private corpus captures/mix2-*-config.json). ETS's own log holds the image of each download per load-state
// machine (RelMemory(n), offsets in the segment); Busforge's segments are compared with it, the
// parameter download's image with the bytes Busforge's parameter flash owns.
const relImage = (file: string) => {
  const out = new Map<number, Map<number, number>>();
  let lsm = -1, inImage = false;
  for (const l of captureText(file).split(/\r?\n/)) {
    if (l.includes(" - Execute image:")) { inImage = true; continue; }
    if (l.includes(" - Execute procedure:")) inImage = false;
    if (!inImage) continue;
    const range = l.match(/ - (\w+)(?:\((\d+)\))?\[\$([0-9A-F]+)-\$[0-9A-F]+\]:$/);
    if (range) { lsm = range[1] === "RelMemory" && Number(range[3]) === 0 ? Number(range[2]) : -1; if (lsm > 0 && !out.has(lsm)) out.set(lsm, new Map()); continue; }
    const row = l.match(/ - {2}([0-9A-F]{4}): ((?:(?:[0-9A-F]{2}|--) ?){1,16})$/);
    if (row && lsm > 0) row[2].trim().split(" ").forEach((b, i) => { if (b !== "--") out.get(lsm)!.set(Number.parseInt(row[1], 16) + i, Number.parseInt(b, 16)); });
  }
  return out;
};
// The load controls of a System B download as ETS sent them and as Busforge plans them: load-state events,
// allocations (size, mode), memory-control-block writes, the program id, the PID 27 reads after the last
// LoadCompleted, the restart. Other reads and memory writes are left out; what each side does besides is
// listed in the tests.
function systemBCaptureBracket(file: string, ia: number): string[] {
  const out: string[] = [];
  for (const l of captureText(file).split("\n")) {
    const m = l.includes("ETS->BRIDGE") ? l.match(/\| ([0-9a-fA-F]+)\s*$/) : null;
    const fr = m ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group || fr.dst !== ia || fr.tpdu.length < 2) continue;
    const t = fr.tpdu, apci = ((t[0] & 0x03) << 8) | t[1];
    if (apci === 0x3d7 && t[3] === 5) {
      const d = t.subarray(6);
      out.push(d[0] === 3 && d[1] === 0x0b ? `alloc:${t[2]}:${d.readUInt32BE(2)}:${d[6]}:${d[7]}` : `${({ 1: "load", 2: "loadCompleted", 4: "unload" } as Record<number, string>)[d[0]]}:${t[2]}`);
    } else if (apci === 0x3d7 && t[3] === 27) out.push(`mcb:${t[2]}:${((t[4] & 0x0f) << 8) | t[5]}:${t.subarray(6).toString("hex")}`);
    else if (apci === 0x3d7 && t[3] === 13) out.push(`stamp:${t.subarray(6).toString("hex")}`);
    else if (apci === 0x3d7) out.push(`prop ${t[2]}/${t[3]}`);
    else if (apci === 0x3d5 && t[3] === 27) out.push(`read:${t[2]}/27:${((t[4] & 0x0f) << 8) | t[5]}:${t[4] >> 4}`);
    else if ((apci & 0x3c0) === 0x380) out.push(`restart:${t.subarray(1).toString("hex")}`);
  }
  return out.slice(out.findIndex((s) => s.startsWith("unload:") || s.startsWith("load:")));
}
function systemBPlanBracket(plan: LoadPlan): string[] {
  return plan.flatMap((s): string[] => {
    if (s.op === "unload" || s.op === "load" || s.op === "loadCompleted") return [`${s.op}:${s.lsm}`];
    if (s.op === "alloc") return [`alloc:${s.lsm}:${s.size}:${s.fill ? 1 : 0}:${s.fill ? s.fillByte ?? 0 : 0}`];
    if (s.op === "writeProp" && s.pid === 27) return [`mcb:${s.obj}:${s.start ?? 1}:${s.data.toString("hex")}`];
    if (s.op === "writeProp") return [`prop ${s.obj}/${s.pid}`];
    if (s.op === "stampAppId") return [`stamp:${s.data.toString("hex")}`];
    if (s.op === "readProp" && s.pid === 27) return [`read:${s.obj}/27:${s.start}:${s.count ?? 1}`];
    if (s.op === "restart") return [`restart:${s.confirmed ? "810100" : "80"}`];
    return [];
  });
}
// What a plan does between its last LoadCompleted and its restart, besides the PID 27 reads: ETS sends
// nothing else there and restarts within a second, on the same connection.
const closingExtras = (plan: LoadPlan) => plan.slice(plan.findLastIndex((s) => s.op === "loadCompleted") + 1).filter((s) => s.op !== "readProp" && s.op !== "restart").map((s) => s.op);
corpusDescribe("Theben MIX 2 (M-0048_A-493B-21-B471) against ETS", () => {
  const xml = catalogueXml("M-0048_A-493B-21-B471.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const A = "M-0048_A-493B-21-B471";
  const PRODUCTS = [
    { name: "HMG 6 T", tag: "hmg6t", par: { ref: `${A}_MD-8_M-20_MI-1_P-6_R-6`, from: "10", to: "15", offset: 86 }, link: 76 },
    { name: "JMG 4 T", tag: "jmg4t", par: { ref: `${A}_MD-6_M-16_MI-3_P-13_R-13`, from: "50", to: "51", offset: 206 }, link: 54 },
    { name: "RMG 8 T", tag: "rmg8t", par: { ref: `${A}_MD-12_M-39_MI-1_P-28_R-442`, from: "4", to: "6", offset: 1191 }, link: 201 },
  ];
  // P-199 "A_Download erfolgt" (offset 39, bit 0x80, Access="None"): every full and parameter download
  // writes it set, the unit clears it (docs/findings.md, LegacyPatchAlways).
  const DOWNLOADED = 39;
  // A parameter that shows unlinked objects, captured switched on and off: "Diagnosemeldungen aktivieren" of the
  // first extension module (DME 2 T, channel C1), which shows objects 95 to 99 (diagnostics).
  const SHOWS: Record<string, { name: string; kind: string; ref: string; objects: number[] }> = {
    hmg6t: { name: "the DME 2 T's diagnostics", kind: "diag", ref: `${A}_MD-12_M-36_MI-1_P-9_R-9`, objects: [95, 96, 97, 98, 99] },
  };
  for (const p of PRODUCTS) {
    describe(p.name, () => {
      const fixture = JSON.parse(captureText(`mix2-${p.tag}-config.json`)) as { ia: string; params: [string, string][]; instances: Parameters<typeof buildDeviceConfig>[3]; links: { comObjNum: number; gaRaws: number[] }[]; overrides: { comObjRefId: string; attrs: Record<string, string> }[] };
      const ia = iaToNum(fixture.ia);
      const file = (kind: string) => `mix2-${p.tag}-ets-${kind}.log`;
      const log = (kind: string) => relImage(`mix2-${p.tag}-ets6log-${kind}.txt`);
      const build = (params: Map<string, string>, links: typeof fixture.links) => {
        const view = buildDeviceConfig(cfg, params, undefined, fixture.instances);
        return classify(cfg).planFullDownload(cfg.mask, { ia: fixture.ia, params, links, moduleInstances: fixture.instances, proc, comObjectOverrides: placeComObjOverrides(cfg, view, fixture.overrides) });
      };
      const params = new Map(fixture.params);
      const full = build(params, fixture.links);
      const segment = (b: typeof full, lsm: number) => b.segments.find((s) => s.lsm === lsm)!.image;
      const asMap = (img: Buffer) => new Map(Array.from(img, (b, i) => [i, b] as [number, number]));
      const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);
      // The test group address the links download added: the one address of its image's table no project link uses.
      const withLink = [...fixture.links, { comObjNum: p.link, gaRaws: [addedGa(tableGas((o) => log("partial-links").get(1)!.get(o), "systemB"), fixture.links)] }];

      test("the configuration is the project's: the parameter changed is at ETS's value before it", () => {
        expect(buildDeviceConfig(cfg, params, undefined, fixture.instances).imageValues.get(p.par.ref)).toBe(p.par.from);
        expect(fixture.links.some((l) => l.comObjNum === p.link)).toBe(false);
      });

      test("full download: Busforge's four segments are ETS's image, byte for byte, the object-link tables included", () => {
        const ets = log("fulldownload");
        for (const lsm of [4, 3, 2, 1]) expect([lsm, sorted(asMap(segment(full, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
        // The active "Objektlink" union member of each module slot (offsets 330, 842, 1354) writes its
        // BinaryValue, decoded.
        const l4 = segment(full, 4);
        expect([330, 842, 1354].map((o) => l4.subarray(o, o + 4).toString("hex")).some((h) => h !== "00000000")).toBe(true);
      });

      test("full download: every byte ETS wrote on the wire is Busforge's", () => {
        const cap = parseCapture(captureText(file("fulldownload")), ia);
        const refs = reportedTableReferences(cap);
        const r = compareSegments(full.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
        expect(r.segments.map((s) => [s.lsm, s.divergences.length])).toEqual([[4, 0], [3, 0], [2, 0], [1, 0]]);
        expect(r.unattributed).toEqual([]);
      });

      test("full download: ETS's bracket, the PEI program unloaded first and the restart confirmed", () => {
        const ets = systemBCaptureBracket(file("fulldownload"), ia);
        expect(systemBPlanBracket(full.plan)).toEqual(ets);
        expect(ets.slice(0, 5)).toEqual(["unload:5", "unload:4", "unload:3", "unload:2", "unload:1"]);
        expect(ets.at(-1)).toBe("restart:810100");
        expect(ets.slice(-5)).toEqual(["read:1/27:1:1", "read:2/27:1:1", "read:3/27:1:1", "read:4/27:1:2", "restart:810100"]);
        // Busforge besides reads the load states of the three tables there and switches verify mode off
        // (skipped where its writes are confirmed, as on this device); no pause, no new connection.
        expect(closingExtras(full.plan)).toEqual(["assertLoaded", "assertLoaded", "assertLoaded", "verifyMode"]);
      });

      // What the unit holds after ETS's full download: ETS's image, with the download marker cleared.
      const held = Buffer.from(segment(full, 4));
      held[DOWNLOADED] &= 0x7f;
      const parFlash = (values: Map<string, string>, current: Buffer) => {
        const target = buildRelativeSegmentTarget(cfg, values, 4, { moduleInstances: fixture.instances, ownIdleUnionDefaults: true })!;
        const { image } = mergeRelativeTarget(current, target);
        const ours = new Map<number, number>();
        for (const r of ownedRuns(image, target.owned)) r.bytes.forEach((b, i) => ours.set(r.offset + i, b));
        const plan = withClosing(withConfirmedRestart(planRelativeParFlash(4, image, target.owned, 0x3bfe, Buffer.from("0048493b21", "hex"), true, declaredMcbWrites(proc, target.size, "par")), proc.secureEnabled), proc, "par");
        return { ours, image, plan };
      };
      const changed = new Map(params).set(p.par.ref, p.par.to);

      test("parameter flash: exactly the bytes of ETS's parameter download, with its values, in ETS's bracket", () => {
        const { ours, plan } = parFlash(changed, held);
        expect(sorted(ours)).toEqual(sorted(log("partial-params").get(4)!));
        expect([...ours].filter(([o, b]) => held[o] !== b).map(([o]) => o)).toEqual([DOWNLOADED, p.par.offset]);
        expect(systemBPlanBracket(plan)).toEqual(systemBCaptureBracket(file("partial-params"), ia));
      });

      // The unit as ETS's full download left it, under the configuration of that download: its image
      // differs from the unit in the cleared marker alone, which is no change (constantParams), so a
      // parameter flash is unchanged and writes nothing.
      test("parameter flash with nothing changed: the cleared download marker alone is no change", () => {
        const target = buildRelativeSegmentTarget(cfg, params, 4, { moduleInstances: fixture.instances, ownIdleUnionDefaults: true })!;
        const { image, diffBytes } = mergeRelativeTarget(held, target);
        expect([...image.keys()].filter((o) => image[o] !== held[o])).toEqual([DOWNLOADED]);
        expect(diffBytes).toBe(0);
        expect(constantParams(cfg).get(`${A}_P-199`)).toBe("1");
        expect(differingConstants(cfg, target.constants, held, image).map((c) => c.paramRefId)).toEqual([expect.stringMatching(new RegExp(`^${A}_P-199_R-`))]);
      });

      test("group-address flash: ETS's tables and com-object table, in ETS's bracket", () => {
        const linked = build(params, withLink);
        const ets = log("partial-links");
        for (const lsm of [3, 2, 1]) expect([lsm, sorted(asMap(segment(linked, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
        expect(ets.get(4)?.size).toBe(0); // the application's range is listed with no byte in it
        const plan = withClosing(withConfirmedRestart(planSystemBGaFlash({ addr: segment(linked, 1), assoc: segment(linked, 2), comObj: segment(linked, 3) }, true, false), proc.secureEnabled), proc, "grp");
        expect(systemBPlanBracket(plan)).toEqual(systemBCaptureBracket(file("partial-links"), ia));
      });

      // ETS reverts both changes in one partial download, one bracket over all four objects (the
      // structural bracket, docs/findings.md §28); Busforge reverts them with its parameter flash and its
      // group-address flash. Their bytes are compared with ETS's, the brackets are each the one above.
      test("revert: the parameter bytes and the tables ETS's revert holds", () => {
        const after = parFlash(changed, held).image;
        after[DOWNLOADED] &= 0x7f;
        const { ours } = parFlash(params, after);
        const ets = log("partial-revert");
        expect(sorted(ours)).toEqual(sorted(ets.get(4)!));
        expect(ours.get(p.par.offset)).toBe(held[p.par.offset]);
        for (const lsm of [3, 2, 1]) expect([lsm, sorted(asMap(segment(full, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
        expect(systemBCaptureBracket(file("partial-revert"), ia).filter((s) => s.startsWith("unload:"))).toEqual(["unload:4", "unload:3", "unload:2", "unload:1"]);
      });

      // The same revert as Busforge's structural flash, from the unit ETS's parameter and group-address
      // downloads left: ETS's bracket, and its bytes. Its record is that of its parameter flash (the application
      // written), which the group-address download in between left as it was while changing the com-object table's
      // stamp: ETS's log falls back on it, and both write every owned parameter byte, the com-object table whole and
      // the group tables whole.
      test("structural flash of the revert: ETS's bracket, and exactly the bytes of ETS's revert", () => {
        const unitParams = parFlash(changed, held).image;
        unitParams[DOWNLOADED] &= 0x7f;
        const unitComObj = segment(build(params, withLink), 3);
        const target = buildRelativeSegmentTarget(cfg, params, 4, { moduleInstances: fixture.instances, ownIdleUnionDefaults: true })!;
        const { image } = mergeRelativeTarget(unitParams, target);
        const comObj = segment(full, 3);
        const mcb = declaredMcbWrites(proc, target.size, "par");
        const record = logStamps(`mix2-${p.tag}-ets6log-partial-params.txt`).closing.map((r) => (r.obj === 4 ? { ...r, written: true as const } : r));
        const check = stampCheck(record, `mix2-${p.tag}-ets6log-partial-revert.txt`);
        expect(check.equal).toBe(false);
        expect(captureText(`mix2-${p.tag}-ets6log-partial-revert.txt`)).toContain("Differential Image Stamp does not match");
        const plan = withClosing(withConfirmedRestart(planRelativeStructuralFlash(4, {
          params: { image, owned: relativeParWriteSet(image, unitParams, target.owned, mcb, check), keptAt: 0x3bfe },
          comObj: { image: comObj, owned: relativeComObjWriteSet(comObj, unitComObj, record, check), keptAt: 0x3000 },
          addr: segment(full, 1), assoc: segment(full, 2),
        }, Buffer.from("0048493b21", "hex"), true, mcb), proc.secureEnabled), proc, "par");
        expect(systemBPlanBracket(plan)).toEqual(systemBCaptureBracket(file("partial-revert"), ia));
        const ets = log("partial-revert");
        const written = (lsm: number) => new Map(plan.flatMap((st) => (st.op === "writeSegmentOwned" && st.lsm === lsm
          ? ownedRuns(st.image, st.owned).flatMap((r) => [...r.bytes].map((b, i) => [r.offset + i, b] as [number, number])) : [])));
        for (const lsm of [4, 3]) expect([lsm, sorted(written(lsm))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
        const whole = (lsm: number) => plan.flatMap((st) => (st.op === "writeSegment" && st.lsm === lsm ? [asMap(st.bytes)] : []));
        for (const lsm of [2, 1]) expect([lsm, whole(lsm).map(sorted)]).toEqual([lsm, [sorted(ets.get(lsm)!)]]);
      });

      const shows = SHOWS[p.tag];
      if (!shows) return;
      // Two more partial downloads, on the unit after a full download of the configuration of the captures
      // above: a parameter that shows objects (unlinked) switched on, and back. ETS runs both with the
      // revert's bracket and falls back from its differential form each time, so its image holds every byte
      // a parameter owns and the three tables whole.
      const shown = new Map(params).set(shows.ref, "1");
      const onFile = file(`partial-${shows.kind}-on`), offFile = file(`partial-${shows.kind}-off`);
      const onLog = `mix2-${p.tag}-ets6log-partial-${shows.kind}-on.txt`, offLog = `mix2-${p.tag}-ets6log-partial-${shows.kind}-off.txt`;
      // Where the unit keeps each segment, as it reported it to ETS.
      const kept = (capture: string) => reportedTableReferences(parseCapture(captureText(capture), ia));
      // The unit's memory by address: the parameter segment and the com-object table given, the group tables of `full`.
      const unitAt = (at: Map<number, number>, app: Buffer, comObj: Buffer) => {
        const m = new Map<number, number>();
        for (const [lsm, seg] of [[4, app], [3, comObj], [2, segment(full, 2)], [1, segment(full, 1)]] as const) seg.forEach((b, i) => m.set(at.get(lsm)! + i, b));
        return m;
      };
      const offsetsToAddresses = (img: Map<number, Map<number, number>>, at: Map<number, number>) => new Map([...img].flatMap(([lsm, m]) => [...m].map(([o, b]) => [at.get(lsm)! + o, b] as [number, number])));

      test(`${shows.name} on and off: objects ${shows.objects[0]} to ${shows.objects.at(-1)} added and removed, so the change takes the structural flash`, () => {
        // The project holds the catalogue default, "nein".
        expect(params.has(shows.ref)).toBe(false);
        expect(buildDeviceConfig(cfg, params, undefined, fixture.instances).imageValues.get(shows.ref)).toBe("0");
        expect(comObjectTableChanges(cfg, params, shown, fixture.instances).map((c) => [c.number, c.fields])).toEqual(shows.objects.map((n) => [n, ["added"]]));
        expect(comObjectTableChanges(cfg, shown, params, fixture.instances).map((c) => [c.number, c.fields])).toEqual(shows.objects.map((n) => [n, ["removed"]]));
        expect(fixture.links.filter((l) => shows.objects.includes(l.comObjNum))).toEqual([]);
        expect(classify(cfg).capabilities().structuralFlash).toBe(true);
      });

      // ETS's image of "on" against its full download: the shown objects' config bytes (0x00 to 0x4b, an unlinked
      // object's), and of the application the switch and the parameters it shows (offset 637: P-9 0x40 and the six
      // flags beside it at 0; offset 638: the cyclic sending time P-105, 10, its low nibble). "Off" is the full
      // download's image again, without offset 638: P-105 is inactive again and placed only in the branch not
      // taken, so ETS does not write it (R14, DownloadInvisibleParameters="None"), and the unit keeps the 10 "on"
      // wrote; the unit's collects before and after both downloads differ in that memory byte alone. Busforge
      // leaves it too: a module-instance parameter is owned only while active (buildRelativeSegmentTarget).
      test(`ETS's logs of ${shows.name} on and off: the revert's bracket, the image of the wire, what each changes`, () => {
        const full4 = log("fulldownload");
        for (const [capture, l] of [[onFile, onLog], [offFile, offLog]] as const) {
          expect(captureText(l)).toContain("Differential Image Stamp does not match, falling back to partial download");
          expect(etsLog(l).removed).toBe(0);
          expect(systemBCaptureBracket(capture, ia)).toEqual(systemBCaptureBracket(file("partial-revert"), ia));
          expect(sorted(offsetsToAddresses(relImage(l), kept(capture)))).toEqual(sorted(memoryImage(parseCapture(captureText(capture), ia).writes)));
          for (const lsm of [2, 1]) expect([lsm, sorted(relImage(l).get(lsm)!)]).toEqual([lsm, sorted(full4.get(lsm)!)]);
          expect(sorted(relImage(l).get(3)!)).toHaveLength(segment(full, 3).length);
        }
        const on = relImage(onLog), off = relImage(offLog), revert = log("partial-revert");
        const changes = (img: Map<number, Map<number, number>>, lsm: number) => [...img.get(lsm)!].filter(([o, b]) => full4.get(lsm)!.get(o) !== b);
        expect(changes(on, 3)).toEqual(shows.objects.map((n) => [2 + (n - 1) * 2, 0x4b]));
        expect(shows.objects.map((n) => full4.get(3)!.get(2 + (n - 1) * 2))).toEqual(shows.objects.map(() => 0x00));
        expect(changes(on, 4)).toEqual([[637, 0x40], [638, 0x0a]]);
        expect([full4.get(4)!.get(637), full4.get(4)!.get(638)]).toEqual([0x00, 0x00]);
        expect(changes(off, 3)).toEqual([]);
        expect(changes(off, 4)).toEqual([]);
        // "On" writes every byte the revert's image holds and offset 638; "off" the revert's bytes.
        expect([...on.get(4)!.keys()].filter((o) => !revert.get(4)!.has(o))).toEqual([638]);
        expect(sorted(off.get(4)!).map(([o]) => o)).toEqual(sorted(revert.get(4)!).map(([o]) => o));
      });

      // Busforge's structural flash of "on" from the unit after the full download (the full download's image, the
      // marker cleared; the unit's application read before "on" is this, byte for byte), and of "off" from the unit
      // "on" left. Its record is the one the download before leaves (read after its last LoadCompleted, before the
      // restart): for "on" ETS's last logged download, the revert, whose com-object stamp the unit still shows (the
      // download between, which has no log, is not seen); for "off" the one "on" left. The unit's stamps no longer equal it, as
      // ETS's logs find, so like ETS it writes every owned byte of the application, the com-object table whole and
      // the group tables whole. ETS's bracket, and exactly ETS's bytes with ETS's values, offset 638 left at the 10
      // "on" wrote after "off".
      const structural = (values: Map<string, string>, app: Buffer, unitComObj: Buffer, at: Map<number, number>, before: string, l: string) => {
        const record = logStamps(before).closing.map((r) => ({ ...r, written: true as const }));
        const check = stampCheck(record, l);
        expect(check.equal).toBe(false);
        const target = buildRelativeSegmentTarget(cfg, values, 4, { moduleInstances: fixture.instances, ownIdleUnionDefaults: true })!;
        const { image } = mergeRelativeTarget(app, target);
        const mcb = declaredMcbWrites(proc, target.size, "par");
        const b = build(values, fixture.links);
        const comObj = segment(b, 3);
        return withClosing(withConfirmedRestart(planRelativeStructuralFlash(4, {
          params: { image, owned: relativeParWriteSet(image, app, target.owned, mcb, check), keptAt: at.get(4)! },
          comObj: { image: comObj, owned: relativeComObjWriteSet(comObj, unitComObj, record, check), keptAt: at.get(3)! },
          addr: segment(b, 1), assoc: segment(b, 2),
        }, Buffer.from("0048493b21", "hex"), true, mcb), proc.secureEnabled), proc, "par");
      };
      const planWrites = (plan: LoadPlan, at: Map<number, number>, lsm: number) => new Map(plan.flatMap((st) =>
        st.op === "writeSegmentOwned" && st.lsm === lsm ? ownedRuns(st.image, st.owned).flatMap((r) => [...r.bytes].map((b, i) => [st.keptAt + r.offset + i, b] as [number, number]))
          : st.op === "writeSegment" && st.lsm === lsm ? [...st.bytes].map((b, i) => [at.get(lsm)! + (st.offset ?? 0) + i, b] as [number, number]) : []));
      const expectShowsForm = (plan: LoadPlan, capture: string, l: string, unit: Map<number, number>) => {
        const at = kept(capture);
        expect(systemBPlanBracket(plan)).toEqual(systemBCaptureBracket(capture, ia));
        // Busforge besides reads the load states of the three tables there, as after its full download.
        expect(closingExtras(plan)).toEqual(["assertLoaded", "assertLoaded", "assertLoaded"]);
        const ets = memoryImage(parseCapture(captureText(capture), ia).writes);
        const etsOf = (lsm: number) => sorted(offsetsToAddresses(new Map([[lsm, relImage(l).get(lsm)!]]), at));
        for (const lsm of [4, 3, 2, 1]) expect([lsm, sorted(planWrites(plan, at, lsm))]).toEqual([lsm, etsOf(lsm)]);
        expect(sorted(new Map([4, 3, 2, 1].flatMap((lsm) => [...planWrites(plan, at, lsm)])))).toEqual(sorted(ets));
        // Of the com-object table the bytes that change on the unit.
        return sorted(planWrites(plan, at, 3)).filter(([a, b]) => unit.get(a) !== b).map(([a, b]) => [a - at.get(3)!, b]);
      };

      test(`structural flash of ${shows.name} on: ETS's bracket and exactly ETS's bytes, the com-object table whole`, () => {
        const at = kept(onFile);
        const plan = structural(shown, held, segment(full, 3), at, `mix2-${p.tag}-ets6log-partial-revert.txt`, onLog);
        expect(expectShowsForm(plan, onFile, onLog, unitAt(at, held, segment(full, 3)))).toEqual(shows.objects.map((n) => [2 + (n - 1) * 2, 0x4b]));
      });

      test(`structural flash of ${shows.name} off: ETS's bracket and bytes, and offset 638 left at the 10 "on" wrote, as ETS leaves it`, () => {
        const at = kept(offFile);
        const app = mergeRelativeTarget(held, buildRelativeSegmentTarget(cfg, shown, 4, { moduleInstances: fixture.instances, ownIdleUnionDefaults: true })!).image;
        app[DOWNLOADED] &= 0x7f;
        expect([app[637], app[638]]).toEqual([0x40, 0x0a]);
        const comObj = segment(build(shown, fixture.links), 3);
        const plan = structural(params, app, comObj, at, onLog, offLog);
        expect(expectShowsForm(plan, offFile, offLog, unitAt(at, app, comObj))).toEqual(shows.objects.map((n) => [2 + (n - 1) * 2, 0x00]));
        expect(planWrites(plan, at, 4).get(at.get(4)! + 637)).toBe(0x00);
        expect(planWrites(plan, at, 4).has(at.get(4)! + 638)).toBe(false);
      });
    });
  }
});

// ETS 6 downloads of the Theben DALI-Gateway KNX plus (System B, not secured), private corpus captures/dali-*:
// a real full download after ETS unloaded the application (dali-ets-fulldownload-real.log), a partial download after
// group 16's "Time for Dimming" (P-781, offset 782) went from 10 s to 6 s, one after linking the unlinked object 458
// ("Group 16, Status") to a test group address, and one that reverted both. The configuration is the
// project's (captures/dali-gateway-unit-fulldownload.json, read before the first download), the unit held ETS's image
// throughout.
corpusDescribe("Theben DALI-Gateway KNX plus (M-0048_A-9071-20-F258-O00EF) against ETS", () => {
  const xml = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const fx = JSON.parse(captureText("dali-gateway-unit-fulldownload.json")) as {
    ia: string; params: [string, string][]; instances: ModuleInstance[]; links: { comObjNum: number; gaRaws: number[] }[]; overrides: [number, ComObjInstanceOverride][];
    segments: Record<string, { at: number; hex: string }>;
  };
  const ia = iaToNum(fx.ia);
  const TIME_FOR_DIMMING = { ref: "M-0048_A-9071-20-F258-O00EF_P-781_R-832", from: "20", to: "12", offset: 782 }; // half seconds
  const LINKED = 458;
  const PROGRAM_ID = Buffer.from("0048907120", "hex");
  const APP_AT = 0x5000;
  const build = (params: Map<string, string>, links: typeof fx.links) => classify(cfg).planFullDownload(cfg.mask, {
    ia: fx.ia, params, links, moduleInstances: fx.instances, comObjectOverrides: new Map(fx.overrides), proc,
  });
  const params = new Map(fx.params);
  const full = build(params, fx.links);
  const segment = (b: typeof full, lsm: number) => b.segments.find((s) => s.lsm === lsm)!.image;
  const asMap = (img: Buffer) => new Map(Array.from(img, (b, i) => [i, b] as [number, number]));
  const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);
  const unit = (lsm: number) => Buffer.from(fx.segments[lsm].hex, "hex");
  // The test group address the links download added: the one address of its image's table no project link uses.
  const withLink = [...fx.links, { comObjNum: LINKED, gaRaws: [addedGa(tableGas((o) => relImage("dali-ets6log-partial-links.txt").get(1)!.get(o), "systemB"), fx.links)] }];
  // ETS switches the unit into verify mode (object 0 PID 14 = 04) before its first memory write; Busforge's full
  // download does the same (its verifyMode step), its partial flashes read each write back (withoutVerifyMode above).
  const etsBracket = (file: string) => systemBCaptureBracket(file, ia).filter((st) => st !== "prop 0/14");

  test("the configuration is the project's: the parameter changed is at ETS's value before it, the object unlinked", () => {
    expect(buildDeviceConfig(cfg, params, undefined, fx.instances).imageValues.get(TIME_FOR_DIMMING.ref)).toBe(TIME_FOR_DIMMING.from);
    expect(fx.links.some((l) => l.comObjNum === LINKED)).toBe(false);
  });

  // ETS's image (its log, RelMemory(4) row 0C40, l. 581) holds the admin password P-817 as "dali" and four zero bytes.
  // Of the application segment it lists the bytes some parameter covers, which are exactly the bytes Busforge's image
  // owns; the 143 others ("--") keep the allocation's fill 0, which Busforge's image holds there.
  test("full download: Busforge's four segments are ETS's image, byte for byte, the admin password's text included", () => {
    const ets = relImage("dali-ets6log-fulldownload-real.txt");
    for (const lsm of [3, 2, 1]) expect([lsm, sorted(asMap(segment(full, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
    const target = buildRelativeSegmentTarget(cfg, params, 4, { moduleInstances: fx.instances, ownIdleUnionDefaults: true })!;
    const owned = new Map([...asMap(segment(full, 4))].filter(([o]) => target.owned[o]));
    expect(sorted(owned)).toEqual(sorted(ets.get(4)!));
    expect([...asMap(segment(full, 4))].filter(([o, b]) => !target.owned[o] && b !== 0)).toEqual([]);
    expect(segment(full, 4).subarray(3144, 3152).toString("hex")).toBe("64616c6900000000");
  });

  // On the wire both sides write the tables whole and, of the application, its image's bytes but the fill-0 bytes at
  // its start and end ("System B full download: the bytes ETS writes, and no other").
  test("full download: every byte ETS wrote on the wire is Busforge's, the rest is the fill, and the unit held this image before", () => {
    const cap = parseCapture(captureText("dali-ets-fulldownload-real.log"), ia);
    const refs = reportedTableReferences(cap);
    const r = compareSegments(full.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.divergences.length])).toEqual([[4, 0], [3, 0], [2, 0], [1, 0]]);
    expect(r.unattributed).toEqual([]);
    const wire = memoryImage(cap.writes);
    const ours = new Map<number, number>();
    for (const st of full.plan) if (st.op === "writeSegment") st.bytes.forEach((b, i) => ours.set(refs.get(st.lsm)! + (st.offset ?? 0) + i, b));
    expect([...wire].filter(([a, b]) => ours.has(a) && ours.get(a) !== b)).toEqual([]);
    expect([...wire].filter(([a]) => !ours.has(a))).toEqual([]);
    expect([...ours].filter(([a]) => !wire.has(a))).toEqual([]);
    for (const lsm of [4, 3, 2, 1]) expect([lsm, segment(full, lsm).equals(unit(lsm))]).toEqual([lsm, true]);
  });

  test("full download: ETS's bracket, the PEI program unloaded first, the application allocated with fill 0, the plain restart", () => {
    const ets = etsBracket("dali-ets-fulldownload-real.log");
    expect(systemBCaptureBracket("dali-ets-fulldownload-real.log", ia).filter((st) => st === "prop 0/14")).toEqual(["prop 0/14"]);
    expect(full.plan.filter((st) => st.op === "verifyMode" && st.on).length).toBe(1);
    expect(systemBPlanBracket(full.plan)).toEqual(ets);
    expect(ets.slice(0, 5)).toEqual(["unload:5", "unload:4", "unload:3", "unload:2", "unload:1"]);
    expect(ets).toContain("alloc:4:3152:1:0");
    expect(ets.at(-1)).toBe("restart:80");
  });

  const held = segment(full, 4);
  const parFlash = (values: Map<string, string>, current: Buffer) => {
    const target = buildRelativeSegmentTarget(cfg, values, 4, { moduleInstances: fx.instances, ownIdleUnionDefaults: true })!;
    const { image } = mergeRelativeTarget(current, target);
    const ours = new Map<number, number>();
    for (const r of ownedRuns(image, target.owned)) r.bytes.forEach((b, i) => ours.set(r.offset + i, b));
    const plan = withClosing(withConfirmedRestart(planRelativeParFlash(4, image, target.owned, APP_AT, PROGRAM_ID, true, declaredMcbWrites(proc, target.size, "par")), proc.secureEnabled), proc, "par");
    return { ours, image, plan };
  };
  const changed = new Map(params).set(TIME_FOR_DIMMING.ref, TIME_FOR_DIMMING.to);

  // ETS's parameter download is differential (PreferPartialDownloadIfApplicationLoaded; dali-ets6log-partial-params.txt:
  // "removed 3008 identical bytes"): of its 3009 owned bytes it writes the one that differs from its record of the unit,
  // 0x530E = 0C (dali-ets-partial-params.log). Busforge's parameter flash without a record writes every owned byte, all
  // but that one with the unit's value; with ETS's record it writes ETS's byte ("the stamp record" below).
  test("parameter flash: the byte ETS changes, with its value, the others as the unit holds them, in ETS's bracket", () => {
    const { ours, plan } = parFlash(changed, held);
    const ets = relImage("dali-ets6log-partial-params.txt").get(4)!;
    expect(sorted(ets)).toEqual([[TIME_FOR_DIMMING.offset, 12]]);
    expect([...ours].filter(([o, b]) => held[o] !== b)).toEqual(sorted(ets));
    const wire = memoryImage(parseCapture(captureText("dali-ets-partial-params.log"), ia).writes);
    expect(sorted(wire)).toEqual([[APP_AT + TIME_FOR_DIMMING.offset, 12]]);
    expect(systemBPlanBracket(plan)).toEqual(etsBracket("dali-ets-partial-params.log"));
  });

  test("group-address flash: ETS's tables and com-object table, in ETS's bracket", () => {
    const linked = build(params, withLink);
    const ets = relImage("dali-ets6log-partial-links.txt");
    for (const lsm of [3, 2, 1]) expect([lsm, sorted(asMap(segment(linked, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
    const plan = withClosing(withConfirmedRestart(planSystemBGaFlash({ addr: segment(linked, 1), assoc: segment(linked, 2), comObj: segment(linked, 3) }, true, false), proc.secureEnabled), proc, "grp");
    expect(systemBPlanBracket(plan)).toEqual(etsBracket("dali-ets-partial-links.log"));
  });

  // ETS reverts both changes in one partial download, one bracket over all four objects; Busforge reverts them with its
  // parameter flash and its group-address flash (bytes here) or with its structural flash (next test).
  // ETS's revert is differential as well ("removed 3008 identical bytes"): 0x530E = 14 back.
  test("revert: the parameter byte and the tables ETS's revert holds", () => {
    const before = parFlash(changed, held).image;
    const { ours } = parFlash(params, before);
    const ets = relImage("dali-ets6log-partial-revert.txt");
    expect(sorted(ets.get(4)!)).toEqual([[TIME_FOR_DIMMING.offset, held[TIME_FOR_DIMMING.offset]]]);
    expect([...ours].filter(([o, b]) => before[o] !== b)).toEqual(sorted(ets.get(4)!));
    for (const lsm of [3, 2, 1]) expect([lsm, sorted(asMap(segment(full, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
  });

  // Its record is that of its parameter flash (the application written), which the unit's stamps equal: ETS's revert
  // is differential, and both write the one parameter byte back and the com-object table whole (the record's download
  // did not write it, and its region's CRC control is 1).
  test("structural flash of the revert: ETS's bracket, and exactly the bytes of ETS's revert", () => {
    const unitParams = parFlash(changed, held).image;
    const unitComObj = segment(build(params, withLink), 3);
    const target = buildRelativeSegmentTarget(cfg, params, 4, { moduleInstances: fx.instances, ownIdleUnionDefaults: true })!;
    const { image } = mergeRelativeTarget(unitParams, target);
    const comObj = segment(full, 3);
    const mcb = declaredMcbWrites(proc, target.size, "par");
    const record = logStamps("dali-ets6log-partial-params.txt").closing.map((r) => (r.obj === 4 ? { ...r, written: true as const } : r));
    const check = stampCheck(record, "dali-ets6log-partial-revert.txt");
    expect(check.equal).toBe(true);
    const plan = withClosing(withConfirmedRestart(planRelativeStructuralFlash(4, {
      params: { image, owned: relativeParWriteSet(image, unitParams, target.owned, mcb, check), keptAt: APP_AT },
      comObj: { image: comObj, owned: relativeComObjWriteSet(comObj, unitComObj, record, check), keptAt: 0x4000 },
      addr: segment(full, 1), assoc: segment(full, 2),
    }, PROGRAM_ID, true, mcb), proc.secureEnabled), proc, "par");
    expect(systemBPlanBracket(plan)).toEqual(etsBracket("dali-ets-partial-revert.log"));
    const ets = relImage("dali-ets6log-partial-revert.txt");
    const written = (lsm: number) => new Map(plan.flatMap((st) => (st.op === "writeSegmentOwned" && st.lsm === lsm
      ? ownedRuns(st.image, st.owned).flatMap((r) => [...r.bytes].map((b, i) => [r.offset + i, b] as [number, number])) : [])));
    for (const lsm of [4, 3]) expect([lsm, sorted(written(lsm))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
    const whole = (lsm: number) => plan.flatMap((st) => (st.op === "writeSegment" && st.lsm === lsm ? [asMap(st.bytes)] : []));
    for (const lsm of [2, 1]) expect([lsm, whole(lsm).map(sorted)]).toEqual([lsm, [sorted(ets.get(lsm)!)]]);
  });
});

// ETS 6 downloads of the MEAN WELL KNX-40E-1280D power supply (M-0162_A-0004-11-F245, MV-07B0, System B, MergedProcedure,
// not secured), private corpus captures/meanwell-*, each with ETS's own log, in this order: a partial
// download after linking the unlinked object 2 ("Power supply on") to a test group address; one after P-29
// "Maximum Tracking Period" (offset 66, 16 bit) went from 1800 s to 1810 s; one that reverted both; a full download
// ("Application program"). The configuration is the project's (captures/meanwell-project.json); what the unit held
// before the first is its collect (captures/meanwell-unit-collect-vor.json), after the last
// captures/meanwell-unit-collect-nach-ets-full.json. The unit kept its four segments at the same addresses throughout
// (ETS's PID 7 reads).
corpusDescribe("MEAN WELL KNX-40E-1280D (M-0162_A-0004-11-F245) against ETS", () => {
  const xml = catalogueXml("M-0162_A-0004-11-F245.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const fx = JSON.parse(captureText("meanwell-project.json")) as { ia: string; params: [string, string][]; links: { comObjNum: number; gaRaws: number[] }[] };
  const ia = iaToNum(fx.ia);
  const MAX_TRACKING = { ref: "M-0162_A-0004-11-F245_P-29_R-29", from: "1800", to: "1810", offset: 66 };
  const LINKED = 2;
  const PROGRAM_ID = Buffer.from("0162000411", "hex");
  const AT: Record<number, number> = { 1: 0x1002, 2: 0x1404, 3: 0x1c06, 4: 0x1c50 };
  const file = (kind: string) => `meanwell-ets-${kind}.log`;
  const log = (kind: string) => `meanwell-ets6log-${kind}.txt`;
  const KINDS = ["links", "params", "revert", "fulldownload"];
  type CollectRecord = { step: string; space: string; target: { object?: number; pid?: number; start?: number; address?: number }; bytes?: string };
  const collect = (f: string) => (JSON.parse(captureText(f)) as { records: CollectRecord[] }).records;
  const unitSegment = (f: string, lsm: number) => Buffer.from(collect(f).find((r) => r.space === "memory" && r.target.address === AT[lsm])!.bytes!, "hex");
  // The unit's memory-control-block element 1 of each object as its collect read it.
  const unitStamps = (f: string): ImageStamp[] => [1, 2, 3, 4].map((obj) => ({ obj, element: 1, hex: collect(f).find((r) => r.space === "property" && r.target.object === obj && r.target.pid === 27 && r.target.start === 1)!.bytes! }));
  const build = (params: Map<string, string>, links: typeof fx.links) => classify(cfg).planFullDownload(cfg.mask, { ia: fx.ia, params, links, proc });
  const params = new Map(fx.params);
  const full = build(params, fx.links);
  // The test group address the links download added: the one address of its image's table no project link uses.
  const TEST_GA = addedGa(tableGas((o) => relImage(log("links")).get(1)!.get(o), "systemB"), fx.links);
  const withLink = [...fx.links, { comObjNum: LINKED, gaRaws: [TEST_GA] }];
  const linked = build(params, withLink);
  const changed = new Map(params).set(MAX_TRACKING.ref, MAX_TRACKING.to);
  const segment = (b: typeof full, lsm: number) => b.segments.find((s) => s.lsm === lsm)!.image;
  const asMap = (img: Buffer) => new Map(Array.from(img, (b, i) => [i, b] as [number, number]));
  const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);
  const wire = (kind: string) => memoryImage(parseCapture(captureText(file(kind)), ia).writes);
  // The bytes a plan writes, by address: each segment where the unit keeps it, a kept segment's owned runs.
  const planBytes = (plan: LoadPlan) => {
    const m = new Map<number, number>();
    for (const st of plan) {
      if (st.op === "writeSegment") st.bytes.forEach((b, i) => m.set(AT[st.lsm] + (st.offset ?? 0) + i, b));
      if (st.op === "writeSegmentOwned") {
        expect(st.keptAt).toBe(AT[st.lsm]);
        for (const r of ownedRuns(st.image, st.owned)) r.bytes.forEach((b, i) => m.set(AT[st.lsm] + r.offset + i, b));
      }
    }
    return m;
  };
  // ETS switches the unit into verify mode (object 0 PID 14) before its first memory write; Busforge's full download does
  // the same (its verifyMode step), its partial flashes read each write back.
  const etsBracket = (kind: string) => systemBCaptureBracket(file(kind), ia).filter((st) => st !== "prop 0/14");
  const parFlash = (values: Map<string, string>, current: Buffer, record?: { before: string; file: string }) => {
    const target = buildRelativeSegmentTarget(cfg, values, 4, { ownIdleUnionDefaults: true })!;
    const { image } = mergeRelativeTarget(current, target);
    const mcb = declaredMcbWrites(proc, target.size, "par");
    const owned = record ? relativeParWriteSet(image, current, target.owned, mcb, stampCheck(logStamps(record.before).closing, record.file)) : target.owned;
    const plan = withClosing(withConfirmedRestart(planRelativeParFlash(4, image, owned, AT[4], PROGRAM_ID, true, mcb), proc.secureEnabled), proc, "par");
    return { image, plan };
  };
  // Busforge's group-address flash: the tables of `b`, the com-object table into the one the unit holds (`unitComObj`),
  // with the bytes relativeComObjWriteSet selects from the stamp record and its check.
  const gaFlash = (b: typeof full, unitComObj: Buffer, record?: ImageStamp[], check: { equal: boolean; read: ImageStamp[] } | null = null) => {
    const comObj = segment(b, 3);
    return withClosing(withConfirmedRestart(planSystemBGaFlash({
      addr: segment(b, 1), assoc: segment(b, 2), comObj,
      comObjKept: { owned: relativeComObjWriteSet(comObj, unitComObj, record, check), keptAt: AT[3] },
    }, true, false), proc.secureEnabled), proc, "grp");
  };
  // The unit after each download, by segment.
  const unitApp = unitSegment("meanwell-unit-collect-vor.json", 4);
  const unitComObj = unitSegment("meanwell-unit-collect-vor.json", 3);
  const afterParams = parFlash(changed, unitApp).image;

  test("the configuration is the project's: the parameter changed at ETS's value before it, objects 2 to 6 unlinked", () => {
    expect(buildDeviceConfig(cfg, params).imageValues.get(MAX_TRACKING.ref)).toBe(MAX_TRACKING.from);
    expect(fx.links.map((l) => l.comObjNum)).toEqual([11, 13, 15, 16, 19, 20]);
    for (const kind of KINDS) {
      const refs = [...reportedTableReferences(parseCapture(captureText(file(kind)), ia))];
      expect([kind, refs.length > 0, refs.filter(([lsm, at]) => AT[lsm] !== at)]).toEqual([kind, true, []]);
    }
  });

  // ETS's image of the full download (its log, RelMemory(1) to (4)) holds the tables whole and the application segment
  // whole (the segment declares <Data>), and it is what the unit held before the four downloads.
  test("full download: Busforge's four segments are ETS's image, byte for byte, and what the unit held before", () => {
    const ets = relImage(log("fulldownload"));
    for (const lsm of [4, 3, 2, 1]) expect([lsm, sorted(asMap(segment(full, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
    for (const lsm of [4, 3, 2, 1]) expect([lsm, segment(full, lsm).equals(unitSegment("meanwell-unit-collect-vor.json", lsm))]).toEqual([lsm, true]);
    expect(segment(full, 4).readUInt16BE(MAX_TRACKING.offset)).toBe(1800);
  });

  test("full download: every byte ETS wrote on the wire is Busforge's, the rest is the fill", () => {
    const cap = parseCapture(captureText(file("fulldownload")), ia);
    const r = compareSegments(full.segments.map((seg) => ({ seg, address: AT[seg.lsm], baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.divergences.length])).toEqual([[4, 0], [3, 0], [2, 0], [1, 0]]);
    expect(r.unattributed).toEqual([]);
    expect(sorted(planBytes(full.plan))).toEqual(sorted(wire("fulldownload")));
  });

  test("full download: ETS's bracket, the PEI program unloaded first, the application allocated with fill 0, the plain restart", () => {
    const ets = etsBracket("fulldownload");
    expect(systemBCaptureBracket(file("fulldownload"), ia).filter((st) => st === "prop 0/14")).toEqual(["prop 0/14"]);
    expect(full.plan.filter((st) => st.op === "verifyMode" && st.on).length).toBe(1);
    expect(systemBPlanBracket(full.plan)).toEqual(ets);
    expect(ets.slice(0, 5)).toEqual(["unload:5", "unload:4", "unload:3", "unload:2", "unload:1"]);
    expect(ets).toContain("alloc:4:212:1:0");
    expect(ets.slice(-5)).toEqual(["read:1/27:1:1", "read:2/27:1:1", "read:3/27:1:1", "read:4/27:1:1", "restart:80"]);
  });

  // The two parameters of the hidden block "PropertySetting" sit in properties, not in memory: P-42 in object 0 PID 78, P-115
  // in object 0 PID 25. ETS reads both before every download, lists them in its image (PID 25 at the parameter's 0x1040
  // where the unit answers 0x1044) and writes neither; no Busforge plan writes them.
  test("the property parameters (object 0 PID 25 and 78): ETS reads them and writes neither, and no Busforge plan writes them", () => {
    const propsTo = (kind: string, apci: number) => captureText(file(kind)).split("\n").flatMap((l) => {
      const m = l.includes("ETS->BRIDGE") ? l.match(/\| ([0-9a-fA-F]+)\s*$/) : null;
      const fr = m ? parseTunnelFrame(m[1]) : null;
      if (!fr || fr.group || fr.dst !== ia || fr.tpdu.length < 4) return [];
      const t = fr.tpdu;
      return (((t[0] & 0x03) << 8) | t[1]) === apci && t[2] === 0 && (t[3] === 25 || t[3] === 78) ? [`0/${t[3]}`] : [];
    });
    for (const kind of KINDS) {
      expect([kind, propsTo(kind, 0x3d5)]).toEqual([kind, ["0/25", "0/78"]]);
      expect([kind, propsTo(kind, 0x3d7)]).toEqual([kind, []]);
    }
    expect(captureText(log("fulldownload"))).toContain("SystemProperty(0/25)[$0000-$0001]:");
    const plans = [full.plan, parFlash(changed, unitApp).plan, gaFlash(linked, unitComObj)];
    expect(plans.flatMap((p) => p.filter((st) => (st.op === "writeProp" || st.op === "readProp") && st.obj === 0 && (st.pid === 25 || st.pid === 78)))).toEqual([]);
  });

  // ETS's parameter download falls back from its differential form ("Differential Image Stamp does not match"): the group-
  // address download before it changed the com-object table's stamp. So it writes every byte a parameter owns, as
  // Busforge's parameter flash does without a record, and the changed byte among them.
  test("parameter flash: exactly the bytes of ETS's parameter download, with its values, in ETS's bracket", () => {
    const { plan } = parFlash(changed, unitApp);
    expect(captureText(log("params"))).toContain("Differential Image Stamp does not match, falling back to partial download");
    const ours = planBytes(plan);
    expect(sorted(ours)).toEqual(sorted(wire("params")));
    expect(sorted(new Map([...relImage(log("params")).get(4)!].map(([o, b]) => [AT[4] + o, b])))).toEqual(sorted(ours));
    expect([...ours].filter(([a, b]) => unitApp[a - AT[4]] !== b)).toEqual([[AT[4] + MAX_TRACKING.offset + 1, 0x12]]);
    expect(systemBPlanBracket(plan)).toEqual(etsBracket("params"));
    expect(etsBracket("params")[0]).toBe("unload:4");
  });

  // ETS's group-address download is differential ("removed 73 identical bytes"): its stamps of the application and the
  // com-object table equal its record, and of the com-object table (one memory-control-block region, CRC control 0) it
  // writes the one byte that differs, object 2's flags with the communication bit; the group tables whole. Busforge's
  // group-address flash decides the same on its record (relativeComObjWriteSet). ETS's record of the unit's last
  // parameter-writing download predates the captures; the unit's stamps before them stand for it, as they equal what ETS
  // read before this download, and that download wrote the com-object table (ETS's differential removed 73 of its bytes,
  // so its image held them: a full download's record).
  test("group-address flash: ETS's tables, the one com-object byte ETS writes with the record, in ETS's bracket", () => {
    const ets = relImage(log("links"));
    for (const lsm of [2, 1]) expect([lsm, sorted(asMap(segment(linked, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
    expect(sorted(ets.get(3)!)).toEqual([[4, 0x4f]]);
    expect(etsLog(log("links")).removed).toBe(73);
    const record = unitStamps("meanwell-unit-collect-vor.json").map((r) => ({ ...r, written: true as const }));
    const check = stampCheck(record, log("links"));
    expect(check.equal).toBe(true);
    const plan = gaFlash(linked, unitComObj, record, check);
    expect(sorted(planBytes(plan))).toEqual(sorted(wire("links")));
    expect(systemBPlanBracket(plan)).toEqual(etsBracket("links"));
    // Without a record, with one the unit's stamps do not equal, or with one of a download that did not write the table,
    // the table goes whole: ETS's form when its stamps do not match (Theben MIX 2, "the stamp record" below) and in the
    // revert below.
    for (const r of [undefined, record.map((x) => (x.obj === 3 ? { obj: x.obj, element: x.element, hex: x.hex } : x))]) expect(planBytes(gaFlash(linked, unitComObj, r, check)).size).toBe(74 + 30 + 16);
    const whole = planBytes(gaFlash(linked, unitComObj));
    expect(sorted(new Map([...whole].filter(([a]) => a >= AT[3] && a < AT[3] + 74)))).toEqual(sorted(new Map([...asMap(segment(linked, 3))].map(([o, b]) => [AT[3] + o, b]))));
  });

  // ETS reverts both changes in one partial download, one bracket over all four objects, differential again ("removed 162
  // identical bytes"): of the application the one byte back (0x08 at offset 67), the com-object table whole, the group
  // tables whole at their old length. ETS's differential compares with its image of the download its record comes from,
  // the parameter download, which held nothing of the com-object table. Busforge reverts them with its parameter flash
  // and its group-address flash, each with the record of that parameter download: the application's one byte, and the
  // com-object table whole (the record's download did not write it), as ETS writes them.
  test("revert: the parameter byte, the tables and the com-object table of ETS's revert", () => {
    const record = { before: log("params"), file: log("revert") };
    const ets = relImage(log("revert"));
    expect(etsLog(log("revert")).removed).toBe(162);
    const par = planBytes(parFlash(params, afterParams, record).plan);
    expect(sorted(par)).toEqual([[AT[4] + MAX_TRACKING.offset + 1, 0x08]]);
    expect(sorted(par)).toEqual(sorted(new Map([...wire("revert")].filter(([a]) => a >= AT[4]))));
    for (const lsm of [2, 1]) expect([lsm, sorted(asMap(segment(full, lsm)))]).toEqual([lsm, sorted(ets.get(lsm)!)]);
    expect([3, sorted(ets.get(3)!)]).toEqual([3, sorted(asMap(segment(full, 3)))]);
    // A Busforge parameter flash's record marks only the application's segment written.
    const parRecord = logStamps(record.before).closing.map((r) => (r.obj === 4 ? { ...r, written: true as const } : r));
    const check = stampCheck(parRecord, record.file);
    expect(check.equal).toBe(true);
    const ga = planBytes(gaFlash(full, segment(linked, 3), parRecord, check));
    expect(sorted(new Map([...ga, ...par]))).toEqual(sorted(wire("revert")));
  });

  // The same revert as Busforge's structural flash, from the unit ETS's parameter and group-address downloads left: ETS's
  // bracket, and its bytes. Its record is that of its parameter flash, which the unit's stamps equal: the one parameter
  // byte back, the com-object table whole (the record's download did not write it), the group tables whole, as ETS writes them.
  test("structural flash of the revert: ETS's bracket, and exactly the bytes of ETS's revert", () => {
    const target = buildRelativeSegmentTarget(cfg, params, 4, { ownIdleUnionDefaults: true })!;
    const { image } = mergeRelativeTarget(afterParams, target);
    const comObj = segment(full, 3);
    const unitLinkedComObj = segment(linked, 3);
    const mcb = declaredMcbWrites(proc, target.size, "par");
    const record = logStamps(log("params")).closing.map((r) => (r.obj === 4 ? { ...r, written: true as const } : r));
    const check = stampCheck(record, log("revert"));
    expect(check.equal).toBe(true);
    const plan = withClosing(withConfirmedRestart(planRelativeStructuralFlash(4, {
      params: { image, owned: relativeParWriteSet(image, afterParams, target.owned, mcb, check), keptAt: AT[4] },
      comObj: { image: comObj, owned: relativeComObjWriteSet(comObj, unitLinkedComObj, record, check), keptAt: AT[3] },
      addr: segment(full, 1), assoc: segment(full, 2),
    }, PROGRAM_ID, true, mcb), proc.secureEnabled), proc, "par");
    expect(systemBPlanBracket(plan)).toEqual(etsBracket("revert"));
    expect(sorted(planBytes(plan))).toEqual(sorted(wire("revert")));
  });

  // ETS's group-address download wrote seven entries; its revert and its full download write the six the configuration
  // holds and leave the seventh behind the active length, which the unit's collect after the full download shows (the
  // tables' PID 23). Busforge's group-address flash and full download write the same lengths.
  test("a table that shrinks leaves its old bytes behind it, in ETS's downloads and in Busforge's", () => {
    const behind = [0x1010, 0x1011, 0x141e, 0x141f, 0x1420, 0x1421];
    expect(behind.map((a) => wire("links").get(a))).toEqual([TEST_GA >> 8, TEST_GA & 0xff, 0x00, 0x06, 0x00, 0x14]);
    for (const kind of ["revert", "fulldownload"]) expect([kind, behind.filter((a) => wire(kind).has(a))]).toEqual([kind, []]);
    const ours = [...planBytes(full.plan).keys(), ...planBytes(gaFlash(full, segment(linked, 3))).keys()];
    expect(behind.filter((a) => ours.includes(a))).toEqual([]);
    const pid23 = (obj: number) => collect("meanwell-unit-collect-nach-ets-full.json").find((r) => r.space === "property" && r.target.object === obj && r.target.pid === 23 && r.target.start === 2)!.bytes!;
    expect(pid23(1).slice(5 * 4, 6 * 4)).toBe(TEST_GA.toString(16).padStart(4, "0"));
    expect(pid23(2).slice(5 * 8, 6 * 8)).toBe("00060014");
  });

  // The association table of every plan above maps group addresses onto the linked objects only; object 6 ("Bus reset")
  // switches the bus voltage off on a telegram, and objects 3 to 6 are unlinked in the project.
  test("no plan associates a group address with objects 3 to 6", () => {
    const objects = (assoc: Buffer) => Array.from({ length: assoc.readUInt16BE(0) }, (_, k) => assoc.readUInt16BE(2 + k * 4 + 2));
    expect(objects(segment(full, 2))).toEqual([11, 13, 15, 16, 19, 20]);
    expect(objects(segment(linked, 2))).toEqual([2, 11, 13, 15, 16, 19, 20]);
    for (const kind of ["links", "revert", "fulldownload"]) {
      const at = wire(kind);
      const assoc = Buffer.from(Array.from({ length: 2 + 4 * at.get(AT[2] + 1)! }, (_, i) => at.get(AT[2] + i)!));
      expect([kind, objects(assoc).filter((o) => o >= 3 && o <= 6)]).toEqual([kind, []]);
    }
  });
});

// ETS 6 downloads of the MDT IP Interface/Router with e-mail and time server (M-0083_A-0137, System B, Data Secure),
// private corpus captures/mdt-router-*: a full download of the application (the project had never loaded it into the
// unit), a partial download without a change, one after the device name P-162 went from its 30-character default to a
// shorter one beginning with the same "MDT ", and one that set it back. The tunnel's frames are encrypted; ETS's own log holds
// its image of each download and every telegram it sent inside the secured ones. The configuration is the project's
// (captures/mdt-router-unit-config.json).
corpusDescribe("MDT IP Interface/Router (M-0083_A-0137-20-7EB2) against ETS", () => {
  const xml = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const fx = JSON.parse(captureText("mdt-router-unit-config.json")) as { params: [string, string][] };
  const A = "M-0083_A-0137-20-7EB2";
  const DEFAULT_NAME = "MDT IP Interface mit IPRouting";
  // The shorter name: "MDT " and the text ETS wrote from the field's fifth byte up to its first zero byte.
  const shortName = () => {
    const written = Buffer.from([...relImage("mdt-router-ets6log-partial-name.txt").get(4)!].sort(([a], [b]) => a - b).map(([, b]) => b)).toString("latin1");
    return DEFAULT_NAME.slice(0, 4) + written.slice(0, written.indexOf("\0"));
  };
  const NAME = { ref: `${A}_P-162_R-162`, offset: 71, size: 30, ets: DEFAULT_NAME };
  const params = new Map(fx.params);
  const target = (values: Map<string, string>) => buildRelativeSegmentTarget(cfg, values, 4, { ownIdleUnionDefaults: true })!;
  const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);
  const full = target(params);
  // The memory writes ETS sent inside its secured telegrams, one per telegram.
  const innerWriteList = (file: string) => captureText(file).split(/\r?\n/).flatMap((l) => {
    const m = l.match(/Sending Sec_req .*InnerTelegram=MemoryExtended_Write_req -> [\d.]+ \([^)]*\) Address=\$([0-9A-F]+) Count=\d+ Data=([0-9A-F]+)/);
    return m ? [{ addr: Number.parseInt(m[1], 16), data: Buffer.from(m[2], "hex"), service: "A_MemoryExtended_Write" as const }] : [];
  });
  const innerWrites = (file: string) => memoryImage(innerWriteList(file));
  // ETS's load controls as the bracket strings of systemBPlanBracket. The reads ETS adds to a parameter download
  // (object 4 PID 7 before the allocation and its compare after it) are reads, as in the Theben captures, and
  // Busforge leaves them out; the PID 27 reads after the last LoadCompleted are in both.
  const logBracket = (file: string) => etsLog(file).steps.flatMap((s): string[] => {
    const a = s.attrs;
    if (a.ObjType !== undefined) return [];
    if (s.verb === "LdCtrlUnload") return [`unload:${a.LsmIdx}`];
    if (s.verb === "LdCtrlLoad") return [`load:${a.LsmIdx}`];
    if (s.verb === "LdCtrlLoadCompleted") return [`loadCompleted:${a.LsmIdx}`];
    if (s.verb === "LdCtrlRelSegment") return [`alloc:${a.LsmIdx}:${a.Size}:${a.Mode}:${a.Mode === "1" ? a.Fill : 0}`];
    if (s.verb === "LdCtrlWriteProp" && a.ObjIdx === "4" && a.PropId === "13") return [`stamp:${a.InlineData.toLowerCase()}`];
    if (s.verb === "LdCtrlLoadImageProp" && a.PropId === "27") return [`read:${a.ObjIdx}/27:1:1`];
    if (s.verb === "LdCtrlMasterReset") return [`restart:${a.EraseCode === "1" ? "810100" : "80"}`];
    return [];
  });
  const parFlash = (values: Map<string, string>, current: Buffer) => {
    const t = target(values);
    const { image } = mergeRelativeTarget(current, t);
    const plan = withClosing(withConfirmedRestart(planRelativeParFlash(4, image, t.owned, 0, Buffer.from("0083013720", "hex"), true, declaredMcbWrites(proc, t.size, "par")), proc.secureEnabled), proc, "par");
    return { image, plan };
  };
  const changed = (image: Buffer, held: Buffer) => new Map([...image].map((b, i) => [i, b] as [number, number]).filter(([i, b]) => held[i] !== b));

  test("the configuration is the project's: the device name at its default, four inactive parameters holding other values", () => {
    const active = buildDeviceConfig(cfg, params).imageValues;
    expect(active.get(NAME.ref)).toBe(NAME.ets);
    for (const p of ["P-315_R-315", "P-15_R-36", "P-2_R-2", "P-205_R-205"]) expect([p, active.has(`${A}_${p}`), params.has(`${A}_${p}`)]).toEqual([p, false, true]);
  });

  // ETS's image (mdt-router-ets6log-fulldownload.txt, RelMemory(4)) lists all 3972 bytes of the application segment.
  // Every text field holds its value and zero bytes over whatever <Data> holds there, the 30-character device name
  // without a closing zero; inactive parameters hold their parameter default, not the value the project still stores.
  test("full download: Busforge's application segment is ETS's image, byte for byte", () => {
    const ets = relImage("mdt-router-ets6log-fulldownload.txt").get(4)!;
    expect(ets.size).toBe(full.size);
    expect(sorted(new Map([...full.bytes].map((b, i) => [i, b] as [number, number])))).toEqual(sorted(ets));
    expect(Buffer.from(full.bytes.subarray(NAME.offset, NAME.offset + NAME.size)).toString("latin1")).toBe(NAME.ets);
    expect(cfg.segments[0].data.subarray(1194, 1209).toString("latin1")).toBe("Statuselement00");
    expect(full.bytes.subarray(1194, 1224).every((b) => b === 0)).toBe(true);
    expect([full.bytes[122] & 0x80, full.bytes[2692] & 0x80, Buffer.from(full.bytes.subarray(124, 135)).toString("latin1")]).toEqual([0, 0, "Bit Alarm 1"]);
  });

  // ETS writes the non-zero bytes of its image and leaves the zeros it can to the allocation's fill (Mode 1, fill 0).
  test("full download: every byte ETS sent into the segment is Busforge's, the rest of Busforge's image is the fill", () => {
    const wire = innerWrites("mdt-router-ets6log-fulldownload.txt");
    const at = inferBase(full.bytes, innerWriteList("mdt-router-ets6log-fulldownload.txt"))!;
    expect(at).toBe(0x14ea);
    const seg = new Map([...wire].filter(([a]) => a >= at && a < at + full.size).map(([a, b]) => [a - at, b] as [number, number]));
    expect([...seg].filter(([o, b]) => full.bytes[o] !== b)).toEqual([]);
    expect([...full.bytes].map((b, o) => [o, b]).filter(([o, b]) => !seg.has(o) && b !== 0)).toEqual([]);
    expect(logBracket("mdt-router-ets6log-fulldownload.txt")).toContain("alloc:4:3972:1:0");
  });

  // The web interface password P-278 (20 bytes at offset 40) reads back FF after any write. ETS's full download writes
  // it from the project, as every other field; its parameter downloads leave it alone, as its record holds it. A unit
  // holding the project's configuration reads FF there, so Busforge's parameter flash counts those 20 bytes and its
  // dry run names them (FlashResult.readsFF), every one of them and nothing else.
  test("the web interface password: ETS's full download writes it from the project; a unit reading it as FF differs there alone, named", () => {
    const PW = { offset: 40, size: 20 };
    const ets = relImage("mdt-router-ets6log-fulldownload.txt").get(4)!;
    const field = Array.from({ length: PW.size }, (_, i) => PW.offset + i);
    expect(field.map((o) => ets.get(o))).toEqual(field.map((o) => full.bytes[o]));
    const at = 0x14ea;
    const wire = innerWrites("mdt-router-ets6log-fulldownload.txt");
    expect(field.filter((o) => full.bytes[o] !== 0).map((o) => wire.get(at + o))).toEqual(field.filter((o) => full.bytes[o] !== 0).map((o) => full.bytes[o]));
    expect(field.some((o) => full.bytes[o] !== 0)).toBe(true);
    for (const file of ["mdt-router-ets6log-partial-name.txt", "mdt-router-ets6log-partial-name-revert.txt"]) {
      expect([file, [...relImage(file).get(4)!.keys()].filter((o) => o >= PW.offset && o < PW.offset + PW.size)]).toEqual([file, []]);
    }
    const unit = Buffer.from(full.bytes);
    unit.fill(0xff, PW.offset, PW.offset + PW.size);
    const { image, diffBytes } = mergeRelativeTarget(unit, full);
    expect(diffBytes).toBe(PW.size);
    expect(differingFF(unit, image, full, at)).toEqual([{ address: at + PW.offset, length: PW.size }]);
  });

  test("a partial download without a change sends nothing; Busforge's flash of the same configuration changes no byte", () => {
    expect(etsLog("mdt-router-ets6log-partial-nochange.txt").steps).toEqual([]);
    expect(innerWrites("mdt-router-ets6log-partial-nochange.txt").size).toBe(0);
    expect(changed(parFlash(params, full.bytes).image, full.bytes).size).toBe(0);
  });

  // ETS's parameter download is differential (PreferPartialDownloadIfApplicationLoaded; "removed 2593 identical bytes"):
  // it writes the bytes that differ from its record of the unit, here one telegram at the field's fifth byte. Busforge's
  // parameter flash without a record writes every owned byte, all but those with the unit's value; with the record the bytes
  // that differ from its read of the unit (the decision is tested in "the stamp record" below).
  for (const [file, label] of [["mdt-router-ets6log-partial-name.txt", "shortened"], ["mdt-router-ets6log-partial-name-revert.txt", "set back"]] as const) {
    test(`parameter flash, device name ${label}: the bytes ETS writes, with its values, in ETS's bracket`, () => {
      const short = shortName();
      expect([short.length > 4, short.length < NAME.size]).toEqual([true, true]);
      const [from, to, written] = label === "shortened"
        ? [NAME.ets, short, short.slice(4) + "\0".repeat(NAME.size - short.length)]
        : [short, NAME.ets, NAME.ets.slice(4)];
      const held = target(new Map(params).set(NAME.ref, from)).bytes;
      const { image, plan } = parFlash(new Map(params).set(NAME.ref, to), held);
      const log = etsLog(file);
      const ets = relImage(file).get(4)!;
      expect(log.removed).toBe(2593);
      expect(sorted(changed(image, held))).toEqual(sorted(ets));
      expect(Buffer.from(sorted(ets).map(([, b]) => b)).toString("latin1")).toBe(written);
      expect(sorted(ets)[0][0]).toBe(NAME.offset + 4);
      const wire = innerWrites(file);
      expect([...wire.values()]).toEqual(sorted(ets).map(([, b]) => b));
      expect(systemBPlanBracket(plan)).toEqual(logBracket(file));
    });
  }
});

// ETS 6 group-address downloads of the MDT IP Interface/Router in Data Secure (private corpus
// captures/mdt-router-ets6log-partial-ga-{link,unlink}.txt; the tunnel's frames are encrypted, ETS's own log holds
// the procedure it executed, its image and every telegram inside the secured ones): object 1 "In Betrieb", unlinked
// in the project, linked to a plain test address (Data Secure off), then unlinked again. The project's other links
// are objects 2 to 4 (captures/mdt-router-unit-config.json).
corpusDescribe("MDT IP Interface/Router (M-0083_A-0137-20-7EB2): group-address downloads against ETS", () => {
  const xml = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const fx = JSON.parse(captureText("mdt-router-unit-config.json")) as { params: [string, string][]; links: { comObjRefId: string; gaRaws: number[] }[] };
  const params = new Map(fx.params);
  const number = (refId: string) => Number(refId.match(/^O-(\d+)_/)![1]);
  const own = fx.links.map((l) => ({ comObjNum: number(l.comObjRefId), gaRaws: l.gaRaws }));
  const TEST = { comObjNum: 1, gaRaws: [gaToNum("15/7/200")] };
  const view = buildDeviceConfig(cfg, params);
  // The unit describes its association table (object 2, PID 23) as PDT_GENERIC_02, which ETS reads before each
  // download: entries of one byte for group index and object number (assocEntryBytes).
  const ENTRY = 2;
  // Busforge's group-address flash of a link set: the tables, the security object without a key (the address is
  // plain) and the plan, the com-object table written whole (relativeComObjWriteSet without a record of a download
  // that wrote it, as Busforge's parameter flashes leave the router's record).
  const gaFlash = (links: ReadonlyArray<{ comObjNum: number; gaRaws: number[] }>) => {
    const comObj = buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set(links.map((l) => l.comObjNum)));
    const { addr, assoc } = buildGroupTables([...links], ENTRY);
    const security = buildSecurityObject([...links], comObj.readUInt16BE(0), new Map());
    const owned = relativeComObjWriteSet(comObj, comObj, undefined, null);
    const plan = withClosing(withConfirmedRestart(planSystemBGaFlash({ addr, assoc, comObj, comObjKept: { owned, keptAt: 0x1402 } }, true, false, security), proc.secureEnabled), proc, "grp");
    return { comObj, addr, assoc, owned, plan };
  };
  // The steps ETS executed and the plan's, in one vocabulary: the tables' load-state machines, the security object's
  // (`sec`), each table written, each security property ETS sent elements of (a WriteProp with Count 0 sends none).
  // Read from the "Executing:" lines directly: etsLog takes only self-closing steps, and the PID 54 step carries an
  // <OnError> child.
  const etsOrder = (file: string) => captureText(file).split(/\r?\n/).flatMap((l): string[] => {
    const m = l.match(/ - Executing: <(\w+)([^>]*?)\s*\/?>/);
    if (!m) return [];
    const st = { verb: m[1], attrs: Object.fromEntries([...m[2].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]])) };
    const a = st.attrs, sec = a.ObjType === "17";
    if (st.verb === "LdCtrlUnload") return [sec ? "sec:unload" : `unload:${a.LsmIdx}`];
    if (st.verb === "LdCtrlLoad") return [sec ? "sec:load" : `load:${a.LsmIdx}`];
    if (st.verb === "LdCtrlLoadCompleted") return [sec ? "sec:loadCompleted" : `loadCompleted:${a.LsmIdx}`];
    if (st.verb === "LdCtrlRelSegment") return [`alloc:${a.LsmIdx}:${a.Size}`];
    if (st.verb === "LdCtrlWriteRelMem") return [`write:${a.ObjIdx}`];
    if (st.verb === "LdCtrlWriteProp" && sec) return a.Count === "0" ? [] : [`sec:prop:${a.PropId}`];
    if (st.verb === "LdCtrlMasterReset") return ["restart"];
    return [];
  });
  const planOrder = (plan: LoadPlan) => plan.flatMap((st): string[] => {
    if (st.op === "unload" || st.op === "load" || st.op === "loadCompleted") return [`${st.op}:${st.lsm}`];
    if (st.op === "alloc") return [`alloc:${st.lsm}:${st.size}`];
    if (st.op === "writeSegment" || st.op === "writeSegmentOwned") return [`write:${st.lsm}`];
    if (st.op === "securityLsm") return [st.event === LSM.UNLOAD ? "sec:unload" : st.event === LSM.LOAD ? "sec:load" : "sec:loadCompleted"];
    if (st.op === "writeSecurityProp") return [`sec:prop:${st.pid}`];
    if (st.op === "restart") return ["restart"];
    return [];
  });
  // The security object's elements ETS wrote: [PID, element, data as hex].
  const etsSecurity = (file: string) => {
    const out: [number, number, string][] = [];
    for (const l of captureText(file).split(/\r?\n/)) {
      const m = l.match(/Sending Sec_req .*InnerTelegram=PropertyExtValue_WriteCon_req .*ObjectType=17 Instance=1 PID=(\d+) NumberOfElements=(\d+) StartIndex=(\d+) Data=([0-9A-F ]+?) succeeded/);
      if (!m) continue;
      const [pid, n, start] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const data = m[4].replace(/ /g, "").toLowerCase(), size = data.length / 2 / n;
      for (let k = 0; k < n; k++) out.push([pid, start + k, data.slice(2 * size * k, 2 * size * (k + 1))]);
    }
    return out;
  };
  const planSecurity = (plan: LoadPlan) => plan.flatMap((st): [number, number, string][] => (st.op !== "writeSecurityProp" ? []
    : Array.from({ length: st.data.length / st.elementSize }, (_, k): [number, number, string] => [st.pid, st.start + k, st.data.subarray(k * st.elementSize, (k + 1) * st.elementSize).toString("hex")])));
  const asMap = (img: Buffer) => [...img].map((b, i) => [i, b] as [number, number]);
  const sorted = (m: Map<number, number>) => [...m].sort(([a], [b]) => a - b);

  for (const [kind, links] of [["link", [...own, TEST]], ["unlink", own]] as const) {
    const file = `mdt-router-ets6log-partial-ga-${kind}.txt`;
    test(`${kind}: ETS read the association table's description first, PDT_GENERIC_02`, () => {
      expect(captureText(file).match(/PropertyDescription_Response_ind <- [\d.]+ \([^)]*\) ObjectIndex=2 PID=23 PropertyIndex=\d+ DataType=(\w+)/)?.[1]).toBe("PDT_GENERIC_02");
    });
    test(`${kind}: the three tables are ETS's image, byte for byte, the com-object table written whole`, () => {
      const ets = relImage(file);
      const ours = gaFlash(links);
      expect(sorted(ets.get(3)!)).toEqual(asMap(ours.comObj));
      expect(sorted(ets.get(2)!)).toEqual(asMap(ours.assoc));
      expect(sorted(ets.get(1)!)).toEqual(asMap(ours.addr));
      expect(ours.owned.every((m) => m === 0xff)).toBe(true);
    });
    test(`${kind}: ETS's steps in ETS's order, the address table written after the security object`, () => {
      const ets = etsOrder(file);
      expect(planOrder(gaFlash(links).plan)).toEqual(ets);
      expect(ets.indexOf("write:1")).toBeGreaterThan(ets.indexOf("sec:loadCompleted"));
    });
    test(`${kind}: the security object's elements ETS wrote, and no group key for the plain address`, () => {
      const ets = etsSecurity(file);
      expect(planSecurity(gaFlash(links).plan)).toEqual(ets);
      expect(ets.filter(([pid]) => pid === 53)).toEqual([]);
    });
  }
  // The same order in ETS's group-address downloads of two other Data Secure products, and their parameter
  // downloads with links write the address table before the security object, as Busforge's full download does.
  test("ETS's group-address downloads of the GVS AMMA and the Jung 400021SE write the address table after the security object too", () => {
    for (const file of ["gvs-amma-ets6log-keytable-plain.txt", "jung-400021se-ets6log-partial-flag-read-on.txt"]) {
      const ets = etsOrder(file);
      expect([file, ets.includes("write:4"), ets.indexOf("write:2") < ets.indexOf("sec:load"), ets.indexOf("write:1") > ets.indexOf("sec:loadCompleted")]).toEqual([file, false, true, true]);
    }
    const withParams = etsOrder("jung-400021se-ets6log-q2-param-link.txt");
    expect(withParams.indexOf("write:1")).toBeLessThan(withParams.indexOf("sec:load"));
  });
  test("link: object 1's entry is the only difference between the two com-object tables, its communication flag", () => {
    const linked = gaFlash([...own, TEST]).comObj, unlinked = gaFlash(own).comObj;
    expect([...linked].flatMap((b, i) => (b !== unlinked[i] ? [[i, unlinked[i], b]] : []))).toEqual([[2, 0x4b, 0x4f]]);
  });
  // The device page's read-back of the unit as ETS's link download left it (captures/mdt-router-unit-collect-nach-ets-ga-link.json,
  // a read-only collection holding each table as allocated and nothing past it): it reads the association table in
  // the form the unit describes, its entries and no byte past them.
  test("link: the read-back of the unit ETS left takes its links from the short table the unit describes, read at its own length", async () => {
    const unit = new CollectedUnit(JSON.parse(captureText("mdt-router-unit-collect-nach-ets-ga-link.json")) as Collection);
    const read = await classify(cfg).readState(asDevice(unit), unit.mask, { liveParams: params, baseParams: params, moduleInstances: [] });
    const byObject = (ls: ReadonlyArray<{ comObjNum: number; gaRaws: number[] }>) => [...ls].sort((a, b) => a.comObjNum - b.comObjNum);
    expect(read.linksRead).toBe(true);
    expect(byObject(read.links)).toEqual(byObject([...own, TEST]));
    expect((await unit.memRead(await unit.tableAddr(2), 10)).equals(gaFlash([...own, TEST]).assoc)).toBe(true);
  });
});

// ETS 6 downloads of the MDT Universal Interface 6-fold BE-06001.02 (M-0083_A-00B4-32-3919, MV-0705, module device,
// ProductProcedure, DynamicTableManagement="false"), private corpus captures/mdtui-*, each with ETS's
// own log, in this order: a full download; a partial download after "Time for long keypress" (P-8, AS-44C8 offset 4)
// went from 0.5 s to 0.6 s; one after linking the unlinked object 48 ("In operation") to a test group address; and one that reverted
// both in one. The configuration is the project's (captures/mdtui-unit-config.json). Before the partial downloads the
// tests take the unit to hold each segment's template under the bytes of ETS's full download (unitMemory).
corpusDescribe("MDT BE-06001.02 (M-0083_A-00B4-32-3919) against ETS", () => {
  const xml = catalogueXml("M-0083_A-00B4-32-3919.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const fx = JSON.parse(captureText("mdtui-unit-config.json")) as {
    ia: string; params: [string, string][]; instances: ModuleInstance[]; links: { comObjNum: number; gaRaws: number[] }[]; overrides: [number, ComObjInstanceOverride][];
  };
  const ia = iaToNum(fx.ia);
  const params = new Map(fx.params);
  const FULL = "mdtui-ets-fulldownload.log", PARTIAL = "mdtui-ets-partial-params.log";
  const LINKS = "mdtui-ets-partial-links.log", REVERT = "mdtui-ets-partial-revert.log";
  const wire = (file: string) => memoryImage(parseCapture(captureText(file), ia).writes);
  const LONG_PRESS = { ref: "M-0083_A-00B4-32-3919_P-8_R-7", from: "33268", to: "33368" };
  const LINKED = 48;
  const full = () => classify(cfg).planFullDownload(cfg.mask, { ia: fx.ia, params, links: fx.links, moduleInstances: fx.instances, comObjectOverrides: new Map(fx.overrides), proc });
  const written = wire(FULL);
  const held = unitMemory(cfg, ia, written);
  const segmentHeld = (address: number) => {
    const seg = cfg.absoluteSegments.find((s) => s.address === address)!;
    return { seg, bytes: Buffer.from(Array.from({ length: seg.size }, (_, i) => held.get(address + i)!)) };
  };
  const comObj = segmentHeld(0x4400);
  const configAt = (n: number) => comObj.seg.address + 3 + n * 4 + 2;
  const gaFlash = (links: typeof fx.links) =>
    planSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia), { address: comObj.seg.address, bytes: withLinkedCommFlags(comObj.bytes, new Set(links.map((l) => l.comObjNum))) });
  // The group addresses of the address table a download wrote, ascending, and the test group address the links download
  // added: the one address of its table no project link uses.
  const tableOf = (img: Map<number, number>) => tableGas(fromMemory(img, 0x4000), "system7");
  const TEST_GA = addedGa(tableOf(wire(LINKS)), fx.links);
  const withLink = [...fx.links, { comObjNum: LINKED, gaRaws: [TEST_GA] }];
  const TABLE_BRACKETS = [
    "unload:1", "unload:2",
    "load:1", "absSegment:1@16384+513", "write", "taskSegment:1@16384=01008300b432", "loadCompleted:1",
    "load:2", "absSegment:2@16897+511", "write", "taskSegment:2@16897=01008300b432", "loadCompleted:2",
    "load:3", "write", "loadCompleted:3", "restart",
  ];
  // What the unit held before the revert: the full download, then the parameter and the group-address download.
  const beforeRevert = () => unitMemory(cfg, ia, written, wire(PARTIAL), wire(LINKS));
  const structural = (device: Map<number, number>) => system7StructuralFlash({ cfg, proc, ia, device, params, baseParams: new Map(params).set(LONG_PRESS.ref, LONG_PRESS.to), links: fx.links, moduleInstances: fx.instances });

  test("the configuration is the project's: five linked objects, the long keypress at 0.5 s, object 48 unlinked", () => {
    expect(fx.links.map((l) => l.comObjNum)).toEqual([0, 6, 12, 18, 44]);
    expect(buildDeviceConfig(cfg, params, undefined, fx.instances).imageValues.get(LONG_PRESS.ref)).toBe(LONG_PRESS.from);
    expect(fx.links.some((l) => l.comObjNum === LINKED)).toBe(false);
  });

  test("full download: the declared steps in their declared order, as ETS sends them, verify mode aside", () => {
    const build = full();
    expect(planSteps(build.plan)).toEqual(withoutVerifyMode(captureSteps(FULL, ia)));
    expect(planSteps(build.plan)).toEqual([
      "unload:1", "unload:2", "unload:3",
      "load:1", "absSegment:1@16384+513", "write", "taskSegment:1@16384=01008300b432", "loadCompleted:1",
      "load:2", "absSegment:2@16897+511", "write", "taskSegment:2@16897=01008300b432", "loadCompleted:2",
      // The two RAM segments (MemType 2), the second a stack segment (SegType 1): declared, nothing written.
      "load:3", "absSegment:3@1792+190", "absSegment:3@1982+1/t1", "absSegment:3@17408+200", "write", "absSegment:3@17608+372", "write",
      "taskSegment:3@17408=01008300b432", "loadCompleted:3", "restart",
    ]);
    expect(build.plan.filter((s) => (s.op === "absSegment" || s.op === "taskSegment") && s.viaProperty !== true)).toEqual([]);
  });

  test("full download: Busforge writes exactly the bytes ETS writes, with ETS's values, the update bit of objects 36 and 39 included", () => {
    const build = full();
    const cap = parseCapture(captureText(FULL), ia);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.flatMap((s) => [...s.divergences, ...s.busforgeOnly, ...s.etsOnly])).toEqual([]);
    expect(r.unattributed).toEqual([]);
    // The address table without the own individual address, the association table, the com-object table and the
    // parameter segment whole, 594 bytes.
    expect(span(bytesOf(build.plan))).toEqual(["4000-4000", "4003-400c", "4201-420b", "4400-463b"]);
    expect([...bytesOf(build.plan)].sort(([a], [b]) => a - b)).toEqual([...written].sort(([a], [b]) => a - b));
    // The external inputs of logic 1 and 2 (UpdateFlag="Enabled"): config 0xD3, update bit 0x80 set.
    expect([configAt(36), configAt(39)].map((a) => written.get(a))).toEqual([0xd3, 0xd3]);
  });

  // ETS's PID 5 declarations (event 03: segments, task segments), in order, as "lsm:data".
  const declarations = (file: string) => captureText(file).split("\n").flatMap((l) => {
    const m = l.includes("ETS->BRIDGE") ? l.match(/\| ([0-9a-fA-F]+)\s*$/) : null;
    const fr = m ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group || fr.dst !== ia || fr.tpdu.length < 7) return [];
    const t = fr.tpdu;
    return (((t[0] & 0x03) << 8) | t[1]) === 0x3d7 && t[3] === 5 && t[6] === 3 ? [`${t[2]}:${t.subarray(6).toString("hex")}`] : [];
  });
  const planDeclarations = (plan: LoadPlan) => plan.flatMap((s) => (s.op === "absSegment"
    ? [`${s.lsm}:${Buffer.from([3, s.segType, s.address >> 8, s.address & 0xff, s.size >> 8, s.size & 0xff, s.access, s.memType, s.segFlags, 0]).toString("hex")}`]
    : s.op === "taskSegment"
      ? [`${s.lsm}:${Buffer.from([3, 2, s.address >> 8, s.address & 0xff, s.peiType, s.manufacturer >> 8, s.manufacturer & 0xff, s.appNumber >> 8, s.appNumber & 0xff, s.version]).toString("hex")}`]
      : []));

  test("full download: every segment and task declaration carries ETS's bytes, access, memory type and flags included", () => {
    expect(planDeclarations(full().plan)).toEqual(declarations(FULL));
    expect(declarations(FULL)).toContain("3:030107be000100020000");
  });

  // Device control (object 0 PID 14): the unit's answer to ETS's read, ETS's write, the unit's answer to the write.
  const deviceControl = (file: string) => captureText(file).split("\n").flatMap((l) => {
    const m = l.match(/\| ([0-9a-fA-F]+)\s*$/);
    const fr = m ? parseTunnelFrame(m[1]) : null;
    if (!fr || fr.group || fr.tpdu.length < 7 || fr.tpdu[2] !== 0 || fr.tpdu[3] !== 14) return [];
    const t = fr.tpdu, apci = ((t[0] & 0x03) << 8) | t[1];
    if (apci === 0x3d6 && fr.src === ia) return [`answer ${t.subarray(6).toString("hex")}`];
    if (apci === 0x3d7 && fr.dst === ia) return [`write ${t.subarray(6).toString("hex")}`];
    return [];
  });

  test("ETS's verify mode: device control written back with 0x04 set, 05 where the unit showed the application stopped", () => {
    expect([FULL, PARTIAL, LINKS, REVERT].map((f) => deviceControl(f).filter((x, i, a) => a.indexOf(x) === i))).toEqual([
      ["answer 01", "write 05", "answer 05"], ["answer 01", "write 05", "answer 05"],
      ["answer 00", "write 04", "answer 04"], ["answer 00", "write 04", "answer 04"],
    ]);
  });

  test("ETS's log: it executes the declared full steps in their declared order, with the image Busforge writes", () => {
    const log = etsLog("mdtui-ets6log-fulldownload.txt");
    const declared = flattenSteps(proc, "full");
    expect(log.steps.map((s) => s.verb)).toEqual(declared.map((s) => s.verb));
    expect(declared.flatMap((d, i) => Object.entries(d.attrs).filter(([k, v]) => log.steps[i].attrs[k] !== v))).toEqual([]);
    expect([...log.image].sort(([a], [b]) => a - b)).toEqual([...bytesOf(full().plan)].sort(([a], [b]) => a - b));
  });

  test("ETS's log of the parameter download: Load 3 without unload, 277 bytes of AS-44C8, nothing of the com-object table", () => {
    const log = etsLog("mdtui-ets6log-partial-params.txt");
    expect(log.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual(["LdCtrlConnect", "LdCtrlCompareProp", "LdCtrlLoad3", "LdCtrlWriteMem17408", "LdCtrlWriteMem17608", "LdCtrlLoadCompleted3", "LdCtrlRestart", "LdCtrlDisconnect"]);
    expect(log.image.size).toBe(277);
    expect(span([...log.image.keys()])[0]).toBe("44c8-44c9");
    expect([...log.image]).toEqual([...wire(PARTIAL)].sort(([a], [b]) => a - b));
  });

  test("parameter flash: ETS's bracket, and exactly the bytes ETS writes, every parameter-covered byte with its value", () => {
    const after = new Map(params).set(LONG_PRESS.ref, LONG_PRESS.to);
    const pseg = segmentHeld(0x44c8);
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, after, proc, new Map([[pseg.seg.id, pseg.bytes]]), { moduleInstances: fx.instances });
    expect([changedBytes, unplaceable]).toEqual([2, []]);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(PARTIAL, ia)));
    expect(planSteps(plan)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    const ets = wire(PARTIAL);
    expect([...bytesOf(plan)].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
    expect([ets.get(0x44cc), ets.get(0x44cd)]).toEqual([0x82, 0x58]);
    // Without the project's module instances the planner places them by the allocators, as the image build
    // does, and plans the same bytes.
    const bare = planAbsoluteParFlash(cfg, after, proc, new Map([[pseg.seg.id, pseg.bytes]]));
    expect([...bytesOf(bare.plan)].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
  });

  test("group-address flash: ETS's partial download, the tables in their declared brackets, the com-object table to its counted entries with the new link bit", () => {
    expect(tableOf(wire(LINKS))).toEqual([...new Set(fx.links.flatMap((l) => l.gaRaws)), TEST_GA].sort((a, b) => a - b));
    const { plan } = gaFlash(withLink);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(LINKS, ia)));
    expect(planSteps(plan)).toEqual(TABLE_BRACKETS);
    const ets = wire(LINKS);
    const ours = bytesOf(plan);
    expect([...ours].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
    // The com-object table is 3 + 49 x 4 = 199 bytes; the segment's last byte (0x44C7) is not written.
    expect(span(ours)).toEqual(["4000-4000", "4003-400e", "4201-420d", "4400-44c6"]);
    // The test address sorted to the end of the address table, its association (object 48, index 6) behind the others.
    expect([ours.get(0x4000), ours.get(0x400d), ours.get(0x400e), ours.get(0x4201), ours.get(0x420c), ours.get(0x420d)]).toEqual([7, TEST_GA >> 8, TEST_GA & 0xff, 6, 6, LINKED]);
    // Of the com-object table only object 48's config byte changes: the linked bit.
    expect([...ours].filter(([a, b]) => a >= comObj.seg.address && held.get(a) !== b)).toEqual([[configAt(LINKED), 0x4f]]);
    expect(held.get(configAt(LINKED))).toBe(0x4b);
  });

  test("ETS's logs of the group-address download and the revert: the table brackets, LSM 3 without unload, the image it wrote", () => {
    for (const [log, capture] of [["mdtui-ets6log-partial-links.txt", LINKS], ["mdtui-ets6log-partial-revert.txt", REVERT]] as const) {
      const l = etsLog(log);
      expect(l.steps.map((s) => `${s.verb}${s.attrs.LsmIdx ?? s.attrs.Address ?? ""}`)).toEqual([
        "LdCtrlConnect", "LdCtrlCompareProp", "LdCtrlUnload1", "LdCtrlUnload2",
        "LdCtrlLoad1", "LdCtrlAbsSegment1", "LdCtrlTaskSegment1", "LdCtrlLoadCompleted1",
        "LdCtrlLoad2", "LdCtrlAbsSegment2", "LdCtrlTaskSegment2", "LdCtrlLoadCompleted2",
        "LdCtrlLoad3", "LdCtrlWriteMem17408", "LdCtrlWriteMem17608", "LdCtrlLoadCompleted3", "LdCtrlRestart", "LdCtrlDisconnect",
      ]);
      expect([...l.image]).toEqual([...wire(capture)].sort(([a], [b]) => a - b));
    }
  });

  test("structural flash of the revert: ETS's bracket set, and every byte ETS changed with ETS's value", () => {
    const device = beforeRevert();
    expectRevertForm(structural(device).plan, REVERT, ia, device);
    // ETS's revert changes the two table counts, object 48's linked bit and the long keypress, nothing else.
    expect([...wire(REVERT)].filter(([a, b]) => device.get(a) !== b).map(([a]) => a.toString(16))).toEqual(["4000", "4201", "44c5", "44cc", "44cd"]);
  });

  test("a table that shrinks leaves its old bytes behind it, in ETS's download and in Busforge's", () => {
    const behind = [0x400d, 0x400e, 0x420c, 0x420d];
    expect(behind.map((a) => wire(LINKS).get(a))).toEqual([TEST_GA >> 8, TEST_GA & 0xff, 0x06, LINKED]);
    expect(behind.filter((a) => wire(REVERT).has(a))).toEqual([]);
    const ours = [...bytesOf(structural(beforeRevert()).plan).keys(), ...bytesOf(gaFlash(fx.links).plan).keys()];
    expect(behind.filter((a) => ours.includes(a))).toEqual([]);
  });
});

// Every System B full download in the corpus, real form (the application unloaded, its segment allocated
// with fill): the bytes Busforge writes are exactly the bytes ETS wrote, with ETS's values. ETS writes of the
// parameter segment the bytes off the fill and its image's bytes between two such with fewer than 31
// bytes between them (fillAllocatedRuns), the tables whole. The configuration is the one ETS downloaded.
corpusDescribe("System B full download: the bytes ETS writes, and no other", () => {
  type Fx = { ia: string; params: [string, string][]; links: { comObjNum: number; gaRaws: number[] }[]; instances?: ModuleInstance[]; overrides?: unknown };
  const mix2 = (tag: string) => {
    const fx = JSON.parse(captureText(`mix2-${tag}-config.json`)) as Fx & { overrides: { comObjRefId: string; attrs: Record<string, string> }[] };
    return { name: `Theben MIX 2 ${tag}`, xml: catalogueXml("M-0048_A-493B-21-B471.xml.gz"), log: `mix2-${tag}-ets-fulldownload.log`, fx,
      overrides: (cfg: ReturnType<typeof parseAppConfig>) => placeComObjOverrides(cfg, buildDeviceConfig(cfg, new Map(fx.params), undefined, fx.instances), fx.overrides) };
  };
  const dali = JSON.parse(captureText("dali-gateway-unit-fulldownload.json")) as Fx & { overrides: [number, ComObjInstanceOverride][] };
  const cases = [
    // Parsing and building this application (190061 elements, a 21601-byte segment) took 3.4 s alone and 8.4 s
    // in a full check running beside others, past the 5 s default.
    { name: "OpenKNX RaumController", xml: gunzipSync(readFileSync(capturePath("openknx-raumcontroller-5.5.1-app.xml.gz"))).toString("utf8"), log: "openknx-ets-fulldownload.log", fx: JSON.parse(captureText("openknx-config.json")) as Fx, overrides: () => new Map<number, ComObjInstanceOverride>(), timeout: 30_000 },
    mix2("hmg6t"), mix2("jmg4t"), mix2("rmg8t"),
    { name: "Theben DALI-Gateway", xml: catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz"), log: "dali-ets-fulldownload-real.log", fx: dali, overrides: () => new Map(dali.overrides) },
    { name: "Jung 400021SE", xml: catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz"), log: "jung-400021se-ets-fulldownload.log", fx: { ia: numToIa(deviceOf("jung-400021se-ets-fulldownload.log")), params: [], links: [] } as Fx, overrides: () => new Map<number, ComObjInstanceOverride>() , timeout: 30_000 }, // parses the 26.9 MB Jung: under 1 s alone, 5-10 s in a full check at load 14-36
    { name: "GVS AMMA", xml: catalogueXml("M-0085_A-0072-30-69AA.xml.gz"), log: "gvs-amma-ets-fulldownload-defaults.log", fx: { ia: numToIa(deviceOf("gvs-amma-ets-fulldownload-defaults.log")), params: [], links: [] } as Fx, overrides: () => new Map<number, ComObjInstanceOverride>() },
  ];
  for (const c of cases) {
    test(`${c.name}: every byte ETS wrote, each with its value, and no byte ETS left out`, () => {
      const cfg = parseAppConfig(c.xml);
      const build = classify(cfg).planFullDownload(cfg.mask, {
        ia: c.fx.ia, params: new Map(c.fx.params), links: c.fx.links, moduleInstances: c.fx.instances ?? [], proc: parseLoadProcedures(c.xml), comObjectOverrides: c.overrides(cfg),
      });
      const cap = parseCapture(captureText(c.log), iaToNum(c.fx.ia));
      const refs = reportedTableReferences(cap);
      // The GVS capture holds no PID 7 answer for the parameter segment; its base is where ETS's distinctive writes line up.
      const at = (lsm: number) => refs.get(lsm) ?? inferBase(build.segments.find((s) => s.lsm === lsm)!.image, cap.writes)!;
      const ours = new Map<number, number>();
      for (const st of build.plan) if (st.op === "writeSegment") st.bytes.forEach((b, i) => ours.set(at(st.lsm) + (st.offset ?? 0) + i, b));
      const ets = memoryImage(cap.writes);
      expect(ours.size).toBeGreaterThan(0);
      expect([...ours].sort((x, y) => x[0] - y[0])).toEqual([...ets].sort((x, y) => x[0] - y[0]));
    }, "timeout" in c ? c.timeout : undefined);
  }

  // The MDT IP Interface/Router's full download is refused (its tunnelling addresses, declaresTunnelingEntries), so its
  // parameter segment is held against ETS's secured writes with the rule alone: <Data> images the segment whole.
  test("MDT IP Interface/Router: the parameter segment's bytes ETS wrote inside its secured telegrams", () => {
    const xml = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");
    const cfg = parseAppConfig(xml);
    const fx = JSON.parse(captureText("mdt-router-unit-config.json")) as { params: [string, string][] };
    const target = buildRelativeSegmentTarget(cfg, new Map(fx.params), 4, { ownIdleUnionDefaults: true })!;
    const coverage = fullDownloadImageCoverage(cfg, target.owned);
    expect(coverage.every(Boolean)).toBe(true);
    const at = 0x14ea;
    const ours = new Map<number, number>();
    for (const r of fillAllocatedRuns(target.bytes, coverage, relParamFillByte(parseLoadProcedures(xml)))) r.bytes.forEach((b, i) => ours.set(at + r.offset + i, b));
    const ets = etsWrites("mdt-router-ets6log-fulldownload.txt");
    const inSegment = [...ets].filter(([a]) => a >= at && a < at + target.size);
    expect([...ours].sort((x, y) => x[0] - y[0])).toEqual(inSegment.sort((x, y) => x[0] - y[0]));
  });
});

// ETS 6.4.1's application download of the MDT IP Interface Secure (M-0083_A-0138, MV-0012, System 1, Data Secure)
// on a unit, through its own tunnel (captures/mdt-ip-secure-ets6log-fulldownload.txt; the encrypted proxy
// log is mdt-ip-secure-ets-fulldownload.log). The application allows no partial download, so this is ETS's
// parameter download too. ETS's log holds every telegram it sent inside the secured ones, the procedure it ran and
// its image. The project's settings for the unit: captures/mdt-ip-secure-unit-knxip.json and -unit-memory.json.
corpusDescribe("MDT IP Interface Secure (M-0083_A-0138, System 1) against ETS", () => {
  const A = "M-0083_A-0138-21-F18E-O0072";
  const cfg = parseAppConfig(catalogueXml(`${A}.xml.gz`));
  const LOG = "mdt-ip-secure-ets6log-fulldownload.txt";
  const params = new Map((JSON.parse(captureText("mdt-ip-secure-unit-memory.json")) as { params: [string, string][] }).params);
  const fx = JSON.parse(captureText("mdt-ip-secure-unit-knxip.json")) as { knxIp: KnxIpDevice; afterEts: { eeprom: string } };
  // ETS took the product's text in its own language (German) for the friendly name, and the unit held it
  // afterwards; Busforge keeps the language the unit holds, else takes the catalogue's default one.
  const GERMAN = Buffer.from("SCN-IP000.03 IP Interface mit ");
  const build = (heldName?: Buffer) => planSystem1Download(cfg, params, fx.knxIp, heldName);
  const hexOf = (s: string) => s.replace(/\s+/g, "").toLowerCase();

  // Every write and read ETS sent from its first write on, one line per telegram, as the plan's steps below.
  const etsWire = () => {
    const out: string[] = [];
    for (const l of captureText(LOG).split(/\r?\n/)) {
      const m = l.match(/ Sending Sec_req .*InnerTelegram=(\w+)_req -> [\d.]+ \([^)]*\) (.*?) succeeded/);
      if (!m) continue;
      const f = Object.fromEntries([...m[2].matchAll(/(\w+)=(.*?)(?= \w+=|$)/g)].map((x) => [x[1], x[2]]));
      const line = m[1] === "MemoryExtended_Write" ? `mem ${f.Address.slice(1).toLowerCase()}=${hexOf(f.Data)}`
        : m[1] === "PropertyExtValue_WriteCon" ? `prop ${f.ObjectType}/${f.PID}#${f.StartIndex}*${f.NumberOfElements}=${hexOf(f.Data)}`
        : m[1] === "PropertyExtValue_Read" ? `read ${f.ObjectType}/${f.PID}#${f.StartIndex}*${f.NumberOfElements}`
        : m[1] === "FunctionPropertyExtCommand" ? `func ${f.ObjectType}/${f.PID}=${hexOf(f.Command)}`
        : m[1] === "ConfirmedRestart" ? "restart confirmed" : null;
      if (line && (out.length || line.startsWith("mem "))) out.push(line);
    }
    return out;
  };
  const planWire = (plan: LoadPlan) => plan.map((s) => {
    if (s.op === "writeMem") return `mem ${s.address.toString(16).padStart(4, "0")}=${s.bytes.toString("hex")}`;
    if (s.op === "securityLsm") return `func 17/5=${Buffer.concat([Buffer.from([s.event]), Buffer.alloc(9)]).toString("hex")}`;
    if (s.op === "writeSecurityProp") return `prop 17/${s.pid}#${s.start}*${s.data.length / s.elementSize}=${s.data.toString("hex")}`;
    if (s.op === "writePropExt") return `prop ${s.objectType}/${s.pid}#${s.start}*${s.count}=${s.data.toString("hex")}`;
    if (s.op === "readPropExt") return `read ${s.objectType}/${s.pid}#${s.start}*${s.count}`;
    if (s.op === "funcPropExt") return `func ${s.objectType}/${s.pid}=${s.data.toString("hex")}`;
    if (s.op === "restart") return s.confirmed ? "restart confirmed" : "restart";
    return s.op;
  });

  // One plan step per ETS telegram. The secured memory writes go out in chunks of the secured path's size
  // (KnxDevice.memWrite), where ETS sent each run in one telegram; the bytes and addresses are the same.
  test("the download's steps are ETS's telegrams, one for one, on a unit holding the German name", () => {
    expect(planWire(build(GERMAN).plan)).toEqual(etsWire());
    expect(etsWire().length).toBe(29);
  });

  test("on a unit holding no product name, the catalogue's default language: only the friendly name differs", () => {
    const ours = planWire(build().plan), ets = etsWire();
    const differing = ours.map((s, i) => [s, ets[i]]).filter(([a, b]) => a !== b);
    expect(differing).toEqual([[
      `prop 11/76#1*30=${Buffer.from("SCN-IP000.03 IP Interface with").toString("hex")}`,
      `prop 11/76#1*30=${Buffer.from("SCN-IP000.03 IP Interface mit ").toString("hex")}`,
    ]]);
  });

  // ETS's image: "--" where it writes nothing, which is the bytes the <Mask> leaves out and no parameter covers. It
  // also lists the run error 0x010D (FF), which only the procedure's inline writes set; the plan writes it so.
  test("the image is ETS's, byte for byte, and the bytes ETS leaves out are those the plan does not write from it", () => {
    const { image, written, plan } = build();
    const ets = etsLog(LOG).image;
    const ours = new Map([...image].flatMap((b, i) => (written[i] ? [[0x0100 + i, b] as [number, number]] : [])));
    ours.set(0x010d, image[0x0d]);
    expect([...ours].sort((a, b) => a[0] - b[0])).toEqual([...ets].filter(([a]) => a >= 0x0100 && a < 0x0200).sort((a, b) => a[0] - b[0]));
    expect(span(written.flatMap((w, i) => (w ? [] : [0x0100 + i])))).toEqual(["101-103", "10d-10d", "117-118", "13e-171", "1ff-1ff"]);
    expect(plan.filter((s) => s.op === "writeMem" && s.address === 0x010d).map((s) => s.op === "writeMem" && [s.bytes.toString("hex"), s.opens ?? s.closes])).toEqual([["00", "run error"], ["ff", "run error"]]);
  });

  // The unit read after ETS's download holds the image in every byte the plan verifies; 0x0176, the TTL parameter
  // (Access="None") written as 64, holds 32: the unit keeps PID 67 there, which the download writes afterwards.
  test("the unit after ETS's download holds every verified byte; the TTL parameter's byte holds PID 67", () => {
    const { image, verify, written, knxIp } = build();
    const after = Buffer.from(fx.afterEts.eeprom, "hex");
    expect(verify.flatMap((v, i) => (v && after[i] !== image[i] ? [i] : []))).toEqual([]);
    expect(written.flatMap((w, i) => (w && !verify[i] ? [0x0100 + i] : []))).toEqual([0x0176]);
    expect([image[0x76], after[0x76], knxIp.find((w) => w.pid === 67)!.data[0]]).toEqual([64, 32, 32]);
  });

  test("the procedure ETS ran is the master data's MV-0012 procedure with its restart replaced by what the plan writes", () => {
    const verbs = etsLog(LOG).steps.map((s) => `${s.verb}${s.attrs.ObjType ? `:${s.attrs.ObjType}` : ""}`);
    const master = verbs.indexOf("LdCtrlUnload:17");
    expect(verbs.slice(0, master).filter((v) => v !== "LdCtrlSetControlVariable")).toEqual(MV0012_DEFAULT_LOAD.filter((s) => s.verb !== "LdCtrlSetControlVariable" && s.verb !== "LdCtrlRestart").map((s) => s.verb));
    expect(verbs.slice(master)).toEqual([
      "LdCtrlUnload:17", "LdCtrlLoad:17", "LdCtrlWriteProp:17", "LdCtrlLoadCompleted:17", "LdCtrlLoadImageProp:11",
      ...Array(9).fill("LdCtrlWriteProp:11"),
      "LdCtrlMapError", "LdCtrlInvokeFunctionProp:11", "LdCtrlMapError", "LdCtrlMapError", "LdCtrlInvokeFunctionProp:11", "LdCtrlMapError", "LdCtrlMapError", "LdCtrlInvokeFunctionProp:11", "LdCtrlMapError",
      "LdCtrlMasterReset", "LdCtrlDisconnect",
    ]);
    // The procedure ETS lists also writes the security object's group key table with no element (Count="0"),
    // which it does not execute; its address table write is answered E_ADDRESS_VOID and ignored (OnError
    // ResourceNotFound).
    expect(captureText(LOG)).toContain('<LdCtrlWriteProp ObjType="17" PropId="53" Count="0" Verify="true" />');
    expect(captureText(LOG)).toMatch(/WritePropertyExt\([\d.]+, 17\[0\]\/54, PDT=4, 0\.\.\.0\) failed: Schreiben von PropertyExtended\(17\*1\/54, 0, 1\) fehlgeschlagen: E_ADDRESS_VOID/);
  });
});

// ETS's record of a download (the PID 27 stamps it reads after the last LoadCompleted) and its check before
// a parameter download (the stamps it reads first), from its own log. Busforge keeps the same record per
// device (ImageStamp) and decides as ETS does (checkedStamps, relativeParWriteSet).
const logStamps = (file: string) => {
  const opening: ImageStamp[] = [], closing: ImageStamp[] = [];
  let started = false;
  for (const l of captureText(file).split(/\r?\n/)) {
    if (/Executing: <LdCtrl(Unload|Load) /.test(l)) { started = true; closing.length = 0; }
    const m = l.match(/ReadProperty\([\d.]+, (\d+)\/27, PDT=\d+, (\d+)\.\.\.(\d+)\): ([0-9A-F ]+)$/);
    if (!m) continue;
    const data = Buffer.from(m[4].replace(/ /g, ""), "hex");
    const els = Array.from({ length: Number(m[3]) - Number(m[2]) + 1 }, (_, k) => ({ obj: Number(m[1]), element: Number(m[2]) + k, hex: data.subarray(8 * k, 8 * k + 8).toString("hex") }));
    (started ? closing : opening).push(...els);
  }
  return { opening, closing };
};
// What Busforge's check finds, the unit answering what ETS read before the download.
const stampCheck = (record: ImageStamp[], file: string) => {
  const read = checkedStamps(record).map((r) => logStamps(file).opening.find((o) => o.obj === r.obj && o.element === r.element) ?? { ...r, hex: "unread" });
  return { equal: read.every((x, i) => x.hex === checkedStamps(record)[i].hex), read };
};
corpusDescribe("the stamp record: ETS's differential parameter download, and its fallback", () => {
  // [the download that wrote the parameters before, the parameter download], in capture order.
  const cases: [string, string][] = [
    ["openknx-ets6log-fulldownload.txt", "openknx-ets6log-partial-params.txt"],
    ["openknx-ets6log-partial-params.txt", "openknx-ets6log-partial-revert.txt"],
    ["dali-ets6log-fulldownload.txt", "dali-ets6log-partial-params.txt"],
    ["dali-ets6log-partial-params.txt", "dali-ets6log-partial-revert.txt"],
    ["mdt-router-ets6log-fulldownload.txt", "mdt-router-ets6log-partial-name.txt"],
    ["mdt-router-ets6log-partial-name.txt", "mdt-router-ets6log-partial-name-revert.txt"],
    ...["hmg6t", "jmg4t", "rmg8t"].flatMap((t): [string, string][] => [[`mix2-${t}-ets6log-fulldownload.txt`, `mix2-${t}-ets6log-partial-params.txt`], [`mix2-${t}-ets6log-partial-params.txt`, `mix2-${t}-ets6log-partial-revert.txt`]]),
    ["mix2-hmg6t-ets6log-partial-diag-on.txt", "mix2-hmg6t-ets6log-partial-diag-off.txt"],
    // Group-address downloads take the same decision on the same stamps: the record is the last download that wrote the
    // parameters, which a group-address download leaves as it was.
    ...["hmg6t", "jmg4t", "rmg8t"].map((t): [string, string] => [`mix2-${t}-ets6log-fulldownload.txt`, `mix2-${t}-ets6log-partial-links.txt`]),
    ["meanwell-ets6log-params.txt", "meanwell-ets6log-revert.txt"],
  ];
  for (const [before, file] of cases) {
    test(`${file}: the decision ETS's log names, from the record of ${before}`, () => {
      const record = logStamps(before).closing;
      expect(record.length).toBeGreaterThan(0);
      const ets = captureText(file).includes("Differential Image Stamp does not match") ? "fallback" : etsLog(file).removed > 0 ? "differential" : "neither";
      expect([file, stampCheck(record, file).equal ? "differential" : "fallback"]).toEqual([file, ets]);
    });
  }

  // MEAN WELL KNX-40E-1280D: ETS's record of the unit's last download that wrote the parameters predates the captures; the
  // unit's stamps before them (its collect) stand for it. The group-address download finds them equal and goes differential,
  // and leaves the record as it was, so the parameter download after it finds the com-object table's stamp changed and falls
  // back.
  for (const [file, ets] of [["meanwell-ets6log-links.txt", "differential"], ["meanwell-ets6log-params.txt", "fallback"]] as const) {
    test(`${file}: the decision ETS's log names, from the unit's stamps before the captures`, () => {
      const records = (JSON.parse(captureText("meanwell-unit-collect-vor.json")) as { records: { space: string; target: { object?: number; pid?: number; start?: number }; bytes?: string }[] }).records;
      const record = [1, 2, 3, 4].map((obj) => ({ obj, element: 1, hex: records.find((r) => r.space === "property" && r.target.object === obj && r.target.pid === 27 && r.target.start === 1)!.bytes! }));
      const logged = captureText(file).includes("Differential Image Stamp does not match") ? "fallback" : etsLog(file).removed > 0 ? "differential" : "neither";
      expect(logged).toBe(ets);
      expect([file, stampCheck(record, file).equal ? "differential" : "fallback"]).toEqual([file, ets]);
    });
  }

  test("Theben DALI-Gateway: with the record, the parameter flash and its revert write ETS's byte and no other", () => {
    const xml = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz");
    const cfg = parseAppConfig(xml);
    const proc = parseLoadProcedures(xml);
    const fx = JSON.parse(captureText("dali-gateway-unit-fulldownload.json")) as { ia: string; params: [string, string][]; instances: ModuleInstance[]; segments: Record<string, { at: number; hex: string }> };
    const ref = "M-0048_A-9071-20-F258-O00EF_P-781_R-832";
    const write = (values: Map<string, string>, held: Buffer, before: string, file: string) => {
      const target = buildRelativeSegmentTarget(cfg, values, 4, { moduleInstances: fx.instances, ownIdleUnionDefaults: true })!;
      const { image } = mergeRelativeTarget(held, target);
      const mask = relativeParWriteSet(image, held, target.owned, declaredMcbWrites(proc, target.size, "par"), stampCheck(logStamps(before).closing, file));
      return { image, bytes: new Map(ownedRuns(image, mask).flatMap((r) => [...r.bytes].map((b, i) => [0x5000 + r.offset + i, b] as [number, number]))) };
    };
    const held = Buffer.from(fx.segments[4].hex, "hex");
    const par = write(new Map(fx.params).set(ref, "12"), held, "dali-ets6log-fulldownload.txt", "dali-ets6log-partial-params.txt");
    expect([...par.bytes]).toEqual([...memoryImage(parseCapture(captureText("dali-ets-partial-params.log"), iaToNum(fx.ia)).writes)]);
    const rev = write(new Map(fx.params), par.image, "dali-ets6log-partial-params.txt", "dali-ets6log-partial-revert.txt");
    expect([...rev.bytes]).toEqual([...memoryImage(parseCapture(captureText("dali-ets-partial-revert.log"), iaToNum(fx.ia)).writes)].filter(([a]) => a >= 0x5000 && a < 0x5000 + held.length));
  });

  test("OpenKNX RaumController: with the record, the parameter flash writes ETS's one byte", () => {
    const xml = gunzipSync(readFileSync(capturePath("openknx-raumcontroller-5.5.1-app.xml.gz"))).toString("utf8");
    const cfg = parseAppConfig(xml);
    const proc = parseLoadProcedures(xml);
    const fx = JSON.parse(captureText("openknx-config.json")) as { ia: string; params: [string, string][]; links: { comObjNum: number; gaRaws: number[] }[] };
    const full = classify(cfg).planFullDownload(cfg.mask, { ia: fx.ia, params: new Map(fx.params), links: fx.links, proc });
    const held = full.segments.find((s) => s.lsm === 4)!.image;
    const values = new Map(fx.params).set("M-00FA_A-A012-55-0000_UP-1000174_R-100017401", "1");
    const target = buildRelativeSegmentTarget(cfg, values, 4, { ownIdleUnionDefaults: true })!;
    const { image } = mergeRelativeTarget(held, target);
    const mask = relativeParWriteSet(image, held, target.owned, declaredMcbWrites(proc, target.size, "par"), stampCheck(logStamps("openknx-ets6log-fulldownload.txt").closing, "openknx-ets6log-partial-params.txt"));
    const ours = ownedRuns(image, mask).flatMap((r) => [...r.bytes].map((b, i) => [0x54 + r.offset + i, b] as [number, number]));
    expect(ours).toEqual([...memoryImage(parseCapture(captureText("openknx-ets-partial-params.log"), iaToNum(fx.ia)).writes)]);
    expect(ours).toEqual([[0x2366, 0x20]]);
  }, 30_000); // builds the OpenKNX application, as the full-download comparison above (3.4 s alone, 8.4 s in a loaded check)
});

// The MDT IP Interface/Router's web interface password P-278 (20 bytes at offset 40) reads FF after any write. ETS's
// parameter downloads compare with its record and leave the field (no byte of it in either partial log); Busforge's
// flash compares with its read, so a byte read as FF is decided against the baseline instead (leaveUnreadUnchanged):
// the device name shortened and set back with the password unchanged since the last programming, the flash writes
// exactly ETS's bytes with the record, and without one every owned byte but the password's.
corpusDescribe("the MDT IP router's web interface password in a parameter flash", () => {
  const xml = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const params = new Map((JSON.parse(captureText("mdt-router-unit-config.json")) as { params: [string, string][] }).params);
  const A = "M-0083_A-0137-20-7EB2";
  const NAME = `${A}_P-162_R-162`, PW_REF = `${A}_P-278_R-278`;
  const PW = { offset: 40, size: 20 };
  const field = (o: number) => o >= PW.offset && o < PW.offset + PW.size;
  const target = (values: Map<string, string>) => buildRelativeSegmentTarget(cfg, values, 4, { ownIdleUnionDefaults: true })!;
  // The shorter name: "MDT " and what ETS wrote from the field's fifth byte up to its first zero byte.
  const short = "MDT " + Buffer.from([...relImage("mdt-router-ets6log-partial-name.txt").get(4)!].sort(([a], [b]) => a - b).map(([, b]) => b)).toString("latin1").split("\0")[0];
  const nameIn = (file: string) => (file.includes("revert") ? [short, params.get(NAME)!] : [params.get(NAME)!, short]);
  const flash = (from: string, to: string, values: Map<string, string>, record: ReturnType<typeof stampCheck> | null) => {
    const base = target(new Map(params).set(NAME, from));
    const next = target(new Map(values).set(NAME, to));
    const unit = Buffer.from(base.bytes);
    unit.fill(0xff, PW.offset, PW.offset + PW.size);
    const { target: t, left } = leaveUnreadUnchanged(unit, next, base, 0);
    const { image } = mergeRelativeTarget(unit, t);
    const mask = relativeParWriteSet(image, unit, t.owned, declaredMcbWrites(proc, t.size, "par"), record);
    return { left, base, next, written: new Map(ownedRuns(image, mask).flatMap((r) => [...r.bytes].map((b, i) => [r.offset + i, b] as [number, number]))), owned: t.owned };
  };
  test("the project's password is a value the field holds", () => {
    expect(params.has(PW_REF)).toBe(true);
    expect(target(params).bytes.subarray(PW.offset, PW.offset + PW.size).some((b) => b !== 0)).toBe(true);
  });
  for (const [before, file] of [["mdt-router-ets6log-fulldownload.txt", "mdt-router-ets6log-partial-name.txt"], ["mdt-router-ets6log-partial-name.txt", "mdt-router-ets6log-partial-name-revert.txt"]] as const) {
    test(`${file}: with the record ETS's bytes and no other, without one every owned byte but the password's`, () => {
      const [from, to] = nameIn(file);
      const ets = relImage(file).get(4)!;
      expect([...ets.keys()].filter(field)).toEqual([]);
      const withRecord = flash(from, to, new Map(params), stampCheck(logStamps(before).closing, file));
      expect(withRecord.left).toEqual([{ address: PW.offset, length: PW.size }]);
      expect([...withRecord.written].sort(([a], [b]) => a - b)).toEqual([...ets].sort(([a], [b]) => a - b));
      const without = flash(from, to, new Map(params), null);
      expect([...without.written.keys()].filter(field)).toEqual([]);
      expect(without.written.size).toBe(without.owned.filter((m, o) => m !== 0 && !field(o)).length);
    });
  }
  test("a password changed in the project goes out, as ETS's differential sends what differs from its record", () => {
    const [from, to] = nameIn("mdt-router-ets6log-partial-name.txt");
    const changed = flash(from, to, new Map(params).set(PW_REF, "another"), stampCheck(logStamps("mdt-router-ets6log-fulldownload.txt").closing, "mdt-router-ets6log-partial-name.txt"));
    const bytes = Array.from({ length: PW.size }, (_, i) => PW.offset + i);
    const differs = bytes.filter((o) => changed.next.bytes[o] !== changed.base.bytes[o]);
    expect(differs.length).toBeGreaterThan(0);
    // The field's bytes the new password leaves as they were (its zero tail) stay alone; the others go out with their value.
    const leftBytes = changed.left.flatMap((r) => Array.from({ length: r.length }, (_, i) => r.address + i));
    expect(leftBytes).toEqual(bytes.filter((o) => !differs.includes(o)));
    expect(differs.map((o) => changed.written.get(o))).toEqual(differs.map((o) => changed.next.bytes[o]));
  });
});
