import { test, expect, describe } from "bun:test";
import { LSM, STATE, type KnxDevice } from "@busforge/knx";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import {
  parseAppConfig, parseLoadProcedures, classify, buildDeviceConfig, resolveModuleInstances, placeComObjOverrides, buildGroupTables, type ComObjectLink,
  buildComObjectTable, buildComObjectTableMv0705, decodeComObjectTable, decodeComObjectTableMv0705, deviceComObjOverrideRows, comObjFlagsDiffering, changedEntryBits,
  type CfgComObjImage, type ComObjInstanceOverride, type ObservedComObjFlags,
} from "../src/index.ts";

type Row = { comObjRefId: string; attrs: Record<string, string> };
const flags = (o: Partial<CfgComObjImage["flags"]> = {}) => ({ read: false, write: true, comm: true, transmit: true, update: false, readOnInit: false, ...o });
const obj = (number: number, f: Partial<CfgComObjImage["flags"]> = {}, priority: CfgComObjImage["priority"] = "Low", refId = `M-00FA_A-0001-01-0000_O-${number}_R-${number}`): CfgComObjImage =>
  ({ number, objectSize: "1 Bit", flags: flags(f), priority, refId });

// System B: [count u16][flags, size] per object, object n at entry n-1 (comobjbuild.ts comObjectEntry).
describe("a System B com-object table read off a device", () => {
  test("gives every flag and the priority of a linked object, as the table was written", () => {
    const active = new Map([[1, obj(1, { read: true, update: true, readOnInit: true })], [2, obj(2, { write: false }, "Alert")], [4, obj(4, {}, "High")]]);
    const table = buildComObjectTable(active, 5, new Set([1, 2, 4]));
    const read = decodeComObjectTable(table, new Set([1, 2, 4]));
    for (const [n, o] of active) expect(read.get(n)).toEqual({ flags: o.flags, priority: o.priority });
  });
  test("does not give the communication flag of an object without a link: it is written off whatever is set", () => {
    const table = buildComObjectTable(new Map([[1, obj(1)]]), 1, new Set());
    expect(read1(table)).toEqual({ flags: { read: false, write: true, transmit: true, update: false, readOnInit: false }, priority: "Low" });
  });
  test("gives no priority for the System class, which no application names", () => {
    const table = Buffer.from([0x00, 0x02, 0x00, 0x00, 0xc4, 0x07]);
    expect(decodeComObjectTable(table, new Set([1, 2])).get(1)!.priority).toBeUndefined();
    expect(decodeComObjectTable(table, new Set([1, 2])).get(2)).toEqual({ flags: { update: true, transmit: true, readOnInit: false, write: false, read: false, comm: true }, priority: undefined });
  });
  test("is refused when shorter than the entries its count declares", () => {
    expect(() => decodeComObjectTable(Buffer.from([0x00, 0x03, 0xc7, 0x00]), new Set())).toThrow(expect.objectContaining({ code: "COM_OBJECT_TABLE_UNREADABLE" }));
    expect(() => decodeComObjectTable(Buffer.from([0x00]), new Set())).toThrow(expect.objectContaining({ code: "COM_OBJECT_TABLE_UNREADABLE" }));
  });
  const read1 = (t: Buffer) => decodeComObjectTable(t, new Set()).get(1);
});

// System 7: [count u8][ramEnd u16] then [dataPtr u16][config][type] per object, object n at entry n
// (comobjbuild.ts buildComObjectTableMv0705).
describe("a System 7 com-object table read off a device", () => {
  test("gives read, write, transmit, update and the priority, and the communication flag only where the device links the object; read-on-init has none", () => {
    // MDT BE-02001.02 object 0, read flag off and on (captures/mdt-be02001-ets-partial-flag-read-{off,on}.log)
    const t = (cfg: number) => Buffer.from([0x01, 0x00, 0x40, 0x00, 0x50, cfg, 0x00]);
    expect(decodeComObjectTableMv0705(t(0x43), new Set()).get(0)).toEqual({ flags: { read: false, write: false, transmit: true, update: false }, priority: "Low" });
    expect(decodeComObjectTableMv0705(t(0x4b), new Set()).get(0)).toEqual({ flags: { read: true, write: false, transmit: true, update: false }, priority: "Low" });
    expect(decodeComObjectTableMv0705(t(0xd2), new Set()).get(0)).toEqual({ flags: { read: false, write: true, transmit: true, update: true }, priority: "Alert" });
    // linked: the 0x04 bit is the communication flag (captures/mdt-be02001-ets-partial-flag-comm-{off,on}.log)
    expect(decodeComObjectTableMv0705(t(0x4b), new Set([0])).get(0)!.flags.comm).toBe(false);
    expect(decodeComObjectTableMv0705(t(0x4f), new Set([0])).get(0)!.flags.comm).toBe(true);
  });
  test("is the inverse of the table the downloads author", () => {
    const template = Buffer.from([0x03, 0x00, 0x40, 0, 0x50, 0x43, 0, 0, 0x51, 0x43, 0, 0, 0x52, 0x43, 0]);
    const active = new Map([[0, obj(0, { read: true }, "High")], [2, obj(2, { update: true, transmit: false })]]);
    const read = decodeComObjectTableMv0705(buildComObjectTableMv0705(template, active, new Set([0])), new Set([0]));
    expect(read.get(0)).toEqual({ flags: { read: true, write: true, transmit: true, update: false, comm: true }, priority: "High" });
    expect(read.get(2)).toEqual({ flags: { read: false, write: true, transmit: false, update: true }, priority: "Low" });
  });
  test("is refused when shorter than the entries its count declares", () => {
    expect(() => decodeComObjectTableMv0705(Buffer.from([0x02, 0x00, 0x40, 0, 0x50, 0x43, 0]), new Set())).toThrow(expect.objectContaining({ code: "COM_OBJECT_TABLE_UNREADABLE" }));
  });
});

// What a read-back takes into the flag baseline: the device's flags as the attributes ETS stores, only
// the bits that differ from the application, and only where the device shows them.
describe("the flags a read-back takes into the baseline", () => {
  const app = { id: "M-00FA_A-0001-01-0000" };
  const ref = (n: number) => `O-${n}_R-${n}`;
  test("a bit the device holds otherwise than the application becomes its attribute", () => {
    const out = deviceComObjOverrideRows(app, new Map([[3, obj(3)], [4, obj(4)]]), new Map([[3, { flags: { read: true, write: true }, priority: "Alert" as const }], [4, { flags: { read: false }, priority: "Low" as const }]]), []);
    expect(out).toEqual({ rows: [{ comObjRefId: ref(3), attrs: { ReadFlag: "Enabled", Priority: "Alert" } }], undecoded: [] });
  });
  test("an object the device holds as recorded keeps the form the baseline stores, so nothing counts as changed", () => {
    const held: Row[] = [{ comObjRefId: ref(3), attrs: { ReadFlag: "Disabled", WriteFlag: "Enabled" } }];
    expect(deviceComObjOverrideRows(app, new Map([[3, obj(3)]]), new Map([[3, { flags: { read: false, write: true }, priority: "Low" as const }]]), held).rows).toEqual(held);
  });
  test("a bit the device does not show keeps the baseline's attribute; a bit it shows at the application's value drops it", () => {
    const held: Row[] = [{ comObjRefId: ref(3), attrs: { CommunicationFlag: "Disabled", ReadFlag: "Enabled" } }];
    expect(deviceComObjOverrideRows(app, new Map([[3, obj(3)]]), new Map([[3, { flags: { read: false }, priority: "Low" as const }]]), held).rows)
      .toEqual([{ comObjRefId: ref(3), attrs: { CommunicationFlag: "Disabled" } }]);
  });
  test("an object the configuration does not activate, or the table does not hold, keeps what the baseline stores", () => {
    const held: Row[] = [{ comObjRefId: ref(9), attrs: { ReadFlag: "Enabled" } }, { comObjRefId: ref(5), attrs: { WriteFlag: "Disabled" } }];
    const out = deviceComObjOverrideRows(app, new Map([[5, obj(5)]]), new Map([[9, { flags: { read: false }, priority: "Low" as const }]]), held);
    expect(out).toEqual({ rows: held, undecoded: [5] });
  });
  test("an object whose priority the device holds as no application names is named, its baseline kept", () => {
    const held: Row[] = [{ comObjRefId: ref(3), attrs: { Priority: "High" } }];
    const out = deviceComObjOverrideRows(app, new Map([[3, obj(3)]]), new Map([[3, { flags: { read: true } }]]), held);
    expect(out).toEqual({ rows: held, undecoded: [3] });
  });
  test("a baseline that sets one object's flag twice, differently, is refused rather than settled", () => {
    const held: Row[] = [{ comObjRefId: ref(3), attrs: { ReadFlag: "Enabled" } }, { comObjRefId: ref(3), attrs: { ReadFlag: "Disabled" } }];
    expect(() => deviceComObjOverrideRows(app, new Map([[3, obj(3)]]), new Map([[3, { flags: { read: true }, priority: "Low" as const }]]), held))
      .toThrow(expect.objectContaining({ code: "COM_OBJECT_OVERRIDE_CONFLICT" }));
  });
  test("several stored rows of one object are replaced by one where the device differs, in their place", () => {
    const held: Row[] = [{ comObjRefId: ref(1), attrs: { ReadFlag: "Enabled" } }, { comObjRefId: ref(3), attrs: { ReadFlag: "Enabled" } }, { comObjRefId: ref(3), attrs: { Priority: "High" } }, { comObjRefId: ref(7), attrs: { WriteFlag: "Disabled" } }];
    const out = deviceComObjOverrideRows(app, new Map([[1, obj(1)], [3, obj(3)], [7, obj(7)]]),
      new Map([[1, { flags: { read: true }, priority: "Low" as const }], [3, { flags: { read: true }, priority: "Low" as const }], [7, { flags: { write: false, transmit: false }, priority: "Low" as const }]]), held);
    expect(out.rows).toEqual([held[0], { comObjRefId: ref(3), attrs: { ReadFlag: "Enabled" } }, { comObjRefId: ref(7), attrs: { WriteFlag: "Disabled", TransmitFlag: "Disabled" } }]);
  });
});

// The check a write that rewrites the com-object table runs against the table the device holds.
describe("the device's flags against the ones the baseline records", () => {
  const active = new Map([[1, obj(1)], [2, obj(2)], [3, obj(3)]]);
  const seen = (o: Partial<CfgComObjImage["flags"]>, priority: CfgComObjImage["priority"] = "Low") => ({ flags: o, priority });
  test("name the objects whose shown flags or priority differ", () => {
    const observed = new Map([[1, seen({ read: false, write: true })], [2, seen({ read: true })], [3, seen({ write: true }, "High")]]);
    expect(comObjFlagsDiffering(observed, active, undefined)).toEqual([2, 3]);
  });
  test("compare with the baseline's overrides laid over the application", () => {
    const base = new Map<number, ComObjInstanceOverride>([[2, { flags: { read: true } }]]);
    expect(comObjFlagsDiffering(new Map([[1, seen({})], [2, seen({ read: true })], [3, seen({})]]), active, base)).toEqual([]);
  });
  test("an object the table does not hold, or holds with no priority an application names, differs", () => {
    expect(comObjFlagsDiffering(new Map<number, ObservedComObjFlags>([[1, seen({})], [2, { flags: {} }]]), active, undefined)).toEqual([2, 3]);
  });
  test("with the bits a write changes: only those objects, and only those bits", () => {
    const observed = new Map([[1, seen({ read: true })], [2, seen({ read: true })], [3, seen({ read: true }, "High")]]);
    expect(comObjFlagsDiffering(observed, active, undefined, new Map([[2, ["read"]]]))).toEqual([2]);
    // the write keeps the read bit the device holds and changes another one: nothing silently changed
    expect(comObjFlagsDiffering(observed, active, undefined, new Map([[1, ["comm", "write"]], [3, ["read"]]]))).toEqual([3]);
    expect(comObjFlagsDiffering(observed, active, undefined, new Map([[3, ["priority"]]]))).toEqual([3]);
  });
  test("the bits that differ between two entries, by the family's layout", () => {
    expect(changedEntryBits(0x08 | 0x04 | 0x01, "systemB")).toEqual(["read", "comm", "priority"]);
    expect(changedEntryBits(0x20, "systemB")).toEqual(["readOnInit"]);
    expect(changedEntryBits(0x20, "system7")).toEqual([]);
    expect(changedEntryBits(0x84, "system7")).toEqual(["update", "comm"]);
  });
});

// The whole path on an emulated System B unit (Jung 400021SE's application): a unit holding a read flag
// the project does not record is not rewritten by a group-address or structural flash; a read-back takes
// the flag, and under that baseline the flashes run and keep it.
corpusDescribe("a System B unit holding a flag the project does not record", () => {
  const xml = catalogueXml("M-0004_A-7072-21-99A7-O000A.xml.gz");
  const cfg = parseAppConfig(xml);
  const params = new Map<string, string>();
  const instances = resolveModuleInstances(cfg, params);
  const view = buildDeviceConfig(cfg, params, undefined, instances);
  const links: ComObjectLink[] = [{ comObjNum: 253, gaRaws: [0x0801] }];
  const L3 = 0x3000;
  const entry = (n: number) => L3 + 2 + (n - 1) * 2;
  class Unit {
    mem = new Map<number, number>();
    state = new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED], [4, STATE.LOADED]]);
    addr = new Map<number, number>([[1, 0x1000], [2, 0x2000], [3, L3], [4, 0x4000]]);
    writes = 0;
    async connect() {}
    async disconnect() {}
    async deviceDescriptor() { return "MV-07B0"; }
    async restart() {}
    async tableAddr(obj: number) { return this.addr.get(obj) ?? 0; }
    async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0; return b; }
    async writesConfirmed() { return false; }
    confirmedWrites() { return []; }
    clearConfirmedWrites() {}
    setExtendedMemoryServices() {}
    acceptUnprovenRestart() {}
    async memWrite(addr: number, data: Buffer) { this.writes++; data.forEach((b, i) => this.mem.set(addr + i, b)); }
    // The association table described as the long form (PDT_GENERIC_04), as the tables this unit holds.
    pdt = 0x14;
    async propertyDescription(obj: number, pid: number) { return { objectIndex: obj, pid, propertyIndex: 0, writable: true, pdt: this.pdt, maxElements: 1, readLevel: 3, writeLevel: 3 }; }
    async propRead(obj: number, pid: number) {
      if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]);
      if (pid === 7) { const a = this.addr.get(obj) ?? 0; return Buffer.from([(a >> 24) & 0xff, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff]); }
      return Buffer.alloc(0);
    }
    async propReadIfPresent() { return null; }
    async propValueDataMax() { return 10; }
    async propReadCounted(obj: number, pid: number, start: number, count = 1) { return { objectIndex: obj, pid, count, start, value: Buffer.alloc(8 * count) }; }
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === 5) {
        if (data[0] === LSM.LOAD) this.state.set(obj, STATE.LOADING);
        else if (data[0] === LSM.LOAD_COMPLETED) this.state.set(obj, STATE.LOADED);
        else if (data[0] === LSM.UNLOAD) this.state.set(obj, STATE.UNLOADED);
        return Buffer.alloc(0);
      }
      return data;
    }
  }
  const asDev = (u: Unit) => u as unknown as KnxDevice;
  // A unit as a full download of the project left it, with a flag of object 253 the application leaves off
  // then set on by another tool.
  const app253 = view.imageComObjects.get(253)!.flags;
  const FLIPS = [[0x08, "ReadFlag", "read"], [0x20, "ReadOnInitFlag", "readOnInit"], [0x80, "UpdateFlag", "update"]] as const;
  const [bit, attr] = FLIPS.find(([, , k]) => !app253[k]) ?? [0, ""];
  const unit = (flip: boolean) => {
    const u = new Unit();
    for (const s of classify(cfg).planFullDownload(cfg.mask, { ia: "1.2.4", params, links, proc: parseLoadProcedures(xml) }).segments) s.image.forEach((b, i) => u.mem.set(u.addr.get(s.lsm)! + i, b));
    if (flip) u.mem.set(entry(253), u.mem.get(entry(253))! | bit);
    return u;
  };
  test("the application leaves a flag of object 253 off that the unit can hold on", () => expect(bit).toBeGreaterThan(0));
  const ga = (extra: Partial<Parameters<ReturnType<typeof classify>["flashGroupTables"]>[2]> = {}) =>
    ({ deviceId: "d", ia: "1.2.4", links, params, baseParams: params, moduleInstances: instances, dryRun: true, persistBackups: () => "backup", ...extra });

  test("a group-address flash, dry run or not, and a structural flash are refused before any write", async () => {
    for (const dryRun of [true, false]) {
      const u = unit(true);
      expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ dryRun })).catch((e: unknown) => e)).toMatchObject({ code: "COM_OBJECT_FLAGS_UNKNOWN", message: expect.stringContaining("#253") });
      expect(u.writes).toBe(0);
    }
    const u = unit(true);
    const changed = new Map([["M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-149_R-142", "8"]]); // removes #253, #254
    expect(await classify(cfg).flashStructure(asDev(u), cfg.mask, { ...ga(), appXml: xml, params: changed, links: [] }).catch((e: unknown) => e)).toMatchObject({ code: "COM_OBJECT_FLAGS_UNKNOWN" });
    expect(u.writes).toBe(0);
  });

  test("a unit holding the flags the baseline records is unchanged", async () => {
    expect(await classify(cfg).flashGroupTables(asDev(unit(false)), cfg.mask, ga())).toMatchObject({ kind: "unchanged" });
  });

  test("a read-back takes the flag; under that baseline the flash runs and the unit keeps it", async () => {
    const u = unit(true);
    const read = await classify(cfg).readState(asDev(u), cfg.mask, { liveParams: params, baseParams: params, moduleInstances: instances });
    const taken = deviceComObjOverrideRows(cfg, view.imageComObjects, read.comObjFlags!, []);
    const ref253 = view.imageComObjects.get(253)!.refId.replace(`${cfg.id}_`, "");
    expect(taken).toEqual({ rows: [{ comObjRefId: ref253, attrs: { [attr]: "Enabled" } }], undecoded: [] });
    const placed = placeComObjOverrides(cfg, view, taken.rows);
    expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ comObjectOverrides: placed, comObjectOverrideBase: placed }))).toMatchObject({ kind: "unchanged" });
    // a new link on another object goes out; 253 keeps the flag the unit holds
    const before = u.mem.get(entry(253));
    const more = [...links, { comObjNum: 254, gaRaws: [0x0802] }];
    expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ links: more, comObjectOverrides: placed, comObjectOverrideBase: placed, dryRun: false }))).toMatchObject({ kind: "flashed", verified: true });
    expect(u.mem.get(entry(253))).toBe(before);
  });

  // The association table's entry width comes from the unit's description of it (PID 23), as ETS reads it.
  test("a group-address flash refuses a unit whose association table description it does not know", async () => {
    const u = unit(false);
    u.pdt = 0x13;
    expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ dryRun: false })).catch((e: unknown) => (e as { code?: string }).code)).toBe("ASSOC_TABLE_FORMAT_UNKNOWN");
    expect(u.writes).toBe(0);
  });

  // A unit describing PDT_GENERIC_02 (the MDT IP Interface/Router) holds and gets the short form: one byte each for
  // group index and object number. Its table is read in that form only, so nothing past it is read.
  const shortUnit = (held: typeof links) => {
    const u = unit(false);
    u.pdt = 0x12;
    const at = u.addr.get(2)!;
    for (let i = 0; i < 64; i++) u.mem.delete(at + i);
    buildGroupTables(held, 2).assoc.forEach((b, i) => u.mem.set(at + i, b));
    const reads: [number, number][] = [];
    const read = u.memRead.bind(u);
    u.memRead = async (a: number, len: number) => { if (a === at) reads.push([a, len]); return read(a, len); };
    return { u, at, reads };
  };
  test("a unit describing the short form gets its links in the short form, verified, and its table is read at its own length", async () => {
    const more = [...links, { comObjNum: 254, gaRaws: [0x0802] }];
    const { u, at, reads } = shortUnit(links);
    expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ links: more }))).toMatchObject({ kind: "dryRun" });
    expect(reads).toEqual([[at, 2], [at, 2 + 2 * links.length]]);
    expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ links: more, dryRun: false }))).toMatchObject({ kind: "flashed", verified: true });
    const want = buildGroupTables(more, 2).assoc;
    expect((await u.memRead(at, want.length)).equals(want)).toBe(true);
  });
  test("a unit describing the short form with an empty association table takes its first link", async () => {
    const { u, at } = shortUnit([]);
    const one = [links[0]];
    const res = await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ links: one, dryRun: false })).catch((e: unknown) => e);
    expect(res).toMatchObject({ kind: "flashed", verified: true });
    expect((await u.memRead(at, 4)).equals(buildGroupTables(one, 2).assoc)).toBe(true);
  });

  // The application declares 1600 group addresses and 1600 associations (<AddressTable>/<AssociationTable> MaxEntries).
  test("a group-address flash takes the 1600 group addresses the application declares and refuses a 1601st before any write", async () => {
    const many = (n: number): ComObjectLink[] => [{ comObjNum: 253, gaRaws: Array.from({ length: n }, (_, i) => 0x0801 + i) }];
    expect([cfg.groupTables.addressMaxEntries, cfg.groupTables.associationMaxEntries]).toEqual([1600, 1600]);
    expect(await classify(cfg).flashGroupTables(asDev(unit(false)), cfg.mask, ga({ links: many(1600) }))).toMatchObject({ kind: "dryRun" });
    const u = unit(false);
    expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ links: many(1601), dryRun: false })).catch((e: unknown) => e)).toMatchObject({ code: "GA_TABLE_TOO_LARGE", message: expect.stringContaining("1601 group addresses") });
    expect(u.writes).toBe(0);
  });

  // The device page's read-back takes the form from the same description.
  test("a read-back reads a unit describing the short form in that form, at its own length", async () => {
    const { u, at, reads } = shortUnit(links);
    const read = await classify(cfg).readState(asDev(u), cfg.mask, { liveParams: params, baseParams: params, moduleInstances: instances });
    expect(read).toMatchObject({ linksRead: true, links });
    expect(reads).toEqual([[at, 2], [at, 2 + 2 * links.length]]);
  });
  test("a read-back refuses a unit whose association table description it does not know", async () => {
    const u = unit(false);
    u.pdt = 0x13;
    expect(await classify(cfg).readState(asDev(u), cfg.mask, { liveParams: params, baseParams: params, moduleInstances: instances }).catch((e: unknown) => e))
      .toMatchObject({ code: "ASSOC_TABLE_FORMAT_UNKNOWN", message: expect.stringContaining("refusing to read it") });
  });
  // A unit answering the description with PID 0 describes no table property there: only then is the form detected.
  test("a read-back of a unit describing no table property detects the form, and a group-address flash refuses it", async () => {
    const u = unit(false);
    u.propertyDescription = async (obj: number) => ({ objectIndex: obj, pid: 0, propertyIndex: 0, writable: false, pdt: 0, maxElements: 0, readLevel: 0, writeLevel: 0 });
    const read = await classify(cfg).readState(asDev(u), cfg.mask, { liveParams: params, baseParams: params, moduleInstances: instances });
    expect(read).toMatchObject({ linksRead: true, links });
    expect(await classify(cfg).flashGroupTables(asDev(u), cfg.mask, ga({ dryRun: false })).catch((e: unknown) => e)).toMatchObject({ code: "ASSOC_TABLE_FORMAT_UNKNOWN", message: expect.stringContaining("describes no table property") });
    expect(u.writes).toBe(0);
  });

  test("a table the unit has not loaded leaves the flags open and the read goes on", async () => {
    const u = unit(false);
    u.addr.set(3, 0);
    const read = await classify(cfg).readState(asDev(u), cfg.mask, { liveParams: params, baseParams: params, moduleInstances: instances });
    expect(read).toMatchObject({ linksRead: true, links, comObjFlagsUnreadable: expect.stringContaining("DEVICE_NOT_PROGRAMMED") });
    expect(read.comObjFlags).toBeUndefined();
  });
});
