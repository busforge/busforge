import { test, expect } from "bun:test";
import { parseAppConfig, parseLoadProcedures, buildAbsoluteSegmentTargets, parameterMemoryBytes, planAbsoluteParFlash, planRelativeParFlash, resolveModuleInstances, toAppModel, type LoadProcedures } from "../src/index.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The proven device: Auro M-0081, ProductProcedure, param segment AS-4200 under LSM3.
corpusDescribe("the real M-0081 absolute par flash plan", () => {
  const xml = catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");
  const app = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const targets = buildAbsoluteSegmentTargets(app, new Map()).filter((t) => t.size > 0);
  const as4200 = targets.find((t) => t.address === 16896)!;

  test("no change -> empty plan", () => {
    // device already holds exactly our built image
    const current = new Map(targets.map((t) => [t.id, Buffer.from(t.bytes)]));
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(app, new Map(), proc, current);
    expect(changedBytes).toBe(0);
    expect(plan).toEqual([]);
    expect(unplaceable).toEqual([]);
  });

  test("one changed owned byte -> the LSM3 bracket writing every parameter-covered byte, as ETS does", () => {
    const firstOwned = as4200.owned.findIndex((o) => o);
    expect(firstOwned).toBeGreaterThanOrEqual(0);
    // device differs from our image at exactly one owned byte
    const dev = Buffer.from(as4200.bytes);
    dev[firstOwned] = dev[firstOwned] ^ 0xff;
    const current = new Map(targets.map((t) => [t.id, t.id === as4200.id ? dev : Buffer.from(t.bytes)]));

    const { plan, changedBytes, segments, unplaceable } = planAbsoluteParFlash(app, new Map(), proc, current);
    expect(changedBytes).toBe(1);
    expect(segments).toEqual([{ id: as4200.id, address: 16896, lsm: 3, changed: 1 }]);
    expect(unplaceable).toEqual([]);
    // exactly the LSM bracket (no connect/disconnect, the caller owns the connection): load(3), the runs of
    // the bytes a parameter covers (parWriteSet, the changed one with our value), loadCompleted(3), restart
    const covered = parameterMemoryBytes(app, as4200.id, as4200.size)!;
    const writes = plan.filter((s) => s.op === "writeMem") as { address: number; bytes: Buffer }[];
    const written = new Map(writes.flatMap((w) => [...w.bytes].map((b, i) => [w.address + i - 16896, b] as [number, number])));
    expect([...written.keys()]).toEqual(covered.flatMap((c, i) => (c ? [i] : [])));
    expect(written.get(firstOwned)).toBe(as4200.bytes[firstOwned]);
    expect(plan.filter((s) => s.op !== "writeMem")).toEqual([{ op: "load", lsm: 3 }, { op: "loadCompleted", lsm: 3 }, { op: "restart", requireReboot: true }]);
  });

  test("changed UNOWNED byte is never written", () => {
    const firstUnowned = as4200.owned.findIndex((o) => !o);
    expect(firstUnowned).toBeGreaterThanOrEqual(0);
    const dev = Buffer.from(as4200.bytes);
    dev[firstUnowned] = dev[firstUnowned] ^ 0xff; // differ on an unowned byte
    const current = new Map(targets.map((t) => [t.id, t.id === as4200.id ? dev : Buffer.from(t.bytes)]));
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(app, new Map(), proc, current);
    expect(changedBytes).toBe(0);
    expect(plan).toEqual([]);
    expect(unplaceable).toEqual([]);
  });

  test("a step scoped AppliesTo=full must not shape a par download", () => {
    const firstOwned = as4200.owned.findIndex((o) => o);
    const dev = Buffer.from(as4200.bytes);
    dev[firstOwned] = dev[firstOwned] ^ 0xff;
    const current = new Map(targets.map((t) => [t.id, t.id === as4200.id ? dev : Buffer.from(t.bytes)]));
    // same declarations as the real procedure, but scoped to the FULL download only
    const fullOnly: LoadProcedures = {
      style: "ProductProcedure",
      blocks: [{ steps: [
        { verb: "LdCtrlLoad", attrs: { LsmIdx: "3", AppliesTo: "full" } },
        { verb: "LdCtrlAbsSegment", attrs: { LsmIdx: "3", Address: "16896", AppliesTo: "full" } },
        { verb: "LdCtrlLoadCompleted", attrs: { LsmIdx: "3", AppliesTo: "full" } },
        { verb: "LdCtrlRestart", attrs: { AppliesTo: "full" } },
      ] }],
      verbs: [], unknown: [], preferPartialIfLoaded: false, dynamicTables: false, secureEnabled: false, extendedMemoryServices: false,
    };
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(app, new Map(), fullOnly, current);
    // the par download sees no par-applicable segment declaration -> the changed segment is
    // unplaceable (and the caller refuses), NOT silently bracketed by full-only steps
    expect(plan).toEqual([]);
    expect(changedBytes).toBe(0);
    expect(unplaceable).toEqual([{ id: as4200.id, address: 16896, changed: 1 }]);
  });

  test("changed segment not declared in the procedure -> reported unplaceable, never silently dropped", () => {
    const firstOwned = as4200.owned.findIndex((o) => o);
    const dev = Buffer.from(as4200.bytes);
    dev[firstOwned] = dev[firstOwned] ^ 0xff;
    const current = new Map(targets.map((t) => [t.id, t.id === as4200.id ? dev : Buffer.from(t.bytes)]));
    // a procedure that does not declare AS-4200 (no LdCtrlAbsSegment for its address)
    const emptyProc: LoadProcedures = { style: "ProductProcedure", blocks: [], verbs: [], unknown: [], preferPartialIfLoaded: false, dynamicTables: false, secureEnabled: false, extendedMemoryServices: false };
    const { plan, changedBytes, unplaceable } = planAbsoluteParFlash(app, new Map(), emptyProc, current);
    expect(plan).toEqual([]);
    expect(changedBytes).toBe(0);
    expect(unplaceable).toEqual([{ id: as4200.id, address: 16896, changed: 1 }]);
  });

  test("segment declared but its LSM never loaded -> unplaceable, not a silent under-write", () => {
    const firstOwned = as4200.owned.findIndex((o) => o);
    const dev = Buffer.from(as4200.bytes);
    dev[firstOwned] = dev[firstOwned] ^ 0xff;
    const current = new Map(targets.map((t) => [t.id, t.id === as4200.id ? dev : Buffer.from(t.bytes)]));
    // The segment IS declared (LdCtrlAbsSegment maps its address to LSM3), but the procedure
    // never emits an LdCtrlLoad for LSM3, so LSM3 is absent from the load order. The plan is
    // assembled by walking lsmOrder; without this guard LSM3's changed run would be counted in
    // changedBytes yet dropped from the plan -> a partial write reported as a full success.
    const noLoad: LoadProcedures = {
      style: "ProductProcedure",
      blocks: [{ steps: [
        { verb: "LdCtrlAbsSegment", attrs: { LsmIdx: "3", Address: "16896" } },
        { verb: "LdCtrlLoadCompleted", attrs: { LsmIdx: "3" } },
        { verb: "LdCtrlRestart", attrs: {} },
      ] }],
      verbs: [], unknown: [], preferPartialIfLoaded: false, dynamicTables: false, secureEnabled: false, extendedMemoryServices: false,
    };
    const { plan, changedBytes, segments, unplaceable } = planAbsoluteParFlash(app, new Map(), noLoad, current);
    expect(plan).toEqual([]);
    expect(changedBytes).toBe(0);
    expect(segments).toEqual([]);
    expect(unplaceable).toEqual([{ id: as4200.id, address: 16896, changed: 1 }]);
  });
});

test("planRelativeParFlash emits exactly the hardware-proven System B bracket", () => {
  // The oracle is the retired hardcoded executor's call order (hardware-proven on
  // an M-0162 device), hand-written here, NOT derived from the planner. The engine-side
  // device-call lock for the same bracket lives in packages/knx/test/flash-exec.test.ts.
  const image = Buffer.alloc(212, 0xab);
  const id = Buffer.from("0083123421", "hex");
  const owned = Array(212).fill(0xff);
  expect(planRelativeParFlash(4, image, owned, 0x4000, id)).toEqual([
    { op: "unload", lsm: 4 },
    { op: "load", lsm: 4 },
    { op: "alloc", lsm: 4, size: 212 },
    { op: "writeSegmentOwned", lsm: 4, image, owned, keptAt: 0x4000 },
    { op: "stampAppId", lsm: 4, data: id },
    { op: "loadCompleted", lsm: 4 },
    { op: "restart", requireReboot: true },
  ]);
});

test("planRelativeParFlash writes the declared MCB entries right after the allocation", () => {
  // The allocation resets the regions (Jung 400021SE: one region after a parameter flash without them).
  const image = Buffer.alloc(212, 0xab);
  const id = Buffer.from("0083123421", "hex");
  const mcb = [{ obj: 4, element: 1, data: Buffer.from("000000D300320000", "hex") }, { obj: 4, element: 2, data: Buffer.from("0000000100320000", "hex") }];
  const owned = Array(212).fill(0xff);
  expect(planRelativeParFlash(4, image, owned, 0x4000, id, true, mcb)).toEqual([
    { op: "unload", lsm: 4 },
    { op: "load", lsm: 4 },
    { op: "alloc", lsm: 4, size: 212 },
    { op: "writeProp", obj: 4, pid: 27, start: 1, data: mcb[0].data },
    { op: "writeProp", obj: 4, pid: 27, start: 2, data: mcb[1].data },
    { op: "writeSegmentOwned", lsm: 4, image, owned, keptAt: 0x4000 },
    { op: "stampAppId", lsm: 4, data: id },
    { op: "loadCompleted", lsm: 4 },
    { op: "restart", requireReboot: true },
  ]);
  expect(() => planRelativeParFlash(4, image, owned, 0x4000, id, true, [{ ...mcb[0], obj: 3 }])).toThrow("object 3");
});


// A System 7 parameter flash writes every byte a parameter covers, the bits no active parameter lies on at the
// segment's <Data> as ETS's image holds them (tools/etsdiff.test.ts: MDT BE-02001.02, Meteodata 140 S). A segment
// without <Data> has no such image any capture shows: there those bits keep what the unit holds.
corpusDescribe("a System 7 parameter flash over a segment without <Data> (Steinel M-008E)", () => {
  const xml = catalogueXml("M-008E_A-7079-10-9C41.xml.gz");
  const app = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const targets = buildAbsoluteSegmentTargets(app, new Map()).filter((t) => t.size > 0);

  test("a hidden parameter's byte keeps the unit's value when another parameter changes", () => {
    const seg = targets.find((t) => app.absoluteSegments.find((s) => s.id === t.id)!.data.length === 0 && t.owned.some(Boolean))!;
    const cov = parameterMemoryBytes(app, seg.id, seg.size, { colorWidth: true })!;
    const hidden = cov.findIndex((c, i) => c && seg.owned[i] === 0);
    const changed = seg.owned.findIndex((o) => o === 0xff);
    expect([hidden >= 0, changed >= 0, seg.dataBits!.every((b) => b === 0)]).toEqual([true, true, true]);
    const unit = Buffer.from(seg.bytes);
    unit[hidden] = 0x5a;
    unit[changed] ^= 0xff;
    const current = new Map(targets.map((t) => [t.id, t.id === seg.id ? unit : Buffer.from(t.bytes)]));
    const { plan, changedBytes } = planAbsoluteParFlash(app, new Map(), proc, current);
    expect(changedBytes).toBe(1);
    const written = new Map((plan.filter((s) => s.op === "writeMem") as { address: number; bytes: Buffer }[]).flatMap((w) => [...w.bytes].map((b, i) => [w.address + i, b] as [number, number])));
    expect([written.get(seg.address + hidden), written.get(seg.address + changed)]).toEqual([0x5a, seg.bytes[changed]]);
  });
});

// A parameter a <ParameterCalculation> sets is ETS's to compute, so its bits are not the image's <Data> to write when
// the configuration hides it: in a module instance too, whose ref carries the instance in the ModuleDef ref's id.
corpusDescribe("a hidden ParameterCalculation target in a module instance (MDT BE-06001.02)", () => {
  test("its bits are not written as <Data>", () => {
    const app = parseAppConfig(catalogueXml("M-0083_A-00B4-32-3919.xml.gz"));
    expect([...app.calculationRefs].some((r) => r.endsWith("_MD-2_P-105_R-543"))).toBe(true);
    const instances = resolveModuleInstances(app, new Map());
    const model = toAppModel(app, { includeUnions: true, instances });
    const targets = buildAbsoluteSegmentTargets(app, new Map(), { moduleInstances: instances });
    const placed = [...model.refs.values()].filter((r) => /_MD-2_M-\d+_MI-\d+_P-105_R-543$/.test(r.id)).map((r) => model.params.get(r.paramId)!);
    expect(placed.length).toBeGreaterThan(0);
    for (const p of placed) {
      const t = targets.find((x) => x.id === p.codeSegment)!;
      expect([p.offset, t.dataBits![p.offset!] & (0x80 >> p.bitOffset)]).toEqual([p.offset, 0]);
    }
  });
});
