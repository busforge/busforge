import { test, expect, describe, mock, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnxTransport } from "@busforge/knx";
import type { Connection } from "../src/db/connections.ts";
import type { Telegram } from "../src/telegram.ts";

// The server half of the "keep the status honest" guarantee: when a live tunnel goes down on its
// own (a heartbeat the gateway stopped answering, an inbound DISCONNECT_REQUEST, a USB error), the
// transport fires onClosed and the Bus must flip /bus/status away from a stale "connected". The
// tunnel-level firing is covered in packages/knx; this pins the Bus reaction, which is where the
// status flip and the stale-callback guard live.

// A controllable stand-in for the real transport. makeTransport is delegated (below) to hand these
// out during these tests so no socket is opened; the Bus assigns its own onClosed onto the instance
// during connect().
class FakeTransport implements KnxTransport {
  assignedIa = 0;
  sent: Buffer[] = [];
  onCemi: KnxTransport["onCemi"] = null;
  onRawCemi: KnxTransport["onRawCemi"] = null;
  onClosed: KnxTransport["onClosed"] = null;
  connectCalls = 0;
  connectResult: Promise<void> = Promise.resolve();
  disconnectResult: Promise<void> = Promise.resolve();
  disconnectCalls = 0;
  async connect() { this.connectCalls++; await this.connectResult; }
  async sendCemi(cemi: Buffer) { this.sent.push(Buffer.from(cemi)); }
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
const { putGroupKeys } = await import("../src/db/groupKeys.ts");
const { putGroupSenders } = await import("../src/db/groupSenders.ts");
const { createGroupAddress, createGroupRange } = await import("../src/db/groupedit.ts");
const { openSecureGroupTpdu } = await import("@busforge/knx");
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

describe("Bus: secured group telegrams", () => {
  // xknx test_data_secure_group_receive: 4.0.9 -> 0/4/0, GroupValueResponse 74 29 29.
  const key = Buffer.from("dfdf23a59fbb40404091d1c162087e8b", "hex");
  const frame = () => Buffer.from("03f110002446cfef4ac085e7092ab062b44d", "hex");
  async function monitor(keys: Map<number, Buffer>) {
    const bus = new Bus(() => 1);
    const seen: Telegram[] = [];
    bus.subscribe((t) => seen.push(t));
    await bus.connect("proj-s", conn, keys);
    const tunnel = created.at(-1)!;
    return { bus, seen, deliver: (tpdu: Buffer, src = 0x4009) => tunnel.onCemi!(src, 0x0400, tpdu, true) };
  }

  test("decrypts with the project's key and shows the inner value", async () => {
    const { bus, seen, deliver } = await monitor(new Map([[0x0400, key]]));
    deliver(frame());
    expect(seen).toEqual([{ ts: 1, src: "4.0.9", dst: "0/4/0", dstRaw: 0x0400, kind: "GroupValueResponse", raw: "742929", security: "decrypted" }]);
    await bus.disconnect();
  });

  test("without a key, a wrong key or a tampered frame there is no value", async () => {
    const none = await monitor(new Map());
    none.deliver(frame());
    expect(none.seen[0]).toMatchObject({ kind: "Unknown", raw: "", security: "noKey" });
    await none.bus.disconnect();
    const wrong = Buffer.from(key); wrong[3] ^= 0x80;
    const bad = await monitor(new Map([[0x0400, wrong]]));
    bad.deliver(frame());
    expect(bad.seen[0]).toMatchObject({ kind: "Unknown", raw: "", security: "authFailed" });
    await bad.bus.disconnect();
  });

  test("the identical frame again shows no second value; a new session has no history", async () => {
    const { bus, seen, deliver } = await monitor(new Map([[0x0400, key]]));
    deliver(frame());
    deliver(frame()); // a replay, or a link-layer repetition: indistinguishable without the repeat flag
    expect(seen.map((t) => [t.security, t.raw])).toEqual([["decrypted", "742929"], ["replay", ""]]);
    await bus.disconnect();
    // A new monitor session starts without history, so the same frame is accepted once more.
    const again = await monitor(new Map([[0x0400, key]]));
    again.deliver(frame());
    expect(again.seen[0].security).toBe("decrypted");
    await again.bus.disconnect();
  });

  test("a sequence not above the sender's last accepted one is a replay, without a value", async () => {
    const { secureEncode } = await import("@busforge/knx");
    const at = (seq: number, value: number) => Buffer.concat([Buffer.from("03f1", "hex"), secureEncode({
      key, src: 0x4009, dst: 0x0400, dstIsGroup: true, seq: Buffer.from(seq.toString(16).padStart(12, "0"), "hex"),
      scf: 0x10, tpci: 0x03, aad: Buffer.from([0x10]), plaintext: Buffer.from([0x00, 0x80 | value]),
    })]);
    const { bus, seen, deliver } = await monitor(new Map([[0x0400, key]]));
    deliver(at(5, 1));
    deliver(at(3, 0)); // older
    deliver(at(5, 0)); // same sequence, different content
    deliver(at(6, 0));
    expect(seen.map((t) => [t.security, t.raw])).toEqual([["decrypted", "01"], ["replay", ""], ["replay", ""], ["decrypted", "00"]]);
    await bus.disconnect();
  });

  test("plain telegrams carry no security state", async () => {
    const { bus, seen, deliver } = await monitor(new Map([[0x0400, key]]));
    deliver(Buffer.from("0081", "hex"));
    expect(seen[0]).toEqual({ ts: 1, src: "4.0.9", dst: "0/4/0", dstRaw: 0x0400, kind: "GroupValueWrite", raw: "01" });
    await bus.disconnect();
  });
});

describe("sending group telegrams through the monitor connection", () => {
  const key = Buffer.alloc(16, 0x5a);
  async function setup(opts: { secured?: boolean; sender?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bus-send-"));
    const state = createState({ dbPath: ":memory:", dataDir: dir });
    createProject(state.db, "p", "Test", 0);
    createConnection(state.db, "c", conn, 0);
    setProjectConnection(state.db, "p", "c");
    const main = createGroupRange(state.db, "p", null, "M", 0);
    const mid = createGroupRange(state.db, "p", main, "S", 0);
    createGroupAddress(state.db, "p", mid, 1, "Switch", "1.001");
    createGroupAddress(state.db, "p", mid, 2, "Temperature", "9.001");
    createGroupAddress(state.db, "p", mid, 3, "Unknown", "");
    if (opts.secured) putGroupKeys(state.db, "p", [{ raw: 1, key, source: "import" }, { raw: 2, key, source: "import" }], state.masterKey);
    if (opts.sender) putGroupSenders(state.db, "p", [{ gaRaw: 1, ia: opts.sender, source: "import" }]);
    const seen: Telegram[] = [];
    state.bus.subscribe((t) => seen.push(t));
    const send = async (body: unknown) => {
      const res = (await handleApi(new Request("http://x/api/projects/p/bus/group", { method: "POST", body: JSON.stringify(body) }), state))!;
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    const connect = async () => {
      await handleApi(new Request("http://x/api/projects/p/bus/connect", { method: "POST" }), state);
      const t = created.at(-1)!; t.assignedIa = 0x1164; return t;
    };
    const close = async () => { await state.bus.disconnect(); state.db.close(); rmSync(dir, { recursive: true, force: true }); };
    return { state, seen, send, connect, close };
  }
  const tpduOf = (cemi: Buffer) => cemi.subarray(9);

  test("refuses while the monitor is not connected", async () => {
    const s = await setup();
    expect(await s.send({ ga: 1, service: "write", value: "01" })).toMatchObject({ status: 409, body: { error: { code: "BUS_NOT_CONNECTED" } } });
    await s.close();
  });

  test("a plain write goes out from the tunnel's address; the monitor shows only what the bus carried", async () => {
    const s = await setup();
    const t = await s.connect();
    expect(await s.send({ ga: 1, service: "write", value: "01" })).toMatchObject({ status: 200, body: { handedToInterface: true, secured: false } });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].readUInt16BE(4)).toBe(0x1164);
    expect(tpduOf(t.sent[0]).toString("hex")).toBe("0081");
    // The interface's confirmation is not read, so the telegram is not recorded as seen on the bus.
    expect(s.seen).toEqual([]);
    await s.close();
  });

  test("the value form follows the address's datapoint type", async () => {
    const s = await setup();
    const t = await s.connect();
    await s.send({ ga: 2, service: "write", value: "0c1a" }); // 9.001: two octets after the APCI
    await s.send({ ga: 2, service: "write", value: "20" });   // a 1-byte value to a non-switching type stays a byte
    expect(t.sent.map((c) => tpduOf(c).toString("hex"))).toEqual(["00800c1a", "008020"]);
    expect(await s.send({ ga: 1, service: "write", value: "40" })).toMatchObject({ status: 400, body: { error: { code: "GROUP_VALUE_INVALID" } } }); // 6 bits only
    expect(await s.send({ ga: 3, service: "write", value: "01" })).toMatchObject({ status: 400, body: { error: { code: "GROUP_VALUE_AMBIGUOUS" } } });
    await s.send({ ga: 3, service: "write", value: "0102" }); // longer than 6 bits: only one form
    expect(tpduOf(t.sent.at(-1)!).toString("hex")).toBe("00800102");
    await s.close();
  });

  test("an address that is not in the project, or not a number, is refused", async () => {
    const s = await setup();
    await s.connect();
    expect(await s.send({ ga: 99, service: "read" })).toMatchObject({ status: 404, body: { error: { code: "GA_NOT_FOUND" } } });
    expect(await s.send({ ga: "1", service: "read" })).toMatchObject({ status: 404, body: { error: { code: "GA_NOT_FOUND" } } });
    expect(await s.send({ ga: true, service: "read" })).toMatchObject({ status: 404 });
    await s.close();
  });

  test("a read goes out as GroupValueRead", async () => {
    const s = await setup();
    const t = await s.connect();
    await s.send({ ga: 1, service: "read" });
    expect(tpduOf(t.sent[0]).toString("hex")).toBe("0000");
    await s.close();
  });

  test("a secured address is refused unless the tunnel's address is one of its senders", async () => {
    const s = await setup({ secured: true, sender: "1.2.50" });
    const t = await s.connect();
    expect(await s.send({ ga: 1, service: "write", value: "01" })).toMatchObject({ status: 409, body: { error: { code: "SECURE_SENDER_NOT_LISTED" } } });
    expect(t.sent).toHaveLength(0);
    await s.close();
  });

  test("a secured write is encrypted with the address's key at a fresh sequence each time", async () => {
    const s = await setup({ secured: true, sender: "1.1.100" });
    const t = await s.connect();
    await s.send({ ga: 1, service: "write", value: "01" });
    await s.send({ ga: 1, service: "write", value: "00" });
    const opened = t.sent.map((c) => openSecureGroupTpdu(0x1164, 1, tpduOf(c), key));
    expect(opened.map((o) => o.state)).toEqual(["decrypted", "decrypted"]);
    const [a, b] = opened as { apdu: Buffer; seq: bigint }[];
    expect([a.apdu.toString("hex"), b.apdu.toString("hex")]).toEqual(["0081", "0080"]);
    expect(b.seq).toBeGreaterThan(a.seq);
    await s.close();
  });

  test("a secured value that does not fit a standard frame is refused, not sent oversized", async () => {
    const s = await setup({ secured: true, sender: "1.1.100" });
    const t = await s.connect();
    putGroupSenders(s.state.db, "p", [{ gaRaw: 2, ia: "1.1.100", source: "import" }]);
    expect(await s.send({ ga: 2, service: "write", value: "0c1a" })).toMatchObject({ status: 400, body: { error: { code: "SECURE_VALUE_TOO_LONG" } } });
    expect(t.sent).toHaveLength(0);
    await s.close();
  });

  test("a value that does not fit the address is refused", async () => {
    const s = await setup();
    await s.connect();
    expect(await s.send({ ga: 1, service: "write", value: "zz" })).toMatchObject({ status: 400, body: { error: { code: "GROUP_VALUE_INVALID" } } });
    expect(await s.send({ ga: 1, service: "flip" })).toMatchObject({ status: 400, body: { error: { code: "GROUP_SERVICE_INVALID" } } });
    await s.close();
  });
});

