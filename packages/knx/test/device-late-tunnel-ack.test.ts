import { test, expect, setDefaultTimeout } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { apdu, parseApdu, tpAck, APCI, type KnxTransport } from "../src/index.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 2.5 s with the
// file alone (load 5-27) and up to 2.5 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(60_000);

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
}, 60_000);
