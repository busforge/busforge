import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { loadKnxproj, readAppProgram, readBaggage } from "@busforge/project";
import { parseAppConfig, buildDeviceConfig, type AppConfig, type ComObjectLink } from "@busforge/product";
import { Bus } from "./bus.ts";
import { openDb } from "./db/schema.ts";
import { insertProject, listProjects, getProject, deleteProject, getInterface, setInterface } from "./db/projects.ts";
import { listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } from "./db/snapshots.ts";
import { insertTelegram, recentTelegrams } from "./db/telegrams.ts";
import { getDeviceParams, setDeviceParam, deleteDeviceParam, getDeviceModules, getDeviceLinks, setDeviceLink, getDeviceAppRef, getDeviceForFlash, getSourceFile, getDeviceChangedKeys, revertDevice, revertDeviceParam, revertDeviceLink, replaceParamBase, replaceLinkBase, resetParamBase, resetLinkBase } from "./db/deviceparams.ts";
import { flashDeviceParameters, flashDeviceGroupAddresses, readDeviceState } from "./flash.ts";
import { ApiError, errorCode } from "./errors.ts";
import { TaskQueue } from "./taskqueue.ts";
import { resolveDcaModule } from "./dca.ts";

export interface AppState {
  db: Database;
  bus: Bus;
  dataDir: string;
  now: () => number;
  // One physical interface, so bus operations (read/flash) run serially through
  // this queue instead of rejecting each other; it also surfaces their progress.
  queue: TaskQueue;
  // Parsed application programs cached per (sourceFile, appRef); immutable once a
  // project is imported, so this never needs invalidation within a run.
  appCache: Map<string, AppConfig>;
}

const DEFAULT_DATA_DIR = join(import.meta.dir, "..", "data");

export function createState(opts?: { dbPath?: string; dataDir?: string; now?: () => number }): AppState {
  const dataDir = opts?.dataDir ?? DEFAULT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(opts?.dbPath ?? join(dataDir, "busforge.db"));
  const bus = new Bus(opts?.now);
  // Persistent writer: every telegram of the active project is stored, whether
  // or not a monitor WebSocket is open.
  bus.subscribe((t) => { if (bus.activeProjectId) insertTelegram(db, bus.activeProjectId, t); });
  const now = opts?.now ?? (() => Date.now());
  return { db, bus, dataDir, now, appCache: new Map(), queue: new TaskQueue(now) };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
// Error responses carry a stable `code` (for client localization) plus the
// English `message` as a fallback/log line.
const err = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

// Handle an /api/* request. Returns null for non-API paths so the caller can
// fall through to static serving.
export async function handleApi(req: Request, state: AppState): Promise<Response | null> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api","projects",":id",...]
  if (seg[0] !== "api") return null;
  const { db, bus } = state;

  try {
    if (seg[1] !== "projects") return err("NOT_FOUND", "not found", 404);

    // /api/projects
    if (seg.length === 2 && req.method === "GET") return json(listProjects(db));

    // /api/projects/import
    if (seg.length === 3 && seg[2] === "import" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
      const password = (form.get("password") as string) || undefined;
      const name = (file instanceof File ? file.name : "project").replace(/\.knxproj$/i, "");
      const bytes = Buffer.from(await file.arrayBuffer());
      const project = loadKnxproj(bytes, password, name);

      const id = randomUUID();
      const dir = join(state.dataDir, "projects", id);
      mkdirSync(dir, { recursive: true });
      const sourceFile = join(dir, "original.knxproj");
      writeFileSync(sourceFile, bytes);
      // Persist DCA baggage (BinaryData/UserFiles, e.g. a DALI gateway's
      // backup-store) so native DCA-replacement modules can read it later. The
      // inner zip is only decryptable here, with the import password in hand.
      try {
        const baggage = readBaggage(bytes, password);
        if (baggage.size > 0) {
          const bagDir = join(dir, "baggage");
          mkdirSync(bagDir, { recursive: true });
          for (const [bname, buf] of baggage) writeFileSync(join(bagDir, bname.replace(/[/\\]/g, "__")), buf);
        }
      } catch { /* baggage is best-effort; never block an import on it */ }
      try {
        insertProject(db, id, project, sourceFile, state.now());
      } catch (e) {
        rmSync(dir, { recursive: true, force: true }); // don't leave an orphan dir behind
        throw e;
      }
      return json({ id, name: project.name, deviceCount: project.devices.length, gaCount: project.groupAddresses.length });
    }

    const id = seg[2];

    // /api/projects/:id
    if (seg.length === 3 && req.method === "GET") {
      const p = getProject(db, id);
      return p ? json(p) : err("PROJECT_NOT_FOUND", "project not found", 404);
    }
    if (seg.length === 3 && req.method === "DELETE") {
      if (!deleteProject(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      if (bus.activeProjectId === id) await bus.disconnect();
      rmSync(join(state.dataDir, "projects", id), { recursive: true, force: true });
      return json({ ok: true });
    }

    // /api/projects/:id/interface
    if (seg.length === 4 && seg[3] === "interface" && req.method === "PUT") {
      const body = (await req.json()) as { interfaceIp?: string; port?: number };
      if (!body.interfaceIp || !body.port) return err("INTERFACE_FIELDS_REQUIRED", "interfaceIp and port required");
      if (!setInterface(db, id, body.interfaceIp, Number(body.port))) return err("PROJECT_NOT_FOUND", "project not found", 404);
      return json(getInterface(db, id));
    }

    // /api/projects/:id/telegrams?limit=
    if (seg.length === 4 && seg[3] === "telegrams" && req.method === "GET") {
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") ?? 500)));
      return json(recentTelegrams(db, id, limit));
    }

    // /api/projects/:id/snapshots  -> list restore points / create a manual one
    if (seg.length === 4 && seg[3] === "snapshots") {
      if (req.method === "GET") return json(listSnapshots(db, id));
      if (req.method === "POST") {
        if (!getInterface(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
        const body = (await req.json().catch(() => ({}))) as { label?: string };
        const snap = createSnapshot(db, id, { label: (body.label ?? "").trim(), kind: "manual", reason: "manual" }, state.now());
        return json(snap, 201);
      }
    }

    // /api/projects/:id/snapshots/:sid/restore  -> roll the config back to a snapshot
    if (seg.length === 6 && seg[3] === "snapshots" && seg[5] === "restore" && req.method === "POST") {
      if (!restoreSnapshot(db, id, decodeURIComponent(seg[4]), state.now())) return err("SNAPSHOT_NOT_FOUND", "snapshot not found", 404);
      return json(getProject(db, id));
    }

    // /api/projects/:id/snapshots/:sid  -> delete a restore point
    if (seg.length === 5 && seg[3] === "snapshots" && req.method === "DELETE") {
      if (!deleteSnapshot(db, id, decodeURIComponent(seg[4]))) return err("SNAPSHOT_NOT_FOUND", "snapshot not found", 404);
      return json({ ok: true });
    }

    // /api/projects/:id/devices/:deviceId/config?lang=
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "config" && req.method === "GET") {
      return deviceConfig(state, id, decodeURIComponent(seg[4]), url.searchParams.get("lang") ?? undefined);
    }
    // /api/projects/:id/devices/:deviceId/baggage  -> DCA config blobs for this
    // device (base64), consumed by native DCA-replacement modules.
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "baggage" && req.method === "GET") {
      const deviceId = decodeURIComponent(seg[4]);
      const bagDir = join(state.dataDir, "projects", id, "baggage");
      const out: Record<string, string> = {};
      if (existsSync(bagDir)) {
        for (const f of readdirSync(bagDir)) {
          if (f.startsWith(`${deviceId}_`)) out[f] = readFileSync(join(bagDir, f)).toString("base64");
        }
      }
      return json(out);
    }
    // /api/projects/:id/devices/:deviceId/params
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "params" && req.method === "PUT") {
      const deviceId = decodeURIComponent(seg[4]);
      const body = (await req.json()) as { paramRefId?: string; value?: string; lang?: string };
      if (!body.paramRefId || body.value === undefined) return err("PARAM_FIELDS_REQUIRED", "paramRefId and value required");
      const value = String(body.value);
      // If the value equals the parameter's default, drop the override instead of
      // storing it, so restoring the default clears the "changed" marker (the
      // sparse baseline has no row for default-valued params).
      const def = resolveParamDefault(state, id, deviceId, body.paramRefId);
      if (def !== undefined && value === def) deleteDeviceParam(db, id, deviceId, body.paramRefId);
      else setDeviceParam(db, id, deviceId, body.paramRefId, value);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/links  -> re-point a com-object to a GA
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "links" && req.method === "PUT") {
      const deviceId = decodeURIComponent(seg[4]);
      const body = (await req.json()) as { comObjRefId?: string; gaRaws?: number[]; lang?: string };
      if (!body.comObjRefId || !Array.isArray(body.gaRaws)) return err("COMOBJ_FIELDS_REQUIRED", "comObjRefId and gaRaws required");
      const app = loadApp(state, id, deviceId);
      if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
      // Accept the full (view) ref id or the stored stripped key.
      const key = body.comObjRefId.startsWith(`${app.id}_`) ? body.comObjRefId.slice(app.id.length + 1) : body.comObjRefId;
      setDeviceLink(db, id, deviceId, key, body.gaRaws.map(Number));
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/revert  -> discard unprogrammed edits
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      if (!getDeviceForFlash(db, id, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const body = (await req.json().catch(() => ({}))) as { lang?: string };
      revertDevice(db, id, deviceId);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/revert-param  -> discard one param's drift
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert-param" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      if (!getDeviceForFlash(db, id, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const body = (await req.json().catch(() => ({}))) as { paramRefId?: string; lang?: string };
      if (!body.paramRefId) return err("PARAM_REF_REQUIRED", "paramRefId required");
      revertDeviceParam(db, id, deviceId, body.paramRefId);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/revert-link  -> discard one com-object's drift
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert-link" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const app = loadApp(state, id, deviceId);
      if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const body = (await req.json().catch(() => ({}))) as { comObjRefId?: string; lang?: string };
      if (!body.comObjRefId) return err("COMOBJ_REF_REQUIRED", "comObjRefId required");
      const key = body.comObjRefId.startsWith(`${app.id}_`) ? body.comObjRefId.slice(app.id.length + 1) : body.comObjRefId;
      revertDeviceLink(db, id, deviceId, key);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/read-back  -> read the device's current
    // state off the bus and store it as the baseline, so drift shows as a change.
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "read-back" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const iface = getInterface(db, id);
      if (!iface?.interfaceIp) return err("INTERFACE_NOT_SET", "set an interface IP first");
      const sourceFile = getSourceFile(db, id);
      if (!sourceFile) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const body = (await req.json().catch(() => ({}))) as { lang?: string };
      // Only record drift for refs the device config actually exposes (matches
      // what the UI shows; keeps module devices from flagging flat-model refs).
      const relevantRefs = deviceParamRefs(state, id, deviceId);
      const rb = await state.queue.enqueue(
        { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read" },
        async (progress, signal) => {
          // Free the bus so the read holds the only connection-oriented link.
          if (bus.activeProjectId) await bus.disconnect();
          return readDeviceState({
            ia: dev.ia, appRef: dev.appRef, sourceFile,
            interfaceIp: iface.interfaceIp, port: iface.port,
            liveParams: getDeviceParams(db, id, deviceId), relevantRefs, onProgress: progress, signal,
          });
        },
      );
      replaceParamBase(db, id, deviceId, rb.paramBase);
      replaceLinkBase(db, id, deviceId, readbackLinkBase(state, id, deviceId, rb.links));
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/flash-ga?dry=1  -> program the group tables
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash-ga" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const iface = getInterface(db, id);
      if (!iface?.interfaceIp) return err("INTERFACE_NOT_SET", "set an interface IP first");
      const resolved = resolveDeviceLinks(state, id, deviceId);
      if (!resolved) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
      const dryGa = url.searchParams.get("dry") === "1";
      // Auto restore point of the about-to-be-programmed config (real flash only).
      if (!dryGa) createSnapshot(db, id, { kind: "auto", reason: "before-flash-ga" }, state.now());
      const result = await state.queue.enqueue(
        { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-ga" },
        async (progress) => {
          if (bus.activeProjectId) await bus.disconnect();
          return flashDeviceGroupAddresses({
            projectId: id, deviceId, ia: dev.ia, expectedMask: resolved.mask, links: resolved.links,
            interfaceIp: iface.interfaceIp, port: iface.port, dataDir: state.dataDir,
            dryRun: dryGa, onProgress: progress,
          });
        },
      );
      // The device's group tables now match our links: clear the change marker.
      if (result.flashed && result.verified !== false) resetLinkBase(db, id, deviceId);
      return json(result);
    }

    // /api/projects/:id/devices/:deviceId/flash?dry=1  -> program the parameter segment
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const iface = getInterface(db, id);
      if (!iface?.interfaceIp) return err("INTERFACE_NOT_SET", "set an interface IP first");
      const sourceFile = getSourceFile(db, id);
      if (!sourceFile) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const dryParams = url.searchParams.get("dry") === "1";
      // Auto restore point of the about-to-be-programmed config (real flash only).
      if (!dryParams) createSnapshot(db, id, { kind: "auto", reason: "before-flash" }, state.now());
      const result = await state.queue.enqueue(
        { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-params" },
        async (progress) => {
          // Free the bus so the flash holds the only connection-oriented link.
          if (bus.activeProjectId) await bus.disconnect();
          return flashDeviceParameters({
            projectId: id, deviceId, ia: dev.ia, appRef: dev.appRef, sourceFile,
            interfaceIp: iface.interfaceIp, port: iface.port,
            params: getDeviceParams(db, id, deviceId), dataDir: state.dataDir,
            dryRun: dryParams, onProgress: progress,
          });
        },
      );
      // The device's parameter segment now matches our values: clear the marker.
      if (result.flashed && result.verified !== false) resetParamBase(db, id, deviceId);
      return json(result);
    }

    // /api/projects/:id/tasks  -> the device's queued/running/recent bus operations
    if (seg.length === 4 && seg[3] === "tasks" && req.method === "GET") {
      return json(state.queue.list(id));
    }

    // /api/projects/:id/tasks/:taskId/cancel  -> cancel a queued (or running read) task
    if (seg.length === 6 && seg[3] === "tasks" && seg[5] === "cancel" && req.method === "POST") {
      const cancelled = state.queue.cancel(decodeURIComponent(seg[4]));
      if (!cancelled) return err("TASK_NOT_CANCELLABLE", "task cannot be cancelled", 409);
      return json({ cancelled });
    }

    // /api/projects/:id/bus/{connect,disconnect,status}
    if (seg.length === 5 && seg[3] === "bus") {
      if (seg[4] === "status" && req.method === "GET") {
        const active = bus.activeProjectId === id;
        return json({ status: active ? bus.status : "disconnected", error: active ? bus.error : null, projectId: bus.activeProjectId });
      }
      if (seg[4] === "connect" && req.method === "POST") {
        const iface = getInterface(db, id);
        if (!iface) return err("PROJECT_NOT_FOUND", "project not found", 404);
        if (!iface.interfaceIp) return err("INTERFACE_NOT_SET", "set an interface IP first");
        if (bus.activeProjectId && bus.activeProjectId !== id) await bus.disconnect();
        await bus.connect(id, iface.interfaceIp, iface.port);
        return json({ status: bus.status, projectId: id });
      }
      if (seg[4] === "disconnect" && req.method === "POST") {
        if (bus.activeProjectId === id) await bus.disconnect();
        return json({ status: "disconnected" });
      }
    }

    return err("NOT_FOUND", "not found", 404);
  } catch (e) {
    // Coded errors (ApiError / KnxprojError) carry a client-localizable code;
    // anything else is an unexpected failure surfaced raw under INTERNAL.
    const code = errorCode(e);
    const status = e instanceof ApiError ? e.status : code ? 400 : 500;
    return err(code ?? "INTERNAL", (e as Error).message, status);
  }
}

// Load and cache a device's parsed application program from the stored .knxproj.
function loadApp(state: AppState, projectId: string, deviceId: string): AppConfig | null {
  const appRef = getDeviceAppRef(state.db, projectId, deviceId);
  if (!appRef) return null;
  const sourceFile = getSourceFile(state.db, projectId);
  if (!sourceFile) return null;
  const cacheKey = `${sourceFile}::${appRef}`;
  let app = state.appCache.get(cacheKey);
  if (!app) {
    const xml = readAppProgram(readFileSync(sourceFile), appRef);
    if (!xml) return null;
    app = parseAppConfig(xml);
    state.appCache.set(cacheKey, app);
  }
  return app;
}

// The default value of a parameter (ref/param default, ignoring user overrides),
// resolved from the built config view so module-instance params work too.
function resolveParamDefault(state: AppState, projectId: string, deviceId: string, refId: string): string | undefined {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return undefined;
  const view = buildDeviceConfig(app, getDeviceParams(state.db, projectId, deviceId), undefined, getDeviceModules(state.db, projectId, deviceId));
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param" && it.param.refId === refId) return it.param.defaultValue;
  return undefined;
}

// Build a device's configuration view and overlay each com-object's stored GA link.
function deviceConfig(state: AppState, projectId: string, deviceId: string, lang?: string): Response {
  const { db } = state;
  if (!getDeviceForFlash(db, projectId, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
  const app = loadApp(state, projectId, deviceId);
  if (!app) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), lang, getDeviceModules(db, projectId, deviceId));
  // Offer a native DCA-replacement module if one matches this app program.
  const module = resolveDcaModule(app.id, app.appVersion);
  if (module) view.dca = { ...(view.dca ?? { hint: "" }), module };
  const links = getDeviceLinks(db, projectId, deviceId);
  const changed = getDeviceChangedKeys(db, projectId, deviceId);
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind === "param") {
      it.param.changed = changed.params.has(it.param.refId);
    } else if (it.kind === "comObject") {
      const key = it.comObject.refId.slice(app.id.length + 1);
      it.comObject.gaRaw = links.get(key)?.[0] ?? null;
      it.comObject.changed = changed.links.has(key);
    }
  }
  return json(view);
}

// Resolve a device's stored links to (comObjNum -> GAs) for flashing the group
// tables. Com-object numbers come from the (module-resolved) config view.
function resolveDeviceLinks(state: AppState, projectId: string, deviceId: string): { mask: string; links: ComObjectLink[] } | null {
  const { db } = state;
  const app = loadApp(state, projectId, deviceId);
  if (!app) return null;
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), undefined, getDeviceModules(db, projectId, deviceId));
  const numByRef = new Map<string, number>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") numByRef.set(it.comObject.refId, it.comObject.number);
  // Resolve com-object numbers for EVERY stored link: from the view (covers
  // module-resolved numbers), else directly from the app (covers com-objects
  // hidden by the current parameter values). Never drop a link silently, or the
  // flashed association table would lose that GA assignment.
  const links: ComObjectLink[] = [];
  for (const [refId, gaRaws] of getDeviceLinks(db, projectId, deviceId)) {
    const full = `${app.id}_${refId}`;
    const direct = app.comObjects.get(app.comObjectRefs.get(full)?.refId ?? "")?.number;
    const num = numByRef.get(full) ?? direct;
    if (num === undefined) throw new ApiError("COMOBJ_UNRESOLVED", `cannot resolve com-object ${refId} for flashing; refusing to avoid dropping its group address`);
    links.push({ comObjNum: num, gaRaws });
  }
  return { mask: app.mask, links };
}

// The parameter refs that make up a device's actual configuration (the config
// view's keys): for module devices these are instance-expanded, so they differ
// from the flat application model. Used to keep read-back drift consistent with
// what the UI shows.
function deviceParamRefs(state: AppState, projectId: string, deviceId: string): Set<string> {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return new Set();
  const view = buildDeviceConfig(app, getDeviceParams(state.db, projectId, deviceId), undefined, getDeviceModules(state.db, projectId, deviceId));
  const refs = new Set<string>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") refs.add(it.param.refId);
  return refs;
}

const sameGaSet = (a: number[], b: number[]) => { const x = [...a].sort((m, n) => m - n), y = [...b].sort((m, n) => m - n); return x.length === y.length && x.every((v, i) => v === y[i]); };

// Merge a device's read-back links into the sparse link baseline: copy the live
// links, then override only where the device differs. Non-module devices map 1:1,
// so a com-object missing from the device read is genuinely unassigned (cleared).
// Module devices can't reverse instance numbering reliably, so only links that map
// onto a known live com-object are trusted; others are neither invented nor dropped.
export function mergeLinkBaseline(live: Map<string, number[]>, device: Map<string, number[]>, hasModules: boolean): Map<string, number[]> {
  const base = new Map(live);
  if (hasModules) {
    for (const [key, dev] of device) {
      if (live.has(key) && !sameGaSet(live.get(key) ?? [], dev)) base.set(key, dev);
    }
  } else {
    for (const key of new Set([...live.keys(), ...device.keys()])) {
      const proj = live.get(key) ?? [];
      const dev = device.get(key) ?? [];
      if (!sameGaSet(proj, dev)) { if (dev.length) base.set(key, dev); else base.delete(key); }
    }
  }
  return base;
}

// Turn the links read off a device (keyed by com-object number) into the sparse
// link baseline keyed by stored ref id: copy the live links, then override only
// the com-objects whose device GA set differs from the project, so the live-vs-
// base diff flags exactly the drift. Inverse of resolveDeviceLinks' numbering.
function readbackLinkBase(state: AppState, projectId: string, deviceId: string, deviceLinks: ComObjectLink[]): Map<string, number[]> {
  const { db } = state;
  const app = loadApp(state, projectId, deviceId);
  if (!app) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project");
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), undefined, getDeviceModules(db, projectId, deviceId));
  // number -> stored ref key. App covers hidden com-objects; the view's
  // module-resolved numbers take precedence.
  const keyByNum = new Map<number, string>();
  for (const [full, cor] of app.comObjectRefs) {
    const num = app.comObjects.get(cor.refId)?.number;
    if (num !== undefined) keyByNum.set(num, full.slice(app.id.length + 1));
  }
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") keyByNum.set(it.comObject.number, it.comObject.refId.slice(app.id.length + 1));

  const device = new Map<string, number[]>();
  for (const l of deviceLinks) { const key = keyByNum.get(l.comObjNum); if (key) device.set(key, l.gaRaws); }

  return mergeLinkBaseline(getDeviceLinks(db, projectId, deviceId), device, app.hasModules);
}
