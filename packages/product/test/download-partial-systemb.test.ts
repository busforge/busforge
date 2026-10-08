import { test, expect } from "bun:test";
import { LSM, STATE, type KnxDevice } from "@busforge/knx";
import {
  parseAppConfig, classify, buildDeviceConfig, buildComObjectTable, buildRelativeSegmentTarget, buildGroupTables, programIdStamp, declaredPropChecks, type ComObjectLink,
} from "@busforge/product";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The System B partial form of the full download on a mock unit, with the Theben DALI-Gateway's application
// (PreferPartialDownloadIfApplicationLoaded, not secured). The subject is the device path: when the form is
// taken (application and tables LOADED, this program id, the segment at this application's size), what it
// writes (R16: the application's control-0 region only where it differs, the com-object table whole where its
// region's control byte is 1, the group tables whole), and that its verify catches a byte the unit lost.
corpusDescribe("System B full download on a unit holding the application (mock unit, Theben DALI-Gateway)", () => {
  const xml = catalogueXml("M-0048_A-9071-20-F258-O00EF.xml.gz");
  const cfg = parseAppConfig(xml);
  const OBJ = { ADDR: 1, ASSOC: 2, COMOBJ: 3, APP: 4, PEI: 5 } as const;
  const PID_LSM = 5, PID_PROGRAM_ID = 13, PID_MCB = 27;
  const AT = { [OBJ.ADDR]: 0x1000, [OBJ.ASSOC]: 0x2000, [OBJ.COMOBJ]: 0x4000, [OBJ.APP]: 0x5000 } as Record<number, number>;

  const images = (params: Map<string, string>, links: ComObjectLink[]) => {
    const view = buildDeviceConfig(cfg, params);
    const target = buildRelativeSegmentTarget(cfg, params, 4, { ownIdleUnionDefaults: true })!;
    return { target, comObj: buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set(links.map((l) => l.comObjNum))), ...buildGroupTables(links) };
  };
  const base = images(new Map(), []);
  const mcbEntry = (size: number, control: number) => { const b = Buffer.alloc(8); b.writeUInt32BE(size, 0); b[4] = control; b[5] = 0x33; return b; };

  interface UnitOpts { programId?: Buffer; states?: Partial<Record<number, number>>; appMcb?: Buffer[]; comObjControl?: number; onRestart?: (mem: Map<number, number>) => void }
  class MockUnit {
    mem = new Map<number, number>();
    state = new Map<number, number>();
    events: string[] = [];
    writes: number[] = []; // every memory address written
    constructor(readonly o: UnitOpts = {}) {
      const put = (at: number, b: Buffer) => b.forEach((x, i) => this.mem.set(at + i, x));
      put(AT[OBJ.APP], base.target.bytes);
      put(AT[OBJ.COMOBJ], base.comObj);
      put(AT[OBJ.ASSOC], base.assoc);
      put(AT[OBJ.ADDR], base.addr);
      for (const obj of [OBJ.ADDR, OBJ.ASSOC, OBJ.COMOBJ, OBJ.APP]) this.state.set(obj, o.states?.[obj] ?? STATE.LOADED);
    }
    async connect() {}
    async disconnect() {}
    async restart() { this.events.push("restart"); this.o.onRestart?.(this.mem); }
    async setVerifyMode() {}
    async deviceDescriptor() { return "MV-07B0"; }
    async tableAddr(obj: number) { return AT[obj] ?? 0; }
    async writesConfirmed() { return false; }
    async propValueDataMax() { return 10; }
    async propReadCounted(obj: number, pid: number, start: number, count = 1) { return { objectIndex: obj, pid, count, start, value: Buffer.alloc(8 * count) }; }
    async memRead(addr: number, len: number) { return Buffer.from(Array.from({ length: len }, (_, i) => this.mem.get(addr + i) ?? 0xff)); }
    async memWrite(addr: number, data: Buffer, opts: { verify?: boolean } = {}) {
      data.forEach((b, i) => { this.mem.set(addr + i, b); this.writes.push(addr + i); });
      if (opts.verify && !(await this.memRead(addr, data.length)).equals(data)) throw new Error("verify mismatch");
    }
    async propRead(obj: number, pid: number, start = 1) {
      const check = declaredPropChecks(cfg.loadProcedures, "full").find((c) => c.obj === obj && c.pid === pid);
      if (check) return check.expect; // the hardware type the application declares, as the unit reports it
      if (pid === PID_LSM) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]);
      if (pid === PID_PROGRAM_ID && obj === OBJ.APP) return this.o.programId ?? programIdStamp(cfg);
      if (pid === PID_MCB && obj === OBJ.APP) return (this.o.appMcb ?? [mcbEntry(base.target.size, 0)])[start - 1] ?? Buffer.alloc(0);
      if (pid === PID_MCB && obj === OBJ.COMOBJ) return start === 1 ? mcbEntry(base.comObj.length, this.o.comObjControl ?? 1) : Buffer.alloc(0);
      return Buffer.alloc(0);
    }
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === PID_LSM) {
        const ev = data[0];
        if (ev === LSM.LOAD) { this.state.set(obj, STATE.LOADING); this.events.push(`load:${obj}`); }
        else if (ev === LSM.LOAD_COMPLETED) { this.state.set(obj, STATE.LOADED); this.events.push(`loadCompleted:${obj}`); }
        else if (ev === LSM.UNLOAD) { this.state.set(obj, STATE.UNLOADED); this.events.push(`unload:${obj}`); }
        else if (data[0] === 0x03 && data[1] === 0x0b) this.events.push(`alloc:${obj}${data[6] ? " filled" : ""}`);
        return Buffer.alloc(0);
      }
      if (pid === PID_PROGRAM_ID) this.events.push(`programId:${obj}`);
      return data;
    }
  }
  const asDev = (m: MockUnit) => m as unknown as KnxDevice;
  const ctxFor = (params = new Map<string, string>(), links: ComObjectLink[] = []) => ({
    deviceId: "d", ia: "1.2.55", appXml: xml, params, links, moduleInstances: [], dryRun: false, backupBeforeUnload: false,
    persistBackups: () => "backup",
  });
  const run = async (unit: MockUnit, params?: Map<string, string>, links?: ComObjectLink[]) => {
    const res = await classify(cfg).downloadFull(asDev(unit), cfg.mask, ctxFor(params, links));
    if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
    return res;
  };
  const inRange = (obj: number, len: number) => (a: number) => a >= AT[obj] && a < AT[obj] + len;

  test("fixture: the application declares PreferPartialDownloadIfApplicationLoaded and is not secured", () => {
    expect(cfg.loadProcedures.preferPartialIfLoaded).toBe(true);
    expect(cfg.loadProcedures.secureEnabled).toBe(false);
  });

  test("project unchanged: the application is not reloaded, the com-object table (control 1) and the group tables go whole, no PEI unload", async () => {
    const unit = new MockUnit();
    const res = await run(unit);
    expect(res.verified).toBe(true);
    expect(unit.events.filter((e) => e !== "restart")).toEqual([
      "unload:3", "unload:2", "unload:1", "load:3", "alloc:3", "load:1", "alloc:1", "load:2", "alloc:2",
      "loadCompleted:3", "loadCompleted:2", "loadCompleted:1",
    ]);
    expect(unit.writes.filter(inRange(OBJ.APP, base.target.size))).toEqual([]);
    expect(unit.writes.filter(inRange(OBJ.COMOBJ, base.comObj.length)).length).toBe(base.comObj.length);
  }, 30_000);

  test("a com-object table reporting control 0 and unchanged is not reloaded at all", async () => {
    const unit = new MockUnit({ comObjControl: 0 });
    expect((await run(unit)).verified).toBe(true);
    expect(unit.events.some((e) => e.endsWith(":3"))).toBe(false);
  }, 30_000);

  test("a parameter change: the application reloaded, only its changed bytes written, the program id stamped", async () => {
    // A parameter whose value changes the image: the first owned, verified byte's parameter, found by trying.
    const want = (p: Map<string, string>) => buildRelativeSegmentTarget(cfg, p, 4, { ownIdleUnionDefaults: true })!.bytes;
    let params: Map<string, string> | undefined;
    for (const ref of cfg.refs.keys()) {
      for (const v of ["1", "2", "0"]) {
        const p = new Map([[ref, v]]);
        try { if (!want(p).equals(base.target.bytes)) { params = p; break; } } catch { /* not placeable */ }
      }
      if (params) break;
    }
    expect(params).toBeDefined();
    const changed = [...want(params!)].map((b, i) => (b !== base.target.bytes[i] ? AT[OBJ.APP] + i : -1)).filter((a) => a >= 0);
    const unit = new MockUnit();
    expect((await run(unit, params)).verified).toBe(true);
    expect(unit.events.slice(0, 2)).toEqual(["unload:4", "unload:3"]);
    expect(unit.events).toContain("programId:4");
    expect(unit.writes.filter(inRange(OBJ.APP, base.target.size)).sort((a, b) => a - b)).toEqual(changed);
  }, 30_000);

  test("the full form where the unit does not hold the application as the partial form needs it", async () => {
    const cases: UnitOpts[] = [
      { programId: Buffer.from("0048907199", "hex") },              // another program id
      { states: { [OBJ.ASSOC]: STATE.ERROR } },                      // a table not loaded
      { states: { [OBJ.APP]: STATE.UNLOADED } },                     // the application not loaded
      { appMcb: [mcbEntry(base.target.size - 1, 0)] },               // the segment at another size
    ];
    for (const o of cases) {
      const unit = new MockUnit(o);
      await run(unit).catch((e) => { unit.events.push(`threw ${e.code ?? e.message}`); });
      // The full form unloads the PEI program first (R9) and reloads every object, allocations filled.
      expect([JSON.stringify(o), unit.events[0]]).toEqual([JSON.stringify(o), "unload:5"]);
      expect(unit.events).toContain("unload:4");
    }
  }, 120_000);

  test("verify: a parameter byte the unit loses on the restart is caught", async () => {
    const flip = base.target.verify.findIndex(Boolean);
    const unit = new MockUnit({ onRestart: (mem) => mem.set(AT[OBJ.APP] + flip, base.target.bytes[flip] ^ 0xff) });
    expect((await run(unit)).verified).toBe(false);
  }, 30_000);
});
