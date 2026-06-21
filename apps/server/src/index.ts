import { join } from "node:path";
import { existsSync } from "node:fs";
import { createState, handleApi } from "./app.ts";
import type { ServerWebSocket } from "bun";

const state = createState();
const PORT = Number(process.env.PORT ?? 3000);
const DIST = join(import.meta.dir, "..", "..", "web", "dist");

// Per-connection state: the unsubscribe handle for this socket's listener.
type WsData = { unsub?: () => void };

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // Bus monitor WebSocket: live group telegrams.
    if (url.pathname === "/api/bus/monitor") {
      if (server.upgrade(req, { data: {} })) return undefined;
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
      // Send the recent backlog first, then stream live telegrams. Both run in
      // this synchronous handler, so no telegram slips in between (no reorder).
      for (const t of state.bus.recent()) ws.send(JSON.stringify(t));
      ws.data.unsub = state.bus.subscribe((t) => ws.send(JSON.stringify(t)));
    },
    close(ws: ServerWebSocket<WsData>) {
      ws.data.unsub?.();
    },
    message() { /* monitor is receive-only */ },
  },
});

console.log(`Busforge server on http://localhost:${server.port}`);
