import { test, expect } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// A UDP send resolves on the tunnelling ACK, which can be late. The device's own timers must
// therefore start when the frame has left the tunnel, not before, or a late tunnel ACK reads as a
// silent device.
class LateTunnelAck implements KnxTransport {
  assignedIa = 0x0001;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  sends = 0;
  constructor(private readonly delayMs: number) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const p = parseApdu(cemi.subarray(9));
    if (p.control) return;
    this.sends++;
    await new Promise((r) => setTimeout(r, this.delayMs)); // the tunnelling ACK arrives late
    queueMicrotask(() => {
      this.onCemi?.(0x110b, this.assignedIa, tpAck(p.seq), false);
      this.onCemi?.(0x110b, this.assignedIa, apdu(p.seq, APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([0x07, 0xb0])), false);
    });
  }
}

test("a tunnelling ACK later than the device's own timeouts still yields the device's answer", async () => {
  const tun = new LateTunnelAck(2_500);
  const dev = new KnxDevice(tun, "1.1.11");
  expect(await dev.deviceDescriptor()).toBe("MV-07B0");
  expect(tun.sends).toBe(1);
}, 10_000);
