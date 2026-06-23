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
  refId: string; name: string; control: "enum" | "number" | "text" | "color" | "unsupported";
  value: string; options?: { value: number; text: string }[]; min?: number; max?: number; suffix?: string; step?: number; slider?: boolean; readOnly?: boolean;
  changed?: boolean; defaultValue?: string; typeLabel?: string; indent?: number;
}
export interface CfgComObjView {
  refId: string; number: number; name: string; functionText: string;
  objectSize: string; dpt: string; flags: { read: boolean; write: boolean; comm: boolean; transmit: boolean; update: boolean; readOnInit: boolean };
  gaRaw?: number | null;
  changed?: boolean;
}
export type CfgItem =
  | { kind: "separator"; text: string; uiHint: string }
  | { kind: "param"; param: CfgParamView }
  | { kind: "comObject"; comObject: CfgComObjView }
  | { kind: "unsupported"; label: string };
export interface CfgBlock { id: string; name: string; items: CfgItem[]; level: number; parentId?: string; }
// Set when the device is configured via a manufacturer ETS DCA app (Windows-only
// plugin); its proprietary config is not shown/editable here, standard params are.
// `module` is present when busforge ships a native replacement for that DCA.
export interface DcaModuleInfo { id: string; displayName: string; category: string; compatible: boolean; deviceVersion: number; supportedVersions: number[] }
export interface DcaInfo { hint: string; module?: DcaModuleInfo }
export interface DeviceConfigView { blocks: CfgBlock[]; hasModules: boolean; dca?: DcaInfo; }
export interface FlashResult { mask: string; imageBytes: number; diffBytes: number; changed: boolean; flashed: boolean; verified?: boolean; backup: string; }

export type TaskKind = "read" | "flash-params" | "flash-ga";
export type TaskState = "queued" | "running" | "done" | "error" | "cancelled";
export interface Task {
  id: string; projectId: string; deviceId: string; deviceName: string; ia: string;
  kind: TaskKind; state: TaskState; phase: string | null; done: number; total: number;
  error: string | null; errorCode: string | null; queuedAt: number; startedAt: number | null; finishedAt: number | null;
}

export type SnapshotKind = "manual" | "auto";
export type SnapshotReason = "manual" | "before-flash" | "before-flash-ga" | "before-restore";
export interface SnapshotMeta {
  id: string; label: string; kind: SnapshotKind; reason: SnapshotReason; createdAt: number; schemaVersion: number;
}

export type BusStatus = "disconnected" | "connecting" | "connected";
export interface BusState { status: BusStatus; error: string | null; projectId: string | null; }
export interface Telegram { ts: number; src: string; dst: string; dstRaw: number; kind: string; raw: string; }

// Thrown on a non-OK response. `code` is the backend's stable error code (when
// present) the UI maps to a localized string; `message` is the English fallback.
export class ApiError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as { error?: unknown }).error;
    if (e && typeof e === "object") {
      const { code, message } = e as { code?: string; message?: string };
      throw new ApiError(message ?? `HTTP ${res.status}`, code);
    }
    throw new ApiError(typeof e === "string" ? e : `HTTP ${res.status}`);
  }
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

  // DCA config blobs for a device (name -> base64), consumed by native DCA modules.
  deviceBaggage: (id: string, deviceId: string): Promise<Record<string, string>> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/baggage`).then((r) => jsonOrThrow<Record<string, string>>(r)),
  setDeviceParam: (id: string, deviceId: string, paramRefId: string, value: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/params`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId, value, lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  flashDevice: (id: string, deviceId: string, dry: boolean): Promise<FlashResult> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/flash${dry ? "?dry=1" : ""}`, { method: "POST" }).then((r) => jsonOrThrow<FlashResult>(r)),
  flashDeviceGa: (id: string, deviceId: string, dry: boolean): Promise<FlashResult> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/flash-ga${dry ? "?dry=1" : ""}`, { method: "POST" }).then((r) => jsonOrThrow<FlashResult>(r)),
  setDeviceLink: (id: string, deviceId: string, comObjRefId: string, gaRaws: number[], lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/links`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ comObjRefId, gaRaws, lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  revertDevice: (id: string, deviceId: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/revert`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),
  revertParam: (id: string, deviceId: string, paramRefId: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/revert-param`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paramRefId, lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),
  revertLink: (id: string, deviceId: string, comObjRefId: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/revert-link`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ comObjRefId, lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),
  // Read the device's current configuration off the bus and adopt it as the
  // baseline; returns the refreshed config view (drifted rows now flagged).
  readBackDevice: (id: string, deviceId: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/read-back`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  snapshots: (id: string): Promise<SnapshotMeta[]> => fetch(`/api/projects/${id}/snapshots`).then((r) => jsonOrThrow<SnapshotMeta[]>(r)),
  createSnapshot: (id: string, label: string): Promise<SnapshotMeta | null> =>
    fetch(`/api/projects/${id}/snapshots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) }).then((r) => jsonOrThrow<SnapshotMeta | null>(r)),
  restoreSnapshot: (id: string, sid: string): Promise<Project> =>
    fetch(`/api/projects/${id}/snapshots/${encodeURIComponent(sid)}/restore`, { method: "POST" }).then((r) => jsonOrThrow<Project>(r)),
  deleteSnapshot: (id: string, sid: string): Promise<{ ok: true }> =>
    fetch(`/api/projects/${id}/snapshots/${encodeURIComponent(sid)}`, { method: "DELETE" }).then((r) => jsonOrThrow<{ ok: true }>(r)),

  tasks: (id: string): Promise<Task[]> => fetch(`/api/projects/${id}/tasks`).then((r) => jsonOrThrow<Task[]>(r)),
  cancelTask: (id: string, taskId: string): Promise<{ cancelled: string }> =>
    fetch(`/api/projects/${id}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).then((r) => jsonOrThrow<{ cancelled: string }>(r)),

  busStatus: (id: string): Promise<BusState> => fetch(`/api/projects/${id}/bus/status`).then((r) => jsonOrThrow<BusState>(r)),
  busConnect: (id: string): Promise<{ status: BusStatus }> => fetch(`/api/projects/${id}/bus/connect`, { method: "POST" }).then((r) => jsonOrThrow<{ status: BusStatus }>(r)),
  busDisconnect: (id: string): Promise<{ status: BusStatus }> => fetch(`/api/projects/${id}/bus/disconnect`, { method: "POST" }).then((r) => jsonOrThrow<{ status: BusStatus }>(r)),
};
