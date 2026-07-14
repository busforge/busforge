import dgram from "node:dgram";
import { SVC, knxFrame, hpai, KNXPORT, CEMI } from "./frame.ts";
import { parseCemiLData, type KnxTransport } from "./transport.ts";
import { KnxError } from "./errors.ts";

// Minimal surface of dgram.Socket the tunnel uses; injectable for offline tests.
export interface TunnelSocket {
  bind(port: number, cb: () => void): void;
  on(ev: "message", cb: (m: Buffer) => void): void;
  send(buf: Buffer, port: number, ip: string, cb: () => void): void;
  close(): void;
}

// KNXnet/IP tunnelling connection. Handles the KNXnet/IP layer (connect,
// tunnelling request/ack both directions) and surfaces incoming cEMI L_Data
// (source IA + raw TPDU) to a listener. The connection-oriented KNX transport
// lives one layer up in KnxDevice.
export class KnxIpTunnel implements KnxTransport {
  private sock!: TunnelSocket;
  channel = 0;
  assignedIa = 0;
  private txSeq = 0;
  private ackWaiter: { seq: number; resolve: () => void } | null = null;
  // Set the moment teardown begins. A datagram that lands between DISCONNECT_REQ and the socket
  // actually closing must not be answered: the ACK would be written into a socket that is gone, and
  // the channel it would ACK on no longer exists. Without it, every ordinary disconnect logged a
  // failure ("null is not an object (evaluating 'kStateSymbol')", node's dgram internals on a closed
  // handle) that was not one.
  private closed = false;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onRawCemi: ((cemi: Buffer) => void) | null = null;

  // createSocket is a test seam; the default is the real UDP socket as before.
  constructor(
    private ifaceIp: string,
    private port = KNXPORT,
    private readonly createSocket: () => TunnelSocket = () => dgram.createSocket("udp4"),
  ) {}

  private send(buf: Buffer) { return new Promise<void>((r) => this.sock.send(buf, this.port, this.ifaceIp, () => r())); }

  async connect(): Promise<void> {
    this.sock = this.createSocket();
    await new Promise<void>((r) => this.sock.bind(0, () => r()));
    // The socket callback wants void, so handing it the async handler dropped the promise: a
    // rejection inside (a failed TUNNEL_ACK send) escaped as an unhandled rejection with no clue
    // where it came from. Failing to answer ONE datagram is recoverable — the gateway retransmits —
    // so the tunnel stays up, but it is reported rather than swallowed.
    this.closed = false;
    this.sock.on("message", (m) => {
      void this.onMessage(m).catch((e: unknown) => {
        if (this.closed) return; // a datagram lost to teardown is not a failure, it is the teardown
        console.error(`KNX/IP: dropped a datagram: ${e instanceof Error ? e.message : "unknown error"}`);
      });
    });

    // Advertise a NAT-mode HPAI (0.0.0.0:0) so the gateway replies to the
    // observed packet source instead of an address we name. Required behind NAT
    // (e.g. the server in a Docker bridge network, where our real local address
    // is an unroutable 172.x/192.168.x container IP); on a flat LAN the packet
    // source is our real address anyway, so this works in both cases.
    const nat = hpai("0.0.0.0", 0);
    const body = Buffer.concat([nat, nat, Buffer.from([0x04, 0x04, 0x02, 0x00])]);
    const done = this.once((m) => m.readUInt16BE(2) === SVC.CONNECT_RES, 4000, "connect");
    await this.send(knxFrame(SVC.CONNECT_REQ, body));
    const res = await done;
    const b = res.subarray(6);
    if (b[1] !== 0) throw new KnxError("TUNNEL_CONNECT_REJECTED", `connect status 0x${b[1].toString(16)}`);
    this.channel = b[0];
    this.assignedIa = b.readUInt16BE(2 + 8 + 2); // channel/status + HPAI(8) + CRD type/len(2)
  }

  private connectResWaiter: { match: (m: Buffer) => boolean; resolve: (m: Buffer) => void } | null = null;
  // Only used for the CONNECT_RES waiter: a timeout here means the gateway never answered
  // the connect request (offline, wrong IP, or blocked), the most common bus-connect failure
  // and fully user-actionable, so it gets a coded error like the reject/ack-timeout paths.
  private once(match: (m: Buffer) => boolean, ms: number, what: string) {
    return new Promise<Buffer>((resolve, reject) => {
      this.connectResWaiter = { match, resolve: (m) => { this.connectResWaiter = null; resolve(m); } };
      setTimeout(() => reject(new KnxError("TUNNEL_CONNECT_TIMEOUT", `${what} timeout`)), ms);
    });
  }

  private async onMessage(m: Buffer) {
    if (this.closed) return; // teardown: there is no channel left to answer on
    const svc = m.readUInt16BE(2);
    const body = m.subarray(6);
    if (this.connectResWaiter?.match(m)) { this.connectResWaiter.resolve(m); return; }
    if (svc === SVC.TUNNEL_ACK) {
      if (this.ackWaiter && body[2] === this.ackWaiter.seq) { this.ackWaiter.resolve(); this.ackWaiter = null; }
    } else if (svc === SVC.TUNNEL_REQ) {
      const serverSeq = body[2];
      await this.send(knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, this.channel, serverSeq, 0x00])));
      const cemi = body.subarray(4);
      // Only L_Data.ind is a telegram from the bus. A gateway also tunnels L_Data.con back — its
      // confirmation that a frame WE sent reached the bus — and the two are byte-identical apart
      // from this code. Passing a .con on as an incoming telegram reports our own outgoing frames
      // to the upper layer as if a device had sent them. (The USB transport has always filtered
      // this correctly; the IP client did not.)
      if (cemi[0] !== CEMI.LDATA_IND) return;
      this.onRawCemi?.(Buffer.from(cemi));
      const { src, dst, tpdu, isGroup } = parseCemiLData(cemi);
      this.onCemi?.(src, dst, tpdu, isGroup);
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
    throw new KnxError("TUNNEL_ACK_TIMEOUT", "tunnelling ack timeout");
  }

  async disconnect() {
    // Stop answering FIRST. The DISCONNECT_REQ below still goes out, but anything that arrives from
    // here on belongs to a channel that is ending, and ACKing it would mean writing into a socket
    // this method is about to close.
    this.closed = true;
    try { await this.send(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([this.channel, 0x00]), hpai("0.0.0.0", 0)]))); } catch { /* teardown: the gateway may be gone; the channel is closed either way */ }
    this.sock?.close();
  }
}
