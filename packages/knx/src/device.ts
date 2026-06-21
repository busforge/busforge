import { KnxIpTunnel } from "./connection.ts";
import { cemiLData, tpConnect, tpDisconnect, tpAck, apdu, parseApdu, iaToNum, APCI, type ParsedApdu } from "./frame.ts";

// Connection-oriented KNX management on top of the tunnel: T_Connect, numbered
// requests with T_ACK + retransmission, ACK-the-response-before-the-next-request.
export class KnxDevice {
  private dst: number;
  private seq = 0;
  private ackResolve: (() => void) | null = null;
  private respResolve: ((p: ParsedApdu) => void) | null = null;

  constructor(private tun: KnxIpTunnel, ia: string) {
    this.dst = iaToNum(ia);
    tun.onCemi = (src, tpdu) => this.onCemi(src, tpdu);
  }
  private get me() { return this.tun.assignedIa; }

  private onCemi(src: number, tpdu: Buffer) {
    if (src !== this.dst) return;
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

  async deviceDescriptor(): Promise<string> {
    const r = await this.request((s) => apdu(s, APCI.DEVICE_DESCRIPTOR_READ), true);
    return "MV-" + r!.data.toString("hex").toUpperCase();
  }

  async propRead(obj: number, pid: number, start = 1, count = 1): Promise<Buffer> {
    const tail = Buffer.from([obj, pid, (count << 4) | ((start >> 8) & 0x0f), start & 0xff]);
    const r = await this.request((s) => apdu(s, APCI.PROPERTY_READ, tail), true);
    return r!.data.subarray(4); // skip obj,pid,start echo
  }

  async memRead(addr: number, len: number, chunk = 12): Promise<Buffer> {
    const out: Buffer[] = [];
    for (let pos = addr; pos < addr + len; ) {
      const n = Math.min(chunk, addr + len - pos);
      const tail = Buffer.from([(pos >> 8) & 0xff, pos & 0xff]);
      const r = await this.request((s) => apdu(s, APCI.MEMORY_READ, tail, n), true);
      out.push(r!.data.subarray(2)); // skip echoed address
      pos += n;
    }
    return Buffer.concat(out);
  }

  // table base address for an interface object (PID 7), big-endian
  async tableAddr(obj: number): Promise<number> {
    const b = await this.propRead(obj, 7);
    let a = 0; for (const x of b) a = (a << 8) | x; return a;
  }
}
