import dgram from "node:dgram";
import net from "node:net";
import { SVC, knxFrame, hpai, hpaiTcp, KNXPORT, CEMI, KnxIpStreamParser } from "./frame.ts";
import { parseCemiLData, type KnxTransport } from "./transport.ts";
import { extendedDeviceMaxApdu, descriptionDeviceInfo } from "./discover.ts";
import { KnxError } from "./errors.ts";

// 3/8/2 §5.4: a tunnelling client sends a CONNECTIONSTATE_REQUEST every 60 s and expects a
// CONNECTIONSTATE_RESPONSE within 10 s, repeating up to three times before it must consider the
// connection dead. Without this, a read-only monitor on a quiet bus (nothing to tunnel for
// minutes) is reaped by a spec-strict gateway (busforge's own bridge drops a channel it has not
// heard from for 120 s), and from then on every "connected" is a lie while the telegram log
// silently records nothing. This holds over TCP as well: ETS 6 and Calimero send the heartbeat on
// the stream, and a TCP peer that vanished without a FIN leaves a socket that looks open.
const HEARTBEAT_INTERVAL_MS = 60_000;
const CONNECTIONSTATE_TIMEOUT_MS = 10_000;
const CONNECTIONSTATE_TRIES = 3;

// Bun (1.3) reports every TCP connect that fails at once as ECONNREFUSED: a host with no route, macOS
// denying the process Local Network access, and an exhausted descriptor table all look like a refusal
// (Node reports EHOSTUNREACH or EMFILE for the same connects). Passing Bun's code on as the cause sent
// a debugging session to the gateway, which was listening all along.
const ON_BUN = typeof process !== "undefined" && !!process.versions?.bun;
function connectErrorCaveat(e: Error): string {
  return ON_BUN && (e as NodeJS.ErrnoException).code === "ECONNREFUSED"
    ? " (the Bun runtime cannot tell a refusal from an unreachable host or a denied macOS Local Network access; if the gateway is listening, restart the server process)"
    : "";
}

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
    // end() on a socket still connecting would only queue the FIN behind a connect the kernel keeps
    // retrying; a connect given up is torn down at once.
    end: () => { if (s.connecting) s.destroy(); else s.end(); },
  };
}

// KNXnet/IP tunnelling connection. Handles the KNXnet/IP layer (connect, tunnelling
// requests both directions, acknowledged over UDP only) and surfaces incoming cEMI L_Data
// (source IA + raw TPDU) to a listener. The connection-oriented KNX transport
// lives one layer up in KnxDevice.
// `probe`: once the confirmation is overdue, the number of the connection-state request whose answer
// shows the interface has read the frame (see awaitCon).
type ConWaiter = { key: string; promise: Promise<void>; resolve: () => void; reject: (e: Error) => void; probe?: number; grace?: ReturnType<typeof setTimeout>; cap?: ReturnType<typeof setTimeout> };

export class KnxIpTunnel implements KnxTransport {
  private sock!: TunnelSocket;
  // Set only in TCP mode; the connection that carries the channel.
  private tcpSock!: TcpSocket;
  private mode: "udp" | "tcp" = "udp";
  private createTcpSocket: () => TcpSocket = realTcpSocket;
  // How long a TCP connect waits for the interface to accept it: the KNXnet/IP CONNECT_REQUEST_TIMEOUT
  // (10 s); an instance field so a test can shorten it.
  private tcpConnectTimeoutMs = 10_000;
  channel = 0;
  assignedIa = 0;
  // How long queryMaxApdu and queryDeviceInfo wait for their answer; an instance field so a test can shorten it.
  private searchTimeoutMs = 1000;
  private txSeq = 0;
  // Counts connects: a heartbeat loop of an earlier channel stops once a later connect began.
  private generation = 0;
  private ackWaiter: { seq: number; resolve: () => void } | null = null;
  // Every UDP send still waiting for its ACK (a T_ACK can go out beside a request), so a closing
  // channel releases all of them, not only the one ackWaiter matches.
  private ackReleases = new Set<() => void>();
  // Per-send wait for a tunnelling ACK over UDP; an instance field so a test can shorten it.
  private ackTimeoutMs = 1500;
  // TCP: the sends waiting for the gateway's L_Data.con, oldest first, and how long each waits before
  // the link is asked whether it still carries anything (an instance field so a test can shorten it):
  // the 3 s a cEMI client waits for a confirmation (KNX 3/6/3 §4.1.5.1, a recommendation). Over TCP
  // the confirmation is the only sign that a frame left the gateway; a stream that stalls (lost
  // segments in retransmission back-off, a Wi-Fi roam) otherwise looks exactly like a device that
  // stopped answering.
  private conWaiters: ConWaiter[] = [];
  private conTimeoutMs = 3000;
  // TCP: the connection-state requests written on this channel and the answers read back, counted. The
  // interface reads the stream in order and answers each request, so the answer to request n shows it
  // has read every frame written before request n.
  private stateSent = 0;
  private stateAnswered = 0;
  private heartbeatRunning = false;
  // Set by a confirmation that settled a send, for the TCP reader (connectTcp).
  private settledCon = false;
  // Frames whose confirmation timed out: a confirmation that turns up later is theirs, never the
  // confirmation of an identical frame sent after them (a repeated request, a repeated group write).
  private lateCons: string[] = [];
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

  // The socket a teardown began on: a reconnect while the teardown still awaits its DISCONNECT_REQ
  // has replaced this.sock, and the new one must stay open.
  private currentSocket(): { close: () => void } | undefined {
    if (this.mode === "tcp") { const t = this.tcpSock; return t && { close: () => t.end() }; }
    return this.sock;
  }
  private closeSocket(sock = this.currentSocket()) {
    sock?.close();
  }
  // A send waiting for its tunnelling ACK on a channel that is closing gets none; it goes back to its
  // loop at once, which then fails as TUNNEL_CLOSED.
  private releaseAck() {
    this.ackWaiter = null;
    const pending = [...this.ackReleases]; this.ackReleases.clear();
    for (const release of pending) release();
  }

  // Each connect opens a new channel: its sequence counter starts at 0, and the events of a socket
  // an earlier connect left behind (a late close or error after the gateway dropped the tunnel) are
  // ignored, so they cannot tear down the channel that replaced it.
  async connect(): Promise<void> {
    this.txSeq = 0;
    this.generation++;
    this.stopHeartbeat();
    this.stateSent = 0;
    this.stateAnswered = 0;
    if (this.mode === "tcp") return this.connectTcp();
    const sock = this.sock = this.createSocket();
    // Open from here on, so a disconnect while the socket binds closes it.
    this.closed = false;
    await new Promise<void>((r) => this.sock.bind(0, () => r()));
    if (this.closed || sock !== this.sock) throw new KnxError("TUNNEL_CLOSED", "the tunnel was closed while it was connecting");
    // The socket callback wants void, so handing it the async handler dropped the promise: a
    // rejection inside (a failed TUNNEL_ACK send) escaped as an unhandled rejection with no clue
    // where it came from. Failing to answer ONE datagram is recoverable — the gateway retransmits —
    // so the tunnel stays up, but it is reported rather than swallowed.
    sock.on("message", (m) => {
      if (sock !== this.sock) return;
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
    sock.on("error", (e) => {
      if (this.closed || sock !== this.sock) return; // a late error during teardown is expected, not a failure
      if (this.connectResWaiter) this.connectResWaiter.reject(new KnxError("TUNNEL_CONNECT_FAILED", `connect to ${this.ifaceIp}:${this.port} failed: ${e.message}`));
      else this.onClosed?.(`the bus connection reported an error: ${e.message}`);
    });

    // Advertise a NAT-mode HPAI (0.0.0.0:0) so the gateway replies to the
    // observed packet source instead of an address we name. Required behind NAT
    // (e.g. the server in a Docker bridge network, where our real local address
    // is an unroutable private container IP); on a flat LAN the packet
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
    // 0x27 E_KNX_CONNECTION: the gateway is up but has no connection to the bus (the bridge says so
    // while its USB stick is gone). Busy (0x24) and the rest stay a plain refusal.
    if (b[1] === 0x27) throw new KnxError("TUNNEL_INTERFACE_UNAVAILABLE", "the KNXnet/IP server has no connection to the KNX bus (connect status 0x27)");
    if (b[1] !== 0) throw new KnxError("TUNNEL_CONNECT_REJECTED", `connect status 0x${b[1].toString(16)}`);
    this.channel = b[0]!;
    this.assignedIa = b.readUInt16BE(2 + 8 + 2); // channel/status + HPAI(8) + CRD type/len(2)
  }

  // The TCP counterpart of connect(). The frame HANDLING (onMessage) is transport-agnostic and is
  // shared verbatim; only the wire (a byte stream reassembled into frames) and the HPAIs (TCP
  // protocol code, §5.2.1) differ from the UDP path.
  private async connectTcp(): Promise<void> {
    const sock = this.tcpSock = this.createTcpSocket();
    this.closed = false;
    // Open the connection first. A refused or unreachable TCP connect is a coded error, not the bare
    // CONNECT timeout a silent UDP gateway would surface.
    // A SYN nothing answers is retried by the kernel for minutes (about 75 s on macOS, over two minutes
    // on Linux) before the connect fails, so the connect gives up on its own after the KNXnet/IP
    // CONNECT_REQUEST_TIMEOUT. Its error is the same unreachable signal a refused connect gives.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.end();
        reject(new KnxError("TUNNEL_CONNECT_FAILED", `TCP connect to ${this.ifaceIp}:${this.port} got no answer within ${this.tcpConnectTimeoutMs / 1000} s: no host there, or a firewall drops it`));
      }, this.tcpConnectTimeoutMs);
      const failed = (e: Error) => { clearTimeout(timer); reject(new KnxError("TUNNEL_CONNECT_FAILED", `TCP connect to ${this.ifaceIp}:${this.port} failed: ${e.message}${connectErrorCaveat(e)}`)); };
      try { this.tcpSock.connect(this.port, this.ifaceIp, () => { clearTimeout(timer); resolve(); }, failed); }
      catch (e) { failed(e instanceof Error ? e : new Error(String(e))); }
    });

    // A byte stream: reassemble it into whole frames and feed each through the SAME dispatch the UDP
    // path uses. A stream that cannot be kept in frame has no safe resync point, so the connection is
    // reaped rather than guessed at.
    // A frame read behind a confirmation in the same chunk waits for the next turn of the event loop,
    // so the send that confirmation settles carries on before it: one stalled stream delivers the
    // device's T_Disconnect, our frame's confirmation and the device's next frame in one burst, and
    // the device layer tells by their order whether the device closed the connection before our
    // frame reached it.
    const parser = new KnxIpStreamParser();
    const pending: Buffer[] = [];
    let draining = false;
    const drain = () => {
      draining = false;
      while (pending.length > 0) {
        if (sock !== this.tcpSock) { pending.length = 0; return; }
        this.settledCon = false;
        void this.onMessage(pending.shift()!).catch((err: unknown) => {
          if (this.closed) return; // a frame lost to teardown is not a failure, it is the teardown
          console.error(`KNX/IP: dropped a frame: ${err instanceof Error ? err.message : "unknown error"}`);
        });
        if (this.settledCon && pending.length > 0) { draining = true; setTimeout(drain, 0); return; }
      }
    };
    sock.onData((chunk) => {
      if (sock !== this.tcpSock) return;
      let frames: Buffer[];
      try { frames = parser.push(chunk); }
      catch (e) { this.reap(`the TCP stream desynchronised: ${e instanceof Error ? e.message : String(e)}`); return; }
      pending.push(...frames);
      if (!draining) drain();
    });
    // TCP guarantees the socket, not the peer: when the connection drops, so does the channel.
    sock.onClose(() => { if (sock === this.tcpSock) this.reap("the TCP connection to the gateway closed"); });

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
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  // One heartbeat round: a CONNECTIONSTATE_REQUEST and its answer, retried per the spec, and if the
  // gateway answers none of them the tunnel is brought down honestly rather than left looking alive.
  // Also started early by a confirmation that is overdue (awaitCon), so one round at a time.
  private async heartbeat(): Promise<void> {
    if (this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    const generation = this.generation;
    try {
      for (let i = 0; i < CONNECTIONSTATE_TRIES; i++) {
        if (this.closed || generation !== this.generation) return;
        const answered = new Promise<boolean>((resolve) => {
          this.stateWaiter = resolve;
          setTimeout(() => { if (this.stateWaiter === resolve) { this.stateWaiter = null; resolve(false); } }, this.stateTimeoutMs).unref?.();
        });
        await this.sendStateRequest();
        if (await answered) return; // a positive CONNECTIONSTATE_RESPONSE: the channel is alive
      }
      if (generation === this.generation) this.reap("the gateway did not answer three connection-state requests; the tunnel is considered dead");
    } finally { this.heartbeatRunning = false; }
  }

  private async sendStateRequest(): Promise<void> {
    // The control HPAI exactly as the CONNECT_REQ sent it: NAT mode on UDP, the zero IPV4_TCP HPAI on TCP.
    const controlHpai = this.mode === "tcp" ? hpaiTcp() : hpai("0.0.0.0", 0);
    try { await this.send(knxFrame(SVC.CONNECTIONSTATE_REQ, Buffer.concat([Buffer.from([this.channel, 0x00]), controlHpai]))); this.stateSent++; }
    catch { /* socket gone: the missing answer is treated as the failure it is */ }
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
    this.failCons(new KnxError("TUNNEL_CLOSED", `the tunnel closed before the gateway confirmed the frame: ${reason}`));
    this.releaseAck();
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
  // The interface's maximum APDU, asked as ETS 6 asks it: a SEARCH_REQUEST_EXTENDED on this connection's own
  // endpoint (the TCP stream, or the tunnel's UDP socket with a NAT-mode HPAI), its search-request parameter
  // asking for the DIBs 01 02 08 06 (ETS's request over TCP: `0610020b0014 0802000000000000 060401020806`),
  // and from the answer the Extended Device Information DIB (an MDT IP Interface/Router announces 210). Null
  // where no answer comes within `searchTimeoutMs` or it carries no such DIB.
  async queryMaxApdu(): Promise<number | null> {
    const body = await this.ask(SVC.SEARCH_RES_EXT, (endpoint) => knxFrame(SVC.SEARCH_REQ_EXT, Buffer.concat([endpoint, Buffer.from([0x06, 0x04, 0x01, 0x02, 0x08, 0x06])])));
    return body ? extendedDeviceMaxApdu(body) : null;
  }

  // The interface's own individual address and serial number, from the Device Information DIB of its
  // DESCRIPTION_RESPONSE on this connection's own endpoint (as ETS asks it over TCP): which interface
  // this connection runs through. Null where no answer comes within `searchTimeoutMs` or it carries no
  // such DIB.
  async queryDeviceInfo(): Promise<{ ia: number; serial: string } | null> {
    const body = await this.ask(SVC.DESCRIPTION_RES, (endpoint) => knxFrame(SVC.DESCRIPTION_REQ, endpoint));
    return body ? descriptionDeviceInfo(body) : null;
  }

  // Send a request carrying this connection's own endpoint (the TCP stream, or the tunnel's UDP socket
  // with a NAT-mode HPAI) and return the body of the answer of service `res`, or null within `searchTimeoutMs`.
  private async ask(res: number, request: (endpoint: Buffer) => Buffer): Promise<Buffer | null> {
    if (this.closed) return null;
    const answer = this.once((m) => m.length >= 6 && m.readUInt16BE(2) === res, this.searchTimeoutMs, "search");
    const endpoint = this.mode === "tcp" ? hpaiTcp() : hpai("0.0.0.0", 0);
    try { await this.send(request(endpoint)); }
    catch (e) { answer.catch(() => {}); this.connectResWaiter = null; throw e; }
    try { return (await answer).subarray(6); } catch { return null; }
  }

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
      if (body[0] === this.channel) {
        this.stateAnswered++;
        if (this.stateWaiter) { const w = this.stateWaiter; this.stateWaiter = null; w(body[1] === 0); }
        this.interfaceReadUpTo();
      }
    } else if (svc === SVC.DISCONNECT_REQ) {
      // The gateway is closing the channel (its own 120 s timeout, a reboot, an operator action).
      // Answer so it stops retransmitting, then surface the closure rather than keep a dead channel
      // looking alive. The answer is best-effort: the channel is closing whether or not it lands.
      try { await this.send(knxFrame(SVC.DISCONNECT_RES, Buffer.from([this.channel, 0x00]))); } catch { /* the gateway may already be gone */ }
      this.reap("the gateway sent a DISCONNECT_REQUEST; the tunnel is closed");
    } else if (svc === SVC.TUNNEL_ACK) {
      if (this.ackWaiter && body[2] === this.ackWaiter.seq) { this.ackWaiter.resolve(); this.ackWaiter = null; }
    } else if (svc === SVC.TUNNEL_REQ) {
      // 3/8/4 v2: tunnelling over TCP has no TUNNELLING_ACK in either direction; the stream is the
      // acknowledgement. Only a UDP request is answered.
      if (this.mode === "udp") await this.send(knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, this.channel, body[2], 0x00])));
      const cemi = body.subarray(4);
      // Only L_Data.ind is a telegram from the bus. A gateway also tunnels L_Data.con back — its
      // confirmation that a frame WE sent reached the bus — and the two are byte-identical apart
      // from this code. Passing a .con on as an incoming telegram reports our own outgoing frames
      // to the upper layer as if a device had sent them. (The USB transport has always filtered
      // this correctly; the IP client did not.)
      if (cemi[0] === CEMI.LDATA_CON) { this.onCon(cemi); return; }
      if (cemi[0] !== CEMI.LDATA_IND) return;
      this.onRawCemi?.(Buffer.from(cemi));
      const { src, dst, tpdu, isGroup } = parseCemiLData(cemi);
      this.onCemi?.(src, dst, tpdu, isGroup);
    }
  }

  // KNXnet/IP-layer send of a cEMI. Over UDP it waits for the tunnelling ACK and retransmits on a
  // timeout (up to `tries`, the spec's recovery for a lost datagram). Over TCP (3/8/4 v2) there is no
  // TUNNELLING_ACK: a real KNX IP interface never sends one, so the frame is written exactly once and
  // the send completes on the interface's L_Data.con (matched by content, see conKey). A
  // retransmission could only duplicate a memory write.
  async sendCemi(cemi: Buffer, tries = 3): Promise<void> {
    if (this.mode === "tcp") {
      if (this.closed) throw new KnxError("TUNNEL_CLOSED", "the tunnel is closed");
      const seq = this.txSeq;
      this.txSeq = (seq + 1) & 0xff;
      // Transport-layer control frames (T_Connect, T_Disconnect, T_ACK) carry no request; waiting
      // for their confirmation would only hold back the answer the T_ACK acknowledges.
      const control = (cemi[2 + (cemi[1] ?? 0) + 7] ?? 0) & 0x80;
      const w = control ? null : this.awaitCon(cemi);
      try { await this.send(knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, this.channel, seq, 0x00]), cemi]))); }
      catch (e) { if (w) { this.dropCon(w); w.promise.catch(() => undefined); w.reject(e instanceof Error ? e : new Error(String(e))); } throw e; }
      if (w) await w.promise;
      return;
    }
    for (let i = 0; i < tries; i++) {
      // The gateway can close the channel while an earlier try waits for its ACK (a DISCONNECT_REQUEST,
      // a heartbeat that went unanswered); the socket is closed with it, and Bun's dgram answers a send
      // into it with a bare TypeError instead of a coded error.
      if (this.closed) throw new KnxError("TUNNEL_CLOSED", "the tunnel is closed");
      const seq = this.txSeq;
      const frame = knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, this.channel, seq, 0x00]), cemi]));
      let release = (): void => undefined;
      const ack = new Promise<boolean>((resolve) => { this.ackWaiter = { seq, resolve: () => resolve(true) }; release = () => resolve(false); setTimeout(release, this.ackTimeoutMs); });
      this.ackReleases.add(release);
      try {
        await this.send(frame);
        if (await ack) { this.txSeq = (this.txSeq + 1) & 0xff; return; }
      } finally { this.ackReleases.delete(release); }
    }
    throw new KnxError("TUNNEL_ACK_TIMEOUT", "tunnelling ack timeout");
  }

  // A confirmation names the frame it confirms by everything but its source (a gateway fills in a
  // source of 0.0.0) and the control field (the gateway sets the confirm bit in it).
  private static conKey(cemi: Buffer): string {
    const p = 2 + (cemi[1] ?? 0);
    return cemi.subarray(p + 4).toString("hex");
  }
  // A confirmation still missing after conTimeoutMs is not yet a failure: the stream may be stalled,
  // with the frame, or its confirmation, held in TCP's retransmission. A connection-state request
  // written now goes behind the frame, so its answer shows the interface has read the frame: from that
  // answer the confirmation gets conTimeoutMs more, and missing then it is TUNNEL_CON_TIMEOUT. While
  // the requests go unanswered the stream is stalled and the wait goes on, until the heartbeat round
  // they belong to declares the tunnel dead (three requests 10 s apart, KNX 3/8/2 §5.4), which fails
  // the send as TUNNEL_CLOSED. ETS goes on after an unconfirmed frame as well (it logs a ConfTimeout
  // after about 1 s and sends the next one). However the answers go, the wait ends as TUNNEL_CON_TIMEOUT
  // once it has lasted as long as that round can (conTimeoutMs on each side of three requests).
  private awaitCon(cemi: Buffer): ConWaiter {
    const key = KnxIpTunnel.conKey(cemi);
    let resolve!: () => void, reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    const clear = () => { clearTimeout(t); if (w.grace) clearTimeout(w.grace); if (w.cap) clearTimeout(w.cap); };
    const w: ConWaiter = { key, promise, resolve: () => { clear(); resolve(); }, reject: (e) => { clear(); reject(e); } };
    const t = setTimeout(() => {
      if (!this.conWaiters.includes(w)) return;
      w.probe = this.stateSent + 1;
      w.cap = setTimeout(() => this.conTimedOut(w, `did not confirm the frame within ${Math.round((2 * this.conTimeoutMs + CONNECTIONSTATE_TRIES * this.stateTimeoutMs) / 1000)} s, with the link not shown dead`), this.conTimeoutMs + CONNECTIONSTATE_TRIES * this.stateTimeoutMs);
      if (this.heartbeatRunning) void this.sendStateRequest();
      else void this.heartbeat();
    }, this.conTimeoutMs);
    this.conWaiters.push(w);
    return w;
  }
  private interfaceReadUpTo(): void {
    for (const w of this.conWaiters) {
      if (w.probe === undefined || w.grace !== undefined || this.stateAnswered < w.probe) continue;
      w.grace = setTimeout(() => this.conTimedOut(w, `answered on the link but did not confirm the frame within ${Math.round(this.conTimeoutMs / 1000)} s of answering`), this.conTimeoutMs);
    }
  }
  private conTimedOut(w: ConWaiter, what: string): void {
    if (!this.dropCon(w)) return;
    this.lateCons.push(w.key);
    if (this.lateCons.length > 16) this.lateCons.shift();
    w.reject(new KnxError("TUNNEL_CON_TIMEOUT", `the interface at ${this.ifaceIp}:${this.port} ${what}: it did not take the frame, it is stuck, or the link stalled again; whether the device answered is unknown`));
  }
  private dropCon(w: ConWaiter): boolean {
    const i = this.conWaiters.indexOf(w);
    if (i < 0) return false;
    this.conWaiters.splice(i, 1);
    return true;
  }
  private onCon(cemi: Buffer): void {
    const key = KnxIpTunnel.conKey(cemi);
    const late = this.lateCons.indexOf(key);
    if (late >= 0) { this.lateCons.splice(late, 1); return; }
    const w = this.conWaiters.find((x) => x.key === key);
    if (!w) return;
    this.dropCon(w);
    this.settledCon = true;
    const ctrl1 = cemi[2 + (cemi[1] ?? 0)] ?? 0;
    if (ctrl1 & 0x01) w.reject(new KnxError("BUS_SEND_FAILED", "the KNX interface reports that the telegram did not reach the bus (negative L_Data.con); the line is dead, disconnected, or no device acknowledged the frame"));
    else w.resolve();
  }
  private failCons(e: Error): void {
    const ws = this.conWaiters; this.conWaiters = []; this.lateCons = [];
    for (const w of ws) w.reject(e);
  }

  async disconnect() {
    // Already torn down (by the gateway, see reap, or by an earlier disconnect): the socket is closed,
    // and closing it again throws in Bun's dgram.
    if (this.closed) return;
    // Stop answering FIRST. The DISCONNECT_REQ below still goes out, but anything that arrives from
    // here on belongs to a channel that is ending, and ACKing it would mean writing into a socket
    // this method is about to close.
    this.closed = true;
    const sock = this.currentSocket();
    this.failCons(new KnxError("TUNNEL_CLOSED", "the tunnel was closed before the gateway confirmed the frame"));
    this.releaseAck();
    this.stopHeartbeat();
    const controlHpai = this.mode === "tcp" ? hpaiTcp() : hpai("0.0.0.0", 0);
    try { await this.send(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([this.channel, 0x00]), controlHpai]))); } catch { /* teardown: the gateway may be gone; the channel is closed either way */ }
    this.closeSocket(sock);
  }
}
