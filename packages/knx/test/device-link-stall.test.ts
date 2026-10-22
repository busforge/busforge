import { test, expect, setDefaultTimeout } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { KnxError } from "../src/errors.ts";
import type { KnxTransport } from "../src/index.ts";

// Timeouts measured with the corpus (docs/testing.md, "Timeouts of heavy tests"): tests here take up to 0.4 s with the
// file alone (load 5-27) and up to 0.4 s with every workspace's tests in parallel (load 5-8). A full check on a busy
// machine stretches a test up to twenty times (2.2 s -> 44.9 s at load 30-50), so every test gets twenty times its own
// time, at least 60 s.
setDefaultTimeout(60_000);

// A link to the interface that stalls or closes: the send itself fails with a tunnel code.
class StalledLink implements KnxTransport {
  assignedIa = 0x12fa; // 1.2.250
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  sends = 0;
  constructor(private readonly code: string) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    if ((cemi[9]! & 0x80) !== 0) return; // T_Connect/T_Disconnect go out
    this.sends++;
    throw new KnxError(this.code, "stalled");
  }
}

for (const code of ["TUNNEL_CON_TIMEOUT", "TUNNEL_CLOSED"]) {
  test(`${code} is passed on after one try, never reported as a silent device`, async () => {
    const link = new StalledLink(code);
    const dev = new KnxDevice(link, "1.2.4");
    await dev.connect();
    const e = await dev.deviceDescriptor().catch((x: unknown) => x);
    expect((e as KnxError).code).toBe(code);
    expect(link.sends).toBe(1);
  });
}

test("a negative confirmation is still retried, the frame did not reach the bus", async () => {
  const link = new StalledLink("BUS_SEND_FAILED");
  const dev = new KnxDevice(link, "1.2.4");
  await dev.connect();
  const e = await dev.deviceDescriptor().catch((x: unknown) => x);
  expect((e as KnxError).code).toBe("BUS_SEND_FAILED");
  expect(link.sends).toBe(3);
});
