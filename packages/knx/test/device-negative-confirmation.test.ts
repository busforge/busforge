import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { KnxError } from "../src/errors.ts";
import { apdu, parseApdu, tpAck, tpDisconnect, APCI, type KnxTransport } from "../src/index.ts";

// An interface that confirms some of our numbered data frames negatively (L_Data.con with the error
// bit: it got no layer-2 acknowledgement), in front of a device with a connection-oriented transport
// layer (KNX 3/3/4). `negative` names, by the index of our numbered data frame (0 = the first), the
// frames the interface confirms negatively; `lost` those of them that did not reach the device. A frame
// confirmed negatively that reached it is taken as any other: the device acknowledges it after the
// confirmation (`ackAfterMs`) and answers it `answerAfterMs` later, as a MEAN WELL power supply did. The
// device acknowledges a repetition (the number it took last) and passes it on no more. It answers memory
// reads from a 256-octet image (octet i holds i) and property writes with the written value. `mute`
// names frames it acknowledges and leaves unanswered, `ackLost` frames whose T_ACK never reaches us
// (the answer does), `closeAfter` frames 10 ms after which it closes the connection, `closeBefore` frames
// whose confirmation its T_Disconnect comes ahead of (the frame meets a closed connection); a T_Connect
// starts its numbering anew.
class NegativelyConfirmingLink implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private rxSeq = 0;
  private txSeq = 0;
  private sent = 0;
  // Our numbered data frames as `seq:service` in the order they went out, and the requests the device
  // passed on to its application as `seq:address` (`seq:w` for a property write).
  wire: string[] = [];
  taken: string[] = [];
  constructor(private readonly opts: { negative: number[]; lost?: number[]; ackAfterMs?: number; answerAfterMs?: number; mute?: number[]; ackLost?: number[]; closeAfter?: number[]; closeBefore?: number[] }) {}
  async connect() {}
  async disconnect() {}
  private send(tpdu: Buffer, afterMs: number) { setTimeout(() => this.onCemi?.(0x1203, this.assignedIa, tpdu, false), afterMs); }
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9] & 0xc0) === 0x80) { if ((cemi[9] & 0x03) === 0x00) { this.rxSeq = 0; this.txSeq = 0; } return; } // T_Connect / T_Disconnect
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    const index = this.sent++;
    this.wire.push(`${p.seq}:${(p.apci & 0x3c0) === APCI.MEMORY_READ ? "r" : "w"}`);
    const negative = this.opts.negative.includes(index);
    if ((this.opts.closeBefore ?? []).includes(index)) {
      this.send(tpDisconnect(), 0);
      await new Promise((r) => setTimeout(r, 3));
      return;
    }
    const reached = !(this.opts.lost ?? []).includes(index);
    // Without a negative confirmation the frame's con comes first, so the device frames come after it.
    const ackAt = negative ? (this.opts.ackAfterMs ?? 3) : 1;
    const answerAt = ackAt + (this.opts.answerAfterMs ?? 2);
    if (reached) this.receive(p, cemi, ackAt, answerAt, index);
    if ((this.opts.closeAfter ?? []).includes(index)) this.send(tpDisconnect(), 10);
    if (negative) {
      await new Promise((r) => setTimeout(r, 1));
      throw new KnxError("BUS_SEND_FAILED", "the KNX interface reports that the telegram did not reach the bus (negative L_Data.con)");
    }
  }
  private receive(p: ReturnType<typeof parseApdu>, cemi: Buffer, ackAt: number, answerAt: number, index: number) {
    const ack = () => { if (!(this.opts.ackLost ?? []).includes(index)) this.send(tpAck(p.seq), ackAt); };
    if (p.seq === ((this.rxSeq - 1) & 0x0f)) { ack(); return; } // a repetition
    if (p.seq !== this.rxSeq) return;
    ack();
    this.rxSeq = (this.rxSeq + 1) & 0x0f;
    let answer: Buffer;
    if ((p.apci & 0x3c0) === APCI.MEMORY_READ) {
      const count = cemi[10] & 0x3f;
      const a = p.data.readUInt16BE(0);
      this.taken.push(`${p.seq}:${a}`);
      const octets = Buffer.from(Array.from({ length: count }, (_, i) => (a + i) & 0xff));
      answer = apdu(this.txSeq, APCI.MEMORY_RESPONSE, Buffer.concat([p.data.subarray(0, 2), octets]), count);
    } else {
      this.taken.push(`${p.seq}:w`);
      answer = apdu(this.txSeq, APCI.PROPERTY_RESPONSE, Buffer.from(p.data));
    }
    if ((this.opts.mute ?? []).includes(index)) return;
    this.txSeq = (this.txSeq + 1) & 0x0f;
    this.send(answer, answerAt);
  }
}

const timeouts = { ackMs: 30, responseMs: 60, retryGapMs: 5, reconnectGapMs: 5 };
const block = (a: number, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (a + i) & 0xff)).toString("hex");
const read = async (dev: KnxDevice, a: number) => (await dev.memRead(a, 2, 2)).toString("hex");

describe("a request the interface confirmed negatively", () => {
  // The interface confirmed a memory read negatively, the device acknowledged it and answered; sent
  // again under the same number, the read was taken as a repetition and never answered.
  test("takes the answer of a device that received it anyway, and sends nothing twice", async () => {
    const link = new NegativelyConfirmingLink({ negative: [1] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(await read(dev, 0x30)).toBe(block(0x30, 2));
    expect(await read(dev, 0x50)).toBe(block(0x50, 2));
    expect(link.wire).toEqual(["0:r", "1:r", "2:r"]);
    expect(link.taken).toEqual(["0:16", "1:48", "2:80"]);
    await dev.disconnect();
  });

  // The device's acknowledgement and answer may come later than the pause before a repetition.
  test("waits for the device's acknowledgement past the pause before a repetition", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0], ackAfterMs: 20, answerAfterMs: 15 });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(link.wire).toEqual(["0:r"]);
    await dev.disconnect();
  });

  // The device's T_ACK may reach the interface before the interface's own confirmation reaches us.
  test("takes an acknowledgement that came before the negative confirmation", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0], ackAfterMs: 0, answerAfterMs: 3 });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(link.wire).toEqual(["0:r"]);
    await dev.disconnect();
  });

  test("a write the device received is written once and never repeated", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    await dev.propWrite(0, 0x36, Buffer.from([1]));
    expect(link.wire).toEqual(["0:w"]);
    expect(link.taken).toEqual(["0:w"]);
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(link.taken).toEqual(["0:w", "1:16"]);
    await dev.disconnect();
  });

  // Not acknowledged within the acknowledgement timeout, the frame is repeated under its number, as the
  // transport layer repeats (KNX 3/3/4 A9) and ETS does: a device that took it passes the repetition on
  // no more, so even a write is carried out once.
  test("a write that did not reach the device is repeated under its number once nothing acknowledged it", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0], lost: [0] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    const t0 = Date.now();
    await dev.propWrite(0, 0x36, Buffer.from([1]));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(timeouts.ackMs);
    expect(link.wire).toEqual(["0:w", "0:w"]);
    expect(link.taken).toEqual(["0:w"]);
    await dev.disconnect();
  });

  test("a read the device took whose repetition is confirmed negatively too is answered once", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0, 1], lost: [0] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(link.wire).toEqual(["0:r", "0:r"]);
    expect(link.taken).toEqual(["0:16"]);
    expect(await read(dev, 0x30)).toBe(block(0x30, 2));
    expect(link.taken).toEqual(["0:16", "1:48"]);
    await dev.disconnect();
  });

  test("every try confirmed negatively and unacknowledged fails with the interface's error", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0, 1, 2], lost: [0, 1, 2] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    const err = await read(dev, 0x10).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("BUS_SEND_FAILED");
    expect(link.wire).toEqual(["0:r", "0:r", "0:r"]);
    // Nothing took the number: the next request goes out under it.
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(link.wire[3]).toBe("0:r");
    await dev.disconnect();
  });

  // A T_Disconnect while nothing acknowledged the negatively confirmed frame may have come ahead of it:
  // the device never saw the request, which a new connection asks once more.
  test("a close while nothing acknowledged it counts as ahead of the request", async () => {
    const link = new NegativelyConfirmingLink({ negative: [1], lost: [1], closeAfter: [1] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(await read(dev, 0x30)).toBe(block(0x30, 2));
    expect(link.wire).toEqual(["0:r", "1:r", "0:r"]);
    expect(link.taken).toEqual(["0:16", "0:48"]);
    await dev.disconnect();
  });

  test("an acknowledged try followed by negatively confirmed ones fails as unanswered, not as unacknowledged", async () => {
    const link = new NegativelyConfirmingLink({ negative: [1, 2], lost: [1, 2], mute: [0] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    const err = await read(dev, 0x10).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("DEVICE_NOT_ANSWERING");
    expect(link.wire).toEqual(["0:r", "0:r", "0:r"]);
  });

  test("takes an answer whose T_ACK was lost, without asking again", async () => {
    const link = new NegativelyConfirmingLink({ negative: [], ackLost: [0] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    expect(link.wire).toEqual(["0:r"]);
    expect(await read(dev, 0x30)).toBe(block(0x30, 2));
    expect(link.taken).toEqual(["0:16", "1:48"]);
    await dev.disconnect();
  });

  // The device carried the write out and its T_ACK was lost before it closed the connection: nothing
  // shows whether the write reached it, so it is not written again on a new connection.
  test("a write met by a close while nothing acknowledged it is not asked again on a new connection", async () => {
    const link = new NegativelyConfirmingLink({ negative: [1], ackLost: [1], mute: [1], closeAfter: [1] });
    const dev = new KnxDevice(link, "1.2.3", undefined, timeouts);
    await dev.connect();
    expect(await read(dev, 0x10)).toBe(block(0x10, 2));
    const err = await dev.propWrite(0, 0x36, Buffer.from([1])).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(link.taken).toEqual(["0:16", "1:w"]);
    expect(link.wire).toEqual(["0:r", "1:w"]);
  });

  test("a write as the first frame of a connection met by such a close is not asked again either", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0], ackLost: [0], mute: [0], closeAfter: [0] });
    const dev = new KnxDevice(link, "1.2.3", undefined, { ...timeouts, staleConnectionMs: 20 });
    await dev.connect();
    const err = await dev.propWrite(0, 0x36, Buffer.from([1])).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(link.taken).toEqual(["0:w"]);
    expect(link.wire).toEqual(["0:w"]);
  });

  // The first try reached the device unacknowledged, the repetition met the device's close: whether the
  // write was carried out stays open, so it is not sent on a new connection.
  for (const first of [false, true]) {
    test(`a write whose earlier try went unacknowledged is not asked again after a close${first ? " on a connection's first frame" : ""}`, async () => {
      const at = first ? 0 : 1;
      const link = new NegativelyConfirmingLink({ negative: [at], ackLost: [at], mute: [at], closeBefore: [at + 1] });
      const dev = new KnxDevice(link, "1.2.3", undefined, { ...timeouts, staleConnectionMs: 20 });
      await dev.connect();
      if (!first) expect(await read(dev, 0x10)).toBe(block(0x10, 2));
      const err = await dev.propWrite(0, 0x36, Buffer.from([1])).then(() => null, (e: { code?: string }) => e);
      expect(err?.code).toBe("DEVICE_CLOSED_CONNECTION");
      expect(link.taken.filter((t) => t.endsWith(":w"))).toHaveLength(1);
      expect(link.wire.filter((t) => t.endsWith(":w"))).toHaveLength(2);
    });
  }

  test("a write whose earlier try went unacknowledged is not asked again after a close behind a later try", async () => {
    const link = new NegativelyConfirmingLink({ negative: [0], ackLost: [0, 1], mute: [0], closeAfter: [1] });
    const dev = new KnxDevice(link, "1.2.3", undefined, { ...timeouts, staleConnectionMs: 20 });
    await dev.connect();
    const err = await dev.propWrite(0, 0x36, Buffer.from([1])).then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(link.taken).toEqual(["0:w"]);
    expect(link.wire).toEqual(["0:w", "0:w"]);
  });
});

