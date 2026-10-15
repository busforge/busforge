import { test, expect } from "bun:test";
import { STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, assessParCoverage, classify, maskInfo, planSystem7GaFlash, type AppConfig, type ComObjectLink, type KnxIpDevice } from "../src/index.ts";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// What each real application program may be offered, written down from the steps its manufacturer
// declares in <LoadProcedures>, not computed by the code under test:
//   - LdCtrlTaskCtrl1 in the full-download steps is encoded from its Address and Count, as every capture
//     shows it (Auro M-0081_A-FE01, TheLuxa M-0048_A-107E, Meteodata M-0048_A-140C over 0x0104), so it
//     refuses nothing.
//   - M-0081_A-FF31 declares a segment whose <Mask> is shorter than the segment while marking bytes, a
//     form no capture shows: its full download is refused.
//   - M-0008_A-10D7 declares a task segment after its restart, which no capture shows ETS sending: its
//     declared form is refused, and with PreferPartialDownloadIfApplicationLoaded its full download runs in
//     ETS's partial form on a unit that holds it, which sends neither; so all three are offered.
//   - M-008E_A-7079 declares parameter segments without <Data>: the full download cannot build their
//     bytes and is refused (its parameter and group-address flash write only what they derive).
//   - LdCtrlLoadImageProp PID 27 closing a procedure is a read before the restart, and the GVS AMMA's
//     closing object 4 PID 67 = 01 write is sent as declared: neither refuses anything.
// Two refusals have other reasons and are listed so the table covers every fixture: M-0083_A-0137
// declares tunnelling addresses (full download refused), M-0083_A-0138 is MV-0012 (System 1: its one procedure
// "all" runs on the parameter route and the full-download route alike; no group-address download is captured).
const ORACLE: Record<string, { flashParams: boolean; flashLinks: boolean; fullDownload: boolean }> = {
  "M-0002_A-A001-13-63C2.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0004_A-7072-21-99A7-O000A.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0008_A-10D7-11-2783-O000A.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0048_A-107E-12-5B58.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0048_A-140C-14-EB70.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0048_A-493B-21-B471.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0048_A-9071-20-F258-O00EF.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0081_A-FE01-11-75D9.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0081_A-FF31-31-D6FF.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0083_A-00B4-32-3919.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0083_A-00B6-32-9642.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-0083_A-0137-20-7EB2.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0083_A-0138-21-F18E-O0072.xml.gz": { flashParams: true, flashLinks: false, fullDownload: true },
  "M-0085_A-0072-30-69AA.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
  "M-008E_A-7079-10-9C41.xml.gz": { flashParams: true, flashLinks: true, fullDownload: false },
  "M-0162_A-0004-11-F245.xml.gz": { flashParams: true, flashLinks: true, fullDownload: true },
};

// The KNXnet/IP settings of a device instance, as the ETS capture of the System 1 download shows them; device
// instance data like the individual address, which the planners of other families do not read.
const KNXIP: KnxIpDevice = {
  ia: "1.1.250", instanceName: "", productName: "A KNXnet/IP interface with Secure", productNameTranslations: [], additionalAddresses: [251, 252, 253, 254],
  ipConfig: { Assign: "Fixed", IPAddress: "192.0.2.2", SubnetMask: "255.255.255.0", DefaultGateway: "192.0.2.1" },
  securityAttributes: ["ToolKey", "LoadedToolKey", "SequenceNumber"], toolKeyLoaded: true, busInterfaces: 0, installation: { Name: "" },
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
      // In either form (deviceflash.ts absoluteFullForm): on a unit without the application, or holding it.
      for (const unitHoldsApplication of [false, true]) {
        try { profile.planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc, unitHoldsApplication, knxIp: KNXIP }); code = undefined; break; } catch (e) { code = (e as { code?: string }).code ?? "uncoded"; }
      }
      expect(caps.fullDownload).toBe(code === undefined);
      const refusal = profile.operationRefusals().fullDownload;
      if (refusal) expect(code).toBe(refusal.code);
    });

    test(`${file}: the parameter and the structural flash are offered only where the par coverage blocks nothing`, () => {
      const model = maskInfo(cfg.mask).memoryModel;
      // A System 1 mask declares no "par" procedure: its parameter download is the full download.
      if (model === "bcu1") { expect([caps.flashParams, caps.structuralFlash]).toEqual([caps.fullDownload, false]); return; }
      const coverageClear = (model === "absolute" || model === "relative") && assessParCoverage(proc, model).blocked.length === 0;
      expect(caps.flashParams).toBe(coverageClear);
      if (caps.structuralFlash) expect(coverageClear).toBe(true);
    });
  }

  test("a refused write names the code its planner refuses with", () => {
    for (const file of ["M-0081_A-FF31-31-D6FF.xml.gz", "M-008E_A-7079-10-9C41.xml.gz"]) {
      const xml = catalogueXml(file);
      const cfg = parseAppConfig(xml);
      const refusals = classify(cfg).operationRefusals();
      expect(refusals.fullDownload?.code).toBe("FULL_DOWNLOAD_SEGMENT_UNKNOWN");
      expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }))
        .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN" }));
    }
    expect(classify(parseAppConfig(catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz"))).operationRefusals()).toEqual({});
    expect(classify(parseAppConfig(catalogueXml("M-0081_A-FE01-11-75D9.xml.gz"))).operationRefusals()).toEqual({});
  });

  test("the application's own reason is given where tunnelling entries would refuse the full download too", () => {
    const xml = catalogueXml("M-008E_A-7079-10-9C41.xml.gz");
    const cfg = { ...parseAppConfig(xml), maxTunnelingUserEntries: 2 };
    expect(classify(cfg).operationRefusals().fullDownload?.code).toBe("FULL_DOWNLOAD_SEGMENT_UNKNOWN");
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }))
      .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN" }));
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
  confirmedWrites() { return []; }
  clearConfirmedWrites() {}
  setExtendedMemoryServices() {}
  acceptUnprovenRestart() {}
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
    expect(() => planSystem7GaFlash(cfg, cfg.loadProcedures, { addr: Buffer.alloc(243), assoc: Buffer.alloc(242) }, null))
      .toThrow(expect.objectContaining({ code: "GA_TABLE_TOO_LARGE" }));
    expect(planSystem7GaFlash(cfg, cfg.loadProcedures, { addr: Buffer.alloc(243), assoc: Buffer.alloc(241) }, null).assocAt).toBe(0x4000 + 243);
    // Within the region but past the declared 120 associations (60 addresses, 180 associations).
    expect(() => planSystem7GaFlash(cfg, cfg.loadProcedures, { addr: Buffer.alloc(123), assoc: Buffer.alloc(361) }, null))
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

// Which form of the full download runs follows the unit (deviceflash.ts absoluteFullForm). The Gira M-0008
// runs only in ETS's partial form, on a unit holding it, loaded; the Auro and the TheLuxa run their declared
// procedure on any unit, as ETS reads no load state first. A unit holding another application, another
// version of this one included, is refused either way.
for (const [file, programId, otherVersion, declared] of [["M-0008_A-10D7-11-2783-O000A.xml.gz", "000810d711", "000810d710", false], ["M-0081_A-FE01-11-75D9.xml.gz", "0081fe0111", "0081fe0110", true], ["M-0048_A-107E-12-5B58.xml.gz", "0048107e12", "0048107e11", true]] as const) {
  corpusDescribe(`the ${file} full download, by the unit it meets`, () => {
    const xml = catalogueXml(file);
    const cfg = parseAppConfig(xml);
    const download = (dev: MockDevice) => classify(cfg).downloadFull(asDev(dev), cfg.mask, {
      deviceId: "d", ia: "1.1.250", appXml: xml, params: new Map(), links: [], dryRun: true, persistBackups: () => "backup",
    });

    test(declared ? "a unit without an application gets the declared download" : "a unit without the application is refused before anything is written", async () => {
      const dev = new MockDevice(cfg, false);
      if (declared) expect((await download(dev)).kind).toBe("dryRun");
      else expect(await download(dev).catch((e: unknown) => e)).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
      expect(dev.writes).toBe(0);
    });

    test("a unit holding another version of the application is refused before anything is written", async () => {
      const dev = new MockDevice(cfg, false);
      dev.programId = Buffer.from(otherVersion, "hex");
      expect(await download(dev).catch((e: unknown) => e)).toMatchObject({ code: "LOAD_PROC_CHECK_FAILED" });
      expect(dev.writes).toBe(0);
    });

    test("a device that holds it, loaded, gets the download", async () => {
      const dev = new MockDevice(cfg, false);
      dev.programId = Buffer.from(programId, "hex");
      expect((await download(dev)).kind).toBe("dryRun");
      expect(dev.writes).toBe(0);
    });
  });
}
