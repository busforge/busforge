import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// A device answering A_Memory_Read with (address & 0xff) per byte, numbering its own data frames as
// the transport layer does. `repeatBefore`: before answering the request for that address it sends
// its previous answer again under the same sequence number, as a Theben DALI-Gateway did when the
// interface reported our T_ACK for that answer as not sent (L_Data.con negative). `wrongAddressAt`:
// it answers the request for that address with a fresh frame for another address.
class RepeatingDevice implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly device = 0x1237;
  private txSeq = 0;
  private last: Buffer | null = null;
  acksSeen: number[] = [];
  // `failFirstAck`: our first T_ACK is rejected by the interface, as a negative L_Data.con rejects a
  // send on USB. The device, never acknowledged, takes our retried request as a repetition (it
  // acknowledges it and does not answer again) and repeats its own answer.
  private lastReqSeq: number | null = null;
  constructor(private readonly opts: { repeatBefore?: number; wrongAddressAt?: number; failFirstAck?: boolean } = {}) {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer) { queueMicrotask(() => this.onCemi?.(this.device, this.assignedIa, tpdu, false)); }
  async sendCemi(cemi: Buffer): Promise<void> {
    const p = parseApdu(cemi.subarray(9));
    if (p.control) {
      if (this.opts.failFirstAck && this.acksSeen.length === 0) { this.acksSeen.push(-1); throw Object.assign(new Error("L_Data.con negative"), { code: "BUS_SEND_FAILED" }); }
      this.acksSeen.push(p.seq);
      return;
    }
    if (p.seq === this.lastReqSeq && this.last) { this.send(tpAck(p.seq)); setTimeout(() => this.send(this.last!), 300); return; }
    this.lastReqSeq = p.seq;
    if (p.apci === APCI.PROPERTY_READ) {
      this.send(tpAck(p.seq));
      const [obj, pid] = p.data;
      this.answer(apdu(this.txSeq, APCI.PROPERTY_RESPONSE, Buffer.from([obj, pid, 0x00, 0x01])));
      return;
    }
    if ((p.apci & 0x3c0) !== APCI.MEMORY_READ) return;
    const n = cemi.subarray(9)[1] & 0x3f;
    const a = p.data.readUInt16BE(0);
    this.send(tpAck(p.seq));
    if (a === this.opts.repeatBefore && this.last) this.send(this.last);
    const at = a === this.opts.wrongAddressAt ? a - n : a;
    const body = Buffer.concat([Buffer.from([at >> 8, at & 0xff]), Buffer.from(Array.from({ length: n }, (_, i) => (at + i) & 0xff))]);
    this.answer(apdu(this.txSeq, APCI.MEMORY_RESPONSE, body, n));
  }
  private answer(tpdu: Buffer) { this.last = tpdu; this.txSeq = (this.txSeq + 1) & 0x0f; this.send(tpdu); }
}

const expected = (addr: number, len: number) => Buffer.from(Array.from({ length: len }, (_, i) => (addr + i) & 0xff));

describe("a numbered frame the device repeats", () => {
  test("is acknowledged again and dropped, and the read takes the answer to its own request", async () => {
    const tun = new RepeatingDevice({ repeatBefore: 0x53c0 });
    const dev = new KnxDevice(tun, "1.2.55");
    await dev.connect();
    const got = await dev.memRead(0x5390, 96, 48);
    expect(got.equals(expected(0x5390, 96))).toBe(true);
    // Two answers, three data frames: the repeated one is acknowledged a second time.
    expect(tun.acksSeen.length).toBe(3);
    expect(tun.acksSeen[1]).toBe(tun.acksSeen[0]);
  });

  test("an answer whose T_ACK failed to send is taken from the device's repetition", async () => {
    const tun = new RepeatingDevice({ failFirstAck: true });
    const dev = new KnxDevice(tun, "1.2.55");
    await dev.connect();
    const got = await dev.memRead(0x5390, 48, 48);
    expect(got.equals(expected(0x5390, 48))).toBe(true);
  }, 10_000);

  test("an answer for another address is refused, not taken as this one's", async () => {
    const dev = new KnxDevice(new RepeatingDevice({ wrongAddressAt: 0x53c0 }), "1.2.55");
    await dev.connect();
    const err = await dev.memRead(0x5390, 96, 48).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/memory read of 0x53c0 was answered for 0x5390/);
  });
});
