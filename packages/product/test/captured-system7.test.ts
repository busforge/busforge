import { test, expect } from "bun:test";
import { STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, parseLoadProcedures, buildGroupTablesMv0705, System7Profile, ETS_CAPTURED_SYSTEM7_APPS, fullDownloadImageDigest, type AppConfig, type ComObjectLink } from "../src/index.ts";
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

// Everything outside ETS_CAPTURED_SYSTEM7_APPS keeps the System 7 download it had before the captured
// applications: segment and task declarations to the memory control 0x0104 (no `viaProperty`), and the
// associations by object then group index. The MDT BE-02001.02 full download is hardware-proven so.
corpusDescribe("System 7 applications ETS is not captured on keep their download", () => {
  const multi: ComObjectLink[] = [{ comObjNum: 2, gaRaws: [0x0903, 0x0901] }, { comObjNum: 0, gaRaws: [0x0905, 0x0902, 0x0904] }, { comObjNum: 1, gaRaws: [0x0900] }];
  test("no declaration in their full-download plans is a property write", () => {
    let planned = 0;
    for (const f of listCatalogue()) {
      const xml = catalogueXml(f);
      const cfg = parseAppConfig(xml);
      if (!(classify(cfg) instanceof System7Profile) || ETS_CAPTURED_SYSTEM7_APPS.includes(cfg.id)) continue;
      let plan;
      try { plan = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.250", params: new Map(), links: [], proc: parseLoadProcedures(xml) }).plan; } catch { continue; }
      planned++;
      expect(plan.filter((s) => (s.op === "absSegment" || s.op === "taskSegment") && "viaProperty" in s)).toEqual([]);
    }
    expect(planned).toBeGreaterThanOrEqual(2); // the MDT BE-02001.02 and the ABB US/U 4.2 at least
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
