import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decodeCheckSums, decodeLoadedImage, loadKnxproj, etsLoadedCompletely, etsNotDownloaded } from "../packages/project/src/index.ts";
import { parseAppConfig, parseLoadProcedures, type AppConfig, type LoadProcedures } from "../packages/product/src/index.ts";
import { crc16Ccitt, crc16CcittFalse } from "../packages/knx/src/flash.ts";
import { iaToNum } from "../packages/knx/src/index.ts";
import { corpusPath, captureText } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { parseCapture, memoryImage, etsAllocations, reportedTableReferences, deviceConfiguration, deviceRows } from "./etsdiff.ts";
import { sha256 } from "./evidence.ts";
import { gunzipSync } from "node:zlib";
import { storeZip } from "../packages/project/test/ziputil.ts";
import { corpusProjects, counted, countedMismatches, countMismatches, loadedImageComparison, readEtsRecords, recordDevice, recordedAppXml, recordsToStartFrom, tally, type DeviceRecord, type EtsRecords, type PinnedCount } from "./ets-records.ts";

// ETS's own record of its last download of a device, kept in every project it saves
// (docs/verification.md, "ETS's download record"), held against Busforge's images offline: for every
// device of every corpus project that carries one, each byte ETS's record marks as its own equals the
// byte Busforge builds for the configuration the project stores. The projects are read through
// captures/ets-download-records.json.gz (tools/ets-records.ts), because most of them are
// password-protected. The lists below name devices by application and count projects, so no
// installation's addresses or files are named here.

// Generous: parsing the Jung and the OpenKNX applications alone takes seconds, and the comparison builds
// every distinct device configuration of the corpus projects.
const TIMEOUT = 300_000;

// Where ETS's record differs from Busforge's image. Each is named and explained in the corpus,
// internal/ets-download-record-deviations.md; a difference not listed here fails, and so does a listed
// one that is gone.
const KNOWN_DEVIATIONS = [
  // ETS's record of the com-object table dates from a download when object 3 had no link, and was not
  // written again after the project linked it; ETS's own later download writes 0x4f for the linked object.
  "gvs-amma-object-3-record-older-than-its-link: M-0085_A-0072-30-69AA object 3 at 6: Busforge 4f, ETS 4b (1 project)",
];

// The devices with a record that are not compared, each with why: ETS marks a part of the device as
// changed since that download, so the record no longer shows the project's configuration, or Busforge
// refuses the device's full download.
const NOT_COMPARED = [
  "M-0004_A-1111-12-8CCD-O000A refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-0004_A-7072-21-99A7-O000A not loaded: links (1 project)",
  "M-0004_A-7072-21-99A7-O000A not loaded: parameters (2 projects)",
  "M-0006_A-C016-10-A81B-O00C5 refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-0022_A-20D3-11-4134-O000A refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-0072_A-F150-10-FA59 refused: COM_OBJECT_TABLE_EMPTY (1 project)",
  "M-0073_A-204C-14-8903 refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-0083_A-0004-32-A137 refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-0085_A-002B-21-4744 refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-0085_A-0072-30-69AA not loaded: links (13 projects)",
  "M-00A7_A-2101-10-A85C refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-011E_A-2151-10-2E64-O0072 refused: COM_OBJECT_TABLE_EMPTY (1 project)",
  "M-0196_A-0094-10-C108 refused: PARAM_BYTE_ORDER_UNSUPPORTED (1 project)",
  "M-0216_A-0001-01-9381 refused: PARAM_HIDDEN_UNSUPPORTED (1 project)",
  "M-02D2_A-0001-11-F9F9 refused: FULL_DOWNLOAD_SEGMENT_UNKNOWN (1 project)",
];

// A moved count fails naming the corpus projects whose devices make it up (tools/ets-records.ts).
function expectNoMismatch(messages: string[]): void {
  if (messages.length) throw new Error(`\n${messages.join("\n\n")}`);
}

// A device of hardware with a PEI program (synthetic ids in the form ETS writes them: the Hardware2Program's id
// carries both programs' numbers): its record keys the application the product data name, never the id read as one.
test("a device's record names the application its product data name, on hardware with a PEI program too", () => {
  const H2P = "M-0083_H-PEI.2F1-0-O0007_HP-4201-13-6B9E-O0007-4201-23-00B3-O0007";
  const APP = "M-0083_A-4201-13-6B9E-O0007", PEI = "M-0083_A-4201-23-00B3-O0007";
  // The application declares LdCtrlLoadImageProp, the PEI program nothing: the record's flag shows which was read.
  const program = (id: string, type: string, procedures: string) => `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083"><ApplicationPrograms><ApplicationProgram Id="${id}" ProgramType="${type}" ApplicationNumber="1" ApplicationVersion="1" MaskVersion="MV-07B0" Name="${id}" LoadProcedureStyle="MergedProcedure"><Static>${procedures}</Static></ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;
  const appXml = program(APP, "ApplicationProgram", `<LoadProcedures><LoadProcedure MergeId="7"><LdCtrlLoadImageProp ObjIdx="4" PropId="27" /></LoadProcedure></LoadProcedures>`);
  const bytes = storeZip({
    "M-0083/Hardware.xml": `<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0083"><Hardware><Hardware Id="M-0083_H-PEI.2F1-0-O0007"><Hardware2Programs><Hardware2Program Id="${H2P}" MediumTypes="MT-0"><ApplicationProgramRef RefId="${APP}"/><ApplicationProgramRef RefId="${PEI}"/></Hardware2Program></Hardware2Programs></Hardware></Hardware></Manufacturer></ManufacturerData></KNX>`,
    [`M-0083/${APP}.xml`]: appXml, [`M-0083/${PEI}.xml`]: program(PEI, "PeiProgram", ""),
  });
  const loaded = { individualAddress: true, mediumConfig: true, application: true, parameters: true, communication: true };
  // As the project's Device has it: the application its Hardware2Program names (Device.appProgramId).
  const device = { id: "P-0001-0_DI-1", ia: "1.1.1", appRef: H2P, appProgramId: APP, etsLoaded: loaded, etsLoadedImage: "AAECAw==", etsCheckSums: "0102:abcd" };
  const rows = { values: [], instances: [], links: [], overrides: [] };
  const context = () => ({ path: "p.knxproj", bytes, catalogue: new Set<string>(), declares: new Map<string, boolean | null>(), apps: {} as Record<string, string>, rows: () => rows });
  const ctx = context();
  const rec = recordDevice(device, ctx);
  expect([rec.appRef, rec.application, rec.declaresLoadImageProp]).toEqual([H2P, APP, true]);
  expect(rec.config).toBe(rows);
  expect(Object.keys(ctx.apps)).toEqual([APP]);
  expect(gunzipSync(Buffer.from(ctx.apps[APP], "base64")).toString("utf8")).toBe(appXml);
  // Where the product data name no one application, a device with a download record is refused, and one without is
  // recorded with none, its load procedure not read.
  expect(() => recordDevice({ ...device, appProgramId: "" }, context())).toThrow(`has a download record, but the product data name no one application of its Hardware2Program ${H2P}`);
  expect(recordDevice({ ...device, appProgramId: "", etsLoadedImage: undefined, etsCheckSums: undefined }, context())).toMatchObject({ application: "", declaresLoadImageProp: null });
});

test("a records file of an earlier format is replaced only by a run over the whole corpus, one of a format the tool does not know never", () => {
  const empty = { format: "busforge-ets-records/2" as const, projects: [], apps: {} };
  expect(recordsToStartFrom({ format: "busforge-ets-records/1" }, true, [])).toEqual(empty);
  expect(recordsToStartFrom({ format: "busforge-ets-records/1" }, true, ["."])).toEqual(empty);
  expect(() => recordsToStartFrom({ format: "busforge-ets-records/1" }, true, ["captures"])).toThrow("record the whole corpus again with --missing");
  expect(() => recordsToStartFrom({ format: "busforge-ets-records/1" }, false, ["a.knxproj"])).toThrow("record the whole corpus again with --missing");
  for (const format of ["busforge-ets-records/3", undefined]) expect(() => recordsToStartFrom({ format }, true, [])).toThrow("which this tool does not know");
  const current = { format: "busforge-ets-records/2" as const, projects: [{ path: "p.knxproj", sha256: "x", devices: [] }], apps: {} };
  expect(recordsToStartFrom(current, false, ["p.knxproj"])).toBe(current);
});

const UNPROTECTED = "captures/bench-ets-project-params-edited-after-download.knxproj";

corpusDescribe("ETS's download record in the corpus projects", () => {
  const records: EtsRecords = readEtsRecords();
  const all = records.projects.flatMap((p) => p.devices.map((d) => ({ project: p.path, d })));
  const withRecord = all.filter(({ d }) => d.loadedImage);

  test("every corpus project is recorded as it is now, and nothing else", () => {
    const onDisk = corpusProjects();
    expect(records.projects.map((p) => p.path)).toEqual(onDisk);
    for (const p of records.projects) expect([p.path, p.sha256]).toEqual([p.path, sha256(readFileSync(corpusPath(p.path)))]);
  }, TIMEOUT);

  // The tool keeps what deviceRows reads from a project; the one project the check can open shows it.
  test("the configuration recorded for a device is what the project stores for it", () => {
    const project = loadKnxproj(readFileSync(corpusPath(UNPROTECTED)), undefined, "bench");
    const recorded = records.projects.find((p) => p.path === UNPROTECTED)!.devices.filter((d) => d.config);
    expect(recorded.length).toBe(2);
    for (const d of recorded) expect(d.config).toEqual(deviceRows(project, project.devices.find((x) => x.ia === d.ia)!.id));
  });

  // ETS keeps the record for an application whose load procedure names LdCtrlLoadImageProp, once it
  // has downloaded it, and for no other: the MV-0705 applications without it (MDT, Theben, Auro,
  // Steinel), the MV-0701 ones (ABB, Theben) and the MV-0012 one carry none, also after a download.
  test("a device carries a record exactly where its application names LdCtrlLoadImageProp and ETS downloaded it", () => {
    const off = all.filter(({ d }) => !!d.loadedImage !== (d.declaresLoadImageProp === true && d.etsLoaded.application));
    expect(off.map(({ project, d }) => `${project} ${d.ia}`)).toEqual([]);
    expectNoMismatch(countMismatches([{ what: "devices with ETS's download record", found: withRecord.length, pinned: 547, byProject: tally(withRecord.map((w) => w.project)) }]));
    expect(all.filter(({ d }) => !d.loadedImage && d.etsLoaded.application).length).toBeGreaterThan(100);
  });

  // Where the relative records of an object cover its memory-control-block regions one for one, from its
  // start and with every byte ETS's, the CheckSums value of each region is the CRC over the record, in the
  // convention of the device's firmware. Not covered: the Gira's first region, of which the record holds
  // the com-object table only, and an object whose record ETS cut to what a partial download wrote.
  test("CheckSums holds the CRC over each memory-control-block region, in the device's convention", () => {
    const conventions = new Map<string, Set<string>>();
    let regions = 0;
    for (const { d } of withRecord) {
      const recs = decodeLoadedImage(d.loadedImage!);
      for (const o of decodeCheckSums(d.checkSums!)) {
        const mine = recs.filter((r) => r.location === "relative" && r.object === o.object).sort((a, b) => a.start - b.start);
        let at = 0;
        const whole = mine.length === o.regions.length && mine.every((r) => { const ok = r.start === at && r.mask.every((m) => m === 0xff); at += r.data.length; return ok; });
        if (!whole) continue;
        mine.forEach((r, i) => {
          const crc = o.regions[i].crc;
          const by = crc === crc16CcittFalse(r.data) ? "CCITT-FALSE" : crc === crc16Ccitt(r.data) ? "CCITT" : "neither";
          const app = d.application;
          conventions.set(app, (conventions.get(app) ?? new Set()).add(by));
          regions++;
        });
      }
    }
    expect(Object.fromEntries([...conventions].map(([app, by]) => [app, [...by]]))).toEqual({
      "M-0004_A-7072-21-99A7-O000A": ["CCITT"],
      "M-002C_A-05E2-10-FC64": ["CCITT-FALSE"],
      "M-0048_A-0103-11-72A2": ["CCITT-FALSE"],
      "M-0048_A-493B-21-B471": ["CCITT"],
      "M-0059_A-7010-10-C902": ["CCITT-FALSE"],
      "M-0072_A-F150-10-FA59": ["CCITT"],
      "M-0073_A-204C-14-8903": ["CCITT"],
      "M-0083_A-0004-32-A137": ["CCITT"],
      "M-0083_A-0137-20-7EB2": ["CCITT"],
      "M-0085_A-001E-31-59BB": ["CCITT"],
      "M-0085_A-002B-21-4744": ["CCITT"],
      "M-0085_A-0072-30-69AA": ["CCITT-FALSE"],
      "M-008B_A-010A-10-BA9A": ["CCITT"],
      "M-00A7_A-2101-10-A85C": ["CCITT"],
      "M-00B6_A-0001-01-9BAE-O0184": ["CCITT"],
      "M-010B_A-0101-10-D3C0": ["CCITT"],
      "M-011E_A-2151-10-2E64-O0072": ["CCITT"],
      "M-0162_A-0004-11-F245": ["CCITT"],
      "M-01DF_A-0101-20-61B4": ["CCITT"],
      "M-0260_A-0005-11-2154": ["CCITT"],
      "M-02AA_A-0081-10-72A7-O0085": ["CCITT-FALSE"],
      "M-02CF_A-0101-10-3D4E": ["CCITT"],
      "M-02D2_A-0001-11-F9F9": ["CCITT-FALSE"],
    });
    expect(regions).toBeGreaterThan(50);
  });

  test("Busforge's images equal every byte ETS's record holds, but for the named deviations", () => {
    const apps = new Map<string, { cfg: AppConfig; proc: LoadProcedures }>();
    const app = (id: string) => {
      let a = apps.get(id);
      if (!a) { const xml = recordedAppXml(records, id); a = { cfg: parseAppConfig(xml), proc: parseLoadProcedures(xml) }; apps.set(id, a); }
      return a;
    };
    // One comparison per distinct device state: the house projects repeat most devices unchanged.
    const outcomes = new Map<string, ReturnType<typeof compare>>();
    const compare = (d: DeviceRecord) => {
      const { cfg, proc } = app(d.application);
      return loadedImageComparison(cfg, proc, d.ia, deviceConfiguration(cfg, d.config!), d.loadedImage!);
    };

    const found: { what: string; project: string }[] = [], notCompared: { what: string; project: string }[] = [];
    const comparedIn: string[] = [], distinctIn: string[] = [], bytesIn = new Map<string, number>();
    for (const { project, d } of withRecord) {
      const id = d.application;
      if (!etsLoadedCompletely(d)) { notCompared.push({ what: `${id} not loaded: ${etsNotDownloaded(d)!.join(", ")}`, project }); continue; }
      const key = JSON.stringify([d.ia, d.appRef, d.application, d.loadedImage, d.config]);
      let o = outcomes.get(key);
      if (!o) {
        o = compare(d);
        outcomes.set(key, o);
        // A distinct device state counts for the first project that shows it.
        if (!("refused" in o)) { distinctIn.push(project); bytesIn.set(project, (bytesIn.get(project) ?? 0) + o.bytes); }
      }
      if ("refused" in o) { notCompared.push({ what: `${id} refused: ${o.refused}`, project }); continue; }
      comparedIn.push(project);
      // One entry per project and byte: a byte two projects show counts twice.
      for (const m of o.mismatches) found.push({ what: `${id} ${m}`, project });
    }
    const named = (k: string) => k.slice(k.indexOf(": ") + 2);
    const pinnedDeviations = KNOWN_DEVIATIONS.map(named);
    expectNoMismatch(countedMismatches(found, pinnedDeviations));
    expectNoMismatch(countedMismatches(notCompared, NOT_COMPARED));
    // The named lists are held to the canonical form too: sorted, one line per entry, the plural right.
    expect(counted(found.map((f) => f.what))).toEqual(pinnedDeviations);
    expect(counted(notCompared.map((f) => f.what))).toEqual(NOT_COMPARED);
    // 519 compared records of 56 distinct device states (84916 bytes) across 547 records in all corpus projects
    // (547 = 519 compared + 28 not compared: 16 not loaded, 12 refused).
    const pinned: PinnedCount[] = [
      { what: "compared records", found: comparedIn.length, pinned: 519, byProject: tally(comparedIn) },
      { what: "distinct device states, each counted for the first project that shows it", found: distinctIn.length, pinned: 56, byProject: tally(distinctIn) },
      { what: "bytes ETS marks as its own, over the distinct device states", found: [...bytesIn.values()].reduce((n, b) => n + b, 0), pinned: 84916, byProject: bytesIn },
    ];
    expectNoMismatch(countMismatches(pinned));
  }, TIMEOUT);

  // The decoder held against a download whose bytes tools/etsdiff.test.ts pins ("System B full download":
  // the GVS AMMA): the unprotected bench project was saved after it, and the record of the AMMA is that
  // download. Every byte the record holds is the byte ETS wrote, or the allocation's fill where ETS wrote
  // none, and CheckSums holds the CRC the unit reported for each object at the end of it.
  test("the GVS AMMA's record is ETS's captured full download, and its CheckSums the CRCs the unit reported", () => {
    const project = loadKnxproj(readFileSync(corpusPath(UNPROTECTED)), undefined, "bench");
    const amma = project.devices.find((d) => d.appProgramId === "M-0085_A-0072-30-69AA")!;
    const cap = parseCapture(captureText("gvs-amma-ets-fulldownload-defaults.log"), iaToNum(amma.ia));
    const mem = memoryImage(cap.writes), alloc = etsAllocations(cap), refs = reportedTableReferences(cap);
    const recs = decodeLoadedImage(amma.etsLoadedImage!);
    expect(recs.map((r) => [r.location, r.object, r.start, r.data.length])).toEqual([["relative", 3, 0, 1066], ["relative", 4, 0, 2816]]);
    for (const r of recs) {
      const base = refs.get(r.object)!, fill = alloc.get(r.object)!.fill;
      expect(r.mask.every((m) => m === 0xff)).toBe(true);
      const ets: (number | null)[] = [...r.data].map((_, i) => mem.get(base + r.start + i) ?? fill);
      expect([...r.data]).toEqual(ets as number[]);
    }
    const reported = (obj: number) => cap.propResponses.filter((p) => p.obj === obj && p.pid === 27).at(-1)!.data.readUInt16BE(6);
    expect(decodeCheckSums(amma.etsCheckSums!)).toEqual([3, 4].map((object) => ({ object, regions: [{ flag: 1, crc: reported(object) }] })));
    // The AMMA reports CRC-16/CCITT-FALSE (flash.ts crc16CcittFalse), over the bytes the record holds.
    expect(recs.map((r) => crc16CcittFalse(r.data))).toEqual([reported(3), reported(4)]);
    expect(recs.map((r) => crc16Ccitt(r.data))).not.toEqual([reported(3), reported(4)]);
  });
});
