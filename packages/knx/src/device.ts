import type { KnxTransport } from "./transport.ts";
import { cemiLData, tpConnect, tpDisconnect, tpAck, apdu, parseApdu, iaToNum, APCI, type ParsedApdu } from "./frame.ts";

// Connection-oriented KNX management on top of the tunnel: T_Connect, numbered
// requests with T_ACK + retransmission, ACK-the-response-before-the-next-request.
// Reads are verified on real hardware; writes/flash are ported from the proven
// reference and the load procedure documented in docs/findings.md.
export class KnxDevice {
  private dst: number;
  private seq = 0;
  private ackResolve: (() => void) | null = null;
  private respResolve: ((p: ParsedApdu) => void) | null = null;

  constructor(private tun: KnxTransport, ia: string) {
    this.dst = iaToNum(ia);
    tun.onCemi = (src, dst, tpdu, isGroup) => this.onCemi(src, dst, tpdu, isGroup);
  }
  private get me() { return this.tun.assignedIa; }

  private onCemi(src: number, _dst: number, tpdu: Buffer, isGroup: boolean) {
    if (isGroup || src !== this.dst) return;
    const p = parseApdu(tpdu);
    if (p.control) { if (p.seq === this.seq) this.ackResolve?.(); return; }
    // numbered data response: send our KNX T_ACK first, then hand it to the waiter
    this.tun.sendCemi(cemiLData(this.me, this.dst, tpAck(p.seq))).then(() => this.respResolve?.(p)).catch(() => {});
  }

  async connect() { this.seq = 0; await this.tun.sendCemi(cemiLData(this.me, this.dst, tpConnect())); }
  async disconnect() { try { await this.tun.sendCemi(cemiLData(this.me, this.dst, tpDisconnect())); } catch {} }

  private async request(build: (seq: number) => Buffer, expectResponse: boolean, tries = 3): Promise<ParsedApdu | null> {
    for (let i = 0; i < tries; i++) {
      const ackP = new Promise<boolean>((res) => { this.ackResolve = () => res(true); setTimeout(() => res(false), 1500); });
      const respP = expectResponse
        ? new Promise<ParsedApdu | null>((res) => { this.respResolve = (p) => res(p); setTimeout(() => res(null), 2000); })
        : Promise.resolve<ParsedApdu | null>(null);
      await this.tun.sendCemi(cemiLData(this.me, this.dst, build(this.seq)));
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
