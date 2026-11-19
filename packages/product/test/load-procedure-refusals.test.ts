import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAppConfig, parseLoadProcedures, classify, assessParCoverage, buildDeviceConfig, buildComObjectTable } from "@busforge/product";
import { catalogueXml, listCatalogue, captureText, corpusPath, bussardCapture, bussardApplication } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { parseCapture } from "../../../tools/etsdiff.ts";
import { pcapToLog } from "../../../tools/pcap.ts";
import { procedureSizeRefusal, taskSegmentManufacturerRefusal, absoluteFullStepRefusal } from "../src/deviceflash.ts";
import { isMemoryMappedLsm } from "../src/masks.ts";

// Parses the 1.2 MB ABB application several times; well under a second alone.
setDefaultTimeout(60_000);

// A System B application (MV-07B0, MergedProcedure) of one 8-byte parameter segment and one com-object, with
// the fragments every System B application in the catalogue declares: the allocation for the full and the
// parameter download, and the write of the whole segment.
const A = "M-00FA_A-1234-01-ABCD";
const base = readFileSync(join(import.meta.dir, "fixtures", "sample-image-app.xml"), "utf8")
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
const once = (xml: string, from: string, to: string) => {
  expect(xml.split(from).length).toBe(2);
  return xml.replace(from, to);
};
const fullDownload = (xml: string) => () => classify(parseAppConfig(xml)).planFullDownload("MV-07B0", { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) });
const refusedWith = (code: string) => expect.objectContaining({ code });
// A device that fails the test on its first use: a write refused before it asks the device anything.
const untouched = new Proxy({}, { get: (_, key) => { throw new Error(`the device was asked for ${String(key)}`); } }) as never;
const ctx = { ia: "1.1.250", params: new Map(), baseParams: new Map(), links: [] } as never;
const rejection = (p: Promise<unknown>) => p.then(() => "no refusal", (e: unknown) => e);

describe("a System B application whose declared sizes for one segment disagree is refused before anything is written", () => {
  test("the consistent application offers every write and plans its full download", () => {
    expect(classify(parseAppConfig(base)).operationRefusals()).toEqual({});
    expect(fullDownload(base)).not.toThrow();
  });

  test.each([
    ["the full download's allocation", '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8"', '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="6"'],
    ["the parameter download's allocation", '<LdCtrlRelSegment AppliesTo="par" LsmIdx="4" Size="8"', '<LdCtrlRelSegment AppliesTo="par" LsmIdx="4" Size="9"'],
    ["the segment write", 'Offset="0" Size="8" Verify="true"', 'Offset="0" Size="6" Verify="true"'],
    ["a segment write at an offset", 'Offset="0" Size="8" Verify="true"', 'Offset="2" Size="6" Verify="true"'],
    ["a segment write without its size", 'Offset="0" Size="8" Verify="true"', 'Offset="0" Verify="true"'],
  ])("%s", (_, from, to) => {
    const xml = once(base, from, to);
    const refusals = classify(parseAppConfig(xml)).operationRefusals();
    for (const op of ["flashParams", "flashLinks", "fullDownload"] as const) expect(refusals[op]?.code).toBe("LOAD_PROCEDURE_SIZE_MISMATCH");
    expect(classify(parseAppConfig(xml)).capabilities()).toMatchObject({ flashParams: false, flashLinks: false, fullDownload: false, structuralFlash: false });
    expect(fullDownload(xml)).toThrow(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
  });

  test("each write refuses it itself, before it asks the device anything", async () => {
    const profile = classify(parseAppConfig(once(base, 'Offset="0" Size="8" Verify="true"', 'Offset="0" Size="6" Verify="true"')));
    expect(await rejection(profile.downloadFull(untouched, "MV-07B0", ctx))).toEqual(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
    expect(await rejection(profile.flashParameters(untouched, "MV-07B0", ctx))).toEqual(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
    expect(await rejection(profile.flashGroupTables(untouched, "MV-07B0", ctx))).toEqual(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
  });
});

// A System B com-object table holds no entry for an object numbered 0: its place is the count (comobjbuild.ts
// buildComObjectTable, held against ETS in tools/bussard-com-object-zero.test.ts).
describe("a System B application with a com-object numbered 0", () => {
  const second = `<ComObject Id="${A}_O-2" Number="2" Name="Status" Text="Status" FunctionText="On/Off" ObjectSize="1 Bit" DatapointType="DPST-1-1" ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled" />`;
  const zero = once(base, `<ComObject Id="${A}_O-1" Number="1"`, `<ComObject Id="${A}_O-1" Number="0"`);
  const withSecond = once(once(once(zero, "</ComObjectTable>", `${second}</ComObjectTable>`),
    "</ComObjectRefs>", `<ComObjectRef Id="${A}_O-2_R-2" RefId="${A}_O-2" /></ComObjectRefs>`),
    `<ComObjectRefRef RefId="${A}_O-1_R-1" />`, `<ComObjectRefRef RefId="${A}_O-1_R-1" /><ComObjectRefRef RefId="${A}_O-2_R-2" />`);

  test("offers every write and plans its full download where another object is numbered 1 or higher", () => {
    expect(classify(parseAppConfig(withSecond)).operationRefusals()).toEqual({});
    const table = fullDownload(withSecond)().segments.find((sg) => sg.source === "comObjTable")!.image;
    // Object 2 (C R T, no link): its communication flag cleared. Object 0 (C W T): no entry.
    expect(table.toString("hex")).toBe("000200004b00");
  });

  test("whose only object it is refuses the full download and the group-address flash before they are offered", () => {
    const profile = classify(parseAppConfig(zero));
    const refusals = profile.operationRefusals();
    expect(refusals.fullDownload?.code).toBe("COM_OBJECT_TABLE_EMPTY");
    expect(refusals.flashLinks?.code).toBe("COM_OBJECT_TABLE_EMPTY");
    expect(refusals.flashParams).toBeUndefined();
    expect(profile.capabilities()).toMatchObject({ flashParams: true, flashLinks: false, fullDownload: false, structuralFlash: false });
    expect(fullDownload(zero)).toThrow(refusedWith("COM_OBJECT_TABLE_EMPTY"));
  });

  test("an application without any com-object is refused alike", () => {
    const none = once(base, /<ComObjectTable>.*<\/ComObjectTable>/s.exec(base)![0], "<ComObjectTable></ComObjectTable>");
    expect(classify(parseAppConfig(none)).operationRefusals().fullDownload?.code).toBe("COM_OBJECT_TABLE_EMPTY");
  });

  test("a project override of object 0's flags refuses the full download: no entry carries it", () => {
    const xml = withSecond;
    const run = (overrides: Map<number, { flags: { read: boolean } }>) => () => classify(parseAppConfig(xml)).planFullDownload("MV-07B0", { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml), comObjectOverrides: overrides });
    expect(run(new Map([[0, { flags: { read: true } }]]))).toThrow(refusedWith("COM_OBJECT_OVERRIDE_UNWRITABLE"));
    expect(run(new Map([[2, { flags: { read: false } }]]))).not.toThrow();
  });
});

describe("a System B full download refuses the PEI program (LSM 5), which it does not load", () => {
  test("a full-download step on LSM 5", () => {
    const xml = once(base, '<LoadProcedure MergeId="4">', '<LoadProcedure MergeId="4">\n                <LdCtrlWriteRelMem AppliesTo="full" ObjIdx="5" Offset="0" Size="4" Verify="true" />');
    const refusals = classify(parseAppConfig(xml)).operationRefusals();
    expect(refusals.fullDownload?.code).toBe("PEI_PROGRAM_UNSUPPORTED");
    expect(refusals.flashParams).toBeUndefined();
    expect(fullDownload(xml)).toThrow(refusedWith("PEI_PROGRAM_UNSUPPORTED"));
  });

  test("a segment of the application on LSM 5", () => {
    const xml = once(base, "</Code>", '<RelativeSegment Id="M-00FA_A-1234-01-ABCD_RS-05-00000" LoadStateMachine="5" Size="4"><Data>AAAAAA==</Data></RelativeSegment>\n            </Code>');
    expect(classify(parseAppConfig(xml)).operationRefusals().fullDownload?.code).toBe("PEI_PROGRAM_UNSUPPORTED");
    expect(fullDownload(xml)).toThrow(refusedWith("PEI_PROGRAM_UNSUPPORTED"));
  });

  test("the full download refuses it itself, before it asks the device anything", async () => {
    const xml = once(base, "</Code>", '<RelativeSegment Id="M-00FA_A-1234-01-ABCD_RS-05-00000" LoadStateMachine="5" Size="4"><Data>AAAAAA==</Data></RelativeSegment>\n            </Code>');
    expect(await rejection(classify(parseAppConfig(xml)).downloadFull(untouched, "MV-07B0", ctx))).toEqual(refusedWith("PEI_PROGRAM_UNSUPPORTED"));
  });

  test("a check declared for the full download alone, which the full download does not run, refuses it", () => {
    const xml = once(base, '<LoadProcedure MergeId="4">', '<LoadProcedure MergeId="4">\n                <LdCtrlCompareProp AppliesTo="full" ObjIdx="0" PropId="78" InlineData="00FA00000000" />');
    expect(classify(parseAppConfig(xml)).operationRefusals()).toEqual({ fullDownload: refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED") });
    expect(fullDownload(xml)).toThrow(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
  });

  test("an unload of the PEI program, the base bracket's own first step, and a check on its object, run by the parameter download too, refuse nothing", () => {
    const xml = once(base, '<LoadProcedure MergeId="4">', '<LoadProcedure MergeId="4">\n                <LdCtrlUnload AppliesTo="full" LsmIdx="5" />\n                <LdCtrlCompareProp ObjIdx="5" PropId="13" InlineData="00FA12340100" />');
    expect(classify(parseAppConfig(xml)).operationRefusals()).toEqual({});
    expect(fullDownload(xml)).not.toThrow();
  });

  // An unfilled allocation (Mode 0) as bussard's ETS captures show it (tools/bussard-unfilled-allocation.test.ts):
  // the fill flag off, the declared fill byte carried, and the segment's <Data> image written whole.
  const unfilled = (fill = "0") => once(base, '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8" Mode="1" Fill="0" />', `<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8" Mode="0" Fill="${fill}" />`);
  test("a full download that allocates a parameter segment with <Data> unfilled allocates it so and writes every byte of it", () => {
    const xml = unfilled("255");
    expect(classify(parseAppConfig(xml)).operationRefusals()).toEqual({});
    const build = fullDownload(xml)();
    expect(build.plan.filter((st) => st.op === "alloc" && st.lsm === 4)).toEqual([{ op: "alloc", lsm: 4, size: 8, fill: false, fillByte: 0xff }]);
    const writes = build.plan.flatMap((st) => (st.op === "writeSegment" && st.lsm === 4 ? [st] : []));
    expect(writes.map((w) => [w.offset, w.bytes.length])).toEqual([[0, 8]]);
    expect(writes[0].bytes.equals(build.segments[0].image)).toBe(true);
    expect(build.segments[0].fillByte).toBeUndefined();
  });

  test.each([
    ["a segment without <Data>", (xml: string) => once(xml, "<Data>AAAAAAAAAKs=</Data>", ""), "declares no <Data>"],
    ["a segment with a <Mask>", (xml: string) => once(xml, "<Data>AAAAAAAAAKs=</Data>", "<Data>AAAAAAAAAKs=</Data><Mask>//////////8=</Mask>"), "declares a <Mask>"],
    ["an application asking for ETS's partial form", (xml: string) => once(xml, "<LoadProcedures>", '<Options PreferPartialDownloadIfApplicationLoaded="true" />\n            <LoadProcedures>'), "partial form"],
  ])("an unfilled allocation of %s is not offered", (_, change, reason) => {
    const xml = change(unfilled());
    const refusal = classify(parseAppConfig(xml)).operationRefusals().fullDownload;
    expect(refusal).toEqual(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
    expect(refusal?.message).toContain(reason);
    expect(fullDownload(xml)).toThrow(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
  });

  test("a full download that allocates the parameter segment twice, filled and unfilled, is not offered", () => {
    const xml = once(base, '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8" Mode="1" Fill="0" />', '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8" Mode="1" Fill="0" />\n                <LdCtrlRelSegment AppliesTo="full" Size="8" Mode="0" Fill="0" />');
    const refusal = classify(parseAppConfig(xml)).operationRefusals().fullDownload;
    expect(refusal).toEqual(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
    expect(refusal?.message).toContain("twice");
  });

  test("a full download that allocates the parameter segment in another mode is not offered", () => {
    const xml = once(base, '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8" Mode="1" Fill="0" />', '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="8" Mode="2" Fill="0" />');
    expect(classify(parseAppConfig(xml)).operationRefusals()).toEqual({ fullDownload: refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED") });
    expect(fullDownload(xml)).toThrow(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
  });

  test("a full-download step the base bracket does not run refuses rather than vanish", () => {
    const xml = once(base, '<LoadProcedure MergeId="4">', '<LoadProcedure MergeId="4">\n                <LdCtrlDelay AppliesTo="full" MilliSeconds="200" />');
    expect(classify(parseAppConfig(xml)).operationRefusals().fullDownload?.code).toBe("FULL_DOWNLOAD_STEP_UNSUPPORTED");
    expect(fullDownload(xml)).toThrow(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
  });
});

corpusDescribe("System 7: LSM 5, the task segment's manufacturer and the declared sizes, by the captures", () => {
  const ABB = "M-0002_A-A001-13-63C2.xml.gz";
  const abb = catalogueXml(ABB);
  const plan = (xml: string, unitHoldsApplication: boolean) => classify(parseAppConfig(xml)).planFullDownload("MV-0701", { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml), unitHoldsApplication });

  // ETS's own log of its download onto the ABB US/U 4.2 and the Gira M-0008 (partial form): it removes the
  // declared task segment on LSM 5 before it runs the procedure.
  test("ETS's logs remove the task segment on LSM 5", () => {
    expect(captureText("abb-usu-4.2-ets6log-fulldownload-loaded.txt")).toContain('Removing <LdCtrlTaskSegment LsmIdx="5" Address="17406" ApplicationID="" PeiType="0" /> (legacy object table address announcement)');
    expect(captureText("gira-m0008-ets6log-fulldownload.txt")).toContain('Removing <LdCtrlTaskSegment LsmIdx="5" Address="16869" ApplicationID="" PeiType="0" /> (legacy object table address announcement)');
  });

  // The third-party synthetic captures (docs/testing.md, "Third-party test data"): ETS's declared-order
  // download of a product declaring a task segment on LSM 5 at its parameter segment, on MV-0701 (the
  // 0x0104 control) and MV-0705 (PID 5): task segments for LSM 1, 2 and 3, none for LSM 5. Busforge's
  // declared form takes the step, and its plan of the MV-0701 product declares the same task segments (the
  // MV-0705 product's full download is refused for a segment only its procedure declares).
  test.each([
    ["syn-s7-lsm5", "M-00FA_A-280F-11-0000", true],
    ["syn-s7-lsm5-0705", "M-00FA_A-2820-10-0000", false],
  ] as const)("%s: ETS's declared form sends no task segment on LSM 5, and neither does Busforge's", (product, app, plans) => {
    const xml = readFileSync(corpusPath(bussardApplication(product, app)), "utf8");
    expect(parseLoadProcedures(xml).blocks.flatMap((b) => b.steps).some((st) => st.verb === "LdCtrlTaskSegment" && st.attrs.LsmIdx === "5")).toBe(true);
    const cap = parseCapture(pcapToLog(readFileSync(corpusPath(bussardCapture(product, "defaults")))), 0x1101);
    const ets = [
      ...cap.writes.filter((w) => w.addr === 0x0104 && (w.data[0] & 0x0f) === 3 && w.data[1] === 2).map((w) => w.data[0] >> 4),
      ...cap.propWrites.filter((w) => w.pid === 5 && w.data[0] === 3 && w.data[1] === 2).map((w) => w.obj),
    ];
    expect(ets).toEqual([1, 2, 3]);
    expect(absoluteFullStepRefusal(parseLoadProcedures(xml), "declared", isMemoryMappedLsm(parseAppConfig(xml).mask))).toBeNull();
    if (!plans) return;
    const cfg = parseAppConfig(xml);
    const ours = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.1", params: new Map(), links: [], proc: parseLoadProcedures(xml), unitHoldsApplication: false }).plan;
    expect(ours.filter((st) => st.op === "taskSegment").map((st) => (st as { lsm: number }).lsm)).toEqual([1, 2, 3]);
    // Its RAM segment at 0x0700 (MemType 2, no <Data>): declared, and neither ETS nor Busforge writes it.
    const ram = (a: number) => a >= 0x0700 && a < 0x0710;
    expect(cap.writes.filter((w) => w.addr === 0x0104 && w.data[0] === 0x33 && w.data[1] === 0 && w.data.readUInt16BE(3) === 0x0700)).toHaveLength(1);
    expect(cap.writes.filter((w) => ram(w.addr))).toEqual([]);
    expect(ours.filter((st) => st.op === "absSegment" && st.address === 0x0700)).toHaveLength(1);
    expect(ours.filter((st) => st.op === "writeMem" && ram(st.address))).toEqual([]);
  });

  // The synthetic captures of sizes that disagree within one segment show ETS taking the procedure's sizes.
  // Busforge refuses each of them by its size check. syn-writerelmem-size (a Mode 0 allocation of 128 octets of
  // a 256-octet segment) is refused by it alone: its com-objects 0 and 1 make the table 00 01 4B 00, as ETS
  // writes it. The others are refused by another rule besides, so the size check takes nothing from a download
  // that would run otherwise: a Mode 1 allocation declared for the parameter download too, a segment only the
  // procedure declares.
  test("syn-writerelmem-size: refused for its sizes alone", () => {
    const xml = readFileSync(corpusPath(bussardApplication("syn-writerelmem-size", "M-00FA_A-2717-10-0000")), "utf8");
    const cfg = parseAppConfig(xml);
    expect(classify(cfg).operationRefusals().fullDownload?.code).toBe("LOAD_PROCEDURE_SIZE_MISMATCH");
    const view = buildDeviceConfig(cfg, new Map());
    expect(buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set()).toString("hex")).toBe("00014b00");
  });
  test.each([
    ["syn-writerelmem-tail", "M-00FA_A-272A-10-0000", (xml: string) => expect(assessParCoverage(parseLoadProcedures(xml), "relative").blocked.map((b) => b.verb)).toEqual(["LdCtrlRelSegment"])],
    ["syn-s7-static-split", "M-00FA_A-2889-10-0000", (xml: string) => expect(parseAppConfig(xml).absoluteSegments.some((sg) => sg.address === 0x4443)).toBe(false)],
  ] as const)("%s: refused for its sizes, and by another rule besides", (product, app, otherRule) => {
    const xml = readFileSync(corpusPath(bussardApplication(product, app)), "utf8");
    expect(procedureSizeRefusal(parseAppConfig(xml), parseLoadProcedures(xml))?.code).toBe("LOAD_PROCEDURE_SIZE_MISMATCH");
    otherRule(xml);
  });

  test("the ABB's and the Gira's declared form leave it out; any other step on LSM 5 is refused in both forms", () => {
    expect(plan(abb, false).plan.filter((st) => st.op === "taskSegment").map((st) => (st as { lsm: number }).lsm)).toEqual([1, 2, 3]);
    expect(plan(abb, true).plan.filter((st) => st.op === "taskSegment").map((st) => (st as { lsm: number }).lsm)).toEqual([1, 2]);
    expect(classify(parseAppConfig(abb)).fullDownloadLoadsApplication()).toBe(true);
    const gira = catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz");
    const giraPlan = classify(parseAppConfig(gira)).planFullDownload("MV-0705", { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(gira), unitHoldsApplication: false }).plan;
    expect(giraPlan.filter((st) => st.op === "taskSegment").map((st) => (st as { lsm: number }).lsm)).toEqual([1, 2, 3]);
    const load5 = once(abb, '<LdCtrlTaskSegment LsmIdx="5" Address="17406" />', '<LdCtrlTaskSegment LsmIdx="5" Address="17406" />\r\n                <LdCtrlLoad LsmIdx="5" />');
    expect(() => plan(load5, false)).toThrow(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
    expect(() => plan(load5, true)).toThrow(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
    expect(classify(parseAppConfig(load5)).operationRefusals()).toMatchObject({ fullDownload: refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"), flashParams: refusedWith("LOAD_STEP_UNSUPPORTED") });
    const write5 = once(abb, '<LdCtrlRestart />', '<LdCtrlWriteProp ObjIdx="5" PropId="67" InlineData="01" />\r\n                <LdCtrlRestart />');
    expect(() => plan(write5, false)).toThrow(refusedWith("FULL_DOWNLOAD_STEP_UNSUPPORTED"));
  });

  // The ABB declares LegacyPatchManufacturerIdInTaskSegment and names no OriginalManufacturer; ETS's task
  // segments carry its own manufacturer, 0002 (the 0x0104 controls of its captures).
  test("LegacyPatchManufacturerIdInTaskSegment with no other original manufacturer: the application's own, as captured", () => {
    const proc = parseLoadProcedures(abb);
    expect([proc.legacyTaskSegmentManufacturer, proc.originalManufacturer]).toEqual([true, undefined]);
    expect(captureText("abb-usu-4.2-ets-fulldownload-loaded.log")).toContain("8b01041302004000800002a00113");
    const segs = plan(abb, true).plan.filter((st) => st.op === "taskSegment");
    expect(segs.map((st) => (st as { manufacturer: number }).manufacturer)).toEqual([0x0002, 0x0002]);
  });

  test("with an original manufacturer of another maker: refused for every write that declares a task segment", () => {
    const xml = once(abb, 'Id="M-0002_A-A001-13-63C2" ', 'Id="M-0002_A-A001-13-63C2" OriginalManufacturer="M-0083" ');
    const proc = parseLoadProcedures(xml);
    expect(proc.originalManufacturer).toBe("M-0083");
    expect(taskSegmentManufacturerRefusal(parseAppConfig(xml), proc)?.code).toBe("TASK_SEGMENT_MANUFACTURER_UNSUPPORTED");
    const refusals = classify(parseAppConfig(xml)).operationRefusals();
    expect([refusals.fullDownload?.code, refusals.flashLinks?.code, refusals.flashParams]).toEqual(["TASK_SEGMENT_MANUFACTURER_UNSUPPORTED", "TASK_SEGMENT_MANUFACTURER_UNSUPPORTED", undefined]);
    expect(() => plan(xml, true)).toThrow(refusedWith("TASK_SEGMENT_MANUFACTURER_UNSUPPORTED"));
  });

  test("a declared segment size that disagrees with the segment refuses every write, before it asks the device anything", async () => {
    const xml = once(abb, '<LdCtrlAbsSegment LsmIdx="3" SegType="0" Address="28416" Size="8"', '<LdCtrlAbsSegment LsmIdx="3" SegType="0" Address="28416" Size="6"');
    const refusals = classify(parseAppConfig(xml)).operationRefusals();
    for (const op of ["flashParams", "flashLinks", "fullDownload"] as const) expect(refusals[op]?.code).toBe("LOAD_PROCEDURE_SIZE_MISMATCH");
    expect(() => plan(xml, true)).toThrow(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
    const profile = classify(parseAppConfig(xml));
    expect(await rejection(profile.downloadFull(untouched, "MV-0701", ctx))).toEqual(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
    expect(await rejection(profile.flashParameters(untouched, "MV-0701", ctx))).toEqual(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
    expect(await rejection(profile.flashGroupTables(untouched, "MV-0701", ctx))).toEqual(refusedWith("LOAD_PROCEDURE_SIZE_MISMATCH"));
  });

  test("a group table whose MaxEntries outgrow its segment refuses every write", () => {
    const xml = once(abb, '<AddressTable CodeSegment="M-0002_A-A001-13-63C2_AS-4000" Offset="0" MaxEntries="254"', '<AddressTable CodeSegment="M-0002_A-A001-13-63C2_AS-4000" Offset="0" MaxEntries="255"');
    expect(classify(parseAppConfig(xml)).operationRefusals().fullDownload?.code).toBe("LOAD_PROCEDURE_SIZE_MISMATCH");
  });

  test("every catalogue application declares agreeing sizes and a task-segment manufacturer the captures show", () => {
    for (const f of listCatalogue()) {
      const xml = catalogueXml(f);
      const cfg = parseAppConfig(xml), proc = parseLoadProcedures(xml);
      expect([f, procedureSizeRefusal(cfg, proc)]).toEqual([f, null]);
      expect([f, taskSegmentManufacturerRefusal(cfg, proc)]).toEqual([f, null]);
      // the counts of docs/load-procedures.md, "Steps refused until a capture shows them"
      expect([f, proc.blocks.flatMap((b) => b.steps).filter((st) => st.attrs.LsmIdx === "5" && st.verb !== "LdCtrlTaskSegment")]).toEqual([f, []]);
      expect([f, cfg.segments.filter((sg) => sg.lsm === 5)]).toEqual([f, []]);
    }
  });
});
