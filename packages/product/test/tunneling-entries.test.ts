import { test, expect, setDefaultTimeout } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, declaresTunnelingEntries, declaresAdditionalAddresses, holdsKnxIpSettings, knxIpRefusals, parseLoadProcedures, type FullDownloadCtx, type KnxIpDevice } from "@busforge/product";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 4.0 s with the
// file alone (load 5-27) and up to 1.6 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(90_000);

// An IP interface's KNXnet/IP settings (its additional individual addresses and its IP configuration) are what ETS
// writes into the KNXnet/IP parameter object, which no System B or System 7 path of Busforge writes. The full download
// is refused where the device holds them: where its application declares additional addresses
// (AdditionalAddressesCount), or where the project gives its instance any. MaxTunnelingUserEntries alone refuses
// nothing: the MDT IP Interface/Router's System B application declares four, and ETS's full download of it touches no
// KNXnet/IP property (tools/etsdiff.test.ts). The oracle is the application's own attributes, read here from the raw
// XML independently of parseAppConfig.

const xmlOf = catalogueXml;
const attr = (xml: string, name: string) => new RegExp(`<ApplicationProgram\\b[^>]*\\b${name}="([^"]*)"`).exec(xml)?.[1];
const declaring = (v: string | undefined) => v !== undefined && !(/^\d+$/.test(v) && Number(v) === 0);

const IP_INTERFACE = "M-0083_A-0137-20-7EB2.xml.gz"; // MDT IP Interface/Router, System B, Data Secure

// An instance's KNXnet/IP settings as the project holds them; `ipConfig` and `additionalAddresses` are what count.
const settings = (over: Partial<KnxIpDevice>): KnxIpDevice => ({
  ia: "1.1.250", instanceName: "", productName: "", productNameTranslations: [], ipConfig: null, additionalAddresses: [],
  securityAttributes: [], toolKeyLoaded: false, busInterfaces: 0, installation: {}, ...over,
});
const HOLDING = [
  ["an IP configuration", settings({ ipConfig: { Assign: "Fixed", IPAddress: "192.0.2.2", SubnetMask: "255.255.255.0", DefaultGateway: "192.0.2.1" } })],
  ["additional addresses", settings({ additionalAddresses: [251, 252] })],
] as const;

// Any access to the device fails the test: the refusal must come before any bus traffic.
const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`device touched: ${String(p)}`); } }) as unknown as KnxDevice;
const plan = (xml: string, knxIp?: KnxIpDevice) => {
  const cfg = parseAppConfig(xml);
  return () => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml), knxIp });
};
const run = async (xml: string, knxIp?: KnxIpDevice) => {
  const cfg = parseAppConfig(xml);
  const ctx = { ia: "1.1.250", params: new Map(), links: [], appXml: xml, knxIp } as unknown as FullDownloadCtx;
  return classify(cfg).downloadFull(untouchable, cfg.mask, ctx).then(() => null, (e: unknown) => e);
};

corpusDescribe("full download of an IP interface's application", () => {
  const ipXml = xmlOf(IP_INTERFACE);
  const cfg = parseAppConfig(ipXml);

  test("the application declares four tunnelling entries and no additional addresses, and the parser reads both", () => {
    expect([attr(ipXml, "MaxTunnelingUserEntries"), attr(ipXml, "AdditionalAddressesCount")]).toEqual(["4", undefined]);
    expect([cfg.maxTunnelingUserEntries, cfg.additionalAddressesCount]).toEqual([4, 0]);
  });

  // The structural flash builds the association table in its long form only, and the router describes the short one.
  test("the full download is offered on the attribute alone; the structural flash is not", () => {
    expect(classify(cfg).capabilities()).toEqual({
      readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: true, structuralFlash: false,
    });
    expect(knxIpRefusals(cfg, null)).toEqual({});
  });

  test("an instance without KNXnet/IP settings plans the download", () => {
    expect(plan(ipXml)().imageBytes).toBeGreaterThan(0);
    expect(plan(ipXml, settings({ busInterfaces: 2 }))().imageBytes).toBeGreaterThan(0);
  });

  for (const [what, knxIp] of HOLDING) {
    test(`an instance holding ${what}: refused with FULL_DOWNLOAD_TUNNELING_ENTRIES, planned and run, before the device is touched`, async () => {
      expect(holdsKnxIpSettings(knxIp)).toBe(true);
      expect(knxIpRefusals(cfg, knxIp).fullDownload?.code).toBe("FULL_DOWNLOAD_TUNNELING_ENTRIES");
      expect(plan(ipXml, knxIp)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" }));
      expect(await run(ipXml, knxIp)).toMatchObject({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" });
    });
  }

  test("the application declaring additional addresses withdraws the offer for every instance", async () => {
    const xml = ipXml.replace('MaxTunnelingUserEntries="4"', 'MaxTunnelingUserEntries="4" AdditionalAddressesCount="4"');
    const declared = parseAppConfig(xml);
    expect(declaresAdditionalAddresses(declared)).toBe(true);
    expect(classify(declared).capabilities().fullDownload).toBe(false);
    expect(knxIpRefusals(declared, null).fullDownload?.code).toBe("FULL_DOWNLOAD_TUNNELING_ENTRIES");
    expect(plan(xml)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" }));
    expect(await run(xml)).toMatchObject({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" });
  });

  test.each(["four", "", " ", "-1", "1.5"])("a declaration %p of additional addresses that is not a non-negative integer counts as declaring them", (v) => {
    const declared = parseAppConfig(ipXml.replace('MaxTunnelingUserEntries="4"', `MaxTunnelingUserEntries="4" AdditionalAddressesCount="${v}"`));
    expect(declaresAdditionalAddresses(declared)).toBe(true);
    expect(classify(declared).capabilities().fullDownload).toBe(false);
  });
});

corpusDescribe("an application refused for its structure keeps that code", () => {
  // The ABB US/U 4.2 (memory-mapped System 7) without its address-table segment cannot be
  // commissioned anyway; with additional addresses declared, the planner answers what the download route does.
  const abb = parseAppConfig(xmlOf("M-0002_A-A001-13-63C2.xml.gz"));
  const cfg = { ...abb, additionalAddressesCount: 2, groupTables: { ...abb.groupTables, addressSegment: undefined } };

  test("FULL_DOWNLOAD_UNSUPPORTED, not the tunnelling code", () => {
    expect(classify(cfg).capabilities().fullDownload).toBe(false);
    expect(knxIpRefusals(cfg, null)).toEqual({});
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xmlOf("M-0002_A-A001-13-63C2.xml.gz")) }))
      .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_UNSUPPORTED", message: expect.stringContaining("KNXnet/IP settings") }));
  });
});

// No System 7 application in the catalogue declares tunnelling entries or additional addresses; the MDT BE-02001.02
// (MV-0705, full download hardware-proven) with the attributes added stands in for one.
corpusDescribe("the System 7 path follows the same rule", () => {
  const be = xmlOf("M-0083_A-00B6-32-9642.xml.gz");
  const tunnelling = be.replace(/<ApplicationProgram\b/, '<ApplicationProgram MaxTunnelingUserEntries="2"');
  const addresses = be.replace(/<ApplicationProgram\b/, '<ApplicationProgram AdditionalAddressesCount="2"');

  test("the tunnelling attribute alone keeps the offer; declared additional addresses withdraw it", () => {
    expect([attr(be, "MaxTunnelingUserEntries"), attr(be, "AdditionalAddressesCount")]).toEqual([undefined, undefined]);
    expect(classify(parseAppConfig(tunnelling)).capabilities().fullDownload).toBe(true);
    expect(classify(parseAppConfig(addresses)).capabilities()).toMatchObject({ readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: false });
  });

  test("planning and running refuse before the device is touched, for the declaration and for an instance's settings", async () => {
    expect(plan(addresses)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" }));
    expect(await run(addresses)).toMatchObject({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" });
    for (const [, knxIp] of HOLDING) {
      expect(plan(be, knxIp)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" }));
      expect(await run(be, knxIp)).toMatchObject({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" });
    }
  });
});

corpusDescribe("System 1 writes the settings itself", () => {
  // The MDT IP Interface Secure (MV-0012) declares four additional addresses, and its download writes them (PID 53).
  const cfg = parseAppConfig(xmlOf("M-0083_A-0138-21-F18E-O0072.xml.gz"));
  test("no refusal for its declaration or its instance's settings", () => {
    expect(declaresAdditionalAddresses(cfg)).toBe(true);
    expect(classify(cfg).capabilities().fullDownload).toBe(true);
    for (const [, knxIp] of HOLDING) expect(knxIpRefusals(cfg, knxIp)).toEqual({});
  });
});

corpusDescribe("applications without KNXnet/IP settings are unaffected", () => {
  const fixtures = listCatalogue();

  test.each(fixtures)("%s: the gates follow the declared attributes", (f) => {
    const xml = xmlOf(f);
    const cfg = parseAppConfig(xml);
    expect([declaresTunnelingEntries(cfg), declaresAdditionalAddresses(cfg)]).toEqual([declaring(attr(xml, "MaxTunnelingUserEntries")), declaring(attr(xml, "AdditionalAddressesCount"))]);
  }, 90_000); // a case parses its application: the 26.9 MB Jung took 8.6 s in a full check at load 14-36

  // The products whose full download is proven, plus the System B reference app the
  // orchestration tests run on: each still offers it.
  test.each([
    "M-0085_A-0072-30-69AA.xml.gz",       // GVS AMMA-04/06.S
    "M-0004_A-7072-21-99A7-O000A.xml.gz", // Jung 400021SE
    "M-0083_A-00B6-32-9642.xml.gz",       // MDT BE-02001.02
    "M-0002_A-A001-13-63C2.xml.gz",       // ABB US/U 4.2
    "M-0162_A-0004-11-F245.xml.gz",       // MEAN WELL power supply
  ])("%s keeps its full download", (f) => {
    expect(classify(parseAppConfig(xmlOf(f))).capabilities().fullDownload).toBe(true);
  }, 60_000); // a case parses its application: the 26.9 MB Jung took 8.6 s in a full check at load 14-36
});
