import { test, expect } from "bun:test";
import { LSM, STATE, type KnxDevice } from "@busforge/knx";
import { parseAppConfig, classify, buildRelativeSegmentTarget, type ComObjectLink } from "@busforge/product";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";

// The GVS AMMA declares a write of 01 to object 4 PID 67 for every download (AppliesTo="all",
// Verify="true"), and ETS sends it after the last LoadCompleted, right before the restart (captures in
// the private corpus, see tools/etsdiff.test.ts). Here the profile's own paths run against a mock
// device: the full download, the parameter flash and the group-address flash each end with that write,
// the declared PID 66 check is read before anything is written, and an echo that differs refuses.
corpusDescribe("the GVS AMMA's closing PID 67 write, through the profile", () => {
  const xml = catalogueXml("M-0085_A-0072-30-69AA.xml.gz");
  const cfg = parseAppConfig(xml);
  const profile = classify(cfg);
  const params = new Map([["M-0085_A-0072-30-69AA_P-20_R-20", "1"], ["M-0085_A-0072-30-69AA_UP-142_R-142", "1"]]);
  const target = buildRelativeSegmentTarget(cfg, params, 4, { ownIdleUnionDefaults: true })!;
  const A: Record<number, number> = { 1: 0x5000, 2: 0x5100, 3: 0x5200, 4: 0x4000 };
  const GA_3_3_6 = (3 << 11) | (3 << 8) | 6;

  class MockDevice {
    mem = new Map<number, number>();
    state = new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED], [4, STATE.LOADED]]);
    log: string[] = [];
    pid67Answer?: Buffer;
    async connect() {}
    async disconnect() {}
    async deviceDescriptor() { return "MV-07B0"; }
    async restart() { this.log.push("restart"); }
    async setVerifyMode() {}
    async writesConfirmed() { return false; }
    confirmedWrites() { return []; }
    clearConfirmedWrites() {}
    setExtendedMemoryServices() {}
    acceptUnprovenRestart() {}
    async tableAddr(obj: number) { return A[obj] ?? 0; }
    async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0; return b; }
    async memWrite(addr: number, data: Buffer) { this.log.push("mem"); for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]); }
    async propReadIfPresent() { return null; }
    // The stamps the download's closing reads take (PID 27), on a standard-frame device.
    async propValueDataMax() { return 10; }
    async propReadCounted(obj: number, pid: number, start: number, count = 1) { return { objectIndex: obj, pid, count, start, value: Buffer.alloc(8 * count) }; }
    async propRead(obj: number, pid: number) {
      if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]);
      if (pid === 7) return Buffer.from([0, 0, (A[obj] >> 8) & 0xff, A[obj] & 0xff]);
      if (obj === 4 && pid === 66) { this.log.push("read 4/66"); return Buffer.from("007230", "hex"); }
      return Buffer.alloc(0); // PID 27: declines, so the full download verifies by reading the segment
    }
    async propWrite(obj: number, pid: number, data: Buffer) {
      if (pid === 5) {
        const ev = data[0];
        if (ev === LSM.LOAD) this.state.set(obj, STATE.LOADING);
        else if (ev === LSM.LOAD_COMPLETED) { this.state.set(obj, STATE.LOADED); this.log.push("loadCompleted"); }
        else if (ev === LSM.UNLOAD) this.state.set(obj, STATE.UNLOADED);
        else if (data[0] === 0x03 && data[1] === 0x0b && data[6]) { const size = data.readUInt32BE(2); for (let i = 0; i < size; i++) this.mem.set(A[obj] + i, data[7]); }
        return Buffer.alloc(0);
      }
      if (pid === 67) { this.log.push(`prop ${obj}/67=${data.toString("hex")}`); return this.pid67Answer ?? data; }
      return Buffer.alloc(0);
    }
  }
  const asDev = (m: MockDevice) => m as unknown as KnxDevice;
  const base = { deviceId: "d", ia: "1.1.203", appXml: xml, params, baseParams: params, moduleInstances: [], dryRun: false, persistBackups: () => "backup" };
  // One full download (it pauses 8 s for the device to save); every other test starts from a copy of it.
  let fullDownload: Promise<MockDevice> | undefined;
  const commissioned = async () => {
    fullDownload ??= (async () => {
      const dev = new MockDevice();
      await profile.downloadFull(asDev(dev), cfg.mask, { ...base, links: [] as ComObjectLink[], backupBeforeUnload: false });
      return dev;
    })();
    const done = await fullDownload, dev = new MockDevice();
    dev.mem = new Map(done.mem); dev.state = new Map(done.state); dev.log = [...done.log];
    return dev;
  };
  // The write closes the download: after every LoadCompleted, and the restart right after it.
  const closesWithPid67 = (log: string[]) => {
    const at = log.lastIndexOf("prop 4/67=01");
    expect(at).toBeGreaterThan(log.lastIndexOf("loadCompleted"));
    expect(log.slice(at)).toEqual(["prop 4/67=01", "restart"]);
  };

  test("the application keeps its parameter flash and full download", () => {
    const caps = profile.capabilities();
    expect([caps.flashParams, caps.fullDownload, caps.flashLinks]).toEqual([true, true, true]);
  });

  test("the full download reads PID 66 first and ends with PID 67 = 01", async () => {
    const dev = await commissioned();
    expect(dev.log.indexOf("read 4/66")).toBeLessThan(dev.log.indexOf("mem"));
    expect(dev.log.indexOf("read 4/66")).toBeGreaterThanOrEqual(0);
    closesWithPid67(dev.log);
  }, 30_000);

  // An owned byte the device holds differently, so the parameter flash has something to write.
  const owned = target.owned.findIndex((m) => m !== 0);

  test("the parameter flash reads PID 66 first and ends with PID 67 = 01", async () => {
    const dev = await commissioned();
    dev.mem.set(A[4] + owned, (dev.mem.get(A[4] + owned) ?? 0) ^ target.owned[owned]);
    dev.log = [];
    const res = await profile.flashParameters(asDev(dev), cfg.mask, base);
    expect(res.kind).toBe("flashed");
    expect((res as { verified: boolean }).verified).toBe(true);
    expect(dev.log[0]).toBe("read 4/66");
    closesWithPid67(dev.log);
  }, 30_000);

  test("the group-address flash ends with PID 67 = 01, and reads no PID 66, as ETS's partial download", async () => {
    const dev = await commissioned();
    dev.log = [];
    const res = await profile.flashGroupTables(asDev(dev), cfg.mask, { ...base, links: [{ comObjNum: 2, gaRaws: [GA_3_3_6] }] });
    expect(res.kind).toBe("flashed");
    expect((res as { verified: boolean }).verified).toBe(true);
    expect(dev.log).not.toContain("read 4/66");
    closesWithPid67(dev.log);
  }, 30_000);

  test("a closing write that cannot be executed as declared refuses every write before the bus", async () => {
    // The same declared write with a Count of two elements: no form of it is known to send.
    const blocks = cfg.loadProcedures.blocks.map((b) => ({ ...b, steps: b.steps.map((st) => (st.verb === "LdCtrlWriteProp" && st.attrs.PropId === "67" ? { ...st, attrs: { ...st.attrs, Count: "2" } } : st)) }));
    const other = { ...cfg, loadProcedures: { ...cfg.loadProcedures, blocks } };
    const p = classify(other);
    const refused = p.operationRefusals();
    expect([refused.flashParams?.code, refused.fullDownload?.code, refused.flashLinks?.code]).toEqual(["LOAD_STEP_UNSUPPORTED", "LOAD_STEP_UNSUPPORTED", "LOAD_STEP_UNSUPPORTED"]);
    const caps = p.capabilities();
    expect([caps.flashParams, caps.fullDownload, caps.flashLinks]).toEqual([false, false, false]);
    const dev = new MockDevice();
    dev.tableAddr = async () => { throw new Error("BUS-REACHED"); };
    const err = await p.flashGroupTables(asDev(dev), cfg.mask, { ...base, links: [{ comObjNum: 2, gaRaws: [GA_3_3_6] }] }).catch((e) => e);
    expect(err?.code).toBe("LOAD_STEP_UNSUPPORTED");
    expect(dev.log).toEqual([]);
  });

  test("a group-address flash whose PID 67 echo is not 01 is refused, not reported programmed", async () => {
    const dev = await commissioned();
    dev.pid67Answer = Buffer.from([0]);
    dev.log = [];
    const err = await profile.flashGroupTables(asDev(dev), cfg.mask, { ...base, links: [{ comObjNum: 2, gaRaws: [GA_3_3_6] }] }).catch((e) => e);
    expect(String(err?.message ?? err)).toContain("PID 67");
    expect(dev.log).not.toContain("restart");
  }, 30_000);

  test("a device that does not echo 01 refuses the flash instead of reporting it programmed", async () => {
    const dev = await commissioned();
    dev.mem.set(A[4] + owned, (dev.mem.get(A[4] + owned) ?? 0) ^ target.owned[owned]);
    dev.pid67Answer = Buffer.alloc(0);
    dev.log = [];
    const err = await profile.flashParameters(asDev(dev), cfg.mask, base).catch((e) => e);
    expect(String(err?.message ?? err)).toContain("PID 67");
    expect(dev.log).not.toContain("restart");
  }, 30_000);
});
