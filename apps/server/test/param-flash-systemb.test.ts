import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { KnxDevice, LSM, STATE } from "@busforge/knx";
import { parseAppConfig, buildRelativeSegmentTarget } from "@busforge/product";
import { classify } from "../src/deviceprofile.ts";

// System B parameter flash against a device whose bytes already match: whether it may call that
// "unchanged" depends on the parameter load-state machine being LOADED. On the house's OpenKNX
// RaumController an interrupted flash left the bytes right and LSM 4 Loading (application halted),
// and the next flash reported "unchanged". The System B bracket rewrites the segment
// and completes the load, so it runs.
const REAL = join(import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "real");
const xml = gunzipSync(readFileSync(join(REAL, "M-0162_A-0004-11-F245.xml.gz"))).toString("utf8");
const cfg = parseAppConfig(xml);
const params = new Map<string, string>();
const target = buildRelativeSegmentTarget(cfg, params, 4, { ownIdleUnionDefaults: true })!;
const BASE = 0x4000;

class MockDevice {
  mem = new Map<number, number>();
  state = new Map<number, number>([[1, STATE.LOADED], [2, STATE.LOADED], [3, STATE.LOADED], [4, STATE.LOADED]]);
  writes = 0;
  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return "MV-07B0"; }
  async restart() {}
  async tableAddr(obj: number) { return obj === 4 ? BASE : 0x100 * obj; }
  async memRead(addr: number, len: number) { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = this.mem.get(addr + i) ?? 0; return b; }
  async writesConfirmed() { return false; }
  async memWrite(addr: number, data: Buffer) { this.writes++; for (let i = 0; i < data.length; i++) this.mem.set(addr + i, data[i]); }
  async propRead(obj: number, pid: number) { if (pid === 5) return Buffer.from([this.state.get(obj) ?? STATE.UNLOADED]); if (pid === 7) return Buffer.from([0, 0, (await this.tableAddr(obj)) >> 8, (await this.tableAddr(obj)) & 0xff]); return Buffer.alloc(0); }
  async propReadIfPresent() { return null; }
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

describe("System B parameter flash on a device whose bytes already match", () => {
  test("LSM 4 LOADED: unchanged, nothing written", async () => {
    const dev = seeded();
    const res = await classify(cfg).flashParameters(asDev(dev), "07B0", ctx);
    expect(res.kind).toBe("unchanged");
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
