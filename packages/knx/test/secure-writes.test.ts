import { test, expect, describe } from "bun:test";
import { KnxDevice, type DeviceTimeouts } from "../src/device.ts";
import { SecureSession } from "../src/secureSession.ts";
import { parseApdu, APCI } from "../src/frame.ts";
import type { KnxTransport } from "../src/transport.ts";

// A secured KnxDevice end to end: the sizes of its writes (transferChunks, secure-framing.test.ts; the
// capture pin is tools/secure-chunks.test.ts) and its sending-sequence write.

const DEV = 0x110b; // 1.1.11
const FAST: DeviceTimeouts = { ackMs: 15, responseMs: 20, retryGapMs: 1, syncResponseMs: 30, restartAnswerMs: 20, restartProofMs: 150, droppedRepeatMs: 12_000, staleConnectionMs: 50, reconnectGapMs: 10, confirmLateMs: 20 };
const KEY = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

// A secured device declaring `deviceMax` behind an interface announcing `interfaceMax` (none when
// undefined) and reached from the tunnel address `me`, answering its maximum APDU, extended memory
// writes and confirmed property writes. `writes` records the data length of every memory write and the
// element count of every property write.
// `requests` keeps every request's plaintext; the device sends from `deviceSeq`.
function securedDevice(deviceMax: number, interfaceMax?: number, me = 0x1101, deviceSeq = 0x112f7n) {
  const writes: string[] = [];
  const requests: string[] = [];
  const far = new SecureSession({ toolKey: KEY, src: DEV, dst: me, seq: deviceSeq });
  const tun: KnxTransport & { onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null } = {
    assignedIa: me,
    onCemi: null,
    onClosed: null,
    async connect() {},
    async disconnect() {},
    ...(interfaceMax === undefined ? {} : { queryMaxApdu: async () => interfaceMax }),
    async sendCemi(cemi: Buffer) {
      const tpdu = Buffer.from(cemi.subarray(9));
      if (tpdu[0] === 0x80 || parseApdu(tpdu).control) return;
      const seq = (tpdu[0] >> 2) & 0x0f;
      const r = far.unwrap(tpdu);
      if (r.status !== "ok") throw new Error(`the fake device could not open a request: ${r.status}`);
      const a = r.apdu, apci = ((a[0] & 0x03) << 8) | a[1];
      requests.push(a.toString("hex"));
      let answer: Buffer;
      if (apci === APCI.PROPERTY_READ && a[3] === 56) answer = Buffer.from([0x03, 0xd6, 0, 56, 0x10, 0x01, deviceMax >> 8, deviceMax & 0xff]);
      else if (apci === APCI.MEMORY_EXT_WRITE) { writes.push(`mem ${a[2]}`); answer = Buffer.from([0x01, 0xfc, 0x00, a[3], a[4], a[5]]); }
      else if (apci === APCI.PROPERTY_EXT_WRITE_CON) { writes.push(`prop ${a[7]}`); answer = Buffer.concat([Buffer.from([0x01, 0xcf]), a.subarray(2, 10), Buffer.from([0x00])]); }
      else throw new Error(`the fake device has no answer to APCI 0x${apci.toString(16)}`);
      queueMicrotask(() => {
        tun.onCemi?.(DEV, me, Buffer.from([0xc2 | (seq << 2)]), false);
        tun.onCemi?.(DEV, me, far.wrapManagement(answer, seq), false);
      });
    },
  };
  const dev = new KnxDevice(tun, "1.1.11", new SecureSession({ toolKey: KEY, src: me, dst: DEV }), FAST);
  dev.setExtendedMemoryServices(true);
  return { dev, writes, requests, far };
}

// ETS's re-activation of the reset Jung 400021SE (private corpus internal/captures/cap-1001/ets-jung-full.log,
// decrypted): right after the tool key, under it, `01ce 0011 001 03b 01 0001 004032bdc207`: PID 59 of the
// security object, one element from 1, six octets, the value of ETS's millisecond clock. The device
// answered that write, and everything after, from that sequence on.
describe("the device's sending sequence (PID 59)", () => {
  test("is written as ETS writes it: one six-octet element from 1, big-endian", async () => {
    const { dev, requests } = securedDevice(233);
    expect(await dev.writeSendingSequence(0x4032bdc207n)).toBe(0x4032bdc207n);
    expect(requests).toEqual(["01ce001100103b010001004032bdc207"]);
  });
  test("never goes below a sequence the device has sent in the session", async () => {
    const { dev, requests } = securedDevice(233, undefined, 0x1101, 0x5000_0000_0000n);
    await dev.writeSendingSequence(0x4032bdc207n); // answered from the device's own, higher counter
    requests.length = 0;
    const written = await dev.writeSendingSequence(0x4032bdc207n);
    expect(written > 0x5000_0000_0000n).toBe(true);
    expect(requests).toEqual([`01ce001100103b010001${written.toString(16).padStart(12, "0")}`]);
  });
  test("is only written inside a secured session", async () => {
    const plain = new KnxDevice({ assignedIa: 0x1101, onCemi: null, onClosed: null, async connect() {}, async disconnect() {}, async sendCemi() {} }, "1.1.11", undefined, FAST);
    expect(((await plain.writeSendingSequence(1n).catch((e: unknown) => e)) as { code?: string }).code).toBe("SECURE_SESSION_REQUIRED");
  });
});

describe("a secured KnxDevice sizes its writes by the interface it is reached through", () => {
  test("behind an interface announcing 210, a device declaring 55 gets ETS's 37-byte memory writes and 33-element property writes", async () => {
    const { dev, writes } = securedDevice(55, 210);
    await dev.memWrite(0x4000, Buffer.alloc(80, 0xaa));
    await dev.propExtWriteElements(17, 1, 61, 1, 1, Buffer.alloc(70));
    expect(writes).toEqual(["mem 37", "mem 37", "mem 6", "prop 33", "prop 33", "prop 4"]);
  });
  test("behind an interface announcing nothing, the same device gets 22 and 18", async () => {
    const { dev, writes } = securedDevice(55);
    await dev.memWrite(0x4000, Buffer.alloc(44, 0xaa));
    await dev.propExtWriteElements(17, 1, 61, 1, 1, Buffer.alloc(36));
    expect(writes).toEqual(["mem 22", "mem 22", "prop 18", "prop 18"]);
  });
  test("behind an interface announcing 210 on another line, where a coupler may not pass the longer frame, it gets 22 and 18", async () => {
    const { dev, writes } = securedDevice(55, 210, 0x1201); // the tunnel at 1.2.1, the device at 1.1.11
    await dev.memWrite(0x4000, Buffer.alloc(44, 0xaa));
    await dev.propExtWriteElements(17, 1, 61, 1, 1, Buffer.alloc(36));
    expect(writes).toEqual(["mem 22", "mem 22", "prop 18", "prop 18"]);
  });
});
