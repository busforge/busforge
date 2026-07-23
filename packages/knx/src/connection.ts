import dgram from "node:dgram";
import net from "node:net";
import { SVC, knxFrame, hpai, hpaiTcp, KNXPORT, CEMI, KnxIpStreamParser } from "./frame.ts";
import { parseCemiLData, type KnxTransport } from "./transport.ts";
import { KnxError } from "./errors.ts";

// 3/8/2 §5.4: a tunnelling client sends a CONNECTIONSTATE_REQUEST every 60 s and expects a
// CONNECTIONSTATE_RESPONSE within 10 s, repeating up to three times before it must consider the
// connection dead. Without this, a read-only monitor on a quiet bus (nothing to tunnel for
// minutes) is reaped by a spec-strict gateway (busforge's own bridge drops a channel it has not
// heard from for 120 s), and from then on every "connected" is a lie while the telegram log
// silently records nothing.
const HEARTBEAT_INTERVAL_MS = 60_000;
const CONNECTIONSTATE_TIMEOUT_MS = 10_000;
const CONNECTIONSTATE_TRIES = 3;

// Minimal surface of dgram.Socket the tunnel uses; injectable for offline tests.
export interface TunnelSocket {
  bind(port: number, cb: () => void): void;
  on(ev: "message", cb: (m: Buffer) => void): void;
  // The socket's asynchronous error channel. On Linux a UDP datagram sent to a port with nothing
  // listening comes back as an ECONNREFUSED here (the kernel surfaces the ICMP port-unreachable);
  // without a listener Node/Bun rethrows it as an uncaught exception. dgram.Socket already overloads
  // on() for this, so the real socket satisfies it for free.
  on(ev: "error", cb: (e: Error) => void): void;
  // The callback carries node's send error (null on success). It must not be dropped:
  // a UDP send can fail on the local host before anything reaches the wire.
  send(buf: Buffer, port: number, ip: string, cb: (err: Error | null) => void): void;
  close(): void;
}

// Minimal surface of a TCP connection the tunnel uses in TCP mode; injectable for offline tests.
// A KNXnet/IP tunnel over TCP is one connection carrying one channel (3/8/2), so this is a single
// stream, not a datagram socket: write() puts one framed KNXnet/IP frame on the wire, onData()
// delivers raw stream bytes (which the tunnel reassembles into frames), onClose() fires when the
// connection ends.
export interface TcpSocket {
  connect(port: number, ip: string, onConnect: () => void, onError: (e: Error) => void): void;
  write(frame: Buffer): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  end(): void;
}

function realTcpSocket(): TcpSocket {
  const s = new net.Socket();
  return {
    // One PERSISTENT error listener: it rejects the connect while still connecting, then becomes a
    // no-op. A one-shot listener would be consumed by the connect error and leave a later error (a
    // post-connect ECONNRESET before the close event) with no handler, i.e. an uncaught exception.
    connect: (port, ip, onConnect, onError) => {
      let connecting = true;
      s.on("error", (e) => { if (connecting) onError(e); });
      s.connect(port, ip, () => { connecting = false; onConnect(); });
    },
    write: (frame) => { s.write(frame); },
    onData: (cb) => { s.on("data", cb); },
    onClose: (cb) => { s.on("close", cb); },
    end: () => { s.end(); },
  };
}

// KNXnet/IP tunnelling connection. Handles the KNXnet/IP layer (connect,
// tunnelling request/ack both directions) and surfaces incoming cEMI L_Data
// (source IA + raw TPDU) to a listener. The connection-oriented KNX transport
// lives one layer up in KnxDevice.
export class KnxIpTunnel implements KnxTransport {
  private sock!: TunnelSocket;
  // Set only in TCP mode; the connection that both carries the channel and is its liveness.
  private tcpSock!: TcpSocket;
  private mode: "udp" | "tcp" = "udp";
  private createTcpSocket: () => TcpSocket = realTcpSocket;
  channel = 0;
  assignedIa = 0;
  private txSeq = 0;
  private ackWaiter: { seq: number; resolve: () => void } | null = null;
  // Per-send wait for a tunnelling ACK; an instance field so a test can shorten the 1.5 s default.
  private ackTimeoutMs = 1500;
  // Set the moment teardown begins. A datagram that lands between DISCONNECT_REQ and the socket
  // actually closing must not be answered: the ACK would be written into a socket that is gone, and
  // the channel it would ACK on no longer exists. Without it, every ordinary disconnect logged a
  // failure ("null is not an object (evaluating 'kStateSymbol')", node's dgram internals on a closed
  // handle) that was not one.
  private closed = false;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onRawCemi: ((cemi: Buffer) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  // The periodic connection-state heartbeat, running only while the tunnel is up.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Resolves the in-flight heartbeat's wait for its CONNECTIONSTATE_RESPONSE (true = channel alive).
  private stateWaiter: ((ok: boolean) => void) | null = null;
  // Per-attempt timeout for a CONNECTIONSTATE_RESPONSE; an instance field so a test can shorten it.
  private stateTimeoutMs = CONNECTIONSTATE_TIMEOUT_MS;

  // createSocket is a test seam; the default is the real UDP socket as before.
  constructor(
    private ifaceIp: string,
    private port = KNXPORT,
    private readonly createSocket: () => TunnelSocket = () => dgram.createSocket("udp4"),
  ) {}

  // Standard KNXnet/IP Tunnelling over TCP (KNXnet/IP Core v2). A separate constructor so the UDP
  // path above stays byte-for-byte as it was; the caller picks the transport by which one it calls.
  // createTcpSocket is the TCP test seam, mirroring createSocket for UDP.
  static tcp(ip: string, port = KNXPORT, createTcpSocket: () => TcpSocket = realTcpSocket): KnxIpTunnel {
    const t = new KnxIpTunnel(ip, port);
    t.mode = "tcp";
    t.createTcpSocket = createTcpSocket;
    return t;
  }

  // UDP promises no delivery, but a send can still fail hard on the local host before
  // anything reaches the wire. The non-obvious case a user actually hits: macOS denies
  // "Local Network" access to an unentitled binary (TCC) and the kernel answers every
  // send with EHOSTUNREACH. Ignoring the callback's error resolved the promise anyway,
  // and the caller later died as a featureless TUNNEL_CONNECT_TIMEOUT.
  private send(buf: Buffer) {
    if (this.mode === "tcp") {
      // A TCP write can still fail synchronously (the connection went away between frames); it is a
      // coded error, exactly as a failed UDP send is, so a caller never sees it as a bare timeout.
      return new Promise<void>((resolve, reject) => {
        try { this.tcpSock.write(buf); resolve(); }
        catch (e) { reject(new KnxError("TUNNEL_SEND_FAILED", `TCP write to ${this.ifaceIp}:${this.port} failed: ${e instanceof Error ? e.message : String(e)}`)); }
      });
    }
    return new Promise<void>((resolve, reject) => {
      this.sock.send(buf, this.port, this.ifaceIp, (err) => {
        if (err) reject(new KnxError("TUNNEL_SEND_FAILED", `UDP send to ${this.ifaceIp}:${this.port} failed: ${err.message}`));
        else resolve();
      });
    });
  }

  private closeSocket() {
    if (this.mode === "tcp") this.tcpSock?.end();
    else this.sock?.close();
  }

  async connect(): Promise<void> {
    if (this.mode === "tcp") return this.connectTcp();
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
    // A UDP socket has an asynchronous error channel that MUST be handled or Node/Bun rethrows it as
    // an uncaught exception. The case that bites: on Linux (a CI container, or any Linux host) a
    // CONNECT_REQ sent to a gateway IP with nothing listening draws an ICMP port-unreachable, which
    // the kernel delivers back as an ECONNREFUSED on the next receive. macOS never surfaces it, so a
    // dead gateway there just times out — which is why this stayed hidden until it ran on Linux. Route
    // it like any bus-connect fault: while connecting, fail the connect at once with a coded error;
    // once the tunnel is up, report it as a closure rather than crash the process.
    this.sock.on("error", (e) => {
      if (this.closed) return; // a late error during teardown is expected, not a failure
      if (this.connectResWaiter) this.connectResWaiter.reject(new KnxError("TUNNEL_CONNECT_FAILED", `connect to ${this.ifaceIp}:${this.port} failed: ${e.message}`));
      else this.onClosed?.(`the bus connection reported an error: ${e.message}`);
    });

    // Advertise a NAT-mode HPAI (0.0.0.0:0) so the gateway replies to the
    // observed packet source instead of an address we name. Required behind NAT
    // (e.g. the server in a Docker bridge network, where our real local address
    // is an unroutable 172.x/192.168.x container IP); on a flat LAN the packet
    // source is our real address anyway, so this works in both cases.
    const nat = hpai("0.0.0.0", 0);
    const body = Buffer.concat([nat, nat, Buffer.from([0x04, 0x04, 0x02, 0x00])]);
    const done = this.once((m) => m.readUInt16BE(2) === SVC.CONNECT_RES, 4000, "connect");
    try {
      await this.send(knxFrame(SVC.CONNECT_REQ, body));
    } catch (e) {
      // The request never left this host, so no CONNECT_RES can ever answer the waiter.
      // Defuse its pending 4 s timeout: the send failure is the error the caller must
      // see, not a later TUNNEL_CONNECT_TIMEOUT rejecting into nowhere.
      done.catch(() => {});
      this.connectResWaiter = null;
      throw e;
    }
    const res = await done;
    this.applyConnectRes(res);

    // Prove the channel is still alive every 60 s. Unreffed so it never keeps the process alive on
    // its own (the HTTP server does that in production; tests must be free to exit).
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private applyConnectRes(res: Buffer) {
    const b = res.subarray(6);
    if (b[1] !== 0) throw new KnxError("TUNNEL_CONNECT_REJECTED", `connect status 0x${b[1].toString(16)}`);
    this.channel = b[0]!;
    this.assignedIa = b.readUInt16BE(2 + 8 + 2); // channel/status + HPAI(8) + CRD type/len(2)
  }

  // The TCP counterpart of connect(). The frame HANDLING (onMessage) is transport-agnostic and is
  // shared verbatim; only the wire (a byte stream reassembled into frames), the HPAIs (TCP protocol
  // code, §5.2.1), and the absence of a heartbeat (3/8/2 v2: the CONNECTIONSTATE procedure is not
  // used on TCP) differ from the UDP path.
  private async connectTcp(): Promise<void> {
    this.tcpSock = this.createTcpSocket();
    this.closed = false;
    // Open the connection first. A refused or unreachable TCP connect is a coded error naming the
    // cause, not the bare CONNECT timeout a silent UDP gateway would surface.
    await new Promise<void>((resolve, reject) => {
      this.tcpSock.connect(this.port, this.ifaceIp, resolve,
        (e) => reject(new KnxError("TUNNEL_CONNECT_FAILED", `TCP connect to ${this.ifaceIp}:${this.port} failed: ${e.message}`)));
    });

    // A byte stream: reassemble it into whole frames and feed each through the SAME dispatch the UDP
    // path uses. A stream that cannot be kept in frame has no safe resync point, so the connection is
    // reaped rather than guessed at.
    const parser = new KnxIpStreamParser();
    this.tcpSock.onData((chunk) => {
      let frames: Buffer[];
      try { frames = parser.push(chunk); }
      catch (e) { this.reap(`the TCP stream desynchronised: ${e instanceof Error ? e.message : String(e)}`); return; }
      for (const m of frames) {
        void this.onMessage(m).catch((err: unknown) => {
          if (this.closed) return; // a frame lost to teardown is not a failure, it is the teardown
          console.error(`KNX/IP: dropped a frame: ${err instanceof Error ? err.message : "unknown error"}`);
        });
      }
    });
    // TCP guarantees the socket, not the peer: when the connection drops, so does the channel.
    this.tcpSock.onClose(() => { this.reap("the TCP connection to the gateway closed"); });

    // On a TCP connection the HPAIs carry protocol code 0x02 and a zero address/port: the connection
    // is the endpoint, so there is nothing to name (contrast the UDP path's NAT-mode 0.0.0.0:0 HPAI,
    // which is protocol code 0x01 and means "answer wherever this datagram came from").
    const tcp = hpaiTcp();
    const body = Buffer.concat([tcp, tcp, Buffer.from([0x04, 0x04, 0x02, 0x00])]);
    const done = this.once((m) => m.readUInt16BE(2) === SVC.CONNECT_RES, 4000, "connect");
    // Everything past the accepted TCP socket can still fail (send error, no CONNECT_RESPONSE within
    // 4 s, a reject status in it). On any of those the socket is up with its listeners registered, so
    // close it rather than leak the fd until the peer eventually drops it.
    try {
      try {
        await this.send(knxFrame(SVC.CONNECT_REQ, body));
      } catch (e) {
        done.catch(() => {});
        this.connectResWaiter = null;
        throw e;
      }
      const res = await done;
      this.applyConnectRes(res);
    } catch (e) {
      this.closeSocket();
      throw e;
    }
    // No heartbeat timer is armed: on TCP the socket's own liveness stands in for CONNECTIONSTATE.
  }

  // One heartbeat round: a CONNECTIONSTATE_REQUEST and its answer, retried per the spec, and if the
  // gateway answers none of them the tunnel is brought down honestly rather than left looking alive.
  private async heartbeat(): Promise<void> {
    for (let i = 0; i < CONNECTIONSTATE_TRIES; i++) {
      if (this.closed) return;
      const answered = new Promise<boolean>((resolve) => {
        this.stateWaiter = resolve;
        setTimeout(() => { if (this.stateWaiter === resolve) { this.stateWaiter = null; resolve(false); } }, this.stateTimeoutMs);
      });
      // A NAT-mode control HPAI, exactly as the CONNECT_REQ sent: answer wherever this packet came from.
      try { await this.send(knxFrame(SVC.CONNECTIONSTATE_REQ, Buffer.concat([Buffer.from([this.channel, 0x00]), hpai("0.0.0.0", 0)]))); }
      catch { /* socket gone: the missing answer below is treated as the failure it is */ }
      if (await answered) return; // a positive CONNECTIONSTATE_RESPONSE: the channel is alive
    }
    this.reap("the gateway did not answer three connection-state requests; the tunnel is considered dead");
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.stateWaiter) { const w = this.stateWaiter; this.stateWaiter = null; w(false); }
  }

  // The tunnel was up and has gone down without us asking (a DISCONNECT_REQUEST from the gateway, or
  // a heartbeat it stopped answering). Close the socket and tell the layer above: a status of
  // "connected" must not outlive the channel it describes. Distinct from disconnect(), which is the
  // caller's own teardown and does not notify.
  private reap(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.closeSocket();
    this.onClosed?.(reason);
  }

  private connectResWaiter: { match: (m: Buffer) => boolean; resolve: (m: Buffer) => void; reject: (e: Error) => void } | null = null;
  // Only used for the CONNECT_RES waiter: a timeout here means the gateway never answered
  // the connect request (offline, wrong IP, or blocked), the most common bus-connect failure
  // and fully user-actionable, so it gets a coded error like the reject/ack-timeout paths. `reject`
  // lets a hard socket error (a Linux ECONNREFUSED) fail the connect at once instead of waiting the
  // full timeout out into a featureless TUNNEL_CONNECT_TIMEOUT.
  private once(match: (m: Buffer) => boolean, ms: number, what: string) {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => { this.connectResWaiter = null; reject(new KnxError("TUNNEL_CONNECT_TIMEOUT", `${what} timeout`)); }, ms);
      const clear = () => { clearTimeout(timer); this.connectResWaiter = null; };
      this.connectResWaiter = { match, resolve: (m) => { clear(); resolve(m); }, reject: (e) => { clear(); reject(e); } };
    });
  }

  private async onMessage(m: Buffer) {
    if (this.closed) return; // teardown: there is no channel left to answer on
    const svc = m.readUInt16BE(2);
    const body = m.subarray(6);
    if (this.connectResWaiter?.match(m)) { this.connectResWaiter.resolve(m); return; }
    if (svc === SVC.CONNECTIONSTATE_RES) {
      // The answer to our heartbeat: body = [channel, status]. Status 0 means the channel is alive.
      if (this.stateWaiter && body[0] === this.channel) { const w = this.stateWaiter; this.stateWaiter = null; w(body[1] === 0); }
    } else if (svc === SVC.DISCONNECT_REQ) {
      // The gateway is closing the channel (its own 120 s timeout, a reboot, an operator action).
      // Answer so it stops retransmitting, then surface the closure rather than keep a dead channel
      // looking alive. The answer is best-effort: the channel is closing whether or not it lands.
      try { await this.send(knxFrame(SVC.DISCONNECT_RES, Buffer.from([this.channel, 0x00]))); } catch { /* the gateway may already be gone */ }
      this.reap("the gateway sent a DISCONNECT_REQUEST; the tunnel is closed");
    } else if (svc === SVC.TUNNEL_ACK) {
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

  // KNXnet/IP-layer send of a cEMI with tunnelling ack. Over UDP the request is retransmitted on an
  // ACK timeout (up to `tries`, the spec's recovery for a lost datagram). Over TCP it is sent EXACTLY
  // once regardless of `tries`: TCP already guarantees order and delivery, so a retransmission could
  // only duplicate a memory write, which is precisely the damage this project exists to prevent. A
  // missing ACK is then a hard TUNNEL_ACK_TIMEOUT, not a reason to resend.
  async sendCemi(cemi: Buffer, tries = 3): Promise<void> {
    const attempts = this.mode === "tcp" ? 1 : tries;
    for (let i = 0; i < attempts; i++) {
      const seq = this.txSeq;
      const frame = knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, this.channel, seq, 0x00]), cemi]));
      const ack = new Promise<boolean>((resolve) => { this.ackWaiter = { seq, resolve: () => resolve(true) }; setTimeout(() => resolve(false), this.ackTimeoutMs); });
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
    this.stopHeartbeat();
    const controlHpai = this.mode === "tcp" ? hpaiTcp() : hpai("0.0.0.0", 0);
    try { await this.send(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([this.channel, 0x00]), controlHpai]))); } catch { /* teardown: the gateway may be gone; the channel is closed either way */ }
    this.closeSocket();
  }
}
