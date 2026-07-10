import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { KnxDevice } from "@busforge/knx";
import {
  parseAppConfig, classify, toAppModel,
  buildAbsoluteSegmentTargets, decodeAbsoluteImage,
  buildParameterImage, decodeParameterImage,
} from "@busforge/product";

// Direct coverage of DeviceProfile.readState, the seam where a device read becomes the
// programmed baseline + drift. The route tests stub readDeviceState out (readback-route.test.ts),
// so this is the ONLY test that exercises the projection itself: read segment bytes off a mock
// device, decode them, and record ONLY the refs that (a) differ from the project image and
// (b) are in relevantRefs. Expectations are decoded INDEPENDENTLY in the test from the seeded
// bytes, so a wrong projection cannot pass by comparing the code against itself.

const REAL = join(import.meta.dir, "fixtures", "real");
const app = (f: string) => parseAppConfig(gunzipSync(readFileSync(join(REAL, f))).toString("utf8"));
const APP_PROGRAM = 4; // OBJ.APP_PROGRAM: System B parameter segment number

// A byte-addressed mock exposing only what readState calls: tableAddr + memRead. Group-table
// pointers point at count bytes seeded to 0, so the link read returns empty and does not
// interfere with the parameter-drift assertions.
class MockReadDevice {
  mem = new Map<number, number>();
  constructor(private tableAddrs: Record<number, number>) {}
  async connect() {}
  async disconnect() {}
  async tableAddr(obj: number) {
    const a = this.tableAddrs[obj];
    if (a === undefined) throw new Error(`mock has no tableAddr for object ${obj}`);
    return a;
  }
  async memRead(addr: number, len: number) {
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0xff;
    return b;
  }
}
const asDev = (m: MockReadDevice) => m as unknown as KnxDevice;
const seedBytes = (dev: MockReadDevice, base: number, bytes: Buffer) => { for (let i = 0; i < bytes.length; i++) dev.mem.set(base + i, bytes[i]); };

describe("System 7 (MV-0705) readState: parameter drift projection", () => {
  const cfg = app("M-0081_A-FE01-11-75D9.xml.gz"); // hasModules false, hardware-proven read-back
  const liveParams = new Map<string, string>();     // manufacturer defaults
  const profile = classify(cfg);
  const model = toAppModel(cfg, { includeUnions: true, instances: [] });
  const targets = buildAbsoluteSegmentTargets(cfg, liveParams);
  const seg = targets[0]; // the segment we drift a byte in
  const segEnd = Math.max(...targets.map((t) => t.address + t.size));
  const GT = segEnd + 0x1000; // empty group-table region, clear of every parameter segment
  const tableAddrs = { 1: GT + 0x10, 2: GT + 0x20 };

  // Seed a device holding EXACTLY the project image (optionally flip one owned byte to drift).
  function seed(drift: boolean): MockReadDevice {
    const dev = new MockReadDevice(tableAddrs);
    for (const t of targets) seedBytes(dev, t.address, t.bytes);
    dev.mem.set(tableAddrs[1], 0); // address table: 0 entries
    dev.mem.set(tableAddrs[2], 0); // association table: 0 entries
    if (drift) { const flip = seg.verify.findIndex(Boolean); dev.mem.set(seg.address + flip, seg.bytes[flip] ^ 0xff); }
    return dev;
  }

  test("fixture ground truth: MV-0705 with an owned+verifiable segment", () => {
    expect(cfg.mask).toBe("MV-0705");
    expect(cfg.hasModules).toBe(false);
    expect(seg.verify.findIndex(Boolean)).toBeGreaterThanOrEqual(0);
  });

  test("a device holding the project image reports ZERO drift and empty links", async () => {
    const rb = await profile.readState(asDev(seed(false)), cfg.mask, { liveParams, moduleInstances: [] });
    expect(rb.paramsRead).toBe(true);
    expect(rb.linksRead).toBe(true);
    expect(rb.links).toEqual([]);
    expect(rb.paramBase).toEqual(liveParams); // no ref differs -> baseline == the live values
  });

  test("a single flipped owned byte is recorded as drift, with the device's decoded value", async () => {
    const drifted = seed(true);
    const rb = await profile.readState(asDev(drifted), cfg.mask, { liveParams, moduleInstances: [] });
    // Independently decode what the drifted segment SHOULD yield, and which ref changed.
    const dVals = decodeAbsoluteImage(model, seg.id, await drifted.memRead(seg.address, seg.size));
    const pVals = decodeAbsoluteImage(model, seg.id, seg.bytes);
    const changed = [...dVals].filter(([ref, v]) => pVals.get(ref) !== v);
    expect(changed.length).toBeGreaterThan(0); // the flip actually moved a decoded ref
    for (const [ref, v] of changed) expect(rb.paramBase.get(ref)).toBe(v); // readState recorded exactly that drift
  });

  test("relevantRefs gates what drift is recorded: excluded refs stay at the live baseline", async () => {
    const drifted = seed(true);
    const dVals = decodeAbsoluteImage(model, seg.id, await drifted.memRead(seg.address, seg.size));
    const pVals = decodeAbsoluteImage(model, seg.id, seg.bytes);
    const changedRef = [...dVals].find(([ref, v]) => pVals.get(ref) !== v)![0];

    // Excluding the drifted ref -> it must NOT enter the baseline.
    const excluded = await profile.readState(asDev(seed(true)), cfg.mask, { liveParams, moduleInstances: [], relevantRefs: new Set(["__none__"]) });
    expect(excluded.paramBase.has(changedRef)).toBe(false);
    expect(excluded.paramBase).toEqual(liveParams);

    // Including it -> it IS recorded.
    const included = await profile.readState(asDev(seed(true)), cfg.mask, { liveParams, moduleInstances: [], relevantRefs: new Set([changedRef]) });
    expect(included.paramBase.get(changedRef)).toBe(dVals.get(changedRef));
  });
});

describe("System B (MV-07B0) readState: parameter drift projection", () => {
  const cfg = app("M-0162_A-0004-11-F245.xml.gz"); // hasModules false: readState image == buildParameterImage(toAppModel(cfg), 4, params)
  const liveParams = new Map<string, string>();
  const profile = classify(cfg);
  const model = toAppModel(cfg);
  const seg = model.segments.find((s) => s.lsm === APP_PROGRAM)!;
  const projectImg = buildParameterImage(model, APP_PROGRAM, liveParams);
  const PARAM_BASE = 0x4000;
  const GT = PARAM_BASE + seg.size + 0x1000;
  const tableAddrs: Record<number, number> = { [APP_PROGRAM]: PARAM_BASE, 1: GT + 0x10, 2: GT + 0x20, 3: GT + 0x30 };

  function seed(drift: boolean): MockReadDevice {
    const dev = new MockReadDevice(tableAddrs);
    seedBytes(dev, PARAM_BASE, projectImg);
    // System B table counts are 2 bytes BE; zero BOTH so the tables read as 0 entries
    // (leaving the high byte at the 0xff default would decode as 255 phantom entries).
    for (const obj of [1, 2, 3]) { dev.mem.set(tableAddrs[obj], 0); dev.mem.set(tableAddrs[obj] + 1, 0); }
    // Flip a byte a parameter reads, so decode changes a ref. Find one by diffing a
    // one-byte-flipped decode against the clean decode (independent of the profile).
    if (drift) dev.mem.set(PARAM_BASE + driftByte, projectImg[driftByte] ^ 0xff);
    return dev;
  }
  // Pick a byte whose flip actually moves a decoded ref (some bytes are padding/unowned).
  const driftByte = (() => {
    for (let i = 0; i < seg.size; i++) {
      const flipped = Buffer.from(projectImg); flipped[i] ^= 0xff;
      const d = decodeParameterImage(model, APP_PROGRAM, flipped);
      const p = decodeParameterImage(model, APP_PROGRAM, projectImg);
      if ([...d].some(([ref, v]) => p.get(ref) !== v)) return i;
    }
    return -1;
  })();

  test("fixture ground truth: System B relative device with a decodable parameter byte", () => {
    expect(cfg.mask).toBe("MV-07B0");
    expect(cfg.hasModules).toBe(false);
    expect(profile.capabilities().readParams).toBe(true);
    expect(driftByte).toBeGreaterThanOrEqual(0);
    expect(projectImg.length).toBe(seg.size);
  });

  test("a device holding the project image reports ZERO drift and empty links", async () => {
    const rb = await profile.readState(asDev(seed(false)), cfg.mask, { liveParams, moduleInstances: [] });
    expect(rb.paramsRead).toBe(true);
    expect(rb.linksRead).toBe(true);
    expect(rb.links).toEqual([]);
    expect(rb.paramBase).toEqual(liveParams);
  });

  test("a single flipped parameter byte is recorded as drift, with the device's decoded value", async () => {
    const drifted = seed(true);
    const rb = await profile.readState(asDev(drifted), cfg.mask, { liveParams, moduleInstances: [] });
    const dVals = decodeParameterImage(model, APP_PROGRAM, await drifted.memRead(PARAM_BASE, seg.size));
    const pVals = decodeParameterImage(model, APP_PROGRAM, projectImg);
    const changed = [...dVals].filter(([ref, v]) => pVals.get(ref) !== v);
    expect(changed.length).toBeGreaterThan(0);
    for (const [ref, v] of changed) expect(rb.paramBase.get(ref)).toBe(v);
  });
});
