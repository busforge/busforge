import { test, expect, describe } from "bun:test";
import { parseAppConfig, parseLoadProcedures, classify, buildDeviceConfig, comObjInstanceOverride, withInstanceOverrides, type ComObjInstanceOverride } from "../src/index.ts";
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

  test("System 7: an update or read-on-init flag set differently is refused, the same value is not", () => {
    const file = "M-0083_A-00B6-32-9642.xml.gz";
    const { n, obj } = firstActive(file);
    expect(() => plan(file, new Map([[n, { flags: { update: !obj.flags.update } }]]))).toThrow(expect.objectContaining({ code: "COM_OBJECT_OVERRIDE_UNWRITABLE" }));
    expect(() => plan(file, new Map([[n, { flags: { readOnInit: !obj.flags.readOnInit } }]]))).toThrow(expect.objectContaining({ code: "COM_OBJECT_OVERRIDE_UNWRITABLE" }));
    expect(() => plan(file, new Map([[n, { flags: { comm: !obj.flags.comm } }]]))).toThrow(expect.objectContaining({ code: "COM_OBJECT_OVERRIDE_UNWRITABLE" }));
    expect(changed(plan(file), plan(file, new Map([[n, { flags: { update: obj.flags.update } }]])))).toEqual([]);
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

  test("an override on an object the configuration does not activate changes nothing", () => {
    const file = "M-0083_A-00B6-32-9642.xml.gz";
    const cfg = parseAppConfig(catalogueXml(file));
    const active = buildDeviceConfig(cfg, new Map()).imageComObjects;
    const inactive = [...Array(255).keys()].find((n) => !active.has(n))!;
    expect(changed(plan(file), plan(file, new Map([[inactive, { flags: { read: true, update: true } }]])))).toEqual([]);
  });
});
