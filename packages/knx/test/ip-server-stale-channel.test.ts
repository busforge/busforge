import { test, expect, describe } from "bun:test";
import { KnxIpServer, type ServerTcpSocket, type ServerTcpListener, type ServerSocket } from "../src/ipserver.ts";
import { SVC, knxFrame, hpaiTcp } from "../src/frame.ts";
import type { KnxTransport } from "../src/transport.ts";

// Regression for the bench "tunnelling ack timeout": a TCP channel that is closed while a frame
// still sits in its per-channel send queue keeps retransmitting for ACK_TRIES × ACK_TIMEOUT_MS
// (~2 s), and when that stale queue finally gives up it called drop() which deleted the channel
// BY ID. Because ids are reused immediately, the stale queue murdered the NEXT client that reused
// its id — reproduced here with no hardware, only the server's fake seams. Fixed by an
// identity-checked drop() plus cancelling a closed channel's queue.

const noopUdp: ServerSocket = { bind: (_p, cb) => cb(), onMessage: () => {}, onError: () => {}, addMembership: () => {}, send: () => {}, close: () => {} };
const IA = (1 << 12) | (1 << 8) | 100; // 1.1.100

class FakeConn implements ServerTcpSocket {
  written: Buffer[] = [];
  dataCb: ((c: Buffer) => void) | null = null;
  closeCb: (() => void) | null = null;
  write(frame: Buffer) { this.written.push(frame); }
  onData(cb: (c: Buffer) => void) { this.dataCb = cb; }
  onClose(cb: () => void) { this.closeCb = cb; }
  end() { /* nothing to flush in the fake */ }
  destroy() { /* nothing to release in the fake */ }
  sentService(svc: number): boolean { return this.written.some((f) => f.length >= 4 && f.readUInt16BE(2) === svc); }
}

const connectReq = knxFrame(SVC.CONNECT_REQ, Buffer.concat([hpaiTcp(), hpaiTcp(), Buffer.from([0x04, 0x04, 0x02, 0x00])]));
const disconnectReq = (ch: number) => knxFrame(SVC.DISCONNECT_REQ, Buffer.concat([Buffer.from([ch, 0x00]), hpaiTcp()]));
const tunnelReq = (ch: number, seq: number) => knxFrame(SVC.TUNNEL_REQ, Buffer.concat([Buffer.from([0x04, ch, seq, 0x00]), Buffer.from([0x11, 0x00, 0xbc, 0xe0, 0x11, 0x64, 0x1b, 0x01, 0x01, 0x00, 0x81])]));
const busInd = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x12, 0x20, 0x11, 0x64, 0x01, 0x00, 0x81]); // an L_Data.ind the bridge fans to clients
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KnxIpServer: a stale channel's dying queue must not take a successor with it", () => {
  test("a new client reusing a freed channel id survives the previous channel's late drop", async () => {
    let onConn: ((s: ServerTcpSocket) => void) | null = null;
    const listener: ServerTcpListener = { listen: (_p, cb) => cb(), onConnection: (cb) => { onConn = cb; }, close: () => {} };
    const transport = { assignedIa: IA, onCemi: null, onRawCemi: null as ((c: Buffer) => void) | null, onClosed: null, connect: async () => {}, disconnect: async () => {}, sendCemi: async () => {} } as unknown as KnxTransport;
    const server = new KnxIpServer({ transport, addresses: [IA], createSocket: () => noopUdp, createTcpListener: () => listener, log: () => {} });
    await server.start();

    // Client A connects and gets channel 1.
    const a = new FakeConn();
    onConn!(a);
    a.dataCb!(connectReq);
    expect(server.channels.has(1)).toBe(true);

    // The bus fans a frame to A; A never ACKs it (a client tearing down stops ACKing at once).
    transport.onRawCemi!(busInd);
    await sleep(50);

    // A disconnects cleanly, freeing id 1 — but its un-acked frame is still retrying in the queue.
    a.dataCb!(disconnectReq(1));
    a.closeCb?.();
    expect(server.channels.has(1)).toBe(false);

    // Client B connects and is handed the freed id 1.
    const b = new FakeConn();
    onConn!(b);
    b.dataCb!(connectReq);
    expect(server.channels.has(1)).toBe(true);
    const bChannel = server.channels.get(1);

    // Wait past A's stale queue expiry (ACK_TRIES × ACK_TIMEOUT_MS ≈ 2 s), where the buggy drop fired.
    await sleep(2600);

    // B's channel must still be alive and still B's — not murdered by A's stale queue.
    expect(server.channels.get(1)).toBe(bChannel);
    // And it must still tunnel: B's request gets a TUNNEL_ACK.
    b.written.length = 0;
    b.dataCb!(tunnelReq(1, 0));
    expect(b.sentService(SVC.TUNNEL_ACK)).toBe(true);
  }, 10_000);
});
