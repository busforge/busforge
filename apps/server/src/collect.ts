import { KnxDevice, SecureSession, iaToNum } from "@busforge/knx";
import { collectDevice, toDiagnosticPackage, CollectCancelled, type CollectApp, type CollectPackage, type DiagnosticConnection, type DiagnosticPackage, type ProgressFn } from "@busforge/product";
import { makeTransport } from "./transport.ts";
import { versionInfo } from "./version.ts";
import type { Connection } from "./db/connections.ts";
import type { SecureCreds } from "./deviceprofile.ts";

// The server side of raw acquisition (docs/raw-acquisition.md, "Collector design"): one device
// session around collectDevice, cleaned into a diagnostic package that lives in memory, on its job,
// for at most a day. Nothing of it is written to disk. Besides its task row, the only database write
// is a secured session's device sequence (onPeerSequence), as in every secured session; desired state
// and baselines are never touched.

export const DIAGNOSTIC_TTL_MS = 24 * 60 * 60_000;

const connectionKind = (c: Connection): DiagnosticConnection => c.type === "usb"
  ? { kind: "usb", usbVendorId: c.usbVendorId, usbProductId: c.usbProductId }
  : { kind: "ip", ipTransport: c.ipTransport };

// Throws CollectCancelled when the job was cancelled: nothing it read survives the cancel.
export async function runCollection(opts: {
  projectId: string; deviceId: string; taskId: string; ia: string; connection: Connection; secure?: SecureCreds;
  app: CollectApp | null; signal: AbortSignal; onProgress?: ProgressFn;
  monitorClosed: { projectId: string; closedAt: number } | null; now?: () => number;
}): Promise<DiagnosticPackage> {
  const now = opts.now ?? (() => Date.now());
  const busTakenAt = now();
  const v = versionInfo();
  const tun = makeTransport(opts.connection);
  let session: SecureSession | undefined;
  let pkg: CollectPackage | null = null;
  let error: string | null = null;
  // Requests issued so far, carried as the task's `done` through every phase.
  let phase = "connect";
  let requests = 0;
  try {
    opts.onProgress?.("connect");
    await tun.connect();
    session = opts.secure ? new SecureSession({ toolKey: opts.secure.toolKey, src: tun.assignedIa, dst: iaToNum(opts.ia), serial: opts.secure.serial }) : undefined;
    const dev = new KnxDevice(tun, opts.ia, session);
    try {
      await dev.connect();
      pkg = await collectDevice(dev, {
        ia: opts.ia, signal: opts.signal, app: opts.app, now, startedAt: busTakenAt,
        onProgress: (p) => { phase = p; opts.onProgress?.(p, requests, 0); },
        onRequest: (n) => { requests = n; opts.onProgress?.(phase, n, 0); },
        reopen: async () => { await dev.disconnect(); await dev.connect(); },
      });
    } finally {
      // After a finished collection the device link is spent anyway: a failing close leaves its
      // package standing. Before that, the close's failure is the link's.
      const closing = await dev.disconnect().then(() => null, (e: unknown) => e);
      if (closing !== null) console.error("[collect] closing the device link failed:", closing);
      if (closing !== null && !pkg) error ??= `the device link could not be closed: ${closing instanceof Error ? closing.message : "no reason given"}`;
    }
  } catch (e) {
    if (e instanceof CollectCancelled) throw e;
    // The link failed before or around the collection; the package says so instead of vanishing.
    error = `${(e as { code?: string }).code ? `${(e as { code: string }).code}: ` : ""}${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try { await tun.disconnect(); } catch { /* the transport may already be gone */ }
    const seq = session?.peerSequence;
    if (seq != null) {
      try { opts.secure?.onPeerSequence?.(seq); } catch (e) { console.error(`[collect] could not record the device's sequence ${seq}:`, e); }
    }
  }
  // A cancel that ended the link rather than the collector is a cancel all the same.
  if (opts.signal.aborted) throw new CollectCancelled();
  const at = now();
  const body: CollectPackage = pkg ?? {
    format: "busforge-raw-collect/1", ia: opts.ia, mask: null, family: null, secured: opts.secure !== undefined, authorizeLevel: null, maxApdu: null,
    plan: null, records: [], limits: [], stop: { reason: "interface", detail: error ?? "no session" },
    counts: { requests: 0, scanRequests: 0, memoryRequests: 0, memoryBytes: 0, reconnects: 0 }, startedAt: busTakenAt, finishedAt: at,
  };
  const c = opts.connection;
  return toDiagnosticPackage(body, {
    busforge: { version: v.version, commit: v.commit },
    connection: connectionKind(c),
    error,
    bus: { takenAt: busTakenAt, monitorClosedAt: opts.monitorClosed?.closedAt ?? null, releasedAt: at },
    secrets: [opts.secure?.serial.toString("hex") ?? "", opts.projectId, opts.deviceId, opts.taskId, opts.monitorClosed?.projectId ?? "", c.type === "usb" ? c.usbSerial ?? "" : `${c.host}:${c.port}`, c.type === "usb" ? "" : c.host],
  });
}

// The diagnostic packages of finished collect jobs, by task. Held in memory only: a server restart
// drops them, and each is deleted a day after its job ended.
export class DiagnosticStore {
  private entries = new Map<string, { projectId: string; pkg: DiagnosticPackage; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  constructor(private now: () => number = () => Date.now(), private ttlMs = DIAGNOSTIC_TTL_MS) {}

  put(taskId: string, projectId: string, pkg: DiagnosticPackage): void {
    this.delete(taskId);
    const timer = setTimeout(() => this.entries.delete(taskId), this.ttlMs);
    // The deletion must not keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    this.entries.set(taskId, { projectId, pkg, expiresAt: this.now() + this.ttlMs, timer });
  }

  get(projectId: string, taskId: string): DiagnosticPackage | null {
    const e = this.entries.get(taskId);
    if (!e) return null;
    if (this.now() >= e.expiresAt) { this.delete(taskId); return null; }
    return e.projectId === projectId ? e.pkg : null;
  }

  delete(taskId: string): void {
    const e = this.entries.get(taskId);
    if (e) clearTimeout(e.timer);
    this.entries.delete(taskId);
  }
}
