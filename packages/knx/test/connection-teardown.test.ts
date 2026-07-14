import { test, expect, describe } from "bun:test";
import { KnxIpTunnel } from "../src/index.ts";
import type { TunnelSocket } from "../src/connection.ts";
import { SVC, knxFrame } from "../src/frame.ts";

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

  bind(_port: number, cb: () => void) { cb(); }
  on(_ev: "message", cb: (m: Buffer) => void) { this.handler = cb; }
  send(buf: Buffer, _port: number, _ip: string, cb: () => void) {
    // The real thing throws here once closed. Reproduce that, or the test proves nothing.
    if (this.closedAt !== null) throw new TypeError("null is not an object (evaluating 'kStateSymbol')");
    this.sent.push(Buffer.from(buf));
    this.n++;
    cb();
  }
  close() { this.closedAt = this.n; }

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
});
