import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { iaToNum } from "../packages/knx/src/index.ts";
import { parseAppConfig, parseLoadProcedures, classify, buildDeviceConfig, buildComObjectTable, initialValues, resolveModuleInstances, type ComObjectLink } from "../packages/product/src/index.ts";
import { BUSSARD_SYNTHETIC_TESTED, bussardApplication, bussardCapture, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { etsAllocations, memoryImage, parseCapture, parseGaAnyForm, reportedTableReferences, type Capture } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";

// bussard's ETS 6.4.1 full downloads (MIT, Tom Bocklisch; the corpus's captures/external/bussard-synthetic/README.md)
// of System B (MV-07B0) products whose com-objects are numbered from 0, into a device simulator at 1.1.1. Entry 0
// of a System B com-object table is its count, so object 0 has no entry: ETS writes the count, the highest object
// number, and the entries of objects 1 and up, and links object 0's group addresses to it as object 0 in the
// association table. They show what ETS sends, never what a device does with object 0.

const DEVICE = iaToNum("1.1.1");
const OBJ = { ADDR: 1, ASSOC: 2, COMOBJ: 3 } as const;
const capture = (product: string, variant: string) => parseCapture(pcapToLog(readFileSync(corpusPath(bussardCapture(product, variant)))), DEVICE);
// The bytes ETS wrote into the table of `obj`, at the base the simulator reported (PID 7), as long as ETS allocated it.
const etsTable = (cap: Capture, obj: number): string => {
  const base = reportedTableReferences(cap).get(obj), alloc = etsAllocations(cap).get(obj);
  if (base === undefined || alloc === undefined) throw new Error(`the capture holds no allocation or PID 7 answer for object ${obj}`);
  const mem = memoryImage(cap.writes);
  return Buffer.from(Array.from({ length: alloc.size }, (_, i) => {
    const b = mem.get(base + i);
    if (b === undefined) throw new Error(`ETS wrote no byte at +${i} of object ${obj}'s table`);
    return b;
  })).toString("hex");
};

const products = () => BUSSARD_SYNTHETIC_TESTED.flatMap(([product, application]) => {
  const xml = readFileSync(corpusPath(bussardApplication(product, application)), "utf8");
  const cfg = parseAppConfig(xml);
  return cfg.mask === "MV-07B0" && [...cfg.comObjects.values()].some((o) => o.number === 0) ? [{ product, xml, cfg }] : [];
});

corpusDescribe("bussard's synthetic captures: the System B com-object table of products numbering an object 0", () => {
  // The products whose full download the profile plans, the com-object table included; every other one is refused
  // by another rule (operationRefusals). syn-ip-enabled-tp declares two additional addresses, and ETS's download of it
  // writes its KNXnet/IP parameter object after the application (its capture's PIDs 51, 66, 67, 76, 55, 53), which no
  // System B path of Busforge writes (FULL_DOWNLOAD_TUNNELING_ENTRIES).
  const PLANNED = ["syn-assign", "syn-assign-rewrite", "syn-choose-never-shown", "syn-choose-per-ref", "syn-color-param", "syn-com-objects", "syn-dynamic-tests", "syn-hidden-default", "syn-ip-address-param", "syn-legacy-patch-always", "syn-minimal", "syn-module-choose", "syn-object-size-ref", "syn-param-calculation", "syn-relseg-fill", "syn-text-initialvalue", "syn-text-undeclared", "syn-union-bitfields", "syn-union-default-range", "syn-user-memory-extmem"];
  // Products whose object 2 sits in the only branch (default="true") of a <choose> on a ParameterRef no active
  // branch places: ETS takes no branch and leaves its entry 00 00, Busforge takes the default branch and writes
  // it (docs/roadmap.md, "A <choose> on a ParameterRef no active branch places"). Held here for what they show
  // of object 0, the count and the entry of object 1; the entry of object 2 is that open rule's.
  const CHOOSE_UNREACHED = ["syn-choose-never-shown", "syn-choose-per-ref"];

  test("every tested MV-07B0 product numbers an object 0, and none is refused for it", () => {
    const all = products();
    expect(all.length).toBe(BUSSARD_SYNTHETIC_TESTED.filter(([p]) => !p.startsWith("syn-s7-")).length);
    const refused = all.flatMap(({ product, cfg }) => {
      const r = classify(cfg).operationRefusals().fullDownload;
      return r ? [[product, r.code] as const] : [];
    });
    expect(refused.map(([, code]) => code)).not.toContain("COM_OBJECT_TABLE_EMPTY");
    expect(all.map((p) => p.product).filter((p) => !refused.some(([r]) => r === p)).sort()).toEqual(PLANNED);
  });

  // The table Busforge writes at application defaults without links: the profile's full download where it plans
  // one, else the table its builder makes from the same configuration view.
  for (const { product, xml, cfg } of products()) {
    test(`${product}: the com-object table ETS wrote at defaults`, () => {
      const params = initialValues(cfg, "de-DE");
      const instances = cfg.hasModules ? resolveModuleInstances(cfg, params) : [];
      const profile = classify(cfg);
      const table = (profile.operationRefusals().fullDownload
        ? (() => { const v = buildDeviceConfig(cfg, params, undefined, instances); return buildComObjectTable(v.imageComObjects, v.maxComObjectNumber, new Set()); })()
        : profile.planFullDownload(cfg.mask, { ia: "1.1.1", params, links: [], moduleInstances: instances, proc: parseLoadProcedures(xml) }).segments.find((s) => s.source === "comObjTable")!.image).toString("hex");
      const ets = etsTable(capture(product, "defaults"), OBJ.COMOBJ);
      if (CHOOSE_UNREACHED.includes(product)) {
        expect(ets.length).toBe(table.length);
        expect(table.slice(0, 8)).toBe(ets.slice(0, 8));
      } else {
        expect(table).toBe(ets);
      }
    });
  }

  // syn-minimal with object 0 (C W) on 1/0/1 and 1/0/2 and object 1 (C R T) on 1/0/3: ETS writes the com-object
  // table 00 01 4F 00 (object 1's communication flag kept, object 0 without an entry), the address table of the
  // three addresses and the association table (1, 0) (3, 1) (2, 0). Busforge's full download plans the same three.
  test("syn-minimal with both objects linked: the three tables ETS wrote", () => {
    const { xml, cfg } = products().find((p) => p.product === "syn-minimal")!;
    const links: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [parseGaAnyForm("1/0/1"), parseGaAnyForm("1/0/2")] }, { comObjNum: 1, gaRaws: [parseGaAnyForm("1/0/3")] }];
    const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params: initialValues(cfg, "de-DE"), links, proc: parseLoadProcedures(xml) });
    const ours = (source: string) => build.segments.find((s) => s.source === source)!.image.toString("hex");
    const cap = capture("syn-minimal", "links");
    expect(etsTable(cap, OBJ.COMOBJ)).toBe("00014f00");
    expect(ours("comObjTable")).toBe(etsTable(cap, OBJ.COMOBJ));
    expect(ours("addrTable")).toBe(etsTable(cap, OBJ.ADDR));
    expect(ours("assocTable")).toBe(etsTable(cap, OBJ.ASSOC));
  });
});
