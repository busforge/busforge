import { test, expect, describe } from "bun:test";
import { KnxIpTunnel } from "../src/index.ts";
import type { TunnelSocket } from "../src/connection.ts";
import { SVC, knxFrame } from "../src/frame.ts";
import { KnxError } from "../src/errors.ts";

// A KNXnet/IP gateway keeps sending until it is told to stop, so a TUNNEL_REQ can land in the
// microseconds between our DISCONNECT_REQ and the socket actually closing. The handler for it is
// async: it ACKs the frame. That ACK was being written into a socket that had already been closed,
// which throws deep in node's dgram internals ("null is not an object (evaluating 'kStateSymbol')").
//
// It never surfaced, because the handler's promise was dropped on the floor. Once errors were no
// longer swallowed, every ordinary disconnect started logging a failure that was not one.
//
// The fix is not to log it more quietly. It is that a tunnel which is tearing down has no channel
// left to answer on, so it does not answer.

class FakeSocket implements TunnelSocket {
  sent: Buffer[] = [];
  closedAt: number | null = null;
  private handler: ((m: Buffer) => void) | null = null;
  private n = 0;

  // The real socket binds on a later turn; tests that race a connect set this.
  deferBind = false;
  bind(_port: number, cb: () => void) { if (this.deferBind) setTimeout(cb, 0); else cb(); }
  on(ev: "message", cb: (m: Buffer) => void): void;
  on(ev: "error", cb: (e: Error) => void): void;
  on(ev: "message" | "error", cb: ((m: Buffer) => void) | ((e: Error) => void)) { if (ev === "message") this.handler = cb as (m: Buffer) => void; }
  // The real socket completes a send on a later turn; tests that race a teardown set this.
  deferSend = false;
  send(buf: Buffer, _port: number, _ip: string, cb: (err: Error | null) => void) {
    // The real thing throws here once closed. Reproduce that, or the test proves nothing.
    if (this.closedAt !== null) throw new TypeError("null is not an object (evaluating 'kStateSymbol')");
    this.sent.push(Buffer.from(buf));
    this.n++;
    if (this.deferSend) setTimeout(() => cb(null), 0);
    else cb(null);
  }
  close() {
    // Bun's dgram throws on a second close() just as it does on a send after the first one.
    if (this.closedAt !== null) throw new TypeError("null is not an object (evaluating 'kStateSymbol')");
    this.closedAt = this.n;
  }

  /** Deliver a datagram from the "gateway". */
  deliver(m: Buffer) { this.handler?.(m); }
}

// A CONNECT_RES the tunnel will accept: channel 7, and an IA in the CRD where connect() reads it.
const connectRes = () => knxFrame(SVC.CONNECT_RES, Buffer.concat([
  Buffer.from([0x07, 0x00]),                          // channel 7, status OK
  Buffer.from([0x08, 0x01, 198, 51, 100, 9, 0x0e, 0x57]), // HPAI (8 bytes)
  Buffer.from([0x04, 0x04, 0x11, 0x0a]),              // CRD: len, type, IA 1.1.10
]));

// An inbound TUNNEL_REQ carrying a minimal cEMI L_Data.ind. Answering it means sending a TUNNEL_ACK.
const tunnelReq = (seq: number) => knxFrame(SVC.TUNNEL_REQ, Buffer.concat([
  Buffer.from([0x04, 0x07, seq, 0x00]),                                  // connection header
  Buffer.from([0x29, 0x00, 0xbc, 0xd0, 0x11, 0x0b, 0x11, 0x01, 0x01, 0x00, 0x81]), // cEMI L_Data.ind
]));

const openTunnel = async () => {
  const sock = new FakeSocket();
  const tun = new KnxIpTunnel("198.51.100.9", 3671, () => sock);
  const connecting = tun.connect();
  await Promise.resolve();
  sock.deliver(connectRes());
  await connecting;
  return { sock, tun };
};

describe("KnxIpTunnel teardown", () => {
  test("a datagram that lands DURING teardown is not answered, and does not throw", async () => {
    const { sock, tun } = await openTunnel();
    const beforeDisconnect = sock.sent.length;

    // The gateway is still talking as we tear the channel down.
    const disconnecting = tun.disconnect();
    sock.deliver(tunnelReq(1));
    await disconnecting;

    // Exactly one frame went out after connect: the DISCONNECT_REQ. No TUNNEL_ACK was attempted,
    // which is the whole point — attempting it is what blew up on the closed socket.
    const after = sock.sent.slice(beforeDisconnect);
    expect(after.length).toBe(1);
    expect(after[0].readUInt16BE(2)).toBe(SVC.DISCONNECT_REQ);
    expect(sock.closedAt).not.toBeNull();
  });

  test("a datagram that lands AFTER the socket is closed is ignored, not sent into it", async () => {
    const { sock, tun } = await openTunnel();
    await tun.disconnect();
    expect(sock.closedAt).not.toBeNull();

    // FakeSocket.send() throws once closed, exactly like node's does. If the tunnel still tried to
    // ACK this, the throw would escape the handler and the test would fail here.
    expect(() => sock.deliver(tunnelReq(2))).not.toThrow();
  });

  test("before teardown, an inbound TUNNEL_REQ IS acknowledged (the guard must not silence a live tunnel)", async () => {
    const { sock, tun } = await openTunnel();
    const before = sock.sent.length;

    sock.deliver(tunnelReq(3));
    await Promise.resolve(); // the handler is async

    const acks = sock.sent.slice(before).filter((f) => f.readUInt16BE(2) === SVC.TUNNEL_ACK);
    expect(acks.length).toBe(1);
    expect(acks[0][8]).toBe(3); // the ACK carries the gateway's sequence number back
    await tun.disconnect();
  });

  // A bridge drops a UDP channel whose client left two of its tunnelling requests unacknowledged, and
  // says so with a DISCONNECT_REQUEST. The tunnel closes its socket on it. The download still running
  // on that tunnel must then learn that the tunnel is closed, not hit the closed socket: Bun's dgram
  // answers that with a bare TypeError ("evaluating 'kStateSymbol'"), which carries no TUNNEL_* code
  // and so hid the real cause and kept the device layer from opening the link again.
  test("a send after the gateway closed the channel fails as TUNNEL_CLOSED, without touching the closed socket", async () => {
    const { sock, tun } = await openTunnel();
    sock.deliver(knxFrame(SVC.DISCONNECT_REQ, Buffer.from([0x07, 0x00, 0x08, 0x01, 0, 0, 0, 0, 0, 0])));
    await Promise.resolve();
    expect(sock.closedAt).not.toBeNull();

    const cemi = Buffer.from([0x11, 0x00, 0xbc, 0xe0, 0x11, 0x0a, 0x11, 0x0b, 0x00, 0x80]);
    const err = await tun.sendCemi(cemi).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("TUNNEL_CLOSED");
  });

  test("a disconnect after the gateway closed the channel resolves, without closing the socket twice", async () => {
    const { sock, tun } = await openTunnel();
    sock.deliver(knxFrame(SVC.DISCONNECT_REQ, Buffer.from([0x07, 0x00, 0x08, 0x01, 0, 0, 0, 0, 0, 0])));
    await Promise.resolve();
    expect(sock.closedAt).not.toBeNull();
    await tun.disconnect();
  });

  test("a send waiting for its ACK when the gateway closes the channel fails at once as TUNNEL_CLOSED", async () => {
    const { sock, tun } = await openTunnel();
    const cemi = Buffer.from([0x11, 0x00, 0xbc, 0xe0, 0x11, 0x0a, 0x11, 0x0b, 0x00, 0x80]);
    const sending = tun.sendCemi(cemi).then(() => null, (e: unknown) => e);
    await Promise.resolve();
    const sent = sock.sent.length;
    const t0 = Date.now();
    sock.deliver(knxFrame(SVC.DISCONNECT_REQ, Buffer.from([0x07, 0x00, 0x08, 0x01, 0, 0, 0, 0, 0, 0])));
    const err = await sending;
    expect(err).toBeInstanceOf(KnxError);
    expect((err as KnxError).code).toBe("TUNNEL_CLOSED");
    // Released by the closure, not by the 1.5 s ACK timeout, and not repeated into the closed socket.
    expect(Date.now() - t0).toBeLessThan(500);
    expect(sock.sent.slice(sent).map((f) => f.readUInt16BE(2))).toEqual([SVC.DISCONNECT_RES]);
  });

  // A second disconnect returns at once while the first still sends its DISCONNECT_REQ; a reconnect
  // right after it (KnxDevice.reopenTransport) must not have its new socket closed by the first.
  test("a disconnect still in progress closes its own socket, not the one a reconnect opened meanwhile", async () => {
    const socks: FakeSocket[] = [];
    const tun = new KnxIpTunnel("198.51.100.9", 3671, () => { const s = new FakeSocket(); socks.push(s); return s; });
    const open = async () => { const c = tun.connect(); await new Promise((r) => setTimeout(r, 0)); socks.at(-1)!.deliver(connectRes()); await c; };
    await open();
    socks[0].deferSend = true;
    const first = tun.disconnect();
    await tun.disconnect();
    await open();
    await first;
    expect(socks[0].closedAt).not.toBeNull();
    expect(socks[1].closedAt).toBeNull();
  });

  test("a disconnect releases every send waiting for its ACK, at once, as TUNNEL_CLOSED", async () => {
    const { tun } = await openTunnel();
    const cemi = Buffer.from([0x11, 0x00, 0xbc, 0xe0, 0x11, 0x0a, 0x11, 0x0b, 0x00, 0x80]);
    // Two sends in flight on the one tunnel (a T_ACK goes out beside a request).
    const sends = [tun.sendCemi(cemi), tun.sendCemi(cemi)].map((p) => p.then(() => null, (e: unknown) => e));
    await Promise.resolve();
    const t0 = Date.now();
    await tun.disconnect();
    for (const err of await Promise.all(sends)) expect((err as KnxError).code).toBe("TUNNEL_CLOSED");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("a disconnect while a reconnect is still binding closes the socket being opened", async () => {
    const socks: FakeSocket[] = [];
    const tun = new KnxIpTunnel("198.51.100.9", 3671, () => { const s = new FakeSocket(); s.deferBind = socks.length > 0; socks.push(s); return s; });
    const first = tun.connect(); await Promise.resolve(); socks[0].deliver(connectRes()); await first;
    await tun.disconnect();
    const reconnecting = tun.connect().then(() => null, (e: unknown) => e);
    await tun.disconnect();
    expect(socks[1].closedAt).not.toBeNull();
    await reconnecting;
  });
});
