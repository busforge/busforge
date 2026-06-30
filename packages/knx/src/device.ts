import { randomBytes } from "node:crypto";
import type { KnxTransport } from "./transport.ts";
import type { SecureSession } from "./secureSession.ts";
import { cemiLData, tpConnect, tpDisconnect, tpAck, apdu, parseApdu, iaToNum, APCI, type ParsedApdu } from "./frame.ts";

// Connection-oriented KNX management on top of the tunnel: T_Connect, numbered
// requests with T_ACK + retransmission, ACK-the-response-before-the-next-request.
// Reads are verified on real hardware; writes/flash are ported from the proven
// reference and the load procedure documented in docs/findings.md.
//
// With an optional SecureSession the same flow speaks KNX Data Secure: every
// management APDU is wrapped (and responses unwrapped) transparently, and connect()
// runs a Sync first to learn the device's tool-access sequence. Without it the path
// is byte-for-byte the plain one. Hardware-verified on an MDT IP interface.
export class KnxDevice {
  private dst: number;
  private seq = 0;
  private ackResolve: (() => void) | null = null;
  private respResolve: ((p: ParsedApdu) => void) | null = null;
  // During the Sync handshake, raw frames are diverted here (the Sync response is not
  // a normal secure data frame, so it bypasses the request machinery).
  private rawInbox: Buffer[] | null = null;
  private rawNotify: (() => void) | null = null;

  constructor(private tun: KnxTransport, ia: string, private secure?: SecureSession) {
    this.dst = iaToNum(ia);
    tun.onCemi = (src, dst, tpdu, isGroup) => this.onCemi(src, dst, tpdu, isGroup);
  }
  private get me() { return this.tun.assignedIa; }

  private onCemi(src: number, _dst: number, tpdu: Buffer, isGroup: boolean) {
    if (isGroup || src !== this.dst) return;
    if (this.rawInbox) { this.rawInbox.push(Buffer.from(tpdu)); this.rawNotify?.(); return; }
    const outer = parseApdu(tpdu);
    if (outer.control) { if (outer.seq === this.seq) this.ackResolve?.(); return; }
    // For a secure session the data frame is a wrapped secure APDU: ACK the outer
    // numbered frame, then deliver the decrypted inner APDU. A failed MAC is dropped
    // (the request times out and can re-sync) rather than surfaced as fake data.
    let p = outer;
    if (this.secure) {
      const inner = this.secure.unwrap(tpdu);
      if (!inner) return;
      p = parseApdu(inner);
    }
    this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck(outer.seq))).then(() => this.respResolve?.(p)).catch(() => {});
  }

  async connect() {
    this.seq = 0;
    await this.tun.sendCemi(cemiLData(this.me, this.dst, tpConnect()));
    if (this.secure) await this.runSync(this.secure);
  }
  async disconnect() { try { await this.tun.sendCemi(cemiLData(this.me, this.dst, tpDisconnect())); } catch {} }

  // Data Secure Sync: agree the live tool-access sequence before any secured request.
  private async runSync(sec: SecureSession): Promise<void> {
    const challenge = randomBytes(6);
    this.rawInbox = [];
    try {
      await this.tun.sendCemi(cemiLData(this.me, this.dst, sec.buildSyncRequest(sec.serial, challenge, this.seq)));
      const rsp = await this.rawNext();
      await this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck((rsp[0] >> 2) & 0x0f))); // ACK the device's Sync.res
      if (!sec.applySyncResponse(rsp, challenge)) throw new Error("secure Sync failed (MAC mismatch)");
      this.seq = (this.seq + 1) & 0x0f; // the Sync request consumed this T-sequence
    } finally { this.rawInbox = null; this.rawNotify = null; }
  }

  // Next non-control (data) frame during Sync; skips the device's T_ACK.
  private rawNext(ms = 3000): Promise<Buffer> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.rawNotify = null; rej(new Error("secure Sync: no response")); }, ms);
      const pump = () => {
        while (this.rawInbox?.length) {
          const f = this.rawInbox.shift()!;
          if ((f[0] & 0xc0) === 0xc0) continue; // skip T_ACK control frames
          clearTimeout(t); this.rawNotify = null; res(f); return;
        }
      };
      this.rawNotify = pump; pump();
    });
  }

  private async request(build: (seq: number) => Buffer, expectResponse: boolean, tries = 3): Promise<ParsedApdu | null> {
    for (let i = 0; i < tries; i++) {
      const ackP = new Promise<boolean>((res) => { this.ackResolve = () => res(true); setTimeout(() => res(false), 1500); });
      const respP = expectResponse
        ? new Promise<ParsedApdu | null>((res) => { this.respResolve = (p) => res(p); setTimeout(() => res(null), 2000); })
        : Promise.resolve<ParsedApdu | null>(null);
      // Plain: send the numbered APDU as-is. Secure: strip the numbering to the bare
      // service APDU (inner TPCI 0) and wrap it for this T-sequence.
      let tpdu = build(this.seq);
      if (this.secure) { const svc = Buffer.from(tpdu); svc[0] &= 0x03; tpdu = this.secure.wrapManagement(svc, this.seq); }
      await this.tun.sendCemi(cemiLData(this.me, this.dst, tpdu));
      if (!(await ackP)) continue;
      if (!expectResponse) { this.seq = (this.seq + 1) & 0x0f; return null; }
      const r = await respP;
      if (r === null) continue;
      this.seq = (this.seq + 1) & 0x0f;
      return r;
    }
    throw new Error("no reliable response (device not answering)");
  }

  // ---- reads (verified on hardware) ----
  async deviceDescriptor(): Promise<string> {
    const r = await this.request((s) => apdu(s, APCI.DEVICE_DESCRIPTOR_READ), true);
    return "MV-" + r!.data.toString("hex").toUpperCase();
  }
  async propRead(obj: number, pid: number, start = 1, count = 1): Promise<Buffer> {
    const tail = Buffer.from([obj, pid, (count << 4) | ((start >> 8) & 0x0f), start & 0xff]);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_READ, tail), true);
    return r!.data.subarray(4); // skip obj,pid,start echo
  }
  async memRead(addr: number, len: number, chunk = 12, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Buffer> {
    // Place bytes by ADDRESS, never by concatenation. Some M112 devices refuse a single
    // MemoryRead that spans an internal memory boundary (they answer with an empty data
    // response); the old concat-and-advance-by-requested-length loop then produced a buffer
    // that was both short AND misaligned (corrupting read-back of any segment crossing such a
    // boundary). On a short/empty response we shrink the request until it fits within a
    // boundary and advance only by what was actually returned.
    const out = Buffer.alloc(len);
    const total = Math.ceil(len / chunk);
    let done = 0;
    let pos = 0;
    while (pos < len) {
      if (signal?.aborted) throw new Error("read aborted");
      let want = Math.min(chunk, len - pos);
      let data: Buffer;
      for (;;) {
        const a = addr + pos;
        const tail = Buffer.from([(a >> 8) & 0xff, a & 0xff]);
        const r = await this.request((s) => apdu(s, APCI.MEMORY_READ, tail, want), true);
        data = r!.data.subarray(2); // skip echoed address
        if (data.length >= want) { data = data.subarray(0, want); break; }
        if (want === 1) throw new Error(`memRead: device refused byte @0x${a.toString(16)}`);
        want = Math.max(1, want >> 1); // shrink to fit within the device read boundary
      }
      data.copy(out, pos);
      pos += want;
      onProgress?.(Math.min(++done, total), total);
    }
    return out;
  }
  async tableAddr(obj: number): Promise<number> {
    const b = await this.propRead(obj, 7);
    let a = 0; for (const x of b) a = (a << 8) | x; return a;
  }

  // ---- writes (ported from the proven reference; load procedure in flash.ts) ----
  async propWrite(obj: number, pid: number, data: Buffer, start = 1, count = 1): Promise<Buffer> {
    const tail = Buffer.concat([Buffer.from([obj, pid, (count << 4) | ((start >> 8) & 0x0f), start & 0xff]), data]);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_WRITE, tail), true);
    return r ? r.data.subarray(4) : Buffer.alloc(0); // device echoes the written value
  }
  async memWrite(addr: number, data: Buffer, opts: { chunk?: number; verify?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
    const chunk = opts.chunk ?? 12;
    const total = Math.ceil(data.length / chunk);
    let done = 0;
    for (let pos = 0; pos < data.length; ) {
      const n = Math.min(chunk, data.length - pos);
      const slice = data.subarray(pos, pos + n);
      const a = addr + pos;
      const tail = Buffer.concat([Buffer.from([(a >> 8) & 0xff, a & 0xff]), slice]);
      await this.request((s) => apdu(s, APCI.MEMORY_WRITE, tail, n), false); // T_ACK only
      pos += n;
      opts.onProgress?.(++done, total);
    }
    if (opts.verify ?? true) {
      const back = await this.memRead(addr, data.length);
      if (!back.equals(data)) throw new Error(`memWrite verify mismatch @0x${addr.toString(16)}`);
    }
  }
  async restart(): Promise<void> {
    // device reboots; no reliable KNX ack expected, fire once
    try { await this.tun.sendCemi(cemiLData(this.me, this.dst, apdu(this.seq, APCI.RESTART))); } catch {}
    this.seq = (this.seq + 1) & 0x0f;
  }
}
