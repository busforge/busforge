import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fillAllocatedRuns, iaToNum } from "../packages/knx/src/index.ts";
import { parseAppConfig, classify, parseLoadProcedures, buildRelativeSegmentTarget, fullDownloadImageCoverage, relParamFillByte, resolveModuleInstances } from "../packages/product/src/index.ts";
import { BUSSARD_SYNTHETIC_DIR, BUSSARD_SYNTHETIC_TESTED, BUSSARD_SYNTHETIC_VARIANTS, bussardApplication, bussardCapture, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { compareSegments, etsAllocations, memoryImage, parseCapture, parseTunnelFrame, reportedTableReferences } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";

// bussard's ETS 6.4.1 captures of its synthetic products (MIT, Tom Bocklisch; the corpus's
// captures/external/bussard-synthetic/README.md): one fabricated product per construct, downloaded at its
// application defaults into a simulator at 1.1.1. They are reference evidence for what ETS sends, never for a
// device: where ETS branches on an answer, they show its answer to the simulator.

const DEVICE = iaToNum("1.1.1");
const app = (product: string) => {
  const entry = BUSSARD_SYNTHETIC_TESTED.find(([p]) => p === product);
  if (!entry) throw new Error(`${product} is not in BUSSARD_SYNTHETIC_TESTED`);
  return readFileSync(corpusPath(bussardApplication(...entry)), "utf8");
};
const capture = (product: string, variant = "defaults") => parseCapture(pcapToLog(readFileSync(corpusPath(bussardCapture(product, variant)))), DEVICE);

corpusDescribe("bussard's synthetic captures: the pcap conversion", () => {
  // bussard distilled ETS's L_Data.req TPDUs of each capture into requests.txt with its own tooling; the
  // conversion has to show exactly those, in order, for every capture of the set.
  test("every capture converts, and ETS's requests in it are the ones bussard listed", () => {
    const manifest = JSON.parse(readFileSync(corpusPath(`${BUSSARD_SYNTHETIC_DIR}/captures/manifest.json`), "utf8")) as { captures: { product: string; variant: string }[] };
    expect(BUSSARD_SYNTHETIC_VARIANTS.map((v) => `${v.product}/${v.variant}`)).toEqual(manifest.captures.map((c) => `${c.product}/${c.variant}`));
    let checked = 0;
    for (const { product, variant, base } of BUSSARD_SYNTHETIC_VARIANTS) {
      for (const [pcap, listed] of base ? [["ets.pcapng", "requests.txt"], ["base.pcapng", "base-requests.txt"]] : [["ets.pcapng", "requests.txt"]]) {
        const ours = pcapToLog(readFileSync(corpusPath(bussardCapture(product, variant, pcap)))).split("\n").flatMap((line) => {
          if (!line.includes(" ETS->BRIDGE TUNNELLING_REQ ")) return [];
          const fr = parseTunnelFrame(line.slice(line.lastIndexOf("| ") + 2));
          const hex4 = (n: number) => n.toString(16).padStart(4, "0");
          return fr && fr.code === 0x11 ? [`${hex4(fr.src)} ${hex4(fr.dst)} ${fr.tpdu.toString("hex")}`] : [];
        });
        const theirs = readFileSync(corpusPath(bussardCapture(product, variant, listed)), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
        expect({ capture: `${product}/${variant}/${pcap}`, requests: ours }).toEqual({ capture: `${product}/${variant}/${pcap}`, requests: theirs });
        checked++;
      }
    }
    expect(checked).toBe(127);
  });
});

// The MV-0701 full download, memory-mapped load-state machines, Busforge's planner against ETS's writes, in the
// segments ETS wrote into: every byte ETS wrote is in Busforge's plan with its value (the unlinked objects'
// communication flag cleared included, com-object table at 0x4400), Busforge plans no other byte there, and
// ETS wrote nothing outside them but the load-control register 0x0104. ETS reads each block before writing it
// and leaves out what the simulator already holds (zeros); the plan's bytes are compared where they differ
// from that. A segment ETS wrote nothing into is not held here.
corpusDescribe("bussard's synthetic captures: System 7 MV-0701 full download against ETS", () => {
  for (const product of ["syn-s7-0701", "syn-s7-no-comobjects", "syn-s7-pei80"]) {
    test(`${product}: every byte ETS wrote matches`, () => {
      const xml = app(product);
      const cfg = parseAppConfig(xml);
      expect(cfg.mask).toBe("MV-0701");
      const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params: new Map(), links: [], proc: parseLoadProcedures(xml) });
      const cap = capture(product);
      const r = compareSegments(build.segments.map((seg) => ({ seg, address: seg.address, baseSource: "declared" })), memoryImage(cap.writes), etsAllocations(cap),
        [{ rule: "the 0x0104 load-control register", covers: (a) => a >= 0x0104 && a < 0x010f }]);
      expect(r.unattributed).toEqual([]);
      const written = r.segments.filter((s) => s.etsWrote > 0);
      expect(written.map((s) => s.id.split("_").pop())).toEqual(["AS-4000", "AS-4400", "AS-4440"]);
      expect(written.reduce((n, s) => n + s.compared, 0)).toBe(129);
      expect(written.flatMap((s) => [...s.divergences, ...s.etsOnly])).toEqual([]);
      const image = new Map(build.segments.map((s) => [s.id, s.image]));
      expect(written.flatMap((s) => s.busforgeOnly.filter((o) => image.get(s.id)![o] !== 0x00).map((o) => `${s.id} +${o}`))).toEqual([]);
    });
  }
});

// System B (MV-07B0) parameter segments at application defaults, one construct each: the segment bytes
// Busforge's full download builds (the steps of planSystemBFull: module instances resolved as it resolves them,
// the bytes it owns, the rest at the fill byte relParamFillByte gives), held against the bytes ETS wrote into
// the segment it allocated, at the base the simulator reported (PID 7). Busforge's full download refuses every
// one of these programs before it builds anything (a Mode 0 allocation, a load-control step it does not model,
// or two sizes for one segment), so the image is held against ETS here on its own.
corpusDescribe("bussard's synthetic captures: System B parameter segments at defaults against ETS", () => {
  const cases: [product: string, construct: string][] = [
    ["syn-minimal", "two parameters, the rest of the segment from its <Data>"],
    ["syn-union-bitfields", "a 16-bit union's default member, and sub-octet parameters packed from the most significant bit"],
    ["syn-union-default-range", "a hidden union member written at its declared default, outside its type"],
    ["syn-hidden-default", "a hidden parameter written at its default (MinEtsVersion 6.0, no DownloadInvisibleParameters)"],
    ["syn-legacy-patch-always", "a hidden LegacyPatchAlways parameter written at its default under DownloadInvisibleParameters=Background"],
    ["syn-param-calculation", "the outputs of a ParameterCalculation at their defaults while every input is at its default"],
    ["syn-dynamic-tests", "choose on single, list, comparison and default tests"],
    ["syn-choose-never-shown", "choose on a never-shown memoryless parameter"],
    ["syn-choose-per-ref", "choose on the unreached second ParameterRef of a reached parameter"],
    ["syn-assign", "Assign from a reached parameter onto an unshown placed one"],
    ["syn-assign-rewrite", "Assign rewriting a parameter"],
    ["syn-module-choose", "module instances in the branches of a choose"],
    ["syn-color-param", "an RGB TypeColor"],
    ["syn-ip-address-param", "a TypeIPAddress"],
    ["syn-ip-enabled-tp", "IP-enabled TP hardware"],
    ["syn-com-objects", "one com-object per size code"],
    ["syn-object-size-ref", "a com-object whose ref changes its size"],
    ["syn-property-param", "a parameter placed in a property, not in the segment"],
    ["syn-map-error", "a ProductProcedure with LdCtrlMapError"],
    ["syn-product-07b0", "a ProductProcedure with the tables as RelSegments"],
    ["syn-master-reset", "LdCtrlMasterReset erase code 1"],
    ["syn-master-reset-code4", "LdCtrlMasterReset erase code 4"],
    ["syn-writerelmem-tail", "a Mode 1 allocation with fill 00: the trailing fill bytes not written"],
    ["syn-user-memory-extmem", "an 8448-byte segment above 0xFFFF, written with A_MemoryExtended"],
  ];
  for (const [product, construct] of cases) {
    test(`${product}: ${construct}`, () => {
      const xml = app(product);
      const cfg = parseAppConfig(xml);
      expect(cfg.mask).toBe("MV-07B0");
      const params = new Map<string, string>();
      const target = buildRelativeSegmentTarget(cfg, params, 4, { moduleInstances: cfg.hasModules ? resolveModuleInstances(cfg, params) : [], ownIdleUnionDefaults: true })!;
      const cap = capture(product);
      const base = reportedTableReferences(cap).get(4);
      const alloc = etsAllocations(cap).get(4);
      if (base === undefined || alloc === undefined) throw new Error(`${product}: the capture holds no allocation or PID 7 answer for LSM 4`);
      expect(alloc.size).toBe(target.size);
      const ours = new Map<number, number>();
      for (const run of fillAllocatedRuns(target.bytes, fullDownloadImageCoverage(cfg, target.owned), relParamFillByte(parseLoadProcedures(xml)))) {
        run.bytes.forEach((b, i) => ours.set(base + run.offset + i, b));
      }
      const ets = [...memoryImage(cap.writes)].filter(([a]) => a >= base && a < base + alloc.size);
      expect(ets.length).toBeGreaterThan(0);
      expect([...ours].sort((x, y) => x[0] - y[0])).toEqual(ets.sort((x, y) => x[0] - y[0]));
    });
  }
});
