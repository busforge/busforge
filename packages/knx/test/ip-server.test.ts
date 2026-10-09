import { test, expect, describe } from "bun:test";
import { KnxIpServer, type ServerSocket, type ServerTcpListener } from "../src/ipserver.ts";
import type { KnxTransport } from "../src/transport.ts";
import { SVC, CEMI, knxFrame, hpai, iaToNum, cemiLData, withMessageCode, tpConnect, tpAck, type Endpoint } from "../src/frame.ts";

// These tests exercise the UDP path only, so the TCP listener is stubbed out: without this the
// server would try to bind a real TCP port, and two servers in one test would collide. The TCP
// path has its own coverage in ip-tcp.test.ts.
const noopTcpListener = (): ServerTcpListener => ({ listen: (_p, cb) => cb(), onConnection: () => {}, close: () => {} });

// Offline tests for the KNXnet/IP server against a fake UDP socket and a fake bus.
// The wire bytes are hand-derived from the spec and from frame.ts:
//   knxFrame(svc, body) = [06 10 | svc u16 BE | total length u16 BE | body]
//   hpai(ip, port)      = [08 01 | 4 ip octets | port u16 BE]
// The server is the counterpart of KnxIpTunnel, so the two test files describe the same
// protocol from opposite ends.

const IFACE_IA = iaToNum("1.1.250");
const SECOND_IA = iaToNum("1.1.251");
const CLIENT: Endpoint = { address: "198.51.100.50", port: 55000 };
const CLIENT2: Endpoint = { address: "198.51.100.51", port: 55001 };

class FakeSocket implements ServerSocket {
  sent: { frame: Buffer; to: Endpoint }[] = [];
  closed = false;
  groups: string[] = [];
  private msg: ((m: Buffer, from: Endpoint) => void) | null = null;

  bind(_port: number, cb: () => void): void { cb(); }
  onMessage(cb: (m: Buffer, from: Endpoint) => void): void { this.msg = cb; }
  onError(_cb: (e: Error) => void): void { /* the tests never fault the socket */ }
  addMembership(group: string): void { this.groups.push(group); }
  send(frame: Buffer, to: Endpoint): void { this.sent.push({ frame: Buffer.from(frame), to }); }
  close(): void { this.closed = true; }

  deliver(m: Buffer, from: Endpoint): void { this.msg!(m, from); }
  /** Frames sent with this service id, oldest first. */
  ofService(svc: number): Buffer[] { return this.sent.filter((s) => s.frame.readUInt16BE(2) === svc).map((s) => s.frame); }
  clear(): void { this.sent.length = 0; }
}

// A bus that records what was written to it and can be told to refuse.
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
  /** A telegram arriving from the bus. */
  emit(cemi: Buffer): void { this.onRawCemi?.(cemi); }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// CONNECT_REQUEST: control HPAI + data HPAI + CRI [len 4, tunnelling 0x04, link layer 0x02, res].
// The HPAIs are NAT-mode (0.0.0.0:0), exactly as our own KnxIpTunnel sends them, so this also
// pins that the server answers where the datagram actually came from.
const connectReq = (layer = 0x02, type = 0x04) => knxFrame(SVC.CONNECT_REQ, Buffer.concat([
  hpai("0.0.0.0", 0), hpai("0.0.0.0", 0), Buffer.from([0x04, type, layer, 0x00]),
]));

// Tunnelling v2 CONNECT_REQUEST asking for a SPECIFIC tunnel address: the CRI is extended to 6
// bytes, the last two carrying the desired individual address (this is what ETS's per-connection
// "Individual Address" field sends).
const connectReqAddr = (ia: number) => knxFrame(SVC.CONNECT_REQ, Buffer.concat([
  hpai("0.0.0.0", 0), hpai("0.0.0.0", 0), Buffer.from([0x06, 0x04, 0x02, 0x00, (ia >> 8) & 0xff, ia & 0xff]),
]));

const tunnelReq = (channel: number, seq: number, cemi: Buffer) =>
  knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, channel, seq, 0x00]), cemi]));

const tunnelAck = (channel: number, seq: number) =>
  knxFrame(SVC.TUNNEL_ACK, Buffer.from([0x04, channel, seq, 0x00]));

const connStateReq = (channel: number) =>
  knxFrame(SVC.CONNECTIONSTATE_REQ, Buffer.concat([Buffer.from([channel, 0x00]), hpai("0.0.0.0", 0)]));

interface Rig { sock: FakeSocket; bus: FakeBus; server: KnxIpServer; clock: { t: number }; }

async function serve(addresses?: number[]): Promise<Rig> {
  const sock = new FakeSocket();
  const bus = new FakeBus();
  const clock = { t: 1_000_000 };
  const server = new KnxIpServer({
    maxApdu: 40, transport: bus,
    addresses,
    createSocket: () => sock,
    createTcpListener: noopTcpListener,
    now: () => clock.t,
    name: "Bench",
  });
  await server.start();
  sock.clear();
  return { sock, bus, server, clock };
}

/** Open a channel and return its id. */
async function open(rig: Rig, from: Endpoint = CLIENT): Promise<number> {
  rig.sock.deliver(connectReq(), from);
  await tick();
  const res = rig.sock.ofService(SVC.CONNECT_RES).at(-1)!;
  rig.sock.clear();
  return res[6];
}

describe("KnxIpServer: discovery", () => {
  test("answers a SEARCH_REQUEST with the interface address, and advertises only what it implements", async () => {
    const { sock } = await serve();
    sock.deliver(knxFrame(SVC.SEARCH_REQ, hpai("0.0.0.0", 0)), CLIENT);

    const res = sock.ofService(SVC.SEARCH_RES);
    expect(res.length).toBe(1);
    expect(sock.sent[0]!.to).toEqual(CLIENT); // NAT-mode HPAI: answered at the packet's real origin

    const dib = res[0]!.subarray(6 + 8); // header + our HPAI
    expect(dib[0]).toBe(54);             // device information DIB
    expect(dib[1]).toBe(0x01);
    expect(dib.readUInt16BE(4)).toBe(IFACE_IA);
    const nameField = dib.subarray(24, 54).toString("latin1");
    expect(nameField.slice(0, nameField.indexOf("\u0000"))).toBe("Bench");
    // Routing multicast address stays 0.0.0.0: this server does not route and says so.
    expect([...dib.subarray(14, 18)]).toEqual([0, 0, 0, 0]);

    // Supported service families: CORE (0x02) v2, DEVICE MANAGEMENT (0x03) v2, TUNNELLING (0x04) v1.
    // Core MUST be v2 or a strict TCP client (ETS) will not attempt a connection at all.
    const fam = res[0]!.subarray(6 + 8 + 54);
    expect([...fam]).toEqual([0x08, 0x02, 0x02, 0x02, 0x03, 0x02, 0x04, 0x01]);
  });

  test("joins the KNXnet/IP discovery multicast group, or no client would ever find it", async () => {
    const { sock } = await serve();
    expect(sock.groups).toEqual(["224.0.23.12"]);
  });
});

describe("KnxIpServer: connection management", () => {
  test("CONNECT_REQUEST is answered with a channel and the tunnel's individual address", async () => {
    const { sock } = await serve();
    sock.deliver(connectReq(), CLIENT);
    await tick();

    const res = sock.ofService(SVC.CONNECT_RES)[0]!;
    const body = res.subarray(6);
    expect(body[1]).toBe(0x00);                          // status: ok
    expect(body.readUInt16BE(2 + 8 + 2)).toBe(IFACE_IA); // CRD carries the tunnel address
    // Same layout our own client parses in connection.ts, so the two are wire-compatible.
  });

  test("a device-management connection is ACCEPTED (ETS opens one alongside its tunnel)", async () => {
    const { sock } = await serve();
    sock.deliver(connectReq(0x02, 0x03), CLIENT); // connection type 0x03 = device management
    await tick();

    const body = sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6);
    expect(body[1]).toBe(0x00);            // E_NO_ERROR
    expect(body[0]).not.toBe(0x00);        // a channel was allocated
    expect(body[body.length - 1]).toBe(0x03); // the CRD names the device-management connection type
  });

  test("answers a device-management property read (Device Object PID 56 = the path's max APDU), not VOID", async () => {
    const { sock } = await serve();
    sock.deliver(connectReq(0x02, 0x03), CLIENT); // device management
    await tick();
    const chId = sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    sock.clear();
    // M_PropRead.req: IOT 0, instance 1, PID 56, NoE 1, start 1.
    const propRead = Buffer.from([0xfc, 0x00, 0x00, 0x01, 0x38, 0x10, 0x01]);
    sock.deliver(knxFrame(SVC.DEVICE_CONFIG_REQ, Buffer.concat([Buffer.from([0x04, chId, 0, 0x00]), propRead])), CLIENT);
    await tick();
    expect(sock.ofService(SVC.DEVICE_CONFIG_ACK).length).toBe(1); // the request is acknowledged
    const cemi = sock.ofService(SVC.DEVICE_CONFIG_REQ).at(-1)!.subarray(10); // strip KNXnet/IP + connection header
    expect(cemi[0]).toBe(0xfb);        // M_PropRead.con
    expect(cemi[4]).toBe(0x38);        // PID 56
    expect(cemi[5] >> 4).toBe(1);      // number-of-elements 1 (a success, NOT the NoE=0 that aborts ETS)
    expect([...cemi.subarray(7)]).toEqual([0x00, 40]); // the path limit the server was given
  });

  test("refuses a maximum APDU length a frame cannot have", () => {
    for (const maxApdu of [14, 255, 40.5]) expect(() => new KnxIpServer({ maxApdu, transport: new FakeBus(), createSocket: () => new FakeSocket() })).toThrow(/maximum APDU length/);
  });

  test("answers the additional-individual-addresses array read (count at index 0, address at index 1)", async () => {
    const { sock } = await serve([iaToNum("1.1.100")]);
    sock.deliver(connectReq(0x02, 0x03), CLIENT);
    await tick();
    const chId = sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    sock.clear();
    const rd = (start: number, ne: number) => knxFrame(SVC.DEVICE_CONFIG_REQ, Buffer.concat([
      Buffer.from([0x04, chId, 0, 0x00]),
      Buffer.from([0xfc, 0x00, 0x0b, 0x01, 0x35, (ne << 4) | ((start >> 8) & 0x0f), start & 0xff]),
    ]));
    sock.deliver(rd(0, 1), CLIENT); await tick(); // index 0 -> element count
    expect([...sock.ofService(SVC.DEVICE_CONFIG_REQ).at(-1)!.subarray(17)]).toEqual([0x00, 0x01]);
    sock.clear();
    sock.deliver(rd(1, 1), CLIENT); await tick(); // index 1 -> the address itself
    expect([...sock.ofService(SVC.DEVICE_CONFIG_REQ).at(-1)!.subarray(17)]).toEqual([0x11, 0x64]); // 1.1.100
  });

  test("a bus-monitor layer connection is REFUSED with the code that says why", async () => {
    const { sock } = await serve();
    sock.deliver(connectReq(0x80), CLIENT); // TUNNEL_BUSMONITOR
    await tick();

    const body = sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6);
    expect(body[1]).toBe(0x29); // E_TUNNELLING_LAYER
  });

  test("a second client is refused when there is only one tunnel address to hand out", async () => {
    const rig = await serve(); // default: the interface's own address only
    await open(rig, CLIENT);

    rig.sock.deliver(connectReq(), CLIENT2);
    await tick();
    const body = rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6);
    expect(body[1]).toBe(0x24); // E_NO_MORE_CONNECTIONS
    // Refusing is the point: two tunnels on ONE address would both receive the device answers
    // addressed to it, and both connection-oriented state machines would be corrupted.
  });

  test("the refusal is logged with who holds the address and how long it has been silent", async () => {
    const logs: string[] = [];
    const sock = new FakeSocket();
    const clock = { t: 1_000_000 };
    const server = new KnxIpServer({ maxApdu: 40, transport: new FakeBus(), createSocket: () => sock, createTcpListener: noopTcpListener, now: () => clock.t, log: (m) => logs.push(m) });
    await server.start();
    sock.deliver(connectReq(), CLIENT);
    await tick();
    clock.t += 37_000;
    sock.deliver(connectReq(), CLIENT2);
    await tick();
    expect(logs.at(-1)).toBe("refused a connection from 198.51.100.51:55001: no free tunnel address (1.1.250 held by channel 1 for 198.51.100.50:55000, last heard 37 s ago)");
  });

  test("two clients get two channels and two DISTINCT addresses when a pool is configured", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    const a = await open(rig, CLIENT);

    rig.sock.deliver(connectReq(), CLIENT2);
    await tick();
    const body = rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6);
    const b = body[0];
    expect(body[1]).toBe(0x00);
    expect(b).not.toBe(a);
    expect(body.readUInt16BE(2 + 8 + 2)).toBe(SECOND_IA);
  });

  test("a client's request for a SPECIFIC free pool address is granted (Tunnelling v2)", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    rig.sock.deliver(connectReqAddr(SECOND_IA), CLIENT); // ask for the second, not the first-free
    await tick();
    const body = rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6);
    expect(body[1]).toBe(0x00);
    expect(body.readUInt16BE(2 + 8 + 2)).toBe(SECOND_IA); // got exactly what it asked for
  });

  test("a request for an address NOT in the pool is refused, never substituted", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    rig.sock.deliver(connectReqAddr(iaToNum("1.1.99")), CLIENT); // an address this server does not own
    await tick();
    const body = rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6);
    expect(body[1]).toBe(0x24); // E_NO_MORE_CONNECTIONS
    expect(body[0]).toBe(0x00); // and no channel was allocated
    expect(rig.server.channels.size).toBe(0);
  });

  test("a request for a pool address already in use is refused, not silently reassigned", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    await open(rig, CLIENT); // takes IFACE_IA (first free)
    rig.sock.deliver(connectReqAddr(IFACE_IA), CLIENT2); // asks for the one just taken
    await tick();
    const body = rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6);
    expect(body[1]).toBe(0x24); // E_NO_MORE_CONNECTIONS: that specific address is busy
  });

  test("CONNECTIONSTATE_REQUEST is answered ok for a live channel and E_CONNECTION_ID for a dead one", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.sock.deliver(connStateReq(ch), CLIENT);
    rig.sock.deliver(connStateReq(ch + 1), CLIENT);
    const res = rig.sock.ofService(SVC.CONNECTIONSTATE_RES);
    expect([...res[0]!.subarray(6)]).toEqual([ch, 0x00]);
    expect([...res[1]!.subarray(6)]).toEqual([ch + 1, 0x21]); // E_CONNECTION_ID
  });

  test("a client that stops sending connection-state requests loses its channel after 120 s", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.clock.t += 119_000;
    rig.server["reap"]();
    expect(rig.server.channels.has(ch)).toBe(true);

    rig.clock.t += 2_000; // now past 120 s
    rig.server["reap"]();
    expect(rig.server.channels.has(ch)).toBe(false);
    // And the client is TOLD, rather than left to discover it by timing out itself.
    expect(rig.sock.ofService(SVC.DISCONNECT_REQ).length).toBe(1);
  });

  test("DISCONNECT_REQUEST frees the channel and its address for the next client", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.sock.deliver(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([ch, 0x00]), hpai("0.0.0.0", 0)])), CLIENT);
    expect([...rig.sock.ofService(SVC.DISCONNECT_RES)[0]!.subarray(6)]).toEqual([ch, 0x00]);
    expect(rig.server.channels.size).toBe(0);

    rig.sock.clear();
    rig.sock.deliver(connectReq(), CLIENT2);
    await tick();
    expect(rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6)[1]).toBe(0x00); // the address came back
  });
});

describe("KnxIpServer: client -> bus", () => {
  const req = cemiLData(IFACE_IA, iaToNum("1.2.32"), Buffer.from([0x80])); // T_Connect to the device

  test("a tunnelled L_Data.req is ACKed, put on the bus, and confirmed with an L_Data.con", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.sock.deliver(tunnelReq(ch, 0, req), CLIENT);
    await tick();

    expect([...rig.sock.ofService(SVC.TUNNEL_ACK)[0]!]).toEqual([...tunnelAck(ch, 0)]);
    expect(rig.bus.written.length).toBe(1);
    expect(rig.bus.written[0]!.equals(req)).toBe(true);

    // The confirmation comes back as a tunnelling request of its own, carrying the same frame with
    // the message code rewritten and the error bit clear.
    const con = rig.sock.ofService(SVC.TUNNEL_REQ)[0]!;
    const cemi = con.subarray(10);
    expect(cemi[0]).toBe(CEMI.LDATA_CON);
    expect(cemi[2] & 0x01).toBe(0); // confirm: no error
  });

  test("when the bus refuses the frame, the client is told so in the L_Data.con, not left guessing", async () => {
    const rig = await serve();
    const ch = await open(rig);
    rig.bus.refuse = "the USB interface did not confirm the frame reached the bus";

    rig.sock.deliver(tunnelReq(ch, 0, req), CLIENT);
    await tick();

    expect(rig.bus.written.length).toBe(0);
    const cemi = rig.sock.ofService(SVC.TUNNEL_REQ)[0]!.subarray(10);
    expect(cemi[0]).toBe(CEMI.LDATA_CON);
    expect(cemi[2] & 0x01).toBe(1); // confirm: ERROR. The telegram did not reach the bus.
  });

  test("a retransmitted frame is ACKed again but NOT written to the bus twice", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.sock.deliver(tunnelReq(ch, 0, req), CLIENT);
    await tick();
    rig.sock.deliver(tunnelReq(ch, 0, req), CLIENT); // the client's ACK was lost, so it repeats
    await tick();

    expect(rig.sock.ofService(SVC.TUNNEL_ACK).length).toBe(2); // both acknowledged
    expect(rig.bus.written.length).toBe(1);                    // written ONCE
    // A duplicated memory write is precisely the damage this project exists to avoid, so the
    // sequence number is not decoration here.
  });

  test("a frame out of sequence is dropped and not acknowledged", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.sock.deliver(tunnelReq(ch, 7, req), CLIENT); // expected 0
    await tick();

    expect(rig.sock.ofService(SVC.TUNNEL_ACK).length).toBe(0);
    expect(rig.bus.written.length).toBe(0);
  });

  test("a client sending from 0.0.0 gets its channel's address filled in", async () => {
    const rig = await serve();
    const ch = await open(rig);
    const anonymous = cemiLData(0, iaToNum("1.2.32"), Buffer.from([0x80]));

    rig.sock.deliver(tunnelReq(ch, 0, anonymous), CLIENT);
    await tick();

    expect(rig.bus.written[0]!.readUInt16BE(4)).toBe(IFACE_IA);
  });

  test("a cEMI that is not an L_Data.req is refused, not forwarded blindly", async () => {
    const rig = await serve();
    const ch = await open(rig);
    const notes: string[] = [];
    // M_PropRead.req: local device management, which this server does not serve.
    const propRead = Buffer.from([0xfc, 0x00, 0x08, 0x01, 0x34, 0x10, 0x01]);

    const sock = rig.sock;
    const server = new KnxIpServer({ maxApdu: 40, transport: rig.bus, createSocket: () => sock, createTcpListener: noopTcpListener, now: () => rig.clock.t, log: (m) => notes.push(m) });
    await server.start();
    sock.clear();
    sock.deliver(connectReq(), CLIENT);
    await tick();
    const ch2 = sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    sock.clear();

    sock.deliver(tunnelReq(ch2, 0, propRead), CLIENT);
    await tick();

    expect(sock.ofService(SVC.TUNNEL_ACK).length).toBe(1); // the DATAGRAM is acknowledged
    expect(rig.bus.written.length).toBe(0);                 // its CONTENT is not put on the bus
    expect(notes.some((n) => n.includes("L_Data.req only"))).toBe(true);
    expect(ch).toBeGreaterThan(0);
    await server.stop();
  });
});

describe("KnxIpServer: bus -> client", () => {
  const ind = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x12, 0x20, 0x1b, 0x01, 0x01, 0x00, 0x81]);

  test("a telegram from the bus reaches the client verbatim, with a sequence number", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.bus.emit(ind);
    await tick();

    const out = rig.sock.ofService(SVC.TUNNEL_REQ)[0]!;
    expect([...out.subarray(6, 10)]).toEqual([0x04, ch, 0x00, 0x00]); // conn header, seq 0
    expect(out.subarray(10).equals(ind)).toBe(true);                  // the bytes are NOT re-encoded
  });

  test("the sequence number advances only once the client acknowledges", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.bus.emit(ind);
    await tick();
    rig.sock.deliver(tunnelAck(ch, 0), CLIENT);
    await tick();

    rig.bus.emit(ind);
    await tick();
    const out = rig.sock.ofService(SVC.TUNNEL_REQ);
    expect(out.length).toBe(2);
    expect(out[1]![8]).toBe(0x01);
    rig.sock.deliver(tunnelAck(ch, 1), CLIENT);
    await tick();
  });

  test("one bus telegram reaches EVERY open tunnel: this is what USB cannot do", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    const a = await open(rig, CLIENT);
    rig.sock.deliver(connectReq(), CLIENT2);
    await tick();
    const b = rig.sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    rig.sock.clear();

    rig.bus.emit(ind);
    await tick();

    const out = rig.sock.ofService(SVC.TUNNEL_REQ);
    expect(out.length).toBe(2);
    const byChannel = (x: number, y: number) => x - y;
    expect(out.map((f) => f[7]).sort(byChannel)).toEqual([a, b].sort(byChannel));
    // A bus monitor and a download can therefore run at the same time through one interface, which
    // is the whole reason the bridge exists.
    rig.sock.deliver(tunnelAck(a, 0), CLIENT);
    rig.sock.deliver(tunnelAck(b, 0), CLIENT2);
    await tick();
  });

  test("what one client sends is seen by the others as a bus telegram", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    const a = await open(rig, CLIENT);
    rig.sock.deliver(connectReq(), CLIENT2);
    await tick();
    const b = rig.sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    rig.sock.clear();

    const req = cemiLData(IFACE_IA, iaToNum("1.2.32"), Buffer.from([0x80]));
    rig.sock.deliver(tunnelReq(a, 0, req), CLIENT);
    await tick();

    const toB = rig.sock.sent.filter((s) => s.to.port === CLIENT2.port && s.frame.readUInt16BE(2) === SVC.TUNNEL_REQ);
    expect(toB.length).toBe(1);
    expect(toB[0]!.frame.subarray(10)[0]).toBe(CEMI.LDATA_IND); // seen as it would be on the bus
    // The sender itself gets the .con, and is NOT sent an echo of its own frame.
    const toA = rig.sock.sent.filter((s) => s.to.port === CLIENT.port && s.frame.readUInt16BE(2) === SVC.TUNNEL_REQ);
    expect(toA.length).toBe(1);
    expect(toA[0]!.frame.subarray(10)[0]).toBe(CEMI.LDATA_CON);
    expect(b).toBeGreaterThan(0);
  });

  test("a client that never acknowledges is retried once and then dropped", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.bus.emit(ind);
    await Bun.sleep(2100); // 1 s ack timeout, one retry, then the channel is gone

    const out = rig.sock.ofService(SVC.TUNNEL_REQ);
    expect(out.length).toBe(2);
    expect(out[0]![8]).toBe(0x00);
    expect(out[1]![8]).toBe(0x00); // the RETRY carries the same sequence number, not the next one
    expect(rig.server.channels.has(ch)).toBe(false);
    expect(rig.sock.ofService(SVC.DISCONNECT_REQ).length).toBe(1);
  }, 5000);
});

describe("KnxIpServer: management NAT (the USB single-address limit)", () => {
  const DEV = iaToNum("1.2.32");

  test("a point-to-point frame leaves the bus sourced from the INTERFACE, not the tunnel address", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    // ETS runs its management over a tunnel whose address is NOT the interface's (SECOND_IA here).
    rig.sock.deliver(connectReqAddr(SECOND_IA), CLIENT);
    await tick();
    const op = rig.sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    rig.sock.clear();

    rig.sock.deliver(tunnelReq(op, 0, cemiLData(SECOND_IA, DEV, tpConnect())), CLIENT);
    await tick();

    // On the bus the source is the interface's own address, so the device answers where a USB
    // interface actually delivers it. The destination is untouched.
    expect(rig.bus.written[0]!.readUInt16BE(4)).toBe(IFACE_IA);
    expect(rig.bus.written[0]!.readUInt16BE(6)).toBe(DEV);
    // The client's confirmation still shows ITS OWN source: the NAT is invisible to ETS.
    const con = rig.sock.ofService(SVC.TUNNEL_REQ)[0]!.subarray(10);
    expect(con[0]).toBe(CEMI.LDATA_CON);
    expect(con.readUInt16BE(4)).toBe(SECOND_IA);
  });

  test("the device's reply is routed only to the owning channel, re-addressed to it", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    const monitor = await open(rig, CLIENT2);            // a second tunnel just watching (on IFACE_IA)
    rig.sock.deliver(connectReqAddr(SECOND_IA), CLIENT); // the operation tunnel
    await tick();
    const op = rig.sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    rig.sock.clear();

    // The operation tunnel manages the device; the NAT records it as the owner.
    rig.sock.deliver(tunnelReq(op, 0, cemiLData(SECOND_IA, DEV, tpConnect())), CLIENT);
    await tick();
    // Drain the resulting con (to op) and ind (to the watcher) so neither channel's send queue is
    // still waiting on an ACK when the reply arrives.
    rig.sock.deliver(tunnelAck(op, 0), CLIENT);
    rig.sock.deliver(tunnelAck(monitor, 0), CLIENT2);
    await tick();
    rig.sock.clear();

    // The device answers, addressed to the INTERFACE (that is where the stick delivers it).
    rig.bus.emit(withMessageCode(cemiLData(DEV, IFACE_IA, tpAck(0)), CEMI.LDATA_IND));
    await tick();

    const toOp = rig.sock.sent.filter((s) => s.to.port === CLIENT.port && s.frame.readUInt16BE(2) === SVC.TUNNEL_REQ);
    const toMon = rig.sock.sent.filter((s) => s.to.port === CLIENT2.port && s.frame.readUInt16BE(2) === SVC.TUNNEL_REQ);
    expect(toOp.length).toBe(1);   // only the owner hears the reply
    expect(toMon.length).toBe(0);  // the watcher does not: a p2p reply is not its business
    const routed = toOp[0]!.frame.subarray(10);
    expect(routed.readUInt16BE(4)).toBe(DEV);       // source: the device, untouched
    expect(routed.readUInt16BE(6)).toBe(SECOND_IA); // destination: rewritten from interface back to the owner
    expect(monitor).toBeGreaterThan(0);
  });

  test("a point-to-point reply for a device NOBODY manages falls through to the fan-out, never dropped", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    const a = await open(rig, CLIENT);
    rig.sock.deliver(connectReq(), CLIENT2);
    await tick();
    const b = rig.sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    rig.sock.clear();

    // No tunnel ever managed DEV, so there is no owner to route to. Hiding the frame would be the
    // one forbidden move; it is delivered to every tunnel exactly as an ordinary bus telegram.
    rig.bus.emit(withMessageCode(cemiLData(DEV, IFACE_IA, tpAck(0)), CEMI.LDATA_IND));
    await tick();

    const out = rig.sock.ofService(SVC.TUNNEL_REQ);
    const byChannel = (x: number, y: number) => x - y;
    expect(out.map((f) => f[7]).sort(byChannel)).toEqual([a, b].sort(byChannel));
  });

  test("group traffic is never NAT-touched: it still reaches every tunnel, verbatim", async () => {
    const rig = await serve([IFACE_IA, SECOND_IA]);
    const mon = await open(rig, CLIENT);                 // a watcher on IFACE_IA
    rig.sock.deliver(connectReqAddr(SECOND_IA), CLIENT2); // the operation tunnel
    await tick();
    const op = rig.sock.ofService(SVC.CONNECT_RES).at(-1)![6];
    rig.sock.clear();

    // Even while a management conversation is open on one tunnel, a group telegram fans out to both.
    rig.sock.deliver(tunnelReq(op, 0, cemiLData(SECOND_IA, DEV, tpConnect())), CLIENT2);
    await tick();
    rig.sock.deliver(tunnelAck(op, 0), CLIENT2);  // drain the con
    rig.sock.deliver(tunnelAck(mon, 0), CLIENT);  // drain the ind the watcher got
    await tick();
    rig.sock.clear();

    const group = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x12, 0x20, 0x1b, 0x01, 0x01, 0x00, 0x81]);
    rig.bus.emit(group);
    await tick();

    const out = rig.sock.ofService(SVC.TUNNEL_REQ);
    const byChannel = (x: number, y: number) => x - y;
    expect(out.map((f) => f[7]).sort(byChannel)).toEqual([op, mon].sort(byChannel));
    expect(out.every((f) => f.subarray(10).equals(group))).toBe(true); // bytes untouched
  });
});

describe("KnxIpServer: malformed input from the LAN", () => {
  // The socket is bound on the LAN, so any host can send it a truncated frame. A parser that reads
  // past a short buffer throws, and a throw out of the dgram 'message' listener is an uncaught
  // exception: one crafted packet per second would be a denial of service. Every one of these must
  // be dropped, not thrown.
  const cases: [string, Buffer][] = [
    ["empty SEARCH_REQ body (parseHpai over-reads)", knxFrame(SVC.SEARCH_REQ, Buffer.alloc(0))],
    ["empty DESCRIPTION_REQ body", knxFrame(SVC.DESCRIPTION_REQ, Buffer.alloc(0))],
    ["short CONNECT_REQ (no HPAIs)", knxFrame(SVC.CONNECT_REQ, Buffer.from([0x08, 0x01]))],
    ["short CONNECTIONSTATE_REQ", knxFrame(SVC.CONNECTIONSTATE_REQ, Buffer.from([0x01]))],
    ["short DISCONNECT_REQ", knxFrame(SVC.DISCONNECT_REQ, Buffer.from([0x01]))],
  ];
  for (const [name, frame] of cases) {
    test(`drops a ${name} instead of throwing`, async () => {
      const rig = await serve();
      expect(() => rig.sock.deliver(frame, CLIENT)).not.toThrow();
    });
  }

  test("drops a TUNNEL_REQ whose cEMI claims more additional-info than it carries", async () => {
    const rig = await serve();
    const ch = await open(rig);
    // cemi[1] = 0xff promises 255 additional-info bytes; cemiSource then reads far past the end.
    const bogus = knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, ch, 0x00, 0x00]), Buffer.from([0x11, 0xff])]));
    expect(() => rig.sock.deliver(bogus, CLIENT)).not.toThrow();
    expect(rig.bus.written.length).toBe(0);
  });
});

describe("KnxIpServer: the negative-confirm bit is additional-info-aware", () => {
  test("with additional info present, the error bit lands on ctrl1, not inside the info block", async () => {
    const rig = await serve();
    const ch = await open(rig);
    rig.bus.refuse = "dead line";
    // An L_Data.req carrying ONE additional-info byte: code, addIL=1, [info], ctrl1, ctrl2, ...
    // ctrl1 sits at offset 2 + addIL = 3, NOT at the fixed offset 2.
    const withInfo = Buffer.from([0x11, 0x01, 0xaa, 0xbc, 0x60, 0x11, 0xfa, 0x12, 0x20, 0x01, 0x00, 0x80]);
    rig.sock.deliver(tunnelReq(ch, 0, withInfo), CLIENT);
    await tick();

    const cemi = rig.sock.ofService(SVC.TUNNEL_REQ)[0]!.subarray(10);
    expect(cemi[0]).toBe(CEMI.LDATA_CON);
    expect(cemi[2]).toBe(0xaa);       // the additional-info byte is untouched
    expect(cemi[3] & 0x01).toBe(1);   // the error bit is on ctrl1, where a client reads it
  });
});

describe("KnxIpServer: refusals", () => {
  test("refuses to start on an interface whose address it does not know", async () => {
    const bus = new FakeBus();
    bus.assignedIa = 0; // the interface never told us
    const server = new KnxIpServer({ maxApdu: 40, transport: bus, createSocket: () => new FakeSocket() });

    let refusal: unknown;
    try { await server.start(); } catch (e) { refusal = e; }
    // Starting anyway would hand every client a tunnel on 0.0.0: an address no device answers to.
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/individual address/);
  });

  test("stop() tells the clients instead of vanishing on them", async () => {
    const rig = await serve();
    const ch = await open(rig);

    await rig.server.stop();

    const bye = rig.sock.ofService(SVC.DISCONNECT_REQ);
    expect(bye.length).toBe(1);
    expect(bye[0]!.subarray(6)[0]).toBe(ch);
    expect(rig.sock.closed).toBe(true);
  });
});

describe("KnxIpServer: the interface goes away", () => {
  const req = cemiLData(IFACE_IA, iaToNum("1.2.32"), Buffer.from([0x80]));

  test("open tunnels are disconnected, and a new one is refused with E_KNX_CONNECTION", async () => {
    const rig = await serve();
    const ch = await open(rig);

    rig.server.interfaceLost("the USB interface refused a write: Cannot write to hid device");

    const bye = rig.sock.ofService(SVC.DISCONNECT_REQ);
    expect(bye.length).toBe(1);
    expect(bye[0]!.subarray(6)[0]).toBe(ch);
    expect(rig.server.channels.size).toBe(0);

    rig.sock.clear();
    rig.sock.deliver(connectReq(), CLIENT);
    await tick();
    // 0x27 E_KNX_CONNECTION: the server has no connection to the KNX subnetwork. A tunnel granted
    // now would confirm every frame negatively, which reads as a dead line, not a missing interface.
    expect(rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6)[1]).toBe(0x27);
    // Nothing from the dead transport reaches anyone any more.
    rig.bus.emit(cemiLData(iaToNum("1.2.32"), iaToNum("1/0/1"), Buffer.from([0x00, 0x81])));
    await tick();
    expect(rig.sock.ofService(SVC.TUNNEL_REQ).length).toBe(0);
  });

  test("a device-management connection is refused the same way while the interface is gone", async () => {
    const rig = await serve();
    rig.server.interfaceLost("gone");
    rig.sock.deliver(connectReq(0x02, 0x03), CLIENT);
    await tick();
    expect(rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6)[1]).toBe(0x27);
  });

  test("a restored interface serves tunnels again, on the new transport only", async () => {
    const rig = await serve();
    rig.server.interfaceLost("gone");
    const fresh = new FakeBus();
    rig.server.interfaceRestored(fresh);
    expect(rig.bus.onRawCemi).toBeNull();

    const ch = await open(rig);
    expect(ch).not.toBe(0);
    rig.sock.deliver(tunnelReq(ch, 0, req), CLIENT);
    await tick();
    expect(fresh.written.length).toBe(1);
    expect(rig.bus.written.length).toBe(0);
    rig.sock.deliver(tunnelAck(ch, 0), CLIENT); // the client acknowledges its L_Data.con
    await tick();

    rig.sock.clear();
    fresh.emit(cemiLData(iaToNum("1.2.32"), iaToNum("1/0/1"), Buffer.from([0x00, 0x81])));
    await tick();
    expect(rig.sock.ofService(SVC.TUNNEL_REQ).length).toBe(1);
  });

  test("an interface that comes back with another address is refused: the tunnels hand out the old one", async () => {
    const rig = await serve();
    rig.server.interfaceLost("gone");
    const other = new FakeBus();
    other.assignedIa = iaToNum("1.1.99");
    expect(() => rig.server.interfaceRestored(other)).toThrow(/1\.1\.99/);
    rig.sock.deliver(connectReq(), CLIENT);
    await tick();
    expect(rig.sock.ofService(SVC.CONNECT_RES)[0]!.subarray(6)[1]).toBe(0x27);
  });
});

describe("KnxIpServer: restoring the interface, refusals", () => {
  test("a restore while the interface is still serving is refused, so two transports never feed the tunnels", async () => {
    const rig = await serve();
    expect(() => rig.server.interfaceRestored(new FakeBus())).toThrow(/not gone/);
    expect(rig.bus.onRawCemi).not.toBeNull();
  });

  test("a restore after stop() is refused", async () => {
    const rig = await serve();
    rig.server.interfaceLost("gone");
    await rig.server.stop();
    const fresh = new FakeBus();
    expect(() => rig.server.interfaceRestored(fresh)).toThrow(/not running/);
    expect(fresh.onRawCemi).toBeNull();
  });

  test("an interface that did not tell its address yet is a retry, not another interface", async () => {
    const rig = await serve();
    rig.server.interfaceLost("gone");
    const silent = new FakeBus();
    silent.assignedIa = 0;
    let e: unknown;
    try { rig.server.interfaceRestored(silent); } catch (x) { e = x; }
    expect((e as { code: string }).code).toBe("BRIDGE_NO_ADDRESS");
  });

  test("the same serial back with another address is named as such, with the way out", async () => {
    const rig = await serve();
    rig.server.interfaceLost("gone");
    const moved = new FakeBus();
    moved.assignedIa = iaToNum("1.1.99");
    let e: unknown;
    try { rig.server.interfaceRestored(moved); } catch (x) { e = x; }
    expect((e as { code: string }).code).toBe("BRIDGE_INTERFACE_CHANGED");
    expect((e as Error).message).toContain("restart the bridge");
  });

  test("a write that loses the interface mid-tunnel drops the channel and confirms negatively to nobody", async () => {
    const rig = await serve();
    const ch = await open(rig);
    rig.bus.sendCemi = () => { rig.server.interfaceLost("the USB interface refused a write"); return Promise.reject(new Error("USB_INTERFACE_LOST")); };
    rig.sock.deliver(tunnelReq(ch, 0, cemiLData(IFACE_IA, iaToNum("1.2.32"), Buffer.from([0x80]))), CLIENT);
    await tick();
    await tick();
    expect(rig.server.channels.size).toBe(0);
    expect(rig.sock.ofService(SVC.DISCONNECT_REQ).length).toBe(1);
    // The L_Data.con belonged to the dropped channel; nothing is sent after the disconnect.
    const after = rig.sock.sent.findIndex((x) => x.frame.readUInt16BE(2) === SVC.DISCONNECT_REQ);
    expect(rig.sock.sent.slice(after + 1).filter((x) => x.frame.readUInt16BE(2) === SVC.TUNNEL_REQ).length).toBe(0);
  });
});
