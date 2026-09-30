import { test, expect } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { KnxError } from "../src/errors.ts";
import type { KnxTransport } from "../src/index.ts";

// A link to the interface that stalls or closes: the send itself fails with a tunnel code.
class StalledLink implements KnxTransport {
  assignedIa = 0x1164;
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
    const dev = new KnxDevice(link, "1.1.204");
    await dev.connect();
    const e = await dev.deviceDescriptor().catch((x: unknown) => x);
    expect((e as KnxError).code).toBe(code);
    expect(link.sends).toBe(1);
  });
}

test("a negative confirmation is still retried, the frame did not reach the bus", async () => {
  const link = new StalledLink("BUS_SEND_FAILED");
  const dev = new KnxDevice(link, "1.1.204");
  await dev.connect();
  const e = await dev.deviceDescriptor().catch((x: unknown) => x);
  expect((e as KnxError).code).toBe("BUS_SEND_FAILED");
  expect(link.sends).toBe(3);
});
