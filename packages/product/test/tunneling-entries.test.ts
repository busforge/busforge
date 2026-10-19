import { test, expect } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, declaresTunnelingEntries, parseLoadProcedures, type FullDownloadCtx } from "@busforge/product";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// An IP interface's tunnelling addresses (MaxTunnelingUserEntries, the project's AdditionalAddresses)
// live outside the parameter image and the load procedure, and no Busforge path writes them. A full
// download reallocates every load object, so it is refused for such an application; the surgical
// writes and the read-back are not. The oracle is the application's own attribute, read here from
// the raw XML independently of parseAppConfig.

const xmlOf = catalogueXml;
const declared = (xml: string) => /<ApplicationProgram\b[^>]*\bMaxTunnelingUserEntries="([^"]*)"/.exec(xml)?.[1];

const IP_INTERFACE = "M-0083_A-0137-20-7EB2.xml.gz"; // MDT IP Interface/Router, System B, Data Secure

// Any access to the device fails the test: the refusal must come before any bus traffic.
const untouchable = new Proxy({}, { get: (_t, p) => { throw new Error(`device touched: ${String(p)}`); } }) as unknown as KnxDevice;

corpusDescribe("full download of an application with tunnelling entries", () => {
  const ipXml = xmlOf(IP_INTERFACE);

  test("the application declares four entries, and the parser reads them", () => {
    expect(declared(ipXml)).toBe("4");
    expect(parseAppConfig(ipXml).maxTunnelingUserEntries).toBe(4);
  });

  test("the capability reports the full download refused; read-back and the surgical flashes stay", () => {
    expect(classify(parseAppConfig(ipXml)).capabilities()).toEqual({
      readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: false, structuralFlash: false,
    });
  });

  test("planning it refuses with FULL_DOWNLOAD_TUNNELING_ENTRIES", () => {
    const cfg = parseAppConfig(ipXml);
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(ipXml) }))
      .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" }));
  });

  test("running it refuses before the device is touched", async () => {
    const cfg = parseAppConfig(ipXml);
    const ctx = { ia: "1.1.250", params: new Map(), links: [], appXml: ipXml } as unknown as FullDownloadCtx;
    const err = await classify(cfg).downloadFull(untouchable, cfg.mask, ctx).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" });
  });

  test("the declaration alone decides: the same application without entries plans a download", () => {
    const xml = ipXml.replace('MaxTunnelingUserEntries="4"', 'MaxTunnelingUserEntries="0"');
    const cfg = parseAppConfig(xml);
    expect(classify(cfg).capabilities().fullDownload).toBe(true);
    expect(classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }).imageBytes).toBeGreaterThan(0);
  });

  test.each(["four", "", " ", "-1", "1.5"])("a declaration %p that is not a non-negative integer counts as declaring entries", (v) => {
    const cfg = parseAppConfig(ipXml.replace('MaxTunnelingUserEntries="4"', `MaxTunnelingUserEntries="${v}"`));
    expect(declaresTunnelingEntries(cfg)).toBe(true);
    expect(classify(cfg).capabilities().fullDownload).toBe(false);
  });
});

corpusDescribe("an application refused for its structure keeps that code", () => {
  // The ABB US/U 4.2 (memory-mapped System 7) without its address-table segment cannot be
  // commissioned anyway; with entries declared, the planner answers what the download route does.
  const abb = parseAppConfig(xmlOf("M-0002_A-A001-13-63C2.xml.gz"));
  const cfg = { ...abb, maxTunnelingUserEntries: 2, groupTables: { ...abb.groupTables, addressSegment: undefined } };

  test("FULL_DOWNLOAD_UNSUPPORTED, not the tunnelling code", () => {
    expect(classify(cfg).capabilities().fullDownload).toBe(false);
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xmlOf("M-0002_A-A001-13-63C2.xml.gz")) }))
      .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_UNSUPPORTED", message: expect.stringContaining("declares tunnelling addresses") }));
  });
});

// No System 7 application in the catalogue declares tunnelling entries; the MDT BE-02001.02
// (MV-0705, full download hardware-proven) with the attribute added stands in for one.
corpusDescribe("the System 7 path refuses the same way", () => {
  const be = xmlOf("M-0083_A-00B6-32-9642.xml.gz");
  const xml = be.replace(/<ApplicationProgram\b/, '<ApplicationProgram MaxTunnelingUserEntries="2"');
  const cfg = parseAppConfig(xml);

  test("the attribute is the only difference, and it withdraws the offer", () => {
    expect(declared(be)).toBeUndefined();
    expect(classify(parseAppConfig(be)).capabilities().fullDownload).toBe(true);
    expect(classify(cfg).capabilities()).toMatchObject({ readParams: true, readLinks: true, flashParams: true, flashLinks: true, fullDownload: false });
  });

  test("planning and running it refuse before the device is touched", async () => {
    expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }))
      .toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" }));
    const ctx = { ia: "1.1.250", params: new Map(), links: [], appXml: xml } as unknown as FullDownloadCtx;
    const err = await classify(cfg).downloadFull(untouchable, cfg.mask, ctx).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: "FULL_DOWNLOAD_TUNNELING_ENTRIES" });
  });
});

corpusDescribe("applications without tunnelling entries are unaffected", () => {
  const fixtures = listCatalogue();

  test.each(fixtures)("%s: the gate follows the declared attribute", (f) => {
    const xml = xmlOf(f);
    const n = declared(xml);
    expect(declaresTunnelingEntries(parseAppConfig(xml))).toBe(n !== undefined && !(/^\d+$/.test(n) && Number(n) === 0));
  });

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
  });
});
