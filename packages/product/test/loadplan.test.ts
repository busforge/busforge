import { test, expect } from "bun:test";
import { parseAppConfig, parseLoadProcedures, buildAbsoluteSegmentTargets, planAbsoluteParFlash, planRelativeParFlash, type LoadProcedures } from "../src/index.ts";
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

  test("one changed owned byte -> minimal proven LSM3 bracket", () => {
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
    // exactly the LSM bracket (no connect/disconnect, the caller owns the connection):
    // load(3), writeMem(1 byte @ owned addr), loadCompleted(3), restart
    expect(plan).toEqual([
      { op: "load", lsm: 3 },
      { op: "writeMem", address: 16896 + firstOwned, bytes: Buffer.from([as4200.bytes[firstOwned]]) },
      { op: "loadCompleted", lsm: 3 },
      { op: "restart", requireReboot: true },
    ]);
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
      verbs: [], unknown: [],
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
    const emptyProc: LoadProcedures = { style: "ProductProcedure", blocks: [], verbs: [], unknown: [] };
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
      verbs: [], unknown: [],
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
  // M-0162), hand-written here, NOT derived from the planner. The engine-side
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

