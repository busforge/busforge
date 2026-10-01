import { test, expect, describe } from "bun:test";
import { readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { iaToNum, ownedRuns } from "../packages/knx/src/index.ts";
import { parseAppConfig, classify, parseLoadProcedures, buildRelativeSegmentTarget, mergeRelativeTarget, buildDeviceConfig, resolveModuleInstances, absoluteStructuralImages, planAbsoluteStructuralFlash, planRelativeStructuralFlash, declaredMcbWrites } from "../packages/product/src/index.ts";
import { parseCapture, memoryImage, etsAllocations, reportedTableReferences, compareSegments, parseGa, inferBase } from "./etsdiff.ts";

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
describe("MDT BE-02001.02 full download against ETS", () => {
  const xml = gunzipSync(readFileSync(join(import.meta.dir, "../packages/product/test/fixtures/real/M-0083_A-00B6-32-9642.xml.gz"))).toString("utf8");
  const cfg = parseAppConfig(xml);
  const run = (capture: string, links: { comObjNum: number; gaRaws: number[] }[]) => {
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: DEV, params: new Map(), links, proc: parseLoadProcedures(xml) });
    const cap = parseCapture(readFileSync(join(import.meta.dir, "fixtures", capture), "utf8"), iaToNum(DEV));
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
describe("GVS AMMA full download against ETS", () => {
  test("every byte matches: silent com-object table, and each idle union holds its default member", () => {
    const xml = gunzipSync(readFileSync(join(import.meta.dir, "../packages/product/test/fixtures/real/M-0085_A-0072-30-69AA.xml.gz"))).toString("utf8");
    const cfg = parseAppConfig(xml);
    const ia = iaToNum("1.1.203");
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.203", params: new Map(), links: [], proc: parseLoadProcedures(xml) });
    const cap = parseCapture(readFileSync(join(import.meta.dir, "fixtures", "gvs-amma-ets-fulldownload-defaults.log"), "utf8"), ia);
    const refs = reportedTableReferences(cap);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.compared, s.divergences.length])).toEqual([[4, 2816, 0], [3, 1066, 0], [2, 2, 0], [1, 2, 0]]);
    expect(r.unattributed).toEqual([]);
  });
});

// ETS 6 full download of the Jung 400021SE (System B, module device, segment above 64 KB) at the
// project's configuration: two module instances, no links; trimmed to the frames to and from 1.1.204.
describe("Jung 400021SE full download against ETS", () => {
  test("every byte matches, including the union a hidden ParameterRef's own default would flip", () => {
    const xml = gunzipSync(readFileSync(join(import.meta.dir, "../packages/product/test/fixtures/real/M-0004_A-7072-21-99A7-O000A.xml.gz"))).toString("utf8");
    const cfg = parseAppConfig(xml);
    const ia = iaToNum("1.1.204");
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.204", params: new Map(), links: [], proc: parseLoadProcedures(xml) });
    const cap = parseCapture(readFileSync(join(import.meta.dir, "fixtures", "jung-400021se-ets-fulldownload.log"), "utf8"), ia);
    const refs = reportedTableReferences(cap);
    const r = compareSegments(build.segments.map((seg) => ({ seg, address: refs.get(seg.lsm) ?? null, baseSource: "device" })), memoryImage(cap.writes), etsAllocations(cap), []);
    expect(r.segments.map((s) => [s.lsm, s.divergences.map((d) => d.offset)])).toEqual([[4, []], [3, []], [2, []], [1, []]]);
  });
});

// ETS 6 partial downloads after linking objects to group addresses (and, on ABB and GVS, enabling
// a channel), 2026-09-26, trimmed per device. Every byte ETS wrote must equal the image Busforge
// builds for the same configuration: parameters, com-object table and group tables.
describe("partial downloads with links against ETS", () => {
  const real = (f: string) => gunzipSync(readFileSync(join(import.meta.dir, "../packages/product/test/fixtures/real", f))).toString("utf8");
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
      const cap = parseCapture(readFileSync(join(import.meta.dir, "fixtures", `${file[c.ia]}-ets-partial-links.log`), "utf8"), iaToNum(c.ia));
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
describe("System B parameter flash against ETS's partial download", () => {
  const real = (f: string) => gunzipSync(readFileSync(join(import.meta.dir, "../packages/product/test/fixtures/real", f))).toString("utf8");
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
      const cap = parseCapture(readFileSync(join(import.meta.dir, "fixtures", `${c.file}-ets-partial-links.log`), "utf8"), iaToNum(c.ia));
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
describe("structural flash against ETS's partial download", () => {
  const real = (f: string) => gunzipSync(readFileSync(join(import.meta.dir, "../packages/product/test/fixtures/real", f))).toString("utf8");

  test("MDT BE-02001.02: Busforge writes exactly the bytes ETS changed, with ETS's values, LSM by LSM", () => {
    const xml = real("M-0083_A-00B6-32-9642.xml.gz");
    const cfg = parseAppConfig(xml);
    const ia = iaToNum(DEV);
    const before = memoryImage(parseCapture(readFileSync(join(import.meta.dir, "fixtures", "mdt-be02001-ets-fulldownload-b7.log"), "utf8"), ia).writes);
    const ets = memoryImage(parseCapture(readFileSync(join(import.meta.dir, "fixtures", "mdt-be02001-ets-partial-structure.log"), "utf8"), ia).writes);
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
    const cap = parseCapture(readFileSync(join(import.meta.dir, "fixtures", "jung-400021se-ets-partial-structure.log"), "utf8"), iaToNum("1.1.204"));
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
describe("etsdiff --partial evidence", () => {
  const realDir = join(import.meta.dir, "../packages/product/test/fixtures/real");
  const cli = async (args: string[]) => {
    const out = join(tmpdir(), `etsdiff-partial-${crypto.randomUUID()}.json`);
    const p = Bun.spawnSync(["bun", "run", join(import.meta.dir, "etsdiff.ts"), ...args, "--partial", `--evidence=${out}`], { stdout: "pipe", stderr: "pipe" });
    const written = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as { scope: { operation: string }; results: { reference: { state: string; detail?: string } } }[] : null;
    rmSync(out, { force: true });
    return { exitCode: p.exitCode, records: written?.map((r) => [r.scope.operation, r.results.reference.state]) ?? null, details: written?.map((r) => r.results.reference.detail) ?? [], stderr: p.stderr.toString() };
  };
  test("GVS AMMA: parameters and links, one pass each", async () => {
    const r = await cli([join(import.meta.dir, "fixtures/gvs-amma-ets-partial-links.log"), `--app=${join(realDir, "M-0085_A-0072-30-69AA.xml.gz")}`, "--ia=1.1.203",
      "--param=M-0085_A-0072-30-69AA_P-20_R-20=1", "--param=M-0085_A-0072-30-69AA_UP-142_R-142=1", "--link=2:3/3/6"]);
    expect([r.exitCode, r.records]).toEqual([0, [["flashParams", "pass"], ["flashLinks", "pass"]]]);
  });
  test("MDT BE-02001.02: links only, so no parameter record", async () => {
    const r = await cli([join(import.meta.dir, "fixtures/mdt-be02001-ets-partial-links.log"), `--app=${join(realDir, "M-0083_A-00B6-32-9642.xml.gz")}`, "--ia=1.1.56", "--link=0:3/3/1", "--link=6:3/3/5"]);
    expect([r.exitCode, r.records]).toEqual([0, [["flashLinks", "pass"]]]);
  });
  test("a configuration ETS did not download fails, and its record says so", async () => {
    const r = await cli([join(import.meta.dir, "fixtures/mdt-be02001-ets-partial-links.log"), `--app=${join(realDir, "M-0083_A-00B6-32-9642.xml.gz")}`, "--ia=1.1.56", "--link=0:3/3/1"]);
    expect([r.exitCode, r.records]).toEqual([1, [["flashLinks", "fail"]]]);
  });
  // GVS AMMA (System B): the parameter segment is placed by the device's table reference and
  // matches; ETS also allocated the association table (a fill and no write) but the capture holds
  // no table reference for it, so that segment could not be compared.
  test("a table ETS allocated but the capture cannot place is a failed record, not a silent pass", async () => {
    const xml = gunzipSync(readFileSync(join(realDir, "M-0085_A-0072-30-69AA.xml.gz"))).toString("utf8");
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
