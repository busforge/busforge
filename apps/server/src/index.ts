import { join } from "node:path";
import { existsSync } from "node:fs";
import { createState, handleApi } from "./app.ts";
import { pruneTelegrams } from "./db/telegrams.ts";
import type { ServerWebSocket } from "bun";

const state = createState();
const PORT = Number(process.env.PORT ?? 3000);
const DIST = join(import.meta.dir, "..", "..", "web", "dist");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Per-connection state: which project this monitor is for, plus its unsubscribe.
type WsData = { projectId: string; unsub?: () => void };

const monitorMatch = (path: string) => /^\/api\/projects\/([^/]+)\/bus\/monitor$/.exec(path);

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Project-scoped bus monitor WebSocket: backlog + live group telegrams.
    const m = monitorMatch(url.pathname);
    if (m) {
      if (server.upgrade(req, { data: { projectId: decodeURIComponent(m[1]) } })) return undefined;
      return new Response("expected websocket", { status: 426 });
    }

    const api = await handleApi(req, state);
    if (api) return api;

    // Static: serve the built web app in production.
    if (existsSync(DIST)) {
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(join(DIST, rel));
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(join(DIST, "index.html"))); // SPA fallback
    }
    return new Response("Busforge server: web app not built (dev uses Vite).", { status: 404 });
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      const { projectId } = ws.data;
      // Live telegrams for this project only. History is loaded separately over
      // REST (GET /api/projects/:id/telegrams), so it shows even when offline.
      ws.data.unsub = state.bus.subscribe((t) => {
        if (state.bus.activeProjectId === projectId) ws.send(JSON.stringify(t));
      });
    },
    close(ws: ServerWebSocket<WsData>) {
      ws.data.unsub?.();
    },
    message() { /* monitor is receive-only */ },
  },
});

// Telegram retention: prune on startup and hourly.
const prune = () => pruneTelegrams(state.db, Date.now() - RETENTION_MS);
prune();
setInterval(prune, 60 * 60 * 1000);

console.log(`Busforge server on http://localhost:${server.port}`);
