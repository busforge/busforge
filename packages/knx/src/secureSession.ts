import { KnxError } from "./errors.ts";
import { secureEncode, secureDecode, SCF, SCF_TOOL_DATA } from "./secure.ts";

// A KNX Data Secure tool-access session: the stateful layer over the pure CCM in
// secure.ts. It owns the 48-bit tool-access sequence counter and frames management
// APDUs as secure TPDUs (and back). The wire framing follows the reference stacks
// (Calimero, thelsing/knx): the secured TPDU is
//   [ outerTPCI | 0x03, 0xF1, SCF, seq(6), (serial(6) for Sync), payload, MAC(4) ]
// where the inner plaintext is the bare service APDU (APCI + data, inner TPCI = 0).
//
// This module is pure protocol logic (no transport). It is unit-verified by a
// two-party round-trip and the Calimero Sync vector; the bus wiring + a real secure
// read-back of a device is the end-to-end proof. See docs/knx-secure.md.

const APCI_LO = 0xf1; // SecureService & 0xFF
const SERIAL_LEN = 6; // bytes of device serial carried in clear on a Sync.req

// The outcome of decoding an inbound secure TPDU. See SecureSession.unwrap.
export type SecureInbound =
  | { status: "ok"; apdu: Buffer } // authenticated and fresh: deliver
  | { status: "replay" }           // authenticated but already seen: ACK, do not deliver
  | { status: "invalid" };         // MAC failed / malformed: drop

function seq6(n: bigint): Buffer {
  const b = Buffer.alloc(6);
  for (let i = 5; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
}
function seqNum(b: Buffer): bigint {
  let n = 0n;
  for (const x of b.subarray(0, 6)) n = (n << 8n) | BigInt(x);
  return n;
}

export class SecureSession {
  private toolKey: Buffer;
  readonly src: number;
  readonly dst: number;
  // The target device's 6-byte serial, needed for the Sync request. Optional: only
  // the Sync flow uses it; pure wrap/unwrap and explicit buildSyncRequest do not.
  readonly serial: Buffer;
  // Our outgoing tool-access sequence. Set from a Sync at session start; strictly
  // increasing per sent secure frame (0 is never sent).
  private seq: bigint;
  // The lowest sequence we will still accept from the peer. Data Secure requires the
  // receiver to enforce a monotone sender sequence: a frame carrying seq < recvSeq is a
  // replay (or a stale desynced frame) and is dropped even though its MAC verifies.
  // Seeded from the Sync response (the device's declared next sequence); before the
  // first Sync it is 0, so the very first received frame is always accepted.
  private recvSeq = 0n;

  constructor(opts: { toolKey: Buffer; src: number; dst: number; serial?: Buffer; seq?: bigint }) {
    this.toolKey = opts.toolKey;
    this.src = opts.src;
    this.dst = opts.dst;
    this.serial = opts.serial ?? Buffer.alloc(6);
    this.seq = opts.seq ?? 1n;
  }

  // Switch to a new tool key within the session. A device takes a new tool key (PID 56) and
  // answers that very write under it, so the switch comes between the send and the answer.
  rekey(toolKey: Buffer): void {
    if (toolKey.length !== 16) throw new KnxError("SECURE_KEY_BAD", `a tool key is 16 bytes, got ${toolKey.length}`);
    this.toolKey = toolKey;
  }

  get sequence(): bigint { return this.seq; }
  // The lowest sequence unwrap will still accept from the peer (for tests/diagnostics).
  get receiveSequence(): bigint { return this.recvSeq; }
  // Adopt a sequence learned from a Sync response (only ever move forward).
  setSequence(n: bigint): void { if (n > this.seq) this.seq = n; }

  private take(): Buffer { const s = seq6(this.seq); this.seq += 1n; return s; }

  // Frame a plain management service APDU (APCI + data, inner TPCI bits 0) as a
  // numbered T_Data_Connected secure TPDU, tSeq = the T_Data_Connected sequence.
  wrapManagement(service: Buffer, tSeq: number): Buffer {
    const outerTpci = 0x40 | ((tSeq & 0x0f) << 2) | 0x03; // numbered + SecureService APCI-hi
    const body = secureEncode({
      key: this.toolKey, src: this.src, dst: this.dst, dstIsGroup: false,
      seq: this.take(), scf: SCF_TOOL_DATA, tpci: outerTpci,
      aad: Buffer.from([SCF_TOOL_DATA]), plaintext: service,
    });
    return Buffer.concat([Buffer.from([outerTpci, APCI_LO]), body]);
  }

  // Decode a secure response TPDU (from the device) into the inner service APDU. Three
  // outcomes, because the caller must treat them differently at the transport layer:
  //  - "ok":      authenticated and fresh; deliver it.
  //  - "replay":  authenticated but its sequence was already seen; a transport-layer
  //               retransmission (our T_ACK was lost). The caller must still T_ACK it so
  //               the device stops retransmitting, but must NOT re-deliver it.
  //  - "invalid": MAC failed or malformed; drop entirely (no ACK, no deliver).
  // src/dst are swapped: the device is the source.
  unwrap(secureTpdu: Buffer): SecureInbound {
    if (secureTpdu.length < 2) return { status: "invalid" };
    const outerTpci = secureTpdu[0];
    const res = secureDecode(secureTpdu.subarray(2), {
      key: this.toolKey, src: this.dst, dst: this.src, dstIsGroup: false,
      tpci: outerTpci, aadFor: (scf) => Buffer.from([scf]),
    });
    if (!res) return { status: "invalid" };
    // Replay guard: a MAC-valid frame whose sequence is not ahead of the last one we
    // accepted is a replay/retransmission. Only advance on a fresh frame, so a replay
    // never moves the window.
    const seq = seqNum(res.seq);
    if (seq < this.recvSeq) return { status: "replay" };
    this.recvSeq = seq + 1n;
    return { status: "ok", apdu: res.plaintext };
  }

  // Build a Sync.req TPDU: a random challenge as payload, the device's 6-byte serial
  // carried in clear (and in the AAD), the sequence slot = our current sequence.
  buildSyncRequest(serial: Buffer, challenge: Buffer, tSeq: number): Buffer {
    if (serial.length !== SERIAL_LEN) throw new Error("serial must be 6 bytes");
    const outerTpci = 0x40 | ((tSeq & 0x0f) << 2) | 0x03;
    const scf = SCF.TOOL | SCF.AUTH_CONF | SCF.S_A_SYNC_REQ; // 0x92
    const seq = this.take();
    const body = secureEncode({
      key: this.toolKey, src: this.src, dst: this.dst, dstIsGroup: false,
      seq, scf, tpci: outerTpci, aad: Buffer.concat([Buffer.from([scf]), serial]), plaintext: challenge,
    });
    // body = [SCF, seq(6), payloadCt, MAC]; the serial rides in clear after the seq.
    return Buffer.concat([Buffer.from([outerTpci, APCI_LO]), body.subarray(0, 7), serial, body.subarray(7)]);
  }

  // Parse a Sync.res TPDU. Its sequence slot is random XOR challenge (recover random,
  // which is the CCM seq input); the 12-byte plaintext is deviceNextSeq(6) || ourNextSeq(6).
  // Adopts ourNextSeq and returns both. Returns null if the MAC does not verify.
  applySyncResponse(secureTpdu: Buffer, challenge: Buffer): { deviceSeq: bigint; ourSeq: bigint } | null {
    if (secureTpdu.length < 9) return null;
    const outerTpci = secureTpdu[0];
    const body = secureTpdu.subarray(2); // [SCF, seqOrRandXorChallenge(6), payload, MAC]
    const xored = body.subarray(1, 7);
    const random = Buffer.alloc(6);
    for (let i = 0; i < 6; i++) random[i] = xored[i] ^ (challenge[i] ?? 0);
    // Re-assemble the body with the recovered random in the sequence slot so decode
    // builds B0/Ctr0 from it (that is what the responder used).
    const decBody = Buffer.concat([body.subarray(0, 1), random, body.subarray(7)]);
    const res = secureDecode(decBody, {
      key: this.toolKey, src: this.dst, dst: this.src, dstIsGroup: false,
      tpci: outerTpci, aadFor: (scf) => Buffer.from([scf]),
    });
    if (!res || res.plaintext.length < 12) return null;
    const deviceSeq = seqNum(res.plaintext.subarray(0, 6));
    const ourSeq = seqNum(res.plaintext.subarray(6, 12));
    this.setSequence(ourSeq);
    // The device just declared its next outgoing sequence: accept from there on. The
    // Sync response is itself replay-proof (its MAC binds our fresh random challenge),
    // so adopting the window directly here is the intended resync point.
    this.recvSeq = deviceSeq;
    return { deviceSeq, ourSeq };
  }
}
