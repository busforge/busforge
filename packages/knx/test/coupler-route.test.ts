import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { KnxError } from "../src/errors.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// A device declaring PID_MAX_APDU_LENGTH 254 that answers the memory services and records the cEMI
// length field (the APDU length) of every frame it is sent. The interface's own address is the tunnel's.
class RouteTransport implements KnxTransport {
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  lengths: number[] = [];
  readCounts: number[] = [];
  extWriteCounts: number[] = [];
  userWriteCounts: number[] = [];
  constructor(public assignedIa: number, readonly device: number) {}
  async connect() {}
  async disconnect() {}
  private answer(tpdu: Buffer) { this.onCemi?.(this.device, this.assignedIa, tpdu, false); }
  async sendCemi(cemi: Buffer): Promise<void> {
    this.lengths.push(cemi[8]);
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    this.answer(tpAck(p.seq));
    if (p.apci === APCI.PROPERTY_READ) {
      const [obj, pid] = p.data;
      this.answer(apdu(p.seq, APCI.PROPERTY_RESPONSE, obj === 0 && pid === 56 ? Buffer.from([0, 56, 0x10, 0x01, 0x00, 0xfe]) : Buffer.from([obj, pid, 0x00, 0x01])));
    } else if ((p.apci & 0x3c0) === APCI.MEMORY_READ) {
      const count = p.apci & 0x3f;
      this.readCounts.push(count);
      this.answer(apdu(p.seq, APCI.MEMORY_RESPONSE, Buffer.concat([p.data.subarray(0, 2), Buffer.alloc(count)]), count));
    } else if (p.apci === APCI.MEMORY_EXT_WRITE) {
      this.extWriteCounts.push(p.data[0]);
      this.answer(apdu(p.seq, APCI.MEMORY_EXT_WRITE_RESP, Buffer.from([0x00, ...p.data.subarray(1, 4)])));
    } else if (p.apci === APCI.MEMORY_EXT_READ) {
      this.readCounts.push(p.data[0]);
      this.answer(apdu(p.seq, APCI.MEMORY_EXT_READ_RESP, Buffer.concat([Buffer.from([0x00, ...p.data.subarray(1, 4)]), Buffer.alloc(p.data[0])])));
    } else if (p.apci === APCI.USER_MEMORY_WRITE) {
      this.userWriteCounts.push(p.data[0] & 0x0f);
      this.answer(apdu(p.seq, APCI.USER_MEMORY_RESPONSE, Buffer.from(p.data)));
    }
  }
}

const TUNNEL = 0x11fa;    // 1.1.250
const SAME_LINE = 0x110b; // 1.1.11
const OTHER_LINE = 0x120b; // 1.2.11, behind the line coupler 1.2.0 seen from line 1.1
const ia = (n: number) => `${n >> 12}.${(n >> 8) & 0xf}.${n & 0xff}`;

describe("a route through a coupler is held to standard frames", () => {
  test("on the interface's line the device's maximum APDU sizes the requests", async () => {
    const tun = new RouteTransport(TUNNEL, SAME_LINE);
    const dev = new KnxDevice(tun, ia(SAME_LINE));
    expect(dev.routeCrossesCoupler()).toBe(false);
    await dev.memRead(0x4000, 96);
    expect(tun.readCounts[0]).toBe(48);
    expect(await dev.propValueDataMax()).toBe(249);
  });

  test("on another line every plain request fits a standard frame, whatever the device declares", async () => {
    const tun = new RouteTransport(TUNNEL, OTHER_LINE);
    const dev = new KnxDevice(tun, ia(OTHER_LINE));
    expect(dev.routeCrossesCoupler()).toBe(true);
    await dev.memRead(0x4000, 96);
    expect(tun.readCounts).toEqual(new Array(8).fill(12));
    expect(await dev.classicReadChunk()).toBe(12);
    expect(await dev.propValueDataMax()).toBe(10);
    // A caller's own chunk does not lift it (the collector passes its own).
    tun.readCounts = [];
    await dev.memReadPartial(0x4000, 48, { chunk: 48 });
    expect(tun.readCounts).toEqual([12, 12, 12, 12]);

    dev.setExtendedMemoryServices(true);
    await dev.memWrite(0x4000, Buffer.alloc(40, 0xa5));
    expect(tun.extWriteCounts).toEqual([10, 10, 10, 10]);
    tun.readCounts = [];
    await dev.memReadExtended(0x10000, 20);
    expect(tun.readCounts).toEqual([10, 10]);

    dev.setExtendedMemoryServices(false);
    await dev.memWrite(0x10000, Buffer.alloc(22, 0x5a), { verify: false });
    expect(tun.userWriteCounts).toEqual([11, 11]);
    expect(Math.max(...tun.lengths)).toBe(15);
  });

  test("an interface that does not tell its address counts as such a route", async () => {
    const tun = new RouteTransport(0, SAME_LINE);
    const dev = new KnxDevice(tun, ia(SAME_LINE));
    expect(dev.routeCrossesCoupler()).toBe(true);
    await dev.memRead(0x4000, 24);
    expect(tun.readCounts).toEqual([12, 12]);
  });

  test("a longer request on that route is refused before it is sent", async () => {
    const tun = new RouteTransport(TUNNEL, OTHER_LINE);
    const dev = new KnxDevice(tun, ia(OTHER_LINE));
    await dev.connect();
    const before = tun.lengths.length;
    const err = await dev.propWrite(0, 99, Buffer.alloc(20)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("COUPLER_ROUTE_LONG_FRAME");
    expect(tun.lengths.length).toBe(before);
  });
});
