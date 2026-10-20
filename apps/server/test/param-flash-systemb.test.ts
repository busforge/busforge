import { test, expect, describe } from "bun:test";
import { KnxDevice, KnxError, LSM, STATE } from "@busforge/knx";
import { parseAppConfig, buildRelativeSegmentTarget, parseLoadProcedures } from "@busforge/product";
import { classify } from "../src/deviceprofile.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// System B parameter flash against a device whose bytes already match: whether it may call that
// "unchanged" depends on the parameter load-state machine being LOADED. On an OpenKNX RaumController
// an interrupted flash can leave the bytes right and LSM 4 Loading (application halted), which a
// byte comparison alone would call "unchanged". The System B bracket rewrites the segment and
// completes the load, so it runs.
corpusDescribe("the System B parameter flash against the real M-0162 application", () => {
  const xml = catalogueXml("M-0162_A-0004-11-F245.xml.gz");
  const cfg = parseAppConfig(xml);
  const params = new Map<string, string>();
  const target = buildRelativeSegmentTarget(cfg, params, 4, { ownIdleUnionDefaults: true })!;
  const BASE = 0x4000;
  // One memory-control-block region over the whole segment, CRC control 0, then access and CRC.
  const STAMP = `${target.size.toString(16).padStart(8, "0")}00ff00aa`;
  const other = (ctl: string, crc: string) => `${target.size.toString(16).padStart(8, "0")}${ctl}ff${crc}`;

  class MockDevice {
    mem = new Map<number, number>();
    state = new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED], [4, STATE.LOADED]]);
    writes = 0;
    written = new Set<number>();
    stamp = STAMP; // what PID 27 answers, element 1 of every object without its own in `stamps`
    stamps = new Map<number, string>();
    async connect() {}
    async disconnect() {}
    async deviceDescriptor() { return "MV-07B0"; }
    // How the closing restart ends, as KnxDevice.restart decides it: "unproven" is the negatively confirmed
    // A_Restart the device did not decide (recorded where accepted, RESTART_UNPROVEN otherwise).
    restartEnds: "proven" | "unproven" | "ignored" = "proven";
    unprovenAccepted = false;
    unprovenSeen = false;
    armed: boolean[] = [];
    acceptUnprovenRestart(on: boolean) { this.unprovenAccepted = on; this.unprovenSeen = false; this.armed.push(on); }
    get restartUnproven() { return this.unprovenSeen; }
    onRestart: () => void = () => {};
    async restart() {
      this.onRestart();
      if (this.restartEnds === "ignored") throw new KnxError("RESTART_IGNORED", "mock: the device kept answering");
      if (this.restartEnds === "unproven") {
        if (!this.unprovenAccepted) throw new KnxError("RESTART_UNPROVEN", "mock: not proven");
        this.unprovenSeen = true;
      }
    }
    async tableAddr(obj: number) { return obj === 4 ? BASE : 0x100 * obj; }
    async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0; return b; }
    async writesConfirmed() { return false; }
    confirmedWrites() { return []; }
    clearConfirmedWrites() {}
    setExtendedMemoryServices() {}
    async setVerifyMode() {}
    async memWrite(addr: number, data: Buffer) { this.writes++; for (let i = 0; i < data.length; i++) { this.mem.set(addr + i, data[i]); this.written.add(addr + i); } }
    async propRead(obj: number, pid: number) { if (pid === 27) return Buffer.from(this.stamps.get(obj) ?? this.stamp, "hex"); if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]); if (pid === 7) return Buffer.from([0, 0, (await this.tableAddr(obj)) >> 8, (await this.tableAddr(obj)) & 0xff]); return Buffer.alloc(0); }
    async propReadIfPresent() { return null; }
    // The stamps the download's closing reads take (PID 27), on a standard-frame device.
    async propValueDataMax() { return 10; }
    async propReadCounted(obj: number, pid: number, start: number, count = 1) { return { objectIndex: obj, pid, count, start, value: pid === 27 ? Buffer.concat(Array.from({ length: count }, () => Buffer.from(this.stamps.get(obj) ?? this.stamp, "hex"))) : Buffer.alloc(8 * count) }; }
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === 5) { const ev = data[0]; if (ev === LSM.LOAD) this.state.set(obj, STATE.LOADING); else if (ev === LSM.LOAD_COMPLETED) this.state.set(obj, STATE.LOADED); else if (ev === LSM.UNLOAD) this.state.set(obj, STATE.UNLOADED); }
      return Buffer.alloc(0);
    }
  }
  const asDev = (m: MockDevice) => m as unknown as KnxDevice;
  const ctx = { deviceId: "d", appXml: xml, params, baseParams: params, moduleInstances: [], dryRun: false, persistBackups: () => "backup" };
  function seeded(): MockDevice {
    const dev = new MockDevice();
    for (let i = 0; i < target.size; i++) dev.mem.set(BASE + i, target.bytes[i]);
    return dev;
  }

  // ETS's record (ImageStamp): with the unit's stamps equal to it the flash writes only the owned bytes that
  // differ; with another stamp, or no record, every owned byte. The result carries the closing reads.
  describe("System B parameter flash and the stamp record", () => {
    const run = async (record: { obj: number; element: number; hex: string }[] | undefined) => {
      const dev = seeded();
      const k = target.owned.findIndex((m) => m === 0xff);
      dev.mem.set(BASE + k, target.bytes[k] ^ 0xff);
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", { ...ctx, stampRecord: record });
      if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
      return { dev, res, k };
    };
    const owned = target.owned.filter((m) => m !== 0).length;
    test("stamps equal to the record: only the byte that differs", async () => {
      const { dev, res, k } = await run([{ obj: 4, element: 1, hex: STAMP }]);
      expect([...dev.written]).toEqual([BASE + k]);
      expect(res.verified).toBe(true);
      expect(res.stamps?.some((st) => st.obj === 4 && st.hex === STAMP)).toBe(true);
    }, 30_000);
    test("a stamp other than the record: every owned byte", async () => {
      expect((await run([{ obj: 4, element: 1, hex: other("00", "00bb") }])).dev.written.size).toBe(owned);
    }, 30_000);
    test("no record: every owned byte", async () => {
      expect((await run(undefined)).dev.written.size).toBe(owned);
    }, 30_000);
    test("a region whose control byte is not 0 does not count: no check, every owned byte", async () => {
      expect((await run([{ obj: 4, element: 1, hex: other("01", "00aa") }])).dev.written.size).toBe(owned);
    }, 30_000);
  });

  // The group-address flash decides the com-object table the same way (relativeComObjWriteSet): with the unit's
  // stamps equal to a record whose download wrote the table, the bytes of the table that differ (one region, CRC
  // control 0); otherwise the table whole. Linking the unlinked object 2 changes its flags byte, as in ETS's group-address download of this
  // application (tools/etsdiff.test.ts).
  describe("System B group-address flash and the stamp record", () => {
    const tables = (links: { comObjNum: number; gaRaws: number[] }[]) => {
      const b = classify(cfg).planFullDownload(cfg.mask, { ia: "1.2.7", params, links, proc: parseLoadProcedures(xml) });
      return (lsm: number) => b.segments.find((s) => s.lsm === lsm)!.image;
    };
    const unlinked = tables([]), linked = tables([{ comObjNum: 2, gaRaws: [0x77c8] }]);
    const COMOBJ = `${unlinked(3).length.toString(16).padStart(8, "0")}00ff00cc`;
    const run = async (record: { obj: number; element: number; hex: string; written?: true }[] | undefined, comObjStamp = COMOBJ, tablesState: number = STATE.LOADED) => {
      const dev = seeded();
      dev.stamps.set(3, comObjStamp);
      dev.state.set(3, tablesState);
      for (const lsm of [1, 2, 3]) unlinked(lsm).forEach((b, i) => dev.mem.set(0x100 * lsm + i, b));
      const res = await classify(cfg).flashGroupTables(asDev(dev), "07B0", { ...ctx, ia: "1.2.7", links: [{ comObjNum: 2, gaRaws: [0x77c8] }], stampRecord: record });
      if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
      expect(res.verified).toBe(true);
      for (const lsm of [1, 2, 3]) expect([lsm, Buffer.from(Array.from(linked(lsm), (_, i) => dev.mem.get(0x100 * lsm + i)!)).equals(linked(lsm))]).toEqual([lsm, true]);
      return [...dev.written].filter((a) => a >= 0x300 && a < 0x300 + linked(3).length).map((a) => a - 0x300);
    };
    const record = [{ obj: 3, element: 1, hex: COMOBJ, written: true as const }, { obj: 4, element: 1, hex: STAMP, written: true as const }];
    const differing = Array.from(linked(3), (_, i) => i).filter((i) => linked(3)[i] !== unlinked(3)[i]);
    test("the change links object 2: one byte of the com-object table differs", () => {
      expect(differing).toEqual([4]);
    });
    test("stamps equal to the record: only the com-object byte that differs", async () => {
      expect(await run(record)).toEqual(differing);
    }, 30_000);
    test("the application's stamp other than the record: the com-object table whole", async () => {
      expect((await run([record[0], { obj: 4, element: 1, hex: other("00", "00bb") }])).length).toBe(linked(3).length);
    }, 30_000);
    test("no record: the com-object table whole", async () => {
      expect((await run(undefined)).length).toBe(linked(3).length);
    }, 30_000);
    test("a record of a parameter flash, which did not write the table: the com-object table whole", async () => {
      expect((await run([{ obj: 3, element: 1, hex: COMOBJ }, record[1]])).length).toBe(linked(3).length);
    }, 30_000);
    test("a com-object region whose control byte is not 0: the com-object table whole", async () => {
      const ctl1 = `${COMOBJ.slice(0, 8)}01${COMOBJ.slice(10)}`;
      expect((await run([{ ...record[0], hex: ctl1 }, record[1]], ctl1)).length).toBe(linked(3).length);
    }, 30_000);
    test("a com-object table not LOADED: the table whole", async () => {
      expect((await run(record, COMOBJ, STATE.LOADING)).length).toBe(linked(3).length);
    }, 30_000);
    test("a stamp the unit does not give as 8 bytes: the table whole, not a refusal", async () => {
      expect((await run(record, "0000004a00ff")).length).toBe(linked(3).length);
    }, 30_000);
  });

  // Which objects an operation's record marks as written (ImageStamp.written) decides the next group-address
  // flash: the com-object table goes differentially only after a record whose download wrote it. A download
  // that writes every segment (the full download and the structural flash) marks
  // all four; the parameter flash only the application; the group-address flash keeps no record.
  describe("which objects each operation's record marks as written", () => {
    const writtenObjs = (stamps: { obj: number; written?: true }[] | undefined) =>
      stamps === undefined ? undefined : [...new Set(stamps.filter((st) => st.written).map((st) => st.obj))].sort((a, b) => a - b);
    const links = [{ comObjNum: 2, gaRaws: [0x77c8] }];
    const loadedUnit = () => {
      const dev = seeded();
      const b = classify(cfg).planFullDownload(cfg.mask, { ia: "1.2.7", params, links: [], proc: parseLoadProcedures(xml) });
      for (const lsm of [1, 2, 3]) b.segments.find((sg) => sg.lsm === lsm)!.image.forEach((v, i) => dev.mem.set(0x100 * lsm + i, v));
      return dev;
    };
    test("full download: all four objects", async () => {
      const res = await classify(cfg).downloadFull(asDev(loadedUnit()), "07B0", { ...ctx, ia: "1.2.7", links });
      if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
      expect(writtenObjs(res.stamps)).toEqual([1, 2, 3, 4]);
    }, 30_000);
    test("parameter flash: the application only", async () => {
      const dev = loadedUnit();
      const k = target.owned.findIndex((m) => m === 0xff);
      dev.mem.set(BASE + k, target.bytes[k] ^ 0xff);
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx);
      if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
      expect(writtenObjs(res.stamps)).toEqual([4]);
    }, 30_000);
    test("group-address flash: no record", async () => {
      const res = await classify(cfg).flashGroupTables(asDev(loadedUnit()), "07B0", { ...ctx, ia: "1.2.7", links });
      if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
      expect(writtenObjs(res.stamps)).toBeUndefined();
    }, 30_000);
    test("structural flash: all four objects", async () => {
      const res = await classify(cfg).flashStructure(asDev(loadedUnit()), "07B0", { ...ctx, ia: "1.2.7", links });
      if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
      expect(writtenObjs(res.stamps)).toEqual([1, 2, 3, 4]);
    }, 30_000);
  });

  // A negatively confirmed A_Restart the device did not decide (KnxDevice.acceptUnprovenRestart) is taken as
  // ETS takes it, and named: the flash is verified by its read-back after the restart and carries
  // restartUnproven. Every operation alike; any other restart failure, a failed read-back or a device that
  // does not come back stays a failure.
  describe("a restart the device did not prove", () => {
    const links = [{ comObjNum: 2, gaRaws: [0x77c8] }];
    const changedUnit = () => {
      const dev = seeded();
      const k = target.owned.findIndex((m) => m === 0xff);
      dev.mem.set(BASE + k, target.bytes[k] ^ 0xff);
      return dev;
    };
    // The writes that rewrite the com-object table find the one the baseline implies on the unit (with no
    // link yet, as its empty group tables say).
    const withTable = () => {
      const dev = changedUnit();
      const l3 = classify(cfg).planFullDownload(cfg.mask, { ia: "1.2.7", params, links: [], proc: parseLoadProcedures(xml) }).segments.find((s) => s.lsm === 3)!.image;
      l3.forEach((b, i) => dev.mem.set(0x300 + i, b));
      return dev;
    };
    // The full download writes the application's non-zero runs into a segment its allocation fills with 0,
    // which this mock does not do: it starts from the image.
    const ops: [string, (dev: MockDevice) => Promise<unknown>, () => MockDevice][] = [
      ["full download", (dev) => classify(cfg).downloadFull(asDev(dev), "07B0", { ...ctx, ia: "1.2.7", links }), seeded],
      ["parameter flash", (dev) => classify(cfg).flashParameters(asDev(dev), "07B0", ctx), changedUnit],
      ["group-address flash", (dev) => classify(cfg).flashGroupTables(asDev(dev), "07B0", { ...ctx, ia: "1.2.7", links }), withTable],
      ["structural flash", (dev) => classify(cfg).flashStructure(asDev(dev), "07B0", { ...ctx, ia: "1.2.7", links }), withTable],
    ];
    for (const [name, op, unitFor] of ops) {
      test(`${name}: verified, with restartUnproven, and the acceptance closed after it`, async () => {
        const dev = unitFor();
        dev.restartEnds = "unproven";
        const res = await op(dev);
        expect(res).toMatchObject({ kind: "flashed", verified: true, restartUnproven: true });
        expect(dev.armed).toEqual([true, false]);
      }, 30_000);
      test(`${name}: a proven restart carries no warning`, async () => {
        const res = await op(unitFor());
        expect(res).toMatchObject({ kind: "flashed", verified: true });
        expect((res as { restartUnproven?: unknown }).restartUnproven).toBeUndefined();
      }, 30_000);
      test(`${name}: a device that ignored the restart stays RESTART_IGNORED, and the acceptance is closed`, async () => {
        const dev = unitFor();
        dev.restartEnds = "ignored";
        const failure = await op(dev).then(() => null, (e: unknown) => e);
        expect((failure as { code?: string } | null)?.code).toBe("RESTART_IGNORED");
        expect(dev.armed).toEqual([true, false]);
      }, 30_000);
    }
    test("a read-back after the unproven restart that differs is not verified", async () => {
      const dev = changedUnit();
      dev.restartEnds = "unproven";
      // The unit loses the written byte on its restart.
      const k = target.owned.findIndex((m) => m === 0xff);
      dev.onRestart = () => { dev.mem.set(BASE + k, target.bytes[k] ^ 0xff); };
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx);
      expect(res).toMatchObject({ kind: "flashed", verified: false, restartUnproven: true });
    }, 30_000);
    test("a device that does not come back after the unproven restart is a failure", async () => {
      const dev = changedUnit();
      dev.restartEnds = "unproven";
      let restarted = false;
      dev.onRestart = () => { restarted = true; };
      dev.deviceDescriptor = async () => { if (restarted) throw new KnxError("DEVICE_NOT_ANSWERING", "mock: gone"); return "MV-07B0"; };
      const failure = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx).then(() => null, (e: unknown) => e);
      expect((failure as { code?: string } | null)?.code).toBe("DEVICE_NOT_ANSWERING");
    }, 60_000);
  });

  describe("System B parameter flash on a device whose bytes already match", () => {
    test("LSM 4 LOADED: unchanged, nothing written", async () => {
      const dev = seeded();
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx);
      expect(res.kind).toBe("unchanged");
      expect(dev.writes).toBe(0);
    });

    // A rebooted OpenKNX device went silent partway through the read-back of a write that had landed:
    // one lost read is retried after a reconnect, not reported as a failed flash.
    test("a read-back that loses the device once is retried after a reconnect", async () => {
      const dev = seeded();
      dev.mem.set(BASE, target.bytes[0] ^ 0xff); // a real change, so the flash writes and verifies
      let failOnce = true;
      const read = dev.memRead.bind(dev);
      dev.memRead = async (addr: number, len: number) => {
        if (dev.writes > 0 && failOnce) { failOnce = false; throw Object.assign(new Error("no reliable response"), { code: "DEVICE_NOT_ANSWERING" }); }
        return read(addr, len);
      };
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx);
      expect(failOnce).toBe(false);
      expect(res.kind).toBe("flashed");
      if (res.kind !== "flashed") throw new Error("unreachable");
      expect(res.verified).toBe(true);
    }, 30_000);

    // Written with the confirmed extended write (the log KnxDevice keeps), and one owned byte it stores
    // but always reads as FF: a field it does not give back.
    test("a field the device does not give back verifies on the write confirmation, after a retried read-back", async () => {
      const k = target.owned.findIndex((m, i) => i > 0 && m === 0xff && target.verify[i] === 0xff && target.bytes[i] !== 0xff);
      expect(k).toBeGreaterThan(0);
      const dev = seeded();
      dev.mem.set(BASE, target.bytes[0] ^ 0xff); // a real change that lands
      let log: { address: number; bytes: Buffer }[] = [];
      dev.confirmedWrites = () => log as never;
      dev.clearConfirmedWrites = () => { log = []; };
      const write = dev.memWrite.bind(dev);
      dev.memWrite = async (addr: number, data: Buffer) => { await write(addr, data); log.push({ address: addr, bytes: Buffer.from(data) }); };
      let failOnce = true;
      const read = dev.memRead.bind(dev);
      dev.memRead = async (addr: number, len: number) => {
        if (dev.writes > 0 && failOnce) { failOnce = false; throw Object.assign(new Error("no reliable response"), { code: "DEVICE_NOT_ANSWERING" }); }
        const b = await read(addr, len);
        if (addr <= BASE + k && BASE + k < addr + len) b[BASE + k - addr] = 0xff;
        return b;
      };
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx);
      expect(failOnce).toBe(false);
      if (res.kind !== "flashed") throw new Error(`not flashed: ${res.kind}`);
      expect(res.verified).toBe(true);
      expect(res.confirmedOnly).toEqual([{ address: BASE + k, length: 1 }]);
    }, 30_000);

    // The same field before a write: the dry run counts the byte the device reads as FF and names it, as
    // nothing but a write tells a byte it does not give back from one that holds FF.
    test("a dry run names the differing bytes the device reads as FF", async () => {
      const k = target.owned.findIndex((m, i) => i > 0 && m === 0xff && target.constant[i] === 0 && target.bytes[i] !== 0xff);
      const dev = seeded();
      dev.mem.set(BASE, target.bytes[0] === 0 ? 1 : 0); // a difference that reads as data
      dev.mem.set(BASE + k, 0xff);
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", { ...ctx, dryRun: true });
      expect(res).toMatchObject({ kind: "dryRun", diffBytes: 2, readsFF: [{ address: BASE + k, length: 1 }] });
      dev.mem.set(BASE + k, target.bytes[k]);
      const plain = await classify(cfg).flashParameters(asDev(dev), "07B0", { ...ctx, dryRun: true });
      expect(plain.kind === "dryRun" && plain.diffBytes === 1 && !("readsFF" in plain)).toBe(true);
      expect(dev.writes).toBe(0);
    });

    test("LSM 4 Loading: the bracket runs and leaves it LOADED", async () => {
      const dev = seeded();
      dev.state.set(4, STATE.LOADING);
      const res = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx);
      expect(res.kind).toBe("flashed");
      if (res.kind !== "flashed") throw new Error("unreachable");
      expect(res.verified).toBe(true);
      expect(dev.writes).toBeGreaterThan(0);
      expect(dev.state.get(4)).toBe(STATE.LOADED);
      for (let i = 0; i < target.size; i++) expect(dev.mem.get(BASE + i)).toBe(target.bytes[i]);
    }, 20_000);
  });
});
