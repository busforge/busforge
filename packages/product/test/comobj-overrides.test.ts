import { test, expect, describe } from "bun:test";
import { parseAppConfig, parseLoadProcedures, classify, buildDeviceConfig, comObjInstanceOverride, withInstanceOverrides, editComObjOverride, type ComObjInstanceOverride } from "../src/index.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

describe("the com-object flags a project sets on a device", () => {
  test("are read from the attributes as ETS stores them", () => {
    expect(comObjInstanceOverride({ ReadFlag: "Enabled", TransmitFlag: "Disabled", Priority: "Alert" })).toEqual({ flags: { read: true, transmit: false }, priority: "Alert" });
    expect(comObjInstanceOverride({})).toEqual({ flags: {} });
  });
  test("a value outside the schema is refused, not guessed", () => {
    for (const attrs of [{ ReadFlag: "true" }, { WriteFlag: "" }, { Priority: "Urgent" }, { Text: "x" }] as Record<string, string>[]) {
      expect(() => comObjInstanceOverride(attrs)).toThrow(expect.objectContaining({ code: "COM_OBJECT_OVERRIDE_INVALID" }));
    }
  });
  test("lie over the application's flags of an active object, and leave an inactive one out", () => {
    const active = new Map([[3, { number: 3, objectSize: "1 Bit", flags: { read: false, write: true, comm: true, transmit: true, update: false, readOnInit: false }, priority: "Low" as const, refId: "r" }]]);
    const o = new Map<number, ComObjInstanceOverride>([[3, { flags: { read: true } }], [9, { flags: { read: true } }]]);
    const out = withInstanceOverrides(active, o);
    expect(out.get(3)!.flags).toEqual({ read: true, write: true, comm: true, transmit: true, update: false, readOnInit: false });
    expect(out.has(9)).toBe(false);
    expect(active.get(3)!.flags.read).toBe(false); // the application's view is untouched
  });
});

// An edit on the device page: each changed bit becomes the attribute ETS stores, a bit set back to
// what the device holds takes the stored form it holds, and a bit set to the application's value
// drops the attribute.
describe("editing a com-object's flags", () => {
  const app = { flags: { read: false, write: true, comm: true, transmit: true, update: false, readOnInit: false }, priority: "Low" as const };
  test("a bit set otherwise than the application is stored as ETS stores it", () => {
    expect(editComObjOverride(undefined, undefined, app, { flags: { read: true }, priority: "Alert" })).toEqual({ ReadFlag: "Enabled", Priority: "Alert" });
    expect(editComObjOverride({ WriteFlag: "Disabled" }, undefined, app, { flags: { transmit: false } })).toEqual({ WriteFlag: "Disabled", TransmitFlag: "Disabled" });
  });
  test("a bit set to the application's value, or reset (null), drops its attribute", () => {
    expect(editComObjOverride({ ReadFlag: "Enabled", Priority: "High" }, undefined, app, { flags: { read: false }, priority: null })).toEqual({});
    expect(editComObjOverride({ ReadFlag: "Enabled" }, undefined, app, { flags: { read: null } })).toEqual({});
  });
  test("a bit set back to what the device holds takes the form it holds", () => {
    // the device holds ReadFlag="Disabled" (equal to the application): setting read on and off again
    // gives back exactly that attribute, so nothing counts as changed
    const held = { ReadFlag: "Disabled" };
    const on = editComObjOverride(held, held, app, { flags: { read: true } });
    expect(on).toEqual({ ReadFlag: "Enabled" });
    expect(editComObjOverride(on, held, app, { flags: { read: false } })).toEqual({ ReadFlag: "Disabled" });
    expect(editComObjOverride(on, held, app, { flags: { read: null } })).toEqual({ ReadFlag: "Disabled" });
  });
  test("a value outside the schema in the stored form is refused", () => {
    expect(() => editComObjOverride({ ReadFlag: "yes" }, undefined, app, { flags: { write: false } })).toThrow(expect.objectContaining({ code: "COM_OBJECT_OVERRIDE_INVALID" }));
  });
});

// The image a full download writes, with and without an override, on products with ETS captures: the
// override changes exactly the object's entry where the table has a bit for it, and is refused where
// it has none.
corpusDescribe("a full download writes the project's com-object flags", () => {
  const plan = (file: string, overrides?: Map<number, ComObjInstanceOverride>, links: { comObjNum: number; gaRaws: number[] }[] = []) => {
    const xml = catalogueXml(file);
    const cfg = parseAppConfig(xml);
    return classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links, proc: parseLoadProcedures(xml), comObjectOverrides: overrides });
  };
  const changed = (a: ReturnType<typeof plan>, b: ReturnType<typeof plan>) =>
    a.segments.flatMap((s, i) => [...s.image].flatMap((v, j) => (v !== b.segments[i].image[j] ? [[s.id.split("_").pop(), j, v, b.segments[i].image[j]]] : [])));
  const firstActive = (file: string) => {
    const cfg = parseAppConfig(catalogueXml(file));
    const [n, obj] = [...buildDeviceConfig(cfg, new Map()).imageComObjects][0];
    return { n, obj };
  };

  test("System 7 (MDT BE-02001.02): the read bit of the object's config byte, nothing else", () => {
    const file = "M-0083_A-00B6-32-9642.xml.gz";
    const { n, obj } = firstActive(file);
    const before = plan(file);
    const after = plan(file, new Map([[n, { flags: { read: !obj.flags.read } }]]));
    const diff = changed(before, after);
    expect(diff).toHaveLength(1);
    expect(diff[0][1]).toBe(3 + n * 4 + 2);
    expect((Number(diff[0][2]) ^ Number(diff[0][3]))).toBe(0x08);
  });

  // Update is config 0x80; communication is the linked bit 0x04, set only on a linked object
  // (captures/mdt-be02001-ets-partial-flag-{update,comm}-{on,off}.log). The config byte has no
  // read-on-init bit.
  test("System 7: the update bit of the object's config byte; a read-on-init flag set differently is refused, the same value is not", () => {
    const file = "M-0083_A-00B6-32-9642.xml.gz";
    const { n, obj } = firstActive(file);
    const diff = changed(plan(file), plan(file, new Map([[n, { flags: { update: !obj.flags.update } }]])));
    expect(diff).toHaveLength(1);
    expect(diff[0][1]).toBe(3 + n * 4 + 2);
    expect((Number(diff[0][2]) ^ Number(diff[0][3]))).toBe(0x80);
    expect(() => plan(file, new Map([[n, { flags: { readOnInit: !obj.flags.readOnInit } }]]))).toThrow(expect.objectContaining({ code: "COM_OBJECT_OVERRIDE_UNWRITABLE" }));
    expect(changed(plan(file), plan(file, new Map([[n, { flags: { readOnInit: obj.flags.readOnInit } }]])))).toEqual([]);
  });

  test("System 7: communication off clears a linked object's linked bit and keeps its association; on an object without a group address it changes nothing", () => {
    const file = "M-0083_A-00B6-32-9642.xml.gz";
    const { n, obj } = firstActive(file);
    expect(obj.flags.comm).toBe(true);
    const off = new Map([[n, { flags: { comm: false } }]]);
    const links = [{ comObjNum: n, gaRaws: [0x0001] }];
    const diff = changed(plan(file, undefined, links), plan(file, off, links));
    expect(diff).toHaveLength(1);
    expect(diff[0][1]).toBe(3 + n * 4 + 2);
    expect((Number(diff[0][2]) ^ Number(diff[0][3]))).toBe(0x04);
    expect(changed(plan(file), plan(file, off))).toEqual([]);
  });

  test("System B (Jung 400021SE): the object's flags byte, update and read-on-init included", () => {
    const file = "M-0004_A-7072-21-99A7-O000A.xml.gz";
    const { n, obj } = firstActive(file);
    const base = plan(file);
    for (const flags of [{ update: !obj.flags.update }, { readOnInit: !obj.flags.readOnInit }, { read: !obj.flags.read }]) {
      expect(changed(base, plan(file, new Map([[n, { flags }]])))).toHaveLength(1);
    }
    expect(changed(base, plan(file, new Map([[n, { flags: {}, priority: obj.priority === "Low" ? "High" : "Low" }]])))).toHaveLength(1);
  }, 60_000);

  test("the bits each family's full download can carry are the ones the editor offers", () => {
    const bits = (file: string) => classify(parseAppConfig(catalogueXml(file))).comObjOverridableBits();
    expect(bits("M-0083_A-00B6-32-9642.xml.gz")).toEqual(["read", "write", "comm", "transmit", "update", "priority"]);
    expect(bits("M-0004_A-7072-21-99A7-O000A.xml.gz")).toEqual(["read", "write", "comm", "transmit", "update", "readOnInit", "priority"]);
  }, 60_000);

  test("an override on an object the configuration does not activate changes nothing", () => {
    const file = "M-0083_A-00B6-32-9642.xml.gz";
    const cfg = parseAppConfig(catalogueXml(file));
    const active = buildDeviceConfig(cfg, new Map()).imageComObjects;
    const inactive = [...Array(255).keys()].find((n) => !active.has(n))!;
    expect(changed(plan(file), plan(file, new Map([[inactive, { flags: { read: true, update: true } }]])))).toEqual([]);
  });
});
