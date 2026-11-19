import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { devServerSettings } from "./src/lib/devServer.ts";

const dev = devServerSettings(process.env);

// Dev: proxy the API and the bus-monitor WebSocket to the Bun server (BUSFORGE_API, default
// http://localhost:3000). BUSFORGE_WEB sets the port and makes it strict: a busy port is an error,
// where Vite would otherwise move to the next one and a run would reach another instance.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    ...(dev.port === undefined ? {} : { port: dev.port, strictPort: true }),
    proxy: {
      "^/api/projects/[^/]+/bus/monitor$": { target: dev.apiWsTarget, ws: true },
      "/api": { target: dev.apiTarget },
    },
  },
});
