import { join } from "node:path";
import { existsSync } from "node:fs";
import { inspect } from "node:util";
import { createState, handleApi } from "./app.ts";
import { pruneTelegrams } from "./db/telegrams.ts";
import type { ServerWebSocket } from "bun";

// A process that drives real hardware must never disappear without saying why. A download that
// dies mid-bracket does not leave a half-configured device, it leaves a RESET one: the load
// states and the individual address live in flash metadata that is only written by the A_Restart
// at the end of the plan, so an interrupted download loses everything the device had. That
// happened here, and it was invisible: the process was simply gone, with nothing in the log.
//
// So every way this process can end now leaves a line behind. The handlers do not exit: an
// uncaught error inside one request must not take the bus operation of another with it.
const say = (why: string, e?: unknown) => {
  // inspect(), not String(): a thrown value that is not an Error stringifies to "[object Object]",
  // which is exactly the nothing this handler exists to replace.
  const err = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : e === undefined ? "" : inspect(e, { depth: 3 });
  console.error(`[${new Date().toISOString()}] ${why}${err ? `: ${err}` : ""}`);
};
process.on("uncaughtException", (e) => say("UNCAUGHT EXCEPTION (server stays up)", e));
process.on("unhandledRejection", (e) => say("UNHANDLED REJECTION (server stays up)", e));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { say(`received ${sig}, exiting`); process.exit(0); });
}
process.on("exit", (code) => say(`process exit (code ${code})`));

const state = createState();
const PORT = Number(process.env.PORT ?? 3000);
const DIST = join(import.meta.dir, "..", "..", "web", "dist");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Per-connection state: which project this monitor is for, plus its unsubscribe.
type WsData = { projectId: string; unsub?: () => void };

const monitorMatch = (path: string) => /^\/api\/projects\/([^/]+)\/bus\/monitor$/.exec(path);

const server = Bun.serve<WsData>({
  port: PORT,
  // Bus operations (reading group/parameter tables, flashing with read-back verify) hold a
  // request open for tens of seconds while the device responds, with no data flowing in the
  // meantime. Bun's default idleTimeout is 10s, which severed slower reads (e.g. a push
  // sensor's group tables) mid-operation -> the client saw an empty reply. Raise it well
  // past the longest single bus exchange. Max allowed is 255s.
  idleTimeout: 240,
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
