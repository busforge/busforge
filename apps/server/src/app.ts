import { loadKnxproj, type Project } from "@busforge/project";
import { Bus } from "./bus.ts";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";

export interface AppState {
  bus: Bus;
  project: Project | null;
  settings: Settings;
}

export function createState(): AppState {
  return { bus: new Bus(), project: null, settings: loadSettings() };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (message: string, status = 400) => json({ error: message }, status);

// Handle an /api/* request. Returns null for non-API paths so the caller can
// fall through to static serving. Pure over AppState, so it is unit-testable
// without binding a socket.
export async function handleApi(req: Request, state: AppState): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  if (!path.startsWith("/api/")) return null;

  try {
    if (path === "/api/project/import" && method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return err("missing file");
      const password = (form.get("password") as string) || undefined;
      const name = (file instanceof File ? file.name : "project").replace(/\.knxproj$/i, "");
      const bytes = Buffer.from(await file.arrayBuffer());
      const project = loadKnxproj(bytes, password, name);
      state.project = project;
      return json({ name: project.name, deviceCount: project.devices.length, gaCount: project.groupAddresses.length });
    }

    if (path === "/api/project" && method === "GET") {
      if (!state.project) return err("no project imported", 404);
      const { name, topology, devices, groupRanges, groupAddresses } = state.project;
      return json({ name, topology, devices, groupRanges, gaCount: groupAddresses.length });
    }

    if (path === "/api/settings" && method === "GET") return json(state.settings);
    if (path === "/api/settings" && method === "PUT") {
      const body = (await req.json()) as Partial<Settings>;
      if (!body.interfaceIp || !body.port) return err("interfaceIp and port required");
      state.settings = saveSettings({ interfaceIp: body.interfaceIp, port: Number(body.port) });
      return json(state.settings);
    }

    if (path === "/api/bus/connect" && method === "POST") {
      await state.bus.connect(state.settings.interfaceIp, state.settings.port);
      return json({ status: state.bus.status });
    }
    if (path === "/api/bus/disconnect" && method === "POST") {
      await state.bus.disconnect();
      return json({ status: state.bus.status });
    }
    if (path === "/api/bus/status" && method === "GET") {
      return json({ status: state.bus.status, error: state.bus.error });
    }

    return err("not found", 404);
  } catch (e) {
    return err((e as Error).message, 400);
  }
}
