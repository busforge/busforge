import { test, expect, describe, mock, beforeAll, afterAll } from "bun:test";
import type { KnxTransport } from "@busforge/knx";
import type { Connection } from "../src/db/connections.ts";

// The server half of the "keep the status honest" guarantee: when a live tunnel goes down on its
// own (a heartbeat the gateway stopped answering, an inbound DISCONNECT_REQUEST, a USB error), the
// transport fires onClosed and the Bus must flip /bus/status away from a stale "connected". The
// tunnel-level firing is covered in packages/knx; this pins the Bus reaction, which is where the
// status flip and the stale-callback guard live.

// A controllable stand-in for the real transport. makeTransport is delegated (below) to hand these
// out during these tests so no socket is opened; the Bus assigns its own onClosed onto the instance
// during connect().
class FakeTransport implements KnxTransport {
  readonly assignedIa = 0;
  onCemi: KnxTransport["onCemi"] = null;
  onRawCemi: KnxTransport["onRawCemi"] = null;
  onClosed: KnxTransport["onClosed"] = null;
  connectCalls = 0;
  async connect() { this.connectCalls++; }
  async sendCemi() {}
  async disconnect() {}
}

// Pin the real module and delegate through a mutable impl that defaults to real. bun does not
// auto-unmock between files, so afterAll restores the real makeTransport; otherwise transport.test.ts
// (which asserts makeTransport builds concrete transports) would see our fake and fail.
const real = await import("../src/transport.ts");
const realMakeTransport = real.makeTransport;
const created: FakeTransport[] = [];
let makeTransportImpl: typeof realMakeTransport = realMakeTransport;

await mock.module("../src/transport.ts", () => ({
  ...real, // isConnectionReady stays real
  makeTransport: (c: Connection) => makeTransportImpl(c),
}));

// Bus must be imported AFTER the mock so its connect() binds the delegating makeTransport.
const { Bus } = await import("../src/bus.ts");

beforeAll(() => { makeTransportImpl = () => { const t = new FakeTransport(); created.push(t); return t; }; });
afterAll(() => { makeTransportImpl = realMakeTransport; created.length = 0; });

const conn: Connection = {
  id: "c1", name: "gw", type: "ip", host: "198.51.100.10", port: 3671,
  usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0,
};

describe("Bus liveness", () => {
  test("a tunnel closing on its own flips status to disconnected and surfaces the reason", async () => {
    const bus = new Bus();
    await bus.connect("proj-1", conn);
    expect(bus.status).toBe("connected");

    const tunnel = created.at(-1)!;
    tunnel.onClosed!("gateway stopped answering the heartbeat");

    expect(bus.status).toBe("disconnected");
    expect(bus.error).toBe("gateway stopped answering the heartbeat");
    // activeProjectId is kept so /bus/status can still tell the owning project why it dropped.
    expect(bus.activeProjectId).toBe("proj-1");
  });

  test("a stale onClosed from a replaced tunnel does not disturb the live connection", async () => {
    const bus = new Bus();
    await bus.connect("proj-1", conn);
    const first = created.at(-1)!;
    await bus.disconnect();
    await bus.connect("proj-2", conn);
    const second = created.at(-1)!;
    expect(second).not.toBe(first);
    expect(bus.status).toBe("connected");

    first.onClosed!("late close from the old tunnel");

    expect(bus.status).toBe("connected");
    expect(bus.error).toBeNull();
    expect(bus.activeProjectId).toBe("proj-2");
  });
});
