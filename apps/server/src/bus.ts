import type { KnxTransport } from "@busforge/knx";
import { decodeGroupTpdu, type Telegram } from "./telegram.ts";
import { makeTransport } from "./transport.ts";
import type { Connection } from "./db/connections.ts";

export type BusStatus = "disconnected" | "connecting" | "connected";

// Owns the live KNXnet/IP tunnel and fans incoming group telegrams out to
// subscribers (the DB writer and the WebSocket clients). Read-only: it never
// sends to the bus. One active connection at a time, bound to a project.
export class Bus {
  private tunnel: KnxTransport | null = null;
  status: BusStatus = "disconnected";
  error: string | null = null;
  activeProjectId: string | null = null;
  private listeners = new Set<(t: Telegram) => void>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) { this.now = now; }

  subscribe(fn: (t: Telegram) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(t: Telegram) { for (const l of this.listeners) l(t); }

  async connect(projectId: string, connection: Connection): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return;
    this.status = "connecting";
    this.error = null;
    this.activeProjectId = projectId;
    const tunnel = makeTransport(connection);
    tunnel.onCemi = (src, dst, tpdu, isGroup) => {
      if (isGroup) this.emit(decodeGroupTpdu(src, dst, tpdu, this.now()));
    };
    // The transport lost the bus underneath us (a heartbeat the gateway stopped answering, an
    // inbound DISCONNECT_REQUEST, a USB error). Reflect that instead of leaving the stale
    // "connected" from connect time: on a quiet monitor tunnel the alternative is a green light
    // over a telegram log that silently stopped recording. activeProjectId is kept so /bus/status
    // can still tell the owning project why its connection dropped.
    tunnel.onClosed = (reason) => {
      if (this.tunnel !== tunnel) return; // a newer connection already replaced this one
      this.tunnel = null;
      this.status = "disconnected";
      this.error = reason;
    };
    try {
      await tunnel.connect();
      this.tunnel = tunnel;
      this.status = "connected";
    } catch (e) {
      this.status = "disconnected";
      this.activeProjectId = null;
      this.error = (e as Error).message;
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    await this.tunnel?.disconnect();
    this.tunnel = null;
    this.status = "disconnected";
    this.activeProjectId = null;
  }
}
