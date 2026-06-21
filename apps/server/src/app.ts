import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { loadKnxproj } from "@busforge/project";
import { Bus } from "./bus.ts";
import { openDb } from "./db/schema.ts";
import { insertProject, listProjects, getProject, deleteProject, getInterface, setInterface } from "./db/projects.ts";
import { insertTelegram, recentTelegrams } from "./db/telegrams.ts";

export interface AppState {
  db: Database;
  bus: Bus;
  dataDir: string;
  now: () => number;
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
  return { db, bus, dataDir, now: opts?.now ?? (() => Date.now()) };
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
