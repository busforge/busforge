import { test, expect, describe } from "bun:test";
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iaToNum, ownedRuns, planSystemBGaFlash, type LoadPlan } from "../packages/knx/src/index.ts";
import { parseAppConfig, classify, parseLoadProcedures, buildRelativeSegmentTarget, mergeRelativeTarget, buildDeviceConfig, resolveModuleInstances, absoluteStructuralImages, planAbsoluteStructuralFlash, planRelativeStructuralFlash, declaredMcbWrites, planRelativeParFlash, withClosingWrites, closingPropWrites, toAppModel, decodeAbsoluteImage, decodeGroupTablesMv0705, buildGroupTablesMv0705, buildAbsoluteSegmentTargets, planAbsoluteParFlash, withLinkedCommFlags, planCapturedSystem7GaFlash, comObjInstanceOverride } from "../packages/product/src/index.ts";
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

// ETS 6 downloads of the Gira Tastsensor 3 Komfort (M-0008, MV-0705, DynamicTableManagement),
// house bus: a full download, a partial download after one parameter change (status LED
// on-time 3 s -> 4 s), one after linking object 4 to 15/7/250, and the partial download that reverted
// both (ETS's stamps no longer matched, so it rewrote every table and the whole application image).
// The project is not in the corpus. The configuration is read from what ETS wrote in the revert: the
// links from its tables, the parameter values decoded by Busforge from its application image, so the
// parameter bytes below check Busforge's encoding against its own decoding of ETS's bytes, while the
// tables, the com-object table, the plan and its wire sequence are checked against ETS directly.
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

  // What ETS sent to the device from its first load-state event on, as steps: load-state events,
  // segment declarations, one "write" per run of memory writes, device-control writes, property reads,
  // the restart. Its reads before the first event (identity, stamps for its differential download)
  // are not part of the procedure.
  function etsSteps(file: string): string[] {
    const out: string[] = [];
    for (const l of captureText(file).split("\n")) {
      const m = l.includes("ETS->BRIDGE") ? l.match(/\| ([0-9a-fA-F]+)\s*$/) : null;
      const fr = m ? parseTunnelFrame(m[1]) : null;
      if (!fr || fr.group || fr.dst !== ia || fr.tpdu.length < 2) continue;
      const t = fr.tpdu, apci = ((t[0] & 0x03) << 8) | t[1];
      if (apci === 0x3d7 && t[3] === 5) {
        const d = t.subarray(6);
        out.push(d[0] === 3 ? (d[1] === 0 ? `absSegment:${t[2]}@${d.readUInt16BE(2)}+${d.readUInt16BE(4)}` : `taskSegment:${t[2]}@${d.readUInt16BE(2)}=${d.subarray(4).toString("hex")}`)
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

  test("full download: every byte ETS wrote matches; Busforge writes whole segments where ETS leaves out what it takes the device to hold", () => {
    const build = full(baseline.params, baseline.links);
    const cap = parseCapture(captureText("gira-m0008-ets-fulldownload.log"), ia);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "plan" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.flatMap((s) => s.divergences)).toEqual([]);
    expect(r.unattributed).toEqual([]);
    // ETS's differential download: of the tables it skips the address table's individual address,
    // of the application it writes only the download marker AS-454E (SegFlags 0, so no stamp tells
    // ETS the device holds it). Busforge writes everything and reads it back.
    expect(r.segments.map((s) => [s.id.split("_").pop(), s.compared, s.busforgeOnly.length])).toEqual([
      ["AS-4000", 15, 2], ["AS-40F3", 19, 0], ["AS-41E5", 0, 375], ["AS-435C", 0, 13], ["AS-4369", 0, 6], ["AS-436F", 0, 202], ["AS-4439", 0, 21], ["AS-444E", 0, 256], ["AS-454E", 3, 0],
    ]);
    expect(build.segments.find((s) => s.source === "assocTable")!.address).toBe(0x4011);
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

  test("group-address flash: tables re-declared where ETS puts them, the com-object table rewritten with the new link bit", () => {
    const links = [...baseline.links, { comObjNum: 4, gaRaws: [parseGa("15/7/250")] }].sort((a, b) => a.comObjNum - b.comObjNum);
    const tables = buildGroupTablesMv0705(links, ia, { order: "ets-captured" });
    // The group-address flash keeps the com-object table the device holds and changes only the link
    // bits (System7Profile.flashGroupTables); the device's table is the one ETS wrote in the revert,
    // its last 8 bytes, which ETS leaves alone, taken from the segment's template.
    const seg = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
    const held = Buffer.from(seg.data.map((b, i) => revert.get(seg.address + i) ?? b));
    const comObj = { address: seg.address, bytes: withLinkedCommFlags(held, new Set(links.map((l) => l.comObjNum))) };
    const { plan, assocAt } = planCapturedSystem7GaFlash(cfg, proc, tables, comObj);
    expect(assocAt).toBe(0x4013);
    expect(planSteps(plan)).toEqual(withoutVerifyMode(etsSteps("gira-m0008-ets-partial-links.log")));
    const ets = memoryImage(parseCapture(captureText("gira-m0008-ets-partial-links.log"), ia).writes);
    const ours = bytesOf(plan);
    expect([...ours].filter(([a, b]) => ets.has(a) && ets.get(a) !== b)).toEqual([]);
    expect([...ets.keys()].filter((a) => !ours.has(a))).toEqual([]);
    // Busforge also writes the address table's individual address and the com-object table's tail,
    // which ETS takes the device to hold already.
    expect(span([...ours.keys()].filter((a) => !ets.has(a)))).toEqual(["4001-4002", "4354-435b"]);
  });
});
