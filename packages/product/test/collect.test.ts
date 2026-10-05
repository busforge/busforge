import { test, expect, describe, afterEach } from "bun:test";
import { KnxDevice, APCI } from "@busforge/knx";
import { collectDevice, planForMask, unreadableReason, CollectCancelled, COLLECT_LIMITS, type CollectPackage, type CollectRecord } from "../src/index.ts";
import { SimSystemB, ALLOWED_APCIS } from "./collect-sim.ts";

function setup() {
  const sim = new SimSystemB();
  const dev = new KnxDevice(sim, "1.1.203");
  let reopened = 0;
  const reopen = async () => { reopened++; await dev.disconnect(); await dev.connect(); };
  return { sim, dev, reopen, reopened: () => reopened };
}
const ctl = () => new AbortController();
const memRecords = (p: CollectPackage, step: string) => p.records.filter((r) => r.step === step && (r.space === "memory" || r.space === "memory-extended"));
const bytesAt = (sim: SimSystemB, address: number, length: number) => Buffer.from(Array.from({ length }, (_, i) => sim.memory(address + i))).toString("hex");

afterEach(() => { delete process.env.KNX_TRIES; });

describe("raw acquisition on a System B device", () => {
  test("reads identity, scan and planned ranges, sends only read services, and records refusals exactly", async () => {
    const { sim, dev, reopen } = setup();
    await dev.connect();
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop).toBeNull();
    expect(p.limits).toEqual([]);
    expect(p.mask).toBe("MV-07B0");
    expect(p.authorizeLevel).toBe(0);
    expect(p.maxApdu).toBe(55);
    for (const a of sim.apcis) expect(ALLOWED_APCIS.has(a)).toBe(true);
    // The security-mode read is the session's last request.
    expect(sim.apcis[sim.apcis.length - 1]).toBe(APCI.FUNCTION_PROPERTY_EXT_STATE_READ);

    // Address table: one classic range, every byte the device's.
    const t1 = memRecords(p, "group address table");
    expect(t1.map((r) => [r.target.address, r.target.length, r.outcome])).toEqual([[0x5000, 10, "bytes"]]);
    expect(t1[0].bytes).toBe(bytesAt(sim, 0x5000, 10));
    // Association table above 0xFFFF: extended reads.
    const t2 = memRecords(p, "association table");
    expect(t2.every((r) => r.space === "memory-extended" && r.outcome === "bytes")).toBe(true);
    expect(t2.reduce((n, r) => n + Number(r.target.length), 0)).toBe(60);
    // A table whose load state is not Loaded is not read, and says why.
    expect(memRecords(p, "group object table")).toMatchObject([{ outcome: "not-attempted", detail: expect.stringContaining("not Loaded") }]);
    // The application segment has one refused byte: recorded alone, the bytes around it kept.
    const app = memRecords(p, "application");
    const refused = app.filter((r) => r.outcome === "refused");
    expect(refused.map((r) => [r.target.address, r.target.length])).toEqual([[0x5105, 1]]);
    const covered = app.reduce((n, r) => n + Number(r.target.length), 0);
    expect(covered).toBe(30);
    for (const r of app.filter((r) => r.outcome === "bytes")) expect(r.bytes).toBe(bytesAt(sim, Number(r.target.address), Number(r.target.length)));
    // A PEI program without a table reference is not attempted.
    expect(memRecords(p, "PEI program")).toMatchObject([{ outcome: "not-attempted" }]);

    // The scan: the security object's values are never read, PID 23 is read in batches.
    expect(p.records.filter((r) => r.step === "scan" && r.target.object === 6 && r.space === "property" && r.outcome !== "not-attempted")).toHaveLength(1); // its object type
    const pid23 = p.records.filter((r) => r.step === "scan" && r.target.object === 2 && r.target.pid === 23 && r.outcome === "bytes");
    expect(pid23.reduce((n, r) => n + (r.bytes!.length / 2), 0)).toBe(2 + 20 * 4);
    expect(pid23.some((r) => Number(r.target.count) > 1)).toBe(true);
    // Absent identity properties are refused with count 0, not taken as empty values.
    expect(p.records.find((r) => r.step === "identity" && r.target.pid === 15)).toMatchObject({ outcome: "refused" });
  });

  test("a session without the free-key authorize sends none and says so", async () => {
    const { sim, dev, reopen } = setup();
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen, authorize: false });
    expect(sim.apcis).not.toContain(APCI.AUTHORIZE_REQUEST);
    expect(p.authorizeLevel).toBeNull();
    expect(p.records.filter((r) => r.space === "authorize")).toMatchObject([{ outcome: "not-attempted", detail: expect.stringContaining("without the free-key authorize") }]);
    expect(p.stop).toBeNull();
  });

  test("refused elements: a refused batch is asked again singly, and the first refused element ends the property", async () => {
    const { sim, dev, reopen } = setup();
    sim.refuseElementsFrom.set("2:23", 5);
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    const pid23 = p.records.filter((r) => r.step === "scan" && r.target.object === 2 && r.target.pid === 23);
    expect(pid23.filter((r) => r.outcome === "bytes").map((r) => [r.target.start, r.target.count])).toEqual([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]]);
    expect(pid23.filter((r) => r.outcome === "refused").map((r) => [r.target.start, r.target.count])).toEqual([[2, 11], [5, 1]]);
    expect(pid23.at(-1)).toMatchObject({ outcome: "not-attempted", target: { start: 6, count: 15 } });
    expect(p.stop).toBeNull();
  });

  test("a device answering fewer elements than asked: the next request starts after the last it gave", async () => {
    const { sim, dev, reopen } = setup();
    sim.maxElementsPerAnswer = 3;
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    const pid23 = p.records.filter((r) => r.step === "scan" && r.target.object === 2 && r.target.pid === 23 && r.outcome === "bytes" && Number(r.target.start) > 0);
    // Elements 1 to 20, each exactly once, in order.
    const got = pid23.flatMap((r) => Array.from({ length: Number(r.target.count) }, (_, i) => Number(r.target.start) + i));
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("an object whose type is not known is not read, since it may be the security object", async () => {
    const { sim, dev, reopen } = setup();
    sim.objects[6].props.get(1)!.elements[0] = Buffer.from([0x11]); // one octet: not a type
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    const values = p.records.filter((r) => r.step === "scan" && r.target.object === 6 && r.space === "property" && r.target.pid !== 1);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((r) => r.outcome === "not-attempted" && r.detail!.includes("type is not known"))).toBe(true);
  });

  test("a descriptor answer that is no type 0 descriptor stops the job as such", async () => {
    const { sim, dev, reopen } = setup();
    sim.descriptorData = Buffer.from([0x07]);
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop?.reason).toBe("descriptor-malformed");
    expect(p.mask).toBeNull();
  });

  test("answers for the wrong address count as failures and reopen the link", async () => {
    const { sim, dev, reopen, reopened } = setup();
    sim.echoOffset = 1;
    // A table long enough for several requests in a row.
    sim.objects[1].props.get(27)!.elements[0] = Buffer.from([0, 0, 0, 200, 0, 0, 0x12, 0x34]);
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop?.reason).toBe("unresponsive");
    expect(p.records.filter((r) => r.outcome === "malformed")).toHaveLength(3);
    expect(reopened()).toBe(2);
  });

  test("a secure device without a key: the descriptor and nothing else", async () => {
    const { sim, dev, reopen } = setup();
    sim.mask = "ffff";
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop?.reason).toBe("secured-no-key");
    expect(sim.apcis).toEqual([APCI.DEVICE_DESCRIPTOR_READ]);
  });

  test("the bounds a user is told about: ten minutes and three failures in a row; no request counts", () => {
    expect(COLLECT_LIMITS.durationMs).toBe(10 * 60_000);
    expect(COLLECT_LIMITS.failuresInARow).toBe(3);
    expect(Object.keys(COLLECT_LIMITS)).not.toContain("scanRequests");
    expect(Object.keys(COLLECT_LIMITS)).not.toContain("memoryRequests");
    // The memory guard is far above what ten minutes can read (about 4 requests a second, 48 bytes each).
    expect(COLLECT_LIMITS.memoryBytes).toBeGreaterThan(4 * 48 * 600);
  });

  test("the memory budget cuts the plan and records the rest as not attempted", async () => {
    const { dev, reopen } = setup();
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen, limits: { memoryBytes: 20 } });
    expect(p.limits).toEqual(["memory plan: 20 bytes"]);
    expect(p.counts.memoryBytes).toBe(20);
    const assoc = memRecords(p, "association table");
    expect(assoc.at(-1)).toMatchObject({ outcome: "not-attempted", detail: expect.stringContaining("memory budget") });
  });

  test("a cancelled job drops everything it read", async () => {
    const { dev, reopen } = setup();
    const c = ctl();
    const run = collectDevice(dev, { ia: "1.1.203", signal: c.signal, reopen, onProgress: (phase) => { if (phase === "scan") c.abort(); } });
    expect(await run.then(() => null, (e: unknown) => e)).toBeInstanceOf(CollectCancelled);
  });

  test("a cancel after the last request drops the package too", async () => {
    const { sim, dev, reopen } = setup();
    const c = ctl();
    sim.mask = "ffff"; // stops after the descriptor
    const run = collectDevice(dev, { ia: "1.1.203", signal: c.signal, reopen, onRequest: () => c.abort() });
    expect(await run.then(() => null, (e: unknown) => e)).toBeInstanceOf(CollectCancelled);
  });

  test("a cancel during a request that fails opens no new link and drops the package", async () => {
    process.env.KNX_TRIES = "1";
    const { sim, dev, reopen, reopened } = setup();
    const c = ctl();
    sim.silent = (a) => { if (a === APCI.MEMORY_READ) { c.abort(); return true; } return false; };
    const run = collectDevice(dev, { ia: "1.1.203", signal: c.signal, reopen });
    expect(await run.then(() => null, (e: unknown) => e)).toBeInstanceOf(CollectCancelled);
    expect(reopened()).toBe(0);
  }, 20_000);

  test("a stopped job keeps its package; only a cancel drops it", async () => {
    const { sim, dev, reopen } = setup();
    sim.mask = "ffff";
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop?.reason).toBe("secured-no-key");
    expect(p.records).toHaveLength(1);
  });

  test("a table reference outside the 24-bit address space is not attempted, and the job goes on", async () => {
    const { sim, dev, reopen } = setup();
    const ref = Buffer.alloc(4); ref.writeUInt32BE(0x01000000);
    sim.objects[1].props.get(7)!.elements[0] = ref;
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop).toBeNull();
    expect(memRecords(p, "group address table")).toMatchObject([{ outcome: "not-attempted", detail: expect.stringContaining("24-bit") }]);
    expect(memRecords(p, "association table").some((r) => r.outcome === "bytes")).toBe(true);
  });

  test("the duration bound stops the job", async () => {
    const { dev, reopen } = setup();
    let t = 0;
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen, now: () => (t += 1000), limits: { durationMs: 30_000 } });
    expect(p.stop?.reason).toBe("duration");
  });

  test("the authorize on a reopened link does not reset the count of failed requests", async () => {
    process.env.KNX_TRIES = "1";
    const { sim, dev, reopen, reopened } = setup();
    sim.silent = (a) => a === APCI.MEMORY_READ;
    // A table long enough for several requests in a row.
    sim.objects[1].props.get(27)!.elements[0] = Buffer.from([0, 0, 0, 200, 0, 0, 0x12, 0x34]);
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop?.reason).toBe("unresponsive");
    expect(p.records.filter((r) => r.outcome === "timeout").map((r) => r.space)).toEqual(["memory", "memory", "memory"]);
    expect(reopened()).toBe(2);
    expect(p.records.filter((r) => r.step === "authorize" && r.detail === "again, on the reopened connection")).toHaveLength(2);
  }, 20_000);

  test("three failed requests in a row close the device off; each failure reopens the link first", async () => {
    process.env.KNX_TRIES = "1";
    const { sim, dev, reopen, reopened } = setup();
    // The device goes quiet at its first memory read and stays so.
    let gone = false;
    sim.silent = (a) => (gone ||= a === APCI.MEMORY_READ);
    const p = await collectDevice(dev, { ia: "1.1.203", signal: ctl().signal, reopen });
    expect(p.stop?.reason).toBe("unresponsive");
    const timeouts = p.records.filter((r: CollectRecord) => r.outcome === "timeout");
    // The memory read, then the authorize on each reopened link.
    expect(timeouts.map((r) => r.space)).toEqual(["memory", "authorize", "authorize"]);
    expect(reopened()).toBe(2);
    // What was not reached stays visible in the plan the package carries.
    expect(p.plan?.tables.length).toBe(5);
  }, 20_000);
});

describe("raw acquisition plans", () => {
  test("BCU1: no authorize, no interface objects, the EEPROM segment and the run status", () => {
    const p = planForMask("MV-0012");
    expect(p.authorize).toBe(false);
    expect(p.objects).toBe("none");
    expect(p.memory.map((m) => [m.address, m.length])).toEqual([[0x60, 1], [0x100, 256]]);
  });

  test("M112: the product XML places the parameter segments, and without it they are named as not attempted", () => {
    expect(planForMask("MV-0705").notAttempted.map((n) => n.name)).toContain("application segments");
    const segs = [{ id: "S1", address: 0x4400, size: 32, data: Buffer.alloc(0) }];
    const p = planForMask("MV-0705", { mask: "MV-0705", absoluteSegments: segs });
    expect(p.memory.find((m) => m.source === "product-xml")).toMatchObject({ address: 0x4400, length: 32 });
    // An application for another mask (a device another tool reprogrammed) places nothing.
    const other = planForMask("MV-0705", { mask: "MV-0701", absoluteSegments: segs });
    expect(other.memory.some((m) => m.source === "product-xml")).toBe(false);
    expect(other.notAttempted.find((n) => n.name === "application segments")?.reason).toContain("MV-0701");
    expect(planForMask("MV-0705", { unavailable: "PARAM_BYTE_ORDER_UNSUPPORTED" }).notAttempted.find((n) => n.name === "application segments")?.reason).toContain("PARAM_BYTE_ORDER_UNSUPPORTED");
  });

  test("an unknown mask gets the descriptor and a probing scan, nothing else", () => {
    const p = planForMask("MV-4711");
    expect(p).toMatchObject({ objects: "probe", authorize: false, memory: [], tables: [] });
  });

  test("ranges that touch a location the master data marks unreadable are refused", () => {
    const seg = [{ address: 0, length: 0x10000 }];
    expect(unreadableReason("MV-0705", { address: 0x0100, length: 16 }, seg)).toContain("unreadable");
    expect(unreadableReason("MV-0700", { address: 0x0101, length: 1 }, seg)).toBeNull();
    expect(unreadableReason("MV-0700", { address: 0x0101, length: 2 }, seg)).toContain("unreadable");
    expect(unreadableReason("MV-0705", { address: 0x3ff0, length: 32 }, [{ address: 0x4000, length: 8192 }])).toContain("outside");
    // A range across two adjacent declared segments lies inside them (the ABB US/U 4.2's AS-4600).
    const m112 = [{ address: 0x4000, length: 8192 }, { address: 0x6000, length: 22016 }, { address: 0xb800, length: 2048 }];
    expect(unreadableReason("MV-0701", { address: 0x4600, length: 7790 }, m112)).toBeNull();
    expect(unreadableReason("MV-0701", { address: 0xb500, length: 0x400 }, m112)).toContain("outside");
  });
});
