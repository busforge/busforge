import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// A device with a connection-oriented transport layer (KNX 3/3/4): it acknowledges every numbered
// frame of ours, passes on one with the expected number and only acknowledges its repetition, and
// after sending a numbered frame waits for our T_ACK (OPEN_WAIT), repeating the frame every
// `repeatMs` until it comes. It answers memory reads from a 256-octet image (octet i holds i) and
// property writes with the written value.
// `inOpenWait` is what it does with the answer to a request taken while it waits: "discard" is what a
// Theben DALI-Gateway did on the house bus, "hold" is the specification's A11 (one slot, sent once our
// T_ACK lets it out of OPEN_WAIT), "queue" keeps every such answer and sends them one after another.
// `loseAcks` names, per number of its frames, how many T_ACKs of ours for it never reach it: the
// interface confirms them negatively. `holdDelayMs` is how long it takes, once our T_ACK let it go on,
// to send an answer it kept.
class TransportLayerDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private rxSeq = 0;
  private txSeq = 0;
  private waiting: { timer: ReturnType<typeof setTimeout> } | null = null;
  private held: { apci: number; body: Buffer; low: number }[] = [];
  private lost = new Map<number, number>();
  // Requests passed on to the device's application, as `seq:address` (`seq:w` for a property write).
  taken: string[] = [];
  constructor(private readonly opts: { inOpenWait: "discard" | "hold" | "queue"; loseAcks: Record<number, number>; repeatMs: number; holdDelayMs?: number }) {}
  async connect() {}
  async disconnect() { if (this.waiting) clearTimeout(this.waiting.timer); }
  private send(tpdu: Buffer) { setTimeout(() => this.onCemi?.(0x1237, this.assignedIa, tpdu, false), 1); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) return; // T_Connect / T_Disconnect
    const p = parseApdu(cemi.subarray(9));
    if (p.control) {
      const lost = this.lost.get(p.seq) ?? 0;
      if (lost < (this.opts.loseAcks[p.seq] ?? 0)) { this.lost.set(p.seq, lost + 1); return; }
      if (this.waiting && p.seq === this.txSeq) {
        clearTimeout(this.waiting.timer);
        this.waiting = null;
        this.txSeq = (this.txSeq + 1) & 0x0f;
        const next = this.held.shift();
        if (next) setTimeout(() => this.dataReq(next), this.opts.holdDelayMs ?? 0);
      }
      return;
    }
    if (p.seq === ((this.rxSeq - 1) & 0x0f)) { this.send(tpAck(p.seq)); return; } // a repetition
    if (p.seq !== this.rxSeq) return;
    this.send(tpAck(p.seq));
    this.rxSeq = (this.rxSeq + 1) & 0x0f;
    if ((p.apci & 0x3c0) === APCI.MEMORY_READ) {
      const count = cemi[10] & 0x3f;
      const a = p.data.readUInt16BE(0);
      this.taken.push(`${p.seq}:${a}`);
      const octets = Buffer.from(Array.from({ length: count }, (_, i) => (a + i) & 0xff));
      this.dataReq({ apci: APCI.MEMORY_RESPONSE, body: Buffer.concat([p.data.subarray(0, 2), octets]), low: count });
    } else if (p.apci === APCI.PROPERTY_WRITE) {
      this.taken.push(`${p.seq}:w`);
      this.dataReq({ apci: APCI.PROPERTY_RESPONSE, body: Buffer.from(p.data), low: 0 });
    }
  }
  // T_Data_Connected.req of an answer.
  private dataReq(a: { apci: number; body: Buffer; low: number }) {
    if (this.waiting) {
      if (this.opts.inOpenWait === "hold") this.held = [a];
      else if (this.opts.inOpenWait === "queue") this.held.push(a);
      return;
    }
    const frame = apdu(this.txSeq, a.apci, a.body, a.low);
    const repeat = (left: number): ReturnType<typeof setTimeout> => setTimeout(() => {
      if (!this.waiting || left === 0) return;
      this.send(frame);
      this.waiting.timer = repeat(left - 1);
    }, this.opts.repeatMs);
    this.waiting = { timer: repeat(3) };
    this.send(frame);
  }
}

// The device repeats its frame later than the tool gives up waiting for an answer, as on the bus
// (3 s against 2 s).
const timeouts = { ackMs: 30, responseMs: 40, retryGapMs: 5 };
const block = (a: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (a + i) & 0xff)).toString("hex");
const read = async (dev: KnxDevice, a: number) => (await dev.memRead(a, 8, 8)).toString("hex");

describe("a request after the interface lost our T_ACK of the answer before it", () => {
  // The house bus: the T_ACK of the first block's answer was confirmed negatively, the device
  // acknowledged the read of the next block and never answered it, and repeated its first answer.
  test("a read is answered by a device that discards an answer while it waits for our T_ACK", async () => {
    const tun = new TransportLayerDevice({ inOpenWait: "discard", loseAcks: { 0: 1 }, repeatMs: 60 });
    const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 8));
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    // The read the device took and lost is asked again under the next number, and the numbering
    // stays in step for the read after it.
    expect(tun.taken).toEqual(["0:16", "1:48", "2:48"]);
    expect(await read(dev, 0x50)).toBe(block(0x50, 8));
    await dev.disconnect();
  });

  test("a read takes the held answer of a device that sends it once our T_ACK reached it, and asks nothing twice", async () => {
    const tun = new TransportLayerDevice({ inOpenWait: "hold", loseAcks: { 0: 1 }, repeatMs: 60 });
    const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 8));
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    expect(await read(dev, 0x50)).toBe(block(0x50, 8));
    expect(tun.taken).toEqual(["0:16", "1:48", "2:80"]);
    await dev.disconnect();
  });

  // Our T_ACK of the repetition is lost too: the read is asked again while the device still waits,
  // and a device that keeps both answers sends the second after the read was answered.
  test("the second answer of a read asked twice is not taken by the read after it", async () => {
    const tun = new TransportLayerDevice({ inOpenWait: "queue", loseAcks: { 0: 2 }, repeatMs: 60 });
    const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 8));
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    expect(await read(dev, 0x50)).toBe(block(0x50, 8));
    expect(await read(dev, 0x70)).toBe(block(0x70, 8));
    expect(tun.taken.filter((t) => t.endsWith(":48")).length).toBe(2);
    await dev.disconnect();
  });

  test("a write the device took and did not answer is refused, never sent under a new number", async () => {
    const tun = new TransportLayerDevice({ inOpenWait: "discard", loseAcks: { 0: 1 }, repeatMs: 60 });
    const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 8));
    const err = await dev.propWrite(0, 0x36, Buffer.from([1])).then(() => null, (e: { code?: string; message?: string }) => e);
    expect(err?.code).toBe("DEVICE_NOT_ANSWERING");
    expect(err?.message).toContain("not asked twice");
    expect(tun.taken).toEqual(["0:16", "1:w"]);
    // The device holds the write's number: the next request takes the next one and is answered.
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    await dev.disconnect();
  });

  // The repetition comes late in a try's window, or between two tries: a device that keeps the answer
  // still gets a whole window to send it before anything is asked again.
  for (const repeatMs of [36, 42]) {
    test(`a held answer whose repetition comes ${repeatMs} ms in is taken without asking twice`, async () => {
      const tun = new TransportLayerDevice({ inOpenWait: "hold", loseAcks: { 0: 1 }, repeatMs });
      const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
      await dev.connect();
      expect(await read(dev, 0x10)).toBe(block(0x10, 8));
      expect(await read(dev, 0x30)).toBe(block(0x30, 8));
      expect(tun.taken).toEqual(["0:16", "1:48"]);
      await dev.disconnect();
    });
  }

  // The repetition comes late in the first try's window and the kept answer after that window closed.
  test("a held answer that comes after the window it was repeated in is taken without asking twice", async () => {
    const tun = new TransportLayerDevice({ inOpenWait: "hold", loseAcks: { 0: 1 }, repeatMs: 36, holdDelayMs: 15 });
    const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 8));
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    expect(tun.taken).toEqual(["0:16", "1:48"]);
    await dev.disconnect();
  });

  test("the same read again after one asked twice is answered", async () => {
    const tun = new TransportLayerDevice({ inOpenWait: "discard", loseAcks: { 0: 1 }, repeatMs: 60 });
    const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 8));
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    expect(await read(dev, 0x30)).toBe(block(0x30, 8));
    expect(tun.taken).toEqual(["0:16", "1:48", "2:48", "3:48", "4:48"]);
    await dev.disconnect();
  });

  test("a read whose T_ACKs all arrive goes out once per block", async () => {
    const tun = new TransportLayerDevice({ inOpenWait: "discard", loseAcks: {}, repeatMs: 60 });
    const dev = new KnxDevice(tun, "1.2.55", undefined, timeouts);
    await dev.connect();
    expect((await dev.memRead(0x10, 24, 8)).toString("hex")).toBe(block(0x10, 24));
    expect(tun.taken).toEqual(["0:16", "1:24", "2:32"]);
    await dev.disconnect();
  });
});

// A device that answers every property read and write for another property than the one asked, or
// with `otherStart` for the element after the one asked.
class OtherPropertyDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private txSeq = 0;
  constructor(private readonly otherStart = false) {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(0x1203, this.assignedIa, tpdu, false)); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) return;
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    this.send(tpAck(p.seq));
    const echo = this.otherStart ? [p.data[0], p.data[1], 0x10, p.data[3] + 1] : [p.data[0], p.data[1] + 1, 0x10, 0x01];
    this.send(apdu(this.txSeq, APCI.PROPERTY_RESPONSE, Buffer.from([...echo, 0x2a])));
    this.txSeq = (this.txSeq + 1) & 0x0f;
  }
}

describe("a property answer for another property", () => {
  test("is refused by a property read", async () => {
    const dev = new KnxDevice(new OtherPropertyDevice(), "1.2.3", undefined, timeouts);
    await dev.connect();
    const err = await dev.propRead(0, 0x36).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("PROPERTY_RESPONSE_MISMATCH");
  });

  test("for another element is refused by a property read", async () => {
    const dev = new KnxDevice(new OtherPropertyDevice(true), "1.2.3", undefined, timeouts);
    await dev.connect();
    const err = await dev.propRead(0, 0x36, 3).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("PROPERTY_RESPONSE_MISMATCH");
  });

  test("is refused by a property write", async () => {
    const dev = new KnxDevice(new OtherPropertyDevice(), "1.2.3", undefined, timeouts);
    await dev.connect();
    const err = await dev.propWrite(0, 0x36, Buffer.from([1])).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("PROPERTY_RESPONSE_MISMATCH");
  });
});

// A device that refuses (T_NAK) its first `refuse` frames, numbered 0, then answers descriptor reads;
// a frame with any number but the one it expects it refuses too.
class RefusingDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private rxSeq = 0;
  private txSeq = 0;
  constructor(private refuse: number) {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(0x1203, this.assignedIa, tpdu, false)); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) return;
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    if (this.refuse > 0 || p.seq !== this.rxSeq) { this.refuse--; this.send(Buffer.from([0xc3 | (p.seq << 2)])); return; }
    this.send(tpAck(p.seq));
    this.rxSeq = (this.rxSeq + 1) & 0x0f;
    this.send(apdu(this.txSeq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0x05])));
    this.txSeq = (this.txSeq + 1) & 0x0f;
  }
}

describe("a request the device refused with T_NAK on every try", () => {
  test("leaves its number to the next request", async () => {
    const dev = new KnxDevice(new RefusingDevice(3), "1.2.3", undefined, timeouts);
    await dev.connect();
    const err = await dev.deviceDescriptor().then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("DEVICE_NOT_ANSWERING");
    expect(await dev.deviceDescriptor()).toBe("MV-0705");
  });
});
