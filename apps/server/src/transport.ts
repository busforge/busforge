import { KnxIpTunnel, KnxUsbTransport, KnxError, type KnxTransport } from "@busforge/knx";
import type { Connection } from "./db/connections.ts";

// An IP transport that decides TCP-vs-UDP at connect() time. TCP tunnelling is what reaches a bridge
// through an `ssh -L` forward or a multi-homed host where UDP source selection fails, so it is tried
// first; ONLY a refused/unreachable TCP connect (a coded TUNNEL_CONNECT_FAILED) falls back to classic
// UDP. Any other error is a real bus/protocol failure and propagates unchanged, so it is never masked
// as "the gateway only speaks UDP". The callbacks may be set before connect() (bus.ts) or after it
// (a KnxDevice installs its onCemi on a connected transport), so each one is held here and also
// forwarded to the inner tunnel whenever it is set.
export class AutoIpTunnel implements KnxTransport {
  private inner: KnxTransport | null = null;
  private cemiCb: KnxTransport["onCemi"] = null;
  private rawCemiCb: KnxTransport["onRawCemi"] = null;
  private closedCb: KnxTransport["onClosed"] = null;
  get onCemi(): KnxTransport["onCemi"] { return this.cemiCb; }
  set onCemi(cb: KnxTransport["onCemi"]) { this.cemiCb = cb; if (this.inner) this.inner.onCemi = cb; }
  get onRawCemi(): KnxTransport["onRawCemi"] { return this.rawCemiCb; }
  set onRawCemi(cb: KnxTransport["onRawCemi"]) { this.rawCemiCb = cb; if (this.inner) this.inner.onRawCemi = cb; }
  get onClosed(): KnxTransport["onClosed"] { return this.closedCb; }
  set onClosed(cb: KnxTransport["onClosed"]) { this.closedCb = cb; if (this.inner) this.inner.onClosed = cb; }

  // makeTcp/makeUdp are test seams (mirroring KnxIpTunnel's createSocket/createTcpSocket); the
  // defaults build the real tunnels, so production behaviour is a plain TCP-first, UDP-fallback.
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly makeTcp: (h: string, p: number) => KnxTransport = (h, p) => KnxIpTunnel.tcp(h, p),
    private readonly makeUdp: (h: string, p: number) => KnxTransport = (h, p) => new KnxIpTunnel(h, p),
  ) {}

  get assignedIa(): number {
    return this.inner?.assignedIa ?? 0;
  }

  async connect(): Promise<void> {
    const tcp = this.makeTcp(this.host, this.port);
    this.inner = tcp;
    this.wire(tcp);
    let tcpFailure: KnxError;
    try {
      await tcp.connect();
      return;
    } catch (e) {
      this.inner = null;
      // A refused/unreachable TCP endpoint is the one signal that says "try UDP". Everything else
      // (a rejected channel, a protocol error, a timeout after the socket was up) is a real failure
      // the caller must see, not a reason to silently retry on a different transport.
      if (!(e instanceof KnxError) || e.code !== "TUNNEL_CONNECT_FAILED") throw e;
      tcpFailure = e;
    }
    const udp = this.makeUdp(this.host, this.port);
    this.inner = udp;
    this.wire(udp);
    try { await udp.connect(); } catch (e) {
      this.inner = null;
      // Both transports failed. The UDP error keeps its code, but the TCP failure before it is often
      // the telling one (a UDP timeout says nothing about why TCP could not connect either).
      if (e instanceof KnxError) throw new KnxError(e.code, `${e.message}; before it, ${tcpFailure.message}`);
      throw e;
    }
  }

  // Copy the caller-assigned callbacks onto the concrete tunnel just before it connects.
  private wire(t: KnxTransport): void {
    t.onCemi = this.onCemi;
    t.onRawCemi = this.onRawCemi;
    t.onClosed = this.onClosed;
  }

  queryMaxApdu(): Promise<number | null> {
    return this.inner?.queryMaxApdu ? this.inner.queryMaxApdu() : Promise.resolve(null);
  }

  sendCemi(cemi: Buffer): Promise<void> {
    if (!this.inner) throw new Error("AutoIpTunnel.sendCemi called before connect()");
    return this.inner.sendCemi(cemi);
  }

  disconnect(): Promise<void> {
    // A disconnect before a successful connect has nothing to tear down.
    return this.inner ? this.inner.disconnect() : Promise.resolve();
  }
}

// Build the concrete transport for a saved connection. The USB transport pulls in
// node-hid lazily on connect(), so the IP path never loads the native module.
export function makeTransport(c: Connection): KnxTransport {
  if (c.type === "usb") {
    // An empty saved serial names no interface.
    return new KnxUsbTransport({ vendorId: c.usbVendorId ?? undefined, productId: c.usbProductId ?? undefined, serial: c.usbSerial || undefined });
  }
  if (c.ipTransport === "udp") return new KnxIpTunnel(c.host, c.port);
  if (c.ipTransport === "tcp") return KnxIpTunnel.tcp(c.host, c.port);
  return new AutoIpTunnel(c.host, c.port);
}

// A connection is "ready" to drive bus operations when its transport-specific
// identity is set. Narrows null away for callers.
export function isConnectionReady(c: Connection | null): c is Connection {
  if (!c) return false;
  return c.type === "usb" ? c.usbVendorId != null && c.usbProductId != null : !!c.host;
}
