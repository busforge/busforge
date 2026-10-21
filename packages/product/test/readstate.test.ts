import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import type { KnxDevice } from "@busforge/knx";
import {
  parseAppConfig, classify, toAppModel, buildDeviceConfig,
  buildAbsoluteSegmentTargets, decodeAbsoluteImage,
  buildParameterImage, buildRelativeSegmentTarget, decodeParameterImage,
} from "@busforge/product";
import { catalogueXml, corpusPath, inServiceCollection } from "../../../tools/corpus.ts";
import { CollectedUnit, asDevice, type Collection } from "./collected-unit.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// Direct coverage of DeviceProfile.readState, the seam where a device read becomes the
// programmed baseline + drift. The route tests stub readDeviceState out (readback-route.test.ts),
// so this is the ONLY test that exercises the projection itself: read segment bytes off a mock
// device, decode them, and record ONLY the refs that (a) differ from the project image and
// (b) are relevant under the project's or the device's configuration (configFor). Expectations are decoded INDEPENDENTLY in the test from the seeded
// bytes, so a wrong projection cannot pass by comparing the code against itself.

const app = (f: string) => parseAppConfig(catalogueXml(f));
const APP_PROGRAM = 4; // OBJ.APP_PROGRAM: System B parameter segment number

// A byte-addressed mock exposing only what readState calls: tableAddr + memRead, and the association
// table's description (the long form, PDT_GENERIC_04). Group-table pointers point at count bytes seeded
// to 0, so the link read returns empty and does not interfere with the parameter-drift assertions.
class MockReadDevice {
  async propertyDescription(obj: number, pid: number) { return { objectIndex: obj, pid, propertyIndex: 0, writable: true, pdt: 0x14, maxElements: 1, readLevel: 3, writeLevel: 3 }; }
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

corpusDescribe("System 7 (MV-0705) readState: parameter drift projection", () => {
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

  test("relevance gates what drift is recorded: excluded refs stay at the live baseline", async () => {
    const drifted = seed(true);
    const dVals = decodeAbsoluteImage(model, seg.id, await drifted.memRead(seg.address, seg.size));
    const pVals = decodeAbsoluteImage(model, seg.id, seg.bytes);
    const changedRef = [...dVals].find(([ref, v]) => pVals.get(ref) !== v)![0];

    // Excluding the drifted ref -> it must NOT enter the baseline.
    const excluded = await profile.readState(asDev(seed(true)), cfg.mask, { liveParams, moduleInstances: [], configFor: () => ({ shown: new Set(["__none__"]), active: new Set(["__none__"]), values: new Map() }) });
    expect(excluded.paramBase.has(changedRef)).toBe(false);
    expect(excluded.paramBase).toEqual(liveParams);

    // Including it -> it IS recorded.
    const included = await profile.readState(asDev(seed(true)), cfg.mask, { liveParams, moduleInstances: [], configFor: () => ({ shown: new Set([changedRef]), active: new Set([changedRef]), values: new Map() }) });
    expect(included.paramBase.get(changedRef)).toBe(dVals.get(changedRef));
  });
});

// The Theben Meteodata 140 S as its unit in service holds it, read into a project at the application's
// defaults (with its two channel functions without memory set as the unit runs them): the project taken
// over from that read writes the unit's own bytes, but for the download marker the unit clears after every
// download, and a second read finds nothing new.
corpusDescribe("System 7 readState: a Meteodata 140 S in service is taken over in one read", () => {
  const cfg = app("M-0048_A-140C-14-EB70.xml.gz");
  const MARKER = "M-0048_A-140C-14-EB70_P-2228_R-2228"; // "Downloaderkennung", Access None
  const configFor = (values: Map<string, string>) => {
    const view = buildDeviceConfig(cfg, values, undefined, []);
    const shown = new Set<string>();
    for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") shown.add(it.param.refId);
    return { shown, active: new Set(view.imageValues.keys()), values: view.imageValues };
  };
  const memoryless = new Map([["M-0048_A-140C-14-EB70_P-7060_R-7060", "3"], ["M-0048_A-140C-14-EB70_P-7152_R-7152", "4"]]);

  test("the project the read sets writes the unit's bytes, and reading again changes nothing", async () => {
    const unit = new CollectedUnit(JSON.parse(readFileSync(corpusPath(inServiceCollection("theben-meteodata-140s-in-service")), "utf8")) as Collection);
    const read = (live: Map<string, string>) => classify(cfg).readState(asDevice(unit), unit.mask, { liveParams: live, baseParams: live, moduleInstances: [], configFor });
    const taken = (await read(memoryless)).paramBase;
    const model = toAppModel(cfg, { includeUnions: true, instances: [] });
    const differing: string[] = [];
    for (const t of buildAbsoluteSegmentTargets(cfg, taken)) for (let i = 0; i < t.size; i++) {
      const have = unit.mem.get(t.address + i)!;
      if (((have & ~t.owned[i]) | (t.bytes[i] & t.owned[i])) === have) continue;
      const owners = [...model.refs.values()].filter((r) => {
        const p = model.params.get(r.paramId)!;
        const type = model.types.get(p.typeId);
        return p.codeSegment === t.id && p.offset !== undefined && type !== undefined && i >= p.offset && i < p.offset + Math.ceil((p.bitOffset + type.sizeInBit) / 8);
      }).map((r) => r.id);
      differing.push(...(owners.length ? owners : [`${t.id} +${i}`]));
    }
    expect(differing).toEqual([MARKER]);
    expect((await read(taken)).paramBase).toEqual(taken);
  });
});

// A System 7 image holds a parameter's value only where the configuration activates it; a hidden one keeps
// its segment's <Data> byte. So where only the DEVICE's configuration activates a parameter, the read
// compares the device's value with the value the project resolves it to there, not with the project's
// image (which holds <Data>): a byte equal to <Data> is no proof of the project's value. Minimal app: `sel`
// (visible) shows `x`, `f` and `m` when 1, `m` shows `y` when 1; x's default 7, its <Data> byte 3; f a
// DPT 9 float, default "21.0", its <Data> bytes 0; y's default 2, its <Data> byte 9.
const hiddenXml = `<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20"><ManufacturerData><Manufacturer RefId="M-0002"><ApplicationPrograms>
<ApplicationProgram Id="M-0002_A-0051-01-0001" ApplicationNumber="81" ApplicationVersion="1" MaskVersion="MV-0705" DefaultLanguage="en-US" Name="Hidden Test">
<Static>
<ParameterTypes>
<ParameterType Id="M-0002_A-0051-01-0001_PT-8"><TypeNumber SizeInBit="8" Type="unsignedInt" minInclusive="0" maxInclusive="255"/></ParameterType>
<ParameterType Id="M-0002_A-0051-01-0001_PT-F"><TypeFloat SizeInBit="16"/></ParameterType>
<ParameterType Id="M-0002_A-0051-01-0001_PT-sel"><TypeRestriction Base="Value" SizeInBit="8"><Enumeration Text="off" Value="0" Id="M-0002_A-0051-01-0001_PT-sel_EN-0"/><Enumeration Text="on" Value="1" Id="M-0002_A-0051-01-0001_PT-sel_EN-1"/></TypeRestriction></ParameterType>
</ParameterTypes>
<Parameters>
<Parameter Id="M-0002_A-0051-01-0001_P-1" ParameterType="M-0002_A-0051-01-0001_PT-sel" Text="sel" Value="0"><Memory CodeSegment="M-0002_A-0051-01-0001_AS-1" Offset="0" BitOffset="0"/></Parameter>
<Parameter Id="M-0002_A-0051-01-0001_P-2" ParameterType="M-0002_A-0051-01-0001_PT-8" Text="x" Value="7"><Memory CodeSegment="M-0002_A-0051-01-0001_AS-1" Offset="1" BitOffset="0"/></Parameter>
<Parameter Id="M-0002_A-0051-01-0001_P-3" ParameterType="M-0002_A-0051-01-0001_PT-F" Text="f" Value="21.0"><Memory CodeSegment="M-0002_A-0051-01-0001_AS-1" Offset="2" BitOffset="0"/></Parameter>
<Parameter Id="M-0002_A-0051-01-0001_P-4" ParameterType="M-0002_A-0051-01-0001_PT-sel" Text="m" Value="0"><Memory CodeSegment="M-0002_A-0051-01-0001_AS-1" Offset="4" BitOffset="0"/></Parameter>
<Parameter Id="M-0002_A-0051-01-0001_P-5" ParameterType="M-0002_A-0051-01-0001_PT-8" Text="y" Value="2"><Memory CodeSegment="M-0002_A-0051-01-0001_AS-1" Offset="5" BitOffset="0"/></Parameter>
</Parameters>
<ParameterRefs>
<ParameterRef Id="M-0002_A-0051-01-0001_P-1_R-1" RefId="M-0002_A-0051-01-0001_P-1"/>
<ParameterRef Id="M-0002_A-0051-01-0001_P-2_R-2" RefId="M-0002_A-0051-01-0001_P-2"/>
<ParameterRef Id="M-0002_A-0051-01-0001_P-3_R-3" RefId="M-0002_A-0051-01-0001_P-3"/>
<ParameterRef Id="M-0002_A-0051-01-0001_P-4_R-4" RefId="M-0002_A-0051-01-0001_P-4"/>
<ParameterRef Id="M-0002_A-0051-01-0001_P-5_R-5" RefId="M-0002_A-0051-01-0001_P-5"/></ParameterRefs>
<Code><AbsoluteSegment Id="M-0002_A-0051-01-0001_AS-1" Address="256" Size="6"><Data>AAMAAAAJ</Data></AbsoluteSegment></Code>
</Static>
<Dynamic><ParameterBlock Id="M-0002_A-0051-01-0001_PB-1" Name="Main" Text="Main">
<ParameterRefRef RefId="M-0002_A-0051-01-0001_P-1_R-1"/>
<choose ParamRefId="M-0002_A-0051-01-0001_P-1_R-1"><when test="1"><ParameterRefRef RefId="M-0002_A-0051-01-0001_P-2_R-2"/><ParameterRefRef RefId="M-0002_A-0051-01-0001_P-3_R-3"/><ParameterRefRef RefId="M-0002_A-0051-01-0001_P-4_R-4"/>
<choose ParamRefId="M-0002_A-0051-01-0001_P-4_R-4"><when test="1"><ParameterRefRef RefId="M-0002_A-0051-01-0001_P-5_R-5"/></when></choose></when></choose>
</ParameterBlock></Dynamic>
</ApplicationProgram></ApplicationPrograms></Manufacturer></ManufacturerData></KNX>`;

test("System 7 readState: a parameter's bytes count only where the device's configuration activates it", async () => {
  const cfg = parseAppConfig(hiddenXml);
  const SEL = "M-0002_A-0051-01-0001_P-1_R-1", X = "M-0002_A-0051-01-0001_P-2_R-2", F = "M-0002_A-0051-01-0001_P-3_R-3", M = "M-0002_A-0051-01-0001_P-4_R-4";
  const configFor = (values: Map<string, string>) => {
    const view = buildDeviceConfig(cfg, values, undefined, []);
    const shown = new Set<string>();
    for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") shown.add(it.param.refId);
    return { shown, active: new Set(view.imageValues.keys()), values: view.imageValues };
  };
  const tableAddrs = { 1: 0x1000, 2: 0x1010 };
  const unit = (bytes: number[]) => {
    const dev = new MockReadDevice(tableAddrs);
    seedBytes(dev, 256, Buffer.from(bytes.length === 4 ? [...bytes, 0, 9] : bytes));
    dev.mem.set(tableAddrs[1], 0);
    dev.mem.set(tableAddrs[2], 0);
    return dev;
  };
  const image = (values: Map<string, string>) => [...buildAbsoluteSegmentTargets(cfg, values)[0].bytes];
  const read = (dev: MockReadDevice, liveParams: Map<string, string>, baseParams = liveParams) =>
    classify(cfg).readState(asDev(dev), cfg.mask, { liveParams, baseParams, moduleInstances: [], configFor });

  // The device shows x at 3, its <Data> byte, and f at its default 21 (0x0C1A); the project, at defaults,
  // hides both. f is compared in the form the image gives it ("21.0" holds as "21"), so it stays unset.
  expect(image(new Map())).toEqual([0, 3, 0, 0, 0, 9]);
  const shows = unit([1, 3, 0x0c, 0x1a]);
  const first = await read(shows, new Map());
  expect(first.paramBase).toEqual(new Map([[SEL, "1"], [X, "3"]]));
  // Taken over (the project set to what the read found), the project writes the device's bytes, and a
  // second read finds nothing new.
  expect(image(first.paramBase)).toEqual([1, 3, 0x0c, 0x1a, 0, 9]);
  expect((await read(shows, first.paramBase)).paramBase).toEqual(first.paramBase);
  // Where the device holds what the project resolves x to under the device's configuration (its default
  // 7), x is in sync and stays unset; a project value set for it is compared, not its default.
  expect((await read(unit([1, 7, 0x0c, 0x1a]), new Map())).paramBase).toEqual(new Map([[SEL, "1"]]));
  expect((await read(unit([1, 7, 0x0c, 0x1a]), new Map([[X, "5"]]))).paramBase).toEqual(new Map([[SEL, "1"], [X, "7"]]));
  expect((await read(unit([1, 5, 0x0c, 0x1a]), new Map([[X, "5"]]))).paramBase).toEqual(new Map([[SEL, "1"], [X, "5"]]));
  expect((await read(unit([1, 7, 0, 0]), new Map())).paramBase).toEqual(new Map([[SEL, "1"], [F, "0"]]));

  // m and y show only on the device, y only while m is 1: set back to the project's m, y would be hidden,
  // so y is resolved on its own, finds its default 2, and stays unset.
  expect((await read(unit([1, 3, 0x0c, 0x1a, 1, 2]), new Map())).paramBase).toEqual(new Map([[SEL, "1"], [X, "3"], [M, "1"]]));

  // Where the project shows x and f and the device hides them, they are compared with the project's image:
  // the device's <Data> bytes against the project's 9 and 21 record 3 and 0, so the hidden settings show as
  // changes.
  const live = new Map([[SEL, "1"], [X, "9"]]);
  expect((await read(unit([0, 3, 0, 0]), live)).paramBase).toEqual(new Map([[SEL, "0"], [X, "3"], [F, "0"]]));
});

corpusDescribe("System B (MV-07B0) readState: parameter drift projection", () => {
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

corpusDescribe("read-back does not launder an unobservable parameter into the programmed baseline", () => {
  // The Theben 493B's channel-active parameter (P-57) has NO memory offset: it lives only in
  // the project, and the device cannot be asked about it. If an unflashed edit to it were
  // adopted into the "programmed" baseline just because the device cannot contradict it, the
  // UI would report the change as programmed and the com-object staleness gate (which trusts
  // the baseline) would be defeated. The read must leave such a ref's baseline alone.
  const cfg = app("M-0048_A-493B-21-B471.xml.gz");
  const profile = classify(cfg);
  const CHANNEL_ACTIVE = "M-0048_A-493B-21-B471_P-57_R-57";
  const PARAM_BASE = 0x4000;

  test("ground truth: the parameter is not in the memory image", () => {
    expect(cfg.params.get(cfg.refs.get(CHANNEL_ACTIVE)!.paramId)!.offset).toBeUndefined();
  });

  test("a baseline entry the device demonstrably does NOT hold is dropped, not kept", async () => {
    // The mirror case: the baseline claims a value, the user reverted it (so it is absent from
    // the live params), and the device is read and proves it holds the application default. The
    // baseline entry must go, or the UI shows a permanent phantom "changed" chip and the
    // com-object gate compares against a configuration the device does not have. The baseline is
    // sparse, so "absent" IS the statement "the device holds the default".
    const cfg2 = app("M-0162_A-0004-11-F245.xml.gz"); // no modules, no unions: a clean baseline case
    const prof2 = classify(cfg2);
    const ref = "M-0162_A-0004-11-F245_P-30_R-30";
    const onDevice = buildRelativeSegmentTarget(cfg2, new Map(), APP_PROGRAM)!; // the DEFAULT image
    const BASE = 0x4000;
    const G = BASE + onDevice.size + 0x1000;
    const dev = new MockReadDevice({ [APP_PROGRAM]: BASE, 1: G + 0x10, 2: G + 0x20, 3: G + 0x30 });
    seedBytes(dev, BASE, onDevice.bytes);
    for (const obj of [1, 2, 3]) { dev.mem.set(G + 0x10 * obj, 0); dev.mem.set(G + 0x10 * obj + 1, 0); }

    const rb = await prof2.readState(asDev(dev), cfg2.mask, {
      liveParams: new Map(),                 // user reverted the edit
      baseParams: new Map([[ref, "1"]]),     // baseline still claims it was programmed
      moduleInstances: [], configFor: () => ({ shown: new Set([ref]), active: new Set([ref]), values: new Map() }),
    });
    expect(rb.paramsRead).toBe(true);
    expect(rb.paramBase.has(ref)).toBe(false); // the device proved the default: the claim is gone
  });

  test("an unflashed edit to it stays drift after a read-back", async () => {
    const live = new Map([[CHANNEL_ACTIVE, "1"]]); // user enabled a channel, never flashed
    const base = new Map<string, string>();        // device was programmed with the default
    const onDevice = buildRelativeSegmentTarget(cfg, base, APP_PROGRAM, { moduleInstances: [] })!;
    const GT = PARAM_BASE + onDevice.size + 0x1000;
    const dev = new MockReadDevice({ [APP_PROGRAM]: PARAM_BASE, 1: GT + 0x10, 2: GT + 0x20, 3: GT + 0x30 });
    seedBytes(dev, PARAM_BASE, onDevice.bytes);
    for (const obj of [1, 2, 3]) { dev.mem.set(GT + 0x10 * (obj === 1 ? 1 : obj === 2 ? 2 : 3), 0); }

    const rb = await profile.readState(asDev(dev), cfg.mask, { liveParams: live, baseParams: base, moduleInstances: [] });
    expect(rb.paramsRead).toBe(true);
    // NOT adopted: the baseline still says "default", so the UI keeps showing the change as
    // unprogrammed and the flash gate still sees a com-object table change.
    expect(rb.paramBase.get(CHANNEL_ACTIVE)).toBeUndefined();
  });
});

corpusDescribe("System B readState covers TOP-LEVEL UNION parameters", () => {
  // The Theben DALI gateway places 178 top-level union parameters,
  // 16 of which the config view exposes for editing and the surgical flash target OWNS (it
  // writes those bytes). Read-back must therefore see them: a model that drops union params
  // decodes nothing at those offsets, so the device could hold anything and read-back would
  // still report "no drift" on bytes we actively flash. That is the exact fake-green this
  // suite exists to prevent, so the union byte is drifted here on a REAL application.
  const cfg = app("M-0048_A-9071-20-F258-O00EF.xml.gz");
  const liveParams = new Map<string, string>();
  const profile = classify(cfg);
  const model = toAppModel(cfg, { includeUnions: true, instances: [] });
  const target = buildRelativeSegmentTarget(cfg, liveParams, APP_PROGRAM)!;
  const view = buildDeviceConfig(cfg, liveParams, undefined, []);
  const uiRefs = new Set<string>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") uiRefs.add(it.param.refId);

  const PARAM_BASE = 0x4000;
  const GT = PARAM_BASE + target.size + 0x1000;
  const tableAddrs: Record<number, number> = { [APP_PROGRAM]: PARAM_BASE, 1: GT + 0x10, 2: GT + 0x20, 3: GT + 0x30 };

  // A byte that ONLY a union parameter covers: the union-free model decodes no ref from it,
  // so drifting it is invisible unless read-back models unions. It is owned + verifiable, i.e.
  // a byte the flash writes and checks.
  const unionOnlyByte = (() => {
    const bytesOf = (m: ReturnType<typeof toAppModel>) => {
      const cover = new Set<number>();
      for (const r of m.refs.values()) {
        const p = m.params.get(r.paramId);
        const t = p && m.types.get(p.typeId);
        if (!p || p.offset === undefined || !t || !Number.isFinite(t.sizeInBit) || t.sizeInBit === 0) continue;
        for (let i = 0; i < Math.ceil(t.sizeInBit / 8); i++) cover.add(p.offset + i);
      }
      return cover;
    };
    const plain = bytesOf(toAppModel(cfg, { instances: [] })); // the model read-back used to use
    for (let i = 0; i < target.size; i++) if (target.owned[i] && target.verify[i] && !plain.has(i)) {
      const flipped = Buffer.from(target.bytes); flipped[i] ^= 0xff;
      const d = decodeParameterImage(model, APP_PROGRAM, flipped);
      const p = decodeParameterImage(model, APP_PROGRAM, target.bytes);
      const moved = [...d].filter(([ref, v]) => p.get(ref) !== v).map(([ref]) => ref);
      if (moved.some((ref) => uiRefs.has(ref))) return i;
    }
    return -1;
  })();

  const seed = () => {
    const dev = new MockReadDevice(tableAddrs);
    seedBytes(dev, PARAM_BASE, target.bytes);
    for (const obj of [1, 2, 3]) { dev.mem.set(tableAddrs[obj], 0); dev.mem.set(tableAddrs[obj] + 1, 0); }
    dev.mem.set(PARAM_BASE + unionOnlyByte, target.bytes[unionOnlyByte] ^ 0xff);
    return dev;
  };

  test("fixture ground truth: a real System B device flashes bytes only union params explain", () => {
    expect(cfg.mask).toBe("MV-07B0");
    expect(unionOnlyByte).toBeGreaterThanOrEqual(0);
  });

  test("drift in a union-only byte is reported (not silently invisible)", async () => {
    const drifted = seed();
    const rb = await profile.readState(asDev(drifted), cfg.mask, { liveParams, moduleInstances: [], configFor: () => ({ shown: uiRefs, active: uiRefs, values: new Map() }) });
    // Decode the expectation independently of the profile, from the seeded bytes.
    const dVals = decodeParameterImage(model, APP_PROGRAM, await drifted.memRead(PARAM_BASE, target.size));
    const pVals = decodeParameterImage(model, APP_PROGRAM, target.bytes);
    const changed = [...dVals].filter(([ref, v]) => pVals.get(ref) !== v && uiRefs.has(ref));
    expect(changed.length).toBeGreaterThan(0);
    for (const [ref, v] of changed) expect(rb.paramBase.get(ref)).toBe(v);
  });

  test("a device holding the flashed image reports ZERO drift", async () => {
    const clean = new MockReadDevice(tableAddrs);
    seedBytes(clean, PARAM_BASE, target.bytes);
    for (const obj of [1, 2, 3]) { clean.mem.set(tableAddrs[obj], 0); clean.mem.set(tableAddrs[obj] + 1, 0); }
    const rb = await profile.readState(asDev(clean), cfg.mask, { liveParams, moduleInstances: [], configFor: () => ({ shown: uiRefs, active: uiRefs, values: new Map() }) });
    expect(rb.paramBase).toEqual(liveParams);
  });
});

// Relevance comes from the DEVICE's configuration, not the project's. A setting that only the
// device's value of another parameter makes visible (a sensor type the project leaves at "none")
// must still enter the baseline, or a later flash of the project resets it without anyone seeing
// the difference (seen on an OpenKNX RaumController).
corpusDescribe("readState records settings that only the device's configuration makes visible", () => {
  const cfg = app("M-0048_A-9071-20-F258-O00EF.xml.gz");
  const profile = classify(cfg);
  const model = toAppModel(cfg, { includeUnions: true, instances: [] });
  const viewRefs = (values: Map<string, string>) => {
    const refs = new Set<string>();
    for (const b of buildDeviceConfig(cfg, values, undefined, []).blocks) for (const it of b.items) if (it.kind === "param") refs.add(it.param.refId);
    return refs;
  };
  const configFor = (values: Map<string, string>) => { const v = buildDeviceConfig(cfg, values, undefined, []).imageValues; return { shown: viewRefs(values), active: new Set(v.keys()), values: v }; };
  const decodable = (ref: string) => decodeParameterImage(model, APP_PROGRAM, buildRelativeSegmentTarget(cfg, new Map(), APP_PROGRAM)!.bytes).has(ref);

  // A visible enum R whose other value reveals an enum S the defaults hide, S image-placeable.
  const found = (() => {
    const base = viewRefs(new Map());
    for (const b of buildDeviceConfig(cfg, new Map(), undefined, []).blocks) for (const it of b.items) {
      if (it.kind !== "param" || it.param.control !== "enum" || !decodable(it.param.refId)) continue;
      for (const o of it.param.options ?? []) {
        if (String(o.value) === it.param.value) continue;
        const withR = new Map([[it.param.refId, String(o.value)]]);
        const size = buildRelativeSegmentTarget(cfg, withR, APP_PROGRAM)?.size;
        for (const b2 of buildDeviceConfig(cfg, withR, undefined, []).blocks) for (const s of b2.items) {
          if (s.kind !== "param" || base.has(s.param.refId) || s.param.control !== "enum" || !decodable(s.param.refId)) continue;
          const w = (s.param.options ?? []).map((x) => String(x.value)).find((v) => v !== s.param.value);
          if (w === undefined) continue;
          const dv = new Map([...withR, [s.param.refId, w]]);
          if (buildRelativeSegmentTarget(cfg, dv, APP_PROGRAM)?.size !== size) continue;
          return { r: it.param.refId, rv: String(o.value), s: s.param.refId, w, device: dv };
        }
      }
    }
    return null;
  })();

  test("the device's revealed setting is recorded, not left at the project's default", async () => {
    expect(found).not.toBeNull();
    const { r, rv, s, w, device } = found!;
    const project = buildRelativeSegmentTarget(cfg, new Map(), APP_PROGRAM)!;
    const onDevice = buildRelativeSegmentTarget(cfg, device, APP_PROGRAM)!;
    expect(onDevice.size).toBe(project.size);
    const PARAM_BASE = 0x4000, GT = PARAM_BASE + project.size + 0x1000;
    const tableAddrs: Record<number, number> = { [APP_PROGRAM]: PARAM_BASE, 1: GT + 0x10, 2: GT + 0x20, 3: GT + 0x30 };
    const dev = new MockReadDevice(tableAddrs);
    seedBytes(dev, PARAM_BASE, onDevice.bytes);
    for (const obj of [1, 2, 3]) { dev.mem.set(tableAddrs[obj], 0); dev.mem.set(tableAddrs[obj] + 1, 0); }

    const rb = await profile.readState(asDev(dev), cfg.mask, { liveParams: new Map(), moduleInstances: [], configFor });
    expect(rb.paramBase.get(r)).toBe(rv);
    expect(rb.paramBase.get(s)).toBe(w);
  });
});

// A text value the codec refuses (a character beyond ASCII: no ETS capture shows its bytes) leaves its field unowned
// in the read-back's build. A project value there must not fold as "in sync" just because the device and the image
// both still hold the segment's <Data>: the field keeps the baseline it had.
corpusDescribe("System B readState: a text field the codec refuses is compared neither way", () => {
  const cfg = app("M-0083_A-0137-20-7EB2.xml.gz");
  const REF = "M-0083_A-0137-20-7EB2_P-162_R-162"; // device name, 30-byte text, <Data> "MDT KNX IP-Interface"
  const liveParams = new Map([[REF, "Küche"]]);
  const target = buildRelativeSegmentTarget(cfg, liveParams, APP_PROGRAM, { textRefusals: "skip" })!;
  const PARAM_BASE = 0x4000;
  const GT = PARAM_BASE + target.size + 0x1000;
  const tableAddrs: Record<number, number> = { [APP_PROGRAM]: PARAM_BASE, 1: GT + 0x10, 2: GT + 0x20, 3: GT + 0x30 };

  test("the device holding <Data> there leaves the field unverified, not in sync", async () => {
    const dev = new MockReadDevice(tableAddrs);
    seedBytes(dev, PARAM_BASE, target.bytes);
    for (const obj of [1, 2, 3]) { dev.mem.set(tableAddrs[obj], 0); dev.mem.set(tableAddrs[obj] + 1, 0); }
    const offset = cfg.params.get(cfg.refs.get(REF)!.paramId)!.offset!;
    expect(Buffer.from(target.bytes.subarray(offset, offset + 20)).toString("latin1")).toBe("MDT KNX IP-Interface");
    const all = new Set(cfg.refs.keys());
    const rb = await classify(cfg).readState(asDev(dev), cfg.mask, { liveParams, baseParams: new Map(), moduleInstances: [], configFor: () => ({ shown: all, active: all, values: new Map() }) });
    expect(rb.paramBase.has(REF)).toBe(false);
  });
});

// An inactive parameter is written at its default, not at the value the project still stores for it (the MDT IP
// Interface/Router's full download, tools/etsdiff.test.ts). A device holding that default is therefore not "in sync"
// with the stored value: the read records the device's value as the baseline, so the stored value stays a change.
corpusDescribe("System B readState: an inactive parameter with a stored value keeps the device's value as its baseline", () => {
  const cfg = app("M-0083_A-0137-20-7EB2.xml.gz");
  const REF = "M-0083_A-0137-20-7EB2_P-315_R-315"; // e-mail text, inactive at defaults, default "Bit Alarm 1"
  const liveParams = new Map([[REF, "Wetterstation"]]);
  const target = buildRelativeSegmentTarget(cfg, liveParams, APP_PROGRAM, { textRefusals: "skip" })!;
  const PARAM_BASE = 0x4000;
  const GT = PARAM_BASE + target.size + 0x1000;
  const tableAddrs: Record<number, number> = { [APP_PROGRAM]: PARAM_BASE, 1: GT + 0x10, 2: GT + 0x20, 3: GT + 0x30 };

  test("the device holding the default records the default, not the stored value", async () => {
    expect(target.defaulted.has(REF)).toBe(true);
    const dev = new MockReadDevice(tableAddrs);
    seedBytes(dev, PARAM_BASE, target.bytes);
    for (const obj of [1, 2, 3]) { dev.mem.set(tableAddrs[obj], 0); dev.mem.set(tableAddrs[obj] + 1, 0); }
    const all = new Set(cfg.refs.keys());
    const rb = await classify(cfg).readState(asDev(dev), cfg.mask, { liveParams, baseParams: new Map(), moduleInstances: [], configFor: () => ({ shown: all, active: all, values: new Map() }) });
    expect(rb.paramBase.get(REF)).toBe("Bit Alarm 1");
  });
});
