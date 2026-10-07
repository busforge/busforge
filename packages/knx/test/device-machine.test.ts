import { test, expect, describe } from "bun:test";
import { KnxDevice, SYNC_GAP_MS } from "../src/device.ts";
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
  onClosed: ((reason: string) => void) | null = null;
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

  test("an optional property the device does not implement (count 0) reads as absent, not as a value", async () => {
    for (const [answer, expected] of [[[0x43, 0xd6, 0x00, 0x09, 0x00, 0x01, 0x07], null], [[0x43, 0xd6, 0x00, 0x09, 0x10, 0x01, 0x12], "12"]] as const) {
      const tun = new FakeTransport();
      const dev = new KnxDevice(tun, "1.2.11");
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
    const dev = new KnxDevice(tun, "1.2.11");
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
    // Constructing it IS the point: KnxDevice installs itself as tun.onCemi, and that is what
    // tun.reply() below drives. The instance is never touched directly.
    new KnxDevice(tun, "1.2.11", ourSession);
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
    const dev = new KnxDevice(tun, "1.2.11", new SecureSession({ toolKey, src: tun.assignedIa, dst: DEV }));
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
  }, 30_000);

  test("secure: a replayed answer followed by silence is not answering, not a key problem", async () => {
    let earlier: Buffer | null = null;
    const { dev } = secureFake((tun, seq, far) => {
      if (!earlier) { earlier = far.wrapManagement(Buffer.from("0340abcd", "hex"), seq); tun.reply([...earlier]); return; }
      tun.reply([...earlier]);
    });
    await dev.deviceDescriptor();
    expect(await code(dev.deviceDescriptor())).toBe("DEVICE_NOT_ANSWERING");
  }, 30_000);

  test("secure: a garbled frame on a request that was never acknowledged is not answering", async () => {
    const { dev } = secureFake((tun, seq, far) => { const f = far.wrapManagement(Buffer.from("0340abcd", "hex"), seq); f[f.length - 1] ^= 1; tun.reply([...f]); }, false);
    expect(await code(dev.deviceDescriptor())).toBe("DEVICE_NOT_ANSWERING");
  }, 30_000);

  // The device answers the tool key write under the new key (ETS capture, Jung 400021SE).
  test("secure: the tool key write is sent once under the old key and its answer taken under the new one", async () => {
    const oldKey = Buffer.alloc(16, 0xfd), newKey = Buffer.alloc(16, 0x11);
    const tun = new FakeTransport();
    const farOld = new SecureSession({ toolKey: oldKey, src: DEV, dst: tun.assignedIa });
    const farNew = new SecureSession({ toolKey: newKey, src: DEV, dst: tun.assignedIa });
    const dev = new KnxDevice(tun, "1.2.11", new SecureSession({ toolKey: oldKey, src: tun.assignedIa, dst: DEV }));
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
    const dev = new KnxDevice(tun, "1.2.11", new SecureSession({ toolKey: Buffer.alloc(16, 0xfd), src: tun.assignedIa, dst: DEV }));
    let sent = 0;
    tun.handler = (tpdu) => { if (!ignorable(tpdu)) sent++; };
    const err = await dev.writeToolKey(Buffer.alloc(16, 0x11)).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("DEVICE_NOT_ANSWERING");
    expect(sent).toBe(1);
  }, 10_000);

  // A device in secure mode acknowledges a plain A_Restart on the transport layer and then ignores
  // it (Jung 400021SE, 2026-09-28): the restart, and the master reset, go through the session.
  test("secure: A_Restart and the master reset are sent secured, never plain", async () => {
    const toolKey = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const tun = new FakeTransport();
    tun.handler = () => { /* a rebooting device answers nothing */ };
    const dev = new KnxDevice(tun, "1.2.11", new SecureSession({ toolKey, src: tun.assignedIa, dst: DEV }));
    await dev.restart();
    await dev.masterReset();
    const farSide = new SecureSession({ toolKey, src: DEV, dst: tun.assignedIa });
    const restart = tun.sent[0], reset = tun.sent[tun.sent.length - 1];
    for (const f of [restart, reset]) expect(f[1]).toBe(0xf1); // A_Data_Secure, not the service in clear
    const inner = (f: Buffer) => { const r = farSide.unwrap(f); if (r.status !== "ok") throw new Error(r.status); return ((r.apdu[0] & 0x03) << 8) | r.apdu[1]; };
    expect(inner(restart)).toBe(APCI.RESTART);
    expect(inner(reset) & 0x3fe).toBe(APCI.RESTART);
  }, 10_000);

  // A secure device drops a Sync request it cannot authenticate without answering, so silence is
  // what a wrong tool key (or a device not in secure mode) looks like; the error has to say so.
  test("secure: a Sync nobody answers fails with a coded error", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11", new SecureSession({ toolKey: Buffer.alloc(16, 1), src: tun.assignedIa, dst: DEV, serial: Buffer.alloc(6, 2) }));
    tun.handler = () => { /* silence */ };
    const err = await dev.connect().catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SECURE_SYNC_NO_RESPONSE");
  }, 10_000); // the Sync waits 3 s for an answer

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
    await new KnxDevice(tun, "1.1.113", session(A)).connect().catch(() => undefined);
    target = B;
    await new KnxDevice(tun, "1.1.114", session(B)).connect().catch(() => undefined);
    target = A;
    // Over a second transport, as the server opens one per operation: the gap still holds.
    const tun2 = new FakeTransport();
    tun2.handler = answerSyncs(tun2);
    await new KnxDevice(tun2, "1.1.113", session(A)).connect().catch(() => undefined);
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
    const dev = new KnxDevice(tun, "1.2.11");
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
  }, 20000);

  test("a device that KEEPS ANSWERING did not reboot, and that is a failure, not a success", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
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
  }, 20000);

  test("with requireReboot=false, a device that keeps answering is fine (it persisted at LoadCompleted)", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
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
  }, 20000);

  // The confirmed restart (A_Restart type 1, erase code 1, channel 0), as ETS sends it to the Theben
  // MIX 2: the device answers A_Restart_Response with an error code and its process time, then reboots.
  const confirming = (error: number) => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
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
  test("confirmed: sends 81 01 00, takes the device's answer, and still demands the silence after it", async () => {
    const { tun, dev } = confirming(0);
    await dev.restart(true, true);
    const sent = tun.sent.filter((f) => !ignorable(f) && parseApdu(f).apci === (APCI.RESTART | 0x01));
    expect(sent.map((f) => f.subarray(1).toString("hex"))).toEqual(["810100"]);
    expect(tun.sent.some((f) => !ignorable(f) && parseApdu(f).apci === APCI.RESTART)).toBe(false);
  }, 20000);
  test("confirmed: an answer with an error code is a refused restart", async () => {
    const { dev } = confirming(1);
    const failure = await dev.restart(true, true).then(() => null, (e: unknown) => e);
    expect(String(failure)).toMatch(/RESTART_REFUSED|error code 1/);
  }, 20000);
  test("confirmed: a device that acknowledges, does not answer and keeps running did not reboot", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
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
  }, 20000);
  test("confirmed: no answer at all is a device already gone, proven by its silence", async () => {
    const { tun, dev } = restarted();
    await dev.restart(true, true);
    expect(tun.sent.filter((f) => !ignorable(f) && parseApdu(f).apci === (APCI.RESTART | 0x01)).length).toBe(1);
  }, 20000);

  test("a send the interface refuses PROPAGATES: silence we never caused proves nothing", async () => {
    const tun = new FakeTransport();
    const dev = new KnxDevice(tun, "1.2.11");
    // If the frame never reached the bus, the quiet that follows is OUR failure, not the device's
    // reboot. Swallowing it (the old `catch {}`) is what let a download that wrote nothing be read
    // as a download that saved everything.
    tun.sendCemi = () => Promise.reject(new Error("interface refused the frame"));
    expect(dev.restart()).rejects.toThrow("interface refused the frame");
  }, 20000);
});
