import dgram from "node:dgram";
import { SVC, knxFrame, hpai, localIpFor, KNXPORT } from "./frame.ts";

// KNXnet/IP tunnelling connection. Handles the KNXnet/IP layer (connect,
// tunnelling request/ack both directions) and surfaces incoming cEMI L_Data
// (source IA + raw TPDU) to a listener. The connection-oriented KNX transport
// lives one layer up in KnxDevice.
export class KnxIpTunnel {
  private sock!: dgram.Socket;
  private localIp = "0.0.0.0";
  private localPort = 0;
  channel = 0;
  assignedIa = 0;
  private txSeq = 0;
  private ackWaiter: { seq: number; resolve: () => void } | null = null;
  onCemi: ((src: number, tpdu: Buffer) => void) | null = null;

  constructor(private ifaceIp: string, private port = KNXPORT) {}

  private send(buf: Buffer) { return new Promise<void>((r) => this.sock.send(buf, this.port, this.ifaceIp, () => r())); }

  async connect(): Promise<void> {
    this.sock = dgram.createSocket("udp4");
    await new Promise<void>((r) => this.sock.bind(0, () => r()));
    this.localPort = this.sock.address().port;
    this.localIp = await localIpFor(this.ifaceIp, this.port);
    this.sock.on("message", (m) => this.onMessage(m));

    const body = Buffer.concat([hpai(this.localIp, this.localPort), hpai(this.localIp, this.localPort), Buffer.from([0x04, 0x04, 0x02, 0x00])]);
    const done = this.once((m) => m.readUInt16BE(2) === SVC.CONNECT_RES, 4000, "connect");
    await this.send(knxFrame(SVC.CONNECT_REQ, body));
    const res = await done;
    const b = res.subarray(6);
    if (b[1] !== 0) throw new Error(`connect status 0x${b[1].toString(16)}`);
    this.channel = b[0];
    this.assignedIa = b.readUInt16BE(2 + 8 + 2); // channel/status + HPAI(8) + CRD type/len(2)
  }

  private connectResWaiter: { match: (m: Buffer) => boolean; resolve: (m: Buffer) => void } | null = null;
  private once(match: (m: Buffer) => boolean, ms: number, what: string) {
    return new Promise<Buffer>((resolve, reject) => {
      this.connectResWaiter = { match, resolve: (m) => { this.connectResWaiter = null; resolve(m); } };
      setTimeout(() => reject(new Error(`${what} timeout`)), ms);
    });
  }

  private async onMessage(m: Buffer) {
    const svc = m.readUInt16BE(2);
    const body = m.subarray(6);
    if (this.connectResWaiter?.match(m)) { this.connectResWaiter.resolve(m); return; }
    if (svc === SVC.TUNNEL_ACK) {
      if (this.ackWaiter && body[2] === this.ackWaiter.seq) { this.ackWaiter.resolve(); this.ackWaiter = null; }
    } else if (svc === SVC.TUNNEL_REQ) {
      const serverSeq = body[2];
      await this.send(knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, this.channel, serverSeq, 0x00])));
      const cemi = body.subarray(4);
      const addIL = cemi[1];
      const off = 2 + addIL;
      const src = cemi.readUInt16BE(off + 2);
      const len = cemi[off + 6];
      const tpdu = cemi.subarray(off + 7, off + 7 + len + 1);
      this.onCemi?.(src, tpdu);
    }
  }

  // KNXnet/IP-layer send of a cEMI with tunnelling ack + retransmission.
  async sendCemi(cemi: Buffer, tries = 3): Promise<void> {
    for (let i = 0; i < tries; i++) {
      const seq = this.txSeq;
      const frame = knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, this.channel, seq, 0x00]), cemi]));
      const ack = new Promise<boolean>((resolve) => { this.ackWaiter = { seq, resolve: () => resolve(true) }; setTimeout(() => resolve(false), 1500); });
      await this.send(frame);
      if (await ack) { this.txSeq = (this.txSeq + 1) & 0xff; return; }
    }
    throw new Error("tunnelling ack timeout");
  }

  async disconnect() {
    try { await this.send(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([this.channel, 0x00]), hpai(this.localIp, this.localPort)]))); } catch {}
    this.sock?.close();
  }
}
