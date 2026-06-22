// TanStack Query hooks over the API client. Query keys are centralized so
// mutations can invalidate precisely. Reads are hooks; writes use useMutation in
// the components with explicit invalidation.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

export const LANG = "de-DE"; // falls back to the manufacturer default when unavailable

export const qk = {
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  busStatus: (id: string) => ["busStatus", id] as const,
  telegrams: (id: string) => ["telegrams", id] as const,
  deviceConfig: (id: string, deviceId: string) => ["deviceConfig", id, deviceId] as const,
};

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: api.listProjects });

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

export const useDeviceConfig = (id: string, deviceId: string) =>
  useQuery({ queryKey: qk.deviceConfig(id, deviceId), queryFn: () => api.deviceConfig(id, deviceId, LANG) });

// Invalidate everything that a device edit can change: its config view and the
// project (per-device change counts live there).
export function useDeviceEdit(projectId: string, deviceId: string) {
  const qc = useQueryClient();
  const after = () => {
    qc.invalidateQueries({ queryKey: qk.deviceConfig(projectId, deviceId) });
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
  };
  const setParam = useMutation({
    mutationFn: (v: { refId: string; value: string }) => api.setDeviceParam(projectId, deviceId, v.refId, v.value, LANG),
    onSuccess: (view) => { qc.setQueryData(qk.deviceConfig(projectId, deviceId), view); qc.invalidateQueries({ queryKey: qk.project(projectId) }); },
  });
  const setLink = useMutation({
    mutationFn: (v: { comObjRefId: string; gaRaws: number[] }) => api.setDeviceLink(projectId, deviceId, v.comObjRefId, v.gaRaws),
    onSuccess: (view) => { qc.setQueryData(qk.deviceConfig(projectId, deviceId), view); qc.invalidateQueries({ queryKey: qk.project(projectId) }); },
  });
  return { setParam, setLink, after };
}
