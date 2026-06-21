import { KnxIpTunnel } from "@busforge/knx";
import { decodeGroupTpdu, type Telegram } from "./telegram.ts";

export type BusStatus = "disconnected" | "connecting" | "connected";

// Owns the live KNXnet/IP tunnel and fans incoming group telegrams out to
// subscribers (the WebSocket clients). Read-only: it never sends to the bus.
// Keeps a bounded ring of recent telegrams so a client that connects (or
// reloads) gets the backlog, not just traffic from its connect moment on.
export class Bus {
  private tunnel: KnxIpTunnel | null = null;
  status: BusStatus = "disconnected";
  error: string | null = null;
  private listeners = new Set<(t: Telegram) => void>();
  private buffer: Telegram[] = [];
  private readonly maxBuffer = 500;
  private now: () => number;

  constructor(now: () => number = () => Date.now()) { this.now = now; }

  subscribe(fn: (t: Telegram) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Snapshot of the most recent telegrams (oldest first), sent as a backlog when
  // a client opens the monitor WebSocket.
  recent(): readonly Telegram[] { return this.buffer; }

  private emit(t: Telegram) {
    this.buffer.push(t);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    for (const l of this.listeners) l(t);
  }

  async connect(ip: string, port: number): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return;
    this.status = "connecting";
    this.error = null;
    this.buffer = []; // fresh session
    const tunnel = new KnxIpTunnel(ip, port);
    tunnel.onCemi = (src, dst, tpdu, isGroup) => {
      if (isGroup) this.emit(decodeGroupTpdu(src, dst, tpdu, this.now()));
    };
    try {
      await tunnel.connect();
      this.tunnel = tunnel;
      this.status = "connected";
    } catch (e) {
      this.status = "disconnected";
      this.error = (e as Error).message;
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    await this.tunnel?.disconnect();
    this.tunnel = null;
    this.status = "disconnected";
  }
}
