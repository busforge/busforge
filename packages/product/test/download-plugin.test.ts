import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig, parseLoadProcedures, classify, downloadPluginRefusal } from "@busforge/product";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// An application that names an ETS download plugin (<Static><Extension EtsDownloadPlugin="{GUID}">) is
// downloaded by ETS through that plugin. Every ETS capture of ours is of an application without one, so
// the writes that put a com-object table into the device (the group-address flash, the full download and
// the structural flash built from both) are refused for it; the parameter flash, which leaves the table
// as the device holds it, is not.

const GUID = "{00000000-0000-4000-8000-000000000001}";
const withExtension = (xml: string, extension: string) => {
  expect(xml.split("</Static>\n          <ModuleDefs>").length).toBe(2);
  return xml.replace("</Static>\n          <ModuleDefs>", `${extension}\n          </Static>\n          <ModuleDefs>`);
};

// A System B application (MV-07B0, MergedProcedure) of one 8-byte parameter segment and one com-object.
const A = "M-00FA_A-1234-01-ABCD";
const systemB = readFileSync(join(import.meta.dir, "fixtures", "sample-image-app.xml"), "utf8")
  .replace('Name="Image Test">', 'Name="Image Test" LoadProcedureStyle="MergedProcedure">')
  .replace("</ParameterRefs>", `</ParameterRefs>
            <ComObjectTable><ComObject Id="${A}_O-1" Number="1" Name="Switch" Text="Switch" FunctionText="On/Off" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" /></ComObjectTable>
            <ComObjectRefs><ComObjectRef Id="${A}_O-1_R-1" RefId="${A}_O-1" /></ComObjectRefs>
            <AddressTable MaxEntries="10" /><AssociationTable MaxEntries="10" />`)
  .replace("</ModuleDefs>", `</ModuleDefs>
          <Dynamic><ChannelIndependentBlock><ParameterBlock Id="${A}_PB-1" Name="main" Text="Main"><ParameterRefRef RefId="P-u8_R-1" /><ComObjectRefRef RefId="${A}_O-1_R-1" /></ParameterBlock></ChannelIndependentBlock></Dynamic>`)
  .replace("</Static>\n          <ModuleDefs>", `<LoadProcedures>
              <LoadProcedure MergeId="2">
                <LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8" Mode="1" Fill="0" />
                <LdCtrlRelSegment AppliesTo="par" LsmIdx="4" Size="8" Mode="0" Fill="0" />
              </LoadProcedure>
              <LoadProcedure MergeId="4">
                <LdCtrlWriteRelMem AppliesTo="full,par" ObjIdx="4" Offset="0" Size="8" Verify="true" />
              </LoadProcedure>
            </LoadProcedures>
          </Static>
          <ModuleDefs>`);

const untouched = new Proxy({}, { get: (_, key) => { throw new Error(`the device was asked for ${String(key)}`); } }) as never;
const ctx = { ia: "1.1.250", params: new Map(), baseParams: new Map(), links: [] } as never;
const rejection = (p: Promise<unknown>) => p.then(() => "no refusal", (e: unknown) => e);
const refusedWith = (code: string) => expect.objectContaining({ code });
const PLUGIN = "COM_OBJECT_TABLE_DOWNLOAD_PLUGIN";

describe("the ETS download plugin an application names", () => {
  test("is read from a non-empty EtsDownloadPlugin of the application's Extension, trimmed", () => {
    expect(parseAppConfig(withExtension(systemB, `<Extension EtsDownloadPlugin=" ${GUID} " />`)).etsDownloadPlugin).toBe(GUID);
  });

  test.each([
    ["no Extension", ""],
    ["an empty Extension", "<Extension />"],
    ["an empty EtsDownloadPlugin", `<Extension EtsDownloadPlugin="" EtsUiPlugin="" EtsDataHandler="" />`],
    ["a blank EtsDownloadPlugin", `<Extension EtsDownloadPlugin="  " />`],
    ["only a UI plugin", `<Extension EtsUiPlugin="${GUID}" />`],
  ])("names none with %s, and refuses nothing for it", (_, extension) => {
    const cfg = parseAppConfig(extension ? withExtension(systemB, extension) : systemB);
    expect(cfg.etsDownloadPlugin).toBeUndefined();
    expect(downloadPluginRefusal(cfg)).toBeUndefined();
    expect(classify(cfg).operationRefusals()).toEqual({});
  });
});

describe("a System B application that names an ETS download plugin", () => {
  const cfg = parseAppConfig(withExtension(systemB, `<Extension EtsDownloadPlugin="${GUID}" />`));
  const profile = classify(cfg);

  test("is offered the parameter flash and reads, and no write of the com-object table", () => {
    expect(profile.operationRefusals()).toEqual({ flashLinks: refusedWith(PLUGIN), fullDownload: refusedWith(PLUGIN) });
    expect(profile.capabilities()).toMatchObject({ readParams: true, readLinks: true, flashParams: true, flashLinks: false, fullDownload: false });
  });

  test("refuses the group-address flash and the full download before it asks the device anything", async () => {
    expect(await rejection(profile.flashGroupTables(untouched, "MV-07B0", ctx))).toEqual(refusedWith(PLUGIN));
    expect(await rejection(profile.downloadFull(untouched, "MV-07B0", ctx))).toEqual(refusedWith(PLUGIN));
  });

  test("plans no full download, as it offers none", () => {
    const xml = withExtension(systemB, `<Extension EtsDownloadPlugin="${GUID}" />`);
    const inputs = { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) };
    expect(() => classify(parseAppConfig(systemB)).planFullDownload("MV-07B0", inputs)).not.toThrow();
    expect(() => profile.planFullDownload("MV-07B0", inputs)).toThrow(expect.objectContaining({ code: PLUGIN }));
  });

  test("names the plugin in the refusal", () => {
    expect(downloadPluginRefusal(cfg)?.message).toContain(GUID);
  });
});

corpusDescribe("the applications of the private corpus", () => {
  test("name no ETS download plugin, so none of their writes is refused for one", () => {
    const files = listCatalogue();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(parseAppConfig(catalogueXml(f)).etsDownloadPlugin, f).toBeUndefined();
  });

  // The MDT BE-02001.02 (MV-0705) carries an empty <Extension />; given a plugin, its System 7 profile
  // withholds the group-address flash and the full download as the System B one does.
  test("a System 7 application given a plugin is refused the writes of the com-object table", async () => {
    const xml = catalogueXml("M-0083_A-00B6-32-9642.xml.gz");
    expect(xml.split("<Extension />").length).toBe(2);
    const plain = classify(parseAppConfig(xml));
    expect(plain.capabilities()).toMatchObject({ flashLinks: true, fullDownload: true });
    const profile = classify(parseAppConfig(xml.replace("<Extension />", `<Extension EtsDownloadPlugin="${GUID}" />`)));
    expect(profile.operationRefusals()).toMatchObject({ flashLinks: refusedWith(PLUGIN), fullDownload: refusedWith(PLUGIN) });
    expect(profile.operationRefusals().flashParams).toBeUndefined();
    expect(profile.capabilities()).toMatchObject({ flashParams: true, flashLinks: false, fullDownload: false, structuralFlash: false });
    expect(await rejection(profile.flashGroupTables(untouched, "MV-0705", ctx))).toEqual(refusedWith(PLUGIN));
    expect(await rejection(profile.downloadFull(untouched, "MV-0705", ctx))).toEqual(refusedWith(PLUGIN));
    for (const unitHoldsApplication of [false, true]) {
      const inputs = { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml), unitHoldsApplication };
      expect(() => plain.planFullDownload("MV-0705", inputs)).not.toThrow();
      expect(() => profile.planFullDownload("MV-0705", inputs)).toThrow(expect.objectContaining({ code: PLUGIN }));
    }
  });

  // Without a com-object table segment the System 7 group-address flash writes the address and
  // association tables alone, so a plugin does not refuse it.
  test("a System 7 group-address flash that writes no com-object table is not refused for a plugin", () => {
    const table = '<ComObjectTable CodeSegment="M-0083_A-00B6-32-9642_AS-4400" Offset="0">';
    const xml = catalogueXml("M-0083_A-00B6-32-9642.xml.gz").replace("<Extension />", `<Extension EtsDownloadPlugin="${GUID}" />`);
    expect(xml.split(table).length).toBe(2);
    const profile = classify(parseAppConfig(xml.replace(table, "<ComObjectTable>")));
    expect(profile.operationRefusals().flashLinks).toBeUndefined();
    expect(profile.capabilities().flashLinks).toBe(true);
  });
});
