// API client + types mirroring the Bun server contract. Types are duplicated
// here (not imported from @busforge/project) to keep the browser bundle free of
// the node-crypto loader code.

export interface DeviceChanges { params: number; links: number; }
export interface Device { id: string; ia: string; name: string; productRef: string; appRef: string; manufacturer: number; comment?: string; searchText?: string; changes?: DeviceChanges; secure?: boolean; }
export interface GroupAddress { address: string; raw: number; name: string; dpt: string; }
export interface GroupRangeNode { id: string; name: string; rangeStart: number; rangeEnd: number; children: GroupRangeNode[]; addresses: GroupAddress[]; }
// Building structure: a tree of spaces (Building > Floor > Room > ...), each with
// the ids of the devices placed directly in it. Empty when the project has none.
export interface SpaceNode { id: string; type: string; name: string; deviceIds: string[]; children: SpaceNode[]; }
export type ConnectionType = "ip" | "usb";
// A saved, reusable bus connection (the connection-manager library).
export interface Connection { id: string; name: string; type: ConnectionType; host: string; port: number; usbVendorId: number | null; usbProductId: number | null; usbSerial: string | null; createdAt: number; }
export type ConnectionInput = Omit<Connection, "id" | "createdAt">;
export interface UsbDevice { vendorId: number; productId: number; product: string; serial?: string; path?: string; }
export interface Gateway { name: string; ip: string; port: number; ia: string; mac: string; }
// Build/version info for the footer: git-describe version, commit sha, ISO build time
// (null for a local dev build).
export interface VersionInfo { version: string; commit: string; builtAt: string | null; }
export interface ProjectSummary { id: string; name: string; deviceCount: number; gaCount: number; snapshotCount: number; buildingCount: number; floorCount: number; roomCount: number; importedAt: number; }
export interface Project { id: string; name: string; connectionId: string | null; devices: Device[]; groupRanges: GroupRangeNode[]; locations: SpaceNode[]; gaCount: number; secureDeviceCount: number; }
export interface ImportGap { ia: string; name: string }
export interface ImportResult { id: string; name: string; deviceCount: number; gaCount: number; devicesWithoutProgram?: ImportGap[]; unresolvedLinks?: number; }
// Metadata from analyzing an import file without persisting it (the preview step).
// `modifiedAt` is the export timestamp for a .busforge artifact, null for a
// .knxproj (the UI falls back to the picked file's last-modified date).
export interface AnalyzeResult { kind: "knxproj" | "busforge"; name: string; deviceCount: number; gaCount: number; snapshotCount: number; buildingCount: number; floorCount: number; roomCount: number; modifiedAt: number | null; devicesWithoutProgram?: ImportGap[]; unresolvedLinks?: number; }
// A placeable catalog product (the device picker's list for blank projects).
export interface CatalogProduct { appRef: string; productRef: string; appProgramId: string; manufacturer: number; name: string; orderNumber: string; hwVersion: string; }
export interface CfgParamView {
  refId: string; name: string; control: "enum" | "number" | "text" | "color" | "time" | "ip" | "display" | "unsupported";
  value: string; options?: { value: number; text: string }[]; min?: number; max?: number; suffix?: string; step?: number; slider?: boolean; unit?: string; float?: boolean; readOnly?: boolean;
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
export interface DeviceConfigView { blocks: CfgBlock[]; hasModules: boolean; dca?: DcaInfo; readbackSupport?: { params: boolean; links: boolean }; }
// One device's communication object on a group address, for the GA details overlay.
export interface GaComObj {
  deviceId: string; deviceName: string; ia: string;
  comObjName: string; functionText: string; comObjNumber: number;
  flags: { read: boolean; write: boolean; comm: boolean; transmit: boolean; update: boolean; readOnInit: boolean };
}
// Which devices use a group address, split into senders (transmit) and receivers
// (write), plus the address's readable range path.
export interface GaDevicesView { address: string; name: string; dpt: string; path: string[]; senders: GaComObj[]; receivers: GaComObj[]; }
export interface FlashResult { mask: string; imageBytes: number; diffBytes: number; changed: boolean; flashed: boolean; verified?: boolean; backup: string; }

export type TaskKind = "read" | "flash-params" | "flash-ga";
export type TaskState = "queued" | "running" | "done" | "error" | "cancelled";
export interface Task {
  id: string; projectId: string; deviceId: string; deviceName: string; ia: string;
  kind: TaskKind; state: TaskState; phase: string | null; done: number; total: number;
  error: string | null; errorCode: string | null; queuedAt: number; startedAt: number | null; finishedAt: number | null;
}

export type SnapshotKind = "manual" | "auto";
export type SnapshotReason = "manual" | "before-flash" | "before-flash-ga" | "before-restore" | "before-ga-edit" | "before-space-edit";
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
  version: (): Promise<VersionInfo> => fetch("/api/version").then((r) => jsonOrThrow<VersionInfo>(r)),

  listProjects: (): Promise<ProjectSummary[]> => fetch("/api/projects").then((r) => jsonOrThrow<ProjectSummary[]>(r)),

  async importProject(file: File, password: string): Promise<ImportResult> {
    const form = new FormData();
    form.set("file", file);
    if (password) form.set("password", password);
    return jsonOrThrow<ImportResult>(await fetch("/api/projects/import", { method: "POST", body: form }));
  },

  // Parse an import file's metadata (for the preview card) without persisting it.
  // Works for both .knxproj and .busforge; a password is used when the file needs it.
  async analyzeImport(file: File, password?: string): Promise<AnalyzeResult> {
    const form = new FormData();
    form.set("file", file);
    if (password) form.set("password", password);
    return jsonOrThrow<AnalyzeResult>(await fetch("/api/projects/analyze", { method: "POST", body: form }));
  },

  // Create a blank project (no devices), to be populated from the catalog.
  createProject: (name: string): Promise<ProjectSummary> =>
    fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => jsonOrThrow<ProjectSummary>(r)),

  // The browsable device catalog (products placeable into a project).
  catalog: (): Promise<CatalogProduct[]> => fetch("/api/catalog/products").then((r) => jsonOrThrow<CatalogProduct[]>(r)),

  // Ingest an official .knxprod product database into the catalog (no project created).
  async importCatalog(file: File): Promise<{ products: number; programs: number }> {
    const form = new FormData();
    form.set("file", file);
    return jsonOrThrow<{ products: number; programs: number }>(await fetch("/api/catalog/import", { method: "POST", body: form }));
  },

  // Place a catalog product into a project as a new device (server allocates the IA).
  addDevice: (id: string, appRef: string, productRef: string, name?: string): Promise<{ id: string; ia: string }> =>
    fetch(`/api/projects/${id}/devices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appRef, productRef, name }) }).then((r) => jsonOrThrow<{ id: string; ia: string }>(r)),

  // Re-import a .busforge project artifact (the export's inverse) as a new project.
  // A password is only needed for an encrypted artifact (ignored otherwise).
  async importBusforge(file: File, password?: string): Promise<ImportResult> {
    const form = new FormData();
    form.set("file", file);
    if (password) form.set("password", password);
    return jsonOrThrow<ImportResult>(await fetch("/api/projects/import-busforge", { method: "POST", body: form }));
  },

  getProject: (id: string): Promise<Project> => fetch(`/api/projects/${id}`).then((r) => jsonOrThrow<Project>(r)),

  deleteProject: (id: string): Promise<{ ok: true }> => fetch(`/api/projects/${id}`, { method: "DELETE" }).then((r) => jsonOrThrow<{ ok: true }>(r)),
  renameProject: (id: string, name: string): Promise<{ id: string; name: string }> =>
    fetch(`/api/projects/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => jsonOrThrow<{ id: string; name: string }>(r)),

  // Download the portable project export (.busforge). POSTs so an optional
  // password rides in the body, not the URL; triggers a browser download from
  // the returned binary (filename taken from Content-Disposition).
  async exportProject(id: string, password?: string): Promise<void> {
    const res = await fetch(`/api/projects/${id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password || undefined }),
    });
    if (!res.ok) { await jsonOrThrow<never>(res); return; } // throws a localized ApiError
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? "project.busforge";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  setProjectConnection: (id: string, connectionId: string | null): Promise<{ connectionId: string | null }> =>
    fetch(`/api/projects/${id}/connection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId }) }).then((r) => jsonOrThrow<{ connectionId: string | null }>(r)),

  telegrams: (id: string, limit = 500): Promise<Telegram[]> =>
    fetch(`/api/projects/${id}/telegrams?limit=${limit}`).then((r) => jsonOrThrow<Telegram[]>(r)),

  deviceConfig: (id: string, deviceId: string, lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/config${lang ? `?lang=${lang}` : ""}`).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  // Which devices use a group address (senders/receivers) + its readable path.
  gaDevices: (id: string, raw: number, lang?: string): Promise<GaDevicesView> =>
    fetch(`/api/projects/${id}/group-addresses/${raw}/devices${lang ? `?lang=${lang}` : ""}`).then((r) => jsonOrThrow<GaDevicesView>(r)),

  // --- group-address structure editing. All return the refreshed project. ---
  createGroupRange: (id: string, parentId: number | null, name: string, number: number): Promise<Project> =>
    fetch(`/api/projects/${id}/group-ranges`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentId, name, number }) }).then((r) => jsonOrThrow<Project>(r)),
  renameGroupRange: (id: string, rangeId: number, name: string): Promise<Project> =>
    fetch(`/api/projects/${id}/group-ranges/${rangeId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => jsonOrThrow<Project>(r)),
  deleteGroupRange: (id: string, rangeId: number): Promise<Project> =>
    fetch(`/api/projects/${id}/group-ranges/${rangeId}`, { method: "DELETE" }).then((r) => jsonOrThrow<Project>(r)),
  rangeImpact: (id: string, rangeId: number): Promise<{ links: number }> =>
    fetch(`/api/projects/${id}/group-ranges/${rangeId}/impact`).then((r) => jsonOrThrow<{ links: number }>(r)),
  createGroupAddress: (id: string, rangeId: number, sub: number, name: string, dpt: string): Promise<Project> =>
    fetch(`/api/projects/${id}/group-addresses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rangeId, sub, name, dpt }) }).then((r) => jsonOrThrow<Project>(r)),
  updateGroupAddress: (id: string, raw: number, name: string, dpt: string): Promise<Project> =>
    fetch(`/api/projects/${id}/group-addresses/${raw}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, dpt }) }).then((r) => jsonOrThrow<Project>(r)),
  deleteGroupAddress: (id: string, raw: number): Promise<Project> =>
    fetch(`/api/projects/${id}/group-addresses/${raw}`, { method: "DELETE" }).then((r) => jsonOrThrow<Project>(r)),
  gaImpact: (id: string, raw: number): Promise<{ links: number }> =>
    fetch(`/api/projects/${id}/group-addresses/${raw}/impact`).then((r) => jsonOrThrow<{ links: number }>(r)),

  // --- building-structure editing. All return the refreshed project. ---
  createSpace: (id: string, parentId: number | null, type: string, name: string): Promise<Project> =>
    fetch(`/api/projects/${id}/spaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentId, type, name }) }).then((r) => jsonOrThrow<Project>(r)),
  renameSpace: (id: string, spaceId: number, name: string): Promise<Project> =>
    fetch(`/api/projects/${id}/spaces/${spaceId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then((r) => jsonOrThrow<Project>(r)),
  deleteSpace: (id: string, spaceId: number): Promise<Project> =>
    fetch(`/api/projects/${id}/spaces/${spaceId}`, { method: "DELETE" }).then((r) => jsonOrThrow<Project>(r)),
  spaceImpact: (id: string, spaceId: number): Promise<{ devices: number }> =>
    fetch(`/api/projects/${id}/spaces/${spaceId}/impact`).then((r) => jsonOrThrow<{ devices: number }>(r)),
  assignDeviceSpace: (id: string, deviceId: string, spaceId: number | null): Promise<Project> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/space`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ spaceId }) }).then((r) => jsonOrThrow<Project>(r)),

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
  restoreSnapshot: (id: string, sid: string): Promise<Project & { gaStructureRestored: boolean }> =>
    fetch(`/api/projects/${id}/snapshots/${encodeURIComponent(sid)}/restore`, { method: "POST" }).then((r) => jsonOrThrow<Project & { gaStructureRestored: boolean }>(r)),
  deleteSnapshot: (id: string, sid: string): Promise<{ ok: true }> =>
    fetch(`/api/projects/${id}/snapshots/${encodeURIComponent(sid)}`, { method: "DELETE" }).then((r) => jsonOrThrow<{ ok: true }>(r)),

  tasks: (id: string): Promise<Task[]> => fetch(`/api/projects/${id}/tasks`).then((r) => jsonOrThrow<Task[]>(r)),
  cancelTask: (id: string, taskId: string): Promise<{ cancelled: string }> =>
    fetch(`/api/projects/${id}/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).then((r) => jsonOrThrow<{ cancelled: string }>(r)),

  // Connection-manager library (reusable saved connections, project-independent).
  connections: (): Promise<Connection[]> => fetch("/api/connections").then((r) => jsonOrThrow<Connection[]>(r)),
  createConnection: (c: ConnectionInput): Promise<Connection> =>
    fetch("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then((r) => jsonOrThrow<Connection>(r)),
  updateConnection: (cid: string, c: ConnectionInput): Promise<Connection> =>
    fetch(`/api/connections/${encodeURIComponent(cid)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then((r) => jsonOrThrow<Connection>(r)),
  deleteConnection: (cid: string): Promise<{ ok: true }> =>
    fetch(`/api/connections/${encodeURIComponent(cid)}`, { method: "DELETE" }).then((r) => jsonOrThrow<{ ok: true }>(r)),
  discoverUsb: (): Promise<UsbDevice[]> => fetch("/api/connections/discover-usb").then((r) => jsonOrThrow<UsbDevice[]>(r)),
  discoverIp: (): Promise<Gateway[]> => fetch("/api/connections/discover-ip").then((r) => jsonOrThrow<Gateway[]>(r)),

  busStatus: (id: string): Promise<BusState> => fetch(`/api/projects/${id}/bus/status`).then((r) => jsonOrThrow<BusState>(r)),
  busConnect: (id: string): Promise<{ status: BusStatus }> => fetch(`/api/projects/${id}/bus/connect`, { method: "POST" }).then((r) => jsonOrThrow<{ status: BusStatus }>(r)),
  busDisconnect: (id: string): Promise<{ status: BusStatus }> => fetch(`/api/projects/${id}/bus/disconnect`, { method: "POST" }).then((r) => jsonOrThrow<{ status: BusStatus }>(r)),
};
