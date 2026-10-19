import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { parseApdu, tpAck, runLoadPlan, leftUnloaded, KnxError, RETURN_CODE_ADDRESS_VOID, type KnxTransport, type LoadPlan } from "../src/index.ts";

// Vectors from ETS 6.4.1 secure-commissioning a Jung 400021SE, decrypted: the
// inner service APDUs (TPCI bits cleared) ETS sent and the device answered. The tool key in the
// PID 56 write is replaced by a dummy; the framing around it is ETS's.
class ScriptedDevice implements KnxTransport {
  assignedIa = 0x12fa; // 1.2.250
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
    this.onCemi?.(0x1204, this.assignedIa, tpAck(p.seq), false);
    const next = this.answers.shift();
    if (next === undefined) return; // a repeated request: the device does not answer it again
    const a = Buffer.from(next, "hex");
    a[0] = 0x40 | (p.seq << 2) | (a[0] & 0x03);
    this.onCemi?.(0x1204, this.assignedIa, a, false);
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
    const dev = new KnxDevice(tun, "1.2.4");
    expect(await dev.securityMode()).toBe(false);
    expect(await dev.funcPropExtCommand(17, 1, 51, Buffer.from([0x00, 0x00, 0x01]))).toEqual({ returnCode: 0, result: Buffer.from([0x00]) });
    await dev.propExtWriteCon(17, 1, 56, Buffer.from(KEY, "hex"));
    expect(tun.sent).toEqual(["01d500110010330000", "01d40011001033" + "000001", "01ce0011001038010001" + KEY]);
  });

  test("element 0 addresses the element count (ETS clears PID 54 that way)", async () => {
    const tun = new ScriptedDevice(["01cf001100103601000000"]);
    await new KnxDevice(tun, "1.2.4").propExtWriteCon(17, 1, 54, Buffer.from([0x00, 0x00]), 0);
    expect(tun.sent).toEqual(["01ce00110010360100000000"]);
  });

  test("a refused write, an answer for another property and a malformed mode are errors", async () => {
    expect(String(await new KnxDevice(new ScriptedDevice(["01cf001100103801000105"]), "1.2.4").propExtWriteCon(17, 1, 56, Buffer.from(KEY, "hex")).catch((e: unknown) => e))).toMatch(/answered/);
    expect(String(await new KnxDevice(new ScriptedDevice(["01d60011001034000000"]), "1.2.4").securityMode().catch((e: unknown) => e))).toMatch(/answered for/);
    expect(String(await new KnxDevice(new ScriptedDevice(["01d600110010330000"]), "1.2.4").securityMode().catch((e: unknown) => e))).toMatch(/security mode/);
  });

  test("an answer with another service, and an address out of range, are refused", async () => {
    expect(String(await new KnxDevice(new ScriptedDevice(["01cd001100103301000101"]), "1.2.4", undefined, { responseMs: 50, retryGapMs: 1 }).securityMode().catch((e: unknown) => e))).toMatch(/service 0x1cd/);
    expect(String(await new KnxDevice(new ScriptedDevice([]), "1.2.4").propExtWriteCon(17, 1, 0x1038, Buffer.alloc(16)).catch((e: unknown) => e))).toMatch(/does not fit/);
    expect(String(await new KnxDevice(new ScriptedDevice([]), "1.2.4").propExtRead(17, 1, 51, 1, 256).catch((e: unknown) => e))).toMatch(/does not fit/);
  });

  test("an extended read with no element is refused, one with elements returns the value", async () => {
    expect(String(await new KnxDevice(new ScriptedDevice(["01cd00110010330000010a"]), "1.2.4").propExtRead(17, 1, 51).catch((e: unknown) => e))).toMatch(/no element/);
    expect(await new KnxDevice(new ScriptedDevice(["01cd001100103301000101"]), "1.2.4").propExtRead(17, 1, 51)).toEqual(Buffer.from([0x01]));
  });
});

// The MDT IP Interface Secure (MV-0012) under ETS 6.4.1's application download, decrypted: the
// security object's address table clear it answers E_ADDRESS_VOID (it has none), and the KNXnet/IP object's
// MAC address read, TTL write and secured-service-family command, as ETS sent them (the scripted device
// answers as 1.2.4; the MAC address in the read is a stand-in for the unit's own).
describe("load steps on objects reached by type, as ETS runs them on a System 1 KNXnet/IP interface", () => {
  test("the E_ADDRESS_VOID answer to the address table clear is taken only where the procedure ignores it", async () => {
    const tun = new ScriptedDevice(["01cf0011001036000000fd"]);
    expect(await new KnxDevice(tun, "1.2.4").propExtWriteCon(17, 1, 54, Buffer.alloc(2), 0, 1, RETURN_CODE_ADDRESS_VOID)).toBe(false);
    expect(tun.sent).toEqual(["01ce00110010360100000000"]);
    expect(String(await new KnxDevice(new ScriptedDevice(["01cf0011001036000000fd"]), "1.2.4").propExtWriteCon(17, 1, 54, Buffer.alloc(2), 0).catch((e: unknown) => e))).toMatch(/answered 00000/);
    expect(String(await new KnxDevice(new ScriptedDevice(["01cf0011001036000000f1"]), "1.2.4").propExtWriteCon(17, 1, 54, Buffer.alloc(2), 0, 1, RETURN_CODE_ADDRESS_VOID).catch((e: unknown) => e))).toMatch(/answered/);
  });

  test("runLoadPlan sends the steps byte for byte as ETS and requires each answer", async () => {
    const tun = new ScriptedDevice(["01cf0011001036000000fd", "01cd000b001040010001020000000001", "01cf000b00104301000100", "01d6000b00105e0000"]);
    const reads: string[] = [];
    await runLoadPlan(new KnxDevice(tun, "1.2.4"), [
      { op: "writeSecurityProp", pid: 54, start: 0, elementSize: 2, data: Buffer.alloc(2), tolerate: RETURN_CODE_ADDRESS_VOID },
      { op: "readPropExt", objectType: 11, instance: 1, pid: 64, start: 1, count: 1 },
      { op: "writePropExt", objectType: 11, instance: 1, pid: 67, start: 1, count: 1, data: Buffer.from([0x20]) },
      { op: "funcPropExt", objectType: 11, instance: 1, pid: 94, data: Buffer.from("00000500", "hex") },
    ], { onRead: (obj, pid, start, data) => reads.push(`${obj}/${pid}#${start}=${data.toString("hex")}`) });
    expect(tun.sent).toEqual(["01ce00110010360100000000", "01cc000b001040010001", "01ce000b0010430100012" + "0", "01d4000b00105e00000500"]);
    expect(reads).toEqual(["11/64#1=020000000001"]);
  });

  test("a function property answered with a return code other than 0, and a refused write, stop the plan", async () => {
    const func = runLoadPlan(new KnxDevice(new ScriptedDevice(["01d6000b00105ef1"]), "1.2.4"), [{ op: "funcPropExt", objectType: 11, instance: 1, pid: 94, data: Buffer.from("00000500", "hex") }]);
    expect(await func.catch((e: { code?: string }) => e.code)).toBe("FUNCTION_PROPERTY_REFUSED");
    const write = runLoadPlan(new KnxDevice(new ScriptedDevice(["01cf000b001043010001f1"]), "1.2.4"), [{ op: "writePropExt", objectType: 11, instance: 1, pid: 67, start: 1, count: 1, data: Buffer.from([0x20]) }]);
    expect(await write.catch((e: { code?: string }) => e.code)).toBe("PROPERTY_EXT_WRITE_REFUSED");
    const read = runLoadPlan(new KnxDevice(new ScriptedDevice(["01cd000b00104000000101"]), "1.2.4"), [{ op: "readPropExt", objectType: 11, instance: 1, pid: 64, start: 1, count: 1 }]);
    expect(await read.catch((e: { code?: string }) => e.code)).toBe("PROPERTY_EXT_READ_REFUSED");
  });
});

describe("a memory write that stops the application outside any load-state machine", () => {
  // A System 1 download stops its application (run error 0x010D = 00) before its image writes and lets it run
  // (FF) after them; a failure in between leaves the device without a running application.
  const device = (failAt: number) => ({
    writesConfirmed: async () => true,
    memWrite: async (address: number) => { if (address === failAt) throw new KnxError("DEVICE_NOT_ANSWERING", "no answer"); },
  }) as unknown as KnxDevice;
  const plan: LoadPlan = [
    { op: "writeMem", address: 0x010d, bytes: Buffer.from([0x00]), opens: "run error" },
    { op: "writeMem", address: 0x0172, bytes: Buffer.alloc(4) },
    { op: "writeMem", address: 0x010d, bytes: Buffer.from([0xff]), closes: "run error" },
    { op: "writeMem", address: 0x00ce, bytes: Buffer.alloc(9) },
  ];
  test("a failure between the two writes is reported as leaving the device unloaded, one after them is not", async () => {
    expect(leftUnloaded(await runLoadPlan(device(0x0172), plan).catch((e: unknown) => e))).toBe(true);
    expect(leftUnloaded(await runLoadPlan(device(0x00ce), plan).catch((e: unknown) => e))).toBe(false);
  });
});
