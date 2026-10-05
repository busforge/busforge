import { evidenceBundle } from "./compatibility.ts";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { AppConfig } from "@busforge/product";
import { Bus } from "./bus.ts";
import { openDb } from "./db/schema.ts";
import { insertTelegram } from "./db/telegrams.ts";
import { countSealedToolKeys } from "./db/deviceSecurity.ts";
import { countSealedGroupKeys } from "./db/groupKeys.ts";
import { countSealedCertificates } from "./db/deviceCertificates.ts";
import { versionInfo } from "./version.ts";
import { ApiError, errorCode } from "./errors.ts";
import { TaskQueue } from "./taskqueue.ts";
import { SqliteTaskStore, closeUnfinishedTasks } from "./db/tasks.ts";
import { getMasterKey } from "./secrets.ts";
import { json, err } from "./httputil.ts";
import * as catalogRoutes from "./routes/catalog.ts";
import * as connectionRoutes from "./routes/connections.ts";
import * as projectRoutes from "./routes/projects.ts";
import * as groupRoutes from "./routes/groups.ts";
import * as spaceRoutes from "./routes/spaces.ts";
import * as deviceRoutes from "./routes/devices.ts";
import * as deviceOpRoutes from "./routes/deviceops.ts";
import { DiagnosticStore } from "./collect.ts";

// Re-exported for tests and any callers that still import these from app.ts;
// their home is the service layer (deviceservice.ts).
export { importGaps, mergeLinkBaseline, selectFlashLinks } from "./deviceservice.ts";

export interface AppState {
  db: Database;
  bus: Bus;
  dataDir: string;
  // Instance master key for sealing KNX Data Secure tool keys at rest (secrets.ts).
  // Resolved once at startup; held in memory, never persisted to the DB.
  masterKey: Buffer;
  now: () => number;
  // One physical interface, so bus operations (read/flash) run serially through
  // this queue instead of rejecting each other; it also surfaces their progress.
  queue: TaskQueue;
  // Parsed application programs cached per application-program id; catalog entries
  // are immutable manufacturer data, so this never needs invalidation within a run.
  appCache: Map<string, AppConfig>;
  // Diagnostic packages of finished collect jobs, in memory only (collect.ts).
  diagnostics: DiagnosticStore;
}

const DEFAULT_DATA_DIR = join(import.meta.dir, "..", "data");

export function createState(opts?: { dbPath?: string; dataDir?: string; now?: () => number }): AppState {
  const dataDir = opts?.dataDir ?? DEFAULT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(opts?.dbPath ?? join(dataDir, "busforge.db"));
  // The shipped evidence bundle is validated at start: a broken one stops the server here instead
  // of failing every device page later.
  evidenceBundle();
  const bus = new Bus(opts?.now);
  // Persistent writer: every telegram of the active project is stored, whether
  // or not a monitor WebSocket is open.
  bus.subscribe((t) => { if (bus.activeProjectId) insertTelegram(db, bus.activeProjectId, t); });
  const now = opts?.now ?? (() => Date.now());
  // Refuse to start if the DB holds sealed tool keys but no master key is available:
  // auto-generating a fresh one (the zero-config default) would silently make every
  // stored key unopenable. Surface the missing key instead of faking a working store.
  const sealedKeyRows = countSealedToolKeys(db) + countSealedGroupKeys(db) + countSealedCertificates(db);
  const hasMasterKey = !!process.env.BUSFORGE_MASTER_KEY || existsSync(join(dataDir, "master.key"));
  if (sealedKeyRows > 0 && !hasMasterKey) {
    throw new Error("the database holds sealed Data Secure keys but no master key is available; set BUSFORGE_MASTER_KEY or restore the master.key file, refusing to auto-generate a key that cannot open them");
  }
  const masterKey = getMasterKey(dataDir);
  closeUnfinishedTasks(db, now());
  const queue = new TaskQueue(now, (run) => bus.withExclusiveOperation(run), new SqliteTaskStore(db));
  return { db, bus, dataDir, masterKey, now, appCache: new Map(), queue, diagnostics: new DiagnosticStore(now) };
}

// The /api/projects/* route modules, dispatched in order. Their route patterns are
// disjoint (each match is a full length + literal-segment + method check), so the
// order only decides who answers first for its own routes; each module keeps its
// routes in the original cascade order internally.
const projectScopedRoutes = [projectRoutes, groupRoutes, spaceRoutes, deviceRoutes, deviceOpRoutes];

// Handle an /api/* request. Returns null for non-API paths so the caller can
// fall through to static serving.
export async function handleApi(req: Request, state: AppState): Promise<Response | null> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api","projects",":id",...]
  if (seg[0] !== "api") return null;

  try {
    // /api/version  -> build/version info for the UI footer (no project scope)
    if (seg[1] === "version" && seg.length === 2 && req.method === "GET") return json(versionInfo());

    const catalogRes = await catalogRoutes.handle(req, url, seg, state);
    if (catalogRes) return catalogRes;
    const connectionRes = await connectionRoutes.handle(req, url, seg, state);
    if (connectionRes) return connectionRes;
    if (seg[1] !== "projects") return err("NOT_FOUND", "not found", 404);

    for (const routes of projectScopedRoutes) {
      const res = await routes.handle(req, url, seg, state);
      if (res) return res;
    }

    return err("NOT_FOUND", "not found", 404);
  } catch (e) {
    // Coded errors (ApiError / ProductError / KnxprojError) carry a client-localizable code;
    // anything else is an unexpected failure surfaced raw under INTERNAL.
    const code = errorCode(e);
    const status = e instanceof ApiError ? e.status : code ? 400 : 500;
    return err(code ?? "INTERNAL", (e as Error).message, status);
  }
}
