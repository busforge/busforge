import { test, expect, describe } from "bun:test";
import { KnxDevice, APCI, apdu, parseApdu, tpAck, type KnxTransport } from "@busforge/knx";
import { confirmedMatch } from "@busforge/product";

// The read-back check that accepts a byte the device does not give back on its write confirmation.
// Segment at 0x100: byte 0 a parameter the operation changed, bytes 1-2 a field the device reads as FF.
describe("confirmedMatch", () => {
  const AT = 0x100;
  const want = Buffer.from([0x11, 0x41, 0x42, 0x07]);
  const before = Buffer.from([0x10, 0xff, 0xff, 0x07]);
  const back = Buffer.from([0x11, 0xff, 0xff, 0x07]);
  const mask = [true, true, true, true];
  const wrote = [{ address: AT, bytes: Buffer.from([0x11, 0x41, 0x42]) }];

  test("every byte read back as wanted: nothing rests on the confirmation", () => {
    expect(confirmedMatch(want, want, mask, AT, wrote, before)).toEqual([]);
  });
  test("a field the device does not give back, the rest of the write landed: its bytes in one run", () => {
    expect(confirmedMatch(back, want, mask, AT, wrote, before)).toEqual([{ address: AT + 1, length: 2 }]);
  });
  test("a byte the operation did not write is not covered", () => {
    expect(confirmedMatch(back, want, mask, AT, [{ address: AT, bytes: Buffer.from([0x11, 0x41]) }], before)).toBeNull();
  });
  test("a confirmation of another value is not covered", () => {
    expect(confirmedMatch(back, want, mask, AT, [{ address: AT, bytes: Buffer.from([0x11, 0x41, 0x43]) }], before)).toBeNull();
  });
  test("a byte that reads a third value, neither written nor held before, is not covered", () => {
    expect(confirmedMatch(Buffer.from([0x11, 0xff, 0x00, 0x07]), want, mask, AT, wrote, before)).toBeNull();
  });
  test("a byte that reads its old data, a write lost or rejected beside one that landed, is not covered", () => {
    const old = Buffer.from([0x10, 0x30, 0x31, 0x07]);
    expect(confirmedMatch(Buffer.from([0x11, 0x30, 0x31, 0x07]), want, mask, AT, wrote, old)).toBeNull();
  });
  test("a byte past the end of the before-image is no sign the write landed", () => {
    const all = [{ address: AT, bytes: want }];
    expect(confirmedMatch(back, want, mask, AT, all, Buffer.from([0x11, 0xff, 0xff]))).toBeNull();
  });
  test("without the segment as read before the operation nothing is covered", () => {
    expect(confirmedMatch(back, want, mask, AT, wrote, null)).toBeNull();
  });
  test("a read-back showing nothing of the write landed (a device that reverted) is not covered", () => {
    expect(confirmedMatch(Buffer.from([0x10, 0xff, 0xff, 0x07]), want, mask, AT, wrote, before)).toBeNull();
    // Nothing else changed: the field is all the operation wrote, and its read shows nothing of it.
    expect(confirmedMatch(back, want, mask, AT, wrote, Buffer.from([0x11, 0xff, 0xff, 0x07]))).toBeNull();
  });
  test("a changed byte the operation did not write is no sign the write landed", () => {
    expect(confirmedMatch(back, want, mask, AT, [{ address: AT + 1, bytes: Buffer.from([0x41, 0x42]) }], before)).toBeNull();
  });
  test("bits outside the mask are not compared, a masked-out byte is not covered as confirmation-only", () => {
    expect(confirmedMatch(Buffer.from([0x11, 0xff, 0xff, 0x00]), want, [true, true, true, false], AT, wrote, before)).toEqual([{ address: AT + 1, length: 2 }]);
    // A bit-masked byte whose masked bits read back as wanted is no confirmation-only byte.
    expect(confirmedMatch(Buffer.from([0x11, 0xf1, 0xff, 0x07]), want, [true, 0x0f, true, true], AT, wrote, Buffer.from([0x10, 0xf1, 0xff, 0x07]))).toEqual([{ address: AT + 2, length: 1 }]);
  });
  test("a read-back shorter than the mask is not verified", () => {
    expect(confirmedMatch(back.subarray(0, 3), want, mask, AT, wrote, before)).toBeNull();
  });

  // The confirmation is per chunk, from the device's return code: a chunk it answers with any other code
  // stops the write and is not logged, so a byte in it is never accepted, even one reading FF before and after.
  describe("on a device's own write answers", () => {
    // Answers each extended write [code, addr(3)], with code 1 for a chunk starting at `rejectAt`.
    class ExtWriteUnit implements KnxTransport {
      assignedIa = 0x0001;
      onCemi: KnxTransport["onCemi"] = null;
      onClosed: KnxTransport["onClosed"] = null;
      constructor(private readonly rejectAt?: number) {}
      async connect() {}
      async disconnect() {}
      async sendCemi(cemi: Buffer) {
        const p = parseApdu(cemi.subarray(9));
        if (p.control || p.apci !== APCI.MEMORY_EXT_WRITE) return;
        const addr = (p.data[1] << 16) | (p.data[2] << 8) | p.data[3];
        this.onCemi?.(0x110b, this.assignedIa, tpAck(p.seq), false);
        const head = Buffer.from([addr === this.rejectAt ? 0x01 : 0x00, (addr >> 16) & 0xff, (addr >> 8) & 0xff, addr & 0xff]);
        this.onCemi?.(0x110b, this.assignedIa, apdu(p.seq, APCI.MEMORY_EXT_WRITE_RESP, head), false);
      }
    }
    const write = async (rejectAt?: number) => {
      const dev = new KnxDevice(new ExtWriteUnit(rejectAt), "1.1.11");
      const err = await dev.memWriteExtended(AT, want.subarray(0, 3), { chunk: 1 }).then(() => null, (e: Error) => e);
      return { err, log: dev.confirmedWrites() };
    };

    test("every chunk answered with code 0: the field rests on the confirmation", async () => {
      const { err, log } = await write();
      expect(err).toBeNull();
      expect(confirmedMatch(back, want, mask, AT, log, before)).toEqual([{ address: AT + 1, length: 2 }]);
    });
    test("a chunk the device rejects stops the write, and its byte is not covered though it reads FF before and after", async () => {
      const { err, log } = await write(AT + 2);
      expect(err?.message).toMatch(/rejected an extended write/);
      expect(log.map((c) => c.address)).toEqual([AT, AT + 1]);
      expect(confirmedMatch(back, want, mask, AT, log, before)).toBeNull();
    });
  });
});
