import { test, expect } from "bun:test";
import { STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, assessParCoverage, classify, maskInfo, planCapturedSystem7GaFlash, type AppConfig, type ComObjectLink } from "../src/index.ts";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// What each real application program may be offered, written down from the steps its manufacturer
// declares in <LoadProcedures>, not computed by the code under test:
//   - LdCtrlTaskCtrl1 in the full-download steps: no Busforge full download executes it, so the full
//     download is refused (M-0048_A-107E, M-0048_A-140C, M-0081_A-FE01, M-0081_A-FF31, M-008E_A-7079).
//   - M-0008_A-10D7 declares it too, and LdCtrlLoadImageProp on objects 1, 2 and 3; ETS 6 is captured
//     running all three of its downloads (loadproc.ts ETS_CAPTURED_SYSTEM7_APPS), which send neither the
//     TaskCtrl1 nor a write for the LoadImageProp, so all three are offered.
//   - LdCtrlLoadImageProp PID 27 in a System B fragment: ETS sends nothing for it (Jung capture), so it
//     refuses nothing.
//   - LdCtrlWriteProp to a manufacturer property in a System B fragment refuses the parameter flash and
//     the full download, except the GVS AMMA's object 4 PID 67 = 01 (M-0085_A-0072, AppliesTo="all"),
//     which ETS is captured sending at the end of its full and partial downloads: it refuses nothing.
// Two refusals have other reasons and are listed so the table covers every fixture: M-0083_A-0137
// declares tunnelling addresses (full download refused), M-0083_A-0138 is MV-0012 (System 1, nothing).
const ORACLE: Record<string, { flashParams: boolean; flashLinks: boolean; fullDownload: boolean }> = {
  "M-0002_A-A001-13-63C2.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0004_A-7072-21-99A7-O000A.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0008_A-10D7-11-2783-O000A.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
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
    for (const file of ["M-0081_A-FE01-11-75D9.xml.gz", "M-008E_A-7079-10-9C41.xml.gz"]) {
      const xml = catalogueXml(file);
      const cfg = parseAppConfig(xml);
      const refusals = classify(cfg).operationRefusals();
      expect(refusals.fullDownload?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
      expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }))
        .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" }));
    }
    expect(classify(parseAppConfig(catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz"))).operationRefusals()).toEqual({});
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
  async authorizeFreeKey() { return 0; } // the level the Gira granted ETS's free key
  async memWrite(addr: number, data: Buffer) { this.writes++; data.forEach((b, i) => this.mem.set(addr + i, b)); }
  programId = Buffer.alloc(0);
  async propRead(obj: number, pid: number) {
    this.propReads.push(`${obj}/${pid}`);
    if (pid === 5) return Buffer.from([STATE.LOADED]);
    if (obj === 3 && pid === 13) return this.programId;
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

  test("M-0008 (captured): the tables are re-declared in ETS's region and the stamps read; a table that does not fit it is refused before the device is asked anything", async () => {
    const cfg = parseAppConfig(catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz"));
    const dev = new MockDevice(cfg, false);
    expect((await flash(cfg, dev)).kind).toBe("dryRun");
    expect(dev.writes).toBe(0);
    // The two tables share the 484 bytes of the two declared segments; more than that is refused.
    expect(() => planCapturedSystem7GaFlash(cfg, cfg.loadProcedures, { addr: Buffer.alloc(243), assoc: Buffer.alloc(242) }, null))
      .toThrow(expect.objectContaining({ code: "GA_TABLE_TOO_LARGE" }));
    expect(planCapturedSystem7GaFlash(cfg, cfg.loadProcedures, { addr: Buffer.alloc(243), assoc: Buffer.alloc(241) }, null).assocAt).toBe(0x4000 + 243);
    // Within the region but past the declared 120 associations (60 addresses, 180 associations).
    expect(() => planCapturedSystem7GaFlash(cfg, cfg.loadProcedures, { addr: Buffer.alloc(123), assoc: Buffer.alloc(361) }, null))
      .toThrow(expect.objectContaining({ code: "GA_TABLE_TOO_LARGE" }));
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

corpusDescribe("the captured M-0008 full download keeps the loaded application, as ETS's does", () => {
  const xml = catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz");
  const cfg = parseAppConfig(xml);
  const download = (dev: MockDevice) => classify(cfg).downloadFull(asDev(dev), cfg.mask, {
    deviceId: "d", ia: "1.1.250", appXml: xml, params: new Map(), links: [], dryRun: true, persistBackups: () => "backup",
  });

  test("a device that does not hold this application is refused before anything is written", async () => {
    const dev = new MockDevice(cfg, false);
    expect(await download(dev).catch((e: unknown) => e)).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
    dev.programId = Buffer.from("000810d710", "hex"); // another version of the application
    expect(await download(dev).catch((e: unknown) => e)).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
    expect(dev.writes).toBe(0);
  });

  test("a device that holds it, loaded, gets the download", async () => {
    const dev = new MockDevice(cfg, false);
    dev.programId = Buffer.from("000810d711", "hex");
    expect((await download(dev)).kind).toBe("dryRun");
    expect(dev.writes).toBe(0);
  });
});
