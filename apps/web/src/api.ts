// API client + types mirroring the Bun server contract. Types are duplicated
// here (not imported from @busforge/project) to keep the browser bundle free of
// the node-crypto loader code.

export interface DeviceChanges { params: number; links: number; }
export interface Device { id: string; ia: string; name: string; productRef: string; appRef: string; manufacturer: number; comment?: string; searchText?: string; changes?: DeviceChanges; }
export interface GroupAddress { address: string; raw: number; name: string; dpt: string; }
export interface GroupRangeNode { id: string; name: string; rangeStart: number; rangeEnd: number; children: GroupRangeNode[]; addresses: GroupAddress[]; }
export interface ProjectInterface { interfaceIp: string; port: number; }
export interface ProjectSummary { id: string; name: string; deviceCount: number; gaCount: number; importedAt: number; }
export interface Project { id: string; name: string; interface: ProjectInterface; devices: Device[]; groupRanges: GroupRangeNode[]; gaCount: number; }
export interface ImportResult { id: string; name: string; deviceCount: number; gaCount: number; }
export interface CfgParamView {
  refId: string; name: string; control: "enum" | "number" | "text" | "unsupported";
  value: string; options?: { value: number; text: string }[]; min?: number; max?: number; suffix?: string; readOnly?: boolean;
  changed?: boolean;
}
export interface CfgComObjView {
  refId: string; number: number; name: string; functionText: string;
  objectSize: string; dpt: string; flags: { read: boolean; write: boolean; comm: boolean; transmit: boolean; update: boolean };
  gaRaw?: number | null;
  changed?: boolean;
}
export type CfgItem =
  | { kind: "separator"; text: string; uiHint: string }
  | { kind: "param"; param: CfgParamView }
  | { kind: "comObject"; comObject: CfgComObjView };
export interface CfgBlock { id: string; name: string; items: CfgItem[]; }
export interface DeviceConfigView { blocks: CfgBlock[]; hasModules: boolean; }
export interface FlashResult { mask: string; imageBytes: number; diffBytes: number; changed: boolean; flashed: boolean; verified?: boolean; backup: string; }

export type BusStatus = "disconnected" | "connecting" | "connected";
export interface BusState { status: BusStatus; error: string | null; projectId: string | null; }
export interface Telegram { ts: number; src: string; dst: string; dstRaw: number; kind: string; raw: string; }

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  listProjects: (): Promise<ProjectSummary[]> => fetch("/api/projects").then((r) => jsonOrThrow<ProjectSummary[]>(r)),

  async importProject(file: File, password: string): Promise<ImportResult> {
    const form = new FormData();
    form.set("file", file);
    if (password) form.set("password", password);
    return jsonOrThrow<ImportResult>(await fetch("/api/projects/import", { method: "POST", body: form }));
  },

  getProject: (id: string): Promise<Project> => fetch(`/api/projects/${id}`).then((r) => jsonOrThrow<Project>(r)),

  deleteProject: (id: string): Promise<{ ok: true }> => fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => jsonOrThrow<{ ok: true }>(r)),

  saveInterface: (id: string, iface: ProjectInterface): Promise<ProjectInterface> =>
    fetch(`/api/projects/${id}/interface`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(iface) }).then((r) => jsonOrThrow<ProjectInterface>(r)),

  telegrams: (id: string, limit = 500): Promise<Telegram[]> =>
    fetch(`/api/projects/${id}/telegrams?limit=${limit}`).then((r) => jsonOrThrow<Telegram[]>(r)),

  deviceConfig: (id: string, deviceId: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/config${lang ? `?lang=${lang}` : ""}`).then((r) => jsonOrThrow<DeviceConfigView>(r)),
  setDeviceParam: (id: string, deviceId: string, paramRefId: string, value: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/params`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId, value, lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  flashDevice: (id: string, deviceId: string, dry: boolean): Promise<FlashResult> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/flash${dry ? "?dry=1" : ""}`, { method: "POST" }).then((r) => jsonOrThrow<FlashResult>(r)),
  flashDeviceGa: (id: string, deviceId: string, dry: boolean): Promise<FlashResult> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/flash-ga${dry ? "?dry=1" : ""}`, { method: "POST" }).then((r) => jsonOrThrow<FlashResult>(r)),
  setDeviceLink: (id: string, deviceId: string, comObjRefId: string, gaRaws: number[]): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/links`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ comObjRefId, gaRaws, lang: "de-DE" }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  revertDevice: (id: string, deviceId: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/revert`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  busStatus: (id: string): Promise<BusState> => fetch(`/api/projects/${id}/bus/status`).then((r) => jsonOrThrow<BusState>(r)),
  busConnect: (id: string): Promise<{ status: BusStatus }> => fetch(`/api/projects/${id}/bus/connect`, { method: "POST" }).then((r) => jsonOrThrow<{ status: BusStatus }>(r)),
  busDisconnect: (id: string): Promise<{ status: BusStatus }> => fetch(`/api/projects/${id}/bus/disconnect`, { method: "POST" }).then((r) => jsonOrThrow<{ status: BusStatus }>(r)),
};
