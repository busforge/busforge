import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { loadKnxproj, readAppProgram } from "@busforge/project";
import { parseAppConfig, buildDeviceConfig, type AppConfig, type ComObjectLink } from "@busforge/product";
import { Bus } from "./bus.ts";
import { openDb } from "./db/schema.ts";
import { insertProject, listProjects, getProject, deleteProject, getInterface, setInterface } from "./db/projects.ts";
import { insertTelegram, recentTelegrams } from "./db/telegrams.ts";
import { getDeviceParams, setDeviceParam, getDeviceModules, getDeviceLinks, setDeviceLink, getDeviceAppRef, getDeviceForFlash, getSourceFile, getDeviceChangedKeys, revertDevice, resetParamBase, resetLinkBase } from "./db/deviceparams.ts";
import { flashDeviceParameters, flashDeviceGroupAddresses } from "./flash.ts";

export interface AppState {
  db: Database;
  bus: Bus;
  dataDir: string;
  now: () => number;
  flashing: boolean; // one flash at a time; writing two segments at once would corrupt the load procedure
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
  return { db, bus, dataDir, now: opts?.now ?? (() => Date.now()), appCache: new Map(), flashing: false };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (message: string, status = 400) => json({ error: message }, status);

// Handle an /api/* request. Returns null for non-API paths so the caller can
// fall through to static serving.
export async function handleApi(req: Request, state: AppState): Promise<Response | null> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api","projects",":id",...]
  if (seg[0] !== "api") return null;
  const { db, bus } = state;

  try {
    if (seg[1] !== "projects") return err("not found", 404);

    // /api/projects
    if (seg.length === 2 && req.method === "GET") return json(listProjects(db));

    // /api/projects/import
    if (seg.length === 3 && seg[2] === "import" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return err("missing file");
      const password = (form.get("password") as string) || undefined;
      const name = (file instanceof File ? file.name : "project").replace(/\.knxproj$/i, "");
      const bytes = Buffer.from(await file.arrayBuffer());
      const project = loadKnxproj(bytes, password, name);

      const id = randomUUID();
      const dir = join(state.dataDir, "projects", id);
      mkdirSync(dir, { recursive: true });
      const sourceFile = join(dir, "original.knxproj");
      writeFileSync(sourceFile, bytes);
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
      return p ? json(p) : err("project not found", 404);
    }
    if (seg.length === 3 && req.method === "DELETE") {
      if (!deleteProject(db, id)) return err("project not found", 404);
      if (bus.activeProjectId === id) await bus.disconnect();
      rmSync(join(state.dataDir, "projects", id), { recursive: true, force: true });
      return json({ ok: true });
    }

    // /api/projects/:id/interface
    if (seg.length === 4 && seg[3] === "interface" && req.method === "PUT") {
      const body = (await req.json()) as { interfaceIp?: string; port?: number };
      if (!body.interfaceIp || !body.port) return err("interfaceIp and port required");
      if (!setInterface(db, id, body.interfaceIp, Number(body.port))) return err("project not found", 404);
      return json(getInterface(db, id));
    }

    // /api/projects/:id/telegrams?limit=
    if (seg.length === 4 && seg[3] === "telegrams" && req.method === "GET") {
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") ?? 500)));
      return json(recentTelegrams(db, id, limit));
    }

    // /api/projects/:id/devices/:deviceId/config?lang=
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "config" && req.method === "GET") {
      return deviceConfig(state, id, decodeURIComponent(seg[4]), url.searchParams.get("lang") ?? undefined);
    }
    // /api/projects/:id/devices/:deviceId/params
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "params" && req.method === "PUT") {
      const deviceId = decodeURIComponent(seg[4]);
      const body = (await req.json()) as { paramRefId?: string; value?: string; lang?: string };
      if (!body.paramRefId || body.value === undefined) return err("paramRefId and value required");
      setDeviceParam(db, id, deviceId, body.paramRefId, String(body.value));
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/links  -> re-point a com-object to a GA
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "links" && req.method === "PUT") {
      const deviceId = decodeURIComponent(seg[4]);
      const body = (await req.json()) as { comObjRefId?: string; gaRaws?: number[]; lang?: string };
      if (!body.comObjRefId || !Array.isArray(body.gaRaws)) return err("comObjRefId and gaRaws required");
      const app = loadApp(state, id, deviceId);
      if (!app) return err("device not found", 404);
      // Accept the full (view) ref id or the stored stripped key.
      const key = body.comObjRefId.startsWith(`${app.id}_`) ? body.comObjRefId.slice(app.id.length + 1) : body.comObjRefId;
      setDeviceLink(db, id, deviceId, key, body.gaRaws.map(Number));
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/revert  -> discard unprogrammed edits
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      if (!getDeviceForFlash(db, id, deviceId)) return err("device not found", 404);
      const body = (await req.json().catch(() => ({}))) as { lang?: string };
      revertDevice(db, id, deviceId);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/flash-ga?dry=1  -> program the group tables
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash-ga" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      if (state.flashing) return err("a flash is already in progress", 409);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("device not found", 404);
      const iface = getInterface(db, id);
      if (!iface?.interfaceIp) return err("set an interface IP first");
      const resolved = resolveDeviceLinks(state, id, deviceId);
      if (!resolved) return err("application program not found in project", 404);
      state.flashing = true;
      try {
        if (bus.activeProjectId) await bus.disconnect();
        const result = await flashDeviceGroupAddresses({
          projectId: id, deviceId, ia: dev.ia, expectedMask: resolved.mask, links: resolved.links,
          interfaceIp: iface.interfaceIp, port: iface.port, dataDir: state.dataDir,
          dryRun: url.searchParams.get("dry") === "1",
        });
        // The device's group tables now match our links: clear the change marker.
        if (result.flashed && result.verified !== false) resetLinkBase(db, id, deviceId);
        return json(result);
      } finally {
        state.flashing = false;
      }
    }

    // /api/projects/:id/devices/:deviceId/flash?dry=1  -> program the parameter segment
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      // Only one flash (dry or real) at a time: concurrent segment writes would
      // corrupt the load procedure on the device.
      if (state.flashing) return err("a flash is already in progress", 409);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("device not found", 404);
      const iface = getInterface(db, id);
      if (!iface?.interfaceIp) return err("set an interface IP first");
      const sourceFile = getSourceFile(db, id);
      if (!sourceFile) return err("project not found", 404);
      state.flashing = true;
      try {
        // Free the bus so the flash holds the only connection-oriented link.
        if (bus.activeProjectId) await bus.disconnect();
        const result = await flashDeviceParameters({
          projectId: id, deviceId, ia: dev.ia, appRef: dev.appRef, sourceFile,
          interfaceIp: iface.interfaceIp, port: iface.port,
          params: getDeviceParams(db, id, deviceId), dataDir: state.dataDir,
          dryRun: url.searchParams.get("dry") === "1",
        });
        // The device's parameter segment now matches our values: clear the marker.
        if (result.flashed && result.verified !== false) resetParamBase(db, id, deviceId);
        return json(result);
      } finally {
        state.flashing = false;
      }
    }

    // /api/projects/:id/bus/{connect,disconnect,status}
    if (seg.length === 5 && seg[3] === "bus") {
      if (seg[4] === "status" && req.method === "GET") {
        const active = bus.activeProjectId === id;
        return json({ status: active ? bus.status : "disconnected", error: active ? bus.error : null, projectId: bus.activeProjectId });
      }
      if (seg[4] === "connect" && req.method === "POST") {
        const iface = getInterface(db, id);
        if (!iface) return err("project not found", 404);
        if (!iface.interfaceIp) return err("set an interface IP first");
        if (bus.activeProjectId && bus.activeProjectId !== id) await bus.disconnect();
        await bus.connect(id, iface.interfaceIp, iface.port);
        return json({ status: bus.status, projectId: id });
      }
      if (seg[4] === "disconnect" && req.method === "POST") {
        if (bus.activeProjectId === id) await bus.disconnect();
        return json({ status: "disconnected" });
      }
    }

    return err("not found", 404);
  } catch (e) {
    return err((e as Error).message, 400);
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

// Build a device's configuration view and overlay each com-object's stored GA link.
function deviceConfig(state: AppState, projectId: string, deviceId: string, lang?: string): Response {
  const { db } = state;
  if (!getDeviceForFlash(db, projectId, deviceId)) return err("device not found", 404);
  const app = loadApp(state, projectId, deviceId);
  if (!app) return err("application program not found in project", 404);
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), lang, getDeviceModules(db, projectId, deviceId));
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
    if (num === undefined) throw new Error(`cannot resolve com-object ${refId} for flashing; refusing to avoid dropping its group address`);
    links.push({ comObjNum: num, gaRaws });
  }
  return { mask: app.mask, links };
}
