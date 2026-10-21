import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { SecureSession } from "../src/secureSession.ts";
import type { KnxTransport } from "../src/index.ts";

// A link that is handed a tunnel address on every connect, from a list.
class Link implements KnxTransport {
  assignedIa = 0;
  onCemi: KnxTransport["onCemi"] = null;
  onClosed: ((reason: string) => void) | null = null;
  connects = 0;
  disconnects = 0;
  constructor(private readonly addresses: number[]) {}
  async connect() { this.assignedIa = this.addresses[Math.min(this.connects, this.addresses.length - 1)]; this.connects++; }
  async disconnect() { this.disconnects++; }
  async sendCemi() {}
}

describe("reopening the link to the interface", () => {
  test("closes and opens the transport again", async () => {
    const link = new Link([0x12fa, 0x12fb]);
    await link.connect();
    const dev = new KnxDevice(link, "1.2.7");
    await dev.reopenTransport();
    expect(link.disconnects).toBe(1);
    expect(link.connects).toBe(2);
  });

  test("a secured session whose link comes back under the same address goes on", async () => {
    const link = new Link([0x12fa, 0x12fa]);
    await link.connect();
    const dev = new KnxDevice(link, "1.2.7", new SecureSession({ toolKey: Buffer.alloc(16, 1), src: 0x12fa, dst: 0x1207 }));
    await dev.reopenTransport();
    expect(link.connects).toBe(2);
  });

  test("a secured session whose link comes back under another address moves to it and refuses to send before a Sync there", async () => {
    const link = new Link([0x12fa, 0x12fb]);
    await link.connect();
    const session = new SecureSession({ toolKey: Buffer.alloc(16, 1), src: 0x12fa, dst: 0x1207 });
    const dev = new KnxDevice(link, "1.2.7", session);
    const before = session.sequence;
    await dev.reopenTransport();
    expect(session.src).toBe(0x12fb);
    expect(session.sequence).toBe(before);
    let err: (Error & { code?: string }) | null = null;
    try { session.wrapManagement(Buffer.from([0x03, 0x00]), 1); } catch (e) { err = e as Error & { code?: string }; }
    expect(err?.code).toBe("SECURE_NOT_SYNCED");
  });
});
