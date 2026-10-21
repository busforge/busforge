// The runner's own tunnels to a unit whose restart drops the tunnels of the interface the run goes
// through (a spec's ipInterface restart "drops": the MDT IP Interface/Router, sharing its housing with
// the installation's KNXnet/IP interface). After such a restart the interface drops the run's tunnel and
// may refuse a new one or leave it unserved for up to a minute, so these helpers reconnect within a
// bounded window. Without "drops" every error is thrown as it is: a lost tunnel there is a fault.
import { KnxIpTunnel, KnxError } from "../../packages/knx/src/index.ts";

// The interface dropped or stopped serving the tunnel (a request unconfirmed, the stream closed).
const LINK_LOST = new Set(["TUNNEL_CLOSED", "TUNNEL_CON_TIMEOUT", "TUNNEL_SEND_FAILED", "TUNNEL_ACK_TIMEOUT"]);
// The interface did not take a new tunnel.
const CONNECT_FAILED = new Set(["TUNNEL_CONNECT_FAILED", "TUNNEL_CONNECT_TIMEOUT", "TUNNEL_CONNECT_REJECTED"]);

export const isLinkLost = (e: unknown): boolean => e instanceof KnxError && LINK_LOST.has(e.code);

// Up to a minute was seen; the window leaves room for one more connect attempt after it.
export const DROP_WINDOW_MS = 90_000;
const RETRY_MS = 3_000;

export interface TunnelOptions {
  drops: boolean;
  // For tests: the tunnel to open, the clock and the wait.
  open?: () => { connect(): Promise<void>; disconnect(): Promise<void> };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // The end of the window, where a caller retries within one window of its own.
  until?: number;
}

// A connected tunnel; with `drops`, a refused connect (the interface refusing a channel or its TCP
// port while its server restarts) is tried again every 3 s within DROP_WINDOW_MS.
export async function connectTunnel<T extends { connect(): Promise<void>; disconnect(): Promise<void> } = KnxIpTunnel>(host: string, port: number, o: TunnelOptions): Promise<T> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const open = o.open ?? (() => KnxIpTunnel.tcp(host, port));
  const until = o.until ?? now() + (o.drops ? DROP_WINDOW_MS : 0);
  for (;;) {
    const tun = open();
    try { await tun.connect(); return tun as T; }
    catch (e) {
      await tun.disconnect().catch(() => undefined);
      if (!o.drops || !(e instanceof KnxError && CONNECT_FAILED.has(e.code)) || now() >= until) throw e;
      await sleep(RETRY_MS);
    }
  }
}

// `f` on a fresh tunnel; with `drops`, a tunnel the interface drops under it is replaced and `f` runs
// again, within DROP_WINDOW_MS. Only for reads: `f` must be safe to repeat.
export async function onFreshTunnel<R, T extends { connect(): Promise<void>; disconnect(): Promise<void> } = KnxIpTunnel>(host: string, port: number, o: TunnelOptions, f: (tun: T) => Promise<R>): Promise<R> {
  const now = o.now ?? Date.now;
  const until = now() + (o.drops ? DROP_WINDOW_MS : 0);
  for (;;) {
    const tun = await connectTunnel<T>(host, port, { ...o, until });
    try { return await f(tun); }
    catch (e) { if (!o.drops || !isLinkLost(e) || now() >= until) throw e; }
    finally { await tun.disconnect().catch((e) => { if (!o.drops || !isLinkLost(e)) throw e; }); }
  }
}
