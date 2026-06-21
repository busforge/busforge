// API client + types mirroring the Bun server contract. Types are duplicated
// here (not imported from @busforge/project) to keep the browser bundle free of
// the node-crypto loader code.

export interface Device { ia: string; name: string; productRef: string; appRef: string; manufacturer: number; }
export interface TopologyLine { address: number; name: string; devices: Device[]; }
export interface TopologyArea { address: number; name: string; lines: TopologyLine[]; }
export interface Topology { areas: TopologyArea[]; }
export interface GroupAddress { address: string; raw: number; name: string; dpt: string; }
export interface GroupRangeNode { id: string; name: string; rangeStart: number; rangeEnd: number; children: GroupRangeNode[]; addresses: GroupAddress[]; }
export interface ProjectData { name: string; topology: Topology; devices: Device[]; groupRanges: GroupRangeNode[]; gaCount: number; }
export interface ImportResult { name: string; deviceCount: number; gaCount: number; }
export interface Settings { interfaceIp: string; port: number; }
export type BusStatus = "disconnected" | "connecting" | "connected";
export interface Telegram { ts: number; src: string; dst: string; kind: string; raw: string; }

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  async importProject(file: File, password: string): Promise<ImportResult> {
    const form = new FormData();
    form.set("file", file);
    if (password) form.set("password", password);
    return jsonOrThrow(await fetch("/api/project/import", { method: "POST", body: form }));
  },
  async getProject(): Promise<ProjectData> {
    return jsonOrThrow(await fetch("/api/project"));
  },
  async getSettings(): Promise<Settings> {
    return jsonOrThrow(await fetch("/api/settings"));
  },
  async saveSettings(s: Settings): Promise<Settings> {
    return jsonOrThrow(await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(s) }));
  },
  async busStatus(): Promise<{ status: BusStatus; error: string | null }> {
    return jsonOrThrow(await fetch("/api/bus/status"));
  },
  async busConnect(): Promise<{ status: BusStatus }> {
    return jsonOrThrow(await fetch("/api/bus/connect", { method: "POST" }));
  },
  async busDisconnect(): Promise<{ status: BusStatus }> {
    return jsonOrThrow(await fetch("/api/bus/disconnect", { method: "POST" }));
  },
};
