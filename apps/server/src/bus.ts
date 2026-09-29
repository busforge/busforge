import { isSecureApdu, openSecureGroupTpdu, cemiLDataGroup, type KnxTransport } from "@busforge/knx";
import { decodeGroupTpdu, undecodedSecureTelegram, type Telegram } from "./telegram.ts";
import { makeTransport } from "./transport.ts";
import { ApiError } from "./errors.ts";
import type { Connection } from "./db/connections.ts";

export type BusStatus = "disconnected" | "connecting" | "connected";

// Owns the live KNXnet/IP tunnel and fans incoming group telegrams out to
// subscribers (the DB writer and the WebSocket clients). It sends only the group
// telegrams a user asks for (sendGroup), never management. One active connection
// at a time, bound to a project.
//
// Secured group telegrams are opened with the active project's group keys. Replay is judged per
// sender (a receiver keeps one sequence per sender for all its group traffic) against the last
// sequence accepted from it in this monitor session only: the history starts empty at every
// connect, so a replay across a reconnect goes unnoticed.
export class Bus {
  private tunnel: KnxTransport | null = null;
  status: BusStatus = "disconnected";
  error: string | null = null;
  activeProjectId: string | null = null;
  private listeners = new Set<(t: Telegram) => void>();
  private now: () => number;
  private managementActive = false;
  private closed = false;
  private transition: Promise<unknown> = Promise.resolve();
  private groupKeys = new Map<number, Buffer>();
  private lastSecure = new Map<number, bigint>();
  // Group keys are read once per connect: a project's keys are fixed at import, nothing changes them later.

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

  connect(projectId: string, connection: Connection, groupKeys: Map<number, Buffer> = new Map()): Promise<void> {
    if (this.managementActive) return Promise.reject(new ApiError("BUS_BUSY", "a bus operation owns the interface", 409));
    return this.transitionTo(async () => {
      // Checked inside the transition: a connect queued before close() would otherwise open a
      // tunnel after it, and the process would exit without releasing the gateway's channel.
      if (this.closed) throw new ApiError("SERVER_SHUTTING_DOWN", "the server is shutting down and opens no bus connection", 503);
      if (this.activeProjectId !== projectId) await this.closeMonitor();
      await this.openMonitor(projectId, connection, groupKeys);
    });
  }

  private async openMonitor(projectId: string, connection: Connection, groupKeys: Map<number, Buffer>): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return;
    if (this.tunnel) await this.closeMonitor();
    this.groupKeys = groupKeys;
    this.lastSecure = new Map();
    const tunnel = makeTransport(connection);
    this.status = "connecting";
    this.error = null;
    this.activeProjectId = projectId;
    tunnel.onCemi = (src, dst, tpdu, isGroup) => {
      if (this.tunnel !== tunnel || !isGroup) return;
      this.emit(isSecureApdu(tpdu) ? this.openSecured(src, dst, tpdu) : decodeGroupTpdu(src, dst, tpdu, this.now()));
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

  private openSecured(src: number, dst: number, tpdu: Buffer): Telegram {
    const opened = openSecureGroupTpdu(src, dst, tpdu, this.groupKeys.get(dst));
    if (opened.state !== "decrypted") return undecodedSecureTelegram(src, dst, opened.state, this.now());
    // A sequence already seen is shown without a value: a replay, or a link-layer repetition of a
    // frame whose value was already shown (the repeat flag is not passed up, so the two look alike).
    const last = this.lastSecure.get(src);
    if (last !== undefined && opened.seq <= last) return undecodedSecureTelegram(src, dst, "replay", this.now());
    this.lastSecure.set(src, opened.seq);
    return { ...decodeGroupTpdu(src, dst, opened.apdu, this.now()), security: "decrypted" };
  }

  // The individual address the monitor connection sends from (the tunnel's), for the project that
  // owns it; refused when that project's monitor is not connected.
  senderIa(projectId: string): number {
    if (this.activeProjectId !== projectId || this.status !== "connected" || !this.tunnel) {
      throw new ApiError("BUS_NOT_CONNECTED", "connect the bus monitor of this project first; group telegrams are sent over its connection", 409);
    }
    return this.tunnel.assignedIa;
  }

  // Hand a group telegram to the interface over the monitor connection. The interface's L_Data.con
  // is not read, so this does not know the telegram reached the bus, and it is not recorded in the
  // monitor as if it had: what the bus carried shows up there only as the devices' answers.
  async sendGroup(projectId: string, dst: number, tpdu: Buffer): Promise<void> {
    const src = this.senderIa(projectId);
    await this.tunnel!.sendCemi(cemiLDataGroup(src, dst, tpdu));
  }

  disconnect(): Promise<void> {
    return this.transitionTo(() => this.closeMonitor());
  }

  // Close the monitor tunnel for good, after every connect already under way.
  close(): Promise<void> {
    this.closed = true;
    return this.disconnect();
  }

  private async closeMonitor(): Promise<void> {
    try { await this.tunnel?.disconnect(); }
    catch (e) { this.error = (e as Error).message; throw e; }
    this.tunnel = null;
    this.status = "disconnected";
    this.activeProjectId = null;
    this.error = null;
    this.groupKeys = new Map();
    this.lastSecure = new Map();
  }
}
