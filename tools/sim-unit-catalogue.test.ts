import { test, expect, setDefaultTimeout } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APCI, cemiLData, iaToNum } from "../packages/knx/src/index.ts";
import { captureText, catalogueXml, corpusPath, listCatalogue } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { captureLData } from "./etsdiff.ts";
import { etsBranches, rowUnit, ROW_FORMAT, SWEEP_DIR, type RowSpec } from "./ets-sweep.ts";
import { tempDir } from "./test-temp.ts";
import { segmentAllocationRefusal, type SimUnit } from "./sim-unit.ts";
import type { SystemBBehaviour, UnitBehaviour } from "./sim-unit-model.ts";
import { gzipSync } from "node:zlib";
import { catalogueUnit, catalogueUnitRecord, catalogueUnitSpec, chooseDonor, donorDigest, donorUnfit, DONOR_RULES, learnIdentity, normalizeProductStoreXml, precheckDonor, PRODUCT_STORE_TAGS, RETIRED_DONOR_RULES, unitMask, type CatalogueUnitSpec } from "./sim-unit-catalogue.ts";
import { mismatchLines } from "./sim-unit-product.ts";
import { framePairs, replayCapture } from "./sim-unit-replay.ts";
import { ABB_USU42, AURO_M0081, GIRA_TS3, MDT_BE02001, MEANWELL_KNX40E, newSimUnit, OPENKNX_RAUMCONTROLLER, SIM_UNITS, THEBEN_DALI_GATEWAY, type SimUnitSpec } from "./sim-units.ts";

// Parsing an application takes up to 6.7 s alone (the OpenKNX RaumController's); the replays below run every unit's
// sweep row on its capture's clock. Twenty times that under a loaded full check (docs/testing.md, "Timeouts of heavy
// tests").
setDefaultTimeout(600_000);

const row = (id: string, file: string) => corpusPath(`${SWEEP_DIR}/${id}/${file}`);
// The catalogue unit of a corpus application, among the own units but its own where it has one (an own unit added
// later leaves the test about the catalogue unit, with the donor named).
const spec = (application: string, donor: string): CatalogueUnitSpec => {
  const units = SIM_UNITS.filter((u) => u.catalogue !== `${application}.xml.gz`);
  const s = catalogueUnitSpec(application, catalogueXml(`${application}.xml.gz`), { donor, units });
  if ("refused" in s) throw new Error(s.refused);
  return s;
};

// A capture on its own clock into a fresh unit `make` builds.
async function replay(make: (opts: ConstructorParameters<typeof SimUnit>[2]) => SimUnit, interfaceIa: number, text: string) {
  let clock = 0;
  const sim = make({ now: () => clock });
  const steps = await replayCapture(sim, text, { tool: "ETS", device: sim.deviceIa, interfaceIa, clock: (ms) => { clock = ms; }, broadcasts: true });
  return { sim, frames: framePairs(steps).map((p) => p.sim) };
}

// The capture up to ETS's first request that is no read: its identification of the unit before the download.
function readsOnly(text: string): string {
  const write = captureLData(text, "ETS").find((f) => {
    if (!f.fromTool || f.code !== 0x11 || f.tpdu.length < 2) return false;
    const apci = ((f.tpdu[0] & 0x03) << 8) | f.tpdu[1];
    const reads: number[] = [APCI.PROPERTY_READ, APCI.PROPERTY_DESCRIPTION_READ, APCI.AUTHORIZE_REQUEST, APCI.FUNCTION_PROPERTY_EXT_STATE_READ];
    return !reads.includes(apci) && (apci & 0x3c0) !== APCI.DEVICE_DESCRIPTOR_READ && (apci & 0x3c0) !== APCI.MEMORY_READ;
  });
  return write ? text.slice(0, text.indexOf(write.line)) : text;
}

corpusDescribe("a catalogue unit's donor", () => {
  test("is chosen per mask by its rule, for every application of the corpus", () => {
    const chosen = listCatalogue().map((f) => {
      const c = chooseDonor(catalogueXml(f));
      return [f.replace(/\.xml\.gz$/, ""), "refused" in c ? c.refused : c.donor.id];
    });
    expect(chosen).toEqual([
      ["M-0002_A-A001-13-63C2", "abb-usu-4.2"],
      // A System B download with Data Secure ends with the confirmed restart: of the units that show it, the MIX 2's and
      // the Jung's applications change their memory after a restart, and the GVS AMMA's object 3 has room for 2130 bytes
      // while the Jung 400021SE's com-object table needs 2656.
      ["M-0004_A-7072-21-99A7-O000A", "no donor for MV-07B0: meanwell-knx40e: its captures show no confirmed restart; theben-dali-gateway: its captures show no confirmed restart; openknx-raumcontroller: its captures show no confirmed restart; theben-mix2-hmg6t: its application changes its memory after a restart; jung-400021se: its application changes its memory after a restart; gvs-amma: segment of object 3: 2656 bytes at 0x3774 reach into the segment of object 4; where the unit places them then is not known; theben-mix2-jmg4t: its application changes its memory after a restart; theben-mix2-rmg8t: its application changes its memory after a restart"],
      // An MV-0705 application declaring a task control 1 and a task segment that starts no segment: the Auro shows
      // the task segment at the end of a segment and a task control 1 of count 0 at address 0, the theLuxa P300 the
      // task segment inside a segment and a task control 1 of count 1 at an address inside a segment; the Gira's
      // application asks for a task control 1 of count 0 at address 0 and its task segment inside a segment.
      // It reads the memory-control blocks at its end, which both MDT units refuse; its full download unloads the
      // application, after which the Gira's captures show no device control.
      ["M-0008_A-10D7-11-2783-O000A", "no donor for MV-0705: mdt-be02001: its collection shows it refuse property 1/27, which the application's LdCtrlLoadImageProp reads; gira-ts3: its captures show no device control after its application's unload, which decides whether its A_Memory_Write is echoed; auro-m0081: its captures show no task segment of object 3 inside a segment; theben-theluxa-p300: its captures show no task control 1 of object 3 with count 0 at address 0; mdt-be06001: its collection shows it refuse property 1/27, which the application's LdCtrlLoadImageProp reads"],
      ["M-0048_A-107E-12-5B58", "theben-theluxa-p300"],
      ["M-0048_A-140C-14-EB70", "no donor for MV-0701: abb-usu-4.2: its captures show no task-control-1; theben-meteodata-140s: its application changes its memory after a restart"],
      ["M-0048_A-493B-21-B471", "gvs-amma"],
      // The DALI-Gateway's com-object table needs 2688 bytes: the MEAN WELL's object 3 has room for 74 bytes only,
      // while the DALI-Gateway's own layout has 4096.
      ["M-0048_A-9071-20-F258-O00EF", "theben-dali-gateway"],
      ["M-0081_A-FE01-11-75D9", "auro-m0081"],
      ["M-0081_A-FF31-31-D6FF", "auro-m0081"],
      ["M-0083_A-00B4-32-3919", "mdt-be02001"],
      ["M-0083_A-00B6-32-9642", "mdt-be02001"],
      ["M-0083_A-0137-20-7EB2", "gvs-amma"],
      ["M-0083_A-0138-21-F18E-O0072", "no donor for MV-0012: no rule for it, the simulator models MV-07B0, MV-0701, MV-0705"],
      ["M-0085_A-0072-30-69AA", "gvs-amma"],
      ["M-008E_A-7079-10-9C41", "theben-theluxa-p300"],
      // With extended memory services ETS writes A_MemoryExtended_Write, which the MEAN WELL's captures do not show.
      ["M-00FA_A-A012-55-0000", "openknx-raumcontroller"],
      ["M-0162_A-0004-11-F245", "meanwell-knx40e"],
    ]);
  });

  test("takes a new own unit without a change of the rule, and refuses a mask none fits", () => {
    const app = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz");
    // The MEAN WELL's object 3 has room for 74 bytes only, so the rule rejects it for the 2688-byte DALI-Gateway table.
    expect(donorUnfit(MEANWELL_KNX40E, app)).toBe("segment of object 3: 2688 bytes at 0x1c06 reach into the segment of object 4; where the unit places them then is not known");
    // Declared Size="0" on LdCtrlRelSegment is refused up front even when another step or the com-object table also sizes the same object.
    const mw = catalogueXml("M-0162_A-0004-11-F245.xml.gz");
    const mwFullStep = '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="212" Mode="1" Fill="0" />';
    expect(mw).toContain(mwFullStep);
    expect(donorUnfit(MEANWELL_KNX40E, mw.replace(mwFullStep, '<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="0" Mode="1" Fill="0" />'))).toBe("segment of object 4: 0 bytes at 0x1c50 do not fit the unit's memory services");
    expect(donorUnfit(MEANWELL_KNX40E, mw.replace(mwFullStep, `<LdCtrlRelSegment AppliesTo="full" LsmIdx="4" Size="0" Mode="1" Fill="0" />${mwFullStep}`))).toBe("segment of object 4: 0 bytes at 0x1c50 do not fit the unit's memory services");
    expect(donorUnfit(MEANWELL_KNX40E, mw.replace(mwFullStep, `<LdCtrlRelSegment AppliesTo="full" LsmIdx="3" Size="0" Mode="1" Fill="0" />${mwFullStep}`))).toBe("segment of object 3: 0 bytes at 0x1c06 do not fit the unit's memory services");
    // A modular System B application sizes object 3 from its resolved module instances (BaseNumber + local Number),
    // not raw declaration numbers: BaseNumber 38 gives com-object 38 -> 78 bytes, past MEAN WELL's 74-byte room.
    const modular = `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0001"><ApplicationPrograms><ApplicationProgram Id="M-0001_A-0001-10-0001" ApplicationNumber="1" ApplicationVersion="16" ProgramType="ApplicationProgram" MaskVersion="MV-07B0" Name="Mod" LoadProcedureStyle="MergedProcedure" DefaultLanguage="en-US"><Static><Code><RelativeSegment Id="M-0001_A-0001-10-0001_RS-04-00000" Name="P" Size="16" LoadStateMachine="4"/></Code><LoadProcedures><LoadProcedure MergeId="2"><LdCtrlRelSegment LsmIdx="4" Size="16" Mode="1" Fill="0" AppliesTo="full"/></LoadProcedure></LoadProcedures></Static><ModuleDefs><ModuleDef Id="M-0001_A-0001-10-0001_MD-1" Name="M"><Arguments><Argument Id="M-0001_A-0001-10-0001_MD-1_A-1" Name="Base" Allocates="1"/></Arguments><Static><ComObjectTable><ComObject Id="M-0001_A-0001-10-0001_MD-1_O-1" Name="O" Number="0" BaseNumber="M-0001_A-0001-10-0001_MD-1_A-1" Text="O" FunctionText="O" ObjectSize="1 Bit" ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Disabled"/></ComObjectTable><ComObjectRefs><ComObjectRef Id="M-0001_A-0001-10-0001_MD-1_O-1_R-1" RefId="M-0001_A-0001-10-0001_MD-1_O-1"/></ComObjectRefs></Static><Dynamic><ChannelIndependentBlock><ParameterBlock Id="M-0001_A-0001-10-0001_MD-1_PB-1" Name="B"><ComObjectRefRef RefId="M-0001_A-0001-10-0001_MD-1_O-1_R-1"/></ParameterBlock></ChannelIndependentBlock></Dynamic></ModuleDef></ModuleDefs><Dynamic><Module Id="M-0001_A-0001-10-0001_M-1" RefId="M-0001_A-0001-10-0001_MD-1"><NumericArg RefId="M-0001_A-0001-10-0001_MD-1_A-1" Value="38"/></Module></Dynamic></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
    expect(donorUnfit(MEANWELL_KNX40E, modular)).toBe("segment of object 3: 78 bytes at 0x1c06 reach into the segment of object 4; where the unit places them then is not known");
    expect(donorUnfit(THEBEN_DALI_GATEWAY, modular)).toBeNull();
    // Shared segmentAllocationRefusal handles lower overlaps, zero-sized neighbours at the same start, and zero-sized neighbours ahead (e.g. OpenKNX obj 4 reaching obj 3).
    const sameStart = new Map([[1, { at: 0x1000, size: 0 }], [2, { at: 0x1000, size: 0 }]]);
    expect(segmentAllocationRefusal(sameStart, 1, 16, 0x10000)).toBeNull();
    const emptyAhead = new Map([[4, { at: 0x54, size: 0 }], [3, { at: 0x54b8, size: 0 }]]);
    expect(segmentAllocationRefusal(emptyAhead, 4, 21604, 0x1000000)).toBeNull();
    expect(segmentAllocationRefusal(emptyAhead, 4, 21605, 0x1000000)).toContain("reach into the segment of object 3");
    const lowerOverlap = new Map([[1, { at: 0x1000, size: 64 }], [2, { at: 0x1010, size: 16 }]]);
    expect(segmentAllocationRefusal(lowerOverlap, 2, 16, 0x10000)).toContain("reach into the segment of object 1");
    // A further MV-07B0 unit whose captures show its programming mode and its serial-number answer: fewer unshown.
    const dali = THEBEN_DALI_GATEWAY.behaviour as SystemBBehaviour;
    const shown: SimUnitSpec = { ...THEBEN_DALI_GATEWAY, id: "a-unit-showing-more", behaviour: { ...dali, programmingMode: false, serialNumberResponseTail: Buffer.alloc(4) } };
    const c = chooseDonor(app, [...SIM_UNITS, shown]);
    expect("donor" in c && [c.donor.id, c.rule]).toEqual([shown.id, DONOR_RULES["MV-07B0"]]);
    expect(chooseDonor(app, SIM_UNITS.filter((u) => u.id === "theben-mix2-hmg6t"))).toEqual({ refused: "no donor for MV-07B0: theben-mix2-hmg6t: its application changes its memory after a restart" });
    expect(chooseDonor(app, [])).toEqual({ refused: "no donor for MV-07B0: no own unit of the mask" });
    // A unit showing the Steinel's task control 1 but its task segment at the end of a segment, not inside one.
    const steinel = catalogueXml("M-008E_A-7079-10-9C41.xml.gz");
    const atEnd: SimUnitSpec = { ...AURO_M0081, id: "a-unit-at-the-end", behaviour: AURO_M0081.behaviour as UnitBehaviour, memoryMapped: undefined, propertyMapped: { ...AURO_M0081.propertyMapped!, taskControls1: [{ lsm: 3, count: 1, at: "inside" }] } };
    expect(donorUnfit(atEnd, steinel)).toBe("its captures show no task segment of object 3 inside a segment");
    expect(catalogueUnitSpec("M-0162_A-0004-11-F245", catalogueXml("M-0162_A-0004-11-F245.xml.gz"))).toEqual({ refused: "M-0162_A-0004-11-F245 has its own unit meanwell-knx40e" });
    const mdt = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");
    expect(catalogueUnitSpec("M-0083_A-0137-20-7EB2", mdt, { donor: "meanwell-knx40e" })).toEqual({ refused: "the donor meanwell-knx40e does not fit the rule: its captures show no confirmed restart" });
    expect(catalogueUnitSpec("M-0083_A-0137-20-7EB3", mdt)).toEqual({ refused: "the application program given is M-0083_A-0137-20-7EB2, not M-0083_A-0137-20-7EB3" });
  });

  test("asks of a download what its unit must answer: the device control after the unload where A_Memory_Write is echoed, each property a closing LdCtrlLoadImageProp reads", () => {
    // The DALI-Gateway's application declares no extended memory services: its memory is written with A_Memory_Write.
    const dali = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz");
    expect(donorUnfit(OPENKNX_RAUMCONTROLLER, dali)).toBe("its captures show no device control after its application's unload, which decides whether its A_Memory_Write is echoed");
    // The MDT BE-06001's application with a closing read of object 1's memory-control block, which both MDTs refuse.
    const be06001 = catalogueXml("M-0083_A-00B4-32-3919.xml.gz").replace("<LdCtrlRestart />", '<LdCtrlLoadImageProp ObjIdx="1" PropId="27" /><LdCtrlRestart />');
    expect([donorUnfit(MDT_BE02001, catalogueXml("M-0083_A-00B4-32-3919.xml.gz")), donorUnfit(MDT_BE02001, be06001)]).toEqual([null, "its collection shows it refuse property 1/27, which the application's LdCtrlLoadImageProp reads"]);
    const c = chooseDonor(be06001);
    expect("donor" in c && c.donor.id).toBe("auro-m0081");
    // A count alone answers only where the unit's captures show what the block reports after a load: the
    // DALI-Gateway's object 5 answered count 0 and no element.
    const object5 = catalogueXml("M-0162_A-0004-11-F245.xml.gz").replace(/(<LdCtrlLoadImageProp ObjIdx="4" PropId="27" \/>)/, '$1<LdCtrlLoadImageProp ObjIdx="5" PropId="27" />');
    expect(object5).toContain('ObjIdx="5" PropId="27"');
    expect([donorUnfit(MEANWELL_KNX40E, object5)?.startsWith("its collection"), donorUnfit(THEBEN_DALI_GATEWAY, object5)]).toEqual([true, "its collection shows only the element count of property 5/27, which the application's LdCtrlLoadImageProp reads"]);
    // An MV-0705 download unloads the application: the Gira Tastsensor 3's captures show no device control after that.
    expect(donorUnfit(GIRA_TS3, catalogueXml("M-0083_A-00B4-32-3919.xml.gz"))).toBe("its captures show no device control after its application's unload, which decides whether its A_Memory_Write is echoed");
  });

  test("refuses an MV-0705 application whose task declarations it cannot read or no unit of the mask takes", () => {
    const be06001 = catalogueXml("M-0083_A-00B4-32-3919.xml.gz");
    const refused = (xml: string) => { const c = chooseDonor(xml); return "refused" in c ? c.refused : c.donor.id; };
    expect(refused(be06001.replace('<LdCtrlTaskSegment LsmIdx="3" Address="17408" />', '<LdCtrlTaskSegment LsmIdx="3" Address="abc" />'))).toBe('no donor for MV-0705: the load procedure declares LdCtrlTaskSegment Address="abc", which is not an unsigned decimal number; refusing to read a value from it');
    expect(refused(be06001.replace('Address="17408" Size="200"', 'Address="" Size="200"'))).toBe('no donor for MV-0705: the load procedure declares LdCtrlAbsSegment Address="", which is not an unsigned decimal number; refusing to read a value from it');
    expect(refused(be06001.replace("<LdCtrlRestart />", '<LdCtrlTaskCtrl1 LsmIdx="3" Address="" Count="" /><LdCtrlRestart />'))).toBe('no donor for MV-0705: the load procedure declares LdCtrlTaskCtrl1 Address="", which is not an unsigned decimal number; refusing to read a value from it');
    expect(refused(be06001.replace("<LdCtrlRestart />", '<LdCtrlTaskSegment LsmIdx="4" Address="17408" /><LdCtrlRestart />'))).toBe("no donor for MV-0705: the application declares a segment or task on object 4, whose load-state machine no unit of the mask shows");
    // ETS never sends a task segment on machine 5 (the Gira Tastsensor 3's application declares one).
    expect(refused(be06001.replace("<LdCtrlRestart />", '<LdCtrlRestart /><LdCtrlTaskSegment LsmIdx="5" Address="17408" />'))).toBe("mdt-be02001");
  });

  test("refuses MV-0701 applications with SegType=1, unload/complete without AbsSegment+TaskSegment, or EEPROM outside collected memory, while keeping clean MV-0701 apps on abb-usu-4.2", () => {
    const mv0701App = (steps: string) =>
      `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0002"><ApplicationPrograms><ApplicationProgram Id="M-0002_A-9999-10-0001" ApplicationNumber="39321" ApplicationVersion="16" ProgramType="ApplicationProgram" MaskVersion="MV-0701" Name="Test0701" LoadProcedureStyle="ProductProcedure" PeiType="128" DefaultLanguage="en-US"><Static><LoadProcedures><LoadProcedure>${steps}</LoadProcedure></LoadProcedures></Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
    const cleanSteps = [
      "<LdCtrlConnect />",
      '<LdCtrlUnload LsmIdx="1" /><LdCtrlUnload LsmIdx="2" /><LdCtrlUnload LsmIdx="3" />',
      '<LdCtrlLoad LsmIdx="1" /><LdCtrlAbsSegment LsmIdx="1" SegType="0" Address="16384" Size="511" Access="255" MemType="3" SegFlags="0" /><LdCtrlTaskSegment LsmIdx="1" Address="16384" /><LdCtrlLoadCompleted LsmIdx="1" />',
      '<LdCtrlLoad LsmIdx="2" /><LdCtrlAbsSegment LsmIdx="2" SegType="0" Address="16896" Size="509" Access="255" MemType="3" SegFlags="0" /><LdCtrlTaskSegment LsmIdx="2" Address="16896" /><LdCtrlLoadCompleted LsmIdx="2" />',
      '<LdCtrlLoad LsmIdx="3" /><LdCtrlAbsSegment LsmIdx="3" SegType="0" Address="1792" Size="100" Access="0" MemType="2" SegFlags="0" /><LdCtrlAbsSegment LsmIdx="3" SegType="0" Address="28656" Size="16" Access="255" MemType="3" SegFlags="128" /><LdCtrlTaskSegment LsmIdx="3" Address="28656" /><LdCtrlTaskSegment LsmIdx="5" Address="28656" /><LdCtrlLoadCompleted LsmIdx="3" />',
      "<LdCtrlRestart /><LdCtrlDisconnect />",
    ].join("");

    // Clean MV-0701 app (RAM SegType=0 MemType=2 outside 0x4000-0x6fff, EEPROM at exact upper boundary 0x6ff0-0x6fff, plus LSM 5 task segment) picks abb-usu-4.2.
    const clean = chooseDonor(mv0701App(cleanSteps));
    expect("donor" in clean && clean.donor.id).toBe("abb-usu-4.2");
    expect(donorUnfit(ABB_USU42, catalogueXml("M-0002_A-A001-13-63C2.xml.gz"))).toBeNull();

    // 1. LdCtrlAbsSegment SegType="1" (RAM/stack segment = additional load control 1) is refused on abb-usu-4.2.
    const withSeg1 = mv0701App(cleanSteps.replace(
      '<LdCtrlAbsSegment LsmIdx="3" SegType="0" Address="1792" Size="100" Access="0" MemType="2" SegFlags="0" />',
      '<LdCtrlAbsSegment LsmIdx="3" SegType="0" Address="1792" Size="100" Access="0" MemType="2" SegFlags="0" /><LdCtrlAbsSegment LsmIdx="3" SegType="1" Address="1892" Size="1" Access="0" MemType="2" SegFlags="0" />',
    ));
    expect(donorUnfit(ABB_USU42, withSeg1)).toBe("its captures show no additional load control 1 (SegType=1)");
    expect(chooseDonor(withSeg1)).toEqual({
      refused: "no donor for MV-0701: abb-usu-4.2: its captures show no additional load control 1 (SegType=1); theben-meteodata-140s: its application changes its memory after a restart",
    });

    // 2. LdCtrlUnload -> LdCtrlLoadCompleted without LdCtrlTaskSegment (or without an absolute segment, or with only LSM 5 TaskSegment, or declared before unload) is refused.
    const noTask = mv0701App(cleanSteps.replace('<LdCtrlTaskSegment LsmIdx="1" Address="16384" />', ""));
    expect(chooseDonor(noTask)).toEqual({
      refused: "no donor for MV-0701: the load procedure completes unloaded load-state machine 1 without LdCtrlTaskSegment",
    });
    const noAbs = mv0701App(cleanSteps.replace('<LdCtrlAbsSegment LsmIdx="1" SegType="0" Address="16384" Size="511" Access="255" MemType="3" SegFlags="0" />', ""));
    expect(chooseDonor(noAbs)).toEqual({
      refused: "no donor for MV-0701: the load procedure declares LdCtrlTaskSegment for load-state machine 1 at 0x4000, outside its declared segments",
    });
    const onlyLsm5Task = mv0701App(cleanSteps.replace('<LdCtrlTaskSegment LsmIdx="3" Address="28656" />', ""));
    expect(chooseDonor(onlyLsm5Task)).toEqual({
      refused: "no donor for MV-0701: the load procedure completes unloaded load-state machine 3 without LdCtrlTaskSegment",
    });
    const beforeUnload = mv0701App(
      '<LdCtrlConnect /><LdCtrlAbsSegment LsmIdx="1" SegType="0" Address="16384" Size="16" Access="255" MemType="3" SegFlags="0" /><LdCtrlTaskSegment LsmIdx="1" Address="16384" /><LdCtrlUnload LsmIdx="1" /><LdCtrlLoad LsmIdx="1" /><LdCtrlLoadCompleted LsmIdx="1" /><LdCtrlRestart /><LdCtrlDisconnect />',
    );
    expect(chooseDonor(beforeUnload)).toEqual({
      refused: "no donor for MV-0701: the load procedure completes unloaded load-state machine 1 without an absolute segment and LdCtrlTaskSegment",
    });
    // Completing a machine that was never unloaded (partial form) is still allowed.
    const noUnload = mv0701App('<LdCtrlConnect /><LdCtrlLoad LsmIdx="3" /><LdCtrlLoadCompleted LsmIdx="3" /><LdCtrlRestart /><LdCtrlDisconnect />');
    expect("donor" in chooseDonor(noUnload)).toBe(true);

    // 3. EEPROM LdCtrlAbsSegment (SegType="0", MemType="3") outside abb-usu-4.2's collected 0x4000-0x6fff window is refused.
    const above = mv0701App(cleanSteps.replaceAll('Address="28656"', 'Address="28672"'));
    expect(donorUnfit(ABB_USU42, above)).toBe("its collected memory does not cover EEPROM segment of object 3 (0x7000-0x700f, 16 bytes)");
    const spanning = mv0701App(cleanSteps.replace('Address="28656" Size="16"', 'Address="28656" Size="32"'));
    expect(donorUnfit(ABB_USU42, spanning)).toBe("its collected memory does not cover EEPROM segment of object 3 (0x6ff0-0x700f, 32 bytes)");
    const below = mv0701App(cleanSteps.replace('Address="16384" Size="511"', 'Address="16368" Size="32"'));
    expect(donorUnfit(ABB_USU42, below)).toBe("its collected memory does not cover EEPROM segment of object 1 (0x3ff0-0x400f, 32 bytes)");
    const zeroSize = mv0701App(cleanSteps.replace('Address="28656" Size="16"', 'Address="28656" Size="0"'));
    expect(chooseDonor(zeroSize)).toEqual({
      refused: "no donor for MV-0701: the application declares an absolute segment of 0 octets at 0x6ff0, which the memory services do not reach whole",
    });
    const full16BitSize = mv0701App(cleanSteps.replace('Address="1792" Size="100"', 'Address="0" Size="65536"'));
    expect(chooseDonor(full16BitSize)).toEqual({
      refused: "no donor for MV-0701: the application declares an absolute segment of 65536 octets at 0x0, which the memory services do not reach whole",
    });
    // Task segment outside the machine's declared segments (at segment end or declared before LdCtrlAbsSegment),
    // additional control before LdCtrlLoad, cross-machine segment overlap, and LSM outside 1-4 are refused.
    const taskAtEnd = mv0701App(cleanSteps.replace('<LdCtrlTaskSegment LsmIdx="3" Address="28656" />', '<LdCtrlTaskSegment LsmIdx="3" Address="28672" />'));
    expect(chooseDonor(taskAtEnd)).toEqual({
      refused: "no donor for MV-0701: the load procedure declares LdCtrlTaskSegment for load-state machine 3 at 0x7000, outside its declared segments",
    });
    const taskBeforeAbs = mv0701App(
      '<LdCtrlConnect /><LdCtrlUnload LsmIdx="1" /><LdCtrlLoad LsmIdx="1" /><LdCtrlTaskSegment LsmIdx="1" Address="16384" /><LdCtrlAbsSegment LsmIdx="1" SegType="0" Address="16384" Size="16" Access="255" MemType="3" SegFlags="0" /><LdCtrlLoadCompleted LsmIdx="1" /><LdCtrlRestart /><LdCtrlDisconnect />',
    );
    expect(chooseDonor(taskBeforeAbs)).toEqual({
      refused: "no donor for MV-0701: the load procedure declares LdCtrlTaskSegment for load-state machine 1 at 0x4000, outside its declared segments",
    });
    const absBeforeLoad = mv0701App(
      '<LdCtrlConnect /><LdCtrlUnload LsmIdx="1" /><LdCtrlAbsSegment LsmIdx="1" SegType="0" Address="16384" Size="16" Access="255" MemType="3" SegFlags="0" /><LdCtrlTaskSegment LsmIdx="1" Address="16384" /><LdCtrlLoad LsmIdx="1" /><LdCtrlLoadCompleted LsmIdx="1" /><LdCtrlRestart /><LdCtrlDisconnect />',
    );
    expect(chooseDonor(absBeforeLoad)).toEqual({
      refused: "no donor for MV-0701: the load procedure declares LdCtrlAbsSegment for unloaded load-state machine 1 before LdCtrlLoad",
    });
    const overlap = mv0701App(cleanSteps.replace('Address="16896" Size="509"', 'Address="16894" Size="509"'));
    expect(chooseDonor(overlap)).toEqual({
      refused: "no donor for MV-0701: the application declares an absolute segment for load-state machine 2 at 0x41fe (509 octets) reaching into one of load-state machine 1",
    });
    const badLsm = mv0701App(cleanSteps.replace("<LdCtrlRestart />", '<LdCtrlUnload LsmIdx="6" /><LdCtrlRestart />'));
    expect(chooseDonor(badLsm)).toEqual({
      refused: "no donor for MV-0701: the load procedure declares LdCtrlUnload for load-state machine 6, which no MV-0701 unit models",
    });
  });

  test("precheckDonor normalizes ETS ProductStore XML (plain or gzipped) to the same chooseDonor verdict and falls back on broken or mismatched files", () => {
    // Invert PRODUCT_STORE_TAGS to convert standard KNX XML to ETS ProductStore shortened tag form (skipping comments/CDATA).
    const shortOf = new Map([...PRODUCT_STORE_TAGS].map(([short, full]) => [full, short]));
    const toProductStore = (xml: string) =>
      `\uFEFF${xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][A-Za-z0-9_:-]*)(?=[\s/>])/g, (m, slash: string | undefined, tag: string | undefined) => {
        if (!tag) return m;
        const short = shortOf.get(tag);
        return short ? `<${slash ?? ""}${short}` : m;
      })}`;
    // CDATA, comments, and Object.prototype-named tags stay untouched while every shortened tag expands; standard XML is idempotent.
    const withCdata = "\uFEFF<KNX><!-- <AP Id=\"x\"/> --><Script><![CDATA[if (a <P && b <M) {}]]></Script><toString/><constructor/><APS><AP Id=\"a\"/></APS></KNX>";
    const expanded = normalizeProductStoreXml(withCdata);
    expect(expanded).toBe('<KNX><!-- <AP Id="x"/> --><Script><![CDATA[if (a <P && b <M) {}]]></Script><toString/><constructor/><ApplicationPrograms><ApplicationProgram Id="a"/></ApplicationPrograms></KNX>');
    expect(normalizeProductStoreXml(expanded)).toBe(expanded);
    // Every single entry in PRODUCT_STORE_TAGS round-trips cleanly.
    for (const [short, full] of PRODUCT_STORE_TAGS) {
      expect(normalizeProductStoreXml(`<${short}></${short}>`)).toBe(`<${full}></${full}>`);
    }

    // Every corpus application: precheckDonor on shortened ProductStore XML matches chooseDonor() verbatim;
    // Buffer and gzipped-Buffer inputs are exercised on both a qualifying and a refused application.
    const bufferChecked = new Set(["M-0083_A-00B4-32-3919", "M-0008_A-10D7-11-2783-O000A"]);
    for (const f of listCatalogue()) {
      const app = f.replace(/\.xml\.gz$/, "");
      const std = catalogueXml(f);
      const expected = chooseDonor(std);
      const storeXml = toProductStore(std);
      const inputs: (string | Buffer)[] = bufferChecked.has(app)
        ? [storeXml, Buffer.from(storeXml, "utf8"), gzipSync(Buffer.from(storeXml, "utf8"))]
        : [storeXml];
      for (const input of inputs) {
        const got = precheckDonor(app, input);
        if ("refused" in expected) expect(got).toEqual({ kind: "refused", why: expected.refused });
        else expect(got).toEqual({ kind: "donor", donor: expected.donor, rule: expected.rule });
      }
    }

    // Trailing comment after </KNX> is valid XML and does not fall back.
    const okApp = "M-0083_A-00B4-32-3919";
    const okStore = toProductStore(catalogueXml(`${okApp}.xml.gz`));
    expect(precheckDonor(okApp, `${okStore}\n<!-- trailing comment -->`, { mask: "0705" })).toMatchObject({ kind: "donor", donor: MDT_BE02001 });
    // Broken, mid-file corrupted, truncated, invalid-UTF8, corrupt-gzip, wrong-id or wrong-mask inputs fall back instead of refusing.
    expect(precheckDonor(okApp, okStore, { mask: "07B0" })).toEqual({ kind: "fallback", why: "ProductStore XML mask MV-0705 disagrees with MV-07B0" });
    expect(precheckDonor("M-0083_A-00B4-32-9999", okStore)).toEqual({ kind: "fallback", why: `ProductStore XML holds ${okApp}, expected M-0083_A-00B4-32-9999` });
    expect(precheckDonor(okApp, okStore.replace(/<\/KNX>\s*$/, ""))).toMatchObject({ kind: "fallback", why: expect.stringContaining("ProductStore XML is malformed") });
    expect(precheckDonor(okApp, okStore.replace("</AP>", "</Wrong>"))).toMatchObject({ kind: "fallback", why: expect.stringContaining("ProductStore XML is malformed") });
    expect(precheckDonor(okApp, Buffer.concat([Buffer.from(okStore, "utf8"), Buffer.from([0xff, 0xfe])]))).toMatchObject({ kind: "fallback", why: expect.stringContaining("could not decode ProductStore XML") });
    expect(precheckDonor(okApp, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff]))).toMatchObject({ kind: "fallback", why: expect.stringContaining("could not decode ProductStore XML") });
    expect(precheckDonor(okApp, "<KNX><NoApp/></KNX>")).toMatchObject({ kind: "fallback", why: expect.stringContaining("could not parse ProductStore XML") });
  });
});

corpusDescribe("a catalogue unit", () => {
  test("answers ETS's reads of its donor's calibration row, each with its source, the product's identity where it gives one", async () => {
    // The MDT BE-06001 on the MDT BE-02001.02, whose defaults row is calibrated against the real unit: the one MV-0705
    // donor with a row, and the one other MV-0705 application it fits. The BE-06001's own rows take its own unit.
    const s = spec("M-0083_A-00B4-32-3919", "mdt-be02001");
    const text = readsOnly(readFileSync(row("M-0083_A-00B6-32-9642/defaults", "ets.log"), "utf8"));
    const own = await replay((o) => newSimUnit(s.donor, o), s.donor.interfaceIa, text);
    const unit = catalogueUnit(s);
    const cat = await replay((o) => unit.make(o), s.interfaceIa, text);
    expect([own.sim.refusals, cat.sim.refusals]).toEqual([[], []]);
    // Its frames are the donor's but for the hardware type, which the application's compare gives.
    const differ = own.frames.flatMap((f, i) => (f === cat.frames[i] ? [] : [[f, cat.frames[i]]]));
    expect(differ).toEqual([["b0 57d6004e10010000000002ac", "b0 57d6004e10010000000002aa"], ["b0 5bd6004e10010000000002ac", "b0 5bd6004e10010000000002aa"]]);
    expect(cat.sim.lines.filter((l) => l.startsWith("answered"))).toEqual([
      "answered A_DeviceDescriptor_Read: product: the application's mask MV-0705, donor mdt-be02001's",
      // The donor refuses PID 56 (it answers no element), as the MDT does.
      "answered A_PropertyValue_Read 0/56 of 0 from 1: donor mdt-be02001",
      "answered A_Authorize_Request: donor mdt-be02001",
      "answered A_PropertyValue_Read 0/11 of 1 from 1: donor mdt-be02001",
      "answered A_PropertyValue_Read 0/12 of 1 from 1: product: the application's manufacturer M-0083",
      "answered A_PropertyValue_Read 0/78 of 1 from 1: product: LdCtrlCompareProp 0/78 0000000002aa00000000",
      "answered A_PropertyValue_Read 0/78 of 1 from 1: product: LdCtrlCompareProp 0/78 0000000002aa00000000",
    ]);
    expect(cat.sim.lines.slice(0, 5)).toEqual([
      `catalogue unit of M-0083_A-00B4-32-3919 from donor mdt-be02001 (MDT BE-02001.02), by the rule ${DONOR_RULES["MV-0705"]}`,
      "source of 0/12: product: the application's manufacturer M-0083",
      "source of 0/78: product: LdCtrlCompareProp 0/78 0000000002aa00000000",
      "source of 3/13: product: the application's program id 008300b432",
      "source of PEI type: product: the application's PEI type 1",
    ]);
    // It holds the product's application: the task segment of the donor's own, in the donor's capture, it refuses.
    const whole = await replay((o) => unit.make(o), s.interfaceIa, readFileSync(row("M-0083_A-00B6-32-9642/defaults", "ets.log"), "utf8"));
    expect(whole.sim.refusals[0]).toBe("sim-refused A_PropertyValue_Write 1/5 0302400001008300b632: a task segment for application 008300b632, where the unit holds 008300b432");
  });

  test("of an application without an own unit answers ETS's reads of its donor's captured download, the product's identity where it gives one", async () => {
    // The Steinel True Presence on the Theben theLuxa P300, the donor its rule picks.
    const s = spec("M-008E_A-7079-10-9C41", "theben-theluxa-p300");
    const capture = captureText("theluxa-p300-ets-fulldownload.log");
    const text = readsOnly(capture);
    const own = await replay((o) => newSimUnit(s.donor, o), s.donor.interfaceIa, text);
    const unit = catalogueUnit(s);
    const cat = await replay((o) => unit.make(o), s.interfaceIa, text);
    expect([own.sim.refusals, cat.sim.refusals]).toEqual([[], []]);
    // Its frames are the donor's but for the manufacturer, which the product gives.
    const differ = own.frames.flatMap((f, i) => (f === cat.frames[i] ? [] : [[f, cat.frames[i]]]));
    expect(differ).toEqual([["b0 53d6000c10010048", "b0 53d6000c1001008e"]]);
    expect(cat.sim.lines.filter((l) => l.startsWith("source"))).toEqual([
      "source of 0/12: product: the application's manufacturer M-008E",
      "source of 3/13: product: the application's program id 008e707910",
      "source of PEI type: product: the application's PEI type 0",
    ]);
    // It holds the product's application: the donor's own task segment, in the donor's capture, it refuses.
    const whole = await replay((o) => unit.make(o), s.interfaceIa, capture);
    expect(whole.sim.refusals[0]).toBe("sim-refused A_PropertyValue_Write 1/5 03024000000048107e12: a task segment for application 0048107e12, where the unit holds 008e707910");
    // And the task segment and task control 1 the product declares, not the donor's: after the unloads, the
    // application's segment, its task segment inside it and its task control 1 taken, the donor's task control 1 refused.
    const sim = unit.make();
    const send = (tpdu: string) => sim.sendCemi(cemiLData(s.interfaceIa, sim.deviceIa, Buffer.from(tpdu, "hex")));
    const frames = ["80", "43d70105100104000000000000000000", "c2", "47d70205100104000000000000000000", "c6", "4bd70305100104000000000000000000", "ca", "4fd70305100101000000000000000000", "ce",
      "53d703051001030043ec02eef2038000", "d2", "57d703051001030246ce00008e707910", "d6", "5bd703051001030446bb010000000000", "da", "5fd703051001030445d3010000000000"];
    for (const t of frames) await send(t);
    expect(sim.refusals).toEqual(["sim-refused A_PropertyValue_Write 3/5 030445d3010000000000: a task control 1 at 0x45d3 with count 1, which the application does not declare for object 3"]);
  });

  test("answers its load states as memory from what its donor held at the start", async () => {
    const unit = catalogueUnit(spec("M-0083_A-00B4-32-3919", "mdt-be02001")).make();
    // A connection, then A_Memory_Read of the four load states at 0xB6EA.
    await unit.sendCemi(cemiLData(0x11ff, unit.deviceIa, Buffer.from([0x80])));
    await unit.sendCemi(cemiLData(0x11ff, unit.deviceIa, Buffer.from([0x42, 0x04, 0xb6, 0xea])));
    expect([unit.refusals, unit.lines.at(-1)]).toEqual([[], "answered A_Memory_Read 4 at 0xb6ea: donor mdt-be02001"]);
  });

  test("refuses a property neither the product nor the donor gives, with its reason", async () => {
    const unit = catalogueUnit(spec("M-0083_A-0137-20-7EB2", "gvs-amma")).make();
    const read = (o: number, pid: number) => cemiLData(0x11ff, unit.deviceIa, Buffer.from([0x03, 0xd5, o, pid, 0x10, 0x01]));
    await unit.sendCemi(read(0, 200));
    await unit.sendCemi(read(0, 12));
    expect(unit.refusals).toEqual(["sim-refused A_PropertyValue_Read 0/200 of 1 from 1: neither the product nor donor gvs-amma gives it"]);
    expect(unit.lines.at(-1)).toBe("answered A_PropertyValue_Read 0/12 of 1 from 1: product: the application's manufacturer M-0083");
  });

  test("of an own unit's application on that unit answers ETS's whole download as the own unit does", async () => {
    // Every own unit that fits the rule for its own application: the product's identity over it is its own. ETS's
    // download of its defaults row, or for a unit without a sweep row yet its captured full download into the real unit.
    // The Gira's captures show no task control 1, which its application declares.
    const rowless: Record<string, string> = { "auro-m0081": "auro-m0081-ets-fulldownload.log", "theben-theluxa-p300": "theluxa-p300-ets-fulldownload.log", "mdt-be06001": "mdtui-ets-fulldownload.log" };
    const fit = SIM_UNITS.filter((u) => donorUnfit(u, catalogueXml(u.catalogue)) === null);
    expect(fit.map((u) => u.id)).toEqual(["meanwell-knx40e", "theben-dali-gateway", "openknx-raumcontroller", "gvs-amma", "abb-usu-4.2", "mdt-be02001", "auro-m0081", "theben-theluxa-p300", "mdt-be06001"]);
    for (const u of fit) {
      const s: CatalogueUnitSpec = { id: `${u.id}@${u.id}`, name: u.name, application: u.catalogue.replace(/\.xml\.gz$/, ""), appXml: catalogueXml(u.catalogue), interfaceIa: u.interfaceIa, interfaceMaxApdu: u.interfaceMaxApdu, donor: u, rule: DONOR_RULES[unitMask(u)], learned: [] };
      const text = rowless[u.id] ? captureText(rowless[u.id]) : readFileSync(row(`${s.application}/defaults`, "ets.log"), "utf8");
      const own = await replay((o) => newSimUnit(u, o), u.interfaceIa, text);
      const cat = await replay((o) => catalogueUnit(s).make(o), u.interfaceIa, text);
      expect([u.id, cat.frames, cat.sim.refusals]).toEqual([u.id, own.frames, own.sim.refusals]);
    }
  });
});

corpusDescribe("a catalogue row's unit", () => {
  test("is built from the donor row.json names and the application program in the row's export", () => {
    const application = "M-0083_A-0137-20-7EB2";
    const dir = tempDir("catalogue-row-");
    // A manufacturer XML holding the one program stands in for the row's export here: both carry it the same way.
    writeFileSync(join(dir, "export.xml"), catalogueXml(`${application}.xml.gz`));
    const record = catalogueUnitRecord(catalogueUnit(spec(application, "gvs-amma")));
    const row = (unit: RowSpec["unit"], exported?: string): RowSpec => ({ format: ROW_FORMAT, unit, etsBuild: "ETS", simulator: "sim:1", ...(exported ? { export: exported } : {}) });
    const unit = rowUnit("r", dir, application, row(record, "export.xml"));
    expect("donor" in unit && [unit.id, unit.donor.id, unit.rule, unit.learned]).toEqual([`${application}@gvs-amma`, "gvs-amma", DONOR_RULES["MV-07B0"], []]);
    expect(() => rowUnit("r", dir, application, row(record))).toThrow("a catalogue unit's application program comes from the row's export, and row.json names none");
    expect(() => rowUnit("r", dir, "M-0083_A-0137-20-7EB3", row(record, "export.xml"))).toThrow("holds no application program M-0083_A-0137-20-7EB3");
    expect(() => rowUnit("r", dir, application, row({ ...record, rule: "MV-07B0: an older rule" }, "export.xml"))).toThrow("the row is to run again");
    expect(() => rowUnit("r", dir, application, row({ ...record, donorDigest: "0".repeat(64) }, "export.xml"))).toThrow("its donor gvs-amma was collected again, run on another application program or given another behaviour since the row ran");
    expect(() => rowUnit("r", dir, application, row({ ...record, donor: undefined as unknown as string }, "export.xml"))).toThrow("its unit names no donor, rule and identity loop lines");
    expect(() => rowUnit("r", dir, application, row({ ...record, rule: undefined as unknown as string }, "export.xml"))).toThrow("its unit names no donor, rule and identity loop lines");
    expect(() => rowUnit("r", dir, application, row({ ...record, donor: "meanwell-knx40e" }, "export.xml"))).toThrow("the donor meanwell-knx40e does not fit the rule: its captures show no confirmed restart");
    // An own unit is named by its id, and runs the row's application.
    expect(() => rowUnit("r", dir, application, row("gvs-amma"))).toThrow("the simulated unit gvs-amma runs M-0085_A-0072-30-69AA, not M-0083_A-0137-20-7EB2");
    // A stored row recorded under a known retired rule whose application now has no qualifying donor stays replayable on
    // its recorded donor (with retiredRule set); an invented rule string, a current-rule mismatch, or a retired-rule row
    // whose application still qualifies under the current rule is rejected.
    const retiredApp = "M-0002_A-9998-10-0001";
    const retiredXml = `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0002"><ApplicationPrograms><ApplicationProgram Id="${retiredApp}" ApplicationNumber="39320" ApplicationVersion="16" ProgramType="ApplicationProgram" MaskVersion="MV-0701" Name="Retired0701" LoadProcedureStyle="ProductProcedure" PeiType="128" DefaultLanguage="en-US"><Static><LoadProcedures><LoadProcedure><LdCtrlConnect /><LdCtrlUnload LsmIdx="3" /><LdCtrlLoad LsmIdx="3" /><LdCtrlAbsSegment LsmIdx="3" SegType="0" Address="1792" Size="100" Access="0" MemType="2" SegFlags="0" /><LdCtrlAbsSegment LsmIdx="3" SegType="1" Address="1892" Size="1" Access="0" MemType="2" SegFlags="0" /><LdCtrlTaskSegment LsmIdx="3" Address="1792" /><LdCtrlLoadCompleted LsmIdx="3" /><LdCtrlRestart /><LdCtrlDisconnect /></LoadProcedure></LoadProcedures></Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
    writeFileSync(join(dir, "retired.xml"), retiredXml);
    const oldRule = RETIRED_DONOR_RULES["MV-0701"][0];
    const retiredRecord = { source: "donor" as const, donor: "abb-usu-4.2", donorDigest: donorDigest(ABB_USU42), rule: oldRule, identity: [], properties: {} };
    const retiredUnit = rowUnit("r-old", dir, retiredApp, row(retiredRecord, "retired.xml"));
    expect("donor" in retiredUnit && [retiredUnit.donor.id, retiredUnit.rule, retiredUnit.retiredRule]).toEqual(["abb-usu-4.2", oldRule, true]);
    expect(catalogueUnit(retiredUnit as CatalogueUnitSpec).spec.rule).toBe(oldRule);
    expect(() => rowUnit("r-invented", dir, retiredApp, row({ ...retiredRecord, rule: "MV-0701: invented" }, "retired.xml"))).toThrow("the donor abb-usu-4.2 does not fit the rule");
    expect(() => rowUnit("r-cur", dir, retiredApp, row({ ...retiredRecord, rule: DONOR_RULES["MV-0701"] }, "retired.xml"))).toThrow("the donor abb-usu-4.2 does not fit the rule");
    expect(() => rowUnit("r-bad", dir, retiredApp, row({ ...retiredRecord, rule: "MV-07B0: wrong mask" }, "retired.xml"))).toThrow("the donor abb-usu-4.2 does not fit the rule");
    const qualifyingApp = "M-0002_A-9997-10-0001";
    const qualifyingXml = retiredXml.replaceAll(retiredApp, qualifyingApp).replace('<LdCtrlAbsSegment LsmIdx="3" SegType="1" Address="1892" Size="1" Access="0" MemType="2" SegFlags="0" />', "");
    writeFileSync(join(dir, "qualifying.xml"), qualifyingXml);
    expect(() => rowUnit("r-qual", dir, qualifyingApp, row(retiredRecord, "qualifying.xml"))).toThrow("the row is to run again");
  });
});

corpusDescribe("a catalogue unit's identity loop", () => {
  const WRONG = row("M-0162_A-0004-11-F245/defaults", "checks/wrong-hardware-type/ets6.log.txt");

  test("reads the Required data mismatch line ETS wrote into a sweep row", () => {
    expect(mismatchLines(readFileSync(WRONG)).map((m) => [m.object, m.pid, m.device.toString("hex"), m.required.toString("hex")])).toEqual([[0, 78, "620100000005", "620100000004"]]);
  });

  test("takes what ETS required where the unit answered what the line says, and refuses another run's line", () => {
    // The MDT SCN-IP000.03 (MV-07B0, Data Secure) on the GVS AMMA.
    const s = spec("M-0083_A-0137-20-7EB2", "gvs-amma");
    const unit = catalogueUnit(s);
    const answers = unit.objects.get(0)!.get(78)!.elements![0].toString("hex");
    // The line of the MEAN WELL run names another unit's answer.
    expect(learnIdentity(s, readFileSync(WRONG))).toEqual({ refused: `ETS saw 620100000005 in 0/78, which this identity does not answer: the log is of another run (${mismatchLines(readFileSync(WRONG))[0].line})` });
    // The same line, as ETS would write it for this unit: what it answers, and a value ETS requires instead.
    const line = mismatchLines(readFileSync(WRONG))[0].line.replace("620100000005 instead of 620100000004", `${answers.toUpperCase()} instead of 0085000000AB`);
    const learned = learnIdentity(s, line);
    if ("refused" in learned) throw new Error(learned.refused);
    const next = catalogueUnit(learned.spec);
    expect(next.objects.get(0)!.get(78)!.elements![0].toString("hex")).toBe("0085000000ab");
    expect(next.properties.get("0/78")).toBe(`identity loop: ETS6.log "${line}"`);
    expect(catalogueUnitRecord(next)).toEqual({ source: "donor", donor: "gvs-amma", donorDigest: donorDigest(s.donor), rule: DONOR_RULES["MV-07B0"], identity: [line], properties: Object.fromEntries(next.properties) });
    // Run again with it, the line no longer applies: the unit answers what ETS required.
    expect(learnIdentity(learned.spec, line)).toEqual({ refused: expect.stringContaining("ETS saw") });
    // A value longer than the donor's element is not filled in, nor one shorter.
    const longer = line.replace("0085000000AB", "0085000000AB01");
    expect(learnIdentity(s, longer)).toEqual({ refused: expect.stringContaining("past the donor's 6, and not zero there") });
    expect(learnIdentity(s, line.replace("0085000000AB", "01"))).toEqual({ refused: expect.stringContaining("gives 1 octets 01, the donor answers 6; what the unit answers after them is not given") });
    // A value with a zero tail past the donor's element leaves the unit's answer as it was: a rerun would fail the same.
    expect(learnIdentity(s, line.replace("0085000000AB", `${answers.toUpperCase()}0000`))).toEqual({ refused: "the unit answers 0/78 as before with what ETS required: a rerun fails the same" });
  });
});

corpusDescribe("where ETS went by an answer of the unit", () => {
  const branches = (id: string, ia: string, mask: string) => etsBranches(readFileSync(row(id, "ets6.log.txt"), "latin1"), readFileSync(row(id, "ets.log"), "utf8"), iaToNum(ia), mask).map((b) => [b.on, b.answer]);

  test("is read from the row's ETS6.log and, on MV-0701, its frames", () => {
    expect(branches("M-0162_A-0004-11-F245/defaults", "1.1.20", "MV-07B0")).toEqual([
      ["max-apdu", "PID 56 answered 55; ETS negotiated 40, restricted by ByInterface"],
      ["verify-mode", "ETS detected memory verify mode off, then on; it switched AutoVerifyMode on 4 times"],
    ]);
    expect(branches("M-0048_A-493B-21-B471/defaults", "1.1.51", "MV-07B0")).toEqual([
      ["max-apdu", "PID 56 answered 55; ETS negotiated 55, restricted by ByTargetDevice"],
      ["confirmed-restart", "the unit answered the confirmed restart with NoError, process time 00:00:01"],
    ]);
    expect(branches("M-0002_A-A001-13-63C2/defaults", "1.1.201", "MV-0701")).toEqual([
      ["max-apdu", "PID 56 not answered (Lesen von Property(0/56, 1, 1) fehlgeschlagen: Empty response), ETS assumed 15; ETS negotiated 15, restricted by ByTargetDevice"],
      ["read-before-write", "the unit answered ETS 229 octets of its memory before ETS wrote there; ETS then wrote 19 of them and left 210 as the unit answered them"],
    ]);
  });
});

test("the rule of each mask is named", () => {
  expect(Object.keys(DONOR_RULES)).toEqual(["MV-07B0", "MV-0701", "MV-0705"]);
});

test("the server of a unit (tools/sim-unit-serve.ts) refuses a repeatable option without its value", () => {
  const serve = (...args: string[]) => Bun.spawnSync([process.execPath, "run", fileURLToPath(new URL("./sim-unit-serve.ts", import.meta.url)), ...args], { env: { PATH: process.env.PATH ?? "" } });
  for (const [option, rest] of [["--override", []], ["--learned-from", ["--port", "3700"]]] as const) {
    const run = serve("meanwell-knx40e", "--tool", "ETS", "--log", join(tempDir("serve-"), "capture.log"), option, ...rest);
    expect([option, run.exitCode !== 0, run.stderr.toString().includes(`${option} takes a value`)]).toEqual([option, true, true]);
  }
});
