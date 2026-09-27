import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// A minimal in-memory transport that answers MemoryRead like a real M112 device with an
// internal read boundary: it refuses (empty response) any single read that spans the byte
// pair (B-1, B), exactly as the house M-0048/M-0008 devices do around 0x4008/0x4009.
// Each readable byte's value is (address & 0xff), so a correct read is trivially checkable.
class FakeBoundaryTransport implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly device = 0x110b; // 1.1.11
  constructor(private boundary: number, public refusals = 0) {}
  async connect() {}
  async disconnect() {}
  get assigned() { return this.assignedIa; }
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9); // skip the 9-byte L_Data head
    const p = parseApdu(tpdu);
    if (p.control || (p.apci & 0x3c0) !== APCI.MEMORY_READ) return; // ignore T_Connect / T_Ack / writes
    const count = p.apci & 0x3f; // MemoryRead carries its byte count in the low APCI bits
    const addr = (p.data[0] << 8) | p.data[1];
    // device acks the request, then answers
    this.onCemi?.(this.device, this.assignedIa, tpAck(p.seq), false);
    const spansBoundary = addr <= this.boundary - 1 && addr + count - 1 >= this.boundary;
    const data = spansBoundary ? Buffer.alloc(0) : Buffer.from(Array.from({ length: count }, (_, i) => (addr + i) & 0xff));
    if (spansBoundary) this.refusals++;
    const resp = apdu(p.seq, APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([(addr >> 8) & 0xff, addr & 0xff]), data]), data.length);
    this.onCemi?.(this.device, this.assignedIa, resp, false);
  }
}

describe("memRead handles device read boundaries without misaligning", () => {
  test("a segment crossing a refused boundary still reads full-length and address-aligned", async () => {
    const tun = new FakeBoundaryTransport(0x1009); // refuse reads spanning 0x1008<->0x1009
    const dev = new KnxDevice(tun, "1.1.11");
    const got = await dev.memRead(0x1000, 24, 12);
    const want = Buffer.from(Array.from({ length: 24 }, (_, i) => (0x1000 + i) & 0xff));
    expect(got.length).toBe(24);
    expect(got.equals(want)).toBe(true); // each byte at its true address, despite the boundary
    expect(tun.refusals).toBeGreaterThan(0); // the boundary was actually exercised
  });

  test("a clean segment (no boundary) reads in fixed chunks unchanged", async () => {
    const tun = new FakeBoundaryTransport(0xffff); // boundary out of range = never refused
    const dev = new KnxDevice(tun, "1.1.11");
    const got = await dev.memRead(0x4800, 40, 12);
    expect(got.equals(Buffer.from(Array.from({ length: 40 }, (_, i) => (0x4800 + i) & 0xff)))).toBe(true);
    expect(tun.refusals).toBe(0);
  });

  test("a truly unreadable single byte throws rather than silently misaligning", async () => {
    // boundary at 0x09 with base 0x08 forces a 1-byte read at 0x08 that still spans 0x08<->0x09.
    const tun = new (class extends FakeBoundaryTransport { async sendCemi(c: Buffer) {
      const t = c.subarray(9); const p = parseApdu(t);
      if (p.control || (p.apci & 0x3c0) !== APCI.MEMORY_READ) return;
      this.onCemi?.(this.device, this.assignedIa, tpAck(p.seq), false);
      const resp = apdu(p.seq, APCI.MEMORY_RESPONSE, Buffer.from([0x20, 0x08]), 0); // always empty
      this.onCemi?.(this.device, this.assignedIa, resp, false);
    } })(0);
    const dev = new KnxDevice(tun, "1.1.11");
    expect(dev.memRead(0x2008, 4, 12)).rejects.toThrow(/refused byte/);
  });
});

// A device that declares PID_MAX_APDU_LENGTH (or not) and records the byte count of every
// MemoryRead it is sent. Unimplemented properties answer with element count 0.
class ApduTransport implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly device = 0x110b;
  counts: number[] = [];
  constructor(private maxApdu: number | null) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    this.onCemi?.(this.device, this.assignedIa, tpAck(p.seq), false);
    if (p.apci === APCI.PROPERTY_READ) {
      const v = this.maxApdu === null ? [] : [this.maxApdu >> 8, this.maxApdu & 0xff];
      const tail = Buffer.from([p.data[0], p.data[1], (v.length ? 1 : 0) << 4, 1, ...v]);
      this.onCemi?.(this.device, this.assignedIa, apdu(p.seq, APCI.PROPERTY_RESPONSE, tail), false);
      return;
    }
    if ((p.apci & 0x3c0) !== APCI.MEMORY_READ) return;
    const count = p.apci & 0x3f;
    this.counts.push(count);
    const addr = (p.data[0] << 8) | p.data[1];
    const data = Buffer.from(Array.from({ length: count }, (_, i) => (addr + i) & 0xff));
    this.onCemi?.(this.device, this.assignedIa, apdu(p.seq, APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([addr >> 8, addr & 0xff]), data]), count), false);
  }
}

describe("memRead sizes its requests from the device's maximum APDU", () => {
  const cases: [string, number | null, number][] = [
    ["no PID_MAX_APDU_LENGTH: standard-frame 12 bytes", null, 12],
    ["a declared 40: 37 bytes", 40, 37],
    ["a declared 254: capped at the proven 48 bytes", 254, 48],
    ["a declared 15 (standard frame): still 12", 15, 12],
  ];
  for (const [name, maxApdu, want] of cases) {
    test(name, async () => {
      const tun = new ApduTransport(maxApdu);
      const dev = new KnxDevice(tun, "1.1.11");
      const got = await dev.memRead(0x4000, 200);
      expect(got.equals(Buffer.from(Array.from({ length: 200 }, (_, i) => (0x4000 + i) & 0xff)))).toBe(true);
      expect(tun.counts[0]).toBe(want);
    });
  }
});
