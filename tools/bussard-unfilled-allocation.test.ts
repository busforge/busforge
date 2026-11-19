import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { allocSegment, iaToNum, planSystemBFullDownload, type LoadStep } from "../packages/knx/src/index.ts";
import { parseAppConfig, parseLoadProcedures, buildRelativeSegmentTarget, fullDownloadImageCoverage, relParamFillByte, relParamFullMode, relativeFullStepRefusal, resolveModuleInstances, initialValues } from "../packages/product/src/index.ts";
import { relativeFullDownloadRefusal } from "../packages/product/src/deviceflash.ts";
import { BUSSARD_SYNTHETIC_TESTED, bussardApplication, bussardCapture, corpusPath } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { memoryImage, parseCapture, reportedTableReferences, type Capture } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";

// bussard's ETS 6.4.1 full downloads (MIT, Tom Bocklisch; the corpus's captures/external/bussard-synthetic/README.md)
// of System B (MV-07B0) products whose load procedure allocates the parameter segment unfilled for the full
// download (LdCtrlRelSegment LsmIdx 4 Mode 0), at application defaults, into a device simulator at 1.1.1. They show
// what ETS sends, never what a device holds.

const DEVICE = iaToNum("1.1.1");
const LSM = 4;
// The tested System B products whose full download allocates the parameter segment unfilled.
const unfilledProducts = () => BUSSARD_SYNTHETIC_TESTED.flatMap(([product, application]) => {
  const xml = readFileSync(corpusPath(bussardApplication(product, application)), "utf8");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  return cfg.mask === "MV-07B0" && relParamFullMode(proc) === "0" ? [{ product, cfg, proc }] : [];
});
const capture = (product: string) => parseCapture(pcapToLog(readFileSync(corpusPath(bussardCapture(product, "defaults")))), DEVICE);
const hex = (b: Buffer) => b.toString("hex");

// ETS's allocation request of the parameter segment (Additional Load Controls 03 0B on PID 5 of LSM 4).
const etsAllocation = (cap: Capture): Buffer => {
  const allocs = cap.propWrites.filter((p) => p.obj === LSM && p.pid === 5 && p.data[0] === 0x03 && p.data[1] === 0x0b);
  expect(allocs).toHaveLength(1);
  return allocs[0].data;
};
// The request Busforge's load runner sends for an allocation step.
async function sentAllocation(step: LoadStep): Promise<Buffer> {
  if (step.op !== "alloc") throw new Error(`not an allocation: ${step.op}`);
  const sent: Buffer[] = [];
  await allocSegment({ propWrite: async (_obj: number, _pid: number, data: Buffer) => { sent.push(data); } } as never, step.lsm, step.size, step.fill ?? false, step.fillByte ?? 0);
  return sent[0];
}

corpusDescribe("bussard's synthetic captures: a System B full download allocating its parameter segment unfilled", () => {
  const products = unfilledProducts();
  const withData = products.filter((p) => p.cfg.segments.find((s) => s.lsm === LSM)!.data.length > 0);
  test("the captures hold 26 such products whose segment declares <Data>, none of them a <Mask>", () => {
    expect(withData).toHaveLength(26);
    expect(withData.some((p) => p.cfg.segments.find((s) => s.lsm === LSM)!.mask)).toBe(false);
  });

  // ETS allocates the segment with the fill flag off and the declared fill byte, and writes every byte of it,
  // the bytes equal to that fill too (syn-relseg-fill: Fill 255 over a <Data> of FF). Busforge's full download
  // planner, given the unfilled allocation as the profile derives it from the procedure (planSystemBFull), plans
  // the same allocation request and the same bytes at the base the simulator reported (PID 7). The profile's
  // own plan is not held here, as some of these products are refused for a load-control step the download
  // does not model. The allocation adds no refusal of its own: the download's refusal is the procedure's step
  // refusal alone.
  for (const { product, cfg, proc } of withData) {
    test(`${product}: the allocation request and every byte of the segment are ETS's`, async () => {
      expect(relativeFullDownloadRefusal(cfg, proc)).toEqual(relativeFullStepRefusal(proc));
      // The products were added to a de-DE ETS project: a text parameter starts at its de-DE InitialValue.
      const params = initialValues(cfg, "de-DE");
      const instances = cfg.hasModules ? resolveModuleInstances(cfg, params) : [];
      const target = buildRelativeSegmentTarget(cfg, params, LSM, { moduleInstances: instances, ownIdleUnionDefaults: true })!;
      const requireReboot = true, mcb: never[] = [], security = undefined, unloadPei = true, closeAtOnce = false, filled = false;
      const plan = planSystemBFullDownload({
        params: target.bytes, paramsInImage: fullDownloadImageCoverage(cfg, target.owned),
        comObj: Buffer.alloc(0), addr: Buffer.alloc(0), assoc: Buffer.alloc(0), programId: Buffer.alloc(5),
      }, relParamFillByte(proc), requireReboot, mcb, security, unloadPei, closeAtOnce, filled);

      const cap = capture(product);
      const alloc = plan.find((s) => s.op === "alloc" && s.lsm === LSM)!;
      expect(hex(await sentAllocation(alloc))).toBe(hex(etsAllocation(cap)));

      const base = reportedTableReferences(cap).get(LSM)!;
      const ours = new Map<number, number>();
      for (const s of plan) if (s.op === "writeSegment" && s.lsm === LSM) s.bytes.forEach((b, i) => ours.set(base + (s.offset ?? 0) + i, b));
      const ets = [...memoryImage(cap.writes)].filter(([a]) => a >= base && a < base + target.size);
      expect(ets).toHaveLength(target.size);
      expect([...ours].sort((x, y) => x[0] - y[0])).toEqual(ets.sort((x, y) => x[0] - y[0]));
    });
  }

  // Of a segment without <Data> ETS writes the bytes up to its last parameter's only (3 of 16) and leaves the rest
  // as the device holds it, after an allocation that does not fill it: what the segment holds after the download is
  // not an image Busforge can state, so the full download of every such product is refused before anything is sent.
  test("syn-relseg-dataless: ETS writes 3 of the 16 bytes", () => {
    const cap = capture("syn-relseg-dataless");
    expect(hex(etsAllocation(cap))).toBe("030b0000001000a50000");
    const base = reportedTableReferences(cap).get(LSM)!;
    expect([...memoryImage(cap.writes)].filter(([a]) => a >= base && a < base + 16).sort((x, y) => x[0] - y[0]).map(([a, b]) => [a - base, b])).toEqual([[0, 0x01], [1, 0x01], [2, 0x2c]]);
  });
  test("a product whose segment declares no <Data> is refused", () => {
    const without = products.filter((p) => !withData.includes(p));
    expect(without.map((p) => p.product)).toContain("syn-relseg-dataless");
    for (const { cfg, proc } of without) {
      expect(relativeFullDownloadRefusal(cfg, proc)).toEqual(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("declares no <Data>") }));
    }
  });
});
