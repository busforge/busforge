import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { KnxDevice, LSM, STATE } from "@busforge/knx";
import { parseAppConfig, parseLoadProcedures, buildDeviceConfig, resolveModuleInstances, absoluteStructuralImages, buildAbsoluteSegmentTargets, type FlashResult } from "@busforge/product";
import { classify } from "../src/deviceprofile.ts";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The structural flash (DeviceProfile.flashStructure) against a simulated device: it writes a change
// that alters the com-object table, verifies it after the restart, and never reports verified what
// the device does not hold.
// Each test plans a full download and a structural flash over a real application program: about
// 0.7 s on a laptop, past Bun's 5 s default on a CI runner busy with the other workspaces' tests.
setDefaultTimeout(30_000);

corpusDescribe("the structural flash against real applications", () => {
  const real = catalogueXml;

  // A memory-image device with property-mapped load-state machines. `clearOnAlloc` models a stack that
  // does not keep a segment's bytes across a reallocation at the same address.
  class MockDevice {
    mem = new Map<number, number>();
    state = new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED], [4, STATE.LOADED]]);
    addr = new Map<number, number>([[1, 0x1000], [2, 0x2000], [3, 0x3000], [4, 0x4000]]);
    props = new Map<string, Buffer>();
    writes: { addr: number; len: number }[] = [];
    clearOnAlloc = false;
    async connect() {}
    async disconnect() {}
    async deviceDescriptor() { return "MV-07B0"; }
    async restart() {}
    async tableAddr(obj: number) { return this.addr.get(obj) ?? 0; }
    async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0; return b; }
    async writesConfirmed() { return false; }
    confirmedWrites() { return []; }
    clearConfirmedWrites() {}
    async memWrite(addr: number, data: Buffer) { this.writes.push({ addr, len: data.length }); for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]); }
    async propRead(obj: number, pid: number) {
      if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]);
      if (pid === 7) { const a = this.addr.get(obj) ?? 0; return Buffer.from([(a >> 24) & 0xff, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff]); }
      return this.props.get(`${obj}/${pid}`) ?? Buffer.alloc(0);
    }
    async propReadIfPresent() { return null; }
    // The stamps the download's closing reads take (PID 27), on a standard-frame device.
    async propValueDataMax() { return 10; }
    async propReadCounted(obj: number, pid: number, start: number, count = 1) { return { objectIndex: obj, pid, count, start, value: Buffer.alloc(8 * count) }; }
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === 5) {
        const ev = data[0];
        if (ev === LSM.LOAD) this.state.set(obj, STATE.LOADING);
        else if (ev === LSM.LOAD_COMPLETED) this.state.set(obj, STATE.LOADED);
        else if (ev === LSM.UNLOAD) this.state.set(obj, STATE.UNLOADED);
        else if (ev === 3 && this.clearOnAlloc) { const at = this.addr.get(obj)!; const size = data.readUInt32BE(2); for (let i = 0; i < size; i++) this.mem.set(at + i, 0); }
        return Buffer.alloc(0);
      }
      return data;
    }
    load(at: number, bytes: Buffer) { bytes.forEach((b, i) => this.mem.set(at + i, b)); }
  }
  const asDev = (m: MockDevice) => m as unknown as KnxDevice;
  const verified = (r: FlashResult) => r.kind === "flashed" && r.verified;

  describe("System B (Jung 400021SE)", () => {
    const xml = real("M-0004_A-7072-21-99A7-O000A.xml.gz");
    const cfg = parseAppConfig(xml);
    const CHANNEL_FUNCTION = "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-149_R-142"; // 8 removes #253, #254
    const base = new Map<string, string>();
    const changed = new Map([[CHANNEL_FUNCTION, "8"]]);
    // A device holding what a full download of the baseline wrote.
    const seeded = () => {
      const dev = new MockDevice();
      const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.204", params: base, links: [], proc: parseLoadProcedures(xml) });
      for (const s of build.segments) dev.load(dev.addr.get(s.lsm)!, s.image);
      return dev;
    };
    const ctx = (params: Map<string, string>, dryRun = false) => ({ deviceId: "d", ia: "1.1.204", appXml: xml, params, baseParams: base, links: [], moduleInstances: [], dryRun, persistBackups: () => "backup" });

    test("a change that removes objects is written in one bracket and verified", async () => {
      const dev = seeded();
      const res = await classify(cfg).flashStructure(asDev(dev), "MV-07B0", ctx(changed));
      expect(res).toMatchObject({ kind: "flashed", verified: true, structural: true });
      const want = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.204", params: changed, links: [], proc: parseLoadProcedures(xml) }).segments.find((s) => s.lsm === 3)!.image;
      expect((await dev.memRead(0x3000, want.length)).equals(want)).toBe(true);
      // The com-object table went only where it differs, not whole.
      const l3 = dev.writes.filter((w) => w.addr >= 0x3000 && w.addr < 0x3000 + want.length).reduce((n, w) => n + w.len, 0);
      expect(l3).toBeGreaterThan(0);
      expect(l3).toBeLessThan(want.length);
      expect([...dev.state.values()]).toEqual([STATE.LOADED, STATE.LOADED, STATE.LOADED, STATE.LOADED]);
    });

    test("a device that does not keep the table across the reallocation is not reported verified", async () => {
      const dev = seeded();
      dev.clearOnAlloc = true;
      const res = await classify(cfg).flashStructure(asDev(dev), "MV-07B0", ctx(changed));
      expect(res.kind).toBe("flashed");
      expect(verified(res)).toBe(false);
    }, 30_000);

    test("a dry run writes nothing and keeps no backups", async () => {
      const dev = seeded();
      let kept = -1;
      const res = await classify(cfg).flashStructure(asDev(dev), "MV-07B0", { ...ctx(changed, true), persistBackups: (files: unknown[]) => { kept = files.length; return "x"; } });
      expect(res).toMatchObject({ kind: "dryRun", structural: true });
      expect(dev.writes).toEqual([]);
      expect(kept).toBe(0);
    });

    test("an application without a capture of it is refused before the bus", async () => {
      const other = parseAppConfig(real("M-0162_A-0004-11-F245.xml.gz")); // not in profiles.ts STRUCTURAL_FLASH_CAPTURED
      expect(classify(other).capabilities().structuralFlash).toBe(false);
      const dev = new MockDevice();
      const err = await classify(other).flashStructure(asDev(dev), "MV-07B0", { ...ctx(changed), appXml: real("M-0162_A-0004-11-F245.xml.gz") }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(dev.writes).toEqual([]);
    });
  });

  describe("System 7 (MDT BE-02001.02)", () => {
    const xml = real("M-0083_A-00B6-32-9642.xml.gz");
    const cfg = parseAppConfig(xml);
    const INPUT_B = "M-0083_A-00B6-32-9642_MD-2_M-3_MI-1_P-24_R-2";
    const shortLong = new Map([[INPUT_B, "7"]]);
    const contact = new Map<string, string>();
    const seeded = (params: Map<string, string>) => {
      const dev = new MockDevice();
      dev.props.set("0/78", Buffer.from("0000000002ac", "hex"));
      // The table references (PID 7) a System 7 unit reports: the segments its procedure declares.
      const declared = (id: string | undefined) => cfg.absoluteSegments.find((s) => s.id === id)!.address;
      dev.addr.set(1, declared(cfg.groupTables.addressSegment)).set(2, declared(cfg.groupTables.associationSegment));
      const build = classify(cfg).planFullDownload(cfg.mask, { ia: "1.1.56", params, links: [], proc: parseLoadProcedures(xml) });
      for (const s of build.segments) if (s.address !== null) dev.load(s.address, s.image);
      return dev;
    };
    const ctx = (params: Map<string, string>, baseParams: Map<string, string>) => ({ deviceId: "d", ia: "1.1.56", appXml: xml, params, baseParams, links: [], moduleInstances: [], dryRun: false, persistBackups: () => "backup" });

    test("going back to the one-object function restores the deactivated settings' template bytes, verified", async () => {
      const dev = seeded(shortLong);
      expect(dev.mem.get(0x44b2)).toBe(0x00);
      const res = await classify(cfg).flashStructure(asDev(dev), "MV-0705", ctx(contact, shortLong));
      expect(res).toMatchObject({ kind: "flashed", verified: true, structural: true });
      expect(dev.mem.get(0x44b2)).toBe(0x01);
    });

    test("only bytes a parameter of the baseline or the new configuration owns are ever taken", () => {
      const inst = resolveModuleInstances(cfg, contact);
      const view = buildDeviceConfig(cfg, contact, undefined, inst);
      const images = absoluteStructuralImages(cfg, contact, [], 0x1138, { baseValues: shortLong, moduleInstances: inst, comObjectTable: { active: view.imageComObjects, linked: new Set() } });
      const now = new Map(buildAbsoluteSegmentTargets(cfg, contact, { moduleInstances: inst }).map((t) => [t.address, t]));
      const was = new Map(buildAbsoluteSegmentTargets(cfg, shortLong, { moduleInstances: inst }).map((t) => [t.address, t]));
      for (const img of images) {
        const n = now.get(img.address), w = was.get(img.address);
        if (!n) continue; // a group or com-object table
        img.owned.forEach((m, i) => expect(m & ~(n.owned[i] | (w?.owned[i] ?? 0)) & 0xff).toBe(0));
      }
    });

    test("an interrupted earlier load of a machine the flash concerns is refused, even when its bytes are right", async () => {
      const dev = seeded(shortLong);
      dev.state.set(2, STATE.LOADING);
      const err = await classify(cfg).flashStructure(asDev(dev), "MV-0705", ctx(contact, shortLong)).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "DEVICE_LOAD_INCOMPLETE" });
    });
  });
});
