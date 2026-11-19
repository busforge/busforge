import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { decodeCheckSums, decodeLoadedImage, loadKnxproj, appProgramId, etsLoadedCompletely, etsNotDownloaded } from "../packages/project/src/index.ts";
import { classify, parseAppConfig, parseLoadProcedures, ProductError, type AppConfig, type LoadProcedures } from "../packages/product/src/index.ts";
import { crc16Ccitt, crc16CcittFalse } from "../packages/knx/src/flash.ts";
import { iaToNum } from "../packages/knx/src/index.ts";
import { corpusPath, corpusRoot, captureText } from "./corpus.ts";
import { corpusDescribe } from "./corpus-test.ts";
import { parseCapture, memoryImage, etsAllocations, reportedTableReferences, deviceConfiguration, deviceRows } from "./etsdiff.ts";
import { sha256 } from "./evidence.ts";
import { readEtsRecords, recordedAppXml, type DeviceRecord, type EtsRecords } from "./ets-records.ts";

// ETS's own record of its last download of a device, kept in every project it saves
// (docs/verification.md, "ETS's download record"), held against Busforge's images offline: for every
// device of every corpus project that carries one, each byte ETS's record marks as its own equals the
// byte Busforge builds for the configuration the project stores. The projects are read through
// captures/ets-download-records.json.gz (tools/ets-records.ts), because most of them are
// password-protected. The lists below name devices by application and count projects, so no
// installation's addresses or files are named here.

// Generous: parsing the Jung and the OpenKNX applications alone takes seconds, and the comparison builds
// every distinct device configuration of thirty-three projects.
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
  "M-0004_A-7072-21-99A7-O000A not loaded: links (1 project)",
  "M-0004_A-7072-21-99A7-O000A not loaded: parameters (2 projects)",
  "M-0085_A-0072-30-69AA not loaded: links (9 projects)",
];

// Each named deviation's projects, counted, as "<what> (<n> project[s])".
function counted(entries: string[]): string[] {
  const n = new Map<string, number>();
  for (const e of entries) n.set(e, (n.get(e) ?? 0) + 1);
  return [...n].map(([e, k]) => `${e} (${k} project${k === 1 ? "" : "s"})`).sort();
}

const hex = (n: number | undefined) => n === undefined ? "--" : n.toString(16).padStart(2, "0");
const UNPROTECTED = "captures/bench-ets-project-params-edited-after-download.knxproj";

corpusDescribe("ETS's download record in the corpus projects", () => {
  const records: EtsRecords = readEtsRecords();
  const all = records.projects.flatMap((p) => p.devices.map((d) => ({ project: p.path, d })));
  const withRecord = all.filter(({ d }) => d.loadedImage);

  test("every corpus project is recorded as it is now, and nothing else", () => {
    const onDisk = (readdirSync(corpusRoot()!, { recursive: true }) as string[]).filter((f) => f.endsWith(".knxproj") && !f.startsWith(".git/")).sort();
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
    expect(withRecord.length).toBe(338);
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
          const app = appProgramId(d.appRef);
          conventions.set(app, (conventions.get(app) ?? new Set()).add(by));
          regions++;
        });
      }
    }
    expect(Object.fromEntries([...conventions].map(([app, by]) => [app, [...by]]))).toEqual({
      "M-0004_A-7072-21-99A7-O000A": ["CCITT"],
      "M-0048_A-493B-21-B471": ["CCITT"],
      "M-0083_A-0137-20-7EB2": ["CCITT"],
      "M-0085_A-0072-30-69AA": ["CCITT-FALSE"],
      "M-0162_A-0004-11-F245": ["CCITT"],
    });
    expect(regions).toBeGreaterThan(50);
  });

  test("Busforge's images equal every byte ETS's record holds, but for the named deviations", () => {
    const apps = new Map<string, { cfg: AppConfig; proc: LoadProcedures }>();
    const app = (appRef: string) => {
      const id = appProgramId(appRef);
      let a = apps.get(id);
      if (!a) { const xml = recordedAppXml(records, id); a = { cfg: parseAppConfig(xml), proc: parseLoadProcedures(xml) }; apps.set(id, a); }
      return a;
    };
    // One comparison per distinct device state: the house projects repeat most devices unchanged.
    const outcomes = new Map<string, ReturnType<typeof compare>>();
    const compare = (d: DeviceRecord) => {
      const { cfg, proc } = app(d.appRef);
      const { params, instances, links, comObjectOverrides } = deviceConfiguration(cfg, d.config!);
      const profile = classify(cfg);
      let segments;
      try {
        // A unit ETS downloaded holds the application. On System 7, ETS's download of such a unit leaves
        // the application loaded and writes the bytes the parameters cover (docs/load-procedures.md,
        // "Which bytes ETS writes"); on System B the partial form needs the unit's memory, and the full
        // form's images hold the same bytes.
        segments = profile.planFullDownload(cfg.mask, {
          ia: d.ia, params, links, moduleInstances: instances, proc, comObjectOverrides,
          unitHoldsApplication: proc.preferPartialIfLoaded && profile.family === "system-7",
        }).segments;
      } catch (e) {
        if (e instanceof ProductError) return { refused: e.code };
        throw e;
      }
      const absolute = new Map<number, number>();
      for (const s of segments) if (s.address !== null) s.image.forEach((b, i) => absolute.set(s.address! + i, b));
      const mismatches: string[] = [];
      let bytes = 0;
      for (const r of decodeLoadedImage(d.loadedImage!)) {
        const image = r.location === "relative" ? segments.find((s) => s.address === null && s.lsm === r.object)?.image : undefined;
        r.data.forEach((ets, i) => {
          if (r.mask[i] !== 0xff) return;
          bytes++;
          const at = r.start + i;
          const ours = r.location === "absolute" ? absolute.get(at) : image?.[at];
          if (ours !== ets) mismatches.push(`object ${r.object} at ${at}: Busforge ${hex(ours)}, ETS ${hex(ets)}`);
        });
      }
      return { bytes, mismatches };
    };

    const found: string[] = [], notCompared: string[] = [];
    let compared = 0;
    for (const { d } of withRecord) {
      const id = appProgramId(d.appRef);
      if (!etsLoadedCompletely(d)) { notCompared.push(`${id} not loaded: ${etsNotDownloaded(d)!.join(", ")}`); continue; }
      const key = JSON.stringify([d.ia, d.appRef, d.loadedImage, d.config]);
      let o = outcomes.get(key);
      if (!o) { o = compare(d); outcomes.set(key, o); }
      if ("refused" in o) { notCompared.push(`${id} refused: ${o.refused}`); continue; }
      compared++;
      // One entry per project and byte: a byte two projects show counts twice.
      for (const m of o.mismatches) found.push(`${id} ${m}`);
    }
    const named = (k: string) => k.slice(k.indexOf(": ") + 2);
    expect(counted(found)).toEqual(KNOWN_DEVIATIONS.map(named));
    expect(counted(notCompared)).toEqual(NOT_COMPARED);
    // 326 records of 29 distinct device states, 42397 bytes ETS marks as its own.
    const distinct = [...outcomes.values()].flatMap((o) => ("refused" in o ? [] : [o.bytes]));
    expect([compared, distinct.length, distinct.reduce((n, b) => n + b, 0)]).toEqual([326, 29, 42397]);
  }, TIMEOUT);

  // The decoder held against a download whose bytes tools/etsdiff.test.ts pins ("System B full download":
  // the GVS AMMA): the unprotected bench project was saved after it, and the record of the AMMA is that
  // download. Every byte the record holds is the byte ETS wrote, or the allocation's fill where ETS wrote
  // none, and CheckSums holds the CRC the unit reported for each object at the end of it.
  test("the GVS AMMA's record is ETS's captured full download, and its CheckSums the CRCs the unit reported", () => {
    const project = loadKnxproj(readFileSync(corpusPath(UNPROTECTED)), undefined, "bench");
    const amma = project.devices.find((d) => appProgramId(d.appRef) === "M-0085_A-0072-30-69AA")!;
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
