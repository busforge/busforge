import { test, expect, describe } from "bun:test";
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iaToNum, ownedRuns, planSystemBGaFlash, type LoadPlan } from "../packages/knx/src/index.ts";
import { parseAppConfig, classify, parseLoadProcedures, flattenSteps, buildRelativeSegmentTarget, mergeRelativeTarget, buildDeviceConfig, resolveModuleInstances, absoluteStructuralImages, planAbsoluteStructuralFlash, planRelativeStructuralFlash, declaredMcbWrites, planRelativeParFlash, withClosingWrites, closingPropWrites, toAppModel, decodeAbsoluteImage, decodeGroupTablesMv0705, buildGroupTablesMv0705, buildAbsoluteSegmentTargets, parameterMemoryBytes, planAbsoluteParFlash, withLinkedCommFlags, planCapturedSystem7GaFlash, planDeclaredOrderSystem7GaFlash, comObjInstanceOverride } from "../packages/product/src/index.ts";
import { catalogueDir, catalogueXml, captureText, capturePath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { parseCapture, parseTunnelFrame, memoryImage, etsAllocations, reportedTableReferences, compareSegments, parseGa, inferBase } from "./etsdiff.ts";

// One proxy log line carrying a KNXnet/IP TUNNELLING_REQUEST with an L_Data frame.
function line(dir: "ETS->BRIDGE" | "BRIDGE->ETS", code: number, src: string, dst: string, tpdu: number[]): string {
  const cemi = [code, 0x00, 0xb0, 0x60, ...u16(iaToNum(src)), ...u16(iaToNum(dst)), tpdu.length - 1, ...tpdu];
  const body = [0x04, 0x01, 0x00, 0x00, ...cemi];
  const frame = [0x06, 0x10, 0x04, 0x20, ...u16(6 + body.length), ...body];
  return `2026-07-22T10:42:17.387Z ${dir} TUNNELLING_REQ req ${src}->${dst} | ${Buffer.from(frame).toString("hex")}`;
}
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const memWrite = (addr: number, data: number[]) => [0x42, 0x80 | data.length, ...u16(addr), ...data];
const memExtWrite = (addr: number, data: number[]) => [0x41, 0xfb, data.length, (addr >> 16) & 0xff, (addr >> 8) & 0xff, addr & 0xff, ...data];
const propWrite = (obj: number, pid: number, data: number[]) => [0x43, 0xd7, obj, pid, 0x10, 0x01, ...data];
const propResponse = (obj: number, pid: number, data: number[]) => [0x43, 0xd6, obj, pid, 0x10, 0x01, ...data];
const DEV = "1.1.56";

describe("capture parsing", () => {
  test("both memory write services, only to the device, replayed in order", () => {
    const cap = parseCapture([
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memWrite(0x4000, [1, 2, 3])),
      line("ETS->BRIDGE", 0x11, "0.0.0", "1.1.57", memWrite(0x4000, [9])),
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memExtWrite(0x10054, [7, 8])),
      line("ETS->BRIDGE", 0x11, "0.0.0", DEV, memWrite(0x4001, [0xaa])),
      // the bridge's confirmation echoes an ETS request; it is not a second write
      line("BRIDGE->ETS", 0x2e, "1.1.100", DEV, memWrite(0x4002, [0xbb])),
      "2026-07-22T10:42:11.147Z --- ETS connected, bridge up ---",
    ].join("\n"), iaToNum(DEV));
    expect(cap.writes.map((w) => [w.service, w.addr, [...w.data]])).toEqual([
      ["A_Memory_Write", 0x4000, [1, 2, 3]],
      ["A_MemoryExtended_Write", 0x10054, [7, 8]],
      ["A_Memory_Write", 0x4001, [0xaa]],
    ]);
    expect(cap.otherDestination).toBe(1);
    expect([...memoryImage(cap.writes)]).toEqual([[0x4000, 1], [0x4001, 0xaa], [0x4002, 3], [0x10054, 7], [0x10055, 8]]);
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
      line("BRIDGE->ETS", 0x29, "1.1.57", "0.0.0", propResponse(3, 7, [0, 0, 0x10, 0])), // another device
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
    expect([parseGa("3/3/1"), parseGa("3/769"), parseGa("6913")]).toEqual([0x1b01, 0x1b01, 0x1b01]);
    expect(() => parseGa("3/8/1")).toThrow();
  });
});

// Two ETS 6 full downloads of the MDT BE-02001.02 (mask MV-0705) through the logging proxy, trimmed
// to the TUNNELLING_REQ lines: application defaults with no links, and the same with input A's
// object #0 linked to 3/3/1. The debounce time P-7 carries LegacyPatchAlways: its <Data> byte is
// 0x32 (50 ms), and ETS writes the parameter's value 0x1e (30 ms) over it.
corpusDescribe("MDT BE-02001.02 full download against ETS", () => {
  const xml = catalogueXml("M-0083_A-00B6-32-9642.xml.gz");
  const cfg = parseAppConfig(xml);
  const run = (capture: string, links: { comObjNum: number; gaRaws: number[] }[]) => {
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: DEV, params: new Map(), links, proc: parseLoadProcedures(xml) });
    const cap = parseCapture(captureText(capture), iaToNum(DEV));
    return compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "declared" })), memoryImage(cap.writes), etsAllocations(cap), []);
  };
  const summary = (r: ReturnType<typeof run>) => r.segments.map((s) => [s.id.split("_").pop(), s.compared, s.divergences.length, s.busforgeOnly]);

  test("at defaults: every byte ETS wrote matches, the debounce time included", () => {
    const r = run("mdt-be02001-ets-fulldownload-defaults.log", []);
    expect(summary(r)).toEqual([["AS-4000", 1, 0, [1, 2]], ["AS-4201", 1, 0, []], ["AS-4400", 104, 0, []], ["AS-4468", 168, 0, []]]);
    expect(r.unattributed).toEqual([]);
  });

  test("with one link: the group tables and the linked object's flags match too", () => {
    const r = run("mdt-be02001-ets-fulldownload-linked.log", [{ comObjNum: 0, gaRaws: [parseGa("3/3/1")] }]);
    expect(summary(r)).toEqual([["AS-4000", 3, 0, [1, 2]], ["AS-4201", 3, 0, []], ["AS-4400", 104, 0, []], ["AS-4468", 168, 0, []]]);
    expect(r.unattributed).toEqual([]);
  });

  test("the linked capture is not matched by a link-less image", () => {
    const r = run("mdt-be02001-ets-fulldownload-linked.log", []);
    expect(r.segments.slice(0, 3).map((s) => s.divergences.length + s.etsOnly.length)).not.toEqual([0, 0, 0]);
  });
});

// ETS 6 full download of the GVS AMMA-04/06.S (System B, fill 0xFF) at application defaults, where
// every output is disabled and no com-object is active; trimmed to the frames to and from 1.1.203.
corpusDescribe("GVS AMMA full download against ETS", () => {
  test("every byte matches: silent com-object table, and each idle union holds its default member", () => {
    const xml = catalogueXml("M-0085_A-0072-30-69AA.xml.gz");
    const cfg = parseAppConfig(xml);
    const ia = iaToNum("1.1.203");
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.203", params: new Map(), links: [], proc: parseLoadProcedures(xml) });
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
  const ia = iaToNum("1.1.203");
  const CLOSING = ["prop 4/67=01", "restart"];

  test("the captures: PID 67 = 01 after the last LoadCompleted, echoed, then the restart", () => {
    for (const f of ["gvs-amma-ets-fulldownload-defaults.log", "gvs-amma-ets-partial-links.log"]) {
      expect(etsClosing(captureText(f), ia)).toEqual(CLOSING);
      expect(parseCapture(captureText(f), ia).propResponses.filter((r) => r.obj === 4 && r.pid === 67).map((r) => r.data.toString("hex"))).toEqual(["01"]);
    }
  });

  test("Busforge's full download ends like ETS's full download", () => {
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.203", params: new Map(), links: [], proc });
    expect(planClosing(build.plan)).toEqual(etsClosing(captureText("gvs-amma-ets-fulldownload-defaults.log"), ia));
  });

  test("Busforge's parameter flash and group-address flash end like ETS's partial download of parameters and links", () => {
    const ets = etsClosing(captureText("gvs-amma-ets-partial-links.log"), ia);
    const par = withClosingWrites(planRelativeParFlash(4, Buffer.alloc(2816), [], 0x4000, Buffer.from("0085007230", "hex"), false), closingPropWrites(proc, "par"));
    const ga = withClosingWrites(planSystemBGaFlash({ addr: Buffer.alloc(4), assoc: Buffer.alloc(4), comObj: Buffer.alloc(4) }, false), closingPropWrites(cfg.loadProcedures, "grp"));
    expect(planClosing(par)).toEqual(ets);
    expect(planClosing(ga)).toEqual(ets);
  });
});

// ETS 6 full download of the Jung 400021SE (System B, module device, segment above 64 KB) at the
// project's configuration: two module instances, no links; trimmed to the frames to and from 1.1.204.
corpusDescribe("Jung 400021SE full download against ETS", () => {
  test("every byte matches, including the union a hidden ParameterRef's own default would flip", () => {
    const xml = catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz");
    const cfg = parseAppConfig(xml);
    const ia = iaToNum("1.1.204");
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.204", params: new Map(), links: [], proc: parseLoadProcedures(xml) });
    const cap = parseCapture(captureText("jung-400021se-ets-fulldownload.log"), ia);
    const refs = reportedTableReferences(cap);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.divergences.map((d) => d.offset)])).toEqual([[4, []], [3, []], [2, []], [1, []]]);
  });
});

// ETS 6 partial downloads after linking objects to group addresses (and, on ABB and GVS, enabling
// a channel), 2026-09-26, trimmed per device. Every byte ETS wrote must equal the image Busforge
// builds for the same configuration: parameters, com-object table and group tables.
corpusDescribe("partial downloads with links against ETS", () => {
  const real = catalogueXml;
  const cases: { name: string; ia: string; app: string; params: [string, string][]; links: [number, string][] }[] = [
    { name: "Jung 400021SE", ia: "1.1.204", app: "M-0004_A-7072-21-99A7-O000A.xml.gz", links: [[253, "3/3/2"], [254, "3/3/3"]],
      params: [["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_P-496_R-106", "1"]] },
    { name: "ABB US/U 4.2", ia: "1.1.201", app: "M-0002_A-A001-13-63C2.xml.gz", links: [[1, "3/3/4"]], params: [["M-0002_A-A001-13-63C2_P-9_R-9", "104"]] },
    { name: "MDT BE-02001.02", ia: "1.1.56", app: "M-0083_A-00B6-32-9642.xml.gz", links: [[0, "3/3/1"], [6, "3/3/5"]], params: [] },
    { name: "GVS AMMA", ia: "1.1.203", app: "M-0085_A-0072-30-69AA.xml.gz", links: [[2, "3/3/6"]], params: [["M-0085_A-0072-30-69AA_P-20_R-20", "1"], ["M-0085_A-0072-30-69AA_UP-142_R-142", "1"]] },
  ];
  const file = { "1.1.204": "jung-400021se", "1.1.201": "abb-usu-4.2", "1.1.56": "mdt-be02001", "1.1.203": "gvs-amma" } as Record<string, string>;
  for (const c of cases) {
    test(`${c.name}: every byte ETS wrote matches`, () => {
      const xml = real(c.app);
      const cfg = parseAppConfig(xml);
      const build = classify(cfg).planFullDownload(cfg.mask, { ia: c.ia, params: new Map(c.params), links: c.links.map(([n, ga]) => ({ comObjNum: n, gaRaws: [parseGa(ga)] })), proc: parseLoadProcedures(xml) });
      const cap = parseCapture(captureText(`${file[c.ia]}-ets-partial-links.log`), iaToNum(c.ia));
      const refs = reportedTableReferences(cap);
      const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address ?? refs.get(seg.lsm) ?? null, baseSource: "t" })), memoryImage(cap.writes), etsAllocations(cap), []);
      const compared = r.segments.reduce((n, s) => n + s.compared, 0);
      expect(compared).toBeGreaterThan(0);
      expect(r.segments.flatMap((s) => s.divergences.map((d) => `${s.id}+${d.offset}`))).toEqual([]);
    });
  }
});

// The same partial downloads, for the System B parameter segment: ETS reallocates it without fill
// and writes exactly the bytes its parameter model owns. Busforge's parameter flash, merged over the
// device's segment as the full download left it, must write the same bytes with the same values.
corpusDescribe("System B parameter flash against ETS's partial download", () => {
  const real = catalogueXml;
  const cases: { name: string; ia: string; app: string; file: string; params: [string, string][] }[] = [
    { name: "Jung 400021SE", ia: "1.1.204", app: "M-0004_A-7072-21-99A7-O000A.xml.gz", file: "jung-400021se",
      params: [["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-150_R-243", "Taster"], ["M-0004_A-7072-21-99A7-O000A_P-496_R-106", "1"]] },
    { name: "GVS AMMA", ia: "1.1.203", app: "M-0085_A-0072-30-69AA.xml.gz", file: "gvs-amma", params: [["M-0085_A-0072-30-69AA_P-20_R-20", "1"], ["M-0085_A-0072-30-69AA_UP-142_R-142", "1"]] },
  ];
  for (const c of cases) {
    test(`${c.name}: the same bytes, with the same values`, () => {
      const xml = real(c.app);
      const cfg = parseAppConfig(xml);
      const before = classify(cfg).planFullDownload(cfg.mask, { ia: c.ia, params: new Map(), links: [], proc: parseLoadProcedures(xml) }).segments.find((s) => s.lsm === 4)!.image;
      const target = buildRelativeSegmentTarget(cfg, new Map(c.params), 4, { ownIdleUnionDefaults: true })!;
      const { image } = mergeRelativeTarget(Buffer.from(before), target);
      const ours = new Map<number, number>();
      for (const r of ownedRuns(image, target.owned)) r.bytes.forEach((b, i) => ours.set(r.offset + i, b));
      const cap = parseCapture(captureText(`${c.file}-ets-partial-links.log`), iaToNum(c.ia));
      const base = reportedTableReferences(cap).get(4)!;
      const ets = new Map([...memoryImage(cap.writes)].filter(([a]) => a >= base && a < base + target.size).map(([a, b]) => [a - base, b]));
      expect([...ours.keys()].sort((a, b) => a - b)).toEqual([...ets.keys()].sort((a, b) => a - b));
      expect([...ours].filter(([o, b]) => ets.get(o) !== b)).toEqual([]);
    });
  }
});

// ETS 6 partial downloads of a change that alters the com-object table, 2026-10-01. Jung 400021SE: K2
// switched from "Dimmen und Farbtemperatur" back to "Schalten" (secured; decrypted, the security
// object's writes left out). MDT BE-02001.02: input B switched from the two-object short/long function
// back to "Kontaktzustand senden" (object 8 goes), after an ETS full download with the two-object one.
corpusDescribe("structural flash against ETS's partial download", () => {
  const real = catalogueXml;

  test("MDT BE-02001.02: Busforge writes exactly the bytes ETS changed, with ETS's values, LSM by LSM", () => {
    const xml = real("M-0083_A-00B6-32-9642.xml.gz");
    const cfg = parseAppConfig(xml);
    const ia = iaToNum(DEV);
    const before = memoryImage(parseCapture(captureText("mdt-be02001-ets-fulldownload-b7.log"), ia).writes);
    const ets = memoryImage(parseCapture(captureText("mdt-be02001-ets-partial-structure.log"), ia).writes);
    const params = new Map<string, string>();
    const instances = resolveModuleInstances(cfg, params);
    const view = buildDeviceConfig(cfg, params, undefined, instances);
    // The device's programmed baseline is the configuration ETS downloaded in full: input B short/long.
    const baseValues = new Map([["M-0083_A-00B6-32-9642_MD-2_M-3_MI-1_P-24_R-2", "7"]]);
    const images = absoluteStructuralImages(cfg, params, [], ia, { baseValues, moduleInstances: instances, comObjectTable: { active: view.imageComObjects, linked: new Set() } });
    // ETS's full download leaves the address table's own individual address to the device (it holds it
    // already), so those two bytes are the only ones the capture does not show; the device holds 1.1.56.
    const unseen = images.flatMap((w) => Array.from({ length: w.image.length }, (_, i) => w.address + i)).filter((a) => !before.has(a));
    expect(unseen).toEqual([0x4001, 0x4002]);
    before.set(0x4001, 0x11).set(0x4002, 0x38);
    const current = new Map(images.map((w) => [w.address, Buffer.from(Array.from({ length: w.image.length }, (_, i) => before.get(w.address + i)!))]));
    const { plan, lsms } = planAbsoluteStructuralFlash(images, parseLoadProcedures(xml), current);
    const ours = new Map<number, number>();
    for (const st of plan) if (st.op === "writeMem") st.bytes.forEach((b, i) => ours.set(st.address + i, b));
    const changedByEts = [...ets].filter(([a, b]) => before.get(a) !== b);
    expect(changedByEts.length).toBeGreaterThan(0);
    expect([...ours].filter(([a, b]) => ets.get(a) !== b)).toEqual([]);
    expect(changedByEts.filter(([a]) => !ours.has(a))).toEqual([]);
    expect(lsms).toEqual([3]);
    expect(plan.map((st) => st.op).filter((op) => op !== "writeMem")).toEqual(["load", "loadCompleted", "restart"]);
  });

  test("Jung 400021SE: every byte ETS wrote matches Busforge's image", () => {
    const xml = real("M-0004_A-7072-21-99A7-O000A.xml.gz");
    const cfg = parseAppConfig(xml);
    const params: [string, string][] = [
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-154_R-220", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-150_R-243", "Taster"],
      ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-154_R-220", "Taster"], ["M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-150_R-243", "Taster"],
    ];
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.204", params: new Map(params), links: [{ comObjNum: 253, gaRaws: [parseGa("0/0/1")] }], proc: parseLoadProcedures(xml) });
    const cap = parseCapture(captureText("jung-400021se-ets-partial-structure.log"), iaToNum("1.1.204"));
    const refs = reportedTableReferences(cap);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.compared, s.divergences.length])).toEqual([[4, 25, 0], [3, 7, 0], [2, 6, 0], [1, 4, 0]]);
    expect(r.unattributed).toEqual([]);
  });

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
  });
});

// The CLI's partial mode, end to end: one record per Busforge flash operation that the partial
// download touched, and none for an operation whose segments ETS left alone.
corpusDescribe("etsdiff --partial evidence", () => {
  const realDir = catalogueDir();
  const cli = async (args: string[]) => {
    const out = join(tmpdir(), `etsdiff-partial-${crypto.randomUUID()}.json`);
    const p = Bun.spawnSync(["bun", "run", join(import.meta.dir, "etsdiff.ts"), ...args, "--partial", `--evidence=${out}`], { stdout: "pipe", stderr: "pipe" });
    const written = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as { scope: { operation: string }; results: { reference: { state: string; detail?: string } } }[] : null;
    rmSync(out, { force: true });
    return { exitCode: p.exitCode, records: written?.map((r) => [r.scope.operation, r.results.reference.state]) ?? null, details: written?.map((r) => r.results.reference.detail) ?? [], stderr: p.stderr.toString() };
  };
  test("GVS AMMA: parameters and links, one pass each", async () => {
    const r = await cli([capturePath("gvs-amma-ets-partial-links.log"), `--app=${join(realDir, "M-0085_A-0072-30-69AA.xml.gz")}`, "--ia=1.1.203",
      "--param=M-0085_A-0072-30-69AA_P-20_R-20=1", "--param=M-0085_A-0072-30-69AA_UP-142_R-142=1", "--link=2:3/3/6"]);
    expect([r.exitCode, r.records]).toEqual([0, [["flashParams", "pass"], ["flashLinks", "pass"]]]);
  });
  test("MDT BE-02001.02: links only, so no parameter record", async () => {
    const r = await cli([capturePath("mdt-be02001-ets-partial-links.log"), `--app=${join(realDir, "M-0083_A-00B6-32-9642.xml.gz")}`, "--ia=1.1.56", "--link=0:3/3/1", "--link=6:3/3/5"]);
    expect([r.exitCode, r.records]).toEqual([0, [["flashLinks", "pass"]]]);
  });
  test("a configuration ETS did not download fails, and its record says so", async () => {
    const r = await cli([capturePath("mdt-be02001-ets-partial-links.log"), `--app=${join(realDir, "M-0083_A-00B6-32-9642.xml.gz")}`, "--ia=1.1.56", "--link=0:3/3/1"]);
    expect([r.exitCode, r.records]).toEqual([1, [["flashLinks", "fail"]]]);
  });
  // GVS AMMA (System B): the parameter segment is placed by the device's table reference and
  // matches; ETS also allocated the association table (a fill and no write) but the capture holds
  // no table reference for it, so that segment could not be compared.
  test("a table ETS allocated but the capture cannot place is a failed record, not a silent pass", async () => {
    const xml = catalogueXml("M-0085_A-0072-30-69AA.xml.gz");
    const cfg = parseAppConfig(xml);
    const params = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.203", params: new Map(), links: [], proc: parseLoadProcedures(xml) }).segments.find((s) => s.lsm === 4)!;
    const base = 0x3fc6;
    const capture = join(tmpdir(), `etsdiff-gvs-${crypto.randomUUID()}.log`);
    writeFileSync(capture, [
      line("BRIDGE->ETS", 0x29, "1.1.203", "0.0.0", propResponse(4, 7, [0, 0, base >> 8, base & 0xff])),
      line("ETS->BRIDGE", 0x11, "0.0.0", "1.1.203", memWrite(base, [...params.image.subarray(0, 4)])),
      line("ETS->BRIDGE", 0x11, "0.0.0", "1.1.203", propWrite(2, 5, [0x03, 0x0b, 0, 0, 0, 0x02, 0, 0, 0, 0])),
    ].join("\n"));
    const r = await cli([capture, `--app=${join(realDir, "M-0085_A-0072-30-69AA.xml.gz")}`, "--ia=1.1.203"]);
    rmSync(capture, { force: true });
    expect([r.exitCode, r.records]).toEqual([1, [["flashParams", "pass"], ["flashLinks", "fail"]]]);
    expect(r.details[1]).toContain("L2 association table not compared, address unknown");
    expect(r.details[1]).toContain("L1 address table not written by this partial download");
  });
});

// What ETS sent to the device from its first load-state event on, as steps: load-state events,
// segment declarations, one "write" per run of memory writes, device-control writes, property reads,
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
      out.push(d[0] === 3 ? (d[1] === 0 ? `absSegment:${t[2]}@${d.readUInt16BE(2)}+${d.readUInt16BE(4)}` : d[1] === 4 ? `taskCtrl1:${t[2]}=${d.subarray(2).toString("hex")}` : `taskSegment:${t[2]}@${d.readUInt16BE(2)}=${d.subarray(4).toString("hex")}`)
        : `${({ 1: "load", 2: "loadCompleted", 4: "unload" } as Record<number, string>)[d[0]]}:${t[2]}`);
    } else if (!out.length) continue;
    else if (apci === 0x3d7) out.push(`prop ${t[2]}/${t[3]}=${t.subarray(6).toString("hex")}`);
    else if (apci === 0x3d5) {
      // A read sent again right after itself is ETS repeating a request that got no answer in time
      // (gira-m0008-ets-partial-links.log, 3/27 element 6), not a second step.
      const step = `read ${t[2]}/${t[3]}#${((t[4] & 0x0f) << 8) | t[5]}`;
      if (out.at(-1) !== step) out.push(step);
    }
    else if ((apci & 0x3f0) === 0x280) { if (out.at(-1) !== "write") out.push("write"); }
    else if ((apci & 0x3c0) === 0x380) out.push("restart");
  }
  return out;
}
function planSteps(plan: LoadPlan): string[] {
  const out: string[] = [];
  for (const s of plan) {
    if (s.op === "absSegment") out.push(`absSegment:${s.lsm}@${s.address}+${s.size}`);
    else if (s.op === "taskSegment") out.push(`taskSegment:${s.lsm}@${s.address}=${Buffer.from([s.peiType, s.manufacturer >> 8, s.manufacturer & 0xff, s.appNumber >> 8, s.appNumber & 0xff, s.version]).toString("hex")}`);
    else if (s.op === "unload" || s.op === "load" || s.op === "loadCompleted") out.push(`${s.op}:${s.lsm}`);
    else if (s.op === "writeMem") { if (out.at(-1) !== "write") out.push("write"); }
    else if (s.op === "readProp") out.push(`read ${s.obj}/${s.pid}#${s.start}`);
    else if (s.op === "taskCtrl1") out.push(`taskCtrl1:${s.lsm}=${Buffer.from([s.address >> 8, s.address & 0xff, s.count, 0, 0, 0, 0, 0]).toString("hex")}`);
    else if (s.op === "restart") out.push("restart");
    else out.push(s.op);
  }
  return out;
}
// ETS switches the device into verify mode before its first memory write (reads device control,
// object 0 PID 14, and writes 04) and takes the device's echo of each write. Busforge reads every write back instead
// (KnxDevice.memWrite), the proof the MV-0705 parameter flash is hardware-proven on, so this is the
// one step of ETS's it leaves out.
const VERIFY_MODE = ["read 0/14#1", "prop 0/14=04"];
const withoutVerifyMode = (steps: string[]) => {
  const at = steps.indexOf(VERIFY_MODE[1]);
  expect([steps.filter((s) => VERIFY_MODE.includes(s)), steps[at - 1]]).toEqual([VERIFY_MODE, VERIFY_MODE[0]]);
  return steps.filter((s) => !VERIFY_MODE.includes(s));
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

// ETS 6 downloads of the Gira Tastsensor 3 Komfort (M-0008, MV-0705, DynamicTableManagement),
// house bus: a full download, a partial download after one parameter change (status LED
// on-time 3 s -> 4 s), one after linking object 4 to 15/7/250, and the partial download that reverted
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
  const IA = "1.2.7", ia = iaToNum(IA);
  const revert = memoryImage(parseCapture(captureText("gira-m0008-ets-partial-revert.log"), ia).writes);

  // The configuration ETS downloaded in the revert (the house project's), read from its bytes.
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
    // The function of each rocker has no memory location, so no image shows it; the house project
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
    classify(cfg).planFullDownload(cfg.mask, { ia: IA, params, links, proc });

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
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: baseline.params, links: baseline.links, proc, comObjectOverrides: object64Read });
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
  // declares the read flag off (0x47): the house project sets it on this device (ComObjectInstanceRef
  // ReadFlag="Enabled"). The project is not in the corpus, so the override is given here as the import
  // stores it; with it every byte matches, without it exactly that byte does not.
  const object64Read = new Map([[64, comObjInstanceOverride({ ReadFlag: "Enabled" })]]);
  test("the whole application image matches what ETS rewrote in the revert, object 64's project read flag included", () => {
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: baseline.params, links: baseline.links, proc, comObjectOverrides: object64Read });
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), revert, new Map(), []);
    expect(r.segments.flatMap((s) => s.divergences)).toEqual([]);
    expect(r.segments.find((s) => s.id.endsWith("AS-41E5"))!.compared).toBeGreaterThan(3 + 64 * 4 + 2);
    expect(r.unattributed).toEqual([]);
    expect(planSteps(build.plan)).toEqual(withoutVerifyMode(etsSteps("gira-m0008-ets-partial-revert.log")));
    const without = full(baseline.params, baseline.links);
    const w = compareSegments(without.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), revert, new Map(), []);
    expect(w.segments.flatMap((s) => s.divergences.map((d) => [s.id.split("_").pop(), d.offset, d.busforge, d.ets]))).toEqual([["AS-41E5", 3 + 64 * 4 + 2, 0x47, 0x4f]]);
  });

  test("parameter flash: Busforge writes the changed byte with ETS's value, in ETS's bracket", () => {
    const ref = [...baseline.params.keys()].find((k) => k.includes("_P-3764_"))!;
    expect(baseline.params.get(ref)).toBe("30");
    const after = new Map(baseline.params).set(ref, "40");
    const current = new Map(buildAbsoluteSegmentTargets(cfg, baseline.params).map((t) => [t.id, t.bytes]));
    const { plan, changedBytes } = planAbsoluteParFlash(cfg, after, proc, current);
    expect(changedBytes).toBe(1);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(etsSteps("gira-m0008-ets-partial-params.log")));
    const ets = memoryImage(parseCapture(captureText("gira-m0008-ets-partial-params.log"), ia).writes);
    const ours = bytesOf(plan);
    expect([...ours].filter(([a, b]) => ets.get(a) !== b)).toEqual([]);
    // ETS writes the rest of its 4-byte run at $435C and the download marker, each already on the
    // device; Busforge compares against what it read and writes the one byte that differs.
    const etsOnly = [...ets.keys()].filter((a) => !ours.has(a));
    expect(span(etsOnly)).toEqual(["435c-435e", "454e-4550"]);
    const held = new Map([...current.entries()].flatMap(([id, b]) => { const s = cfg.absoluteSegments.find((x) => x.id === id)!; return [...b].map((v, i) => [s.address + i, v] as [number, number]); }));
    expect(etsOnly.filter((a) => held.get(a) !== ets.get(a))).toEqual([]);
  });

  // The group-address flash keeps the com-object table the device holds and changes only the link
  // bits (System7Profile.flashGroupTables). What the device holds there: the segment's template under
  // the bytes ETS wrote in a download (its last 8 bytes, which no ETS image holds, from the template).
  const comObjSeg = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
  const heldComObj = (written: Map<number, number>) => Buffer.from(comObjSeg.data.map((b, i) => written.get(comObjSeg.address + i) ?? b));
  const gaFlash = (links: { comObjNum: number; gaRaws: number[] }[], held: Buffer) => planCapturedSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia, { order: "ets-captured" }),
    { address: comObjSeg.address, bytes: withLinkedCommFlags(held, new Set(links.map((l) => l.comObjNum))) });
  const withTestLink = [...baseline.links, { comObjNum: 4, gaRaws: [parseGa("15/7/250")] }].sort((a, b) => a.comObjNum - b.comObjNum);
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
});

// ETS 6 downloads of the Auro presence detector (M-0081_A-FE01-11-75D9, MV-0705, LdCtrlTaskCtrl1),
// house unit, in this order: a full download; a partial download after one parameter
// change ("led feedback" to "no led feedback", AS-4200 offset 7, 01 -> 00); one after adding 15/7/250
// as a second address on object 10; and one that reverted both (parameters and links in one). ETS runs this application's
// declared steps in their declared order (loadproc.ts ETS_DECLARED_ORDER_SYSTEM7_APPS). The project
// is not in the corpus. The configuration is read from what ETS wrote in the full download: the links
// from its tables, the parameter values decoded by Busforge from the 50 parameter bytes it wrote.
corpusDescribe("Auro presence detector (M-0081_A-FE01-11-75D9) against ETS", () => {
  const xml = catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const IA = "1.2.3", ia = iaToNum(IA);
  const FULL = "auro-m0081-ets-fulldownload.log", PARTIAL = "auro-m0081-ets-partial-params.log";
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

  test("the configuration read from the full download: two linked objects, every parameter decoded", () => {
    expect(baseline.links).toEqual([{ comObjNum: 9, gaRaws: [0x1807] }, { comObjNum: 10, gaRaws: [0x050a] }]);
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

  test("parameter flash: ETS's bracket, and the one changed byte with ETS's value; ETS also writes every unchanged parameter byte", () => {
    const led = [...baseline.params.keys()].find((k) => k.startsWith(`${LED}_`))!;
    const after = new Map(baseline.params).set(led, "0");
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, after, proc, new Map([[paramSeg.id, held]]));
    expect([changedBytes, unplaceable]).toEqual([1, []]);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(PARTIAL, ia)));
    expect(planSteps(plan)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    const ets = memoryImage(parseCapture(captureText(PARTIAL), ia).writes);
    const ours = bytesOf(plan);
    expect([...ours]).toEqual([[0x4207, 0x00]]);
    expect(ets.get(0x4207)).toBe(0x00);
    // ETS writes every byte a parameter owns, AS-4200 offsets 0-49 but 3 and 36; Busforge writes the
    // byte that differs from what it read. Every byte only ETS writes is what the device already holds.
    const etsOnly = [...ets.keys()].filter((a) => !ours.has(a));
    expect(span(etsOnly)).toEqual(["4200-4202", "4204-4206", "4208-4223", "4225-4231"]);
    expect(etsOnly.filter((a) => held[a - paramSeg.address] !== ets.get(a))).toEqual([]);
  });

  // The com-object table the device holds after ETS's full download, with the link bits of `links`, as
  // the group-address flash builds it from a read of the device (System7Profile.flashGroupTables).
  const comObjSeg = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
  const heldComObj = Buffer.from(comObjSeg.data.map((b, i) => written.get(comObjSeg.address + i) ?? b));
  const gaFlash = (links: { comObjNum: number; gaRaws: number[] }[], deviceComObj: Buffer = heldComObj) =>
    planDeclaredOrderSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia), { address: comObjSeg.address, bytes: withLinkedCommFlags(deviceComObj, new Set(links.map((l) => l.comObjNum))) });
  const second = baseline.links.map((l) => (l.comObjNum === 10 ? { ...l, gaRaws: [...l.gaRaws, parseGa("15/7/250")] } : l));
  const TABLE_BRACKETS = (t: string) => [
    "unload:1", "unload:2",
    "load:1", "absSegment:1@16384+47", "write", t.replace("%", "1@16384"), "loadCompleted:1",
    "load:2", "absSegment:2@16431+45", "write", t.replace("%", "2@16431"), "loadCompleted:2",
    "load:3", "write", "loadCompleted:3", "restart",
  ];

  test("group-address flash: ETS's partial download, the tables in their declared brackets, the com-object table whole", () => {
    expect(parseGa("15/7/250")).toBe(0x7ffa);
    const { plan, segments } = gaFlash(second);
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
    expect(span(segments.flatMap((w) => Array.from(w.image, (_, i) => w.address + i)))).toEqual(span(ours));
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
    expect([...bytesOf(par.plan)]).toEqual([[0x4207, 0x01]]);
    expect(ets.get(0x4207)).toBe(0x01);
    // Every byte ETS writes beyond the tables and the com-object table is a parameter byte of the full
    // download's image, with its value; offsets 3 and 36 (no parameter) are not among them.
    const image = bytesOf(full().plan);
    const params = [...ets].filter(([a]) => !ga.has(a));
    expect(span(params.map(([a]) => a))).toEqual(["4200-4202", "4204-4223", "4225-4231"]);
    expect(params.filter(([a, b]) => image.get(a) !== b)).toEqual([]);
  });

  test("a table that shrinks leaves its old bytes behind it, in ETS's download and in Busforge's", () => {
    const links = memoryImage(parseCapture(captureText(LINKS), ia).writes);
    const revert = memoryImage(parseCapture(captureText(REVERT), ia).writes);
    const behind = [0x4007, 0x4008, 0x4034, 0x4035];
    expect(behind.map((a) => links.get(a))).toEqual([0x7f, 0xfa, 0x03, 0x0a]);
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
});

// ETS 6 downloads of the Theben TheLuxa P300 (M-0048_A-107E-12-5B58, MV-0705, LdCtrlTaskCtrl1 Address
// 17875 Count 1, DynamicTableManagement), house unit, in this order: a full download;
// a partial download after one parameter change ("Temperature calibration in 0.1 °C", AS-4800 offset 19,
// 0 -> 1); one after linking object 16 ("C1 Block", unlinked before) to 15/7/250; and one that reverted
// both. ETS runs the full download's declared steps in their declared order (ETS_DECLARED_ORDER_SYSTEM7_APPS),
// but declares the two table segments as one region, as on the Gira (ETS_REGION_TABLES_SYSTEM7_APPS). The
// project is not in the corpus. The configuration is read from what ETS wrote in the full download: the
// links from its tables, the parameter values decoded by Busforge from the 576-byte parameter segment.
corpusDescribe("Theben TheLuxa P300 (M-0048_A-107E-12-5B58) against ETS", () => {
  const xml = catalogueXml("M-0048_A-107E-12-5B58.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const IA = "1.2.10", ia = iaToNum(IA);
  const FULL = "theluxa-p300-ets-fulldownload.log", PARTIAL = "theluxa-p300-ets-partial-params.log";
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

  test("the configuration read from the full download: object 6 on three addresses, the temperature calibration 0", () => {
    expect(baseline.links).toEqual([{ comObjNum: 6, gaRaws: [0x0014, 0x1800, 0x1801] }]);
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
  // house unit after one of ETS's downloads holds 00 there). What the unit holds after ETS's full download:
  const onUnit = Buffer.from(held);
  onUnit[0] = 0x00;

  test("parameter flash: ETS's bracket, the changed byte and the download marker with ETS's values; ETS also writes every unchanged parameter byte", () => {
    expect(held[0]).toBe(0xaa);
    const after = new Map(baseline.params).set(tempRef(), "1");
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(cfg, after, proc, new Map([[paramSeg.id, onUnit]]));
    expect([changedBytes, unplaceable]).toEqual([2, []]);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(captureSteps(PARTIAL, ia)));
    expect(planSteps(plan)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    const ets = memoryImage(parseCapture(captureText(PARTIAL), ia).writes);
    expect([...bytesOf(plan)]).toEqual([[0x4800, 0xaa], [0x4813, 0x01]]);
    expect([ets.get(0x4800), ets.get(0x4813)]).toEqual([0xaa, 0x01]);
    const etsOnly = [...ets.keys()].filter((a) => a !== 0x4800 && a !== 0x4813);
    expect(etsOnly.filter((a) => onUnit[a - paramSeg.address] !== ets.get(a))).toEqual([]);
  });

  const gaFlash = (links: { comObjNum: number; gaRaws: number[] }[], deviceComObj: Buffer) => planCapturedSystem7GaFlash(cfg, proc, buildGroupTablesMv0705(links, ia, { order: "ets-captured" }),
    { address: comObjSeg.address, bytes: withLinkedCommFlags(deviceComObj, new Set(links.map((l) => l.comObjNum))) });
  const withTestLink = [...baseline.links, { comObjNum: 16, gaRaws: [parseGa("15/7/250")] }];
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
    // The parameter bytes of the revert: the parameter flash writes the one byte back, with ETS's value;
    // every other byte ETS writes there is the full download's.
    const before = Buffer.from(onUnit);
    before[19] = 1;
    const par = planAbsoluteParFlash(cfg, baseline.params, proc, new Map([[paramSeg.id, before]]));
    expect([...bytesOf(par.plan)]).toEqual([[0x4800, 0xaa], [0x4813, 0x00]]);
    expect([revert.get(0x4800), revert.get(0x4813)]).toEqual([0xaa, 0x00]);
    expect([...revert].filter(([a, b]) => a >= 0x4800 && written.get(a) !== b)).toEqual([]);
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
