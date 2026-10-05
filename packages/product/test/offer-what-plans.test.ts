import { test, expect } from "bun:test";
import { STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, assessParCoverage, classify, maskInfo, type AppConfig, type ComObjectLink } from "../src/index.ts";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// What each real application program may be offered, written down from the steps its manufacturer
// declares in <LoadProcedures>, not computed by the code under test:
//   - LdCtrlTaskCtrl1 in the full-download steps: no Busforge full download executes it, so the full
//     download is refused (M-0048_A-107E, M-0048_A-140C, M-0081_A-FE01, M-0081_A-FF31, M-0008_A-10D7,
//     M-008E_A-7079).
//   - LdCtrlLoadImageProp on objects 1, 2 and 3 in an absolute (System 7) procedure: no evidence of what
//     ETS sends for it, so the parameter flash and the group-address flash, which write those objects'
//     segments, are refused (M-0008_A-10D7).
//   - LdCtrlLoadImageProp PID 27 in a System B fragment: ETS sends nothing for it (Jung capture), so it
//     refuses nothing.
// Two refusals have other reasons and are listed so the table covers every fixture: M-0083_A-0137
// declares tunnelling addresses (full download refused), M-0083_A-0138 is MV-0012 (System 1, nothing).
const ORACLE: Record<string, { flashParams: boolean; flashLinks: boolean; fullDownload: boolean }> = {
  "M-0002_A-A001-13-63C2.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0004_A-7072-21-99A7-O000A.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0008_A-10D7-11-2783-O000A.xml.gz": { flashParams: false, flashLinks: false, fullDownload: false },
  "M-0048_A-107E-12-5B58.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0048_A-140C-14-EB70.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0048_A-493B-21-B471.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0048_A-9071-20-F258-O00EF.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0081_A-FE01-11-75D9.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0081_A-FF31-31-D6FF.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0083_A-00B4-32-3919.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0083_A-00B6-32-9642.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0083_A-0137-20-7EB2.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0083_A-0138-21-F18E-O0072.xml.gz": { flashParams: false, flashLinks: false, fullDownload: false },
  "M-0085_A-0072-30-69AA.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-008E_A-7079-10-9C41.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0162_A-0004-11-F245.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
};

corpusDescribe("capabilities() offers a write exactly where its planner runs the declared procedure", () => {
  const files = listCatalogue();

  test("the oracle names every catalogue fixture", () => {
    expect(Object.keys(ORACLE).sort()).toEqual(files);
  });

  for (const file of files) {
    const xml = catalogueXml(file);
    const cfg = parseAppConfig(xml);
    const profile = classify(cfg);
    const caps = profile.capabilities();
    const proc = parseLoadProcedures(xml);

    test(`${file}: the offered writes match the declared verbs`, () => {
      const { flashParams, flashLinks, fullDownload } = caps;
      expect({ flashParams, flashLinks, fullDownload }).toEqual(ORACLE[file]);
    });

    test(`${file}: the full download is offered exactly when it plans at the defaults, and a procedure refusal is the planner's`, () => {
      let code: string | undefined;
      try { profile.planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc }); } catch (e) { code = (e as { code?: string }).code ?? "uncoded"; }
      expect(caps.fullDownload).toBe(code === undefined);
      const refusal = profile.operationRefusals().fullDownload;
      if (refusal) expect(code).toBe(refusal.code);
    });

    test(`${file}: the parameter and the structural flash are offered only where the par coverage blocks nothing`, () => {
      const model = maskInfo(cfg.mask).memoryModel;
      const coverageClear = (model === "absolute" || model === "relative") && assessParCoverage(proc, model).blocked.length === 0;
      expect(caps.flashParams).toBe(coverageClear);
      if (caps.structuralFlash) expect(coverageClear).toBe(true);
    });
  }

  test("a refused write names the code its planner refuses with", () => {
    for (const file of ["M-0081_A-FE01-11-75D9.xml.gz", "M-0008_A-10D7-11-2783-O000A.xml.gz"]) {
      const xml = catalogueXml(file);
      const cfg = parseAppConfig(xml);
      const refusals = classify(cfg).operationRefusals();
      expect(refusals.fullDownload?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
      expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }))
        .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" }));
    }
    const m0008 = classify(parseAppConfig(catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz"))).operationRefusals();
    expect(m0008.flashParams?.code).toBe("LOAD_STEP_UNSUPPORTED");
    expect(m0008.flashLinks?.code).toBe("LOAD_STEP_UNSUPPORTED");
    expect(m0008.flashLinks?.message).toContain("LdCtrlLoadImageProp");
  });

  test("the procedure is the reason given where tunnelling entries would refuse the full download too", () => {
    const xml = catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");
    const cfg = { ...parseAppConfig(xml), maxTunnelingUserEntries: 2 };
    expect(classify(cfg).operationRefusals().fullDownload?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }))
      .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" }));
  });
});

// Byte-addressed mock of a System 7 device: LSM states over property 5 (property-mapped) or the
// memory-mapped status bytes (MV-0700/0701), table pointers and memory. Every other property read is
// recorded and answered empty.
const MM_STATUS_BASE = 46825;
class MockDevice {
  mem = new Map<number, number>();
  propReads: string[] = [];
  writes = 0;
  constructor(readonly cfg: AppConfig, readonly memMapped: boolean) {
    for (const seg of cfg.absoluteSegments) seg.data.forEach((b, i) => this.mem.set(seg.address + i, b));
    for (const obj of [1, 2, 3]) if (memMapped) this.mem.set(MM_STATUS_BASE + obj, STATE.LOADED);
  }
  segAddr(id: string | undefined) { return this.cfg.absoluteSegments.find((s) => s.id === id)!.address; }
  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return this.cfg.mask; }
  async restart() {}
  async tableAddr(obj: number) { return obj === 1 ? this.segAddr(this.cfg.groupTables.addressSegment) : this.segAddr(this.cfg.groupTables.associationSegment); }
  async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0; return b; }
  async writesConfirmed() { return false; }
  async memWrite(addr: number, data: Buffer) { this.writes++; data.forEach((b, i) => this.mem.set(addr + i, b)); }
  async propRead(obj: number, pid: number) {
    this.propReads.push(`${obj}/${pid}`);
    if (pid === 5) return Buffer.from([STATE.LOADED]);
    return Buffer.alloc(0);
  }
  async propWrite() { this.writes++; return Buffer.alloc(0); }
}
const asDev = (m: MockDevice) => m as unknown as KnxDevice;

corpusDescribe("the System 7 group-address flash holds the declared steps addressed to the tables it writes", () => {
  const links: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x0801] }];
  const flash = (cfg: AppConfig, dev: MockDevice) => classify(cfg).flashGroupTables(asDev(dev), cfg.mask, {
    deviceId: "d", ia: "1.1.250", links, params: new Map(), baseParams: new Map(), dryRun: true, persistBackups: () => "backup",
  });

  test("M-0008 (LdCtrlLoadImageProp on objects 1, 2, 3) is refused before the device is asked anything", async () => {
    const cfg = parseAppConfig(catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz"));
    const dev = new MockDevice(cfg, false);
    expect(await flash(cfg, dev).catch((e: unknown) => e)).toMatchObject({ code: "LOAD_STEP_UNSUPPORTED" });
    expect(dev.propReads).toEqual([]);
    expect(dev.writes).toBe(0);
  });

  for (const [file, memMapped] of [["M-0083_A-00B6-32-9642.xml.gz", false], ["M-0081_A-FE01-11-75D9.xml.gz", false], ["M-0002_A-A001-13-63C2.xml.gz", true]] as const) {
    test(`${file} still plans (LdCtrlTaskCtrl1 and LdCtrlTaskSegment stay documented skips)`, async () => {
      const cfg = parseAppConfig(catalogueXml(file));
      const dev = new MockDevice(cfg, memMapped);
      const res = await flash(cfg, dev);
      expect(res.kind).toBe("dryRun");
      expect(dev.writes).toBe(0);
      // A declared CompareProp (the ABB's application id on object 3) is not run by this flash.
      expect(dev.propReads.filter((r) => !r.endsWith("/5"))).toEqual([]);
    });
  }
});
