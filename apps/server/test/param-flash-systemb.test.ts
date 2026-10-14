import { test, expect, describe } from "bun:test";
import { KnxDevice, LSM, STATE } from "@busforge/knx";
import { parseAppConfig, buildRelativeSegmentTarget, parseLoadProcedures } from "@busforge/product";
import { classify } from "../src/deviceprofile.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// System B parameter flash against a device whose bytes already match: whether it may call that
// "unchanged" depends on the parameter load-state machine being LOADED. On the house's OpenKNX
// RaumController an interrupted flash left the bytes right and LSM 4 Loading (application halted),
// and the next flash reported "unchanged". The System B bracket rewrites the segment
// and completes the load, so it runs.
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
    async restart() {}
    async tableAddr(obj: number) { return obj === 4 ? BASE : 0x100 * obj; }
    async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0; return b; }
    async writesConfirmed() { return false; }
    confirmedWrites() { return []; }
    clearConfirmedWrites() {}
    setExtendedMemoryServices() {}
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
      const b = classify(cfg).planFullDownload(cfg.mask, { ia: "1.2.20", params, links, proc: parseLoadProcedures(xml) });
      return (lsm: number) => b.segments.find((s) => s.lsm === lsm)!.image;
    };
    const unlinked = tables([]), linked = tables([{ comObjNum: 2, gaRaws: [0x7ffa] }]);
    const COMOBJ = `${unlinked(3).length.toString(16).padStart(8, "0")}00ff00cc`;
    const run = async (record: { obj: number; element: number; hex: string; written?: true }[] | undefined, comObjStamp = COMOBJ, tablesState: number = STATE.LOADED) => {
      const dev = seeded();
      dev.stamps.set(3, comObjStamp);
      dev.state.set(3, tablesState);
      for (const lsm of [1, 2, 3]) unlinked(lsm).forEach((b, i) => dev.mem.set(0x100 * lsm + i, b));
      const res = await classify(cfg).flashGroupTables(asDev(dev), "07B0", { ...ctx, ia: "1.2.20", links: [{ comObjNum: 2, gaRaws: [0x7ffa] }], stampRecord: record });
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
