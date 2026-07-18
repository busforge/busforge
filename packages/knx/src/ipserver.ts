import dgram from "node:dgram";
import net from "node:net";
import {
  SVC, KNXPORT, CEMI, CEMI_CON_ERROR, knxFrame, hpai, hpaiTcp, parseHpai,
  withMessageCode, withSource, cemiSource, numToIa, KnxIpStreamParser, type Endpoint,
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

// One accepted TCP connection. Narrow like ServerSocket: write() puts a framed KNXnet/IP frame on
// the wire, onData() delivers raw stream bytes (which the server reassembles), onClose() fires when
// the connection ends. A TCP channel is bound to exactly one of these for its whole lifetime.
export interface ServerTcpSocket {
  write(frame: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  end(): void;
}

// The TCP listener seam, mirroring ServerSocket so the tests stay socket-free.
export interface ServerTcpListener {
  listen(port: number, cb: () => void): void;
  onConnection(cb: (sock: ServerTcpSocket) => void): void;
  close(): void;
}

function realTcpListener(): ServerTcpListener {
  const server = net.createServer();
  return {
    listen: (port, cb) => { server.listen(port, cb); },
    onConnection: (cb) => {
      server.on("connection", (s) => {
        // 'error' must have a listener or node throws it uncaught; the 'close' that always follows an
        // error is what actually reaps the channel, so the error handler need only keep the process up.
        s.on("error", () => {});
        cb({
          write: (frame) => { s.write(frame); },
          onData: (dcb) => { s.on("data", dcb); },
          onClose: (ccb) => { s.on("close", ccb); },
          end: () => { s.end(); },
        });
      });
    },
    close: () => { server.close(); },
  };
}

interface Channel {
  id: number;
  ia: number;          // the individual address this tunnel sends from
  control: Endpoint;   // where connection-state and disconnect answers go (UDP channels only)
  data: Endpoint;      // where tunnelling frames go (UDP channels only)
  // Set for a channel established over TCP; when set, EVERY reply for this channel goes back over
  // this socket and the control/data Endpoints above are unused. null for a UDP channel.
  tcp: ServerTcpSocket | null;
  txSeq: number;       // our sequence counter towards this client
  rxSeq: number;       // the next sequence number we expect FROM this client
  lastSeen: number;
  ack: { seq: number; resolve: () => void } | null;
  queue: Promise<void>; // serialises server -> client tunnelling; only one frame may be in flight
}

// Where a datagram/frame came from, and therefore where its response goes. A UDP request answers to
// the HPAI it carries (with the NAT fallback to the packet source); a TCP request answers on the
// same connection, ignoring any HPAI. Threaded through dispatch so one code path serves both.
type Origin =
  | { kind: "udp"; from: Endpoint }
  | { kind: "tcp"; sock: ServerTcpSocket };

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
  createTcpListener?: () => ServerTcpListener;
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
  private readonly createTcpListener: () => ServerTcpListener;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private sock: ServerSocket | null = null;
  private tcp: ServerTcpListener | null = null;
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
    this.createTcpListener = opts.createTcpListener ?? realTcpListener;
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

    // The standard KNXnet/IP Tunnelling-over-TCP listener on the same port. ETS's plain tunnel uses
    // UDP and keeps working through the socket above; a client that opens a TCP connection and then
    // CONNECT_REQs gets its own channel here, multiplexed into the same channel map.
    const tcp = this.createTcpListener();
    tcp.onConnection((s) => this.onTcpConnection(s));
    await new Promise<void>((r) => tcp.listen(this.port, () => r()));
    this.tcp = tcp;

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
      this.toControl(ch, knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([ch.id, E_NO_ERROR]), this.controlHpai(ch)])));
      ch.tcp?.end();
      this.channels.delete(ch.id);
    }
    this.transport.onRawCemi = null;
    this.sock?.close();
    this.sock = null;
    this.tcp?.close();
    this.tcp = null;
  }

  private send(frame: Buffer, to: Endpoint): void {
    this.sock?.send(frame, to);
  }

  // A frame directed at an established channel: over its TCP connection if it has one, else to the
  // matching UDP endpoint. control carries connection-state / disconnect answers, data carries
  // tunnelling frames; on TCP the two coincide (the one socket), so the split is a UDP concern.
  private toControl(ch: Channel, frame: Buffer): void { if (ch.tcp) ch.tcp.write(frame); else this.send(frame, ch.control); }
  private toData(ch: Channel, frame: Buffer): void { if (ch.tcp) ch.tcp.write(frame); else this.send(frame, ch.data); }

  // The control HPAI this server puts in a DISCONNECT_REQUEST it originates. On TCP it is the
  // zero-address IPV4_TCP HPAI (the connection is the endpoint); on UDP it is this server's address.
  private controlHpai(ch: Channel): Buffer { return ch.tcp ? hpaiTcp() : hpai(this.me.address, this.me.port); }

  // A KNXnet/IP frame arriving on one accepted TCP connection. The stream is reassembled into whole
  // frames and each is dispatched through the SAME service logic as a UDP datagram; the difference is
  // only where the answers go (back over this socket). A stream that cannot be kept in frame is
  // dropped with the connection, exactly as a malformed datagram is dropped, never crashing the server.
  private onTcpConnection(sock: ServerTcpSocket): void {
    const parser = new KnxIpStreamParser();
    sock.onData((chunk) => {
      let frames: Buffer[];
      try { frames = parser.push(chunk); }
      catch (e) {
        this.log(`tcp: dropped a connection whose KNXnet/IP stream desynchronised: ${e instanceof Error ? e.message : String(e)}`);
        sock.end();
        return;
      }
      for (const m of frames) {
        try { this.dispatch(m, { kind: "tcp", sock }); }
        catch (e) { this.log(`tcp: dropped a malformed frame: ${e instanceof Error ? e.message : String(e)}`); }
      }
    });
    // A TCP channel's liveness IS its socket (3/8/2 v2: no CONNECTIONSTATE heartbeat on TCP). When the
    // connection ends, delete its channel; do NOT send a DISCONNECT into a socket that is already gone.
    sock.onClose(() => {
      for (const ch of [...this.channels.values()]) {
        if (ch.tcp === sock && this.channels.delete(ch.id)) this.log(`channel ${ch.id} closed: its TCP connection dropped`);
      }
    });
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
      this.dispatch(m, { kind: "udp", from });
    } catch (e) {
      // The socket is bound on the LAN, so every host can send it a truncated or malformed frame,
      // and the parsers here read at fixed and cEMI-relative offsets that a short buffer overruns.
      // A throw out of the dgram 'message' listener is an uncaught exception: one crafted packet
      // per second would be a denial of service. A datagram we cannot parse is simply not a request
      // we can answer, so it is dropped, with one line rather than a stack trace per packet.
      this.log(`dropped a malformed datagram from ${from.address}:${from.port}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private dispatch(m: Buffer, origin: Origin): void {
    if (m.length < 6 || m[0] !== 0x06 || m[1] !== 0x10) return; // not a KNXnet/IP frame
    const svc = m.readUInt16BE(2);
    const body = m.subarray(6);
    switch (svc) {
      case SVC.SEARCH_REQ:
        this.answer(origin, () => parseHpai(body, 0, this.originFrom(origin)), knxFrame(SVC.SEARCH_RES, Buffer.concat([this.responseHpai(origin), this.describe()])));
        return;
      case SVC.DESCRIPTION_REQ:
        this.answer(origin, () => parseHpai(body, 0, this.originFrom(origin)), knxFrame(SVC.DESCRIPTION_RES, this.describe()));
        return;
      case SVC.CONNECT_REQ:
        this.onConnect(body, origin);
        return;
      case SVC.CONNECTIONSTATE_REQ:
        this.onConnectionState(body, origin);
        return;
      case SVC.DISCONNECT_REQ:
        this.onDisconnect(body, origin);
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

  // The datagram source a UDP request's HPAI falls back to (its 0.0.0.0:0 NAT form); irrelevant for a
  // TCP request, whose response never consults an HPAI.
  private originFrom(origin: Origin): Endpoint { return origin.kind === "udp" ? origin.from : this.me; }

  // Send a response to where a request came from: on TCP over the same connection, on UDP to the HPAI
  // the request carried (computed lazily, since a TCP request has none worth parsing).
  private answer(origin: Origin, udpTo: () => Endpoint, frame: Buffer): void {
    if (origin.kind === "tcp") origin.sock.write(frame);
    else this.send(frame, udpTo());
  }

  // The HPAI this server puts in a response (SEARCH_RES / DESCRIPTION_RES / CONNECT_RES). On a TCP
  // connection it MUST be the zero-address IPV4_TCP HPAI: the connection is the endpoint, and a
  // strict client (ETS) rejects a TCP handshake whose response advertises a UDP address to answer at.
  // On UDP it names this server's own address as before.
  private responseHpai(origin: Origin): Buffer {
    return origin.kind === "tcp" ? hpaiTcp() : hpai(this.me.address, this.me.port);
  }

  // ---- connection management ----

  private onConnect(body: Buffer, origin: Origin): void {
    const from = this.originFrom(origin);
    const control = parseHpai(body, 0, from);
    const data = parseHpai(body, 8, from);
    const cri = body.subarray(16);
    const reject = (status: number) =>
      this.answer(origin, () => control, knxFrame(SVC.CONNECT_RES, Buffer.from([0x00, status])));

    if (cri[1] !== CRI_TUNNEL) { reject(E_CONNECTION_TYPE); return; }   // device management: not served
    if (cri[2] !== LAYER_LINK) { reject(E_TUNNELLING_LAYER); return; }  // bus-monitor layer: not served

    const taken = new Set([...this.channels.values()].map((c) => c.ia));
    // Tunnelling v2 (3/8/4): a client MAY ask for a SPECIFIC tunnel address by extending the CRI to
    // 6 bytes, the last two carrying the desired individual address (this is what ETS's per-connection
    // "Individual Address" field sends). It is honoured only within our configured pool and only if
    // that address is free: the pool is the operator's assertion of which addresses are safe on this
    // line, so a request for one we do not own, or one already in use, is refused rather than
    // silently substituted — a client that believes it holds 1.1.253 while actually sending from
    // 1.1.254 would mislabel every telegram it puts on the bus. Without a request, assign first free.
    let ia: number | undefined;
    if (cri[0] >= 6 && cri.length >= 6) {
      const wanted = (cri[4] << 8) | cri[5];
      if (!this.addresses.includes(wanted) || taken.has(wanted)) {
        this.log(`refused a request for tunnel address ${numToIa(wanted)}: ${this.addresses.includes(wanted) ? "already in use" : "not in this server's pool"}`);
        reject(E_NO_MORE_CONNECTIONS);
        return;
      }
      ia = wanted;
    } else {
      ia = this.addresses.find((a) => !taken.has(a));
    }
    let id = 1;
    while (this.channels.has(id) && id < 0xff) id++;
    if (ia === undefined || this.channels.has(id)) { reject(E_NO_MORE_CONNECTIONS); return; }

    const tcp = origin.kind === "tcp" ? origin.sock : null;
    this.channels.set(id, { id, ia, control, data, tcp, txSeq: 0, rxSeq: 0, lastSeen: this.now(), ack: null, queue: Promise.resolve() });
    const crd = Buffer.from([0x04, CRI_TUNNEL, (ia >> 8) & 0xff, ia & 0xff]);
    this.answer(origin, () => control, knxFrame(SVC.CONNECT_RES, Buffer.concat([Buffer.from([id, E_NO_ERROR]), this.responseHpai(origin), crd])));
    this.log(`channel ${id} open ${tcp ? "over TCP" : `for ${data.address}:${data.port}`} as ${numToIa(ia)}`);
  }

  private onConnectionState(body: Buffer, origin: Origin): void {
    const id = body[0];
    const ch = this.channels.get(id);
    if (ch) ch.lastSeen = this.now();
    this.answer(origin, () => parseHpai(body, 2, this.originFrom(origin)), knxFrame(SVC.CONNECTIONSTATE_RES, Buffer.from([id, ch ? E_NO_ERROR : E_CONNECTION_ID])));
  }

  private onDisconnect(body: Buffer, origin: Origin): void {
    const id = body[0];
    const ch = this.channels.get(id);
    this.answer(origin, () => parseHpai(body, 2, this.originFrom(origin)), knxFrame(SVC.DISCONNECT_RES, Buffer.from([id, ch ? E_NO_ERROR : E_CONNECTION_ID])));
    if (ch) { this.channels.delete(id); this.log(`channel ${id} closed by the client`); }
  }

  // A client that stops sending CONNECTIONSTATE_REQUESTs is gone (crashed, unplugged, routed away).
  // Its channel holds one of the tunnel addresses, so leaving it open would eventually starve the
  // server of addresses and refuse honest clients.
  private reap(): void {
    const cutoff = this.now() - HEARTBEAT_TIMEOUT_MS;
    for (const ch of [...this.channels.values()]) {
      // A TCP channel is reaped by its socket's lifetime (onTcpConnection's onClose), never by
      // heartbeat silence: 3/8/2 v2 does not run the CONNECTIONSTATE procedure over TCP, so a quiet
      // but connected TCP client has no lastSeen to refresh and must not be dropped for it.
      if (ch.tcp) continue;
      if (ch.lastSeen < cutoff) this.drop(ch, "no connection-state request for 120 s");
    }
  }

  private drop(ch: Channel, why: string): void {
    // Identity, not id. A channel id is reused as soon as it is freed (see the id search in
    // onConnectRequest). A stale channel object — one closed while a frame still sat in its send
    // queue, whose retry loop only expires ~2-4 s later — must never delete the NEW channel that
    // reused its id, nor send that new client a DISCONNECT into the OLD socket. Deleting by id
    // alone did exactly that: the successor silently lost its channel and its next tunnelling
    // request went unacknowledged ("tunnelling ack timeout").
    if (this.channels.get(ch.id) !== ch) return;
    this.channels.delete(ch.id);
    this.toControl(ch, knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([ch.id, E_NO_ERROR]), this.controlHpai(ch)])));
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
    if (seq === previous) { this.toData(ch, knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR]))); return; }
    if (seq !== expected) { this.log(`channel ${id}: dropped a frame out of sequence (got ${seq}, expected ${expected})`); return; }

    this.toData(ch, knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR])));
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
        // Stop the moment the channel is gone from the map (closed by the client, or dropped).
        // Retransmitting to a departed client burns ACK_TIMEOUT_MS per try for nothing, and the
        // trailing drop() would fire against an id another client may already have reused.
        if (this.channels.get(ch.id) !== ch) return;
        const seq = ch.txSeq;
        const acked = new Promise<boolean>((resolve) => {
          ch.ack = { seq, resolve: () => resolve(true) };
          setTimeout(() => resolve(false), ACK_TIMEOUT_MS);
        });
        this.toData(ch, knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, ch.id, seq, 0x00]), cemi])));
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
