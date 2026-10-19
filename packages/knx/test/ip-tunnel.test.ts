import { test, expect, describe } from "bun:test";
import { KnxIpTunnel, type TunnelSocket } from "../src/connection.ts";
import { cemiLData, iaToNum, SVC, knxFrame, hpai } from "../src/frame.ts";

// Offline tests for KnxIpTunnel against a scripted fake UDP socket. Every
// expected datagram is hand-derived from frame.ts/connection.ts:
//   knxFrame(svc, body) = [06 10 | svc u16 BE | total length u16 BE | body]
//   hpai(ip, port)      = [08 01 | 4 ip octets | port u16 BE]
//   SVC: CONNECT_REQ 0x0205, CONNECT_RES 0x0206, DISCONNECT_REQ 0x0209,
//        TUNNEL_REQ 0x0420, TUNNEL_ACK 0x0421

class FakeUdpSocket implements TunnelSocket {
  sent: Buffer[] = [];
  closed = false;
  private msgCb: ((m: Buffer) => void) | null = null;
  private errCb: ((e: Error) => void) | null = null;
  bind(_port: number, cb: () => void): void { cb(); }
  on(ev: "message", cb: (m: Buffer) => void): void;
  on(ev: "error", cb: (e: Error) => void): void;
  on(ev: "message" | "error", cb: ((m: Buffer) => void) | ((e: Error) => void)): void {
    if (ev === "message") this.msgCb = cb as (m: Buffer) => void; else this.errCb = cb as (e: Error) => void;
  }
  injectError(e: Error): void { this.errCb!(e); }
  send(buf: Buffer, _port: number, _ip: string, cb: (err: Error | null) => void): void {
    this.sent.push(Buffer.from(buf));
    cb(null);
  }
  close(): void { this.closed = true; }
  inject(m: Buffer): void { this.msgCb!(m); }
}

// Flush pending microtasks/immediate timers so async internals settle.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const CHANNEL = 0x15;
const ASSIGNED_IA = iaToNum("1.1.250"); // 0x11fa

// CONNECT_RESPONSE, 24 bytes total:
//   06 10 02 06 00 18                  KNXnet/IP header, svc 0x0206, len 24
//   15 00                              channel id 0x15, status 0x00 (ok)
//   08 01 c6 33 64 02 0e 57            gateway data HPAI 198.51.100.2:3671
//   04 04 11 fa                        CRD: len 4, tunnel conn, IA 1.1.250
// connection.ts parses: channel = body[0], status = body[1],
// assignedIa = body.readUInt16BE(2 + 8 + 2) -> the two bytes after 04 04.
const CONNECT_RES = Buffer.from([
  0x06, 0x10, 0x02, 0x06, 0x00, 0x18,
  CHANNEL, 0x00,
  0x08, 0x01, 0xc6, 0x33, 0x64, 0x02, 0x0e, 0x57,
  0x04, 0x04, 0x11, 0xfa,
]);

async function connected() {
  const sock = new FakeUdpSocket();
  const tunnel = new KnxIpTunnel("192.0.2.10", 3671, () => sock);
  const p = tunnel.connect();
  await tick(); // let bind resolve and the CONNECT_REQUEST go out
  sock.inject(CONNECT_RES);
  await p;
  sock.sent.length = 0; // only look at traffic after connect
  return { sock, tunnel };
}

describe("KnxIpTunnel", () => {
  test("connect sends two NAT-mode HPAIs and parses channel + assigned IA", async () => {
    const sock = new FakeUdpSocket();
    const tunnel = new KnxIpTunnel("192.0.2.10", 3671, () => sock);
    const p = tunnel.connect();
    await tick();

    expect(sock.sent.length).toBe(1);
    // CONNECT_REQUEST, 26 bytes:
    //   06 10 02 05 00 1a          header: svc CONNECT_REQ, total len 26
    //   08 01 00 00 00 00 00 00    control HPAI: len 8, proto 0x01 (UDP),
    //                              IP 0.0.0.0, port 0  <-- NAT mode
    //   08 01 00 00 00 00 00 00    data HPAI: identical NAT-mode HPAI
    //   04 04 02 00                CRI: len 4, tunnel connection,
    //                              link layer (0x02), reserved
    // The 0.0.0.0:0 HPAIs are the hard-won Docker-bridge-NAT fix: the
    // gateway must reply to the observed packet source, not an address we
    // name (a container-internal 172.x IP would be unroutable and the
    // tunnel would time out). Lock the exact bytes.
    const natHpai = [0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x02, 0x05, 0x00, 0x1a,
      ...natHpai,
      ...natHpai,
      0x04, 0x04, 0x02, 0x00,
    ]);

    sock.inject(CONNECT_RES);
    await p;
    expect(tunnel.channel).toBe(CHANNEL);
    expect(tunnel.assignedIa).toBe(ASSIGNED_IA);
  });

  test("incoming TUNNELING_REQUEST is ACKed and surfaced via onCemi", async () => {
    const { sock, tunnel } = await connected();
    const calls: { src: number; dst: number; tpdu: Buffer; isGroup: boolean }[] = [];
    tunnel.onCemi = (src, dst, tpdu, isGroup) => calls.push({ src, dst, tpdu, isGroup });

    // TUNNELING_REQUEST seq 5 carrying a group L_Data.ind, 21 bytes:
    //   06 10 04 20 00 15                 header: svc TUNNEL_REQ, len 21
    //   04 15 05 00                       conn header: len 4, channel 0x15,
    //                                     seq 5, reserved
    //   29 00 bc e0 12 07 0a 03 01 00 81  cEMI: L_Data.ind, no add. info,
    //                                     ctrl bc e0 (group-addressed),
    //                                     src 1.2.7, dst GA 1/2/3 (0x0a03),
    //                                     len 1, TPDU 00 81 (GroupValueWrite 1)
    const req = Buffer.from([
      0x06, 0x10, 0x04, 0x20, 0x00, 0x15,
      0x04, CHANNEL, 0x05, 0x00,
      0x29, 0x00, 0xbc, 0xe0, 0x12, 0x07, 0x0a, 0x03, 0x01, 0x00, 0x81,
    ]);
    sock.inject(req);
    await tick();

    // Expected TUNNELING_ACK, 10 bytes: header (svc 0x0421, len 10) +
    // [04 len, channel 0x15 echoed, seq 5 echoed, status 00]
    expect(sock.sent.length).toBe(1);
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x04, 0x21, 0x00, 0x0a,
      0x04, CHANNEL, 0x05, 0x00,
    ]);

    expect(calls.length).toBe(1);
    expect(calls[0]!.src).toBe(iaToNum("1.2.7"));
    expect(calls[0]!.dst).toBe(0x0a03); // GA 1/2/3
    expect(calls[0]!.isGroup).toBe(true);
    expect(calls[0]!.tpdu.equals(Buffer.from([0x00, 0x81]))).toBe(true);
  });

  test("a tunnelled L_Data.con is ACKed but NOT surfaced: it is our own frame, not a device's", async () => {
    // A gateway tunnels back an L_Data.con to confirm that a frame WE sent reached the bus. It is
    // byte-identical to an incoming L_Data.ind apart from the message code (0x2e vs 0x29). Passing
    // it up as an incoming telegram reports our own outgoing frames to the upper layer as if a
    // device had sent them (KnxDevice would then treat its own T_Connect echo as a device reply).
    const { sock, tunnel } = await connected();
    let calls = 0;
    tunnel.onCemi = () => calls++;

    // Same frame as the delivery test, but message code 0x2e (L_Data.con).
    const con = Buffer.from([
      0x06, 0x10, 0x04, 0x20, 0x00, 0x15,
      0x04, CHANNEL, 0x07, 0x00,
      0x2e, 0x00, 0xbc, 0xe0, 0x12, 0x07, 0x0a, 0x03, 0x01, 0x00, 0x81,
    ]);
    sock.inject(con);
    await tick();

    expect(calls).toBe(0);            // not delivered upward
    expect(sock.sent.length).toBe(1); // but still ACKed, so the gateway stops retransmitting
    expect(sock.sent[0]!.readUInt16BE(2)).toBe(0x0421); // TUNNEL_ACK
  });

  test("duplicate TUNNELING_REQUEST (same seq) is ACKed AND delivered again (current behavior)", async () => {
    // connection.ts does NOT track the server sequence counter: onMessage()
    // ACKs whatever seq arrives and always forwards the cEMI. A gateway
    // retransmission (same seq, e.g. because our ACK was lost) is therefore
    // delivered to onCemi twice. This locks that actual behavior; it is an
    // observation, not an endorsement of duplicate delivery.
    const { sock, tunnel } = await connected();
    let calls = 0;
    tunnel.onCemi = () => calls++;

    const req = Buffer.from([
      0x06, 0x10, 0x04, 0x20, 0x00, 0x15,
      0x04, CHANNEL, 0x05, 0x00, // same seq 5 both times
      0x29, 0x00, 0xbc, 0xe0, 0x12, 0x07, 0x0a, 0x03, 0x01, 0x00, 0x81,
    ]);
    sock.inject(req);
    await tick();
    sock.inject(req);
    await tick();

    expect(calls).toBe(2); // duplicate NOT suppressed
    expect(sock.sent.length).toBe(2); // both ACKed
    expect(sock.sent[0]!.equals(sock.sent[1]!)).toBe(true);
  });

  test("sendCemi carries the local seq counter and increments per ACKed send", async () => {
    const { sock, tunnel } = await connected();
    // cemiLData(1.1.250, 1.2.7, [0x80]) = 11 00 bc 60 11 fa 12 07 00 80 (10 B)
    const cemi = cemiLData(ASSIGNED_IA, iaToNum("1.2.7"), Buffer.from([0x80]));

    const p1 = tunnel.sendCemi(cemi);
    await tick();
    // TUNNELING_REQUEST, 20 bytes: header 06 10 04 20 00 14 +
    // conn header [04, channel 0x15, seq 0x00, 00] + the 10-byte cEMI
    expect(sock.sent.length).toBe(1);
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x04, 0x20, 0x00, 0x14,
      0x04, CHANNEL, 0x00, 0x00,
      ...cemi,
    ]);
    // TUNNELING_ACK for seq 0: 06 10 04 21 00 0a + [04, channel, seq 0, status 0]
    sock.inject(Buffer.from([0x06, 0x10, 0x04, 0x21, 0x00, 0x0a, 0x04, CHANNEL, 0x00, 0x00]));
    await p1;

    const p2 = tunnel.sendCemi(cemi);
    await tick();
    expect(sock.sent.length).toBe(2);
    // second send: seq incremented to 0x01
    expect([...sock.sent[1]!]).toEqual([
      0x06, 0x10, 0x04, 0x20, 0x00, 0x14,
      0x04, CHANNEL, 0x01, 0x00,
      ...cemi,
    ]);
    sock.inject(Buffer.from([0x06, 0x10, 0x04, 0x21, 0x00, 0x0a, 0x04, CHANNEL, 0x01, 0x00]));
    await p2;
  });

  test("disconnect sends DISCONNECT_REQUEST with the channel id and closes the socket", async () => {
    const { sock, tunnel } = await connected();
    await tunnel.disconnect();

    // DISCONNECT_REQUEST, 16 bytes:
    //   06 10 02 09 00 10          header: svc DISCONNECT_REQ, total len 16
    //   15 00                      channel id 0x15, reserved
    //   08 01 00 00 00 00 00 00    NAT-mode control HPAI (0.0.0.0:0 again)
    expect(sock.sent.length).toBe(1);
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x02, 0x09, 0x00, 0x10,
      CHANNEL, 0x00,
      0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(sock.closed).toBe(true);
  });

  test("a socket-level send failure rejects connect() with TUNNEL_SEND_FAILED, not a timeout", async () => {
    // A UDP send can fail on the local host before anything reaches the wire; the case a
    // user actually hits is macOS denying "Local Network" access (TCC), where the kernel
    // answers every send with EHOSTUNREACH. Ignoring the send callback's error resolved
    // the promise anyway, and connect() died 4 s later as a featureless
    // TUNNEL_CONNECT_TIMEOUT pointing at the gateway instead of at this host.
    class RefusingUdpSocket extends FakeUdpSocket {
      override send(_buf: Buffer, _port: number, _ip: string, cb: (err: Error | null) => void): void {
        cb(new Error("sendto EHOSTUNREACH"));
      }
    }
    const tunnel = new KnxIpTunnel("192.0.2.10", 3671, () => new RefusingUdpSocket());

    const err = await tunnel.connect().then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err).not.toBeNull();
    expect(err!.name).toBe("KnxError");
    expect(err!.code).toBe("TUNNEL_SEND_FAILED");
    // The message names the destination and carries the underlying cause.
    expect(err!.message).toContain("192.0.2.10:3671");
    expect(err!.message).toContain("EHOSTUNREACH");
  });

  test("a heartbeat sends a CONNECTIONSTATE_REQUEST and a positive answer keeps the tunnel up", async () => {
    const { sock, tunnel } = await connected();
    const closed: string[] = [];
    tunnel.onClosed = (r) => { closed.push(r); };

    const hb = tunnel["heartbeat"](); // drive one round directly; the 60 s interval never fires in a test
    await tick();

    // CONNECTIONSTATE_REQUEST, 16 bytes:
    //   06 10 02 07 00 10          header: svc CONNECTIONSTATE_REQ, total len 16
    //   15 00                      channel id 0x15, reserved
    //   08 01 00 00 00 00 00 00    NAT-mode control HPAI (0.0.0.0:0)
    expect(sock.sent.length).toBe(1);
    expect([...sock.sent[0]!]).toEqual([
      0x06, 0x10, 0x02, 0x07, 0x00, 0x10,
      CHANNEL, 0x00,
      0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    // A positive CONNECTIONSTATE_RESPONSE (channel echoed, status 0) ends the round cleanly.
    sock.inject(knxFrame(SVC.CONNECTIONSTATE_RES, Buffer.from([CHANNEL, 0x00])));
    await hb;
    expect(closed).toEqual([]); // the channel proved alive, so nothing was torn down
  });

  test("a heartbeat the gateway never answers brings the tunnel down and fires onClosed", async () => {
    const { sock, tunnel } = await connected();
    tunnel["stateTimeoutMs"] = 5; // don't wait 10 s x 3 for the real per-attempt timeout
    const closed: string[] = [];
    tunnel.onClosed = (r) => { closed.push(r); };

    await tunnel["heartbeat"]();

    // Three CONNECTIONSTATE_REQUESTs went out (the spec's retries) before the tunnel gave up.
    const hbs = sock.sent.filter((f) => f.readUInt16BE(2) === SVC.CONNECTIONSTATE_REQ);
    expect(hbs.length).toBe(3);
    // And the silence is surfaced as a closure, with the socket torn down. Without the reap-on-silence
    // path this stays empty and the caller keeps believing it is connected.
    expect(closed.length).toBe(1);
    expect(closed[0]!).toContain("connection-state");
    expect(sock.closed).toBe(true);
  });

  test("an inbound DISCONNECT_REQUEST is answered and surfaces as a closure", async () => {
    const { sock, tunnel } = await connected();
    const closed: string[] = [];
    tunnel.onClosed = (r) => { closed.push(r); };

    // DISCONNECT_REQUEST from the gateway: [channel, reserved] + its control HPAI.
    sock.inject(knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([CHANNEL, 0x00]), hpai("198.51.100.2", 3671)])));
    await tick();

    // We answer DISCONNECT_RESPONSE [channel, status 0] so the gateway stops retransmitting...
    const res = sock.sent.filter((f) => f.readUInt16BE(2) === SVC.DISCONNECT_RES);
    expect(res.length).toBe(1);
    expect([...res[0]!.subarray(6)]).toEqual([CHANNEL, 0x00]);
    // ...and the closure is surfaced rather than swallowed. Without the handler the frame is
    // ignored, onClosed never fires, and the status stays a stale "connected".
    expect(closed.length).toBe(1);
    expect(closed[0]!).toContain("DISCONNECT_REQUEST");
    expect(sock.closed).toBe(true);
  });

  test("a socket error mid-connect fails fast with TUNNEL_CONNECT_FAILED, not an uncaught exception", async () => {
    // On Linux a CONNECT_REQ to a gateway IP with nothing listening draws an ICMP port-unreachable,
    // delivered back as an async ECONNREFUSED on the UDP socket's error channel. With no handler this
    // is an uncaught exception that crashes the run (it did, in CI on Linux, while passing on macOS
    // which never surfaces it). The handler must turn it into a coded connect failure instead.
    const sock = new FakeUdpSocket();
    const tunnel = new KnxIpTunnel("192.0.2.10", 3671, () => sock);
    const p = tunnel.connect().then(() => null, (e: unknown) => e as Error & { code?: string });
    await tick(); // bind resolves, CONNECT_REQ goes out, the waiter is armed
    sock.injectError(new Error("ECONNREFUSED: connection refused, recv"));
    const err = await p;
    expect(err).not.toBeNull();
    expect(err!.name).toBe("KnxError");
    expect(err!.code).toBe("TUNNEL_CONNECT_FAILED");
    expect(err!.message).toContain("192.0.2.10:3671");
  });

  test("a socket error AFTER connect is reported as a closure, not thrown", async () => {
    const { sock, tunnel } = await connected();
    const closed: string[] = [];
    tunnel.onClosed = (r) => closed.push(r);
    sock.injectError(new Error("ECONNREFUSED: connection refused, recv"));
    await tick();
    // The tunnel is already up, so there is no connect to fail: the error surfaces through onClosed
    // (a dead channel the caller can react to) rather than crashing.
    expect(closed.length).toBe(1);
    expect(closed[0]!).toContain("error");
  });
});

describe("KnxIpTunnel: why a gateway refused the connection", () => {
  async function refusedWith(status: number) {
    const sock = new FakeUdpSocket();
    const tunnel = new KnxIpTunnel("192.0.2.10", 3671, () => sock);
    const p = tunnel.connect().catch((e) => e);
    await tick();
    sock.inject(Buffer.from([0x06, 0x10, 0x02, 0x06, 0x00, 0x08, 0x00, status]));
    return (await p) as { code: string; message: string };
  }

  test("E_KNX_CONNECTION (0x27) says the gateway has lost its bus, not that it is busy", async () => {
    const e = await refusedWith(0x27);
    expect(e.code).toBe("TUNNEL_INTERFACE_UNAVAILABLE");
    expect(e.message).toContain("0x27");
  });

  test("any other status stays a plain refusal that names the status", async () => {
    const e = await refusedWith(0x24);
    expect(e.code).toBe("TUNNEL_CONNECT_REJECTED");
    expect(e.message).toContain("0x24");
  });
});
