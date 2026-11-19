// Settings of the Vite dev server (vite.config.ts), read from the environment. The two variables are
// the ones the smoke framework already uses to find the server and the web app, so one pair of
// values points the dev server and a smoke run at the same instance.

const DEFAULT_API = "http://localhost:3000";

export interface DevServerSettings {
  /** Origin the dev server proxies /api to (BUSFORGE_API). */
  apiTarget: string;
  /** The same origin with the ws: scheme, for the bus-monitor WebSocket. */
  apiWsTarget: string;
  /** The port to listen on, from BUSFORGE_WEB; undefined leaves Vite's own default (5173). */
  port: number | undefined;
}

function parseOrigin(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL such as http://localhost:3917, got "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL, got "${value}"`);
  }
  return url;
}

export function devServerSettings(env: Record<string, string | undefined>): DevServerSettings {
  const api = parseOrigin("BUSFORGE_API", env.BUSFORGE_API ?? DEFAULT_API);
  const apiTarget = api.origin;
  const apiWsTarget = `${api.protocol === "https:" ? "wss" : "ws"}://${api.host}`;

  let port: number | undefined;
  if (env.BUSFORGE_WEB !== undefined) {
    const web = parseOrigin("BUSFORGE_WEB", env.BUSFORGE_WEB);
    // A URL without a port would silently mean 80 or 443, which is never what a dev server wants.
    if (web.port === "") throw new Error(`BUSFORGE_WEB must name the dev server's port, such as http://localhost:5917, got "${env.BUSFORGE_WEB}"`);
    port = Number(web.port);
  }
  return { apiTarget, apiWsTarget, port };
}
