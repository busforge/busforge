import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseAppConfig, parseLoadProcedures, buildAbsoluteSegmentTargets, planAbsoluteParFlash, type LoadProcedures } from "../src/index.ts";

const REAL = join(import.meta.dir, "fixtures", "real");
const fixture = (n: string) => gunzipSync(readFileSync(join(REAL, n))).toString("utf8");

// The proven device: Auro M-0081, ProductProcedure, param segment AS-4200 under LSM3.
const xml = fixture("M-0081_A-FE01-11-75D9.xml.gz");
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
    { op: "restart" },
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
