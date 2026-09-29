import { test, expect, describe } from "bun:test";
import { KnxIpTunnel, KnxUsbTransport, KnxError, type KnxTransport } from "@busforge/knx";
import { makeTransport, isConnectionReady, AutoIpTunnel } from "../src/transport.ts";
import type { Connection } from "../src/db/connections.ts";

// A minimal KnxTransport that records what was done to it, for the AutoIpTunnel tests.
class StubTunnel implements KnxTransport {
  assignedIa = 0;
  onCemi: KnxTransport["onCemi"] = null;
  onRawCemi: KnxTransport["onRawCemi"] = null;
  onClosed: KnxTransport["onClosed"] = null;
  connected = false;
  disconnected = false;
  sent: Buffer[] = [];
  constructor(private readonly onConnect?: () => void) {}
  async connect(): Promise<void> { this.onConnect?.(); this.connected = true; }
  async sendCemi(cemi: Buffer): Promise<void> { this.sent.push(cemi); }
  async disconnect(): Promise<void> { this.disconnected = true; }
}

const conn = (over: Partial<Connection>): Connection => ({
  id: "c1", name: "c", type: "ip", host: "", port: 3671, ipTransport: "auto",
  usbVendorId: null, usbProductId: null, usbSerial: null, createdAt: 0, ...over,
});

describe("isConnectionReady", () => {
  test("ip is ready only with a host", () => {
    expect(isConnectionReady(conn({ type: "ip", host: "198.51.100.10" }))).toBe(true);
    expect(isConnectionReady(conn({ type: "ip", host: "" }))).toBe(false);
  });
  test("usb is ready only with vendor and product id", () => {
    expect(isConnectionReady(conn({ type: "usb", usbVendorId: 0x147b, usbProductId: 0x5120 }))).toBe(true);
    expect(isConnectionReady(conn({ type: "usb", usbVendorId: 0x147b, usbProductId: null }))).toBe(false);
    expect(isConnectionReady(conn({ type: "usb" }))).toBe(false);
  });
  test("null is not ready", () => {
    expect(isConnectionReady(null)).toBe(false);
  });
});

describe("makeTransport", () => {
  test("usb connection yields a USB transport", () => {
    expect(makeTransport(conn({ type: "usb", usbVendorId: 1, usbProductId: 2 }))).toBeInstanceOf(KnxUsbTransport);
  });
  test("the ip transport value selects the concrete transport", () => {
    // udp and tcp both build a KnxIpTunnel (the classic client); auto wraps them in the
    // decide-at-connect AutoIpTunnel, which is deliberately NOT a KnxIpTunnel.
    expect(makeTransport(conn({ host: "198.51.100.10", ipTransport: "udp" }))).toBeInstanceOf(KnxIpTunnel);
    expect(makeTransport(conn({ host: "198.51.100.10", ipTransport: "tcp" }))).toBeInstanceOf(KnxIpTunnel);
    const auto = makeTransport(conn({ host: "198.51.100.10", ipTransport: "auto" }));
    expect(auto).toBeInstanceOf(AutoIpTunnel);
    expect(auto).not.toBeInstanceOf(KnxIpTunnel);
    expect(auto.assignedIa).toBe(0); // no inner tunnel until connect()
  });
});

describe("AutoIpTunnel", () => {
  test("prefers TCP: connects it, wires callbacks onto it, never touches UDP", async () => {
    const tcp = new StubTunnel();
    const udp = new StubTunnel();
    const t = new AutoIpTunnel("h", 3671, () => tcp, () => udp);
    const onCemi = () => {};
    const onClosed = () => {};
    t.onCemi = onCemi;
    t.onClosed = onClosed;
    await t.connect();
    expect(tcp.connected).toBe(true);
    expect(udp.connected).toBe(false);
    expect(tcp.onCemi).toBe(onCemi); // callbacks assigned before connect land on the inner
    expect(tcp.onClosed).toBe(onClosed);
    tcp.assignedIa = 0x1101;
    expect(t.assignedIa).toBe(0x1101); // exposed from the connected inner
    const cemi = Buffer.from([1, 2, 3]);
    await t.sendCemi(cemi);
    expect(tcp.sent).toEqual([cemi]); // delegated
    await t.disconnect();
    expect(tcp.disconnected).toBe(true);
  });

  // A KnxDevice is built on an already connected transport and installs its onCemi then; before
  // this was forwarded, every device answer over an "auto" connection was lost.
  test("callbacks set after connect reach the inner tunnel too", async () => {
    const tcp = new StubTunnel();
    const t = new AutoIpTunnel("h", 3671, () => tcp, () => new StubTunnel());
    await t.connect();
    const onCemi = () => {};
    const onRawCemi = () => {};
    const onClosed = () => {};
    t.onCemi = onCemi;
    t.onRawCemi = onRawCemi;
    t.onClosed = onClosed;
    expect(tcp.onCemi).toBe(onCemi);
    expect(tcp.onRawCemi).toBe(onRawCemi);
    expect(tcp.onClosed).toBe(onClosed);
    expect(t.onCemi).toBe(onCemi);
  });

  test("falls back to UDP only on TUNNEL_CONNECT_FAILED, wiring callbacks onto UDP", async () => {
    const tcp = new StubTunnel(() => { throw new KnxError("TUNNEL_CONNECT_FAILED", "refused"); });
    const udp = new StubTunnel();
    const t = new AutoIpTunnel("h", 3671, () => tcp, () => udp);
    const onCemi = () => {};
    t.onCemi = onCemi;
    await t.connect();
    expect(udp.connected).toBe(true);
    expect(udp.onCemi).toBe(onCemi);
    await t.sendCemi(Buffer.from([9]));
    expect(udp.sent.length).toBe(1); // delegates to the connected (UDP) inner
  });

  test("propagates a non-connect-failed error instead of masking it as a UDP fallback", async () => {
    const tcp = new StubTunnel(() => { throw new KnxError("TUNNEL_CONNECT_REJECTED", "busy"); });
    const udp = new StubTunnel();
    const t = new AutoIpTunnel("h", 3671, () => tcp, () => udp);
    await t.connect().then(() => { throw new Error("expected connect to reject"); }, (e: unknown) => {
      expect((e as KnxError).message).toBe("busy");
    });
    expect(udp.connected).toBe(false); // a real bus/protocol failure must not silently retry UDP
  });

  test("when the UDP fallback fails too, the error keeps its code and still names the TCP failure", async () => {
    const tcp = new StubTunnel(() => { throw new KnxError("TUNNEL_CONNECT_FAILED", "TCP connect to h:3671 failed: connect ECONNREFUSED h:3671"); });
    const udp = new StubTunnel(() => { throw new KnxError("TUNNEL_CONNECT_TIMEOUT", "connect timeout"); });
    const t = new AutoIpTunnel("h", 3671, () => tcp, () => udp);
    const err = await t.connect().then(() => null, (e: unknown) => e as KnxError);
    expect(err).toBeInstanceOf(KnxError);
    expect(err!.code).toBe("TUNNEL_CONNECT_TIMEOUT");
    expect(err!.message).toContain("connect timeout");
    expect(err!.message).toContain("ECONNREFUSED");
  });

  test("disconnect before a successful connect is a no-op", async () => {
    const t = new AutoIpTunnel("h", 3671, () => new StubTunnel(), () => new StubTunnel());
    await t.disconnect(); // resolves without an inner tunnel to tear down
  });
});
