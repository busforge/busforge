import { test, expect, describe } from "bun:test";
import { KnxIpTunnel, type TunnelSocket } from "../src/connection.ts";
import { KnxIpServer, type ServerSocket } from "../src/ipserver.ts";
import { iaToNum, type Endpoint } from "../src/frame.ts";
import type { KnxTransport } from "../src/transport.ts";

// Cross-implementation liveness test: the REAL KnxIpTunnel talks to the REAL KnxIpServer over an
// in-memory socket pair, so the actual CONNECT / CONNECTIONSTATE / DISCONNECT frames one side emits
// are parsed by the other. This is what closes finding 1 ("/bus/status lied on a reaped tunnel")
// against busforge's own bridge, one of the exact spec-strict gateways the finding named. It is NOT
// a third-party-gateway hardware test; see docs/connections.md for what remains unproven.
//
// The two implementations expose injectable socket seams (TunnelSocket, ServerSocket) and the server
// an injectable clock, so the 120 s reap window is driven by advancing the clock instead of waiting.

const IFACE_IA = iaToNum("1.1.250");
const CLIENT: Endpoint = { address: "198.51.100.50", port: 55000 };
const HEARTBEAT_TIMEOUT_MS = 120_000; // the server's window (ipserver.ts), mirrored here for the clock math
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// A minimal bus for the server to put on the network; it never needs to carry a telegram here.
class FakeBus implements KnxTransport {
  assignedIa = IFACE_IA;
  onCemi: KnxTransport["onCemi"] = null;
  onRawCemi: ((cemi: Buffer) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): Promise<void> { return Promise.resolve(); }
  sendCemi(): Promise<void> { return Promise.resolve(); }
}

// The in-memory wire between one client and the server. Datagrams are delivered on a macrotask, as
// real UDP would, so the promise chains on both sides resolve exactly as over a socket.
class Wire {
  clientMsg: ((m: Buffer) => void) | null = null;
  serverMsg: ((m: Buffer, from: Endpoint) => void) | null = null;
  severed = false; // client -> server can be cut, to model a gateway that stopped answering
  fromClient(buf: Buffer): void {
    if (this.severed) return;
    const cb = this.serverMsg;
    if (cb) setTimeout(() => cb(Buffer.from(buf), CLIENT), 0);
  }
  toClient(buf: Buffer, to: Endpoint): void {
    const cb = this.clientMsg;
    if (cb && to.address === CLIENT.address && to.port === CLIENT.port) setTimeout(() => cb(Buffer.from(buf)), 0);
  }
}

interface Rig { tunnel: KnxIpTunnel; server: KnxIpServer; wire: Wire; clock: { t: number }; }

async function connect(): Promise<Rig> {
  const wire = new Wire();
  const clock = { t: 1_000_000 };
  const clientSock: TunnelSocket = {
    bind: (_p, cb) => cb(),
    on: (_ev, cb) => { wire.clientMsg = cb; },
    send: (buf, _port, _ip, cb) => { wire.fromClient(buf); cb(); },
    close: () => { wire.clientMsg = null; },
  };
  const serverSock: ServerSocket = {
    bind: (_p, cb) => cb(),
    onMessage: (cb) => { wire.serverMsg = cb; },
    onError: () => {},
    addMembership: () => {},
    send: (buf, to) => wire.toClient(buf, to),
    close: () => { wire.serverMsg = null; },
  };
  const server = new KnxIpServer({ transport: new FakeBus(), createSocket: () => serverSock, now: () => clock.t, name: "Bench" });
  await server.start();
  const tunnel = new KnxIpTunnel("198.51.100.99", 3671, () => clientSock);
  await tunnel.connect();
  return { tunnel, server, wire, clock };
}

describe("KNXnet/IP tunnel liveness against the real server", () => {
  test("connects and takes a channel on the server", async () => {
    const { tunnel, server } = await connect();
    expect(server.channels.size).toBe(1);
    expect(tunnel.assignedIa).toBe(IFACE_IA); // parsed from the server's real CONNECT_RESPONSE
    await tunnel.disconnect();
  });

  test("the client's heartbeat keeps a quiet channel alive past the server's 120 s reap window", async () => {
    const { tunnel, server, clock } = await connect();
    const closed: string[] = [];
    tunnel.onClosed = (r) => { closed.push(r); };

    // Move past the reap window, then send one heartbeat. The server answers it AND records it as
    // activity, so the reap that follows must NOT drop the channel.
    clock.t += HEARTBEAT_TIMEOUT_MS + 1_000;
    await tunnel["heartbeat"](); // drive one round directly; the 60 s interval never fires in a test
    server["reap"]();

    expect(server.channels.size).toBe(1); // survived, because the heartbeat was heard
    expect(closed).toEqual([]);
    await tunnel.disconnect();
  });

  test("without a heartbeat the server reaps the channel and the client reports the closure", async () => {
    const { tunnel, server, clock } = await connect();
    const closed: string[] = [];
    tunnel.onClosed = (r) => { closed.push(r); };

    // No heartbeat: the channel goes silent past the window and the server drops it, sending a real
    // DISCONNECT_REQUEST the client must answer and surface instead of staying "connected".
    clock.t += HEARTBEAT_TIMEOUT_MS + 1_000;
    server["reap"]();
    expect(server.channels.size).toBe(0);
    await tick(); await tick(); // let the DISCONNECT_REQUEST reach the client and its RESPONSE go back

    expect(closed.length).toBe(1);
    expect(closed[0]!).toContain("DISCONNECT_REQUEST");
    expect(tunnel["closed"]).toBe(true);
  });

  test("a gateway that answers no heartbeat is brought down honestly by the client", async () => {
    const { tunnel, wire } = await connect();
    const closed: string[] = [];
    tunnel.onClosed = (r) => { closed.push(r); };

    // The gateway stops answering: the client's three connection-state attempts all time out, and it
    // must reap itself rather than keep reporting a live connection over a dead one.
    tunnel["stateTimeoutMs"] = 5;
    wire.severed = true;
    await tunnel["heartbeat"]();

    expect(closed.length).toBe(1);
    expect(closed[0]!).toContain("did not answer three connection-state requests");
    expect(tunnel["closed"]).toBe(true);
  });
});
