// TanStack Query hooks over the API client. Query keys are centralized so
// mutations can invalidate precisely. Reads are hooks; writes use useMutation in
// the components with explicit invalidation.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type ReplaceMappingEntry, type Task, type GroupAddressSecurity, type ComObjFlagEdit, type AssumedValue } from "./api.ts";

export const qk = {
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  busStatus: (id: string) => ["busStatus", id] as const,
  telegrams: (id: string) => ["telegrams", id] as const,
  // lang is part of the key so switching the UI language refetches the
  // catalogue text in that language; the server maps it to the nearest
  // available catalogue language.
  deviceConfig: (id: string, deviceId: string, lang: string) => ["deviceConfig", id, deviceId, lang] as const,
  gaDevices: (id: string, raw: number, lang: string) => ["gaDevices", id, raw, lang] as const,
  tasks: (id: string) => ["tasks", id] as const,
  snapshots: (id: string) => ["snapshots", id] as const,
  catalog: ["catalog"] as const,
  manufacturers: ["manufacturers"] as const,
  appComObjects: (appProgramId: string, lang: string) => ["appComObjects", appProgramId, lang] as const,
  connections: ["connections"] as const,
  version: ["version"] as const,
};

// Build/version info for the footer. It cannot change while the page is open (the server
// resolves it once per process), so never refetch.
export const useVersion = () =>
  useQuery({ queryKey: qk.version, queryFn: api.version, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false });

export const useConnections = () =>
  useQuery({ queryKey: qk.connections, queryFn: api.connections, staleTime: 30_000 });

// The dashboard must reflect each project's current counts (devices, GAs, restore
// points) whenever you return to it. Those change while you are inside a project,
// so refetch on every mount and on window refocus rather than trusting staleTime.
export const useProjects = () => useQuery({
  queryKey: qk.projects,
  queryFn: api.listProjects,
  refetchOnMount: "always",
  refetchOnWindowFocus: true,
});

// The device catalog is global and rarely changes within a session; cache it
// (refetched on demand when the picker opens via staleTime expiry).
export const useCatalog = (enabled = true) =>
  useQuery({ queryKey: qk.catalog, queryFn: api.catalog, enabled, staleTime: 60_000 });

// Where each manufacturer publishes its product data: fixed per build.
export const useManufacturers = (enabled = true) =>
  useQuery({ queryKey: qk.manufacturers, queryFn: api.manufacturers, enabled, staleTime: Infinity });

// The complete com-object universe of a catalog application program, for the
// replace-product link mapping. Fetched only once a target product is picked
// (enabled); language-keyed like the device config so the object names match
// the UI. The server refuses module-def apps with a coded error the dialog shows.
export const useAppComObjects = (appProgramId: string, enabled: boolean) => {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return useQuery({
    queryKey: qk.appComObjects(appProgramId, lang),
    queryFn: () => api.appComObjects(appProgramId, lang),
    enabled, staleTime: 60_000, retry: false, // a coded refusal will not succeed on retry
  });
};

export const useProject = (id: string) =>
  useQuery({ queryKey: qk.project(id), queryFn: () => api.getProject(id) });

export const useBusStatus = (id: string) =>
  useQuery({
    queryKey: qk.busStatus(id),
    queryFn: () => api.busStatus(id),
    refetchInterval: 15_000, // surface a dropped connection without a manual reload
  });

export const useTelegrams = (id: string) =>
  useQuery({ queryKey: qk.telegrams(id), queryFn: () => api.telegrams(id, 500) });

// Bus-operation queue. A steady heartbeat keeps the header in sync even with
// operations triggered elsewhere (the bus is serialized server-side); it speeds
// up while something is running/queued so progress feels live.
export const useTasks = (id: string) =>
  useQuery({
    queryKey: qk.tasks(id),
    queryFn: () => api.tasks(id),
    refetchInterval: (q) => {
      const data = q.state.data as Task[] | undefined;
      return data?.some((t) => t.state === "running" || t.state === "queued") ? 500 : 2000;
    },
  });

export const useSnapshots = (id: string) =>
  useQuery({ queryKey: qk.snapshots(id), queryFn: () => api.snapshots(id) });

// Snapshot create/restore/delete. Restore rewrites the whole config layer, so it
// invalidates the project (device list + change counts) and every device config
// view. All three also bump the dashboard's project list, whose restore-point
// count changes.
export function useSnapshotActions(projectId: string) {
  const qc = useQueryClient();
  const refreshList = () => {
    void qc.invalidateQueries({ queryKey: qk.snapshots(projectId) });
    void qc.invalidateQueries({ queryKey: qk.projects }); // dashboard restore-point count
  };
  const create = useMutation({
    mutationFn: (label: string) => api.createSnapshot(projectId, label),
    onSuccess: refreshList,
  });
  const restore = useMutation({
    mutationFn: (sid: string) => api.restoreSnapshot(projectId, sid),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: ["deviceConfig", projectId] });
      refreshList(); // restore inserts an auto undo-point
    },
  });
  const remove = useMutation({
    mutationFn: (sid: string) => api.deleteSnapshot(projectId, sid),
    onSuccess: refreshList,
  });
  return { create, restore, remove };
}

export const useDeviceConfig = (id: string, deviceId: string) => {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return useQuery({ queryKey: qk.deviceConfig(id, deviceId, lang), queryFn: () => api.deviceConfig(id, deviceId, lang) });
};

// Group-address structure edits (ranges + addresses). Each returns the refreshed
// project, applied immediately; deletes capture an undo snapshot server-side and
// can drop device links, so the project (change counts), device configs, the
// dashboard counts, the snapshot list and any open GA overlay are all refreshed.
export function useGroupEdit(projectId: string) {
  const qc = useQueryClient();
  const after = (project: Awaited<ReturnType<typeof api.getProject>>) => {
    qc.setQueryData(qk.project(projectId), project);
    void qc.invalidateQueries({ queryKey: ["deviceConfig", projectId] });
    void qc.invalidateQueries({ queryKey: ["gaDevices", projectId] });
    void qc.invalidateQueries({ queryKey: qk.projects });
    void qc.invalidateQueries({ queryKey: qk.snapshots(projectId) });
  };
  return {
    createRange: useMutation({ mutationFn: (v: { parentId: number | null; name: string; number: number }) => api.createGroupRange(projectId, v.parentId, v.name, v.number), onSuccess: after }),
    renameRange: useMutation({ mutationFn: (v: { rangeId: number; name: string }) => api.renameGroupRange(projectId, v.rangeId, v.name), onSuccess: after }),
    deleteRange: useMutation({ mutationFn: (rangeId: number) => api.deleteGroupRange(projectId, rangeId), onSuccess: after }),
    createGa: useMutation({ mutationFn: (v: { rangeId: number; sub: number; name: string; dpt: string }) => api.createGroupAddress(projectId, v.rangeId, v.sub, v.name, v.dpt), onSuccess: after }),
    updateGa: useMutation({ mutationFn: (v: { raw: number; name: string; dpt: string; security?: GroupAddressSecurity }) => api.updateGroupAddress(projectId, v.raw, v.name, v.dpt, v.security), onSuccess: after }),
    deleteGa: useMutation({ mutationFn: (raw: number) => api.deleteGroupAddress(projectId, raw), onSuccess: after }),
  };
}

// Building-structure edits (spaces + device assignment). Each returns the
// refreshed project, applied immediately. A delete captures an undo snapshot
// server-side; assignment can move a device between rooms. The project (device
// grouping), dashboard counts and the snapshot list are refreshed.
export function useSpaceEdit(projectId: string) {
  const qc = useQueryClient();
  const after = (project: Awaited<ReturnType<typeof api.getProject>>) => {
    qc.setQueryData(qk.project(projectId), project);
    void qc.invalidateQueries({ queryKey: qk.projects });
    void qc.invalidateQueries({ queryKey: qk.snapshots(projectId) });
  };
  return {
    createSpace: useMutation({ mutationFn: (v: { parentId: number | null; type: string; name: string }) => api.createSpace(projectId, v.parentId, v.type, v.name), onSuccess: after }),
    renameSpace: useMutation({ mutationFn: (v: { spaceId: number; name: string }) => api.renameSpace(projectId, v.spaceId, v.name), onSuccess: after }),
    deleteSpace: useMutation({ mutationFn: (spaceId: number) => api.deleteSpace(projectId, spaceId), onSuccess: after }),
    assignDevice: useMutation({ mutationFn: (v: { deviceId: string; spaceId: number | null }) => api.assignDeviceSpace(projectId, v.deviceId, v.spaceId), onSuccess: after }),
  };
}

// Devices linked to a group address, fetched only when the details overlay opens
// (enabled). Language-keyed so com-object names match the UI; cached briefly so
// reopening the same GA is instant.
export const useGaDevices = (id: string, raw: number, enabled: boolean) => {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return useQuery({ queryKey: qk.gaDevices(id, raw, lang), queryFn: () => api.gaDevices(id, raw, lang), enabled, staleTime: 30_000 });
};

// Add or remove an assigned sender of a group address; refreshes that address's overlay.
export const useGaSenders = (id: string, raw: number) => {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ["gaDevices", id, raw] });
  return {
    add: useMutation({ mutationFn: (ia: string) => api.addGaSender(id, raw, ia), onSuccess: done }),
    remove: useMutation({ mutationFn: (ia: string) => api.removeGaSender(id, raw, ia), onSuccess: done }),
  };
};

export const useSendGroup = (id: string) =>
  useMutation({ mutationFn: (v: { ga: number; service: "write" | "read"; value?: string }) => api.sendGroup(id, v.ga, v.service, v.value) });

// Invalidate everything that a device edit can change: its config view and the
// project (per-device change counts live there). Edits request the current UI
// language so the returned view's catalogue text matches what is on screen.
export function useDeviceEdit(projectId: string, deviceId: string) {
  const qc = useQueryClient();
  const { i18n } = useTranslation();
  const lang = i18n.language;
  // Invalidate by the lang-agnostic prefix so cached views in any language refresh.
  const after = () => {
    void qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] });
    void qc.invalidateQueries({ queryKey: qk.project(projectId) });
  };
  const onSuccess = (view: Awaited<ReturnType<typeof api.deviceConfig>>) => {
    // Apply the returned (current-language) view instantly, and mark the other
    // cached languages stale so a later language switch refetches the edit
    // (without a redundant refetch of the view we just set).
    qc.setQueryData(qk.deviceConfig(projectId, deviceId, lang), view);
    void qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId], refetchType: "none" });
    void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    // Link edits (setLink, revert*, replaceProduct) change which devices a GA
    // reaches, so the GA details overlay must not serve its stale sender/receiver list.
    void qc.invalidateQueries({ queryKey: ["gaDevices", projectId] });
  };
  const setParam = useMutation({
    mutationFn: (v: { refId: string; value: string }) => api.setDeviceParam(projectId, deviceId, v.refId, v.value, lang),
    onSuccess,
  });
  const setLink = useMutation({
    mutationFn: (v: { comObjRefId: string; gaRaws: number[]; allowPlain?: boolean }) => api.setDeviceLink(projectId, deviceId, v.comObjRefId, v.gaRaws, lang, v.allowPlain),
    onSuccess,
  });
  const revert = useMutation({
    mutationFn: () => api.revertDevice(projectId, deviceId, lang),
    onSuccess,
  });
  const revertParam = useMutation({
    mutationFn: (refId: string) => api.revertParam(projectId, deviceId, refId, lang),
    onSuccess,
  });
  const setFlags = useMutation({
    mutationFn: (v: { comObjRefId: string; edit: ComObjFlagEdit }) => api.setComObjFlags(projectId, deviceId, v.comObjRefId, v.edit, lang),
    onSuccess,
  });
  const revertFlags = useMutation({
    mutationFn: (comObjRefId: string) => api.revertComObjFlags(projectId, deviceId, comObjRefId, lang),
    onSuccess,
  });
  const revertLink = useMutation({
    mutationFn: (comObjRefId: string) => api.revertLink(projectId, deviceId, comObjRefId, lang),
    onSuccess,
  });
  // Read the device's state off the bus and adopt it as the baseline; the
  // refreshed view flags any rows that drift from the project config.
  const readBack = useMutation({
    mutationFn: (assume?: AssumedValue[]) => api.readBackDevice(projectId, deviceId, lang, assume),
    onSuccess,
  });
  // Swap the device's product for a catalog product, migrating its GA links
  // through the given mapping. Returns the fresh config view of the NEW app.
  const replaceProduct = useMutation({
    mutationFn: (v: { appRef: string; productRef: string; mapping: ReplaceMappingEntry[] }) =>
      api.replaceDevice(projectId, deviceId, v.appRef, v.productRef, v.mapping, lang),
    onSuccess,
  });
  return { setParam, setLink, setFlags, revertFlags, revert, revertParam, revertLink, readBack, replaceProduct, after };
}
