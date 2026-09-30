import { test, expect, describe, mock, afterAll } from "bun:test";
import { parseApdu, tpAck, type KnxTransport } from "@busforge/knx";
import type { Connection } from "../src/db/connections.ts";

// secure-identify against a simulated device on the transport: every secured frame (A_Data_Secure,
// the Sync included) goes unanswered, as from a device that does not hold the key; plain requests
// get the answers the bench devices gave (2026-09-30).
type Plain = { mask: string; serial: string; mode: string };
class SimDevice implements KnxTransport {
  assignedIa = 0x1164;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  constructor(private readonly plain: Plain) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const src = cemi.readUInt16BE(6);
    const tpdu = cemi.subarray(9);
    const p = parseApdu(tpdu);
    if (p.control || (tpdu[0] & 0xc0) === 0x80) return;
    if (p.apci === 0x3f1) return; // secured: the device does not hold this key
    const reply = (hex: string) => {
      const a = Buffer.from(hex, "hex");
      a[0] = 0x40 | (p.seq << 2) | (a[0] & 0x03);
      queueMicrotask(() => { this.onCemi?.(src, this.assignedIa, tpAck(p.seq), false); this.onCemi?.(src, this.assignedIa, a, false); });
    };
    if (p.apci === 0x300) reply("0340" + this.plain.mask);
    else if (p.apci === 0x3d5) reply(this.plain.serial ? "03d6000b1001" + this.plain.serial : "03d6000b0001");
    else if (p.apci === 0x1d5) reply("01d60011001033" + this.plain.mode);
  }
}

let device: Plain = { mask: "07b0", serial: "008500000203", mode: "000000" };
const realTransport = await import("../src/transport.ts");
const realMake = realTransport.makeTransport;
let makeImpl: typeof realMake = () => new SimDevice(device);
await mock.module("../src/transport.ts", () => ({ ...realTransport, makeTransport: (c: Connection) => makeImpl(c) }));
const { secureIdentify } = await import("../src/deviceprofile.ts");
afterAll(() => { makeImpl = realMake; });

// The connection is never dialled: makeTransport is the simulated device.
const conn = { id: "sim", kind: "ip" } as unknown as Connection;
const creds = { toolKey: Buffer.alloc(16, 0x11), serial: Buffer.from("00fa01020304", "hex") };
const code = (e: unknown) => (e as { code?: string }).code;

describe("secure-identify", () => {
  test("without a tool key it reads plainly: mask, serial and the security mode the device states", async () => {
    device = { mask: "07b0", serial: "008500000203", mode: "000000" };
    expect(await secureIdentify(conn, "1.1.203", undefined)).toEqual({ secure: false, mask: "MV-07B0", serial: "008500000203", securityMode: { state: "off" } });
  });

  test("a device in secure mode read without its key: no serial, and the mode denied, never off", async () => {
    device = { mask: "ffff", serial: "", mode: "fc" };
    const r = await secureIdentify(conn, "1.1.204", undefined);
    expect(r).toMatchObject({ secure: false, mask: "MV-FFFF", serial: null, securityMode: { state: "denied" } });
  });

  test("a stored key the device does not answer, on a device that states it is off: not activated", async () => {
    device = { mask: "07b0", serial: "00fa01020304", mode: "000000" };
    expect(code(await secureIdentify(conn, "1.1.204", creds).catch((e: unknown) => e))).toBe("SECURE_MODE_OFF");
  }, 15_000);

  test("a stored key the device does not answer, on a device that will not say: the Sync failure stands", async () => {
    device = { mask: "ffff", serial: "", mode: "fc" };
    expect(code(await secureIdentify(conn, "1.1.204", creds).catch((e: unknown) => e))).toBe("SECURE_SYNC_NO_RESPONSE");
  }, 15_000);
});
