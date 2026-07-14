import dgram from "node:dgram";
import {
  SVC, KNXPORT, CEMI, CEMI_CON_ERROR, knxFrame, hpai, parseHpai,
  withMessageCode, withSource, cemiSource, numToIa, type Endpoint,
} from "./frame.ts";
import { SEARCH_MULTICAST } from "./discover.ts";
import { localIPv4, localMac } from "./localnet.ts";
import type { KnxTransport } from "./transport.ts";
import { KnxError } from "./errors.ts";

// KNXnet/IP tunnelling SERVER: the mirror image of KnxIpTunnel. It puts a KnxTransport (in
// practice the USB interface on the bench) on the network, so that anything speaking KNXnet/IP —
// Busforge running on another machine, ETS, a second Busforge instance watching the bus — can
// reach the bus through it.
//
// The reason this exists is not convenience. A USB interface can be opened by exactly ONE process,
// so with USB the bus monitor and a download are mutually exclusive, and the loser fails in a way
// that looks like a bus fault. A KNXnet/IP server MULTIPLEXES: several tunnels share one physical
// interface. That failure class disappears.
//
// What it deliberately does NOT do:
//   - routing (no multicast forwarding; the routing multicast address in the DIB stays 0.0.0.0)
//   - device-management connections (a client asking for one is refused, not silently accepted)
//   - bus-monitor layer connections (same)
// Each of those is answered with the KNXnet/IP error code that says so, because a client that
// believes it has a connection and then hears nothing is the worst of the three outcomes.

// KNXnet/IP connect/state status codes (3/8/2 §7.5.1)
const E_NO_ERROR = 0x00;
const E_CONNECTION_ID = 0x21;      // no such channel
const E_CONNECTION_TYPE = 0x22;    // connection type not supported
const E_NO_MORE_CONNECTIONS = 0x24;
const E_TUNNELLING_LAYER = 0x29;   // requested layer not supported

const CRI_TUNNEL = 0x04;   // connection type: tunnelling
const LAYER_LINK = 0x02;   // TUNNEL_LINKLAYER, the only layer we serve

// 3/8/4: a tunnelling client acknowledges within 1 s; the server retries once and then considers
// the client gone. 3/8/2: the client sends a CONNECTIONSTATE_REQUEST every 60 s, and the server
// drops a channel it has not heard from for 120 s. These numbers are the protocol's, not ours.
const ACK_TIMEOUT_MS = 1000;
const ACK_TRIES = 2;
const HEARTBEAT_TIMEOUT_MS = 120_000;
const REAP_INTERVAL_MS = 10_000;

// The socket surface the server uses. Narrow on purpose: it is the test seam, and a fake for it
// has to be exactly as complicated as the real behaviour we depend on, no more.
export interface ServerSocket {
  bind(port: number, cb: () => void): void;
  onMessage(cb: (m: Buffer, from: Endpoint) => void): void;
  onError(cb: (e: Error) => void): void;
  addMembership(group: string): void;
  send(buf: Buffer, to: Endpoint): void;
  close(): void;
}

function realSocket(): ServerSocket {
  const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return {
    bind: (port, cb) => { s.bind(port, cb); },
    onMessage: (cb) => { s.on("message", (m, r) => cb(m, { address: r.address, port: r.port })); },
    onError: (cb) => { s.on("error", cb); },
    addMembership: (g) => { s.addMembership(g); },
    send: (buf, to) => { s.send(buf, to.port, to.address); },
    close: () => { s.close(); },
  };
}

interface Channel {
  id: number;
  ia: number;          // the individual address this tunnel sends from
  control: Endpoint;   // where connection-state and disconnect answers go
  data: Endpoint;      // where tunnelling frames go
  txSeq: number;       // our sequence counter towards this client
  rxSeq: number;       // the next sequence number we expect FROM this client
  lastSeen: number;
  ack: { seq: number; resolve: () => void } | null;
  queue: Promise<void>; // serialises server -> client tunnelling; only one frame may be in flight
}

export interface KnxIpServerOptions {
  transport: KnxTransport;
  // The address(es) this server hands out to tunnelling clients, one per channel. Defaults to the
  // interface's own address, which means exactly one tunnel — the honest default, because a second
  // client sending from the same address would collide with the first in connection-oriented
  // management (the device's answers are addressed to the IA, and both tunnels would see them).
  // Handing out more addresses is only safe if they are free on that line; that is the operator's
  // call, so it is an explicit option and not a guess.
  addresses?: number[];
  name?: string;
  port?: number;
  serialNumber?: Buffer;
  createSocket?: () => ServerSocket;
  now?: () => number;
  log?: (msg: string) => void;
}

export class KnxIpServer {
  private readonly transport: KnxTransport;
  private readonly addresses: number[];
  private readonly name: string;
  private readonly port: number;
  private readonly serialNumber: Buffer;
  private readonly createSocket: () => ServerSocket;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private sock: ServerSocket | null = null;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private me: Endpoint = { address: "0.0.0.0", port: KNXPORT };
  readonly channels = new Map<number, Channel>();

  constructor(opts: KnxIpServerOptions) {
    this.transport = opts.transport;
    this.addresses = opts.addresses?.length ? [...opts.addresses] : [opts.transport.assignedIa];
    this.name = (opts.name ?? "Busforge Bridge").slice(0, 29);
    this.port = opts.port ?? KNXPORT;
    this.serialNumber = opts.serialNumber ?? Buffer.alloc(6);
    this.createSocket = opts.createSocket ?? realSocket;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  // The transport must already be connected: the address it hands out to tunnelling clients is the
  // interface's, and it only knows that once it has asked the interface.
  async start(): Promise<void> {
    if (this.addresses.some((a) => a === 0)) {
      throw new KnxError("BRIDGE_NO_ADDRESS",
        "the KNX interface did not tell us its individual address, so this server has none to hand out; a tunnel on 0.0.0 is an address no device can answer to, and every telegram sent through it would be untraceable on the bus");
    }
    const ip = localIPv4();
    if (ip === "0.0.0.0") {
      throw new KnxError("BRIDGE_NO_LOCAL_ADDRESS",
        "this host has no external IPv4 address, so the server has none to advertise; clients would discover it and then be unable to reach it");
    }
    this.me = { address: ip, port: this.port };

    const sock = this.createSocket();
    sock.onError((e) => this.log(`socket error: ${e.message}`));
    sock.onMessage((m, from) => this.onDatagram(m, from));
    await new Promise<void>((r) => sock.bind(this.port, () => r()));
    sock.addMembership(SEARCH_MULTICAST); // so a client's multicast SEARCH_REQUEST reaches us
    this.sock = sock;

    // Everything the bus says goes to every open tunnel, verbatim.
    this.transport.onRawCemi = (cemi) => { for (const ch of this.channels.values()) void this.toClient(ch, cemi); };

    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.log(`listening on ${ip}:${this.port} as ${numToIa(this.addresses[0])} (${this.addresses.length} tunnel address${this.addresses.length === 1 ? "" : "es"})`);
  }

  async stop(): Promise<void> {
    if (this.reaper) { clearInterval(this.reaper); this.reaper = null; }
    // Tell the clients rather than vanishing: a tunnel whose server disappears silently sits there
    // until its own 120 s heartbeat timeout and reports a bus fault in the meantime.
    for (const ch of [...this.channels.values()]) {
      this.send(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([ch.id, E_NO_ERROR]), hpai(this.me.address, this.me.port)])), ch.control);
      this.channels.delete(ch.id);
    }
    this.transport.onRawCemi = null;
    this.sock?.close();
    this.sock = null;
  }

  private send(frame: Buffer, to: Endpoint): void {
    this.sock?.send(frame, to);
  }

  // ---- discovery / description ----

  private deviceInfoDib(): Buffer {
    const b = Buffer.alloc(54);
    b[0] = 54;
    b[1] = 0x01;                              // DIB type: device information
    b[2] = 0x02;                              // KNX medium: TP1
    b[3] = 0x00;                              // device status: not in programming mode
    b.writeUInt16BE(this.addresses[0], 4);   // the interface's own address
    b.writeUInt16BE(0, 6);                    // project installation id: none
    this.serialNumber.copy(b, 8, 0, 6);
    // 14..17 stay zero: the routing multicast address. This server does not route, and saying so
    // with 0.0.0.0 is what tells a client not to expect routing from it.
    localMac().copy(b, 18, 0, 6);
    b.write(this.name, 24, "latin1");         // 30-byte field, NUL-padded; the name is capped to 29
    return b;
  }

  // CORE and TUNNELLING only. DEVICE MANAGEMENT (family 0x03) is not advertised because it is not
  // implemented, and a client that saw it advertised would open such a connection and then wait
  // forever for an answer we never send.
  private static readonly SUPP_SVC_DIB = Buffer.from([0x06, 0x02, 0x02, 0x01, 0x04, 0x01]);

  private describe(): Buffer {
    return Buffer.concat([this.deviceInfoDib(), KnxIpServer.SUPP_SVC_DIB]);
  }

  // ---- datagram dispatch ----

  private onDatagram(m: Buffer, from: Endpoint): void {
    try {
      this.dispatch(m, from);
    } catch (e) {
      // The socket is bound on the LAN, so every host can send it a truncated or malformed frame,
      // and the parsers here read at fixed and cEMI-relative offsets that a short buffer overruns.
      // A throw out of the dgram 'message' listener is an uncaught exception: one crafted packet
      // per second would be a denial of service. A datagram we cannot parse is simply not a request
      // we can answer, so it is dropped, with one line rather than a stack trace per packet.
      this.log(`dropped a malformed datagram from ${from.address}:${from.port}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private dispatch(m: Buffer, from: Endpoint): void {
    if (m.length < 6 || m[0] !== 0x06 || m[1] !== 0x10) return; // not a KNXnet/IP frame
    const svc = m.readUInt16BE(2);
    const body = m.subarray(6);
    switch (svc) {
      case SVC.SEARCH_REQ:
        this.send(knxFrame(SVC.SEARCH_RES, Buffer.concat([hpai(this.me.address, this.me.port), this.describe()])), parseHpai(body, 0, from));
        return;
      case SVC.DESCRIPTION_REQ:
        this.send(knxFrame(SVC.DESCRIPTION_RES, this.describe()), parseHpai(body, 0, from));
        return;
      case SVC.CONNECT_REQ:
        this.onConnect(body, from);
        return;
      case SVC.CONNECTIONSTATE_REQ:
        this.onConnectionState(body, from);
        return;
      case SVC.DISCONNECT_REQ:
        this.onDisconnect(body, from);
        return;
      case SVC.TUNNEL_REQ:
        void this.onTunnelRequest(body);
        return;
      case SVC.TUNNEL_ACK:
        this.onTunnelAck(body);
        return;
      default:
        return; // a service we do not implement: silence is the protocol's answer, not an error
    }
  }

  // ---- connection management ----

  private onConnect(body: Buffer, from: Endpoint): void {
    const control = parseHpai(body, 0, from);
    const data = parseHpai(body, 8, from);
    const cri = body.subarray(16);
    const reject = (status: number) =>
      this.send(knxFrame(SVC.CONNECT_RES, Buffer.from([0x00, status])), control);

    if (cri[1] !== CRI_TUNNEL) { reject(E_CONNECTION_TYPE); return; }   // device management: not served
    if (cri[2] !== LAYER_LINK) { reject(E_TUNNELLING_LAYER); return; }  // bus-monitor layer: not served

    const taken = new Set([...this.channels.values()].map((c) => c.ia));
    const ia = this.addresses.find((a) => !taken.has(a));
    let id = 1;
    while (this.channels.has(id) && id < 0xff) id++;
    if (ia === undefined || this.channels.has(id)) { reject(E_NO_MORE_CONNECTIONS); return; }

    this.channels.set(id, { id, ia, control, data, txSeq: 0, rxSeq: 0, lastSeen: this.now(), ack: null, queue: Promise.resolve() });
    const crd = Buffer.from([0x04, CRI_TUNNEL, (ia >> 8) & 0xff, ia & 0xff]);
    this.send(knxFrame(SVC.CONNECT_RES, Buffer.concat([Buffer.from([id, E_NO_ERROR]), hpai(this.me.address, this.me.port), crd])), control);
    this.log(`channel ${id} open for ${data.address}:${data.port} as ${numToIa(ia)}`);
  }

  private onConnectionState(body: Buffer, from: Endpoint): void {
    const id = body[0];
    const ch = this.channels.get(id);
    const to = parseHpai(body, 2, from);
    if (ch) ch.lastSeen = this.now();
    this.send(knxFrame(SVC.CONNECTIONSTATE_RES, Buffer.from([id, ch ? E_NO_ERROR : E_CONNECTION_ID])), to);
  }

  private onDisconnect(body: Buffer, from: Endpoint): void {
    const id = body[0];
    const ch = this.channels.get(id);
    this.send(knxFrame(SVC.DISCONNECT_RES, Buffer.from([id, ch ? E_NO_ERROR : E_CONNECTION_ID])), parseHpai(body, 2, from));
    if (ch) { this.channels.delete(id); this.log(`channel ${id} closed by the client`); }
  }

  // A client that stops sending CONNECTIONSTATE_REQUESTs is gone (crashed, unplugged, routed away).
  // Its channel holds one of the tunnel addresses, so leaving it open would eventually starve the
  // server of addresses and refuse honest clients.
  private reap(): void {
    const cutoff = this.now() - HEARTBEAT_TIMEOUT_MS;
    for (const ch of [...this.channels.values()]) {
      if (ch.lastSeen < cutoff) this.drop(ch, "no connection-state request for 120 s");
    }
  }

  private drop(ch: Channel, why: string): void {
    if (!this.channels.delete(ch.id)) return;
    this.send(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([ch.id, E_NO_ERROR]), hpai(this.me.address, this.me.port)])), ch.control);
    this.log(`channel ${ch.id} dropped: ${why}`);
  }

  // ---- tunnelling: client -> bus ----

  private async onTunnelRequest(body: Buffer): Promise<void> {
    const id = body[1];
    const seq = body[2];
    const ch = this.channels.get(id);
    if (!ch) return; // no such channel: there is nothing to acknowledge ON
    ch.lastSeen = this.now();

    // The sequence number is what tells a fresh frame from a retransmission of one whose ACK got
    // lost. A repeat of the last frame must be acknowledged again (or the client keeps repeating)
    // but must NOT be put on the bus twice — a duplicated memory write is exactly the kind of
    // damage this project exists to avoid. Anything else is out of order: drop it, do not ACK it.
    const expected = ch.rxSeq;
    const previous = (expected - 1) & 0xff;
    if (seq === previous) { this.send(knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR])), ch.data); return; }
    if (seq !== expected) { this.log(`channel ${id}: dropped a frame out of sequence (got ${seq}, expected ${expected})`); return; }

    this.send(knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR])), ch.data);
    ch.rxSeq = (expected + 1) & 0xff;

    const cemi = body.subarray(4);
    if (cemi[0] !== CEMI.LDATA_REQ) {
      // The tunnel-layer ACK above is about the datagram, not its content; refusing the content is
      // a separate thing and it is said out loud rather than dropped on the floor.
      this.log(`channel ${id}: refused a cEMI message code 0x${cemi[0].toString(16)}; this server tunnels L_Data.req only`);
      return;
    }

    // A client that sends from 0.0.0 means "you know who I am": that is this channel's address.
    const framed = cemiSource(cemi) === 0 ? withSource(cemi, ch.ia) : Buffer.from(cemi);

    let failed = false;
    try {
      await this.transport.sendCemi(framed);
    } catch (e) {
      failed = true;
      this.log(`channel ${id}: the bus did not take the frame: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The L_Data.con is the ONLY way a tunnelling client learns whether its telegram reached the
    // bus. Withholding it on failure would leave the client waiting on a timeout it cannot
    // interpret; sending a clean one would be a lie. So it is sent either way, with the error bit
    // carrying the truth.
    const con = withMessageCode(framed, CEMI.LDATA_CON);
    // The confirm flag is in ctrl1, which sits AFTER the variable-length additional-info block, so
    // its offset is 2 + the additional-info length, not a fixed 2. Real clients send no additional
    // info (cemi[1] == 0) so the two coincide today, but writing the error bit at a fixed offset
    // would, for any client that does, land it inside the additional-info bytes and hand that
    // client a clean confirmation for a frame that never reached the bus.
    if (failed) con[2 + con[1]] |= CEMI_CON_ERROR;
    void this.toClient(ch, con);

    // The other tunnels are on the same bus and must see this frame, exactly as they would have
    // seen it if the client had been a device. Without this, two Busforge instances sharing the
    // bridge each see only half the conversation.
    if (!failed) {
      const ind = withMessageCode(framed, CEMI.LDATA_IND);
      for (const other of this.channels.values()) if (other.id !== ch.id) void this.toClient(other, ind);
    }
  }

  // ---- tunnelling: bus -> client ----

  private toClient(ch: Channel, cemi: Buffer): Promise<void> {
    // Serialised per channel: KNXnet/IP allows exactly one unacknowledged tunnelling frame per
    // connection, so a second send must wait rather than race the first one's ACK.
    ch.queue = ch.queue.then(async () => {
      for (let i = 0; i < ACK_TRIES; i++) {
        const seq = ch.txSeq;
        const acked = new Promise<boolean>((resolve) => {
          ch.ack = { seq, resolve: () => resolve(true) };
          setTimeout(() => resolve(false), ACK_TIMEOUT_MS);
        });
        this.send(knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, ch.id, seq, 0x00]), cemi])), ch.data);
        if (await acked) { ch.ack = null; ch.txSeq = (seq + 1) & 0xff; return; }
      }
      ch.ack = null;
      this.drop(ch, "the client acknowledged neither the frame nor its repetition");
    }).catch((e: unknown) => {
      // The chain must survive a failed send, or one dead socket write would wedge the channel's
      // queue forever and every later frame for that client would silently never go out.
      this.log(`channel ${ch.id}: send failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return ch.queue;
  }

  private onTunnelAck(body: Buffer): void {
    const ch = this.channels.get(body[1]);
    if (!ch) return;
    ch.lastSeen = this.now();
    if (ch.ack && ch.ack.seq === body[2]) ch.ack.resolve();
  }
}
