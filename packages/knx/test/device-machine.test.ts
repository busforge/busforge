import { test, expect, describe } from "bun:test";
import { KnxDevice } from "../src/device.ts";
import { SecureSession } from "../src/secureSession.ts";
import { parseApdu, APCI } from "../src/frame.ts";
import type { KnxTransport } from "../src/transport.ts";

// Frame-level tests of the KnxDevice request machine (numbered T_Data + T_ACK +
// retransmission) against a scripted transport. All response TPDUs are hand-built;
// each byte is derived in a comment from the frame.ts encodings:
//   numbered data octet0 = 0x40 | seq<<2 | apci[9:8];  octet1 = apci[7:0] | low6data
//   T_ACK               = 0xc2 | seq<<2
const DEV = 0x120b; // 1.2.11 = (1<<12)|(2<<8)|11

class FakeTransport implements KnxTransport {
  assignedIa = 0x1101; // 1.1.1 (tunnel-assigned source)
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  sent: Buffer[] = []; // outgoing TPDUs (9-byte cemiLData head stripped)
  handler: ((tpdu: Buffer) => void) | null = null; // per-test device script
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer) {
    const tpdu = Buffer.from(cemi.subarray(9)); // cemiLData head is fixed 9 bytes
    this.sent.push(tpdu);
    this.handler?.(tpdu);
  }
  reply(tpdu: number[]) { this.onCemi?.(DEV, this.assignedIa, Buffer.from(tpdu), false); }
}
// Frames the fake device must not react to: T_Connect (0x80) and the KnxDevice's
// own T_ACKs of our responses (control frames). Reacting to those would loop.
const ignorable = (tpdu: Buffer) => tpdu[0] === 0x80 || parseApdu(tpdu).control;

describe("KnxDevice request machine (frame level)", () => {
  test("happy propRead: numbered read seq 0, device T_ACKs the response, value skips the 4-byte echo", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci !== APCI.PROPERTY_READ) return;
      tun.reply([0xc2 | (p.seq << 2)]); // T_ACK the read
      // PROPERTY_RESPONSE seq 0: octet0 = 0x40 | 0<<2 | (0x3d6>>8 = 3) = 0x43;
      // octet1 = 0x3d6 & 0xff = 0xd6; data = 4-byte obj/pid/start echo (00 0b 10 01,
      // mirroring the request tail) + property value ca fe.
      tun.reply([0x43, 0xd6, 0x00, 0x0b, 0x10, 0x01, 0xca, 0xfe]);
    };
    await dev.connect();
    const v = await dev.propRead(0, 0x0b);
    expect(v.toString("hex")).toBe("cafe"); // the 4 echo bytes are stripped, only the value remains
    // outgoing frame 0: T_Connect = 0x80 (UDT connect control)
    expect(tun.sent[0].toString("hex")).toBe("80");
    // outgoing frame 1: PROPERTY_READ seq 0: octet0 = 0x40|0<<2|(0x3d5>>8 = 3) = 0x43;
    // octet1 = 0x3d5&0xff = 0xd5; tail = obj 00, pid 0b, count 1<<4 | start hi = 10, start lo 01.
    expect(tun.sent[1].toString("hex")).toBe("43d5000b1001");
    // outgoing frame 2: the device T_ACKs OUR response before resolving: 0xc2 | 0<<2 = c2.
    expect(tun.sent[2].toString("hex")).toBe("c2");
    expect(tun.sent.length).toBe(3);
  });

  test("retransmission: an unACKed request is resent byte-identically (same seq) after the ACK timeout", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
    let reads = 0;
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci !== APCI.PROPERTY_READ) return;
      if (++reads === 1) return; // swallow attempt 1: no T_ACK -> device must retransmit after 1.5 s
      tun.reply([0xc2 | (p.seq << 2)]);
      // PROPERTY_RESPONSE seq 0 (see derivation above), value = single byte 01
      tun.reply([0x43, 0xd6, 0x00, 0x0b, 0x10, 0x01, 0x01]);
    };
    const v = await dev.propRead(0, 0x0b);
    expect(v.toString("hex")).toBe("01");
    // Exactly 2 numbered data frames went out, and retransmission means IDENTICAL bytes:
    // the seq must NOT advance on an unacknowledged try (it only advances after ACK).
    const dataFrames = tun.sent.filter((f) => !ignorable(f));
    expect(dataFrames.length).toBe(2);
    expect(dataFrames[0].toString("hex")).toBe("43d5000b1001"); // seq 0 (derived in the happy test)
    expect(dataFrames[1].toString("hex")).toBe("43d5000b1001"); // same seq, same bytes
  }, 10000);

  test("sequence numbers wrap at 15 (4-bit T-sequence): 17 writes carry seq 0..15,0", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      // MEMORY_WRITE carries its byte count in the low 6 APCI bits, so mask to the service
      if ((p.apci & 0x3c0) === APCI.MEMORY_WRITE) tun.reply([0xc2 | (p.seq << 2)]); // T_ACK only, no response
    };
    // 17 one-byte chunks = 17 numbered requests = one full 0..15 cycle plus the wrap-around
    await dev.memWrite(0x2000, Buffer.alloc(17, 0x5a), { chunk: 1, verify: false });
    const writes = tun.sent.filter((f) => !ignorable(f));
    expect(writes.length).toBe(17);
    // T-sequence lives in octet0 bits 5..2 (frame.ts: 0x40 | seq<<2 | apci-hi)
    expect(writes.map((f) => (f[0] >> 2) & 0x0f)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0]);
    // First write, fully hand-built: octet0 = 0x40|0<<2|(0x280>>8 = 2) = 0x42;
    // octet1 = (0x280&0xff = 0x80) | count 1 = 0x81; addr 20 00; data 5a.
    expect(writes[0].toString("hex")).toBe("428120005a");
    // 17th write: seq wrapped to 0 (identical octet0), address advanced to 0x2000+16 = 0x2010.
    expect(writes[16].toString("hex")).toBe("428120105a");
  });

  test("memWrite verify:true rejects when the read-back differs from what was written", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if ((p.apci & 0x3c0) === APCI.MEMORY_WRITE) { tun.reply([0xc2 | (p.seq << 2)]); return; } // accept the write
      if ((p.apci & 0x3c0) === APCI.MEMORY_READ) {
        tun.reply([0xc2 | (p.seq << 2)]);
        const count = p.apci & 0x3f; // requested length rides in the low 6 APCI bits
        // MEMORY_RESPONSE: octet0 = 0x40 | seq<<2 | (0x240>>8 = 2); octet1 = 0x40 | count;
        // then the 2-byte address echo and count bytes that are NOT what was written (0xee).
        tun.reply([0x40 | (p.seq << 2) | 0x02, 0x40 | count, p.data[0], p.data[1], ...Array(count).fill(0xee)]);
      }
    };
    // wrote 12 34 but the device "stored" ee ee -> the verify read-back must reject
    await expect(dev.memWrite(0x1000, Buffer.from([0x12, 0x34]), { verify: true })).rejects.toThrow(/verify mismatch/);
  });

  test("deviceDescriptor: descriptor bytes 07 b0 resolve to MV-07B0", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci !== APCI.DEVICE_DESCRIPTOR_READ) return;
      tun.reply([0xc2 | (p.seq << 2)]);
      // DEVICE_DESCRIPTOR_RESPONSE seq 0: octet0 = 0x40 | 0<<2 | (0x340>>8 = 3) = 0x43;
      // octet1 = 0x340 & 0xff = 0x40; data = mask version 07 b0 (descriptor type 0).
      tun.reply([0x43, 0x40, 0x07, 0xb0]);
    };
    expect(await dev.deviceDescriptor()).toBe("MV-07B0");
    // and the read itself: octet0 = 0x40|0<<2|(0x300>>8 = 3) = 0x43; octet1 = 0x300&0xff = 00
    expect(tun.sent[0].toString("hex")).toBe("4300");
  });

  // A secure device retransmits its response when our T_ACK is lost. The retransmission
  // carries the same 48-bit secure sequence, so the receive-side replay guard flags it as a
  // replay. device.onCemi must still T_ACK it (so the device stops retransmitting) but must
  // NOT re-deliver it. Regression guard for the replay-protection change.
  test("secure: a replayed device response is re-ACKed at the transport layer, not re-delivered", async () => {
    const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const tun = new FakeTransport();
    // The KnxDevice's own session (src = our tunnel IA, dst = the device).
    const ourSession = new SecureSession({ toolKey, src: tun.assignedIa, dst: DEV });
    const dev = new KnxDevice(tun, "1.2.11", ourSession);
    // The paired far side (the device) that produces the secured response.
    const farSide = new SecureSession({ toolKey, src: DEV, dst: tun.assignedIa });
    const wrapped = farSide.wrapManagement(Buffer.from("0340abcd", "hex"), 5); // T-seq 5

    const ackForSeq5 = (0xc2 | (5 << 2)).toString(16); // tpAck(5) = 0xd6
    // First delivery: MAC-valid and fresh -> device ACKs it.
    tun.reply([...wrapped]);
    expect(tun.sent.map((f) => f.toString("hex"))).toContain(ackForSeq5);
    const acksAfterFirst = tun.sent.filter((f) => f.toString("hex") === ackForSeq5).length;

    // Bit-identical retransmission (our first ACK was lost): still ACKed, so a SECOND ACK
    // goes out. Before the fix, the replay was dropped before the ACK and the device would
    // exhaust its retries and disconnect mid-operation.
    tun.reply([...wrapped]);
    const acksAfterReplay = tun.sent.filter((f) => f.toString("hex") === ackForSeq5).length;
    expect(acksAfterReplay).toBe(acksAfterFirst + 1);
  });
});
