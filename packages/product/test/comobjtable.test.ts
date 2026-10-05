import { test, expect } from "bun:test";
import type { KnxDevice } from "@busforge/knx";
import {
  parseAppConfig, classify, ProductError,
  comObjectTable, diffComObjectTables,
  buildRelativeSegmentTarget, buildAbsoluteSegmentTargets, buildDeviceConfig, resolveModuleInstances,
} from "@busforge/product";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The com-object table (L3) staleness gate. Busforge writes parameters (L4) and the group
// tables (L1/L2) but keeps the device's com-object table. A parameter that changes which
// com-objects exist (or their flags/size) therefore invalidates that table, and flashing it
// anyway would leave the device behaving unlike what the UI shows while reporting success.
// This suite pins the refusal on REAL application programs, across both memory models.

const app = (f: string) => parseAppConfig(catalogueXml(f));
const LSM = 4;

// A device stub that throws on any bus call it was not given. Writes are never stubbed, so a
// gate that failed to refuse shows up as a loud "unexpected bus call", not a silent pass.
const dev = (overrides: Record<string, unknown>) =>
  new Proxy({}, {
    get: (_t, prop) => (prop in overrides ? (overrides as any)[prop] : () => { throw new Error(`unexpected bus call: ${String(prop)}`); }),
  }) as unknown as KnxDevice;

// The device was last programmed with `base`; we are about to flash `params`.
const ctxFor = (appXml: string, params: Map<string, string>, base = new Map<string, string>()) => ({
  deviceId: "d", appXml, params, baseParams: base, dryRun: false,
  // Reached only AFTER the gate passes: the sentinel proves a flash was allowed to proceed.
  persistBackups: () => { throw new Error("BACKUP-PERSISTED"); },
});

corpusDescribe("diffComObjectTables", () => {
  const cfg = app("M-0162_A-0004-11-F245.xml.gz");
  const base = comObjectTable(cfg, new Map());

  test("identical parameter sets imply an identical table (the gate never fires on a no-op)", () => {
    expect(diffComObjectTables(base, comObjectTable(cfg, new Map()))).toEqual([]);
    expect(base.size).toBeGreaterThan(0); // never pass vacuously
  });

  test("a parameter that activates a com-object is reported as added", () => {
    const changes = diffComObjectTables(base, comObjectTable(cfg, new Map([["M-0162_A-0004-11-F245_P-30_R-30", "1"]])));
    expect(changes.length).toBe(1);
    expect(changes[0].fields).toEqual(["added"]);
    expect(changes[0].now).toBeDefined();
    expect(changes[0].was).toBeUndefined();
    // and the inverse direction reports it as removed
    const back = diffComObjectTables(comObjectTable(cfg, new Map([["M-0162_A-0004-11-F245_P-30_R-30", "1"]])), base);
    expect(back.map((c) => c.fields)).toEqual([["removed"]]);
  });

  test("a differing flag on the same object number is reported with the flag named", () => {
    const one = new Map(base);
    const [num, obj] = [...base][0];
    one.set(num, { ...obj, flags: { ...obj.flags, transmit: !obj.flags.transmit } });
    expect(diffComObjectTables(base, one)).toEqual([expect.objectContaining({ number: num, fields: ["flag:transmit"] })]);
  });

  test("the channel-active parameter that drives this gate has NO memory offset (why the baseline, not the device image, is the comparison point)", () => {
    // The detector cannot ask the device what it is configured as: the Theben 493B's
    // channel-active parameter is not in its memory image at all, so a device-image detector
    // would be blind to the very change that changes the object set. See comobjtable.ts.
    const theben = app("M-0048_A-493B-21-B471.xml.gz");
    const p = theben.params.get(theben.refs.get("M-0048_A-493B-21-B471_P-57_R-57")!.paramId)!;
    expect(p.offset).toBeUndefined();
    expect(diffComObjectTables(comObjectTable(theben, new Map()), comObjectTable(theben, new Map([["M-0048_A-493B-21-B471_P-57_R-57", "1"]]))).length).toBeGreaterThan(0);
  });
});

corpusDescribe("System B flash refuses when the com-object table would go stale", () => {
  const xml = catalogueXml("M-0048_A-493B-21-B471.xml.gz");
  const cfg = parseAppConfig(xml);
  const profile = classify(cfg);
  const CHANNEL_ACTIVE = "M-0048_A-493B-21-B471_P-57_R-57"; // the Theben channel-active parameter
  const PARAM_BASE = 0x4000;

  // The device holds the image of its CURRENT (default) configuration.
  const onDevice = buildRelativeSegmentTarget(cfg, new Map(), LSM)!.bytes;
  const busDev = dev({
    propRead: async () => Buffer.alloc(16),
    tableAddr: async () => PARAM_BASE,
    memRead: async (_a: number, len: number) => onDevice.subarray(0, len),
  });

  test("ground truth: activating the channel really does change the object set", () => {
    const before = comObjectTable(cfg, new Map());
    const after = comObjectTable(cfg, new Map([[CHANNEL_ACTIVE, "1"]]));
    expect(diffComObjectTables(before, after).length).toBeGreaterThan(0);
  });

  test("enabling a channel refuses with COM_OBJECT_TABLE_STALE and writes nothing", async () => {
    const err = await profile.flashParameters(busDev, "07B0", ctxFor(xml, new Map([[CHANNEL_ACTIVE, "1"]]))).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as ProductError).code).toBe("COM_OBJECT_TABLE_STALE");
    expect((err as ProductError).message).toContain("communication objects");
  });

  test("a device already holding the project's configuration passes the gate (identity flash still works)", async () => {
    const err = await profile.flashParameters(busDev, "07B0", ctxFor(xml, new Map())).then(() => null, (e) => e);
    expect((err as Error).message).toBe("BACKUP-PERSISTED"); // gate passed, flash proceeded
  });

  test("a parameter change that leaves the object set alone still flashes", async () => {
    // Pick a real UI parameter whose value change does not move the com-object table.
    const view = buildDeviceConfig(cfg, new Map(), undefined, resolveModuleInstances(cfg, new Map()));
    const base = comObjectTable(cfg, new Map());
    let neutral: Map<string, string> | null = null;
    for (const b of view.blocks) for (const it of b.items) {
      if (neutral || it.kind !== "param" || !it.param.options?.length) continue;
      for (const o of it.param.options) {
        const cand = new Map([[it.param.refId, String(o.value)]]);
        if (String(o.value) !== String(it.param.value) && diffComObjectTables(base, comObjectTable(cfg, cand)).length === 0) { neutral = cand; break; }
      }
    }
    expect(neutral).not.toBeNull();
    const err = await profile.flashParameters(busDev, "07B0", ctxFor(xml, neutral!)).then(() => null, (e) => e);
    expect((err as Error).message).toBe("BACKUP-PERSISTED");
  });
});

corpusDescribe("the GROUP-ADDRESS flash is gated too (the parameter flash alone is not enough)", () => {
  // Without this, the exact configuration the parameter flash refuses could still be pushed as a
  // GA flash: the association table numbers its com-objects from the LIVE config, so it would
  // point group addresses at objects the device's kept-from-device com-object table never
  // configured (a link to nothing), and the verify, which only re-reads the tables it just wrote,
  // would still report verified: true.
  const xml = catalogueXml("M-0048_A-493B-21-B471.xml.gz");
  const cfg = parseAppConfig(xml);
  const profile = classify(cfg);
  const CHANNEL_ACTIVE = "M-0048_A-493B-21-B471_P-57_R-57";

  // com-object 241 is active in this app's default configuration (the switch channels start at 241);
  // a link must target an object the configuration activates, or the GA flash refuses it
  // (LINK_COM_OBJECT_INACTIVE) before the staleness gate is what these tests are exercising.
  const gaCtx = (params: Map<string, string>, base: Map<string, string>) => ({
    deviceId: "d", ia: "1.2.53", links: [{ comObjNum: 241, gaRaws: [2305] }],
    params, baseParams: base, dryRun: false,
    persistBackups: () => { throw new Error("BACKUP-PERSISTED"); },
  });

  test("enabling a channel refuses the GA flash with COM_OBJECT_TABLE_STALE, before any bus call", async () => {
    // The device stub throws on ANY bus call, so a gate that failed to refuse shows up loudly.
    const err = await profile
      .flashGroupTables(dev({}), "07B0", gaCtx(new Map([[CHANNEL_ACTIVE, "1"]]), new Map()))
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as ProductError).code).toBe("COM_OBJECT_TABLE_STALE");
  });

  test("an unchanged configuration passes the gate and reaches the bus", async () => {
    const err = await profile
      .flashGroupTables(dev({ tableAddr: async () => { throw new Error("BUS-REACHED"); } }), "07B0", gaCtx(new Map(), new Map()))
      .then(() => null, (e) => e);
    expect((err as Error).message).toBe("BUS-REACHED"); // gate passed
  });
});

corpusDescribe("System 7 (absolute) flash applies the same gate", () => {
  const xml = catalogueXml("M-008E_A-7079-10-9C41.xml.gz");
  const cfg = parseAppConfig(xml);
  const profile = classify(cfg);
  const OBJ_ADDING = "M-008E_A-7079-10-9C41_P-11_R-11"; // 0 -> 1 activates com-objects 53, 54, ...

  // The device holds its default-configuration segments, addressed absolutely.
  const targets = buildAbsoluteSegmentTargets(cfg, new Map());
  const bySegAddr = new Map(targets.map((t) => [t.address, t.bytes]));
  const busDev = dev({
    propRead: async () => Buffer.alloc(16),
    memRead: async (addr: number, len: number) => (bySegAddr.get(addr) ?? Buffer.alloc(len)).subarray(0, len),
  });

  test("ground truth: the fixture is absolute and the parameter changes the object set", () => {
    expect(profile.memoryModel).toBe("absolute");
    expect(diffComObjectTables(comObjectTable(cfg, new Map()), comObjectTable(cfg, new Map([[OBJ_ADDING, "1"]]))).length).toBeGreaterThan(0);
  });

  test("refuses with COM_OBJECT_TABLE_STALE before any write", async () => {
    const err = await profile.flashParameters(busDev, "0705", ctxFor(xml, new Map([[OBJ_ADDING, "1"]]))).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProductError);
    expect((err as ProductError).code).toBe("COM_OBJECT_TABLE_STALE");
  });

  test("an unchanged configuration passes the gate", async () => {
    const err = await profile.flashParameters(busDev, "0705", ctxFor(xml, new Map())).then(() => null, (e) => e);
    expect((err as Error).message).toBe("BACKUP-PERSISTED");
  });
});
