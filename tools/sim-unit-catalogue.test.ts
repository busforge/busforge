import { test, expect, setDefaultTimeout } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APCI, cemiLData, iaToNum } from "../packages/knx/src/index.ts";
import { captureText, catalogueXml, corpusPath, listCatalogue } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { captureLData } from "./etsdiff.ts";
import { etsBranches, rowUnit, ROW_FORMAT, SWEEP_DIR, type RowSpec } from "./ets-sweep.ts";
import { tempDir } from "./test-temp.ts";
import type { SimUnit } from "./sim-unit.ts";
import type { SystemBBehaviour, UnitBehaviour } from "./sim-unit-model.ts";
import { catalogueUnit, catalogueUnitRecord, catalogueUnitSpec, chooseDonor, donorDigest, donorUnfit, DONOR_RULES, learnIdentity, unitMask, type CatalogueUnitSpec } from "./sim-unit-catalogue.ts";
import { mismatchLines } from "./sim-unit-product.ts";
import { framePairs, replayCapture } from "./sim-unit-replay.ts";
import { AURO_M0081, MEANWELL_KNX40E, newSimUnit, SIM_UNITS, type SimUnitSpec } from "./sim-units.ts";

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
      // the Jung's applications change their memory after a restart.
      ["M-0004_A-7072-21-99A7-O000A", "gvs-amma"],
      // An MV-0705 application declaring a task control 1 and a task segment that starts no segment: the Auro shows
      // the task segment at the end of a segment and a task control 1 of count 0, the theLuxa P300 the task segment
      // inside a segment and a task control 1 of count 1; the Gira's application asks for count 0 inside a segment.
      ["M-0008_A-10D7-11-2783-O000A", "no donor for MV-0705: mdt-be02001: its captures show no task control 1 of object 3 with count 0; gira-ts3: its captures show no task control 1 of object 3 with count 0; auro-m0081: its captures show no task segment of object 3 inside a segment; theben-theluxa-p300: its captures show no task control 1 of object 3 with count 0; mdt-be06001: its captures show no task control 1 of object 3 with count 0"],
      ["M-0048_A-107E-12-5B58", "theben-theluxa-p300"],
      ["M-0048_A-140C-14-EB70", "no donor for MV-0701: abb-usu-4.2: its captures show no task-control-1; theben-meteodata-140s: its application changes its memory after a restart"],
      ["M-0048_A-493B-21-B471", "gvs-amma"],
      ["M-0048_A-9071-20-F258-O00EF", "meanwell-knx40e"],
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
    // A further MV-07B0 unit whose captures show its programming mode and its serial-number answer: fewer unshown.
    const meanwell = MEANWELL_KNX40E.behaviour as SystemBBehaviour;
    const shown: SimUnitSpec = { ...MEANWELL_KNX40E, id: "a-unit-showing-more", behaviour: { ...meanwell, programmingMode: false, serialNumberResponseTail: Buffer.alloc(4) } };
    const c = chooseDonor(app, [...SIM_UNITS, shown]);
    expect("donor" in c && [c.donor.id, c.rule]).toEqual([shown.id, DONOR_RULES["MV-07B0"]]);
    expect(chooseDonor(app, SIM_UNITS.filter((u) => u.id === "theben-mix2-hmg6t"))).toEqual({ refused: "no donor for MV-07B0: theben-mix2-hmg6t: its application changes its memory after a restart" });
    expect(chooseDonor(app, [])).toEqual({ refused: "no donor for MV-07B0: no own unit of the mask" });
    // A unit showing the Steinel's task control 1 but its task segment at the end of a segment, not inside one.
    const steinel = catalogueXml("M-008E_A-7079-10-9C41.xml.gz");
    const atEnd: SimUnitSpec = { ...AURO_M0081, id: "a-unit-at-the-end", behaviour: AURO_M0081.behaviour as UnitBehaviour, memoryMapped: undefined, propertyMapped: { ...AURO_M0081.propertyMapped!, taskControls1: [{ lsm: 3, count: 1 }] } };
    expect(donorUnfit(atEnd, steinel)).toBe("its captures show no task segment of object 3 inside a segment");
    expect(catalogueUnitSpec("M-0162_A-0004-11-F245", catalogueXml("M-0162_A-0004-11-F245.xml.gz"))).toEqual({ refused: "M-0162_A-0004-11-F245 has its own unit meanwell-knx40e" });
    const mdt = catalogueXml("M-0083_A-0137-20-7EB2.xml.gz");
    expect(catalogueUnitSpec("M-0083_A-0137-20-7EB2", mdt, { donor: "meanwell-knx40e" })).toEqual({ refused: "the donor meanwell-knx40e does not fit the rule: its captures show no confirmed restart" });
    expect(catalogueUnitSpec("M-0083_A-0137-20-7EB3", mdt)).toEqual({ refused: "the application program given is M-0083_A-0137-20-7EB2, not M-0083_A-0137-20-7EB3" });
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
    expect(() => rowUnit("r", dir, application, row({ ...record, donorDigest: "0".repeat(64) }, "export.xml"))).toThrow("its donor gvs-amma was collected again or given another behaviour since the row ran");
    expect(() => rowUnit("r", dir, application, row({ ...record, donor: undefined as unknown as string }, "export.xml"))).toThrow("its unit names no donor and identity loop lines");
    expect(() => rowUnit("r", dir, application, row({ ...record, donor: "meanwell-knx40e" }, "export.xml"))).toThrow("the donor meanwell-knx40e does not fit the rule: its captures show no confirmed restart");
    // An own unit is named by its id, and runs the row's application.
    expect(() => rowUnit("r", dir, application, row("gvs-amma"))).toThrow("the simulated unit gvs-amma runs M-0085_A-0072-30-69AA, not M-0083_A-0137-20-7EB2");
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
