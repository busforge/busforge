import { test, expect, describe } from "bun:test";
import { KnxDevice, readSecurityMode } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// A device that, before it answers a request of the new connection, sends a numbered answer of another
// service: its A_Memory_Response (one byte at 0x44A5, value 0x08) to a write of a connection whose
// tunnel closed before it acknowledged that answer, repeated under the old connection's sequence
// number `staleSeq`. Then it answers the request itself, numbering from 0 as a new connection does.
class StaleAnswerDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly device = 0x1203; // 1.2.3
  private txSeq = 0;
  private staleSent = false;
  acksSeen: number[] = [];
  constructor(private readonly staleSeq: number) {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(this.device, this.assignedIa, tpdu, false)); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) return; // T_Connect / T_Disconnect
    const p = parseApdu(cemi.subarray(9));
    if (p.control) { this.acksSeen.push(p.seq); return; }
    this.send(tpAck(p.seq));
    if (!this.staleSent) {
      this.staleSent = true;
      this.send(apdu(this.staleSeq, APCI.MEMORY_RESPONSE, Buffer.from([0x44, 0xa5, 0x08]), 1));
    }
    if ((p.apci & 0x3c0) === APCI.DEVICE_DESCRIPTOR_READ) this.answer(apdu(this.txSeq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0x05])));
    else if (p.apci === APCI.PROPERTY_READ) this.answer(apdu(this.txSeq, APCI.PROPERTY_RESPONSE, Buffer.from([p.data[0], p.data[1], 0x10, 0x01, 0x2a])));
  }
  private answer(tpdu: Buffer) { this.txSeq = (this.txSeq + 1) & 0x0f; this.send(tpdu); }
}

describe("a numbered answer of another service than the one asked for", () => {
  for (const staleSeq of [5, 0]) {
    test(`is acknowledged and not taken as the device descriptor (its sequence number ${staleSeq})`, async () => {
      const tun = new StaleAnswerDevice(staleSeq);
      const dev = new KnxDevice(tun, "1.2.3");
      await dev.connect();
      expect(await dev.deviceDescriptor()).toBe("MV-0705");
      // Both data frames are acknowledged, each under its own number.
      expect(tun.acksSeen).toEqual([staleSeq, 0]);
    });
  }

  test("is not taken as a property value either", async () => {
    const dev = new KnxDevice(new StaleAnswerDevice(3), "1.2.3");
    await dev.connect();
    expect((await dev.propRead(0, 1)).toString("hex")).toBe("2a");
  });

  test("the type 0 descriptor read takes the descriptor behind it instead of refusing", async () => {
    const dev = new KnxDevice(new StaleAnswerDevice(5), "1.2.3");
    await dev.connect();
    expect(await dev.descriptorType0()).toBe("MV-0705");
  });
});

// A device that acknowledges every request; the one with sequence number 0 (all its tries) it answers
// only with another service, each time a new frame under the next number, every later one with its
// device descriptor. `repeat` makes the other service the same frame each time, a repetition.
class OtherServiceDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private txSeq = 0;
  private otherSeq = 7;
  constructor(private readonly repeat = false) {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(0x1203, this.assignedIa, tpdu, false)); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) return;
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    this.send(tpAck(p.seq));
    if (p.seq === 0) {
      this.send(apdu(this.otherSeq, APCI.MEMORY_RESPONSE, Buffer.from([0x44, 0xa5, 0x08]), 1));
      if (!this.repeat) this.otherSeq = (this.otherSeq + 1) & 0x0f;
      return;
    }
    this.send(apdu(this.txSeq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0x05])));
    this.txSeq = (this.txSeq + 1) & 0x0f;
  }
}

describe("a request answered only with another service", () => {
  test("is refused by name once its tries are spent, not taken as silence, and the next request takes the next number", async () => {
    const dev = new KnxDevice(new OtherServiceDevice(), "1.2.3", undefined, { responseMs: 50, retryGapMs: 1 });
    await dev.connect();
    const err = await dev.deviceDescriptor().then(() => null, (e: { code?: string; message?: string }) => e);
    expect(err?.code).toBe("ANSWER_SERVICE_MISMATCH");
    expect(err?.message).toContain("0x240");
    expect(await dev.deviceDescriptor()).toBe("MV-0705");
  });

  // The same frame again is taken for a repetition: the device waiting for our T_ACK of it while it
  // took the read, which is then asked again under the next number. This pins that rule only; the
  // transport layer behind it is modelled in device-lost-tack.test.ts.
  test("whose other service is repeated is asked again under the next number and answered", async () => {
    const dev = new KnxDevice(new OtherServiceDevice(true), "1.2.3", undefined, { responseMs: 50, retryGapMs: 1 });
    await dev.connect();
    expect(await dev.deviceDescriptor()).toBe("MV-0705");
  });

  test("leaves the security mode unreadable instead of failing the identification", async () => {
    const dev = new KnxDevice(new OtherServiceDevice(), "1.2.3", undefined, { responseMs: 50, retryGapMs: 1 });
    await dev.connect();
    expect((await readSecurityMode(dev)).state).toBe("unreadable");
  });
});

// A device whose stale answer comes outside a request, or again later: `afterConnect` sends it right
// after the T_Connect; `repeatAt` sends it before answering each request with one of those sequence
// numbers. It answers property reads with value 0x2a and descriptor reads with MV-0705.
class LateStaleDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private txSeq = 0;
  requests = 0;
  constructor(private readonly stale: Buffer, private readonly opts: { afterConnect?: boolean; repeatAt?: number[] }) {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(0x1203, this.assignedIa, tpdu, false)); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) { if (cemi[9] === 0x80 && this.opts.afterConnect) this.send(this.stale); return; }
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    this.requests++;
    this.send(tpAck(p.seq));
    if (this.opts.repeatAt?.includes(p.seq)) this.send(this.stale);
    if ((p.apci & 0x3c0) === APCI.DEVICE_DESCRIPTOR_READ) this.answer(apdu(this.txSeq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0x05])));
    else if (p.apci === APCI.PROPERTY_READ) this.answer(apdu(this.txSeq, APCI.PROPERTY_RESPONSE, Buffer.from([p.data[0], p.data[1], 0x10, 0x01, 0x2a])));
    else if ((p.apci & 0x3c0) === (APCI.RESTART & 0x3c0)) this.answer(apdu(this.txSeq, APCI.RESTART | 0x21, Buffer.from([0, 0, 0])));
  }
  private answer(tpdu: Buffer) { this.txSeq = (this.txSeq + 1) & 0x0f; this.send(tpdu); }
}
const staleMemory = apdu(0, APCI.MEMORY_RESPONSE, Buffer.from([0x44, 0xa5, 0x08]), 1);

describe("a stale answer outside the request it could be taken for", () => {
  test("arriving between the connect and the first request, it does not make that request's answer a repetition", async () => {
    const dev = new KnxDevice(new LateStaleDevice(staleMemory, { afterConnect: true }), "1.2.3", undefined, { responseMs: 200 });
    await dev.connect();
    await new Promise((r) => setTimeout(r, 5));
    expect(await dev.deviceDescriptor()).toBe("MV-0705");
  });

  test("its repetition is not taken as the answer of a later request of its service", async () => {
    // A property answer of an earlier connection (object 0, PID 14, value 0x99), dropped during the
    // descriptor read and sent again while a property read of the same object and PID waits.
    const staleProperty = apdu(5, APCI.PROPERTY_RESPONSE, Buffer.from([0x00, 0x0e, 0x10, 0x01, 0x99]));
    const dev = new KnxDevice(new LateStaleDevice(staleProperty, { repeatAt: [0, 1] }), "1.2.3", undefined, { responseMs: 200 });
    await dev.connect();
    expect(await dev.deviceDescriptor()).toBe("MV-0705");
    expect((await dev.propRead(0, 14)).toString("hex")).toBe("2a");
  });

  test("arriving at a confirmed restart, it is not taken as the restart's answer", async () => {
    const dev = new KnxDevice(new LateStaleDevice(staleMemory, { repeatAt: [0] }), "1.2.3", undefined, { responseMs: 50, restartAnswerMs: 200 });
    await dev.connect();
    await dev.restart(false, true);
  });
});

// A device whose link fails on a confirmed restart; its A_Restart_Response arrives late, between
// requests, under the number its next answer carries (0). Afterwards it answers descriptor reads.
class RestartLinkFailDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private failed = false;
  private txSeq = 0;
  descriptorReads = 0;
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(0x1203, this.assignedIa, tpdu, false)); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) return;
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    if (!this.failed && (p.apci & 0x3c0) === (APCI.RESTART & 0x3c0)) {
      this.failed = true;
      setTimeout(() => this.onCemi?.(0x1203, this.assignedIa, apdu(0, APCI.RESTART | 0x21, Buffer.from([0, 0, 0])), false), 2);
      throw Object.assign(new Error("tunnel closed"), { code: "TUNNEL_CLOSED" });
    }
    this.send(tpAck(p.seq));
    this.descriptorReads++;
    this.send(apdu(this.txSeq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0x05])));
    this.txSeq = (this.txSeq + 1) & 0x0f;
  }
}

test("a confirmed restart that fails leaves no restart answer awaited for the requests after it", async () => {
  const tun = new RestartLinkFailDevice();
  const dev = new KnxDevice(tun, "1.2.3", undefined, { responseMs: 200 });
  await dev.connect();
  expect(await dev.restart(false, true).then(() => null, (e: { code?: string }) => e.code)).toBe("TUNNEL_CLOSED");
  await new Promise((r) => setTimeout(r, 10));
  expect(await dev.deviceDescriptor()).toBe("MV-0705");
  // Taken at the first try: the late restart answer did not make the answer's number a repetition.
  expect(tun.descriptorReads).toBe(1);
});

test("a dropped frame's repetition is recognised only within the device's repetition window", async () => {
  // The same frame as a dropped one, after the window: a new frame of the same number, taken.
  const staleProperty = apdu(1, APCI.PROPERTY_RESPONSE, Buffer.from([0x00, 0x0e, 0x10, 0x01, 0x2a]));
  const tun = new LateStaleDevice(staleProperty, { repeatAt: [0] });
  const dev = new KnxDevice(tun, "1.2.3", undefined, { responseMs: 200, droppedRepeatMs: 20 });
  await dev.connect();
  expect(await dev.deviceDescriptor()).toBe("MV-0705");
  await new Promise((r) => setTimeout(r, 40));
  expect((await dev.propRead(0, 14)).toString("hex")).toBe("2a");
  expect(tun.requests).toBe(2); // each taken at its first try
});
