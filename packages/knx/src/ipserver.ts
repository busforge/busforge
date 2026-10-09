import dgram from "node:dgram";
import net from "node:net";
import {
  SVC, KNXPORT, CEMI, CEMI_CON_ERROR, BROADCAST, knxFrame, hpai, hpaiTcp, parseHpai,
  withMessageCode, withSource, withDest, cemiSource, cemiDest, cemiIsGroup, numToIa,
  KnxIpStreamParser, type Endpoint,
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
// It also accepts the LOCAL DEVICE-MANAGEMENT connection ETS opens alongside its tunnel, and answers
// the interface-object property reads over it (its own addresses, medium, capabilities); refusing it
// made ETS abort the whole session. See acceptMgmt / onDeviceConfig.
//
// What it deliberately does NOT do:
//   - routing (no multicast forwarding; the routing multicast address in the DIB stays 0.0.0.0)
//   - bus-monitor layer connections (a client asking for one is refused, not silently accepted)
// That one is answered with the KNXnet/IP error code that says so, because a client that believes it
// has a connection and then hears nothing is the worst outcome.

// KNXnet/IP connect/state status codes (3/8/2 §7.5.1)
const E_NO_ERROR = 0x00;
const E_CONNECTION_ID = 0x21;      // no such channel
const E_CONNECTION_TYPE = 0x22;    // connection type not supported
const E_NO_MORE_CONNECTIONS = 0x24;
const E_KNX_CONNECTION = 0x27;     // the server has no connection to the KNX subnetwork
const E_TUNNELLING_LAYER = 0x29;   // requested layer not supported

const CRI_TUNNEL = 0x04;   // connection type: tunnelling
const CRI_DEVICE_MGMT = 0x03; // connection type: local device management (cEMI property access)
const LAYER_LINK = 0x02;   // TUNNEL_LINKLAYER, the only layer we serve

// cEMI local-device-management message codes (M_Prop*). A device-configuration connection carries
// these instead of L_Data: a client (ETS) reads the interface's OWN interface-object properties
// (its addresses, medium, capabilities) over it. .con is our answer to a .req; nrOfElem 0 on a
// read-con means "no such property/element" and the single data byte is the negative-response code.
const MPR_READ_REQ = 0xfc, MPR_READ_CON = 0xfb, MPR_WRITE_REQ = 0xf6, MPR_WRITE_CON = 0xf5;
const PROP_ERR_VOID = 0x07; // "the property does not exist / element out of range"

// 3/8/4: a tunnelling client acknowledges within 1 s; the server retries once and then considers
// the client gone. 3/8/2: the client sends a CONNECTIONSTATE_REQUEST every 60 s, and the server
// drops a channel it has not heard from for 120 s. These numbers are the protocol's, not ours.
const ACK_TIMEOUT_MS = 1000;
const ACK_TRIES = 2;
const HEARTBEAT_TIMEOUT_MS = 120_000;
const REAP_INTERVAL_MS = 10_000;
// How long a TCP connection the server ends may take to complete its close. A FIN alone leaves the
// socket to a peer that may never answer it (vanished, or alive but hung), so it is destroyed after.
const TCP_CLOSE_GRACE_MS = 5_000;

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
  readonly remote?: string; // "address:port" of the peer, for the log
  write(frame: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  end(): void;
  destroy(): void;
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
          remote: `${s.remoteAddress ?? "?"}:${s.remotePort ?? "?"}`,
          write: (frame) => { s.write(frame); },
          onData: (dcb) => { s.on("data", dcb); },
          onClose: (ccb) => { s.on("close", ccb); },
          end: () => { s.end(); },
          destroy: () => { s.destroy(); },
        });
      });
    },
    close: () => { server.close(); },
  };
}

interface Channel {
  id: number;
  mgmt?: boolean;      // a local device-management channel (cEMI property access), not a tunnel
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
  // The longest APDU the path behind this server carries (Device Object PID 56). ETS sends at most
  // min(this, the device's own) per frame, so more than the interface carries loses the frames above it.
  maxApdu: number;
  name?: string;
  port?: number;
  serialNumber?: Buffer;
  createSocket?: () => ServerSocket;
  createTcpListener?: () => ServerTcpListener;
  now?: () => number;
  log?: (msg: string) => void;
}

export class KnxIpServer {
  private transport: KnxTransport;
  private readonly maxApdu: number;
  // Why the interface is gone, while it is; null while it serves. See interfaceLost.
  private down: string | null = null;
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
  // Every accepted TCP connection and when it last carried a frame. The channel reaper cannot see a
  // connection that never opened a channel (a search or description, then a vanished peer).
  private readonly tcpConns = new Map<ServerTcpSocket, number>();
  private tcpCloseGraceMs = TCP_CLOSE_GRACE_MS;
  // Management NAT (the USB single-address limit): device address -> the channel whose connection-
  // oriented conversation with that device is being funnelled through the interface's own address.
  // The bus reply to such a frame is addressed to the interface, not the tunnel, so it is routed
  // back to the owning channel here. See onTunnelRequest / routeFromBus.
  //
  // There is exactly ONE owner per device, and that is not a simplification: a USB interface holds a
  // single connection-oriented state on its own IA, so two tunnels managing the same device would
  // both send as that IA and collide at the KNX transport layer regardless of what this map says —
  // one-owner is the hardware's constraint, not this code's. The entry is keyed by, and identity-
  // checked against, the live channel (routeFromBus), so a channel that closed — or whose id was
  // reused by a new client — never inherits a stale conversation: the check fails and the frame
  // falls through to the ordinary fan-out. A stale entry for a still-open owner is therefore the only
  // one that survives, and it can only ever route a reply back to that same management tunnel, which
  // is where it belongs; it is left unpruned because pruning would buy nothing.
  private readonly mgmtOwner = new Map<number, Channel>();

  constructor(opts: KnxIpServerOptions) {
    this.transport = opts.transport;
    this.addresses = opts.addresses?.length ? [...opts.addresses] : [opts.transport.assignedIa];
    if (!Number.isInteger(opts.maxApdu) || opts.maxApdu < 15 || opts.maxApdu > 254) throw new Error(`maximum APDU length ${opts.maxApdu} is outside 15..254`);
    this.maxApdu = opts.maxApdu;
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

    // Everything the bus says goes to the tunnels; routeFromBus decides whether a frame is broadcast
    // to every tunnel (group traffic) or handed to the one channel a management conversation belongs to.
    this.transport.onRawCemi = (cemi) => this.routeFromBus(cemi);

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

  // The interface under the tunnels went away (a USB stick that re-enumerated). Every open channel
  // is disconnected, and every new connection is refused with E_KNX_CONNECTION until
  // interfaceRestored: a tunnel granted on a dead interface would confirm each frame negatively,
  // which a client cannot tell from a dead line or an absent device.
  interfaceLost(reason: string): void {
    if (this.down !== null) return;
    this.down = reason;
    this.transport.onRawCemi = null;
    this.mgmtOwner.clear();
    this.log(`the KNX interface is gone (${reason}); disconnecting every tunnel and refusing new ones until it is back`);
    for (const ch of [...this.channels.values()]) this.drop(ch, "the KNX interface is gone");
  }

  // The interface is back, as a new transport. It must hold the address the old one held: the
  // tunnel addresses this server hands out and the management NAT are both built on it, and an
  // interface with another address is another interface.
  interfaceRestored(transport: KnxTransport): void {
    if (this.sock === null) throw new Error("interfaceRestored: the server is not running");
    if (this.down === null) throw new Error("interfaceRestored: the interface is not gone");
    if (transport.assignedIa === 0) {
      throw new KnxError("BRIDGE_NO_ADDRESS", "the KNX interface is back but did not tell its individual address yet");
    }
    // An interface that had no address (possible with an explicit address pool) takes the one it
    // reports now; one that had an address must come back with it.
    const before = this.transport.assignedIa;
    if (before !== 0 && transport.assignedIa !== before) {
      throw new KnxError("BRIDGE_INTERFACE_CHANGED",
        `the KNX interface is back as ${numToIa(transport.assignedIa)}, not ${numToIa(before)} (reprogrammed, or another stick); the tunnels hand out and route by the old address, so restart the bridge to serve it under the new one`);
    }
    this.transport = transport;
    this.transport.onRawCemi = (cemi) => this.routeFromBus(cemi);
    this.down = null;
    this.log(`the KNX interface is back as ${numToIa(transport.assignedIa)}; accepting tunnels again`);
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
    this.tcpConns.set(sock, this.now());
    sock.onData((chunk) => {
      this.tcpConns.set(sock, this.now());
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
    // When the connection ends, delete its channels; do NOT send a DISCONNECT into a socket that is
    // already gone. A peer that vanished without a FIN never gets here: reap() catches that one.
    sock.onClose(() => {
      this.tcpConns.delete(sock);
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

  // Advertise CORE v2, DEVICE MANAGEMENT v2 and TUNNELLING v1. Core MUST be v2 or a strict client
  // (ETS) will not attempt a connection over TCP at all: KNXnet/IP tunnelling over TCP is a Core-v2
  // feature, so on Core v1 ETS does the DESCRIPTION over TCP and then gives up without a CONNECT.
  // Device management is advertised because ETS opens such a connection alongside its tunnel and we
  // now answer it (acceptMgmt / onDeviceConfig).
  private static readonly SUPP_SVC_DIB = Buffer.from([0x08, 0x02, 0x02, 0x02, 0x03, 0x02, 0x04, 0x01]);

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
      case SVC.DEVICE_CONFIG_REQ:
        this.onDeviceConfig(body, origin);
        return;
      case SVC.DEVICE_CONFIG_ACK:
        return; // the client acknowledging one of our config responses; nothing more to do
      case SVC.TUNNEL_REQ:
        void this.onTunnelRequest(body, origin);
        return;
      case SVC.TUNNEL_ACK:
        this.onTunnelAck(body, origin);
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

    if (this.down !== null) {
      this.log(`refused a connection: the KNX interface is gone (${this.down})`);
      reject(E_KNX_CONNECTION);
      return;
    }
    if (cri[1] === CRI_DEVICE_MGMT) { this.acceptMgmt(control, data, origin); return; } // ETS opens one alongside its tunnel
    if (cri[1] !== CRI_TUNNEL) { reject(E_CONNECTION_TYPE); return; }
    if (cri[2] !== LAYER_LINK) { reject(E_TUNNELLING_LAYER); return; }  // bus-monitor layer: not served

    const taken = new Set([...this.channels.values()].filter((c) => !c.mgmt).map((c) => c.ia));
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
    if (ia === undefined) {
      // Said with the holders: a channel whose client vanished keeps its address until the reaper
      // takes it, and the log is where that shows.
      const holders = [...this.channels.values()].filter((c) => !c.mgmt)
        .map((c) => `${numToIa(c.ia)} held by channel ${c.id} ${this.peer(c)}, last heard ${Math.round((this.now() - c.lastSeen) / 1000)} s ago`);
      this.log(`refused a connection ${origin.kind === "tcp" ? `over TCP from ${origin.sock.remote ?? "?"}` : `from ${from.address}:${from.port}`}: no free tunnel address (${holders.join("; ")})`);
      reject(E_NO_MORE_CONNECTIONS);
      return;
    }
    if (this.channels.has(id)) { reject(E_NO_MORE_CONNECTIONS); return; }

    const tcp = origin.kind === "tcp" ? origin.sock : null;
    this.channels.set(id, { id, ia, control, data, tcp, txSeq: 0, rxSeq: 0, lastSeen: this.now(), ack: null, queue: Promise.resolve() });
    const crd = Buffer.from([0x04, CRI_TUNNEL, (ia >> 8) & 0xff, ia & 0xff]);
    this.answer(origin, () => control, knxFrame(SVC.CONNECT_RES, Buffer.concat([Buffer.from([id, E_NO_ERROR]), this.responseHpai(origin), crd])));
    this.log(`channel ${id} open ${this.peer(this.channels.get(id)!)} as ${numToIa(ia)}`);
  }

  // ETS 6 opens a local device-management connection ALONGSIDE its tunnel and reads the interface's
  // own interface-object properties over it (its individual address, additional tunnel addresses,
  // medium, capabilities). Refusing it made ETS abort the whole session ("connection type not
  // supported"), so it is accepted as its own channel; the property answers live in propValue().
  private acceptMgmt(control: Endpoint, data: Endpoint, origin: Origin): void {
    let id = 1;
    while (this.channels.has(id) && id < 0xff) id++;
    if (this.channels.has(id)) { this.answer(origin, () => control, knxFrame(SVC.CONNECT_RES, Buffer.from([0x00, E_NO_MORE_CONNECTIONS]))); return; }
    const tcp = origin.kind === "tcp" ? origin.sock : null;
    // ia 0: a device-management channel sends from no tunnel address and must never be counted as
    // holding one (else it would starve the tunnel of the single address ETS also wants).
    this.channels.set(id, { id, mgmt: true, ia: 0, control, data, tcp, txSeq: 0, rxSeq: 0, lastSeen: this.now(), ack: null, queue: Promise.resolve() });
    const crd = Buffer.from([0x02, CRI_DEVICE_MGMT]); // device-management CRD is just its length + type
    this.answer(origin, () => control, knxFrame(SVC.CONNECT_RES, Buffer.concat([Buffer.from([id, E_NO_ERROR]), this.responseHpai(origin), crd])));
    this.log(`device-management channel ${id} open ${tcp ? "over TCP" : `for ${data.address}:${data.port}`}`);
  }

  private onDeviceConfig(body: Buffer, origin: Origin): void {
    const id = body[1], seq = body[2];
    const ch = this.channelFor(id, origin);
    if (!ch || !ch.mgmt) return;
    ch.lastSeen = this.now();
    this.toData(ch, knxFrame(SVC.DEVICE_CONFIG_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR]))); // the config ACK
    const cemi = body.subarray(4);
    if (cemi.length === 0) return; // a config frame with no cEMI carries nothing to act on
    const mc = cemi[0];
    if (mc !== MPR_READ_REQ && mc !== MPR_WRITE_REQ) { this.log(`device-management channel ${id}: ignoring cEMI mc 0x${mc.toString(16)}`); return; }
    const objType = cemi.readUInt16BE(1), objInst = cemi[3], pid = cemi[4];
    const ne = cemi[5] >> 4, startIdx = ((cemi[5] & 0x0f) << 8) | cemi[6];
    if (mc === MPR_WRITE_REQ) {
      // We expose no writable properties; confirm the write as void rather than pretend it took.
      this.log(`device-management channel ${id}: WRITE obj=${objType}/${objInst} PID=${pid} -> refused (void)`);
      this.sendConfig(ch, Buffer.from([MPR_WRITE_CON, (objType >> 8) & 0xff, objType & 0xff, objInst, pid, (startIdx >> 8) & 0x0f, startIdx & 0xff, PROP_ERR_VOID]));
      return;
    }
    const val = this.propValue(objType, objInst, pid, startIdx, ne);
    const head = Buffer.from([MPR_READ_CON, (objType >> 8) & 0xff, objType & 0xff, objInst, pid, 0, 0]);
    if (val) {
      head[5] = (ne << 4) | ((startIdx >> 8) & 0x0f); head[6] = startIdx & 0xff;
      this.log(`device-management channel ${id}: READ obj=${objType}/${objInst} PID=${pid} start=${startIdx} ne=${ne} -> ${val.toString("hex")}`);
      this.sendConfig(ch, Buffer.concat([head, val]));
    } else {
      head[5] = (startIdx >> 8) & 0x0f; head[6] = startIdx & 0xff; // nrOfElem 0 == negative response
      this.log(`device-management channel ${id}: READ obj=${objType}/${objInst} PID=${pid} start=${startIdx} ne=${ne} -> VOID (unknown)`);
      this.sendConfig(ch, Buffer.concat([head, Buffer.from([PROP_ERR_VOID])]));
    }
  }

  // Send one device-configuration response, carrying our own outgoing sequence number.
  private sendConfig(ch: Channel, cemi: Buffer): void {
    const seq = ch.txSeq;
    ch.txSeq = (seq + 1) & 0xff;
    this.toData(ch, knxFrame(SVC.DEVICE_CONFIG_REQ, Buffer.concat([Buffer.from([0x04, ch.id, seq, 0x00]), cemi])));
  }

  // The value of one interface-object property ETS reads over device management, or null for a
  // property we do not model (answered VOID). The two ETS hard-requires (Device Object PID 56 and 83)
  // and the two it needs for a usable tunnel (medium type, additional addresses) all return real
  // data; the rest are polish. Values verified against the thelsing/knx and Calimero property tables.
  private propValue(objType: number, _objInst: number, pid: number, start: number, ne: number): Buffer | null {
    const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
    if (objType === 0) { // Device Object
      if (pid === 56) return u16(this.maxApdu); // PID_MAX_APDULENGTH (required): the path's limit
      if (pid === 83) return u16(0x07b0);       // PID_DEVICE_DESCRIPTOR / mask version (required; any valid mask)
      if (pid === 1) return u16(0);             // PID_OBJECT_TYPE
      if (pid === 11) return Buffer.from(this.serialNumber); // PID_SERIAL_NUMBER (6 B)
      if (pid === 12) return u16(0x00fa);       // PID_MANUFACTURER_ID
    } else if (objType === 8) { // cEMI Server Object
      if (pid === 51) return u16(0x0002);       // PID_MEDIUM_TYPE = TP1 (required; wire code 0x02, NOT thelsing's 0x20)
      if (pid === 52) return Buffer.from([0x00]); // PID_COMM_MODE = Data Link Layer
      if (pid === 64) return u16(0x0001);       // PID_COMM_MODES_SUPPORTED = DLL
    } else if (objType === 11) { // KNXnet/IP Parameter Object
      if (pid === 52) return u16(this.transport.assignedIa || this.addresses[0] || 0); // PID_KNX_INDIVIDUAL_ADDRESS
      if (pid === 53) { // PID_ADDITIONAL_INDIVIDUAL_ADDRESSES: an array; index 0 answers the element count
        if (start === 0) return u16(this.addresses.length);
        const sel = this.addresses.slice(start - 1, ne ? start - 1 + ne : undefined);
        return sel.length ? Buffer.concat(sel.map(u16)) : null; // out-of-range element read -> VOID, not an empty positive

      }
      if (pid === 76) { const n = Buffer.alloc(30); Buffer.from(this.name, "latin1").copy(n); return n; } // PID_FRIENDLY_NAME
    }
    return null;
  }

  // The channel a frame names, if the frame arrived where that channel lives. A TCP channel belongs to
  // its one connection: a frame naming its id from another connection (or over UDP) must neither keep
  // it alive nor close it, and a UDP channel is not reachable from a TCP connection either.
  private channelFor(id: number, origin: Origin): Channel | undefined {
    const ch = this.channels.get(id);
    if (!ch) return undefined;
    if (ch.tcp) return origin.kind === "tcp" && origin.sock === ch.tcp ? ch : undefined;
    return origin.kind === "udp" ? ch : undefined;
  }

  private peer(ch: Channel): string {
    return ch.tcp ? `over TCP from ${ch.tcp.remote ?? "?"}` : `for ${ch.data.address}:${ch.data.port}`;
  }

  private onConnectionState(body: Buffer, origin: Origin): void {
    const id = body[0];
    const ch = this.channelFor(id, origin);
    if (ch) ch.lastSeen = this.now();
    this.answer(origin, () => parseHpai(body, 2, this.originFrom(origin)), knxFrame(SVC.CONNECTIONSTATE_RES, Buffer.from([id, ch ? E_NO_ERROR : E_CONNECTION_ID])));
  }

  private onDisconnect(body: Buffer, origin: Origin): void {
    const id = body[0];
    const ch = this.channelFor(id, origin);
    this.answer(origin, () => parseHpai(body, 2, this.originFrom(origin)), knxFrame(SVC.DISCONNECT_RES, Buffer.from([id, ch ? E_NO_ERROR : E_CONNECTION_ID])));
    if (ch) { this.channels.delete(id); this.log(`channel ${id} closed by the client`); }
  }

  // A client that stops sending CONNECTIONSTATE_REQUESTs is gone (crashed, unplugged, routed away).
  // Its channel holds one of the tunnel addresses, so leaving it open would eventually starve the
  // server of addresses and refuse honest clients. TCP channels included: ETS 6 and Calimero send the
  // heartbeat on the stream, and a client whose FIN never arrived (a network change, a sleeping
  // laptop) leaves a socket that stays ESTABLISHED here indefinitely.
  private reap(): void {
    const cutoff = this.now() - HEARTBEAT_TIMEOUT_MS;
    for (const ch of [...this.channels.values()]) {
      if (ch.lastSeen < cutoff) this.drop(ch, "no connection-state request for 120 s");
    }
    for (const [sock, lastFrame] of this.tcpConns) {
      if (lastFrame >= cutoff || [...this.channels.values()].some((c) => c.tcp === sock)) continue;
      this.tcpConns.delete(sock);
      this.closeTcp(sock);
      this.log("tcp: closed a connection that carried no channel and no frame for 120 s");
    }
  }

  private closeTcp(sock: ServerTcpSocket): void {
    sock.end();
    setTimeout(() => sock.destroy(), this.tcpCloseGraceMs).unref?.();
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
    // The connection carries nothing once its last channel is gone; closing it frees the socket that
    // a vanished peer would otherwise hold open forever.
    const tcp = ch.tcp;
    if (tcp && ![...this.channels.values()].some((c) => c.tcp === tcp)) { this.tcpConns.delete(tcp); this.closeTcp(tcp); }
  }

  // ---- tunnelling: client -> bus ----

  private async onTunnelRequest(body: Buffer, origin: Origin): Promise<void> {
    const id = body[1];
    const seq = body[2];
    const ch = this.channelFor(id, origin);
    if (!ch) return; // no such channel: there is nothing to acknowledge ON
    ch.lastSeen = this.now();

    // The sequence number tells a fresh frame from a retransmission whose ACK got lost — but only
    // over UDP, and only there does dropping the duplicate matter. Over TCP (3/8/4 v2) the stream is
    // reliable and ordered: there is nothing to retransmit and no gap to reject, and ETS in fact
    // leaves the sequence counter at 0 on EVERY frame. Running the UDP duplicate-detection on that
    // would read every frame after the first as a repeat of frame 0 and drop it — acknowledged but
    // never put on the bus — which is exactly what stalls a download after its first telegram. So on
    // TCP: acknowledge and process every frame. (A duplicated memory write is still impossible: TCP
    // does not duplicate, and the device's own connection-oriented TPCI sequence rejects a repeat.)
    if (ch.tcp) {
      this.toData(ch, knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR])));
    } else {
      // Over UDP a repeat of the last frame must be re-acknowledged (or the client keeps repeating)
      // but must NOT be put on the bus twice; anything else is out of order — drop it, do not ACK it.
      const expected = ch.rxSeq;
      const previous = (expected - 1) & 0xff;
      if (seq === previous) { this.toData(ch, knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR]))); return; }
      if (seq !== expected) { this.log(`channel ${id}: dropped a frame out of sequence (got ${seq}, expected ${expected})`); return; }
      this.toData(ch, knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, id, seq, E_NO_ERROR])));
      ch.rxSeq = (expected + 1) & 0xff;
    }

    const cemi = body.subarray(4);
    if (cemi[0] !== CEMI.LDATA_REQ) {
      // The tunnel-layer ACK above is about the datagram, not its content; refusing the content is
      // a separate thing and it is said out loud rather than dropped on the floor.
      this.log(`channel ${id}: refused a cEMI message code 0x${cemi[0].toString(16)}; this server tunnels L_Data.req only`);
      return;
    }

    // A client that sends from 0.0.0 means "you know who I am": that is this channel's address.
    // This is the frame as the client sees it confirmed; the management NAT below may put a
    // different source on the bus, but the client must never see that.
    const clientFrame = cemiSource(cemi) === 0 ? withSource(cemi, ch.ia) : Buffer.from(cemi);

    // Management NAT — the USB single-address limit. A USB interface delivers a connection-oriented
    // point-to-point reply back to the host ONLY when it is addressed to the interface's OWN address.
    // ETS, though, runs a download over a tunnel whose address is NOT the interface's (it keeps a
    // persistent interface tunnel and does the management on a SECOND one), so a device replying to
    // that tunnel's address would be answering into a void the interface never hears, and the download
    // stalls. So a point-to-point frame leaves the bus sourced from the interface's address, and this
    // channel is recorded as the owner of the conversation with the destination device, so routeFromBus
    // can hand the reply — addressed to the interface — back to it. Group and broadcast frames are left
    // untouched: the interface delivers those to every host regardless of address, so they need no NAT.
    const iface = this.transport.assignedIa;
    const p2p = !cemiIsGroup(clientFrame) && cemiDest(clientFrame) !== BROADCAST;
    const nat = p2p && iface !== 0 && cemiSource(clientFrame) !== iface;
    const busFrame = nat ? withSource(clientFrame, iface) : clientFrame;
    if (nat) this.mgmtOwner.set(cemiDest(clientFrame), ch);

    let failed = false;
    try {
      await this.transport.sendCemi(busFrame);
    } catch (e) {
      failed = true;
      this.log(`channel ${id}: the bus did not take the frame: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The L_Data.con is the ONLY way a tunnelling client learns whether its telegram reached the
    // bus. Withholding it on failure would leave the client waiting on a timeout it cannot
    // interpret; sending a clean one would be a lie. So it is sent either way, with the error bit
    // carrying the truth. It echoes the client's OWN frame, not the NAT'd one: the NAT is invisible.
    const con = withMessageCode(clientFrame, CEMI.LDATA_CON);
    // The confirm flag is in ctrl1, which sits AFTER the variable-length additional-info block, so
    // its offset is 2 + the additional-info length, not a fixed 2. Real clients send no additional
    // info (cemi[1] == 0) so the two coincide today, but writing the error bit at a fixed offset
    // would, for any client that does, land it inside the additional-info bytes and hand that
    // client a clean confirmation for a frame that never reached the bus.
    if (failed) con[2 + con[1]] |= CEMI_CON_ERROR;
    void this.toClient(ch, con);

    // The other tunnels are on the same bus and must see this frame, exactly as they would have
    // seen it if the client had been a device. Without this, two Busforge instances sharing the
    // bridge each see only half the conversation. They see what the bus actually carried (the NAT'd
    // source), because that is bus reality — the frame a real device would have observed.
    if (!failed) {
      const ind = withMessageCode(busFrame, CEMI.LDATA_IND);
      for (const other of this.channels.values()) if (other.id !== ch.id && !other.mgmt) void this.toClient(other, ind);
    }
  }

  // ---- tunnelling: bus -> client ----

  // A cEMI frame the interface received from the bus, on its way to the tunnelling clients. Group and
  // broadcast traffic goes to every tunnel verbatim (the whole point of a multiplexing server). The
  // exception is a point-to-point reply addressed to the interface's OWN address: that is the answer
  // to a frame the management NAT sent on a client's behalf (see onTunnelRequest), it belongs to
  // exactly one channel — the one managing that device — and is delivered only there, with the
  // destination rewritten back to that channel's tunnel address so the client sees a reply addressed
  // to itself, as a normal interface would present it. If no live channel owns the conversation (a
  // stray reply, or the owner has since closed), it falls through to the ordinary fan-out, never dropped.
  private routeFromBus(cemi: Buffer): void {
    const iface = this.transport.assignedIa;
    const p = 2 + (cemi[1] ?? 0);
    if (iface !== 0 && cemi.length >= p + 6 && !cemiIsGroup(cemi) && cemiDest(cemi) === iface) {
      const owner = this.mgmtOwner.get(cemiSource(cemi));
      if (owner && !owner.mgmt && this.channels.get(owner.id) === owner) {
        // Deliberately to the owner ALONE, not fanned out: a connection-oriented management reply
        // belongs to the one conversation that asked for it. This is the point-to-point counterpart
        // of the group fan-out in onTunnelRequest — a passive monitor watches group traffic, and has
        // no place in someone else's download. Rewrite the destination from the interface back to the
        // owner's tunnel address so the client sees a reply addressed to itself, as a normal interface
        // would present it.
        void this.toClient(owner, withDest(cemi, owner.ia));
        return;
      }
    }
    for (const ch of this.channels.values()) if (!ch.mgmt) void this.toClient(ch, cemi);
  }

  private toClient(ch: Channel, cemi: Buffer): Promise<void> {
    // Over TCP the transport is reliable: 3/8/4 v2 sends a tunnelling request WITHOUT waiting for a
    // TUNNELLING_ACK, and the client (ETS) does not send one. Running the UDP ack-and-retransmit loop
    // below on a TCP channel would therefore drop every TCP client the instant the first bus telegram
    // reached it (it never acks), which is exactly the "acknowledged neither the frame nor its
    // repetition" drop ETS was hitting. So on TCP: send once, advance the sequence, done.
    if (ch.tcp) {
      ch.queue = ch.queue.then(() => {
        if (this.channels.get(ch.id) !== ch) return;
        const seq = ch.txSeq;
        ch.txSeq = (seq + 1) & 0xff;
        this.toData(ch, knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, ch.id, seq, 0x00]), cemi])));
      }).catch((e: unknown) => this.log(`channel ${ch.id}: send failed: ${e instanceof Error ? e.message : String(e)}`));
      return ch.queue;
    }
    // Serialised per channel: KNXnet/IP over UDP allows exactly one unacknowledged tunnelling frame
    // per connection, so a second send must wait rather than race the first one's ACK.
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

  private onTunnelAck(body: Buffer, origin: Origin): void {
    const ch = this.channelFor(body[1], origin);
    if (!ch) return;
    ch.lastSeen = this.now();
    if (ch.ack && ch.ack.seq === body[2]) ch.ack.resolve();
  }
}
