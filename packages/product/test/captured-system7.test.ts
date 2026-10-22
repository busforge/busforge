import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, parseLoadProcedures, buildDeviceConfig, buildAbsoluteSegmentTargets, absoluteStructuralImages, buildGroupTablesMv0705, System7Profile, absoluteFullStepRefusal, fullDownloadImageDigest, planSystem7GaFlash, type AppConfig, type ComObjectLink, type LoadProcedures } from "../src/index.ts";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 9.0 s with the
// file alone (load 5-27) and up to 9.0 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(190_000);

// The Gira Tastsensor 3 Komfort (M-0008) as the ETS captures show it answering, emulated byte for
// byte: load-state machines on PID 5, a segment declaration on PID 5 moving the machine's table
// reference (PID 7), the program id (object 3 PID 13), a stamp on PID 27 per declared segment, memory.
// The profile's real write paths run against it, not a dry run, and the device is read back after.
class GiraDevice {
  mem = new Map<number, number>();
  state = new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED]]);
  tableRef = new Map<number, number>([[1, 0x4000], [2, 0x4011], [3, 0x41e5]]);
  programId = Buffer.from("000810d711", "hex");
  ops: string[] = [];
  constructor(cfg: AppConfig) {
    for (const s of cfg.absoluteSegments) s.data.forEach((b, i) => this.mem.set(s.address + i, b));
  }
  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return "MV-0705"; }
  level = 0;
  async authorizeFreeKey() { return this.level; }
  async restart() { this.ops.push("restart"); }
  async writesConfirmed() { return false; }
  confirmedWrites() { return []; }
  clearConfirmedWrites() {}
  setExtendedMemoryServices() {}
  acceptUnprovenRestart() {}
  async tableAddr(obj: number) { return this.tableRef.get(obj) ?? 0; }
  async memRead(addr: number, len: number) { return Buffer.from(Array.from({ length: len }, (_, i) => this.mem.get(addr + i) ?? 0)); }
  async memWrite(addr: number, data: Buffer) {
    if (this.ops.at(-1) !== "write") this.ops.push("write");
    data.forEach((b, i) => this.mem.set(addr + i, b));
  }
  async propRead(obj: number, pid: number) {
    if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]);
    if (obj === 3 && pid === 13) return this.programId;
    if (pid === 7) { const a = this.tableRef.get(obj) ?? 0; return Buffer.from([a >> 24, a >> 16, a >> 8, a].map((x) => x & 0xff)); }
    return Buffer.alloc(0);
  }
  async propWrite(obj: number, pid: number, data: Buffer) {
    if (pid !== 5) throw new Error(`unexpected property write ${obj}/${pid}`);
    if (data[0] === 3 && data[1] === 0) { this.tableRef.set(obj, data.readUInt16BE(2)); this.ops.push(`absSegment:${obj}@${data.readUInt16BE(2)}+${data.readUInt16BE(4)}`); }
    else if (data[0] === 3 && data[1] === 2) this.ops.push(`taskSegment:${obj}@${data.readUInt16BE(2)}`);
    else if (data[0] === 3 && data[1] === 4) this.ops.push(`taskCtrl1:${obj}=${data.subarray(2).toString("hex")}`);
    else {
      const ev = ({ 1: "load", 2: "loadCompleted", 4: "unload" } as Record<number, string>)[data[0]];
      this.state.set(obj, data[0] === 1 ? STATE.LOADING : data[0] === 2 ? STATE.LOADED : STATE.UNLOADED);
      this.ops.push(`${ev}:${obj}`);
    }
    return Buffer.from([this.state.get(obj)!]);
  }
  async propReadCounted(obj: number, pid: number, start: number, count = 1) {
    this.ops.push(`read ${obj}/${pid}#${start}${count > 1 ? `x${count}` : ""}`);
    return { objectIndex: obj, pid, count, start, value: Buffer.alloc(8 * count) };
  }
  // A standard-frame device: one 8-byte stamp per property response.
  async propValueDataMax() { return 10; }
}
const asDev = (d: GiraDevice) => d as unknown as KnxDevice;
const STAMPS = ["read 1/27#1", "read 2/27#1", ...[1, 2, 3, 4, 5, 6].map((i) => `read 3/27#${i}`)];

corpusDescribe("the captured M-0008 downloads, run against an emulated device", () => {
  const xml = catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz");
  const cfg = parseAppConfig(xml);
  const IA = "1.2.7";
  const base = { deviceId: "d", ia: IA, appXml: xml, params: new Map<string, string>(), dryRun: false, persistBackups: () => "backup" };
  const twoObjects: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x1107, 0x77c8] }, { comObjNum: 2, gaRaws: [0x1108, 0x77c8] }];

  test("full download: ETS's sequence, the tables placed one behind the other, verified after the restart", async () => {
    const dev = new GiraDevice(cfg);
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    // address table: count 3 (own address + 2), 1.2.7, 2/1/7, 2/1/8, 14/7/200 -> 9 bytes at 0x4000
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2",
      "load:1", "absSegment:1@16384+9", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16393+475", "write", "taskSegment:2@16393", "loadCompleted:2",
      "load:3", "write", "loadCompleted:3", ...STAMPS, "restart",
    ]);
    // the association table, first links first: (1,0) (2,2), then 14/7/200 = index 3 on both: (3,0) (3,2)
    expect((await dev.memRead(0x4009, 9)).toString("hex")).toBe("040100020203000302");
    expect(dev.tableRef.get(2)).toBe(0x4009);
  }, 70_000);

  test("full download: a table reference the device does not hold at the re-declared address after the restart is not verified", async () => {
    const dev = new GiraDevice(cfg);
    dev.restart = async () => { dev.ops.push("restart"); dev.tableRef.set(2, 0x4011); };
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    expect(r).toMatchObject({ kind: "flashed", verified: false });
    expect((await dev.memRead(0x4009, 9)).toString("hex")).toBe("040100020203000302");
  }, 100_000);

  test("a device without this application is refused, untouched", async () => {
    const dev = new GiraDevice(cfg);
    dev.state.set(3, STATE.UNLOADED);
    expect(await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects }).catch((e: unknown) => e)).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
    expect(dev.ops).toEqual([]);
  });

  test("a unit that grants the free key less than level 0, as ETS was granted, is refused, untouched", async () => {
    const dev = new GiraDevice(cfg);
    dev.level = 3;
    expect(await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects }).catch((e: unknown) => e)).toMatchObject({ code: "FULL_DOWNLOAD_ACCESS_LEVEL" });
    expect(dev.ops).toEqual([]);
  });

  test("the dry run reports the digest of the image the offline plan builds", async () => {
    const dev = new GiraDevice(cfg);
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects, dryRun: true });
    // The emulated unit holds the application loaded, so the dry run plans ETS's partial form.
    const offline = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: new Map(), links: twoObjects, proc: parseLoadProcedures(xml), unitHoldsApplication: true });
    expect(r).toMatchObject({ kind: "dryRun", imageDigest: fullDownloadImageDigest(offline.segments) });
    expect(dev.ops).toEqual([]);
  });

  test("a unit whose address table is not loaded is refused, untouched, though it holds the application", async () => {
    const dev = new GiraDevice(cfg);
    dev.state.set(1, STATE.UNLOADED);
    expect(await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects }).catch((e: unknown) => e))
      .toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED", message: expect.stringContaining("does not hold this application loaded") });
    expect(dev.ops).toEqual([]);
  });

  // A broken-off application bracket leaves LSM 3 LOADING with this program id: no capture shows what
  // ETS sends to such a unit, so it is refused too, and ETS restores it.
  test("a unit whose application is LOADING, with this program id, is refused as well", async () => {
    const dev = new GiraDevice(cfg);
    dev.state.set(3, STATE.LOADING);
    expect(await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects }).catch((e: unknown) => e)).toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED" });
    expect(dev.ops).toEqual([]);
  });

  test("group-address flash: a longer address table moves the association table, and the read-back follows it", async () => {
    const dev = new GiraDevice(cfg);
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    dev.ops = [];
    const more = [...twoObjects, { comObjNum: 4, gaRaws: [0x77c9] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2",
      "load:1", "absSegment:1@16384+11", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16395+473", "write", "taskSegment:2@16395", "loadCompleted:2",
      "load:3", "write", "loadCompleted:3", ...STAMPS, "restart",
    ]);
    expect(dev.tableRef.get(2)).toBe(0x400b);
  }, 130_000);

  // ETS's image of its group-address download (gira-m0008-ets6log-partial-links.txt) leaves out the
  // address table's own individual address and the com-object segment's bytes behind its counted
  // entries; the flash writes neither and does not count them as a change.
  test("group-address flash: neither the own individual address nor the com-object segment's bytes behind the table are written", async () => {
    const dev = new GiraDevice(cfg);
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    const comObj = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.comObjectSegment)!;
    const tail = comObj.address + 3 + 4 * comObj.data[0];
    expect(comObj.address + comObj.size - tail).toBe(8);
    const marked = [0x4001, 0x4002, ...Array.from({ length: 8 }, (_, i) => tail + i)];
    for (const a of marked) dev.mem.set(a, 0xa5);
    const written: number[] = [];
    const memWrite = dev.memWrite.bind(dev);
    dev.memWrite = async (addr: number, data: Buffer) => { data.forEach((_, i) => written.push(addr + i)); return memWrite(addr, data); };
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: [...twoObjects, { comObjNum: 4, gaRaws: [0x77c9] }], baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(written.filter((a) => marked.includes(a))).toEqual([]);
    expect(marked.map((a) => dev.mem.get(a))).toEqual(marked.map(() => 0xa5));
  }, 130_000);

  test("group-address flash: a unit that differs only in the address table's own address is unchanged", async () => {
    const dev = new GiraDevice(cfg);
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x09);
    dev.ops = [];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "unchanged" });
    expect(dev.ops).toEqual([]);
  }, 70_000);

  // Equal table bytes are not enough: the device reads its association table from where object 2's
  // reference points, so a table that stands elsewhere is counted as a change and written.
  test("group-address flash: tables whose reference is not at the re-declared address are not unchanged", async () => {
    const dev = new GiraDevice(cfg);
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    // The unit holds its own address in the address table, as a real one does (the download leaves it).
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x07);
    const at = dev.tableRef.get(2)!;
    dev.tableRef.set(2, at + 2);
    for (let i = 20; i >= 0; i--) dev.mem.set(at + 2 + i, dev.mem.get(at + i) ?? 0);
    const dry = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), dryRun: true });
    expect(dry).toMatchObject({ kind: "dryRun" });
    expect((dry as { diffBytes: number }).diffBytes).toBeGreaterThan(0);
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect([dev.tableRef.get(1), dev.tableRef.get(2)]).toEqual([0x4000, at]);
  }, 130_000);

  // ETS keeps the association of a linked object with communication off and clears its linked bit
  // (captures/mdt-be02001-ets-partial-flag-comm-{off,on}.log).
  test("group-address flash: a linked object whose communication flag the project changes to off gets no linked bit", async () => {
    const l3 = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.comObjectSegment)!;
    const app0 = buildDeviceConfig(cfg, new Map()).imageComObjects.get(0)!;
    expect(app0.flags.comm).toBe(true);
    // a unit holding the flags the baseline records (the application's) for the object, linked
    const dev = new GiraDevice(cfg);
    const template = dev.mem.get(l3.address + 3 + 2)!;
    const held = (template & ~0xdf) | { Low: 0b11, High: 0b01, Alert: 0b10 }[app0.priority] | 0x04 | (app0.flags.read ? 0x08 : 0) | (app0.flags.write ? 0x10 : 0) | (app0.flags.transmit ? 0x40 : 0) | (app0.flags.update ? 0x80 : 0);
    dev.mem.set(l3.address + 3 + 2, held);
    const off = new Map([[0, { flags: { comm: false } }]]);
    expect(await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), comObjectOverrides: off, comObjectFlagChanges: new Set([0]) })).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.mem.get(l3.address + 3 + 2)).toBe(held & ~0x04);
  }, 70_000);

  // The captures show a project's communication flag off over an application's on; what ETS writes for a
  // linked object whose application itself sets communication off is not captured.
  test("a linked object whose application sets communication off is refused by every write that authors its linked bit, before any write", async () => {
    const ref0 = buildDeviceConfig(cfg, new Map()).imageComObjects.get(0)!.refId;
    const offCfg = { ...cfg, comObjectRefs: new Map([...cfg.comObjectRefs].map(([k, r]) => [k, r.id === ref0 ? { ...r, flags: { ...r.flags, comm: false } } : r])) };
    expect(buildDeviceConfig(offCfg, new Map()).imageComObjects.get(0)!.flags.comm).toBe(false);
    for (const run of [
      (d: GiraDevice) => classify(offCfg).flashGroupTables(asDev(d), offCfg.mask, { ...base, links: twoObjects, baseParams: new Map() }),
      (d: GiraDevice) => classify(offCfg).flashStructure(asDev(d), offCfg.mask, { ...base, links: twoObjects, baseParams: new Map() }),
      (d: GiraDevice) => classify(offCfg).downloadFull(asDev(d), offCfg.mask, { ...base, links: twoObjects }),
    ]) {
      const dev = new GiraDevice(offCfg);
      expect(await run(dev).catch((e: unknown) => e)).toMatchObject({ code: "COM_OBJECT_APP_COMM_OFF_LINKED" });
      expect(dev.ops.filter((o) => o === "write")).toEqual([]);
    }
    // not linked: nothing to decide, the full download runs
    const free = new GiraDevice(offCfg);
    expect(await classify(offCfg).downloadFull(asDev(free), offCfg.mask, { ...base, links: twoObjects.filter((l) => l.comObjNum !== 0) })).toMatchObject({ verified: true });
  }, 70_000);

  test("group-address flash: an object whose flags the project changed gets them as the project gives them; the rest stays as the unit holds it", async () => {
    const l3 = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.comObjectSegment)!;
    const config = (d: GiraDevice, n: number) => d.mem.get(l3.address + 3 + n * 4 + 2)!;
    const app0 = buildDeviceConfig(cfg, new Map()).imageComObjects.get(0)!;
    const flipped = new Map([[0, { flags: { read: !app0.flags.read }, priority: app0.priority === "Alert" ? "Low" as const : "Alert" as const }]]);
    // not a change since the last write: the unit keeps its bits, only the linked bit follows the links
    const kept = new GiraDevice(cfg);
    const before = config(kept, 0);
    expect(await classify(cfg).flashGroupTables(asDev(kept), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), comObjectOverrides: flipped })).toMatchObject({ kind: "flashed", verified: true });
    expect(config(kept, 0)).toBe(before | 0x04);
    // a change: read and priority as the project gives them, on a unit holding the flags the baseline
    // records (the application's) for the object
    const changed = new GiraDevice(cfg);
    const PRIO = { Low: 0b11, High: 0b01, Alert: 0b10 };
    const held = (before & ~0xdb) | PRIO[app0.priority] | (app0.flags.read ? 0x08 : 0) | (app0.flags.write ? 0x10 : 0) | (app0.flags.transmit ? 0x40 : 0) | (app0.flags.update ? 0x80 : 0);
    changed.mem.set(l3.address + 3 + 2, held);
    expect(await classify(cfg).flashGroupTables(asDev(changed), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), comObjectOverrides: flipped, comObjectFlagChanges: new Set([0]) })).toMatchObject({ kind: "flashed", verified: true });
    expect(config(changed, 0)).toBe((held & ~0x0b) | (app0.flags.read ? 0 : 0x08) | PRIO[flipped.get(0)!.priority] | 0x04);
    // the same change on a unit holding a third priority, which the baseline does not record: refused
    // before any write, as the write would change it silently
    const other = new GiraDevice(cfg);
    const third = (["Low", "High", "Alert"] as const).find((p) => p !== app0.priority && p !== flipped.get(0)!.priority)!;
    other.mem.set(l3.address + 3 + 2, (held & ~0x03) | PRIO[third]);
    expect(await classify(cfg).flashGroupTables(asDev(other), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), comObjectOverrides: flipped, comObjectFlagChanges: new Set([0]) }).catch((e: unknown) => e))
      .toMatchObject({ code: "COM_OBJECT_FLAGS_UNKNOWN" });
    expect(other.ops.filter((o) => o === "write")).toEqual([]);
    // an update flag the project changes: config 0x80 as the project gives it
    // (captures/mdt-be02001-ets-partial-flag-update-{on,off}.log)
    const upd = new GiraDevice(cfg);
    const updHeld = (before & ~0xdb) | { Low: 0b11, High: 0b01, Alert: 0b10 }[app0.priority] | (app0.flags.read ? 0x08 : 0) | (app0.flags.write ? 0x10 : 0) | (app0.flags.transmit ? 0x40 : 0) | (app0.flags.update ? 0x80 : 0);
    upd.mem.set(l3.address + 3 + 2, updHeld);
    expect(await classify(cfg).flashGroupTables(asDev(upd), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), comObjectOverrides: new Map([[0, { flags: { update: !app0.flags.update } }]]), comObjectFlagChanges: new Set([0]) })).toMatchObject({ kind: "flashed", verified: true });
    expect(config(upd, 0)).toBe((updHeld & ~0x80) | (app0.flags.update ? 0 : 0x80) | 0x04);
  }, 190_000);

  test("parameter flash: one bracket on the application, the stamps, the restart", async () => {
    const dev = new GiraDevice(cfg);
    const ref = "M-0008_A-10D7-11-2783-O000A_P-3764_R-3764";
    expect(cfg.params.has("M-0008_A-10D7-11-2783-O000A_P-3764")).toBe(true);
    const r = await classify(cfg).flashParameters(asDev(dev), cfg.mask, { ...base, params: new Map([[ref, "40"]]), baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual(["load:3", "write", "loadCompleted:3", ...STAMPS, "restart"]);
    expect(dev.mem.get(0x435c + 3)).toBe(40);
  }, 70_000);

  // P-3738 "Downloaderkennung" (Access="None", the same value in every configuration): a unit that holds
  // another value there and nothing else differing is unchanged, nothing written, the parameter named.
  test("parameter flash: a unit that differs only in a constant parameter is unchanged and names it", async () => {
    const dev = new GiraDevice(cfg);
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    const c = buildAbsoluteSegmentTargets(cfg, new Map()).flatMap((t) => t.constants.map((k) => ({ ...k, address: t.address })))
      .find((k) => k.paramId === "M-0008_A-10D7-11-2783-O000A_P-3738")!;
    expect(c.sizeInBit % 8).toBe(0);
    dev.mem.set(c.address + c.offset, dev.mem.get(c.address + c.offset)! ^ 0xff);
    dev.ops = [];
    const r = await classify(cfg).flashParameters(asDev(dev), cfg.mask, { ...base, dryRun: true, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "unchanged", constantsDiffer: [{ paramRefId: c.paramRefId, label: "Downloaderkennung" }] });
    expect(dev.ops.filter((o) => o === "write")).toEqual([]);
  }, 70_000);
});

// The rules every System 7 application's declared full download follows (docs/load-procedures.md, "The
// rules, by level"): declarations as PID 5 writes on a property-mapped mask, to the 0x0104 control on a
// memory-mapped one; the address table's own individual address never written; a declared LdCtrlTaskCtrl1
// encoded from its attributes; the associations in ETS's order.
corpusDescribe("the System 7 rules hold for every catalogue application", () => {
  test("declarations travel by the mask, the own individual address is never written", () => {
    let planned = 0;
    for (const f of listCatalogue()) {
      const xml = catalogueXml(f);
      const cfg = parseAppConfig(xml);
      if (!(classify(cfg) instanceof System7Profile)) continue;
      let plan;
      try { plan = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }).plan; } catch { continue; }
      planned++;
      const declared = plan.filter((st) => st.op === "absSegment" || st.op === "taskSegment");
      const viaProperty = cfg.mask !== "MV-0701" && cfg.mask !== "MV-0700";
      expect([f, declared.filter((st) => ("viaProperty" in st) !== viaProperty)]).toEqual([f, []]);
      const addrAt = cfg.absoluteSegments.find((x) => x.id === cfg.groupTables.addressSegment)!.address;
      const own = plan.flatMap((st) => (st.op === "writeMem" ? Array.from(st.bytes, (_, i) => st.address + i) : [])).filter((a) => a === addrAt + 1 || a === addrAt + 2);
      expect([f, own]).toEqual([f, []]);
    }
    expect(planned).toBeGreaterThanOrEqual(6); // ABB, TheLuxa, Meteodata, Auro FE01, both MDT
  }, 70_000); // parses every catalogue application, the 26.9 MB Jung among them: about 3 s on a busy machine, over 8 s while the check runs every workspace at once
  test("every declared LdCtrlTaskCtrl1 is encoded from its Address and Count", () => {
    const seen: string[] = [];
    for (const f of listCatalogue()) {
      const xml = catalogueXml(f);
      const proc = parseLoadProcedures(xml);
      const tc = proc.blocks.flatMap((b) => b.steps).find((st) => st.verb === "LdCtrlTaskCtrl1");
      if (!tc) continue;
      seen.push(proc.app ?? f);
      const cfg = parseAppConfig(xml);
      let plan;
      try { plan = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc }).plan; } catch (e) { expect([f, String((e as Error).message)]).not.toEqual([f, expect.stringContaining("TaskCtrl1")]); continue; }
      expect(plan.filter((st) => st.op === "taskCtrl1")).toEqual([{ op: "taskCtrl1", lsm: Number(tc.attrs.LsmIdx), address: Number(tc.attrs.Address), count: Number(tc.attrs.Count) }]);
    }
    expect(seen.sort()).toEqual(["M-0008_A-10D7-11-2783-O000A", "M-0048_A-107E-12-5B58", "M-0048_A-140C-14-EB70", "M-0081_A-FE01-11-75D9", "M-0081_A-FF31-31-D6FF", "M-008E_A-7079-10-9C41"]);
  }, 60_000); // reads every catalogue application's load procedure, the 26.9 MB Jung among them: about 1 s on a quiet machine, several times that while the check runs every workspace at once
  test("the associations: each object's first link, then the others by object and group index", () => {
    const multi: ComObjectLink[] = [{ comObjNum: 2, gaRaws: [0x0903, 0x0901] }, { comObjNum: 0, gaRaws: [0x0905, 0x0902, 0x0904] }, { comObjNum: 1, gaRaws: [0x0900] }];
    // group indices: 0x0900=1 0x0901=2 0x0902=3 0x0903=4 0x0904=5 0x0905=6
    expect(buildGroupTablesMv0705(multi, 0x11fa).assoc.toString("hex")).toEqual("06" + "0600" + "0101" + "0402" + "0300" + "0500" + "0202");
  });
});

// A memory-mapped System 7 unit (MV-0701): its load-state machines take the 11-byte control at 0x0104 and
// answer their state at 46825 + LSM; the program id is object 3 PID 13. It records every memory read and
// every memory write but the controls, in order.
class MemMappedDevice {
  mem = new Map<number, number>();
  written: [number, number][] = [];
  ops: string[] = [];
  constructor(cfg: AppConfig, public programId: Buffer) {
    for (const s of cfg.absoluteSegments) s.data.forEach((b, i) => this.mem.set(s.address + i, b));
    for (const lsm of [1, 2, 3]) this.mem.set(46825 + lsm, STATE.LOADED);
  }
  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return "MV-0701"; }
  async authorizeFreeKey() { return 0; }
  async restart() {}
  async writesConfirmed() { return false; }
  confirmedWrites() { return []; }
  clearConfirmedWrites() {}
  setExtendedMemoryServices() {}
  acceptUnprovenRestart() {}
  async classicReadChunk() { return 12; }
  async memRead(addr: number, len: number, chunk?: number) {
    if (addr < 46825) { this.ops.push(`read ${addr.toString(16)}+${len}/${chunk ?? "-"}`); }
    return Buffer.from(Array.from({ length: len }, (_, i) => this.mem.get(addr + i) ?? 0));
  }
  async memWrite(addr: number, data: Buffer) {
    if (addr === 0x0104) {
      const lsm = data[0] >> 4, ev = data[0] & 0x0f;
      if (ev !== 3) this.mem.set(46825 + lsm, ev === 1 ? STATE.LOADING : ev === 2 ? STATE.LOADED : STATE.UNLOADED);
      return;
    }
    this.ops.push(`write ${addr.toString(16)}+${data.length}`);
    data.forEach((b, i) => { this.mem.set(addr + i, b); this.written.push([addr + i, b]); });
  }
  async propRead(obj: number, pid: number) { return obj === 3 && pid === 13 ? this.programId : Buffer.alloc(0); }
}

// The ABB US/U 4.2 (M-0002_A-A001-13-63C2, MV-0701): its parameter flash runs read-compare (RunOpts.readCompare)
// through the profile. The unit holds the target image but for "Transmission delay after bus voltage recovery"
// (P-3, 0x6F01) at its default 2; the flash to 5 reads the block holding it and writes that one byte.
corpusDescribe("a memory-mapped System 7 parameter flash, run against an emulated unit", () => {
  const xml = catalogueXml("M-0002_A-A001-13-63C2.xml.gz");
  const cfg = parseAppConfig(xml);
  const DELAY = "M-0002_A-A001-13-63C2_P-3_R-3";

  test("only the byte that differs is written, its block read first in the unit's read size, and the flash verifies", async () => {
    const params = new Map([[DELAY, "5"]]);
    const dev = new MemMappedDevice(cfg, Buffer.from("0002a00113", "hex"));
    for (const t of buildAbsoluteSegmentTargets(cfg, params)) t.bytes.forEach((b, i) => { if (t.owned[i]) dev.mem.set(t.address + i, b); });
    dev.mem.set(0x6f01, 2);
    const r = await classify(cfg).flashParameters(dev as unknown as KnxDevice, cfg.mask, {
      deviceId: "d", appXml: xml, params, baseParams: new Map(), dryRun: false, persistBackups: () => "backup",
    });
    expect(r).toMatchObject({ kind: "flashed", verified: true, diffBytes: 1 });
    expect(dev.written).toEqual([[0x6f01, 5]]);
    // The planned write was read first, in the unit's 12-byte read blocks, then the differing byte written.
    const w = dev.ops.indexOf("write 6f01+1");
    expect(dev.ops.slice(w - 1, w + 1)).toEqual(["read 6f01+1/12", "write 6f01+1"]);
  });

  test("a full download reports the bytes it wrote, and its progress runs over the planned bytes", async () => {
    const dev = new MemMappedDevice(cfg, Buffer.from("0002a00113", "hex"));
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x05);
    const progress: [number, number][] = [];
    const r = await classify(cfg).downloadFull(dev as unknown as KnxDevice, cfg.mask, {
      deviceId: "d", ia: "1.2.5", appXml: xml, params: new Map(), links: [], dryRun: false, persistBackups: () => "backup",
      onProgress: (phase, done, total) => { if (phase === "write" && done !== undefined && total !== undefined) progress.push([done, total]); },
    });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    if (r.kind !== "flashed") throw new Error("not flashed");
    // The unit held the segments' templates, so most of the image is not written.
    expect(r.diffBytes).toBe(dev.written.length);
    expect(r.diffBytes).toBeGreaterThan(0);
    expect(r.diffBytes).toBeLessThan(r.imageBytes);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every(([d, t], i) => t === progress[0][1] && d <= t && (i === 0 || d > progress[i - 1][0]))).toBe(true);
    expect(progress.at(-1)![0]).toBe(progress[0][1]);
  });
});

corpusDescribe("the way back for a captured application's unit without its application is ETS", () => {
  test("the M-0008 full download is offered, but does not load the application; the MDT's does", () => {
    const gira = classify(parseAppConfig(catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz")));
    expect(gira.capabilities().fullDownload).toBe(true);
    expect(gira.fullDownloadLoadsApplication()).toBe(false);
    const mdt = classify(parseAppConfig(catalogueXml("M-0083_A-00B6-32-9642.xml.gz")));
    expect(mdt.fullDownloadLoadsApplication()).toBe(true);
  });
});

// The Auro presence detector (M-0081_A-FE01-11-75D9), whose full download ETS runs in its declared order
// (its ProductProcedure, no PreferPartialDownloadIfApplicationLoaded), run against the same emulation.
corpusDescribe("the declared-order M-0081_A-FE01-11-75D9 downloads, run against an emulated device", () => {
  const xml = catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const IA = "1.2.3";
  const base = { deviceId: "d", ia: IA, appXml: xml, params: new Map<string, string>(), dryRun: false, persistBackups: () => "backup" };
  // Object 0 is the one the defaults activate.
  const links: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x1107, 0x2a01] }];
  const auro = () => {
    const dev = new GiraDevice(cfg);
    dev.programId = Buffer.from("0081fe0111", "hex");
    dev.tableRef = new Map([[1, 0x4000], [2, 0x402f], [3, 0x405c]]);
    return dev;
  };

  test("full download: the declared steps in their declared order, the own address left to the device, verified after the restart", async () => {
    const dev = auro();
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x03);
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2", "unload:3",
      "load:1", "absSegment:1@16384+47", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16431+45", "write", "taskSegment:2@16431", "loadCompleted:2",
      "load:3", "absSegment:3@1792+250", "absSegment:3@16476+91", "write", "absSegment:3@16896+256", "write",
      "taskSegment:3@16567", "taskCtrl1:3=0000000000000000", "loadCompleted:3", "restart",
    ]);
    expect((await dev.memRead(0x4000, 7)).toString("hex")).toBe("03120311072a01");
    expect((await dev.memRead(0x402f, 5)).toString("hex")).toBe("0201000200");
  }, 70_000);

  test("a unit whose address table is not loaded takes the same download: ETS reads no load state before the declared procedure", async () => {
    const dev = auro();
    dev.state.set(1, STATE.UNLOADED);
    expect(await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links })).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops[0]).toBe("unload:1");
  }, 70_000);

  test("the dry run reports the digest of the image the offline plan builds", async () => {
    const dev = auro();
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links, dryRun: true });
    const offline = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: new Map(), links, proc });
    expect(r).toMatchObject({ kind: "dryRun", imageDigest: fullDownloadImageDigest(offline.segments) });
    expect(dev.ops).toEqual([]);
  });

  test("group-address flash: the tables unloaded and declared again, the own address left alone, the com-object table whole, verified", async () => {
    const dev = auro();
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x03);
    dev.ops = [];
    const more: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x1107, 0x2a01, 0x77c8] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2",
      "load:1", "absSegment:1@16384+47", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16431+45", "write", "taskSegment:2@16431", "loadCompleted:2",
      "load:3", "write", "loadCompleted:3", "restart",
    ]);
    expect((await dev.memRead(0x4000, 9)).toString("hex")).toBe("04120311072a0177c8");
    expect((await dev.memRead(0x402f, 7)).toString("hex")).toBe("03010002000300");
  }, 130_000);

  // The own individual address in the address table is the device's: it is neither written nor counted.
  test("group-address flash: a unit that differs only in the address table's own address is unchanged", async () => {
    const dev = auro();
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x09);
    dev.ops = [];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "unchanged" });
    expect(dev.ops).toEqual([]);
  }, 70_000);

  test("group-address flash: the change counted is the bytes of the planned runs that differ from the device", async () => {
    const dev = auro();
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x09);
    const more: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x1107, 0x2a01, 0x77c8] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map(), dryRun: true });
    // What changes: the address table's count and 77 c8 after 2/1/7 and 5/2/1, the association table's
    // count and (03,00); everything else the plan writes equals the unit, and the own address 12 09
    // (the project's is 12 03) is not counted.
    const want: [number, number][] = [[0x4000, 0x04], [0x4007, 0x77], [0x4008, 0xc8], [0x402f, 0x03], [0x4034, 0x03], [0x4035, 0x00]];
    const differing = want.filter(([a, b]) => (dev.mem.get(a) ?? 0) !== b).length;
    expect(differing).toBeGreaterThanOrEqual(2);
    expect(r).toMatchObject({ kind: "dryRun", diffBytes: differing });
  }, 70_000);

  test("group-address flash: a table reference the device does not hold at the declared address after the restart is not verified", async () => {
    const dev = auro();
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x03);
    dev.restart = async () => { dev.ops.push("restart"); dev.tableRef.set(2, 0x4030); };
    const more: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x1107, 0x2a01, 0x77c8] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: false });
    expect((await dev.memRead(0x402f, 7)).toString("hex")).toBe("03010002000300");
  }, 160_000);

  test("parameter flash: one bracket on the application, the changed byte, the restart", async () => {
    const dev = auro();
    const led = "M-0081_A-FE01-11-75D9_P-10_R-10";
    expect(cfg.params.has("M-0081_A-FE01-11-75D9_P-10")).toBe(true);
    const r = await classify(cfg).flashParameters(asDev(dev), cfg.mask, { ...base, params: new Map([[led, "0"]]), baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    expect(dev.mem.get(0x4207)).toBe(0);
  }, 70_000);

  // An LdCtrlTaskCtrl1 that one byte of Count and two of Address cannot carry, or one with attributes no
  // capture shows encoded, is refused, by the offer and by the planner.
  const forms: Record<string, string>[] = [{ LsmIdx: "3", Address: "70000", Count: "0" }, { LsmIdx: "3", Address: "0", Count: "256" }, { LsmIdx: "3", Address: "0", Count: "0", Extra: "1" }, { LsmIdx: "3" }];
  for (const attrs of forms) {
    test(`LdCtrlTaskCtrl1 ${JSON.stringify(attrs)} is refused`, () => {
      const changed: LoadProcedures = { ...proc, blocks: proc.blocks.map((b) => ({ ...b, steps: b.steps.map((s) => (s.verb === "LdCtrlTaskCtrl1" ? { ...s, attrs } : s)) })) };
      expect(absoluteFullStepRefusal(changed)).toMatchObject({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("LdCtrlTaskCtrl1") });
      expect(() => classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: new Map(), links, proc: changed })).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" }));
    });
  }
  test("the captured form is not refused", () => {
    expect(absoluteFullStepRefusal(proc)).toBeNull();
  });

  // Of a segment with a <Mask>, the declared-order downloads write the bytes the mask marks and the bytes a
  // parameter covers. A mask that does not say that byte by byte, or a parameter whose width is not
  // known, is refused rather than guessed at.
  describe("a masked segment whose written bytes cannot be told is refused", () => {
    const ADDR = "M-0081_A-FE01-11-75D9_AS-4000";
    const tables = { addr: Buffer.from("03120311072a01", "hex"), assoc: Buffer.from("0201000200", "hex") };
    const withMask = (mask: (m: Buffer) => Buffer): AppConfig => ({ ...cfg, absoluteSegments: cfg.absoluteSegments.map((s) => (s.id === ADDR ? { ...s, mask: mask(s.mask!) } : s)) });
    const plan = (app: AppConfig) => () => planSystem7GaFlash(app, proc, tables, null);
    test("the unmodified address table segment plans", () => {
      expect(cfg.absoluteSegments.find((s) => s.id === ADDR)?.mask?.length).toBe(47);
      expect(plan(cfg)).not.toThrow();
    });
    test("a mask shorter than its segment", () => {
      expect(plan(withMask((m) => m.subarray(0, m.length - 1)))).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("<Mask> of 46 bytes for 47") }));
    });
    test("a mask byte that marks single bits", () => {
      expect(plan(withMask((m) => { const b = Buffer.from(m); b[5] = 0x0f; return b; }))).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("marks single bits") }));
    });
    test("a mask that leaves out a table byte other than the own individual address", () => {
      expect(plan(withMask((m) => { const b = Buffer.from(m); b[4] = 0; return b; }))).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("leaves out byte 4") }));
    });
    test("a parameter in the segment whose type has no known width", () => {
      const some = [...cfg.params.values()].find((p) => p.offset !== undefined)!;
      const odd = { ...some, id: "M-0081_A-FE01-11-75D9_P-99999", codeSegment: ADDR, offset: 20, typeId: "M-0081_A-FE01-11-75D9_PT-NoSuchType" };
      const app: AppConfig = { ...cfg, params: new Map([...cfg.params, [odd.id, odd]]) };
      expect(plan(app)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("no known width") }));
    });
  });
});

corpusDescribe("the declared-order M-0048_A-107E-12-5B58 (TheLuxa P300) full download, run against an emulated device", () => {
  const xml = catalogueXml("M-0048_A-107E-12-5B58.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const IA = "1.2.4";
  const base = { deviceId: "d", ia: IA, appXml: xml, params: new Map<string, string>(), dryRun: false, persistBackups: () => "backup" };
  const links: ComObjectLink[] = [{ comObjNum: 6, gaRaws: [0x1109, 0x77c8, 0x77c9] }];
  const COM = "M-0048_A-107E-12-5B58_AS-43FC";
  const theLuxa = () => {
    const dev = new GiraDevice(cfg);
    dev.programId = Buffer.from("0048107e12", "hex");
    dev.tableRef = new Map([[1, 0x4000], [2, 0x4009], [3, 0x43fc]]);
    return dev;
  };

  test("full download: the tables re-declared as one region, TaskCtrl1 as captured, each table's reference checked after the restart", async () => {
    const dev = theLuxa();
    dev.tableRef.set(2, 0x4100);
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2", "unload:3",
      "load:1", "absSegment:1@16384+9", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16393+1011", "write", "taskSegment:2@16393", "loadCompleted:2",
      "load:3", "absSegment:3@1792+248", "absSegment:3@17404+500", "write", "absSegment:3@18432+576", "write",
      "taskSegment:3@17894", "taskCtrl1:3=45d3010000000000", "loadCompleted:3", "restart",
    ]);
    expect([dev.tableRef.get(1), dev.tableRef.get(2)]).toEqual([0x4000, 0x4009]);
  }, 70_000);

  test("full download: a table reference the device does not hold at the re-declared address after the restart is not verified", async () => {
    const dev = theLuxa();
    dev.restart = async () => { dev.ops.push("restart"); dev.tableRef.set(2, 0x41ff); };
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    expect(r).toMatchObject({ kind: "flashed", verified: false });
  }, 100_000);

  const plan = (app: AppConfig, p: LoadProcedures = proc) => () => classify(app).planFullDownload(app.mask, { ia: IA, params: new Map(), links, proc: p });
  test("the application as declared plans", () => {
    expect(plan(cfg)).not.toThrow();
  });
  // The com-object table segment is written whole as a segment loaded afresh; what the table refusals
  // guard still holds for it.
  test("a parameter whose memory lies in the com-object table segment is refused", () => {
    const some = [...cfg.params.values()].find((p) => p.offset !== undefined)!;
    for (const offset of [20, 480]) {
      const odd = { ...some, id: "M-0048_A-107E-12-5B58_P-99999", codeSegment: COM, offset, bitOffset: 0 };
      const app: AppConfig = { ...cfg, params: new Map([...cfg.params, [odd.id, odd]]) };
      expect(plan(app)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("lies in the com-object table segment") }));
    }
  });
  test("a <Mask> that leaves out a byte of the com-object table is refused", () => {
    expect(cfg.absoluteSegments.find((s) => s.id === COM)!.mask).toBeUndefined();
    const app: AppConfig = { ...cfg, absoluteSegments: cfg.absoluteSegments.map((s) => (s.id === COM ? { ...s, mask: Buffer.alloc(s.size, 0xff).fill(0, 10, 11) } : s)) };
    expect(plan(app)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_SEGMENT_UNKNOWN", message: expect.stringContaining("leaves out byte 10") }));
  });
  // An LdCtrlTaskCtrl1 the control cannot carry is refused on this application as on every other.
  const forms: Record<string, string>[] = [{ LsmIdx: "3", Address: "17875", Count: "300" }, { LsmIdx: "0", Address: "17875", Count: "1" }, { LsmIdx: "3", Address: "-1", Count: "1" }];
  for (const attrs of forms) {
    test(`LdCtrlTaskCtrl1 ${JSON.stringify(attrs)} is refused`, () => {
      const changed: LoadProcedures = { ...proc, blocks: proc.blocks.map((b) => ({ ...b, steps: b.steps.map((s) => (s.verb === "LdCtrlTaskCtrl1" ? { ...s, attrs } : s)) })) };
      expect(absoluteFullStepRefusal(changed)).toMatchObject({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("LdCtrlTaskCtrl1") });
      expect(plan(cfg, changed)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" }));
    });
  }
});

// The update bit (config 0x80) of the MV-0705 com-object table follows each configured object's update
// flag, as ETS writes it (TheLuxa P300, Meteodata 140 S and MDT BE-06001.02 captures); an unconfigured
// entry is the template's minus the linked bit. Built through the structural flash's path, with each
// application's default configuration.
corpusDescribe("the update bit of the MV-0705 com-object table is the configured object's update flag", () => {
  let updating = 0;
  for (const file of listCatalogue()) {
    const cfg = parseAppConfig(catalogueXml(file));
    if (cfg.mask !== "MV-0705" || cfg.groupTables.comObjectSegment === undefined) continue;
    test(`${file}: 0x80 on a configured object exactly where it declares the update flag`, () => {
      const active = buildDeviceConfig(cfg, new Map()).imageComObjects;
      const seg = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.comObjectSegment)!;
      const table = absoluteStructuralImages(cfg, new Map(), [], 0x110a, { baseValues: new Map(), comObjectTable: { active, linked: new Set() } })
        .find((i) => i.id === seg.id)!.image;
      for (let n = 0; n < seg.data[0]; n++) {
        const at = 3 + n * 4 + 2, o = active.get(n);
        if (!o) expect(table[at]).toBe(seg.data[at] & ~0x04);
        else expect(table[at] & 0x80).toBe(o.flags.update ? 0x80 : 0);
        if (o?.flags.update) updating++;
      }
      if (cfg.id === "M-0048_A-107E-12-5B58") expect(table[3 + 116 * 4 + 2]).toBe(0xcb);
    });
  }
  test("configured objects with the update flag exist, so the rule is exercised", () => {
    expect(updating).toBeGreaterThan(0);
  });
});
