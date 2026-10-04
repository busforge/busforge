import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KnxDevice, SecureSession, iaToNum } from "@busforge/knx";
import { collectDevice, type CollectApp, type CollectPackage, type ProgressFn } from "@busforge/product";
import { makeTransport } from "./transport.ts";
import { versionInfo } from "./version.ts";
import type { Connection } from "./db/connections.ts";
import type { SecureCreds } from "./deviceprofile.ts";

// The server side of raw acquisition (docs/raw-acquisition.md, "Collector design"): one device
// session around collectDevice, and the package written as a file of its own. Besides its task row,
// the only database write is a secured session's device sequence (onPeerSequence), as in every
// secured session; desired state and baselines are never touched.

export interface CollectProvenance {
  busforge: { version: string; commit: string };
  transport: { kind: Connection["type"]; route: string; ipTransport: Connection["ipTransport"] | null };
  // The monitor connection the job closed to take the bus, and when; null when none was open. The job
  // does not reopen it.
  monitorClosed: { projectId: string; at: number } | null;
  busTakenAt: number;
  // Taken when the package is written, right before the job ends and releases the bus.
  busReleasedAt: number;
}
export type StoredCollectPackage = CollectPackage & { taskId: string; projectId: string; deviceId: string; provenance: CollectProvenance; error: string | null };

const route = (c: Connection) => c.type === "usb"
  ? `usb ${c.usbVendorId?.toString(16) ?? "?"}:${c.usbProductId?.toString(16) ?? "?"}${c.usbSerial ? ` serial ${c.usbSerial}` : ""}`
  : `${c.host}:${c.port}`;

export function collectionPath(dataDir: string, projectId: string, taskId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(taskId)) throw new Error(`not a task id: ${taskId}`);
  return join(dataDir, "projects", projectId, "collections", `${taskId}.json`);
}

export function readCollection(dataDir: string, projectId: string, taskId: string): StoredCollectPackage | null {
  let path: string;
  try { path = collectionPath(dataDir, projectId, taskId); } catch { return null; }
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as StoredCollectPackage : null;
}

export async function runCollection(opts: {
  dataDir: string; projectId: string; deviceId: string; taskId: string; ia: string; connection: Connection; secure?: SecureCreds;
  app: CollectApp | null; signal: AbortSignal; onProgress?: ProgressFn;
  monitorClosed: { projectId: string; closedAt: number } | null; now?: () => number;
}): Promise<StoredCollectPackage> {
  const now = opts.now ?? (() => Date.now());
  const busTakenAt = now();
  const v = versionInfo();
  const tun = makeTransport(opts.connection);
  let session: SecureSession | undefined;
  let pkg: CollectPackage | null = null;
  let error: string | null = null;
  try {
    opts.onProgress?.("connect");
    await tun.connect();
    session = opts.secure ? new SecureSession({ toolKey: opts.secure.toolKey, src: tun.assignedIa, dst: iaToNum(opts.ia), serial: opts.secure.serial }) : undefined;
    const dev = new KnxDevice(tun, opts.ia, session);
    try {
      await dev.connect();
      pkg = await collectDevice(dev, {
        ia: opts.ia, signal: opts.signal, app: opts.app, now, onProgress: opts.onProgress,
        reopen: async () => { await dev.disconnect(); await dev.connect(); },
      });
    } finally {
      await dev.disconnect();
    }
  } catch (e) {
    // The link failed before or around the collection; the package says so instead of vanishing.
    error = `${(e as { code?: string }).code ? `${(e as { code: string }).code}: ` : ""}${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try { await tun.disconnect(); } catch { /* the transport may already be gone */ }
    const seq = session?.peerSequence;
    if (seq != null) {
      try { opts.secure?.onPeerSequence?.(seq); } catch (e) { console.error(`[collect] could not record the device's sequence ${seq}:`, e); }
    }
  }
  const at = now();
  const body: CollectPackage = pkg ?? {
    format: "busforge-raw-collect/1", ia: opts.ia, mask: null, family: null, secured: opts.secure !== undefined, authorizeLevel: null, maxApdu: null,
    plan: null, records: [], limits: [], stop: { reason: "interface", detail: error ?? "no session" },
    counts: { requests: 0, scanRequests: 0, memoryRequests: 0, memoryBytes: 0, reconnects: 0 }, startedAt: busTakenAt, finishedAt: at,
  };
  const stored: StoredCollectPackage = {
    ...body, taskId: opts.taskId, projectId: opts.projectId, deviceId: opts.deviceId, error,
    provenance: {
      busforge: { version: v.version, commit: v.commit },
      transport: { kind: opts.connection.type, route: route(opts.connection), ipTransport: opts.connection.type === "usb" ? null : opts.connection.ipTransport },
      monitorClosed: opts.monitorClosed ? { projectId: opts.monitorClosed.projectId, at: opts.monitorClosed.closedAt } : null,
      busTakenAt, busReleasedAt: at,
    },
  };
  const path = collectionPath(opts.dataDir, opts.projectId, opts.taskId);
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(stored, null, 1));
    renameSync(`${path}.tmp`, path);
  } catch (e) {
    rmSync(`${path}.tmp`, { force: true });
    throw e;
  }
  return stored;
}
