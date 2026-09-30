import { test, expect, describe } from "bun:test";
import { KnxDevice, readSecurityMode } from "../src/device.ts";
import { parseApdu, tpAck, type KnxTransport } from "../src/index.ts";

// The answers the bench devices gave to a plain A_FunctionPropertyExtState_Read of object type 17,
// PID 51 (2026-09-30): the GVS (not secured) [00 00 00], the Jung in secure mode 0xFC (access
// denied), the MDT acknowledged each try, never answered, and closed the connection about 6 s
// after the first. The timing here is compressed: the close follows the acknowledgement at once.
type Reply = { tpdu: string } | "ack";
class BenchDevice implements KnxTransport {
  assignedIa = 0x1164;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly sent: string[] = [];
  constructor(private readonly replies: Reply[][]) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    this.sent.push(tpdu.toString("hex"));
    const p = parseApdu(tpdu);
    if (p.control) return;
    for (const r of this.replies.shift() ?? []) {
      if (r === "ack") { this.onCemi?.(0x11cc, this.assignedIa, tpAck(p.seq), false); continue; }
      const a = Buffer.from(r.tpdu, "hex");
      if (a[0] & 0x40) a[0] = 0x40 | (p.seq << 2) | (a[0] & 0x03);
      this.onCemi?.(0x11cc, this.assignedIa, a, false);
    }
  }
}
const answer = (tpdu: string): Reply[] => ["ack", { tpdu }];

describe("the security mode as a device states it", () => {
  test("on, off and access denied are each reported as such", async () => {
    expect(await readSecurityMode(new KnxDevice(new BenchDevice([answer("41d60011001033000001")]), "1.1.204"))).toEqual({ state: "on" });
    expect(await readSecurityMode(new KnxDevice(new BenchDevice([answer("41d60011001033000000")]), "1.1.204"))).toEqual({ state: "off" });
    expect(await readSecurityMode(new KnxDevice(new BenchDevice([answer("41d60011001033fc")]), "1.1.204"))).toMatchObject({ state: "denied" });
  });

  test("access denied is its own error, never read as off", async () => {
    const e = await new KnxDevice(new BenchDevice([answer("41d60011001033fc")]), "1.1.204").securityMode().catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("SECURITY_MODE_DENIED");
  });

  test("an answer Busforge cannot read is reported as unreadable, with what the device said", async () => {
    const r = await readSecurityMode(new KnxDevice(new BenchDevice([answer("41d600110010330000")]), "1.1.204"));
    expect(r).toMatchObject({ state: "unreadable" });
    expect((r as { detail: string }).detail).toMatch(/security mode/);
  });
});

describe("a device that closes the connection", () => {
  test("ends the request at once as closed, not as silence, is not acknowledged, and is not asked again", async () => {
    const tun = new BenchDevice([["ack", { tpdu: "81" }]]);
    const dev = new KnxDevice(tun, "1.1.204");
    const t0 = Date.now();
    const e = await dev.funcPropExtStateRead(17, 1, 51, Buffer.from([0x00, 0x00])).catch((x: unknown) => x);
    expect(String(e)).toMatch(/closed the connection/);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((e as { code?: string }).code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(tun.sent).toEqual(["41d500110010330000"]);
  });

  test("closing before acknowledging ends the request the same way", async () => {
    const tun = new BenchDevice([[{ tpdu: "81" }]]);
    const e = await new KnxDevice(tun, "1.1.204").funcPropExtStateRead(17, 1, 51, Buffer.from([0x00, 0x00])).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("DEVICE_CLOSED_CONNECTION");
    expect(tun.sent).toEqual(["41d500110010330000"]);
  });

  test("is reported as unreadable by the security mode read", async () => {
    const r = await readSecurityMode(new KnxDevice(new BenchDevice([["ack", { tpdu: "81" }]]), "1.1.204"));
    expect(r).toMatchObject({ state: "unreadable" });
  });
});
