import { test, expect, describe, mock, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  connectResult: Promise<void> = Promise.resolve();
  disconnectResult: Promise<void> = Promise.resolve();
  disconnectCalls = 0;
  async connect() { this.connectCalls++; await this.connectResult; }
  async sendCemi() {}
  async disconnect() { this.disconnectCalls++; await this.disconnectResult; }
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
  id: "c1", name: "gw", type: "ip", host: "198.51.100.10", port: 3671, ipTransport: "auto",
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

const { createState, handleApi } = await import("../src/app.ts");
const { createProject, setProjectConnection } = await import("../src/db/projects.ts");
const { createConnection } = await import("../src/db/connections.ts");

for (const type of ["usb", "ip"] as const) {
  test(`${type}: API monitor connect refuses while a management job owns the interface`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "bus-owner-"));
    const state = createState({ dbPath: ":memory:", dataDir: dir });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      createProject(state.db, "p", "Test", 0);
      createConnection(state.db, "c", { ...conn, type, usbVendorId: 1, usbProductId: 2 }, 0);
      setProjectConnection(state.db, "p", "c");
      const job = state.queue.enqueue({ projectId: "p", deviceId: "d", deviceName: "test", ia: "1.1.1", kind: "flash-params", writes: true }, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const count = created.length;
      const res = (await handleApi(new Request("http://x/api/projects/p/bus/connect", { method: "POST" }), state))!;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "BUS_BUSY" } });
      expect(created.length).toBe(count);
      release.resolve();
      await job;
      const reconnect = (await handleApi(new Request("http://x/api/projects/p/bus/connect", { method: "POST" }), state))!;
      expect(reconnect.status).toBe(200);
      expect(state.bus.status).toBe("connected");
    } finally {
      release.resolve();
      await state.bus.disconnect();
      state.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("management waits for a pending monitor connect and closes it before running", async () => {
  const bus = new Bus();
  const gate = Promise.withResolvers<void>();
  const factory = makeTransportImpl;
  const tunnel = new FakeTransport();
  tunnel.connectResult = gate.promise;
  makeTransportImpl = () => tunnel;
  let ran = false;
  try {
    const pendingConnect = bus.connect("p", conn);
    const operation = bus.withExclusiveOperation(async () => {
      ran = true;
      expect(tunnel.disconnectCalls).toBe(1);
      expect(bus.status).toBe("disconnected");
    });
    expect(await bus.connect("other", conn).catch((error: unknown) => error)).toMatchObject({ code: "BUS_BUSY" });
    expect(ran).toBe(false);
    gate.resolve();
    await pendingConnect;
    await operation;
    expect(ran).toBe(true);
    expect(bus.activeProjectId).toBeNull();
  } finally {
    gate.resolve();
    makeTransportImpl = factory;
    await bus.disconnect();
  }
});

test("failed management releases ownership and leaves the monitor accurately disconnected", async () => {
  const bus = new Bus();
  await bus.connect("p", conn);
  expect(await bus.withExclusiveOperation(async () => { throw new Error("read failed"); }).catch((error: unknown) => error)).toMatchObject({ message: "read failed" });
  expect(bus.status).toBe("disconnected");
  expect(bus.activeProjectId).toBeNull();
  await bus.connect("p", conn);
  expect(bus.status).toBe("connected");
  await bus.disconnect();
});

test("concurrent monitor connect/disconnect serializes without a late live handle", async () => {
  const bus = new Bus();
  const gate = Promise.withResolvers<void>();
  const tunnel = new FakeTransport();
  tunnel.connectResult = gate.promise;
  const factory = makeTransportImpl;
  makeTransportImpl = () => tunnel;
  try {
    const connect = bus.connect("p", conn);
    const disconnect = bus.disconnect();
    gate.resolve();
    await Promise.all([connect, disconnect]);
    expect(tunnel.disconnectCalls).toBe(1);
    expect(bus.status).toBe("disconnected");
    expect(bus.activeProjectId).toBeNull();
  } finally { gate.resolve(); makeTransportImpl = factory; }
});

test("a failed monitor close prevents management from opening another transport", async () => {
  const bus = new Bus();
  await bus.connect("p", conn);
  const tunnel = created.at(-1)!;
  tunnel.disconnectResult = Promise.reject(new Error("close failed"));
  let ran = false;
  expect(await bus.withExclusiveOperation(async () => { ran = true; }).catch((error: unknown) => error)).toMatchObject({ message: "close failed" });
  expect(ran).toBe(false);
  tunnel.disconnectResult = Promise.resolve();
  await bus.withExclusiveOperation(async () => { ran = true; });
  expect(ran).toBe(true);
  expect(bus.status).toBe("disconnected");
});

test("failed monitor connection and cleanup retain the handle until it can be closed", async () => {
  const bus = new Bus();
  const tunnel = new FakeTransport();
  const factory = makeTransportImpl;
  tunnel.connectResult = Promise.reject(new Error("connect failed"));
  tunnel.disconnectResult = Promise.reject(new Error("cleanup failed"));
  makeTransportImpl = () => tunnel;
  try {
    expect(await bus.connect("p", conn).catch((error: unknown) => error)).toMatchObject({ message: "connect failed" });
    expect(bus.status).toBe("disconnected");
    let ran = false;
    expect(await bus.withExclusiveOperation(async () => { ran = true; }).catch((error: unknown) => error)).toMatchObject({ message: "cleanup failed" });
    expect(ran).toBe(false);
    tunnel.disconnectResult = Promise.resolve();
    await bus.withExclusiveOperation(async () => { ran = true; });
    expect(ran).toBe(true);
  } finally {
    makeTransportImpl = factory;
    tunnel.disconnectResult = Promise.resolve();
    await bus.disconnect();
  }
});

test("close releases the tunnel and refuses every connect that had not opened yet", async () => {
  const bus = new Bus();
  const gate = Promise.withResolvers<void>();
  const tunnel = new FakeTransport();
  tunnel.connectResult = gate.promise;
  const factory = makeTransportImpl;
  makeTransportImpl = () => tunnel;
  try {
    const opening = bus.connect("p", conn);
    for (let i = 0; i < 10 && tunnel.connectCalls === 0; i++) await Promise.resolve();
    expect(tunnel.connectCalls).toBe(1); // already opening when the shutdown starts
    const queued = bus.connect("other", conn).catch((error: unknown) => error);
    const closing = bus.close();
    gate.resolve();
    await opening;
    expect(await queued).toMatchObject({ code: "SERVER_SHUTTING_DOWN" });
    await closing;
    expect(tunnel.disconnectCalls).toBe(1);
    expect(bus.status).toBe("disconnected");
    expect(await bus.connect("p", conn).catch((error: unknown) => error)).toMatchObject({ code: "SERVER_SHUTTING_DOWN" });
  } finally { gate.resolve(); makeTransportImpl = factory; }
});
