// API client + types for the Bun server contract. The device-configuration wire types
// (CfgBlock, DeviceConfigView, FlashResult, ...) are the ONE authoritative definition in
// @busforge/product, imported here type-only and re-exported for the rest of the web app. A
// type-only import is erased at build (esbuild drops it entirely), so nothing runtime (no
// node-crypto, no XML parser) crosses into the browser bundle; only the compiler sees it, which
// is exactly what keeps this contract from drifting away from the server's.
import type {
  CfgParamView, CfgComObjView, CfgCell, CfgGridLine, CfgButtonView, CfgItem, CfgBlock,
  DcaInfo, DcaModuleInfo, DeviceConfigView, FlashResult,
} from "@busforge/product";
export type {
  CfgParamView, CfgComObjView, CfgCell, CfgGridLine, CfgButtonView, CfgItem, CfgBlock,
  DcaInfo, DcaModuleInfo, DeviceConfigView, FlashResult,
};

// neverProgrammed: no configuration of this project has been verified on the device since it was
// placed or its product replaced.
export interface DeviceChanges { params: number; links: number; neverProgrammed: boolean }
export interface Device { id: string; ia: string; name: string; productRef: string; appRef: string; manufacturer: number; comment?: string; searchText?: string; changes?: DeviceChanges; secure?: boolean; }
// security: the address's Data Secure mode, as ETS's "Automatisch" / "Erzwungen an" / "Erzwungen aus".
export type GroupAddressSecurity = "auto" | "on" | "off";
export interface GroupAddress { address: string; raw: number; name: string; dpt: string; security: GroupAddressSecurity; }
export interface GroupRangeNode { id: string; name: string; rangeStart: number; rangeEnd: number; children: GroupRangeNode[]; addresses: GroupAddress[]; }
// Building structure: a tree of spaces (Building > Floor > Room > ...), each with
// the ids of the devices placed directly in it. Empty when the project has none.
export interface SpaceNode { id: string; type: string; name: string; deviceIds: string[]; children: SpaceNode[]; }
export type ConnectionType = "ip" | "usb";
// KNXnet/IP transport for an IP connection: 'auto' prefers TCP and falls back to UDP.
export type IpTransport = "auto" | "tcp" | "udp";
// A saved, reusable bus connection (the connection-manager library).
export interface Connection { id: string; name: string; type: ConnectionType; host: string; port: number; ipTransport: IpTransport; usbVendorId: number | null; usbProductId: number | null; usbSerial: string | null; createdAt: number; }
export type ConnectionInput = Omit<Connection, "id" | "createdAt">;
export interface UsbDevice { vendorId: number; productId: number; product: string; serial?: string; path?: string; }
export interface Gateway { name: string; ip: string; port: number; ia: string; mac: string; }
// Build/version info for the footer: git-describe version, commit sha, ISO build time
// (null for a local dev build).
export interface VersionInfo { version: string; commit: string; builtAt: string | null; }
// The file a project was imported from; null for a project created in busforge or imported before this was kept.
export interface ImportSource { kind: "knxproj" | "busforge"; name: string; sha256: string; bytes: number }
export interface ProjectSummary { id: string; name: string; deviceCount: number; gaCount: number; snapshotCount: number; buildingCount: number; floorCount: number; roomCount: number; importedAt: number; source: ImportSource | null; }
export interface Project { id: string; name: string; connectionId: string | null; groupAddressLevels: 2 | 3; devices: Device[]; groupRanges: GroupRangeNode[]; locations: SpaceNode[]; gaCount: number; secureDeviceCount: number; groupKeyCount: number; }
export interface ImportGap { ia: string; name: string }
export interface ImportResult { id: string; name: string; deviceCount: number; gaCount: number; devicesWithoutProgram?: ImportGap[]; unresolvedLinks?: number; malformedDevices?: number; unresolvedSenders?: number; secureDevicesWithoutSerial?: number; baggageUnreadable?: boolean; }
// Metadata from analyzing an import file without persisting it (the preview step).
// `modifiedAt` is the export timestamp for a .busforge artifact, null for a
// .knxproj (the UI falls back to the picked file's last-modified date).
export interface AnalyzeResult { kind: "knxproj" | "busforge"; name: string; deviceCount: number; gaCount: number; snapshotCount: number; buildingCount: number; floorCount: number; roomCount: number; modifiedAt: number | null; devicesWithoutProgram?: ImportGap[]; unresolvedLinks?: number; malformedDevices?: number; unresolvedSenders?: number; secureDevicesWithoutSerial?: number; }
// A placeable catalog product (the device picker's list for blank projects).
export interface CatalogProduct { appRef: string; productRef: string; appProgramId: string; manufacturer: number; name: string; orderNumber: string; hwVersion: string; }
// One com-object of an application program's COMPLETE declaration (not gated by
// parameter visibility), for the replace-product link mapping. Mirrors the
// server's ComObjUniverseEntry (@busforge/product comObjectUniverse).
export interface AppComObject {
  refId: string; number: number; name: string; functionText: string;
  dpt: string; objectSize: string;
  flags: { read: boolean; write: boolean; comm: boolean; transmit: boolean; update: boolean; readOnInit: boolean };
}
// One row of the replace-product link migration: `from` is a com-object ref the
// device currently links, `to` a com-object of the NEW application (null = drop
// the link). The mapping must cover every current link; the server refuses a
// partial one rather than losing links silently.
export interface ReplaceMappingEntry { from: string; to: string | null; }
// Result of writing a device's individual address on the bus (mirrors
// @busforge/knx AssignIaResult). `verified` means THE programmed device answers
// on the new address; anything less is a failure the UI must show as one.
export interface AssignIaResult { previous: string; assigned: string; verified: boolean; progModeCleared: boolean; progModeError: string | null; }
// One device's communication object on a group address, for the GA details overlay.
export interface GaComObj {
  deviceId: string; deviceName: string; ia: string;
  comObjName: string; functionText: string; comObjNumber: number;
  flags: { read: boolean; write: boolean; comm: boolean; transmit: boolean; update: boolean; readOnInit: boolean };
}
// Which devices use a group address, split into senders (transmit) and receivers
// (write), plus the address's readable range path.
// interfaceSenders: the individual addresses the project assigns as senders besides the linked
// objects (a tunnelling channel); a secured address's receivers list them in their security table.
export interface GaDevicesView { address: string; name: string; dpt: string; path: string[]; senders: GaComObj[]; receivers: GaComObj[]; secured: boolean; interfaceSenders: { ia: string; source: "import" | "busforge" }[]; }

export type TaskKind = "read" | "flash-params" | "flash-ga" | "flash-structure" | "assign-ia" | "download" | "secure-activate";
export type TaskState = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";
export interface Task {
  id: string; projectId: string; deviceId: string; deviceName: string; ia: string;
  // writes: the task changes the device (a real flash, download or address assignment).
  kind: TaskKind; writes: boolean; snapshotId: string | null; state: TaskState; phase: string | null; done: number; total: number;
  error: string | null; errorCode: string | null; result: unknown; baselineCommitted: boolean;
  queuedAt: number; startedAt: number | null; finishedAt: number | null;
  // Whether the server accepts a cancel now: queued, writing nothing, or a write still only reading.
  cancellable: boolean;
}
export const taskActive = (t: Task) => t.state === "queued" || t.state === "running";

export type SnapshotKind = "manual" | "auto";
export type SnapshotReason = "manual" | "before-flash" | "before-flash-ga" | "before-download" | "before-restore" | "before-ga-edit" | "before-space-edit";
export interface SnapshotMeta {
  id: string; label: string; kind: SnapshotKind; reason: SnapshotReason; createdAt: number; schemaVersion: number;
}

export type BusStatus = "disconnected" | "connecting" | "connected";
export interface BusState { status: BusStatus; error: string | null; projectId: string | null; }
// How a secured group telegram was received (absent on a plain one); only "decrypted" carries a value.
export type TelegramSecurity = "decrypted" | "noKey" | "authFailed" | "replay" | "unsupported";
export interface Telegram { ts: number; src: string; dst: string; dstRaw: number; kind: string; raw: string; security?: TelegramSecurity; }

// Thrown on a non-OK response. `code` is the backend's stable error code (when
// present) the UI maps to a localized string; `message` is the English fallback.
export class ApiError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A real write is answered with its queued task (202), not its result: the job runs on in the
// server whether or not this page is still open. Poll the task until it finishes and hand back the
// operation's result. An unverified write is a result too (the caller shows it as the failure it
// is); every other unsuccessful end is thrown with its code.
export async function awaitTask<T>(projectId: string, submitted: Promise<Task>, onTask?: (t: Task) => void, pollMs = 1000): Promise<T> {
  let task = await submitted;
  onTask?.(task);
  let misses = 0;
  while (taskActive(task)) {
    await sleep(pollMs);
    try {
      task = await jsonOrThrow<Task>(await fetch(`/api/projects/${projectId}/tasks/${encodeURIComponent(task.id)}`));
      misses = 0;
    } catch (e) {
      if (e instanceof ApiError && e.code === "TASK_NOT_FOUND") throw e;
      // The server is unreachable or failing (a proxy's 502 during a restart), which says nothing
      // about the job: it may still be running.
      if (++misses >= 60) throw new ApiError("lost contact with the server; the operation may still be running, see the bus queue", "TASK_CONTACT_LOST");
    }
  }
  if (task.state === "done" || (task.errorCode === "FLASH_UNVERIFIED" && task.result)) return task.result as T;
  throw new ApiError(task.error ?? `task ${task.state}`, task.errorCode ?? `TASK_${task.state.toUpperCase()}`);
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

// Hand a binary response to the browser as a download, named by its Content-Disposition.
async function downloadResponse(res: Response, fallbackName: string): Promise<void> {
  if (!res.ok) { await jsonOrThrow<never>(res); return; } // throws a localized ApiError
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// A dry run answers with its preview directly; a real write answers with its task, awaited here.
// `onTask` learns the submitted write's task, so a caller can tell its own job from someone else's.
function programDevice(id: string, deviceId: string, route: "flash" | "flash-ga" | "download", dry: boolean, onTask?: (t: Task) => void): Promise<FlashResult> {
  const res = fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/${route}${dry ? "?dry=1" : ""}`, { method: "POST" });
  return dry ? res.then((r) => jsonOrThrow<FlashResult>(r)) : awaitTask<FlashResult>(id, res.then((r) => jsonOrThrow<Task>(r)), onTask);
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

  // keysExported acknowledges that the tool keys only Busforge holds were exported first
  // (PROJECT_HOLDS_OWN_KEYS otherwise).
  deleteProject: (id: string, keysExported = false): Promise<{ ok: true }> =>
    fetch(`/api/projects/${id}${keysExported ? "?keysExported=1" : ""}`, { method: "DELETE" }).then((r) => jsonOrThrow<{ ok: true }>(r)),
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
    await downloadResponse(res, "project.busforge");
  },

  // Download the project's KNX Data Secure keys as an ETS keyring (.knxkeys), encrypted with
  // the password (required).
  async exportKeyring(id: string, password: string): Promise<void> {
    const res = await fetch(`/api/projects/${id}/keyring`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    await downloadResponse(res, "project.knxkeys");
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

  addGaSender: (id: string, raw: number, ia: string): Promise<GaDevicesView> =>
    fetch(`/api/projects/${id}/group-addresses/${raw}/senders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ia }) }).then((r) => jsonOrThrow<GaDevicesView>(r)),
  removeGaSender: (id: string, raw: number, ia: string): Promise<GaDevicesView> =>
    fetch(`/api/projects/${id}/group-addresses/${raw}/senders/${encodeURIComponent(ia)}`, { method: "DELETE" }).then((r) => jsonOrThrow<GaDevicesView>(r)),
  // A GroupValueWrite (value as hex) or GroupValueRead, handed to the interface over the project's
  // monitor connection; the interface's confirmation is not read.
  sendGroup: (id: string, ga: number, service: "write" | "read", value?: string): Promise<{ handedToInterface: true; secured: boolean }> =>
    fetch(`/api/projects/${id}/bus/group`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ga, service, value }) }).then((r) => jsonOrThrow<{ handedToInterface: true; secured: boolean }>(r)),

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
  updateGroupAddress: (id: string, raw: number, name: string, dpt: string, security?: GroupAddressSecurity): Promise<Project> =>
    fetch(`/api/projects/${id}/group-addresses/${raw}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, dpt, security }) }).then((r) => jsonOrThrow<Project>(r)),
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

  // Which devices are in programming mode right now (a broadcast probe over the bus).
  progMode: (id: string): Promise<string[]> =>
    fetch(`/api/projects/${id}/prog-mode`).then((r) => jsonOrThrow<{ devices: string[] }>(r)).then((r) => r.devices),
  // Write the device's project address into the physical device in programming mode.
  assignIa: (id: string, deviceId: string): Promise<AssignIaResult> =>
    awaitTask(id, fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/assign-ia`, { method: "POST" }).then((r) => jsonOrThrow<Task>(r))),
  setDeviceAddress: (id: string, deviceId: string, ia: string): Promise<{ id: string; ia: string }> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/address`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ia }),
    }).then((r) => jsonOrThrow<{ id: string; ia: string }>(r)),
  // Store the device certificate printed on a KNX Data Secure device (serial + factory key), sealed.
  // Nothing is sent to the device.
  putDeviceCertificate: (id: string, deviceId: string, certificate: string): Promise<{ serial: string }> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/certificate`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ certificate }),
    }).then((r) => jsonOrThrow<{ serial: string }>(r)),
  // Deposit a tool key another tool gave the device; stored only once the device answered a secure
  // Sync under it. Nothing is written to the device.
  putToolKey: (id: string, deviceId: string, toolKey: string, serial: string): Promise<{ serial: string; source: string }> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/tool-key`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ toolKey, serial }),
    }).then((r) => jsonOrThrow<{ serial: string; source: string }>(r)),
  // Take the device from its factory key to a tool key (the one on file, or one Busforge generates
  // and stores before writing it). A device that already holds the key on file is left alone.
  secureActivate: (id: string, deviceId: string): Promise<{ outcome: "activated" | "already-active" }> =>
    awaitTask(id, fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/secure-activate`, { method: "POST" }).then((r) => jsonOrThrow<Task>(r))),
  // Commission the device from nothing: application id + parameter image +
  // com-object table + group tables in one bracket (dry=true only previews).
  downloadDevice: (id: string, deviceId: string, dry: boolean, onTask?: (t: Task) => void): Promise<FlashResult> => programDevice(id, deviceId, "download", dry, onTask),
  // The COMPLETE com-object universe of a catalog application program.
  appComObjects: (appProgramId: string, lang?: string): Promise<AppComObject[]> =>
    fetch(`/api/catalog/apps/${encodeURIComponent(appProgramId)}/comobjects${lang ? `?lang=${lang}` : ""}`).then((r) => jsonOrThrow<AppComObject[]>(r)),
  // Swap the device's product for a catalog product (the physical device was
  // replaced), migrating its GA links through an explicit, total mapping. A
  // project-model edit only: nothing is written to the bus.
  replaceDevice: (id: string, deviceId: string, appRef: string, productRef: string, mapping: ReplaceMappingEntry[], lang?: string): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/replace`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appRef, productRef, mapping, lang }),
    }).then((r) => jsonOrThrow<DeviceConfigView>(r)),

  flashDevice: (id: string, deviceId: string, dry: boolean, onTask?: (t: Task) => void): Promise<FlashResult> => programDevice(id, deviceId, "flash", dry, onTask),
  flashDeviceGa: (id: string, deviceId: string, dry: boolean, onTask?: (t: Task) => void): Promise<FlashResult> => programDevice(id, deviceId, "flash-ga", dry, onTask),
  // allowPlain: the user confirmed turning a secured address plain (SECURE_GA_TURNS_PLAIN).
  setDeviceLink: (id: string, deviceId: string, comObjRefId: string, gaRaws: number[], lang?: string, allowPlain?: boolean): Promise<DeviceConfigView> =>
    fetch(`/api/projects/${id}/devices/${encodeURIComponent(deviceId)}/links`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ comObjRefId, gaRaws, lang, allowPlain }),
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
