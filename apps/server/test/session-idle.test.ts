import { test, expect, mock, afterAll, describe, jest } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnxDevice, PID, STATE, VERIFY_MODE, APCI, parseApdu, tpAck, crc16Ccitt, type KnxTransport } from "@busforge/knx";
import { buildComObjectTable, declaredPropChecks, programIdStamp, type FlashResult } from "@busforge/product";
import { catalogueXml } from "../../../tools/corpus.ts";
import { corpusDescribe } from "../../../tools/corpus-test.ts";
import { SimSystemB, systemBObjects } from "../../../packages/product/test/collect-sim.ts";
import type { Connection } from "../src/db/connections.ts";

// A device closes a transport connection that carries no request for the transport layer's connection
// timeout (6 s), and a read or a write then goes out again on a new connection, after a pause, or fails on
// DEVICE_CLOSED_CONNECTION where the connection carried an A_Restart. A step that builds or
// decodes from a large application takes seconds on a slow host, so none may run inside a device session.
// Here every such step (the application's parse, its model, the image builds, the configuration and the
// decoding of an image, and the read-back's configuration callback) moves a virtual clock on by 7 s, and
// the device emulated on the transport closes its connection when the next frame comes later than 6 s
// on that clock after the one before. The real session envelope runs every operation against it.
const SLOW_MS = 7_000, IDLE_CLOSE_MS = 6_000;
let slow = false;
let lag = 0;
const now = () => performance.now() + lag;
const slowed = <F extends (...a: never[]) => unknown>(f: F) => ((...a: Parameters<F>) => { if (slow) lag += SLOW_MS; return f(...a); }) as F;

const appconfig = await import("../../../packages/product/src/appconfig.ts");
const application = await import("../../../packages/product/src/application.ts");
const deviceimage = await import("../../../packages/product/src/deviceimage.ts");
const config = await import("../../../packages/product/src/config.ts");
const image = await import("../../../packages/product/src/image.ts");
await mock.module("../../../packages/product/src/appconfig.ts", () => ({ ...appconfig, parseAppConfig: slowed(appconfig.parseAppConfig) }));
await mock.module("../../../packages/product/src/application.ts", () => ({ ...application, toAppModel: slowed(application.toAppModel) }));
await mock.module("../../../packages/product/src/deviceimage.ts", () => ({
  ...deviceimage, buildRelativeSegmentTarget: slowed(deviceimage.buildRelativeSegmentTarget), buildAbsoluteSegmentTargets: slowed(deviceimage.buildAbsoluteSegmentTargets),
}));
await mock.module("../../../packages/product/src/config.ts", () => ({ ...config, buildDeviceConfig: slowed(config.buildDeviceConfig) }));
await mock.module("../../../packages/product/src/image.ts", () => ({
  ...image, decodeParameterImage: slowed(image.decodeParameterImage), decodeAbsoluteImage: slowed(image.decodeAbsoluteImage),
}));

// A System B unit holding loaded, empty group tables, the com-object table of `comObjTable` and a zeroed
// parameter segment, closing its connection after IDLE_CLOSE_MS without a frame. `closed` records each
// closure with the silence that caused it. It takes writes as a device does: memory (answered in verify
// mode), the load-state events (an allocation places the segment, a LoadCompleted of the parameter
// segment sets its CRC), every other property; A_Restart reboots it, silent for REBOOT_MS with its
// connection gone.
const COM_OBJ_AT = 0x6000, REBOOT_MS = 3_000;
const SEGMENT_AT: Record<number, number> = { 1: 0x5000, 2: 0x5010, 3: COM_OBJ_AT, 4: 0x5100 };
let comObjTable: Buffer = Buffer.from([0, 0]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
class IdleClosingUnit extends SimSystemB {
  closed: number[] = [];
  sessions = 0;
  restarts = 0;
  private connected = false;
  private last = 0;
  private rebootUntil = 0;
  private written = new Map<number, number>();
  private allocated = new Map<number, number>();
  constructor() {
    super();
    const loaded = { pdt: 0x0a, readLevel: 3, elements: [Buffer.from([1])] };
    const table = (at: number) => ({ pdt: 0x13, readLevel: 3, elements: [u32(at)] });
    const objects = systemBObjects();
    objects[1].props.set(5, loaded); objects[1].props.set(7, table(0x5000));
    objects[2].props.set(5, loaded); objects[2].props.set(7, table(0x5010));
    objects[3].props.set(5, loaded); objects[3].props.set(7, table(COM_OBJ_AT));
    objects[4].props.set(5, loaded); objects[4].props.set(7, table(0x5100));
    objects[0].props.set(PID.DEVICE_CONTROL, { pdt: 0x02, readLevel: 3, elements: [Buffer.from([0])] });
    this.objects = objects;
    this.refused = new Set();
  }
  override memory(a: number): number { return this.written.get(a) ?? comObjTable[a - COM_OBJ_AT] ?? 0; }
  override async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    const t = now();
    if (t < this.rebootUntil) return;
    if (tpdu[0] === 0x80) { this.connected = true; this.sessions++; this.last = t; return; }
    // The disconnect after an operation's last request counts too: a build between that request and the
    // next one (the first write of a flash that is not a dry run) would have lost the connection.
    if (tpdu[0] === 0x81) { if (this.connected && t - this.last > IDLE_CLOSE_MS) this.closed.push(Math.round(t - this.last)); this.connected = false; return; }
    if (!this.connected) return;
    if (t - this.last > IDLE_CLOSE_MS) {
      this.closed.push(Math.round(t - this.last));
      this.connected = false;
      const from = cemi.readUInt16BE(6);
      queueMicrotask(() => this.onCemi?.(from, this.assignedIa, Buffer.from([0x81]), false));
      return;
    }
    this.last = t;
    if (this.takeWrite(cemi, tpdu, t)) return;
    return super.sendCemi(cemi);
  }
  private takeWrite(cemi: Buffer, tpdu: Buffer, t: number): boolean {
    const p = parseApdu(tpdu);
    if (p.control) return false;
    const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
    const from = cemi.readUInt16BE(6);
    const reply = (out: number, data: Buffer, low = 0) => {
      const a = Buffer.concat([Buffer.from([0x40 | (p.seq << 2) | ((out >> 8) & 0x03), (out & 0xff) | low]), data]);
      queueMicrotask(() => { this.onCemi?.(from, this.assignedIa, tpAck(p.seq), false); this.onCemi?.(from, this.assignedIa, a, false); });
    };
    const d = p.data;
    if ((apci & 0x3c0) === APCI.RESTART) {
      this.restarts++; this.connected = false; this.rebootUntil = t + REBOOT_MS;
      return true;
    }
    if ((apci & 0x3c0) === APCI.MEMORY_WRITE) {
      const n = apci & 0x3f, at = d.readUInt16BE(0);
      for (let i = 0; i < n; i++) this.written.set(at + i, d[2 + i]);
      if ((this.objects[0].props.get(PID.DEVICE_CONTROL)?.elements[0]?.[0] ?? 0) & VERIFY_MODE) reply(APCI.MEMORY_RESPONSE, Buffer.from(d.subarray(0, 2 + n)), n);
      else queueMicrotask(() => this.onCemi?.(from, this.assignedIa, tpAck(p.seq), false));
      return true;
    }
    if (apci !== APCI.PROPERTY_WRITE) return false;
    const [o, pid] = d;
    const value = Buffer.from(d.subarray(4));
    const props = this.objects[o].props;
    const set = (k: number, v: Buffer, pdt = 0x11) => props.set(k, { pdt: props.get(k)?.pdt ?? pdt, readLevel: 3, elements: [v] });
    if (pid === PID.LOAD_STATE_CONTROL) {
      const state = (v: number) => set(5, Buffer.from([v]), 0x0a);
      if (value[0] === 1) state(STATE.LOADING);
      else if (value[0] === 4) state(STATE.UNLOADED);
      else if (value[0] === 3 && value[1] === 0x0b) { this.allocated.set(o, value.readUInt32BE(2)); set(7, u32(SEGMENT_AT[o]), 0x13); }
      else if (value[0] === 2) {
        state(STATE.LOADED);
        const size = this.allocated.get(o) ?? props.get(27)?.elements[0]?.readUInt32BE(0);
        if (o === 4 && size !== undefined) {
          const segment = Buffer.from(Array.from({ length: size }, (_, i) => this.memory(SEGMENT_AT[4] + i)));
          set(27, Buffer.concat([u32(size), Buffer.from([0, 0]), Buffer.from([crc16Ccitt(segment) >> 8, crc16Ccitt(segment) & 0xff])]), 0x1b);
        }
      }
      reply(APCI.PROPERTY_RESPONSE, Buffer.concat([d.subarray(0, 4), props.get(5)!.elements[0]]));
      return true;
    }
    set(pid, value);
    reply(APCI.PROPERTY_RESPONSE, Buffer.concat([d.subarray(0, 4), value]));
    return true;
  }
}

let unit: IdleClosingUnit | null = null;
const transport = await import("../src/transport.ts");
const realMake = transport.makeTransport;
await mock.module("../src/transport.ts", () => ({ ...transport, makeTransport: (c: Connection): KnxTransport => unit ?? realMake(c) }));
const ops = await import("../src/deviceprofile.ts");
afterAll(() => { unit = null; slow = false; });

const dir = mkdtempSync(join(tmpdir(), "busforge-session-idle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// A System B application with a parameter segment, offering every read and write.
const appXml = readFileSync(join(import.meta.dir, "..", "..", "..", "packages", "product", "test", "fixtures", "sample-grid-app.xml"), "utf8");
{
  const view = config.buildDeviceConfig(appconfig.parseAppConfig(appXml), new Map());
  comObjTable = buildComObjectTable(view.imageComObjects, view.maxComObjectNumber, new Set());
}
const connection: Connection = { id: "c", name: "GW", type: "ip", host: "198.51.100.10", port: 3671, ipTransport: "udp", usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0 };
const scope = { projectId: "p", dataDir: dir, ia: "1.1.10", connection, deviceId: "d" };
const params = new Map<string, string>();
// Every operation runs with the slow steps slowed and a fresh unit; it returns the unit with the result.
async function onUnit<T>(run: () => Promise<T>): Promise<{ result: T; unit: IdleClosingUnit }> {
  const u = new IdleClosingUnit();
  unit = u; lag = 0; slow = true;
  try { return { result: await run(), unit: u }; } finally { slow = false; unit = null; }
}

test("the emulated unit closes a connection left without a frame for 6 s, and the next request goes out again on a new connection", async () => {
  const u = new IdleClosingUnit();
  const dev = new KnxDevice(u, "1.1.10", undefined, { reconnectGapMs: 10 });
  await dev.connect();
  expect(await dev.deviceDescriptor()).toBe("MV-07B0");
  lag += SLOW_MS;
  await dev.propRead(4, 7);
  expect(u.closed).toEqual([expect.any(Number)]);
  expect(u.closed[0]).toBeGreaterThan(IDLE_CLOSE_MS);
  expect(u.sessions).toBe(2);
});

test("a read-back decodes after its session, and the checks of a never-programmed unit's read run each in a session of its own", async () => {
  const app = appconfig.parseAppConfig(appXml);
  const configFor = slowed((values: Map<string, string>) => {
    const view = config.buildDeviceConfig(app, values);
    return { shown: new Set<string>(), active: new Set(view.imageValues.keys()), values: view.imageValues };
  });
  const { result, unit: u } = await onUnit(() => ops.readDeviceState({ ...scope, appXml, liveParams: params, baseParams: params, configFor, holds: true }));
  expect(u.closed).toEqual([]);
  expect(result).toMatchObject({ paramsRead: true, linksRead: true, loaded: true });
  expect(result.imageRefused).toBeUndefined();
  expect(typeof result.imageMatches).toBe("boolean");
  // The read, then the parameter dry run, then (where that finds nothing to write) the group-address one.
  expect(u.sessions).toBe(result.imageMatches === null ? 1 : 2 + (result.imageMatches ? 1 : 0));
});

test("a parameter flash builds its image before the session opens", async () => {
  const { result, unit: u } = await onUnit(() => ops.flashDeviceParameters({ ...scope, appXml, params, baseParams: params, dryRun: true }));
  expect(u.closed).toEqual([]);
  expect(["dryRun", "unchanged"]).toContain(result.kind);
});

test("a group-address flash builds its tables before the session opens", async () => {
  const { result, unit: u } = await onUnit(() => ops.flashDeviceGroupAddresses({ ...scope, appXml, params, baseParams: params, links: [], dryRun: true, comObjectOverrides: new Map(), comObjectOverrideBase: new Map() }));
  expect(u.closed).toEqual([]);
  expect(["dryRun", "unchanged"]).toContain(result.kind);
});

test("a structural flash builds its images before the session opens", async () => {
  const { result, unit: u } = await onUnit(() => ops.flashDeviceStructure({ ...scope, appXml, params, baseParams: params, links: [], dryRun: true, comObjectOverrides: new Map(), comObjectOverrideBase: new Map() }));
  expect(u.closed).toEqual([]);
  expect(["dryRun", "unchanged"]).toContain(result.kind);
});

test("a full download builds its image before the session opens", async () => {
  // With the backup before the unload, the device is read after the image is built.
  const { result, unit: u } = await onUnit(() => ops.downloadDeviceFull({ ...scope, appXml, params, links: [], dryRun: true, backupBeforeUnload: true, comObjectOverrides: new Map() }));
  expect(u.closed).toEqual([]);
  expect(result.kind).toBe("dryRun");
});

// The writes themselves, through the closing restart, the reconnect and the read-back that verifies
// them. Timers are faked (the waits for the device's reboot and the full download's settle cost no real
// time), and the unit's clock runs on them.
async function onFakeClock<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; !done && i < 200_000; i++) {
    await new Promise((r) => setImmediate(r));
    if (!done && jest.getTimerCount() > 0) jest.advanceTimersToNextTimer();
  }
  return p;
}
async function writeOnUnit<T>(run: () => Promise<T>): Promise<{ result: T; unit: IdleClosingUnit }> {
  jest.useFakeTimers();
  try { return await onUnit(() => onFakeClock(run())); } finally { jest.useRealTimers(); }
}
const link = [{ comObjNum: 1, gaRaws: [0x0901] }];
const written = (result: FlashResult, u: IdleClosingUnit) => {
  expect(u.closed).toEqual([]);
  expect(result).toMatchObject({ kind: "flashed", verified: true });
  expect((result as { diffBytes: number }).diffBytes).toBeGreaterThan(0);
  expect(u.restarts).toBe(1);
};

describe("a write keeps no connection idle, through its restart and its verification", () => {
  test("a parameter flash", async () => {
    const { result, unit: u } = await writeOnUnit(() => ops.flashDeviceParameters({ ...scope, appXml, params, baseParams: params, dryRun: false }));
    written(result, u);
  });
  test("a group-address flash", async () => {
    const { result, unit: u } = await writeOnUnit(() => ops.flashDeviceGroupAddresses({ ...scope, appXml, params, baseParams: params, dryRun: false, links: link, comObjectOverrides: new Map(), comObjectOverrideBase: new Map() }));
    written(result, u);
  });
  test("a structural flash", async () => {
    const { result, unit: u } = await writeOnUnit(() => ops.flashDeviceStructure({ ...scope, appXml, params, baseParams: params, dryRun: false, links: link, comObjectOverrides: new Map(), comObjectOverrideBase: new Map() }));
    written(result, u);
  });
  test("a full download closed with the restart at once", async () => {
    const { result, unit: u } = await writeOnUnit(() => ops.downloadDeviceFull({ ...scope, appXml, params, dryRun: false, links: link, comObjectOverrides: new Map() }));
    written(result, u);
  });
  // thelsing/OpenKNX (manufacturer 0x00FA): the download is left alone for its save timer before the restart.
  test("a full download that waits for the device's save before its restart", async () => {
    const openKnx = appXml.replaceAll("M-TEST", "M-00FA");
    const { result, unit: u } = await writeOnUnit(() => ops.downloadDeviceFull({ ...scope, appXml: openKnx, params, dryRun: false, links: link, comObjectOverrides: new Map() }));
    written(result, u);
  });
});

test("an operation refused before it needs the device opens no session", async () => {
  const { result, unit: u } = await onUnit(() => ops.flashDeviceParameters({ ...scope, appXml, params: new Map([["M-NOPE_A-1_P-1_R-1", "1"]]), baseParams: params, dryRun: true }).catch((e: { code?: string }) => e));
  expect((result as { code?: string }).code).toBeDefined();
  expect(u.sessions).toBe(0);
});

test("a device of another mask fails the session at its first request", async () => {
  const { result, unit: u } = await onUnit(async () => {
    unit!.mask = "0705";
    return ops.readDeviceState({ ...scope, appXml, liveParams: params, baseParams: params }).catch((e: { code?: string }) => e);
  });
  expect((result as { code?: string }).code).toBe("MASK_MISMATCH");
  expect(u.sessions).toBe(1);
});

test("a device whose session opens at its first request holds its settings until then and refuses any other use before it", async () => {
  let opens = 0;
  const real = new KnxDevice(new IdleClosingUnit(), "1.1.10");
  const { dev } = ops.openedOnFirstRequest(async () => { opens++; await real.connect(); return { dev: real }; }, false, false);
  dev.setExtendedMemoryServices(true);
  dev.acceptUnprovenRestart(true);
  dev.clearConfirmedWrites();
  expect(dev.confirmedWrites()).toEqual([]);
  expect([dev.restartUnproven, dev.secured, dev.overUsb]).toEqual([false, false, false]);
  expect((dev as unknown as { then?: unknown }).then).toBeUndefined();
  expect(() => (dev as unknown as { timeouts: unknown }).timeouts).toThrow("before the device session opened");
  expect(opens).toBe(0);
  expect(await dev.deviceDescriptor()).toBe("MV-07B0");
  expect(await dev.propRead(4, 5)).toEqual(Buffer.from([1]));
  expect(opens).toBe(1);
  expect((real as unknown as { extendedMemory: boolean }).extendedMemory).toBe(true);
});

test("a failed opening fails every request after it without opening again", async () => {
  let opens = 0;
  const lazy = ops.openedOnFirstRequest(async () => { opens++; throw Object.assign(new Error("refused"), { code: "MASK_MISMATCH" }); }, false, false);
  expect(await lazy.dev.propRead(4, 5).catch((e: unknown) => e)).toMatchObject({ code: "MASK_MISMATCH" });
  expect(await lazy.dev.memRead(0, 1).catch((e: unknown) => e)).toMatchObject({ code: "MASK_MISMATCH" });
  expect(opens).toBe(1);
  expect(lazy.failure()?.error).toMatchObject({ code: "MASK_MISMATCH" });
});

// System 7 (property-mapped MV-0705): the MDT BE-06001.02, its declared checks answered as the application
// expects, its load-state machines loaded, its memory zero.
corpusDescribe("System 7: every build runs before the session opens", () => {
  const s7Xml = catalogueXml("M-0083_A-00B4-32-3919.xml.gz");
  const s7 = appconfig.parseAppConfig(s7Xml);
  const s7Unit = () => {
    const u = new IdleClosingUnit();
    u.mask = "0705";
    for (const c of declaredPropChecks(s7.loadProcedures, "par")) u.objects[c.obj].props.set(c.pid, { pdt: 0x11, readLevel: 3, elements: [c.expect] });
    u.objects[3].props.set(13, { pdt: 0x11, readLevel: 3, elements: [programIdStamp(s7)] });
    return u;
  };
  const on = async <T>(run: () => Promise<T>) => {
    const u = s7Unit();
    unit = u; lag = 0; slow = true;
    try { return { result: await run(), unit: u }; } finally { slow = false; unit = null; }
  };
  const s7Scope = { ...scope, appXml: s7Xml, params, baseParams: params, dryRun: true };

  test("a read-back", async () => {
    const { result, unit: u } = await on(() => ops.readDeviceState({ ...s7Scope, liveParams: params }));
    expect(u.closed).toEqual([]);
    expect(result).toMatchObject({ paramsRead: true, linksRead: true });
  });
  test("a parameter flash", async () => {
    const { result, unit: u } = await on(() => ops.flashDeviceParameters(s7Scope));
    expect(u.closed).toEqual([]);
    expect(["dryRun", "unchanged"]).toContain(result.kind);
  });
  test("a group-address flash", async () => {
    const { result, unit: u } = await on(() => ops.flashDeviceGroupAddresses({ ...s7Scope, links: [], comObjectOverrides: new Map(), comObjectOverrideBase: new Map() }).catch((e: { code?: string }) => e));
    expect(u.closed).toEqual([]);
    expect((result as { code?: string }).code).not.toBe("DEVICE_CLOSED_CONNECTION");
  });
  test("a structural flash", async () => {
    const { result, unit: u } = await on(() => ops.flashDeviceStructure({ ...s7Scope, links: [], comObjectOverrides: new Map(), comObjectOverrideBase: new Map() }).catch((e: { code?: string }) => e));
    expect(u.closed).toEqual([]);
    expect((result as { code?: string }).code).not.toBe("DEVICE_CLOSED_CONNECTION");
  });
  test("a full download", async () => {
    const { result, unit: u } = await on(() => ops.downloadDeviceFull({ ...s7Scope, links: [], backupBeforeUnload: true, comObjectOverrides: new Map() }).catch((e: { code?: string }) => e));
    expect(u.closed).toEqual([]);
    expect((result as { code?: string }).code).not.toBe("DEVICE_CLOSED_CONNECTION");
  });
});
