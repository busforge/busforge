import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// An in-memory device that speaks A_MemoryExtended (3-byte address). Reads answer each byte as
// (address & 0xff); writes are stored and can be read back. It records which classic vs extended
// services it saw, so a test can prove the auto-select routed by address (classic stays byte-identical
// below 0x10000, extended is used above). The request/response layout mirrors the real service:
// read req [count, addr(3)] -> resp [0x00, addr(3), data...]; write req [count, addr(3), data]
// -> resp [0x00, addr(3)]. (Response layout confirmed against a real Jung 400021SE on the bench.)
class FakeExtTransport implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly device = 0x110b; // 1.1.11
  readonly mem = new Map<number, number>();
  sawClassic = 0;
  sawExtended = 0;
  // Injected faults for the negative tests.
  constructor(private readonly opts: { badCode?: boolean; wrongEcho?: boolean } = {}) {}
  async connect() {}
  async disconnect() {}
  get assigned() { return this.assignedIa; }
  private ack(seq: number) { this.onCemi?.(this.device, this.assignedIa, tpAck(seq), false); }
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9); // skip the 9-byte L_Data head
    const p = parseApdu(tpdu);
    if (p.control) return;
    if ((p.apci & 0x3c0) === APCI.MEMORY_READ || (p.apci & 0x3c0) === APCI.MEMORY_WRITE) { this.sawClassic++; this.ack(p.seq); return; }
    if (p.apci === APCI.MEMORY_EXT_READ) {
      this.sawExtended++;
      const count = p.data[0];
      const addr = (p.data[1] << 16) | (p.data[2] << 8) | p.data[3];
      this.ack(p.seq);
      const echo = this.opts.wrongEcho ? addr + 1 : addr;
      const data = Buffer.from(Array.from({ length: count }, (_, i) => this.mem.get(addr + i) ?? ((addr + i) & 0xff)));
      const head = Buffer.from([this.opts.badCode ? 0x01 : 0x00, (echo >> 16) & 0xff, (echo >> 8) & 0xff, echo & 0xff]);
      this.onCemi?.(this.device, this.assignedIa, apdu(p.seq, APCI.MEMORY_EXT_READ_RESP, Buffer.concat([head, data])), false);
      return;
    }
    if (p.apci === APCI.MEMORY_EXT_WRITE) {
      this.sawExtended++;
      const count = p.data[0];
      const addr = (p.data[1] << 16) | (p.data[2] << 8) | p.data[3];
      for (let i = 0; i < count; i++) this.mem.set(addr + i, p.data[4 + i]);
      this.ack(p.seq);
      const echo = this.opts.wrongEcho ? addr + 1 : addr;
      const head = Buffer.from([this.opts.badCode ? 0x01 : 0x00, (echo >> 16) & 0xff, (echo >> 8) & 0xff, echo & 0xff]);
      this.onCemi?.(this.device, this.assignedIa, apdu(p.seq, APCI.MEMORY_EXT_WRITE_RESP, head), false);
      return;
    }
  }
}

describe("A_MemoryExtended reaches past the 16-bit memory services", () => {
  test("memRead auto-routes to extended above 0xFFFF and reads full-length, address-aligned", async () => {
    const tun = new FakeExtTransport();
    const dev = new KnxDevice(tun, "1.1.11");
    const got = await dev.memRead(0x15000, 30, 12); // Jung 400021SE param segment lives here
    expect(got.equals(Buffer.from(Array.from({ length: 30 }, (_, i) => (0x15000 + i) & 0xff)))).toBe(true);
    expect(tun.sawExtended).toBeGreaterThan(0);
    expect(tun.sawClassic).toBe(0);
  });

  test("memWrite auto-routes to extended above 0xFFFF, and the bytes read back", async () => {
    const tun = new FakeExtTransport();
    const dev = new KnxDevice(tun, "1.1.11");
    const payload = Buffer.from(Array.from({ length: 25 }, (_, i) => (i * 7) & 0xff));
    await dev.memWrite(0x15000, payload, { chunk: 12 }); // verify:true by default -> reads back via extended
    const back = await dev.memReadExtended(0x15000, payload.length);
    expect(back.equals(payload)).toBe(true);
  });

  test("a segment spanning the 0xFFFF boundary is served entirely by extended (never truncated)", async () => {
    const tun = new FakeExtTransport();
    const dev = new KnxDevice(tun, "1.1.11");
    const got = await dev.memRead(0xfff8, 16, 12); // 0xFFF8..0x10007 crosses the classic ceiling
    expect(got.length).toBe(16);
    expect(tun.sawExtended).toBeGreaterThan(0);
    expect(tun.sawClassic).toBe(0);
  });

  test("a non-zero return code is refused, not trusted", async () => {
    const dev = new KnxDevice(new FakeExtTransport({ badCode: true }), "1.1.11");
    expect(dev.memReadExtended(0x15000, 4)).rejects.toThrow(/returned code/);
    const dev2 = new KnxDevice(new FakeExtTransport({ badCode: true }), "1.1.11");
    expect(dev2.memWriteExtended(0x15000, Buffer.from([1, 2, 3]))).rejects.toThrow(/rejected an extended write/);
  });

  test("a confirmation for the wrong address is refused", async () => {
    const dev = new KnxDevice(new FakeExtTransport({ wrongEcho: true }), "1.1.11");
    expect(dev.memReadExtended(0x15000, 4)).rejects.toThrow(/echoed/);
  });

  test("addresses that still fit in 16 bits keep using the classic services (byte-identical path)", async () => {
    const tun = new FakeExtTransport();
    const dev = new KnxDevice(tun, "1.1.11");
    await dev.memWrite(0x0100, Buffer.from([1, 2, 3]), { verify: false });
    expect(tun.sawClassic).toBeGreaterThan(0);
    expect(tun.sawExtended).toBe(0);
  });
});
