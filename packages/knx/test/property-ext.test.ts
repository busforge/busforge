import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { parseApdu, tpAck, type KnxTransport } from "../src/index.ts";

// Vectors from ETS 6.4.1 secure-commissioning the bench Jung 400021SE (2026-09-28), decrypted: the
// inner service APDUs (TPCI bits cleared) ETS sent and the device answered. The tool key in the
// PID 56 write is replaced by a dummy; the framing around it is ETS's.
class ScriptedDevice implements KnxTransport {
  assignedIa = 0x1164;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly sent: string[] = [];
  constructor(private readonly answers: string[]) {}
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    const p = parseApdu(tpdu);
    if (p.control) return;
    const svc = Buffer.from(tpdu); svc[0] &= 0x03;
    this.sent.push(svc.toString("hex"));
    this.onCemi?.(0x11cc, this.assignedIa, tpAck(p.seq), false);
    const a = Buffer.from(this.answers.shift()!, "hex");
    a[0] = 0x40 | (p.seq << 2) | (a[0] & 0x03);
    this.onCemi?.(0x11cc, this.assignedIa, a, false);
  }
}
const KEY = "00112233445566778899aabbccddeeff";

describe("extended property services, byte-for-byte as ETS sends them", () => {
  test("security mode read, switched on, then the tool key written", async () => {
    const tun = new ScriptedDevice([
      "01d60011001033000000",   // state: success, service 0, mode off
      "01d600110010330000",     // command: success, service 0
      "01cf001100103801000100", // write-con: 1 element at 1, success
    ]);
    const dev = new KnxDevice(tun, "1.1.204");
    expect(await dev.securityMode()).toBe(false);
    expect(await dev.funcPropExtCommand(17, 1, 51, Buffer.from([0x00, 0x00, 0x01]))).toEqual({ returnCode: 0, result: Buffer.from([0x00]) });
    await dev.propExtWriteCon(17, 1, 56, Buffer.from(KEY, "hex"));
    expect(tun.sent).toEqual(["01d500110010330000", "01d40011001033" + "000001", "01ce0011001038010001" + KEY]);
  });

  test("element 0 addresses the element count (ETS clears PID 54 that way)", async () => {
    const tun = new ScriptedDevice(["01cf001100103601000000"]);
    await new KnxDevice(tun, "1.1.204").propExtWriteCon(17, 1, 54, Buffer.from([0x00, 0x00]), 0);
    expect(tun.sent).toEqual(["01ce00110010360100000000"]);
  });

  test("a refused write, an answer for another property and a malformed mode are errors", async () => {
    expect(String(await new KnxDevice(new ScriptedDevice(["01cf001100103801000105"]), "1.1.204").propExtWriteCon(17, 1, 56, Buffer.from(KEY, "hex")).catch((e: unknown) => e))).toMatch(/answered/);
    expect(String(await new KnxDevice(new ScriptedDevice(["01d60011001034000000"]), "1.1.204").securityMode().catch((e: unknown) => e))).toMatch(/answered for/);
    expect(String(await new KnxDevice(new ScriptedDevice(["01d600110010330000"]), "1.1.204").securityMode().catch((e: unknown) => e))).toMatch(/security mode/);
  });

  test("an answer with another service, and an address out of range, are refused", async () => {
    expect(String(await new KnxDevice(new ScriptedDevice(["01cd001100103301000101"]), "1.1.204").securityMode().catch((e: unknown) => e))).toMatch(/service 0x1cd/);
    expect(String(await new KnxDevice(new ScriptedDevice([]), "1.1.204").propExtWriteCon(17, 1, 0x1038, Buffer.alloc(16)).catch((e: unknown) => e))).toMatch(/does not fit/);
    expect(String(await new KnxDevice(new ScriptedDevice([]), "1.1.204").propExtRead(17, 1, 51, 1, 256).catch((e: unknown) => e))).toMatch(/does not fit/);
  });

  test("an extended read with no element is refused, one with elements returns the value", async () => {
    expect(String(await new KnxDevice(new ScriptedDevice(["01cd00110010330000010a"]), "1.1.204").propExtRead(17, 1, 51).catch((e: unknown) => e))).toMatch(/no element/);
    expect(await new KnxDevice(new ScriptedDevice(["01cd001100103301000101"]), "1.1.204").propExtRead(17, 1, 51)).toEqual(Buffer.from([0x01]));
  });
});
