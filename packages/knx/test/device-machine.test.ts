import { test, expect, describe } from "bun:test";
import { KnxDevice, SYNC_GAP_MS, type DeviceTimeouts } from "../src/device.ts";
import { SecureSession } from "../src/secureSession.ts";
import { parseApdu, APCI } from "../src/frame.ts";
import type { KnxTransport } from "../src/transport.ts";
import { KnxError } from "../src/errors.ts";

// Frame-level tests of the KnxDevice request machine (numbered T_Data + T_ACK +
// retransmission) against a scripted transport. All response TPDUs are hand-built;
// each byte is derived in a comment from the frame.ts encodings:
//   numbered data octet0 = 0x40 | seq<<2 | apci[9:8];  octet1 = apci[7:0] | low6data
//   T_ACK               = 0xc2 | seq<<2
const DEV = 0x110b; // 1.1.11 = (1<<12)|(1<<8)|11
// The scripted transport answers inside the send or not at all, so a device timeout only ever measures
// a silence: the bus timeouts shrink to milliseconds, in the order they have on the bus.
const FAST: DeviceTimeouts = { ackMs: 15, responseMs: 20, retryGapMs: 1, syncResponseMs: 30, restartAnswerMs: 20, restartProofMs: 150 };

class FakeTransport implements KnxTransport {
  assignedIa = 0x1101; // 1.1.1 (tunnel-assigned source)
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  sent: Buffer[] = []; // outgoing TPDUs (9-byte cemiLData head stripped)
  handler: ((tpdu: Buffer) => void) | null = null; // per-test device script
  // The interface's confirmation of a frame: a code here rejects the send (BUS_SEND_FAILED = negative L_Data.con).
  failSend: ((tpdu: Buffer) => string | null) | null = null;
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer) {
    const tpdu = Buffer.from(cemi.subarray(9)); // cemiLData head is fixed 9 bytes
    this.sent.push(tpdu);
    this.handler?.(tpdu);
    const code = this.failSend?.(tpdu);
    if (code) throw new KnxError(code, `fake interface: ${code}`);
  }
  reply(tpdu: number[]) { this.onCemi?.(DEV, this.assignedIa, Buffer.from(tpdu), false); }
}
// Frames the fake device must not react to: T_Connect (0x80) and the KnxDevice's
// own T_ACKs of our responses (control frames). Reacting to those would loop.
const ignorable = (tpdu: Buffer) => tpdu[0] === 0x80 || parseApdu(tpdu).control;
// The device implements no PID_MAX_APDU_LENGTH (the first memory write asks for it): T_ACK, then a
// property response with no element, so memWrite keeps the classic service.
const answersNoMaxApdu = (tun: FakeTransport, p: ReturnType<typeof parseApdu>): boolean => {
  if (p.apci !== APCI.PROPERTY_READ || p.data[1] !== 56) return false;
  tun.reply([0xc2 | (p.seq << 2)]);
  tun.reply([0x40 | (p.seq << 2) | 0x03, 0xd6, 0, 56, 0x00, 0x01]);
  return true;
};

describe("KnxDevice request machine (frame level)", () => {
  test("happy propRead: numbered read seq 0, device T_ACKs the response, value skips the 4-byte echo", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
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

  test("an optional property the device does not implement (count 0) reads as absent, not as a value", async () => {
    for (const [answer, expected] of [[[0x43, 0xd6, 0x00, 0x09, 0x00, 0x01, 0x07], null], [[0x43, 0xd6, 0x00, 0x09, 0x10, 0x01, 0x12], "12"]] as const) {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
      tun.handler = (tpdu) => {
        if (ignorable(tpdu)) return;
        const p = parseApdu(tpdu);
        if (p.apci !== APCI.PROPERTY_READ) return;
        tun.reply([0xc2 | (p.seq << 2)]);
        tun.reply([...answer]); // PROPERTY_RESPONSE seq 0: obj 00, pid 09, count<<4 in octet 4, then data
      };
      const v = await dev.propReadIfPresent(0, 9);
      expect(v === null ? null : v.toString("hex")).toBe(expected);
    }
  });

    test("retransmission: an unACKed request is resent byte-identically (same seq) after the ACK timeout", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    let reads = 0;
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci !== APCI.PROPERTY_READ) return;
      if (++reads === 1) return; // swallow attempt 1: no T_ACK -> device must retransmit after the ACK timeout
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
  });

  test("sequence numbers wrap at 15 (4-bit T-sequence): 17 writes carry seq 0..15,0", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (answersNoMaxApdu(tun, p)) return;
      // MEMORY_WRITE carries its byte count in the low 6 APCI bits, so mask to the service
      if ((p.apci & 0x3c0) === APCI.MEMORY_WRITE) tun.reply([0xc2 | (p.seq << 2)]); // T_ACK only, no response
    };
    // The PID_MAX_APDU_LENGTH read takes seq 0; 17 one-byte chunks then carry 1..15, 0, 1: the wrap
    await dev.memWrite(0x2000, Buffer.alloc(17, 0x5a), { chunk: 1, verify: false });
    const writes = tun.sent.filter((f) => !ignorable(f) && (parseApdu(f).apci & 0x3c0) === APCI.MEMORY_WRITE);
    expect(writes.length).toBe(17);
    // T-sequence lives in octet0 bits 5..2 (frame.ts: 0x40 | seq<<2 | apci-hi)
    expect(writes.map((f) => (f[0] >> 2) & 0x0f)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1]);
    // First write, fully hand-built: octet0 = 0x40|1<<2|(0x280>>8 = 2) = 0x46;
    // octet1 = (0x280&0xff = 0x80) | count 1 = 0x81; addr 20 00; data 5a.
    expect(writes[0].toString("hex")).toBe("468120005a");
    // 16th write: seq wrapped to 0, address advanced to 0x2000+15 = 0x200f.
    expect(writes[15].toString("hex")).toBe("4281200f5a");
  });

  test("memWrite verify:true rejects when the read-back differs from what was written", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (answersNoMaxApdu(tun, p)) return;
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
    expect(dev.memWrite(0x1000, Buffer.from([0x12, 0x34]), { verify: true })).rejects.toThrow(/verify mismatch/);
  });

  test("deviceDescriptor: descriptor bytes 07 b0 resolve to MV-07B0", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
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
    // Constructing it IS the point: KnxDevice installs itself as tun.onCemi, and that is what
    // tun.reply() below drives. The instance is never touched directly.
    new KnxDevice(tun, "1.1.11", ourSession, FAST);
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

  // An answer that fails its MAC is never used; when the device acknowledged the request and then
  // sent only such answers, the error says it answered and was not believed, not that it was silent.
  // A replay is MAC-valid (the key is fine) and a stale retransmission is ordinary transport, so it
  // is not evidence of anything: a device that sends nothing else is reported as not answering.
  const secureFake = (reply: (tun: FakeTransport, seq: number, farSide: SecureSession) => void, ack = true) => {
    const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const tun = new FakeTransport();
    const farSide = new SecureSession({ toolKey, src: DEV, dst: tun.assignedIa });
    const dev = new KnxDevice(tun, "1.1.11", new SecureSession({ toolKey, src: tun.assignedIa, dst: DEV }), FAST);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const seq = (tpdu[0] >> 2) & 0x0f;
      if (ack) tun.reply([0xc2 | (seq << 2)]);
      reply(tun, seq, farSide);
    };
    return { dev, farSide, tun };
  };
  const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as { code?: string }).code;

  test("secure: answers that fail authentication after an acknowledged request fail as rejected", async () => {
    const { dev } = secureFake((tun, seq, far) => { const f = far.wrapManagement(Buffer.from("0340abcd", "hex"), seq); f[f.length - 1] ^= 1; tun.reply([...f]); });
    expect(await code(dev.deviceDescriptor())).toBe("SECURE_ANSWER_REJECTED");
  });

  test("secure: a replayed answer followed by silence is not answering, not a key problem", async () => {
    let earlier: Buffer | null = null;
    const { dev } = secureFake((tun, seq, far) => {
      if (!earlier) { earlier = far.wrapManagement(Buffer.from("0340abcd", "hex"), seq); tun.reply([...earlier]); return; }
      tun.reply([...earlier]);
    });
    await dev.deviceDescriptor();
    expect(await code(dev.deviceDescriptor())).toBe("DEVICE_NOT_ANSWERING");
  });

  test("secure: a garbled frame on a request that was never acknowledged is not answering", async () => {
    const { dev } = secureFake((tun, seq, far) => { const f = far.wrapManagement(Buffer.from("0340abcd", "hex"), seq); f[f.length - 1] ^= 1; tun.reply([...f]); }, false);
    expect(await code(dev.deviceDescriptor())).toBe("DEVICE_NOT_ANSWERING");
  });

  // The device answers the tool key write under the new key (ETS capture, Jung 400021SE).
  test("secure: the tool key write is sent once under the old key and its answer taken under the new one", async () => {
    const oldKey = Buffer.alloc(16, 0xfd), newKey = Buffer.alloc(16, 0x11);
    const tun = new FakeTransport();
    const farOld = new SecureSession({ toolKey: oldKey, src: DEV, dst: tun.assignedIa });
    const farNew = new SecureSession({ toolKey: newKey, src: DEV, dst: tun.assignedIa });
    const dev = new KnxDevice(tun, "1.1.11", new SecureSession({ toolKey: oldKey, src: tun.assignedIa, dst: DEV }), FAST);
    const inner: string[] = [];
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const r = farOld.unwrap(tpdu);
      if (r.status !== "ok") throw new Error("the write must go out under the old key");
      inner.push(r.apdu.toString("hex"));
      const seq = (tpdu[0] >> 2) & 0x0f;
      tun.reply([0xc2 | (seq << 2)]);
      tun.reply([...farNew.wrapManagement(Buffer.from("01cf001100103801000100", "hex"), seq)]);
    };
    await dev.writeToolKey(newKey);
    expect(inner).toEqual(["01ce0011001038010001" + newKey.toString("hex")]);
  });

  test("secure: an unanswered tool key write is not retried", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", new SecureSession({ toolKey: Buffer.alloc(16, 0xfd), src: tun.assignedIa, dst: DEV }), FAST);
    let sent = 0;
    tun.handler = (tpdu) => { if (!ignorable(tpdu)) sent++; };
    const err = await dev.writeToolKey(Buffer.alloc(16, 0x11)).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("DEVICE_NOT_ANSWERING");
    expect(sent).toBe(1);
  });

  // A device in secure mode acknowledges a plain A_Restart on the transport layer and then ignores
  // it (Jung 400021SE, 2026-09-28): the restart, and the master reset, go through the session.
  test("secure: A_Restart and the master reset are sent secured, never plain", async () => {
    const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const tun = new FakeTransport();
    tun.handler = () => { /* a rebooting device answers nothing */ };
    const dev = new KnxDevice(tun, "1.1.11", new SecureSession({ toolKey, src: tun.assignedIa, dst: DEV }), FAST);
    await dev.restart();
    await dev.masterReset();
    const farSide = new SecureSession({ toolKey, src: DEV, dst: tun.assignedIa });
    const restart = tun.sent[0], reset = tun.sent[tun.sent.length - 1];
    for (const f of [restart, reset]) expect(f[1]).toBe(0xf1); // A_Data_Secure, not the service in clear
    const inner = (f: Buffer) => { const r = farSide.unwrap(f); if (r.status !== "ok") throw new Error(r.status); return ((r.apdu[0] & 0x03) << 8) | r.apdu[1]; };
    expect(inner(restart)).toBe(APCI.RESTART);
    expect(inner(reset) & 0x3fe).toBe(APCI.RESTART);
  });

  // A secure device drops a Sync request it cannot authenticate without answering, so silence is
  // what a wrong tool key (or a device not in secure mode) looks like; the error has to say so.
  test("secure: a Sync nobody answers fails with a coded error", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", new SecureSession({ toolKey: Buffer.alloc(16, 1), src: tun.assignedIa, dst: DEV, serial: Buffer.alloc(6, 2) }), FAST);
    tun.handler = () => { /* silence */ };
    const err = await dev.connect().catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_SYNC_NO_RESPONSE");
  });

  // The Jung 400021SE ignores a Sync request less than about a second after the previous one to it
  // (docs/findings.md §21). A second session to the same device keeps the gap; another device does not wait.
  test("secure: a second Sync to the same device waits out the gap, over any transport; another device's does not", async () => {
    const tun = new FakeTransport();
    const syncs: { dst: number; t: number }[] = [];
    const session = (dst: number) => new SecureSession({ toolKey: Buffer.alloc(16, 1), src: tun.assignedIa, dst, serial: Buffer.alloc(6, 2) });
    // Answer every Sync at once with a frame that is not a valid Sync response: the connect fails
    // immediately (SECURE_SYNC_FAILED) instead of timing out, so the send times are the gap alone.
    const A = 0x1171, B = 0x1172; // addresses no other test syncs with
    let target = A;
    const answerSyncs = (t: FakeTransport) => (tpdu: Buffer) => {
      if (tpdu[1] !== 0xf1) return;
      syncs.push({ dst: target, t: Date.now() });
      t.onCemi?.(target, t.assignedIa, Buffer.from("43f193" + "00".repeat(22), "hex"), false);
    };
    tun.handler = answerSyncs(tun);
    const t0 = Date.now();
    await new KnxDevice(tun, "1.1.113", session(A), FAST).connect().catch(() => undefined);
    target = B;
    await new KnxDevice(tun, "1.1.114", session(B), FAST).connect().catch(() => undefined);
    target = A;
    // Over a second transport, as the server opens one per operation: the gap still holds.
    const tun2 = new FakeTransport();
    tun2.handler = answerSyncs(tun2);
    await new KnxDevice(tun2, "1.1.113", session(A), FAST).connect().catch(() => undefined);
    expect(syncs.map((x) => x.dst)).toEqual([A, B, A]);
    expect(syncs[0].t - t0).toBeLessThan(200);
    expect(syncs[1].t - syncs[0].t).toBeLessThan(200); // another device: no wait
    expect(syncs[2].t - syncs[0].t).toBeGreaterThanOrEqual(SYNC_GAP_MS - 5);
  }, 10_000);
});

// restart() is the step that makes a download STICK, and the only one whose success is inferred
// from SILENCE. LdCtrlLoadCompleted persists nothing on this stack: the flash metadata (the four
// load states, the table addresses, the individual address) is written from one place reachable
// over the bus, `BauSystemB::restartRequestIndication()`, i.e. on receiving A_Restart. It used to
// be fired with `catch {}` into a connection that the preceding 8 s settle had already let time out
// (a connection-oriented link dies after 6 s of silence). It never arrived, nothing noticed, and
// every check that followed passed against the device's RAM while its flash held nothing. Then the
// bench powered the device down and it came back factory-fresh.
//
// So all three of these are load-bearing, and each one is a way that failure comes back.
describe("KnxDevice.restart: the reboot is proven, never assumed", () => {
  const restarted = () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    // A rebooting device answers nothing at all: it is gone, and so is the connection.
    tun.handler = () => { /* silence */ };
    return { tun, dev };
  };

  test("the device goes quiet after A_Restart: that IS the proof, and it resolves", async () => {
    const { tun, dev } = restarted();
    await dev.restart();
    // A_Restart went out as a numbered request (APCI 0x380), and nothing was swallowed.
    const restart = tun.sent.filter((f) => !f[0].toString(2).startsWith("11") && parseApdu(f).apci === APCI.RESTART);
    expect(restart.length).toBeGreaterThan(0);
  });

  test("a device that KEEPS ANSWERING did not reboot, and that is a failure, not a success", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    // The device ACKs and answers the descriptor read: it is still there, still holding the
    // connection, and it has therefore written NOTHING to flash. Reporting this download as done
    // is the exact bug: the caller would then verify against RAM and see everything it expects.
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci === APCI.RESTART) { tun.reply([0xc2 | (p.seq << 2)]); return; }
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) {
        tun.reply([0xc2 | (p.seq << 2)]);
        tun.reply([0x40 | (p.seq << 2) | 0x03, 0x40, 0x07, 0xb0]); // still alive, MV-07B0
      }
    };
    expect(dev.restart()).rejects.toThrow(/RESTART_IGNORED|did not reboot/);
  });

  test("with requireReboot=false, a device that keeps answering is fine (it persisted at LoadCompleted)", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    // Same device as above: it keeps answering after A_Restart. For firmware that persists at
    // LoadCompleted (the GVS AMMA, hardware-verified across a power cycle), that is not a failure —
    // the configuration is already saved and the device simply does not reboot on A_Restart.
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci === APCI.RESTART) { tun.reply([0xc2 | (p.seq << 2)]); return; }
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) {
        tun.reply([0xc2 | (p.seq << 2)]);
        tun.reply([0x40 | (p.seq << 2) | 0x03, 0x40, 0x07, 0xb0]);
      }
    };
    await dev.restart(false); // resolves, does not throw
    // The A_Restart still went out — best-effort, not skipped.
    expect(tun.sent.filter((f) => !f[0].toString(2).startsWith("11") && parseApdu(f).apci === APCI.RESTART).length).toBeGreaterThan(0);
  });

  // A device that reboots at once on A_Restart sends no L2 acknowledgement, so the interface confirms
  // the frame negatively although it arrived (private corpus captures/meanwell-ets-restart.log CON-NEG,
  // the unit's startup telegrams 2 s later; ETS goes on). Such a restart counts as sent and unconfirmed.
  const isRestart = (tpdu: Buffer) => !ignorable(tpdu) && (parseApdu(tpdu).apci & ~0x01) === APCI.RESTART;
  const negativeOnRestart = (tun: FakeTransport) => { tun.failSend = (tpdu) => (isRestart(tpdu) ? "BUS_SEND_FAILED" : null); };
  test("a negative L_Data.con on A_Restart, then silence: not proven, the restart sent once", async () => {
    const { tun, dev } = restarted();
    negativeOnRestart(tun);
    const failure = await dev.restart().then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_UNPROVEN");
    expect(tun.sent.filter(isRestart).length).toBe(1);
  });
  test("a negative L_Data.con on A_Restart and a device that keeps answering: not restarted, even with requireReboot=false", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    negativeOnRestart(tun);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) {
        tun.reply([0xc2 | (p.seq << 2)]);
        tun.reply([0x40 | (p.seq << 2) | 0x03, 0x40, 0x07, 0xb0]);
      }
    };
    const failure = await dev.restart(false).then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_IGNORED");
    expect(String(failure)).toMatch(/confirmed A_Restart negatively/);
  });
  // A transport-correct device: it answers the sequence number it expects, acknowledges and drops a
  // repetition of the last one, refuses any other with T_NAK, and starts counting at 0 on T_Connect.
  const keepsRunning = (tun: FakeTransport, lostRestart: boolean) => {
    let expect = 0;
    tun.failSend = (tpdu) => (isRestart(tpdu) ? "BUS_SEND_FAILED" : null);
    tun.handler = (tpdu) => {
      if (tpdu[0] === 0x80) { expect = 0; return; }
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (lostRestart && isRestart(tpdu)) return; // the frame never reached the device
      if (p.seq === ((expect + 15) & 0x0f)) { tun.reply([0xc2 | (p.seq << 2)]); return; }
      if (p.seq !== expect) { tun.reply([0xc3 | (p.seq << 2)]); return; }
      expect = (expect + 1) & 0x0f;
      tun.reply([0xc2 | (p.seq << 2)]);
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) tun.reply([0x40 | (p.seq << 2) | 0x03, 0x40, 0x07, 0xb0]);
    };
  };
  test("a negatively confirmed A_Restart and a device still running is RESTART_IGNORED, whether it saw the frame or not", async () => {
    for (const confirmed of [false, true]) for (const lost of [true, false]) {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
      keepsRunning(tun, lost);
      const failure = await dev.restart(true, confirmed).then(() => null, (e: unknown) => e);
      expect([confirmed, lost, (failure as { code?: string } | null)?.code]).toEqual([confirmed, lost, "RESTART_IGNORED"]);
    }
  });
  test("a negatively confirmed A_Restart and a device back already, without the connection: proven by its T_Disconnect", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    negativeOnRestart(tun);
    // Rebooted and up again within the probe's window: no connection, so a numbered frame gets T_Disconnect.
    tun.handler = (tpdu) => { if (!ignorable(tpdu) && !isRestart(tpdu)) tun.reply([0x81]); };
    await dev.restart();
  });
  test("a negative L_Data.con on the confirmed restart, then silence: not proven", async () => {
    const { tun, dev } = restarted();
    negativeOnRestart(tun);
    const failure = await dev.restart(true, true).then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_UNPROVEN");
    expect(tun.sent.filter(isRestart).length).toBe(1);
  });
  test("a negative L_Data.con on the restart and on every probe: not proven, for plain and confirmed", async () => {
    for (const confirmed of [false, true]) {
      const { tun, dev } = restarted();
      tun.failSend = (tpdu) => (ignorable(tpdu) ? null : "BUS_SEND_FAILED");
      const failure = await dev.restart(true, confirmed).then(() => null, (e: unknown) => e);
      expect([confirmed, (failure as { code?: string } | null)?.code]).toEqual([confirmed, "RESTART_UNPROVEN"]);
    }
  });
  test("after a negatively confirmed restart, a T_Disconnect to another tool's address is no proof", async () => {
    const { tun, dev } = restarted();
    negativeOnRestart(tun);
    tun.handler = (tpdu) => { if (!ignorable(tpdu) && !isRestart(tpdu)) tun.onCemi?.(DEV, 0x11fe, Buffer.from([0x81]), false); };
    const failure = await dev.restart().then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_UNPROVEN");
  });
  test("after a negatively confirmed restart, a T_Disconnect later than the window is the device's idle timeout, no proof", async () => {
    // The probe goes out inside the window and is still waiting for its acknowledgement when the
    // device's T_Disconnect arrives, after the window.
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, { ...FAST, ackMs: 200, responseMs: 200, restartProofMs: 30 });
    negativeOnRestart(tun);
    tun.handler = (tpdu) => { if (!ignorable(tpdu) && !isRestart(tpdu)) setTimeout(() => tun.reply([0x81]), 80); };
    const failure = await dev.restart().then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_UNPROVEN");
  });
  test("after a negatively confirmed restart, a T_Disconnect inside the window, during a probe, is the proof", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, { ...FAST, ackMs: 200, responseMs: 200, restartProofMs: 150 });
    negativeOnRestart(tun);
    tun.handler = (tpdu) => { if (!ignorable(tpdu) && !isRestart(tpdu)) setTimeout(() => tun.reply([0x81]), 80); };
    await dev.restart();
  });
  test("a T_NAK that arrives after the probe's negative confirmation still counts: RESTART_IGNORED", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    tun.failSend = (tpdu) => (ignorable(tpdu) ? null : "BUS_SEND_FAILED");
    tun.handler = (tpdu) => {
      if (ignorable(tpdu) || isRestart(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) setTimeout(() => tun.reply([0xc3 | (p.seq << 2)]), 0);
    };
    const failure = await dev.restart().then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_IGNORED");
  });
  test("a T_ACK without an answer on the probe: the device is still there, RESTART_IGNORED after either confirmation", async () => {
    for (const negative of [false, true]) {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
      if (negative) negativeOnRestart(tun);
      tun.handler = (tpdu) => {
        if (ignorable(tpdu)) return;
        const p = parseApdu(tpdu);
        if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) tun.reply([0xc2 | (p.seq << 2)]); // T_ACK, never an answer
      };
      const failure = await dev.restart().then(() => null, (e: unknown) => e);
      expect([negative, (failure as { code?: string } | null)?.code]).toEqual([negative, "RESTART_IGNORED"]);
    }
  });
  test("a link failure on the probes after a negatively confirmed restart is that error, never a proof, also where an unproven restart is accepted", async () => {
    for (const accept of [false, true]) for (const code of ["TUNNEL_ACK_TIMEOUT", "TUNNEL_SEND_FAILED", "USB_SEND_NOT_CONFIRMED", "USB_INTERFACE_LOST"]) {
      const { tun, dev } = restarted();
      dev.acceptUnprovenRestart(accept);
      // Only the first probe meets the failed link; the rest are left unanswered.
      let failed = false;
      tun.failSend = (tpdu) => (isRestart(tpdu) ? "BUS_SEND_FAILED" : !ignorable(tpdu) && parseApdu(tpdu).apci === APCI.DEVICE_DESCRIPTOR_READ && !failed ? (failed = true, code) : null);
      const failure = await dev.restart().then(() => null, (e: unknown) => e);
      expect([accept, code, (failure as { code?: string } | null)?.code, dev.restartUnproven]).toEqual([accept, code, code, false]);
    }
  });
  test("a link failure on the probe after a positively confirmed restart is that error, never a proof", async () => {
    for (const code of ["TUNNEL_ACK_TIMEOUT", "TUNNEL_SEND_FAILED", "USB_SEND_NOT_CONFIRMED", "USB_INTERFACE_LOST"]) {
      const { tun, dev } = restarted();
      tun.failSend = (tpdu) => (!ignorable(tpdu) && parseApdu(tpdu).apci === APCI.DEVICE_DESCRIPTOR_READ ? code : null);
      const failure = await dev.restart().then(() => null, (e: unknown) => e);
      expect([code, (failure as { code?: string } | null)?.code]).toEqual([code, code]);
    }
  });
  test("a T_NAK on the probe after a positively confirmed restart: the device is still there, RESTART_IGNORED", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) tun.reply([0xc3 | (p.seq << 2)]);
    };
    const failure = await dev.restart().then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_IGNORED");
  });
  test("a negatively confirmed restart, unanswered probes, then T_Disconnect from the device: proven", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    let probes = 0;
    tun.failSend = (tpdu) => (isRestart(tpdu) || (!ignorable(tpdu) && parseApdu(tpdu).apci === APCI.DEVICE_DESCRIPTOR_READ && probes < 3) ? "BUS_SEND_FAILED" : null);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu) || isRestart(tpdu)) return;
      if (parseApdu(tpdu).apci === APCI.DEVICE_DESCRIPTOR_READ && ++probes > 3) tun.reply([0x81]);
    };
    await dev.restart();
  });
  test("a negative L_Data.con on the confirmed restart, no answer and a device that keeps answering: not restarted", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    negativeOnRestart(tun);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) {
        tun.reply([0xc2 | (p.seq << 2)]);
        tun.reply([0x40 | (p.seq << 2) | 0x03, 0x40, 0x07, 0xb0]);
      }
    };
    const failure = await dev.restart(false, true).then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("RESTART_IGNORED");
  });
  test("a failed link on A_Restart is still an error: only the negative confirmation is taken", async () => {
    const { tun, dev } = restarted();
    tun.failSend = (tpdu) => (isRestart(tpdu) ? "TUNNEL_CLOSED" : null);
    const failure = await dev.restart().then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("TUNNEL_CLOSED");
  });
  test("a negative L_Data.con on any other frame stays an error", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    tun.failSend = (tpdu) => (!ignorable(tpdu) && parseApdu(tpdu).apci === APCI.PROPERTY_READ ? "BUS_SEND_FAILED" : null);
    const failure = await dev.propRead(0, 11).then(() => null, (e: unknown) => e);
    expect((failure as { code?: string } | null)?.code).toBe("BUS_SEND_FAILED");
  });

  // A caller that reads the device back after the restart (a flash) takes RESTART_UNPROVEN as ETS takes
  // a negatively confirmed restart: sent, and goes on. Only that case; every other verdict stands.
  describe("where an unproven restart is accepted", () => {
    const outcome = async (dev: KnxDevice, requireReboot = true, confirmed = false) =>
      dev.restart(requireReboot, confirmed).then(() => "resolved", (e: unknown) => (e as { code?: string }).code ?? String(e));

    test("a negative L_Data.con on the restart, then silence: recorded, not thrown, for plain and confirmed", async () => {
      for (const confirmed of [false, true]) {
        const { tun, dev } = restarted();
        negativeOnRestart(tun);
        dev.acceptUnprovenRestart(true);
        expect([confirmed, await outcome(dev, true, confirmed), dev.restartUnproven]).toEqual([confirmed, "resolved", true]);
        expect(tun.sent.filter(isRestart).length).toBe(1);
      }
    });
    test("not accepted, the same restart is RESTART_UNPROVEN and records nothing", async () => {
      const { tun, dev } = restarted();
      negativeOnRestart(tun);
      dev.acceptUnprovenRestart(true);
      dev.acceptUnprovenRestart(false);
      expect([await outcome(dev), dev.restartUnproven]).toEqual(["RESTART_UNPROVEN", false]);
    });
    test("arming again clears an earlier unproven restart", async () => {
      const { tun, dev } = restarted();
      negativeOnRestart(tun);
      dev.acceptUnprovenRestart(true);
      await dev.restart();
      expect(dev.restartUnproven).toBe(true);
      dev.acceptUnprovenRestart(true);
      expect(dev.restartUnproven).toBe(false);
    });
    test("a device still running after a negatively confirmed restart stays RESTART_IGNORED", async () => {
      for (const confirmed of [false, true]) for (const lost of [true, false]) {
        const tun = new FakeTransport();
        const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
        keepsRunning(tun, lost);
        dev.acceptUnprovenRestart(true);
        expect([confirmed, lost, await outcome(dev, false, confirmed), dev.restartUnproven]).toEqual([confirmed, lost, "RESTART_IGNORED", false]);
      }
    });
    test("a T_ACK without an answer, or a late T_NAK, on the probe stays RESTART_IGNORED", async () => {
      for (const reply of [0xc2, 0xc3]) {
        const tun = new FakeTransport();
        const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
        tun.failSend = (tpdu) => (ignorable(tpdu) ? null : "BUS_SEND_FAILED");
        tun.handler = (tpdu) => {
          if (ignorable(tpdu) || isRestart(tpdu)) return;
          const p = parseApdu(tpdu);
          if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) setTimeout(() => tun.reply([reply | (p.seq << 2)]), 0);
        };
        dev.acceptUnprovenRestart(true);
        expect([reply, await outcome(dev), dev.restartUnproven]).toEqual([reply, "RESTART_IGNORED", false]);
      }
    });
    test("a positively confirmed restart the device ignores, or a confirmed restart it refuses, stays an error", async () => {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
      tun.handler = (tpdu) => {
        if (ignorable(tpdu)) return;
        const p = parseApdu(tpdu);
        if (p.apci === APCI.RESTART) { tun.reply([0xc2 | (p.seq << 2)]); return; }
        if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) { tun.reply([0xc2 | (p.seq << 2)]); tun.reply([0x40 | (p.seq << 2) | 0x03, 0x40, 0x07, 0xb0]); }
      };
      dev.acceptUnprovenRestart(true);
      expect([await outcome(dev), dev.restartUnproven]).toEqual(["RESTART_IGNORED", false]);
      const refusing = confirming(1);
      refusing.dev.acceptUnprovenRestart(true);
      expect([await outcome(refusing.dev, true, true), refusing.dev.restartUnproven]).toEqual(["RESTART_REFUSED", false]);
    });
    test("a T_Disconnect inside the window is the proof, not a warning", async () => {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
      negativeOnRestart(tun);
      tun.handler = (tpdu) => { if (!ignorable(tpdu) && !isRestart(tpdu)) tun.reply([0x81]); };
      dev.acceptUnprovenRestart(true);
      expect([await outcome(dev), dev.restartUnproven]).toEqual(["resolved", false]);
    });

    test("a T_ACK of the probe, then a T_Disconnect: the device held the connection, RESTART_IGNORED", async () => {
      for (const accept of [false, true]) {
        const tun = new FakeTransport();
        const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
        negativeOnRestart(tun);
        tun.handler = (tpdu) => {
          if (ignorable(tpdu) || isRestart(tpdu)) return;
          const p = parseApdu(tpdu);
          if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) { tun.reply([0xc2 | (p.seq << 2)]); tun.reply([0x81]); }
        };
        dev.acceptUnprovenRestart(accept);
        expect([accept, await outcome(dev), dev.restartUnproven]).toEqual([accept, "RESTART_IGNORED", false]);
      }
    });
    test("a T_Disconnect between two probes, inside the window, is the proof", async () => {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.1.11", undefined, { ...FAST, retryGapMs: 100, restartProofMs: 300 });
      let scheduled = false;
      tun.failSend = (tpdu) => {
        if (ignorable(tpdu)) return null;
        if (!isRestart(tpdu) && !scheduled) { scheduled = true; setTimeout(() => tun.reply([0x81]), 30); }
        return "BUS_SEND_FAILED";
      };
      dev.acceptUnprovenRestart(true);
      expect([await outcome(dev), dev.restartUnproven]).toEqual(["resolved", false]);
    });
    test("a T_Disconnect later than the window is no proof: recorded as unproven", async () => {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.1.11", undefined, { ...FAST, ackMs: 200, responseMs: 200, restartProofMs: 30 });
      negativeOnRestart(tun);
      tun.handler = (tpdu) => { if (!ignorable(tpdu) && !isRestart(tpdu)) setTimeout(() => tun.reply([0x81]), 80); };
      dev.acceptUnprovenRestart(true);
      expect([await outcome(dev), dev.restartUnproven]).toEqual(["resolved", true]);
    });
    test("a link failure on a later probe is that error too", async () => {
      for (const at of [1, 2]) {
        const { tun, dev } = restarted();
        let probes = 0;
        tun.failSend = (tpdu) => (isRestart(tpdu) ? "BUS_SEND_FAILED" : !ignorable(tpdu) && parseApdu(tpdu).apci === APCI.DEVICE_DESCRIPTOR_READ && probes++ === at ? "USB_INTERFACE_LOST" : null);
        dev.acceptUnprovenRestart(true);
        expect([at, await outcome(dev), dev.restartUnproven, probes > at]).toEqual([at, "USB_INTERFACE_LOST", false, true]);
      }
    });

    // The MEAN WELL KNX-40E-1280D's parameter flash over the bench USB stick (private corpus
    // captures/meanwell-busforge-final2-par-1810.log), on a time scale of 1:10: A_Restart confirmed
    // negatively; the first probes confirmed negatively too (the unit is rebooting); from +0.68 s every
    // probe confirmed positively with no transport answer at all (its stack drops frames on the dead
    // connection without T_Disconnect); its startup telegrams at +2.19 s; no decision within the 4 s window.
    test("the MEAN WELL power supply's restart, replayed: recorded as unproven where accepted, RESTART_UNPROVEN otherwise", async () => {
      for (const accept of [true, false]) {
        const tun = new FakeTransport();
        const dev = new KnxDevice(tun, "1.1.11", undefined, { ...FAST, restartProofMs: 400 });
        let sentAt = 0;
        const cons: string[] = [];
        tun.failSend = (tpdu) => {
          if (ignorable(tpdu)) return null;
          if (isRestart(tpdu)) { sentAt = Date.now(); return "BUS_SEND_FAILED"; }
          const con = Date.now() - sentAt < 68 ? "BUS_SEND_FAILED" : null;
          cons.push(con ?? "ok");
          return con;
        };
        tun.handler = () => { /* the unit answers nothing on the old connection */ };
        setTimeout(() => tun.onCemi?.(DEV, 0x0b02, Buffer.from([0x00, 0x80, 0x0c]), true), 219); // its startup GroupValue_Write
        dev.acceptUnprovenRestart(accept);
        expect([accept, await outcome(dev)]).toEqual([accept, accept ? "resolved" : "RESTART_UNPROVEN"]);
        expect([accept, dev.restartUnproven]).toEqual([accept, accept]);
        expect(cons).toContain("BUS_SEND_FAILED");
        expect(cons).toContain("ok");
      }
    }, 10_000);
  });

  // The confirmed restart (A_Restart type 1, erase code 1, channel 0), as ETS sends it to the Theben
  // MIX 2: the device answers A_Restart_Response with an error code and its process time, then reboots.
  const confirming = (error: number) => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      if (p.apci === (APCI.RESTART | 0x01)) {
        tun.reply([0xc2 | (p.seq << 2)]);
        tun.reply([0x40 | (p.seq << 2) | 0x03, 0xa1, error, 0x00, 0x01]);
      }
    };
    return { tun, dev };
  };
  // ETS takes the answer and disconnects without probing the device (private corpus
  // captures/mdt-router-ets6log-{fulldownload,partial-name,partial-name-revert}.txt).
  test("confirmed: sends 81 01 00 and takes the device's answer as the restart's proof, without a probe", async () => {
    const { tun, dev } = confirming(0);
    await dev.restart(true, true);
    const sent = tun.sent.filter((f) => !ignorable(f) && parseApdu(f).apci === (APCI.RESTART | 0x01));
    expect(sent.map((f) => f.subarray(1).toString("hex"))).toEqual(["810100"]);
    expect(tun.sent.some((f) => !ignorable(f) && parseApdu(f).apci === APCI.RESTART)).toBe(false);
    expect(tun.sent.some((f) => !ignorable(f) && parseApdu(f).apci === APCI.DEVICE_DESCRIPTOR_READ)).toBe(false);
  });
  test("confirmed: an answer with an error code is a refused restart", async () => {
    const { dev } = confirming(1);
    const failure = await dev.restart(true, true).then(() => null, (e: unknown) => e);
    expect(String(failure)).toMatch(/RESTART_REFUSED|error code 1/);
  });
  test("confirmed: a device that acknowledges, does not answer and keeps running did not reboot", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    // Transport-correct: a frame with the sequence number it saw last is a repetition, acknowledged
    // and dropped; only a new number is answered.
    let last = -1;
    tun.handler = (tpdu) => {
      if (ignorable(tpdu)) return;
      const p = parseApdu(tpdu);
      tun.reply([0xc2 | (p.seq << 2)]);
      if (p.seq === last) return;
      last = p.seq;
      if (p.apci === APCI.DEVICE_DESCRIPTOR_READ) tun.reply([0x40 | (p.seq << 2) | 0x03, 0x40, 0x07, 0xb0]);
    };
    const failure = await dev.restart(true, true).then(() => null, (e: unknown) => e);
    expect(String(failure)).toMatch(/RESTART_IGNORED|did not reboot/);
  });
  test("confirmed: no answer at all is a device already gone, proven by its silence", async () => {
    const { tun, dev } = restarted();
    await dev.restart(true, true);
    expect(tun.sent.filter((f) => !ignorable(f) && parseApdu(f).apci === (APCI.RESTART | 0x01)).length).toBe(1);
  });

  // The MDT IP Interface/Router as ETS 6 meets it through an MDT IP interface (private corpus
  // captures/mdt-router-ets6log-fulldownload.txt, -partial-name.txt, -partial-name-revert.txt): the device
  // acknowledges the confirmed restart and answers it, the interface sends no L_Data.con for that frame, and
  // ETS logs "Ack arrived for ConfirmedRestart_req" and the response with no "Conf after" for it. A tunnel that
  // waits for the confirmation rejects with TUNNEL_CON_TIMEOUT after its timeout.
  const conNeverComes = (deviceAcks: boolean, error = 0) => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    const plain = tun.sendCemi.bind(tun);
    tun.sendCemi = async (cemi: Buffer) => {
      const tpdu = Buffer.from(cemi.subarray(9));
      if (ignorable(tpdu) || parseApdu(tpdu).apci !== (APCI.RESTART | 0x01)) return plain(cemi);
      tun.sent.push(tpdu);
      if (deviceAcks) {
        tun.reply([0xc2 | (parseApdu(tpdu).seq << 2)]);
        tun.reply([0x40 | (parseApdu(tpdu).seq << 2) | 0x03, 0xa1, error, 0x00, 0x00]);
      }
      await new Promise((r) => setTimeout(r, 50));
      throw Object.assign(new Error("the interface did not confirm the frame"), { code: "TUNNEL_CON_TIMEOUT" });
    };
    return { tun, dev };
  };
  test("confirmed: the device's acknowledgement and answer prove delivery when the interface never confirms the frame", async () => {
    const { tun, dev } = conNeverComes(true);
    await dev.restart(true, true);
    expect(tun.sent.filter((f) => !ignorable(f) && parseApdu(f).apci === (APCI.RESTART | 0x01)).length).toBe(1);
  });
  test("confirmed: without the interface's confirmation the device's answer is still checked", async () => {
    const { dev } = conNeverComes(true, 1);
    const failure = await dev.restart(true, true).then(() => null, (e: unknown) => e);
    expect(failure).toMatchObject({ code: "RESTART_REFUSED" });
  });
  // The probe after the restart through an interface that stalls: whether it reached the device is unknown,
  // so its failure is not taken as the device's silence.
  test("a probe the interface never confirms is no proof of the reboot", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    const plain = tun.sendCemi.bind(tun);
    tun.sendCemi = async (cemi: Buffer) => {
      const tpdu = Buffer.from(cemi.subarray(9));
      if (ignorable(tpdu) || parseApdu(tpdu).apci !== APCI.DEVICE_DESCRIPTOR_READ) return plain(cemi);
      tun.sent.push(tpdu);
      throw Object.assign(new Error("the interface did not confirm the frame"), { code: "TUNNEL_CON_TIMEOUT" });
    };
    tun.handler = (tpdu) => { if (!ignorable(tpdu) && parseApdu(tpdu).apci === APCI.RESTART) tun.reply([0xc2 | (parseApdu(tpdu).seq << 2)]); };
    const failure = await dev.restart().then(() => null, (e: unknown) => e);
    expect(failure).toMatchObject({ code: "TUNNEL_CON_TIMEOUT" });
  });
  test("confirmed: neither the device's acknowledgement nor the interface's confirmation is still a failed send", async () => {
    const { dev } = conNeverComes(false);
    const failure = await dev.restart(true, true).then(() => null, (e: unknown) => e);
    expect(failure).toMatchObject({ code: "TUNNEL_CON_TIMEOUT" });
  });

  test("a send the interface refuses PROPAGATES: silence we never caused proves nothing", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.1.11", undefined, FAST);
    // If the frame never reached the bus, the quiet that follows is OUR failure, not the device's
    // reboot. Swallowing it (the old `catch {}`) is what let a download that wrote nothing be read
    // as a download that saved everything.
    tun.sendCemi = () => Promise.reject(new Error("interface refused the frame"));
    expect(dev.restart()).rejects.toThrow("interface refused the frame");
  });
});
