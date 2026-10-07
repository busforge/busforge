import { test, expect, describe } from "bun:test";
import { STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, parseLoadProcedures, buildDeviceConfig, absoluteStructuralImages, etsUpdateBitMv0705, buildGroupTablesMv0705, System7Profile, ETS_CAPTURED_SYSTEM7_APPS, ETS_DECLARED_ORDER_SYSTEM7_APPS, absoluteFullStepRefusal, fullDownloadImageDigest, planDeclaredOrderSystem7GaFlash, type AppConfig, type ComObjectLink, type LoadProcedures } from "../src/index.ts";
import { catalogueXml, listCatalogue } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

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
  async propReadCounted(obj: number, pid: number, start: number) {
    this.ops.push(`read ${obj}/${pid}#${start}`);
    return { objectIndex: obj, pid, count: 1, start, value: Buffer.from("000001d300f2d021", "hex") };
  }
}
const asDev = (d: GiraDevice) => d as unknown as KnxDevice;
const STAMPS = ["read 1/27#1", "read 2/27#1", ...[1, 2, 3, 4, 5, 6].map((i) => `read 3/27#${i}`)];

corpusDescribe("the captured M-0008 downloads, run against an emulated device", () => {
  const xml = catalogueXml("M-0008_A-10D7-11-2783-O000A.xml.gz");
  const cfg = parseAppConfig(xml);
  const IA = "1.1.1";
  const base = { deviceId: "d", ia: IA, appXml: xml, params: new Map<string, string>(), dryRun: false, persistBackups: () => "backup" };
  const twoObjects: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x0012, 0x1800] }, { comObjNum: 2, gaRaws: [0x0013, 0x1800] }];

  test("full download: ETS's sequence, the tables placed one behind the other, verified after the restart", async () => {
    const dev = new GiraDevice(cfg);
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    // address table: count 3 (own address + 2), 1.1.1, 0/0/18, 0/0/19, 3/0/0 -> 9 bytes at 0x4000
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2",
      "load:1", "absSegment:1@16384+9", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16393+475", "write", "taskSegment:2@16393", "loadCompleted:2",
      "load:3", "write", "loadCompleted:3", ...STAMPS, "restart",
    ]);
    // the association table, first links first: (1,0) (2,2), then 3/0/0 = index 3 on both: (3,0) (3,2)
    expect((await dev.memRead(0x4009, 9)).toString("hex")).toBe("040100020203000302");
    expect(dev.tableRef.get(2)).toBe(0x4009);
  }, 20_000);

  test("full download: a table reference the device does not hold at the re-declared address after the restart is not verified", async () => {
    const dev = new GiraDevice(cfg);
    dev.restart = async () => { dev.ops.push("restart"); dev.tableRef.set(2, 0x4011); };
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    expect(r).toMatchObject({ kind: "flashed", verified: false });
    expect((await dev.memRead(0x4009, 9)).toString("hex")).toBe("040100020203000302");
  }, 20_000);

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
    const offline = classify(cfg).planFullDownload(cfg.mask, { ia: IA, params: new Map(), links: twoObjects, proc: parseLoadProcedures(xml) });
    expect(r).toMatchObject({ kind: "dryRun", imageDigest: fullDownloadImageDigest(offline.segments) });
    expect(dev.ops).toEqual([]);
  });

  test("a unit whose address table is not loaded is refused, untouched, though it holds the application", async () => {
    const dev = new GiraDevice(cfg);
    dev.state.set(1, STATE.UNLOADED);
    expect(await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects }).catch((e: unknown) => e))
      .toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED", message: expect.stringContaining("load-state machine 1 ") });
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
    const more = [...twoObjects, { comObjNum: 4, gaRaws: [0x7ffa] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2",
      "load:1", "absSegment:1@16384+11", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16395+473", "write", "taskSegment:2@16395", "loadCompleted:2",
      "load:3", "write", "loadCompleted:3", ...STAMPS, "restart",
    ]);
    expect(dev.tableRef.get(2)).toBe(0x400b);
  }, 20_000);

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
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: [...twoObjects, { comObjNum: 4, gaRaws: [0x7ffa] }], baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(written.filter((a) => marked.includes(a))).toEqual([]);
    expect(marked.map((a) => dev.mem.get(a))).toEqual(marked.map(() => 0xa5));
  }, 20_000);

  test("group-address flash: a unit that differs only in the address table's own address is unchanged", async () => {
    const dev = new GiraDevice(cfg);
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    dev.mem.set(0x4001, 0x11).set(0x4002, 0x05);
    dev.ops = [];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "unchanged" });
    expect(dev.ops).toEqual([]);
  }, 20_000);

  // Equal table bytes are not enough: the device reads its association table from where object 2's
  // reference points, so a table that stands elsewhere is counted as a change and written.
  test("group-address flash: tables whose reference is not at the re-declared address are not unchanged", async () => {
    const dev = new GiraDevice(cfg);
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links: twoObjects });
    // The unit holds its own address in the address table, as a real one does (the download leaves it).
    dev.mem.set(0x4001, 0x11).set(0x4002, 0x01);
    const at = dev.tableRef.get(2)!;
    dev.tableRef.set(2, at + 2);
    for (let i = 20; i >= 0; i--) dev.mem.set(at + 2 + i, dev.mem.get(at + i) ?? 0);
    const dry = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), dryRun: true });
    expect(dry).toMatchObject({ kind: "dryRun" });
    expect((dry as { diffBytes: number }).diffBytes).toBeGreaterThan(0);
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect([dev.tableRef.get(1), dev.tableRef.get(2)]).toEqual([0x4000, at]);
  }, 20_000);

  test("group-address flash: a communication flag the project sets against the links is refused before any write", async () => {
    const dev = new GiraDevice(cfg);
    const off = new Map([[0, { flags: { comm: false } }]]);
    expect(await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: twoObjects, baseParams: new Map(), comObjectOverrides: off }).catch((e: unknown) => e))
      .toMatchObject({ code: "COM_OBJECT_OVERRIDE_UNWRITABLE" });
    expect(dev.ops).toEqual([]);
  });

  test("parameter flash: one bracket on the application, the stamps, the restart", async () => {
    const dev = new GiraDevice(cfg);
    const ref = "M-0008_A-10D7-11-2783-O000A_P-3764_R-3764";
    expect(cfg.params.has("M-0008_A-10D7-11-2783-O000A_P-3764")).toBe(true);
    const r = await classify(cfg).flashParameters(asDev(dev), cfg.mask, { ...base, params: new Map([[ref, "40"]]), baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual(["load:3", "write", "loadCompleted:3", ...STAMPS, "restart"]);
    expect(dev.mem.get(0x435c + 3)).toBe(40);
  }, 20_000);
});

// Everything outside ETS_CAPTURED_SYSTEM7_APPS and ETS_DECLARED_ORDER_SYSTEM7_APPS keeps the System 7
// download it had before the captured applications: segment and task declarations to the memory control
// 0x0104 (no `viaProperty`), no LdCtrlTaskCtrl1, every written segment whole from its start (no <Mask>
// read), and the associations by object then group index. The MDT BE-02001.02 full download is
// hardware-proven so.
corpusDescribe("System 7 applications ETS is not captured on keep their download", () => {
  const multi: ComObjectLink[] = [{ comObjNum: 2, gaRaws: [0x0903, 0x0901] }, { comObjNum: 0, gaRaws: [0x0905, 0x0902, 0x0904] }, { comObjNum: 1, gaRaws: [0x0900] }];
  const captured = (id: string) => ETS_CAPTURED_SYSTEM7_APPS.includes(id) || ETS_DECLARED_ORDER_SYSTEM7_APPS.includes(id);
  test("no declaration in their full-download plans is a property write, none is a TaskCtrl1, every segment is written whole", () => {
    let planned = 0;
    for (const f of listCatalogue()) {
      const xml = catalogueXml(f);
      const cfg = parseAppConfig(xml);
      if (!(classify(cfg) instanceof System7Profile) || captured(cfg.id)) continue;
      let plan;
      try { plan = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }).plan; } catch { continue; }
      planned++;
      expect(plan.filter((s) => (s.op === "absSegment" || s.op === "taskSegment") && "viaProperty" in s)).toEqual([]);
      expect(plan.filter((s) => s.op === "taskCtrl1")).toEqual([]);
      const starts = new Set(cfg.absoluteSegments.map((s) => s.address));
      expect(plan.flatMap((s) => (s.op === "writeMem" && !starts.has(s.address) ? [s.address] : []))).toEqual([]);
    }
    expect(planned).toBeGreaterThanOrEqual(2); // the MDT BE-02001.02 and the ABB US/U 4.2 at least
  });
  test("an LdCtrlTaskCtrl1 is refused on every application outside the declared-order registry, in any form", () => {
    let seen = 0;
    for (const f of listCatalogue()) {
      const xml = catalogueXml(f);
      const proc = parseLoadProcedures(xml);
      if (captured(proc.app ?? "") || !proc.verbs.includes("LdCtrlTaskCtrl1")) continue;
      seen++;
      expect(absoluteFullStepRefusal(proc)).toMatchObject({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" });
    }
    expect(seen).toBeGreaterThanOrEqual(3); // M-0048_A-140C, M-0081_A-FF31, M-008E_A-7079
  });
  test("their associations are ordered by object, then group index", () => {
    const { assoc } = buildGroupTablesMv0705(multi, 0x11fa);
    // group indices: 0x0900=1 0x0901=2 0x0902=3 0x0903=4 0x0904=5 0x0905=6
    expect(assoc.toString("hex")).toEqual("06" + "0300" + "0500" + "0600" + "0101" + "0202" + "0402");
    expect(buildGroupTablesMv0705(multi, 0x11fa, { order: "ets-captured" }).assoc.toString("hex")).toEqual("06" + "0600" + "0101" + "0402" + "0300" + "0500" + "0202");
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
// (loadproc.ts ETS_DECLARED_ORDER_SYSTEM7_APPS), run against the same emulation.
corpusDescribe("the declared-order M-0081_A-FE01-11-75D9 downloads, run against an emulated device", () => {
  const xml = catalogueXml("M-0081_A-FE01-11-75D9.xml.gz");
  const cfg = parseAppConfig(xml);
  const proc = parseLoadProcedures(xml);
  const IA = "1.2.18";
  const base = { deviceId: "d", ia: IA, appXml: xml, params: new Map<string, string>(), dryRun: false, persistBackups: () => "backup" };
  // Object 0 is the one the defaults activate.
  const links: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x050a, 0x1807] }];
  const auro = () => {
    const dev = new GiraDevice(cfg);
    dev.programId = Buffer.from("0081fe0111", "hex");
    dev.tableRef = new Map([[1, 0x4000], [2, 0x402f], [3, 0x405c]]);
    return dev;
  };

  test("full download: the declared steps in their declared order, the own address left to the device, verified after the restart", async () => {
    const dev = auro();
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x12);
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2", "unload:3",
      "load:1", "absSegment:1@16384+47", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16431+45", "write", "taskSegment:2@16431", "loadCompleted:2",
      "load:3", "absSegment:3@1792+250", "absSegment:3@16476+91", "write", "absSegment:3@16896+256", "write",
      "taskSegment:3@16567", "taskCtrl1:3=0000000000000000", "loadCompleted:3", "restart",
    ]);
    expect((await dev.memRead(0x4000, 7)).toString("hex")).toBe("031212050a1807");
    expect((await dev.memRead(0x402f, 5)).toString("hex")).toBe("0201000200");
  }, 20_000);

  test("a unit whose address table is not loaded is refused, untouched, though it holds the application", async () => {
    const dev = auro();
    dev.state.set(1, STATE.UNLOADED);
    expect(await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links }).catch((e: unknown) => e))
      .toMatchObject({ code: "FULL_DOWNLOAD_APPLICATION_NOT_LOADED", message: expect.stringContaining("load-state machine 1 ") });
    expect(dev.ops).toEqual([]);
  });

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
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x12);
    dev.ops = [];
    const more: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x050a, 0x1807, 0x7ffa] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual([
      "unload:1", "unload:2",
      "load:1", "absSegment:1@16384+47", "write", "taskSegment:1@16384", "loadCompleted:1",
      "load:2", "absSegment:2@16431+45", "write", "taskSegment:2@16431", "loadCompleted:2",
      "load:3", "write", "loadCompleted:3", "restart",
    ]);
    expect((await dev.memRead(0x4000, 9)).toString("hex")).toBe("041212050a18077ffa");
    expect((await dev.memRead(0x402f, 7)).toString("hex")).toBe("03010002000300");
  }, 20_000);

  // The own individual address in the address table is the device's: it is neither written nor counted.
  test("group-address flash: a unit that differs only in the address table's own address is unchanged", async () => {
    const dev = auro();
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    dev.mem.set(0x4001, 0x11).set(0x4002, 0x05);
    dev.ops = [];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "unchanged" });
    expect(dev.ops).toEqual([]);
  }, 20_000);

  test("group-address flash: the change counted is the bytes of the planned runs that differ from the device", async () => {
    const dev = auro();
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    dev.mem.set(0x4001, 0x11).set(0x4002, 0x05);
    const more: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x050a, 0x1807, 0x7ffa] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map(), dryRun: true });
    // What changes: the address table's count and 7f fa after the two linked addresses, the association table's
    // count and (03,00); everything else the plan writes equals the unit, and the own address 11 05
    // (the project's is 12 12) is not counted.
    const want: [number, number][] = [[0x4000, 0x04], [0x4007, 0x7f], [0x4008, 0xfa], [0x402f, 0x03], [0x4034, 0x03], [0x4035, 0x00]];
    const differing = want.filter(([a, b]) => (dev.mem.get(a) ?? 0) !== b).length;
    expect(differing).toBeGreaterThanOrEqual(2);
    expect(r).toMatchObject({ kind: "dryRun", diffBytes: differing });
  }, 20_000);

  test("group-address flash: a table reference the device does not hold at the declared address after the restart is not verified", async () => {
    const dev = auro();
    await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    dev.mem.set(0x4001, 0x12).set(0x4002, 0x12);
    dev.restart = async () => { dev.ops.push("restart"); dev.tableRef.set(2, 0x4030); };
    const more: ComObjectLink[] = [{ comObjNum: 0, gaRaws: [0x050a, 0x1807, 0x7ffa] }];
    const r = await classify(cfg).flashGroupTables(asDev(dev), cfg.mask, { ...base, links: more, baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: false });
    expect((await dev.memRead(0x402f, 7)).toString("hex")).toBe("03010002000300");
  }, 20_000);

  test("parameter flash: one bracket on the application, the changed byte, the restart", async () => {
    const dev = auro();
    const led = "M-0081_A-FE01-11-75D9_P-10_R-10";
    expect(cfg.params.has("M-0081_A-FE01-11-75D9_P-10")).toBe(true);
    const r = await classify(cfg).flashParameters(asDev(dev), cfg.mask, { ...base, params: new Map([[led, "0"]]), baseParams: new Map() });
    expect(r).toMatchObject({ kind: "flashed", verified: true });
    expect(dev.ops.slice(0, dev.ops.indexOf("restart") + 1)).toEqual(["load:3", "write", "loadCompleted:3", "restart"]);
    expect(dev.mem.get(0x4207)).toBe(0);
  }, 20_000);

  // Only LdCtrlTaskCtrl1 LsmIdx 3 Address 0 Count 0 is captured; any other form of it is refused, by the
  // offer and by the planner.
  const forms: Record<string, string>[] = [{ LsmIdx: "3", Address: "1", Count: "0" }, { LsmIdx: "3", Address: "0", Count: "2" }, { LsmIdx: "2", Address: "0", Count: "0" }, { LsmIdx: "3" }];
  for (const attrs of forms) {
    test(`LdCtrlTaskCtrl1 ${JSON.stringify(attrs)} is refused`, () => {
      const changed: LoadProcedures = { ...proc, blocks: proc.blocks.map((b) => ({ ...b, steps: b.steps.map((s) => (s.verb === "LdCtrlTaskCtrl1" ? { ...s, attrs } : s)) })) };
      expect(absoluteFullStepRefusal(changed)).toMatchObject({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("only LsmIdx 3 with Address 0 and Count 0") });
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
    const tables = { addr: Buffer.from("031212050a1807", "hex"), assoc: Buffer.from("0201000200", "hex") };
    const withMask = (mask: (m: Buffer) => Buffer): AppConfig => ({ ...cfg, absoluteSegments: cfg.absoluteSegments.map((s) => (s.id === ADDR ? { ...s, mask: mask(s.mask!) } : s)) });
    const plan = (app: AppConfig) => () => planDeclaredOrderSystem7GaFlash(app, proc, tables, null);
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
  const IA = "1.2.10";
  const base = { deviceId: "d", ia: IA, appXml: xml, params: new Map<string, string>(), dryRun: false, persistBackups: () => "backup" };
  const links: ComObjectLink[] = [{ comObjNum: 6, gaRaws: [0x0014, 0x1800, 0x1801] }];
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
  }, 20_000);

  test("full download: a table reference the device does not hold at the re-declared address after the restart is not verified", async () => {
    const dev = theLuxa();
    dev.restart = async () => { dev.ops.push("restart"); dev.tableRef.set(2, 0x41ff); };
    const r = await classify(cfg).downloadFull(asDev(dev), cfg.mask, { ...base, links });
    expect(r).toMatchObject({ kind: "flashed", verified: false });
  }, 20_000);

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
  // Only LdCtrlTaskCtrl1 LsmIdx 3 Address 17875 Count 1 is captured on this application.
  const forms: Record<string, string>[] = [{ LsmIdx: "3", Address: "0", Count: "0" }, { LsmIdx: "3", Address: "17875", Count: "2" }, { LsmIdx: "2", Address: "17875", Count: "1" }, { LsmIdx: "3", Address: "17876", Count: "1" }];
  for (const attrs of forms) {
    test(`LdCtrlTaskCtrl1 ${JSON.stringify(attrs)} is refused`, () => {
      const changed: LoadProcedures = { ...proc, blocks: proc.blocks.map((b) => ({ ...b, steps: b.steps.map((s) => (s.verb === "LdCtrlTaskCtrl1" ? { ...s, attrs } : s)) })) };
      expect(absoluteFullStepRefusal(changed)).toMatchObject({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: expect.stringContaining("only LsmIdx 3 with Address 17875 and Count 1") });
      expect(plan(cfg, changed)).toThrow(expect.objectContaining({ code: "FULL_DOWNLOAD_STEP_UNSUPPORTED" }));
    });
  }
});

// The update bit (config 0x80) of the MV-0705 com-object table is taken from one capture, the TheLuxa
// P300's object 116 (comobjbuild.ts ETS_UPDATE_BIT_MV0705_APPS). Every other MV-0705 application keeps
// the table it got before: a configured object's config byte without 0x80 whatever its update flag,
// an unconfigured entry the template's minus the linked bit. Built through the structural flash's
// path, with each application's default configuration.
corpusDescribe("the update bit of the MV-0705 com-object table is set for the TheLuxa P300 only", () => {
  let otherUpdating = 0;
  for (const file of listCatalogue()) {
    const cfg = parseAppConfig(catalogueXml(file));
    if (cfg.mask !== "MV-0705" || cfg.groupTables.comObjectSegment === undefined) continue;
    test(`${file}: 0x80 on a configured object only where ETS is captured writing it`, () => {
      const active = buildDeviceConfig(cfg, new Map()).imageComObjects;
      const seg = cfg.absoluteSegments.find((s) => s.id === cfg.groupTables.comObjectSegment)!;
      const table = absoluteStructuralImages(cfg, new Map(), [], 0x120a, { baseValues: new Map(), comObjectTable: { active, linked: new Set() } })
        .find((i) => i.id === seg.id)!.image;
      const theLuxa = cfg.id === "M-0048_A-107E-12-5B58";
      expect(etsUpdateBitMv0705(cfg.id)).toBe(theLuxa);
      for (let n = 0; n < seg.data[0]; n++) {
        const at = 3 + n * 4 + 2, o = active.get(n);
        if (!o) expect(table[at]).toBe(seg.data[at] & ~0x04);
        else expect(table[at] & 0x80).toBe(theLuxa && o.flags.update ? 0x80 : 0);
        if (o?.flags.update && !theLuxa) otherUpdating++;
      }
      if (theLuxa) expect(table[3 + 116 * 4 + 2]).toBe(0xcb);
    });
  }
  test("another application has configured objects with the update flag, so the rule is exercised", () => {
    expect(otherUpdating).toBeGreaterThan(0);
  });
});
