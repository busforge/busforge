import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, KnxError, type KnxTransport } from "../src/index.ts";

// One device on a bus with a connection-oriented transport layer (KNX 3/3/4, as the thelsing/OpenKNX
// stack implements it): a T_Connect while it is closed opens a connection to the sender; a T_Connect
// from another address while one is open is answered with a T_Disconnect to that address (A10), one
// from the connected address does nothing (A0); a T_Disconnect closes the connection only from the
// connected address (E2, else E3/A0). An open connection without any frame for `idleMs` closes.
// It answers device descriptor reads with MV-07B0.
class Bus {
  private partner: number | null = null;
  private rxSeq = 0;
  private txSeq = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private taps = new Map<number, BusTunnel>();
  // Connections the device refused because it held another one.
  refused = 0;
  constructor(private readonly idleMs: number, readonly device = 0x1220) {}
  tunnel(ia: number): BusTunnel { const t = new BusTunnel(this, ia); this.taps.set(ia, t); return t; }
  private to(ia: number, tpdu: Buffer) { const t = this.taps.get(ia); setTimeout(() => t?.deliver(tpdu), 1); }
  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.partner !== null) this.to(this.partner, Buffer.from([0x81])); this.partner = null; }, this.idleMs);
  }
  frame(src: number, tpdu: Buffer) {
    if ((tpdu[0] & 0xc0) === 0x80) {
      const connect = (tpdu[0] & 0x03) === 0x00;
      if (connect) {
        if (this.partner === null) { this.partner = src; this.rxSeq = 0; this.txSeq = 0; this.touch(); }
        else if (this.partner !== src) { this.refused++; this.to(src, Buffer.from([0x81])); }
      } else if (this.partner === src) { this.partner = null; if (this.idle) clearTimeout(this.idle); }
      return;
    }
    if (src !== this.partner) return;
    this.touch();
    const p = parseApdu(tpdu);
    if (p.control) { if (p.seq === this.txSeq) this.txSeq = (this.txSeq + 1) & 0x0f; return; }
    if (p.seq === ((this.rxSeq - 1) & 0x0f)) { this.to(src, tpAck(p.seq)); return; }
    if (p.seq !== this.rxSeq) { this.to(src, Buffer.from([0xc3 | (p.seq << 2)])); return; }
    this.to(src, tpAck(p.seq));
    this.rxSeq = (this.rxSeq + 1) & 0x0f;
    if ((p.apci & 0x3c0) === APCI.DEVICE_DESCRIPTOR_READ) this.to(src, apdu(this.txSeq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0xb0])));
  }
}

// A tunnel with tunnel address `ia`; `stall()` makes every later frame of it stall on the way, as the
// link between the tool and the interface did: its numbered frames fail as TUNNEL_CON_TIMEOUT, its
// control frames go nowhere.
class BusTunnel implements KnxTransport {
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  private stalled = false;
  constructor(private readonly bus: Bus, readonly assignedIa: number) {}
  async connect() {}
  async disconnect() {}
  stall() { this.stalled = true; }
  deliver(tpdu: Buffer) { if (!this.stalled) this.onCemi?.(this.bus.device, this.assignedIa, tpdu, false); }
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    if (this.stalled) {
      if ((tpdu[0] & 0x80) === 0) throw new KnxError("TUNNEL_CON_TIMEOUT", "the interface did not confirm the frame");
      return;
    }
    this.bus.frame(this.assignedIa, Buffer.from(tpdu));
  }
}

const timeouts = { ackMs: 30, responseMs: 40, retryGapMs: 5, staleConnectionMs: 200 };

describe("a connection to a device after the tunnel of the one before was lost", () => {
  test("waits out the old connection when the new tunnel has another address", async () => {
    const bus = new Bus(100);
    const first = bus.tunnel(0x11ff);
    const a = new KnxDevice(first, "1.2.32", undefined, timeouts);
    await a.connect();
    expect(await a.deviceDescriptor()).toBe("MV-07B0");
    first.stall();
    const lost = await a.deviceDescriptor().then(() => null, (e: { code?: string }) => e);
    expect(lost?.code).toBe("TUNNEL_CON_TIMEOUT");
    await a.disconnect();
    const b = new KnxDevice(bus.tunnel(0x11fd), "1.2.32", undefined, timeouts);
    await b.connect();
    expect(await b.deviceDescriptor()).toBe("MV-07B0");
    // Refused once while the device still held the old connection, answered on the next.
    expect(bus.refused).toBe(1);
  });

  // The link fails behind the session's last frame: nothing of ours notices, and the device still holds
  // the connection when the next session opens one under another tunnel address.
  test("is opened again when the device refuses it for an old connection nobody saw fail", async () => {
    const bus = new Bus(100);
    const first = bus.tunnel(0x11ff);
    const a = new KnxDevice(first, "1.2.32", undefined, timeouts);
    await a.connect();
    expect(await a.deviceDescriptor()).toBe("MV-07B0");
    first.stall();
    await a.disconnect();
    const b = new KnxDevice(bus.tunnel(0x11fd), "1.2.32", undefined, timeouts);
    await b.connect();
    expect(await b.deviceDescriptor()).toBe("MV-07B0");
    expect(bus.refused).toBe(1);
  });

  test("refused again after the wait, is refused by name", async () => {
    const bus = new Bus(10_000, 0x1122);
    const other = new KnxDevice(bus.tunnel(0x1105), "1.1.34", undefined, timeouts);
    await other.connect();
    expect(await other.deviceDescriptor()).toBe("MV-07B0");
    const b = new KnxDevice(bus.tunnel(0x11fd), "1.1.34", undefined, timeouts);
    await b.connect();
    const err = await b.deviceDescriptor().then(() => null, (e: { code?: string; message?: string }) => e);
    expect(err?.code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(err?.message).toContain("refused the connection twice");
    expect(bus.refused).toBe(2);
  });

  test("closes the old connection first when the new tunnel has the same address", async () => {
    const bus = new Bus(10_000);
    const first = bus.tunnel(0x11ff);
    const a = new KnxDevice(first, "1.2.32", undefined, timeouts);
    await a.connect();
    expect(await a.deviceDescriptor()).toBe("MV-07B0");
    first.stall();
    expect((await a.deviceDescriptor().then(() => null, (e: { code?: string }) => e))?.code).toBe("TUNNEL_CON_TIMEOUT");
    // The interface gives the next tunnel the same address; the device still numbers the old
    // connection, which a new one from 0 would not match.
    const start = Date.now();
    const b = new KnxDevice(bus.tunnel(0x11ff), "1.2.32", undefined, timeouts);
    await b.connect();
    expect(await b.deviceDescriptor()).toBe("MV-07B0");
    expect(Date.now() - start).toBeLessThan(timeouts.staleConnectionMs);
  });

  test("opens at once to a device whose connection ended normally", async () => {
    const bus = new Bus(10_000, 0x1221);
    const a = new KnxDevice(bus.tunnel(0x11ff), "1.2.33", undefined, timeouts);
    await a.connect();
    expect(await a.deviceDescriptor()).toBe("MV-07B0");
    await a.disconnect();
    const start = Date.now();
    const b = new KnxDevice(bus.tunnel(0x11fd), "1.2.33", undefined, timeouts);
    await b.connect();
    expect(await b.deviceDescriptor()).toBe("MV-07B0");
    expect(Date.now() - start).toBeLessThan(timeouts.staleConnectionMs);
  });
});
