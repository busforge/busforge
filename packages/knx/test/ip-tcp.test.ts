import { test, expect, describe } from "bun:test";
import { KnxIpTunnel, type TcpSocket } from "../src/connection.ts";
import { KnxIpServer, type ServerSocket, type ServerTcpSocket, type ServerTcpListener } from "../src/ipserver.ts";
import type { KnxTransport } from "../src/transport.ts";
import {
  KnxIpStreamParser, SVC, CEMI, knxFrame, hpai, hpaiTcp, iaToNum, cemiLData, type Endpoint,
} from "../src/frame.ts";

// Offline tests for standard KNXnet/IP Tunnelling over TCP, both ends, against scripted fakes. The
// wire bytes are hand-derived from frame.ts exactly as the UDP tests are:
//   knxFrame(svc, body) = [06 10 | svc u16 BE | total length u16 BE | body]
//   hpaiTcp()           = [08 02 | 00 00 00 00 | 00 00]  (host protocol code 0x02 = IPV4_TCP)
// Over TCP a frame is self-delimited by that total-length field, not by datagram boundaries, so the
// stream de-framer (KnxIpStreamParser) is what turns received bytes back into whole frames.

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Stream de-framer
// ---------------------------------------------------------------------------

describe("KnxIpStreamParser", () => {
  const f1 = knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, 0x01, 0x00, 0x00])); // 10 bytes
  const f2 = knxFrame(SVC.CONNECTIONSTATE_RES, Buffer.from([0x01, 0x00]));    // 8 bytes

  test("two frames coalesced into one read are split back into exactly those frames", () => {
    const p = new KnxIpStreamParser();
    const out = p.push(Buffer.concat([f1, f2]));
    expect(out.length).toBe(2);
    expect(out[0]!.equals(f1)).toBe(true);
    expect(out[1]!.equals(f2)).toBe(true);
  });

  test("a frame split across reads is held until it is complete", () => {
    const p = new KnxIpStreamParser();
    expect(p.push(f1.subarray(0, 3)).length).toBe(0); // only part of the header: nothing yet
    expect(p.push(f1.subarray(3, 7)).length).toBe(0); // still short of the declared length
    const out = p.push(f1.subarray(7));               // the last bytes complete it
    expect(out.length).toBe(1);
    expect(out[0]!.equals(f1)).toBe(true);
  });

  test("a short header alone yields nothing and waits", () => {
    const p = new KnxIpStreamParser();
    expect(p.push(Buffer.from([0x06, 0x10])).length).toBe(0);
  });

  test("a stream that is not KNXnet/IP framed is rejected, not read into", () => {
    const p = new KnxIpStreamParser();
    expect(() => p.push(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]))).toThrow(/out of frame/);
  });

  test("a declared length below the 6-byte header is rejected", () => {
    const p = new KnxIpStreamParser();
    expect(() => p.push(Buffer.from([0x06, 0x10, 0x04, 0x21, 0x00, 0x05]))).toThrow(/below the 6-byte header/);
  });
});

// ---------------------------------------------------------------------------
// Client: KnxIpTunnel over TCP
// ---------------------------------------------------------------------------

class FakeTcpSocket implements TcpSocket {
  sent: Buffer[] = [];
  ended = false;
  connectError: Error | null = null;
  private dataCb: ((c: Buffer) => void) | null = null;
  private closeCb: (() => void) | null = null;

  connect(_port: number, _ip: string, onConnect: () => void, onError: (e: Error) => void): void {
    if (this.connectError) onError(this.connectError); else onConnect();
  }
  write(frame: Buffer): void { this.sent.push(Buffer.from(frame)); }
  onData(cb: (c: Buffer) => void): void { this.dataCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  end(): void { this.ended = true; }

  inject(m: Buffer): void { this.dataCb!(m); }
  drop(): void { this.closeCb?.(); }
}

const CHANNEL = 0x07;
const CLIENT_IA = iaToNum("1.2.10");
// CONNECT_RESPONSE: channel 0x07, status ok, gateway HPAI, CRD carrying IA 1.2.10. The client
// ignores the gateway HPAI on TCP (the connection is the endpoint), so any address serves here.
const CONNECT_RES = knxFrame(SVC.CONNECT_RES, Buffer.concat([
  Buffer.from([CHANNEL, 0x00]),
  hpai("198.51.100.9", 3671),
  Buffer.from([0x04, 0x04, (CLIENT_IA >> 8) & 0xff, CLIENT_IA & 0xff]),
]));

async function connectedTcp() {
  const sock = new FakeTcpSocket();
  const tunnel = KnxIpTunnel.tcp("192.0.2.10", 3671, () => sock);
  const p = tunnel.connect();
  await tick(); // let the TCP connect resolve and the CONNECT_REQUEST go out
  sock.inject(CONNECT_RES);
  await p;
  sock.sent.length = 0;
  return { sock, tunnel };
}

describe("KnxIpTunnel over TCP", () => {
  test("connect sends a CONNECT_REQUEST with TCP HPAIs and parses channel + assigned IA", async () => {
    const sock = new FakeTcpSocket();
    const tunnel = KnxIpTunnel.tcp("192.0.2.10", 3671, () => sock);
    const p = tunnel.connect();
    await tick();

    expect(sock.sent.length).toBe(1);
    // CONNECT_REQUEST, 26 bytes: header + two IPV4_TCP HPAIs (08 02 00..00) + CRI (tunnel, link layer).
    const tcpHpai = [0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x02, 0x05, 0x00, 0x1a,
      ...tcpHpai,
      ...tcpHpai,
      0x04, 0x04, 0x02, 0x00,
    ]);

    sock.inject(CONNECT_RES);
    await p;
    expect(tunnel.channel).toBe(CHANNEL);
    expect(tunnel.assignedIa).toBe(CLIENT_IA);
  });

  test("a TCP connect error surfaces as a coded TUNNEL_CONNECT_FAILED, not a bare timeout", async () => {
    const sock = new FakeTcpSocket();
    sock.connectError = new Error("connect ECONNREFUSED 192.0.2.10:3671");
    const tunnel = KnxIpTunnel.tcp("192.0.2.10", 3671, () => sock);

    const err = await tunnel.connect().then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err).not.toBeNull();
    expect(err!.name).toBe("KnxError");
    expect(err!.code).toBe("TUNNEL_CONNECT_FAILED");
    expect(err!.message).toContain("192.0.2.10:3671");
    expect(err!.message).toContain("ECONNREFUSED");
  });

  test("no heartbeat timer is armed in TCP mode (the socket's liveness stands in for it)", async () => {
    const { tunnel } = await connectedTcp();
    // The 60 s CONNECTIONSTATE heartbeat procedure is not used on TCP (3/8/2 v2).
    expect(tunnel["heartbeatTimer"]).toBeNull();
  });

  test("sendCemi sends one TUNNELLING_REQUEST and completes when its ACK arrives", async () => {
    const { sock, tunnel } = await connectedTcp();
    const cemi = cemiLData(CLIENT_IA, iaToNum("1.2.7"), Buffer.from([0x80]));

    const p = tunnel.sendCemi(cemi);
    await tick();
    expect(sock.sent.length).toBe(1);
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x04, 0x20, 0x00, 0x14,
      0x04, CHANNEL, 0x00, 0x00,
      ...cemi,
    ]);
    sock.inject(knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, CHANNEL, 0x00, 0x00])));
    await p; // resolves on the ACK
  });

  test("sendCemi does NOT retransmit on an ACK timeout: exactly one request, then TUNNEL_ACK_TIMEOUT", async () => {
    const { sock, tunnel } = await connectedTcp();
    tunnel["ackTimeoutMs"] = 10; // don't wait the full 1.5 s
    const cemi = cemiLData(CLIENT_IA, iaToNum("1.2.7"), Buffer.from([0x80]));

    const err = await tunnel.sendCemi(cemi).then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err).not.toBeNull();
    expect(err!.code).toBe("TUNNEL_ACK_TIMEOUT");
    // TCP guarantees delivery, so a retransmission would only duplicate the memory write. The
    // request went out exactly once.
    expect(sock.sent.filter((f) => f.readUInt16BE(2) === SVC.TUNNEL_REQ).length).toBe(1);
  });

  test("an inbound L_Data.ind is ACKed and surfaced via onCemi", async () => {
    const { sock, tunnel } = await connectedTcp();
    const calls: { src: number; dst: number; isGroup: boolean }[] = [];
    tunnel.onCemi = (src, dst, _tpdu, isGroup) => calls.push({ src, dst, isGroup });

    const req = knxFrame(SVC.TUNNEL_REQ, Buffer.concat([
      Buffer.from([0x04, CHANNEL, 0x05, 0x00]),
      Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x12, 0x07, 0x0a, 0x03, 0x01, 0x00, 0x81]),
    ]));
    sock.inject(req);
    await tick();

    const acks = sock.sent.filter((f) => f.readUInt16BE(2) === SVC.TUNNEL_ACK);
    expect(acks.length).toBe(1);
    expect(acks[0]![8]).toBe(0x05); // the gateway's sequence number echoed back
    expect(calls.length).toBe(1);
    expect(calls[0]!.src).toBe(iaToNum("1.2.7"));
    expect(calls[0]!.dst).toBe(0x0a03);
    expect(calls[0]!.isGroup).toBe(true);
  });

  test("onClosed fires when the TCP connection drops", async () => {
    const { sock, tunnel } = await connectedTcp();
    const closed: string[] = [];
    tunnel.onClosed = (r) => closed.push(r);

    sock.drop();
    expect(closed.length).toBe(1);
    expect(closed[0]!).toContain("TCP");
  });

  test("disconnect sends a DISCONNECT_REQUEST with a TCP HPAI and ends the socket", async () => {
    const { sock, tunnel } = await connectedTcp();
    await tunnel.disconnect();

    expect(sock.sent.length).toBe(1);
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x02, 0x09, 0x00, 0x10,
      CHANNEL, 0x00,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(sock.ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Server: KnxIpServer over TCP
// ---------------------------------------------------------------------------

const IFACE_IA = iaToNum("1.1.250");
const SECOND_IA = iaToNum("1.1.251");

class FakeUdpServerSocket implements ServerSocket {
  bind(_port: number, cb: () => void): void { cb(); }
  onMessage(_cb: (m: Buffer, from: Endpoint) => void): void {}
  onError(_cb: (e: Error) => void): void {}
  addMembership(_group: string): void {}
  send(_frame: Buffer, _to: Endpoint): void {}
  close(): void {}
}

class FakeServerConn implements ServerTcpSocket {
  sent: Buffer[] = [];
  ended = false;
  private dataCb: ((c: Buffer) => void) | null = null;
  private closeCb: (() => void) | null = null;
  write(frame: Buffer): void { this.sent.push(Buffer.from(frame)); }
  onData(cb: (c: Buffer) => void): void { this.dataCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  end(): void { this.ended = true; }
  feed(m: Buffer): void { this.dataCb!(m); }
  drop(): void { this.closeCb?.(); }
  ofService(svc: number): Buffer[] { return this.sent.filter((f) => f.readUInt16BE(2) === svc); }
}

class FakeTcpListener implements ServerTcpListener {
  private connCb: ((s: ServerTcpSocket) => void) | null = null;
  listen(_port: number, cb: () => void): void { cb(); }
  onConnection(cb: (s: ServerTcpSocket) => void): void { this.connCb = cb; }
  close(): void {}
  accept(s: ServerTcpSocket): void { this.connCb!(s); }
}

class FakeBus implements KnxTransport {
  assignedIa = IFACE_IA;
  onCemi: KnxTransport["onCemi"] = null;
  onRawCemi: ((cemi: Buffer) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  written: Buffer[] = [];
  refuse: string | null = null;
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  sendCemi(cemi: Buffer): Promise<void> {
    if (this.refuse) return Promise.reject(new Error(this.refuse));
    this.written.push(Buffer.from(cemi));
    return Promise.resolve();
  }
  emit(cemi: Buffer): void { this.onRawCemi?.(cemi); }
}

const connectReqTcp = () =>
  knxFrame(SVC.CONNECT_REQ, Buffer.concat([hpaiTcp(), hpaiTcp(), Buffer.from([0x04, 0x04, 0x02, 0x00])]));
const tunnelReq = (channel: number, seq: number, cemi: Buffer) =>
  knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, channel, seq, 0x00]), cemi]));
const tunnelAck = (channel: number, seq: number) =>
  knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, channel, seq, 0x00]));

interface ServerRig { bus: FakeBus; listener: FakeTcpListener; server: KnxIpServer; clock: { t: number }; }

async function serveTcp(addresses?: number[]): Promise<ServerRig> {
  const bus = new FakeBus();
  const listener = new FakeTcpListener();
  const clock = { t: 1_000_000 };
  const server = new KnxIpServer({
    transport: bus, addresses,
    createSocket: () => new FakeUdpServerSocket(),
    createTcpListener: () => listener,
    now: () => clock.t, name: "Bench",
  });
  await server.start();
  return { bus, listener, server, clock };
}

/** Accept a TCP connection, open a channel on it, and return both. */
async function openTcp(rig: ServerRig): Promise<{ conn: FakeServerConn; ch: number }> {
  const conn = new FakeServerConn();
  rig.listener.accept(conn);
  conn.feed(connectReqTcp());
  await tick();
  const res = conn.ofService(SVC.CONNECT_RES).at(-1)!;
  const ch = res[6]!;
  conn.sent.length = 0;
  return { conn, ch };
}

describe("KnxIpServer over TCP", () => {
  test("a CONNECT_REQUEST on a TCP connection is answered on that same connection with a channel + IA", async () => {
    const rig = await serveTcp();
    const conn = new FakeServerConn();
    rig.listener.accept(conn);
    conn.feed(connectReqTcp());
    await tick();

    const res = conn.ofService(SVC.CONNECT_RES);
    expect(res.length).toBe(1); // answered over the socket, not the UDP endpoint
    const body = res[0]!.subarray(6);
    expect(body[1]).toBe(0x00);                          // status ok
    expect(body.readUInt16BE(2 + 8 + 2)).toBe(IFACE_IA); // CRD carries the tunnel address
    expect(rig.server.channels.get(body[0]!)!.tcp).toBe(conn);
  });

  test("a tunnelled L_Data.req is ACKed on the socket, put on the bus, and confirmed with an L_Data.con on the socket", async () => {
    const rig = await serveTcp();
    const { conn, ch } = await openTcp(rig);
    const req = cemiLData(IFACE_IA, iaToNum("1.2.32"), Buffer.from([0x80]));

    conn.feed(tunnelReq(ch, 0, req));
    await tick();

    expect([...conn.ofService(SVC.TUNNEL_ACK)[0]!]).toEqual([...tunnelAck(ch, 0)]);
    expect(rig.bus.written.length).toBe(1);
    expect(rig.bus.written[0]!.equals(req)).toBe(true);
    const con = conn.ofService(SVC.TUNNEL_REQ)[0]!.subarray(10);
    expect(con[0]).toBe(CEMI.LDATA_CON);
    expect(con[2]! & 0x01).toBe(0); // confirm: no error
  });

  test("a bus telegram is delivered to the TCP client as a TUNNELLING_REQUEST and completes on the client ACK", async () => {
    const rig = await serveTcp();
    const { conn, ch } = await openTcp(rig);
    const ind = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x12, 0x20, 0x1b, 0x01, 0x01, 0x00, 0x81]);

    rig.bus.emit(ind);
    await tick();
    const out = conn.ofService(SVC.TUNNEL_REQ);
    expect(out.length).toBe(1);
    expect([...out[0]!.subarray(6, 10)]).toEqual([0x04, ch, 0x00, 0x00]);
    expect(out[0]!.subarray(10).equals(ind)).toBe(true);

    // The client acknowledges; the sequence number advances only then.
    conn.feed(tunnelAck(ch, 0));
    await tick();
    rig.bus.emit(ind);
    await tick();
    expect(conn.ofService(SVC.TUNNEL_REQ)[1]![8]).toBe(0x01);
    conn.feed(tunnelAck(ch, 1));
    await tick();
  });

  test("closing the TCP connection deletes its channel, and no DISCONNECT is written into the dead socket", async () => {
    const rig = await serveTcp();
    const { conn, ch } = await openTcp(rig);
    expect(rig.server.channels.has(ch)).toBe(true);

    conn.drop();
    expect(rig.server.channels.has(ch)).toBe(false);
    expect(conn.ofService(SVC.DISCONNECT_REQ).length).toBe(0);
  });

  test("the 120 s heartbeat reaper never drops a TCP channel", async () => {
    const rig = await serveTcp();
    const { ch } = await openTcp(rig);

    rig.clock.t += 10 * 60_000; // far past the 120 s UDP window
    rig.server["reap"]();
    expect(rig.server.channels.has(ch)).toBe(true); // reaped by socket lifetime, not by silence
  });

  test("a malformed TCP stream drops that connection without crashing the server", async () => {
    const rig = await serveTcp();
    const conn = new FakeServerConn();
    rig.listener.accept(conn);

    expect(() => conn.feed(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]))).not.toThrow();
    expect(conn.ended).toBe(true); // the connection is ended
    expect(rig.server.channels.size).toBe(0);
  });

  test("two TCP connections get two channels and two distinct addresses, isolated from each other", async () => {
    const rig = await serveTcp([IFACE_IA, SECOND_IA]);
    const a = await openTcp(rig);
    const b = await openTcp(rig);
    expect(a.ch).not.toBe(b.ch);
    expect(rig.server.channels.get(a.ch)!.ia).toBe(IFACE_IA);
    expect(rig.server.channels.get(b.ch)!.ia).toBe(SECOND_IA);

    // A bus telegram reaches BOTH, each over its own connection.
    const ind = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x12, 0x20, 0x1b, 0x01, 0x01, 0x00, 0x81]);
    rig.bus.emit(ind);
    await tick();
    expect(a.conn.ofService(SVC.TUNNEL_REQ).length).toBe(1);
    expect(b.conn.ofService(SVC.TUNNEL_REQ).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: the real client and the real server over a paired in-memory TCP link
// ---------------------------------------------------------------------------

describe("KNXnet/IP tunnel over TCP, client and server end to end", () => {
  // A back-to-back TCP link: each side's write() reaches the other's onData on a macrotask, as a real
  // stream would. Both sides run the real KnxIpStreamParser, so a whole frame per write is reassembled
  // on receipt exactly as over a socket.
  function tcpPair() {
    let clientData: (c: Buffer) => void = () => {};
    let serverData: (c: Buffer) => void = () => {};
    let clientClose: () => void = () => {};
    let serverClose: () => void = () => {};
    const clientSock: TcpSocket = {
      connect: (_p, _ip, onC) => onC(),
      write: (f) => { const b = Buffer.from(f); setTimeout(() => serverData(b), 0); },
      onData: (cb) => { clientData = cb; },
      onClose: (cb) => { clientClose = cb; },
      end: () => { setTimeout(() => serverClose(), 0); },
    };
    const serverSock: ServerTcpSocket = {
      write: (f) => { const b = Buffer.from(f); setTimeout(() => clientData(b), 0); },
      onData: (cb) => { serverData = cb; },
      onClose: (cb) => { serverClose = cb; },
      end: () => { setTimeout(() => clientClose(), 0); },
    };
    return { clientSock, serverSock };
  }

  test("a cEMI travels both directions across the real client and server", async () => {
    const bus = new FakeBus();
    const listener = new FakeTcpListener();
    const server = new KnxIpServer({
      transport: bus,
      createSocket: () => new FakeUdpServerSocket(),
      createTcpListener: () => listener,
      name: "Bench",
    });
    await server.start();

    const { clientSock, serverSock } = tcpPair();
    listener.accept(serverSock); // the server side must be listening before the client connects
    const tunnel = KnxIpTunnel.tcp("192.0.2.10", 3671, () => clientSock);
    await tunnel.connect();
    expect(tunnel.assignedIa).toBe(IFACE_IA);
    expect(server.channels.size).toBe(1);

    // Flush several macrotasks: the paired link delivers each write on its own macrotask.
    const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };

    // client -> bus: sendCemi resolves on the server's tunnelling ACK, and the frame is on the bus.
    const out = cemiLData(IFACE_IA, iaToNum("1.2.32"), Buffer.from([0x80]));
    await tunnel.sendCemi(out);
    expect(bus.written.length).toBe(1);
    expect(bus.written[0]!.equals(out)).toBe(true);
    await flush(); // let the server's L_Data.con and its client ACK settle, freeing the channel queue

    // bus -> client: a telegram from the bus surfaces via onCemi on the client.
    const seen: number[] = [];
    tunnel.onCemi = (src) => seen.push(src);
    bus.emit(Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x12, 0x20, 0x1b, 0x01, 0x01, 0x00, 0x81]));
    await flush();
    expect(seen).toEqual([iaToNum("1.2.32")]);

    await tunnel.disconnect();
    await server.stop();
  });
});
