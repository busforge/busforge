import type { KnxTransport } from "@busforge/knx";
import { decodeGroupTpdu, type Telegram } from "./telegram.ts";
import { makeTransport } from "./transport.ts";
import { ApiError } from "./errors.ts";
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
  private managementActive = false;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(now: () => number = () => Date.now()) { this.now = now; }

  subscribe(fn: (t: Telegram) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(t: Telegram) { for (const l of this.listeners) l(t); }

  // Monitor transitions serialize with each other. Management reserves ownership before
  // waiting for an in-flight connect, so a competing API client cannot open another tunnel.
  private transitionTo<T>(run: () => Promise<T>): Promise<T> {
    const result = this.transition.then(run);
    this.transition = result.catch(() => {});
    return result;
  }

  async withExclusiveOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.managementActive) throw new ApiError("BUS_BUSY", "a bus operation owns the interface", 409);
    this.managementActive = true;
    try {
      await this.transitionTo(() => this.closeMonitor());
      return await run();
    } finally {
      this.managementActive = false;
    }
  }

  connect(projectId: string, connection: Connection): Promise<void> {
    if (this.managementActive) return Promise.reject(new ApiError("BUS_BUSY", "a bus operation owns the interface", 409));
    return this.transitionTo(async () => {
      if (this.activeProjectId !== projectId) await this.closeMonitor();
      await this.openMonitor(projectId, connection);
    });
  }

  private async openMonitor(projectId: string, connection: Connection): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return;
    if (this.tunnel) await this.closeMonitor();
    const tunnel = makeTransport(connection);
    this.status = "connecting";
    this.error = null;
    this.activeProjectId = projectId;
    tunnel.onCemi = (src, dst, tpdu, isGroup) => {
      if (this.tunnel === tunnel && isGroup) this.emit(decodeGroupTpdu(src, dst, tpdu, this.now()));
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
      this.tunnel = tunnel;
      await tunnel.connect();
      if (this.tunnel !== tunnel) throw new ApiError("BUS_CONNECTION_CLOSED", "monitor connection closed while connecting");
      this.status = "connected";
    } catch (e) {
      this.status = "disconnected";
      this.error = (e as Error).message;
      try {
        await tunnel.disconnect();
        this.tunnel = null;
      } catch (cleanup) {
        // Keep an unclosed handle: the next owner must finish closing it before opening one.
        this.error += `; cleanup failed: ${(cleanup as Error).message}`;
      }
      throw e;
    }
  }

  disconnect(): Promise<void> {
    return this.transitionTo(() => this.closeMonitor());
  }

  private async closeMonitor(): Promise<void> {
    try { await this.tunnel?.disconnect(); }
    catch (e) { this.error = (e as Error).message; throw e; }
    this.tunnel = null;
    this.status = "disconnected";
    this.activeProjectId = null;
    this.error = null;
  }
}
