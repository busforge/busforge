// TanStack Query hooks over the API client. Query keys are centralized so
// mutations can invalidate precisely. Reads are hooks; writes use useMutation in
// the components with explicit invalidation.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api.ts";

export const qk = {
  projects: ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  busStatus: (id: string) => ["busStatus", id] as const,
  telegrams: (id: string) => ["telegrams", id] as const,
  // lang is part of the key so switching the UI language refetches the
  // catalogue text in that language; the server maps it to the nearest
  // available catalogue language.
  deviceConfig: (id: string, deviceId: string, lang: string) => ["deviceConfig", id, deviceId, lang] as const,
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

export const useDeviceConfig = (id: string, deviceId: string) => {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  return useQuery({ queryKey: qk.deviceConfig(id, deviceId, lang), queryFn: () => api.deviceConfig(id, deviceId, lang) });
};

// Invalidate everything that a device edit can change: its config view and the
// project (per-device change counts live there). Edits request the current UI
// language so the returned view's catalogue text matches what is on screen.
export function useDeviceEdit(projectId: string, deviceId: string) {
  const qc = useQueryClient();
  const { i18n } = useTranslation();
  const lang = i18n.language;
  // Invalidate by the lang-agnostic prefix so cached views in any language refresh.
  const after = () => {
    qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] });
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
  };
  const onSuccess = (view: Awaited<ReturnType<typeof api.deviceConfig>>) => {
    // Apply the returned (current-language) view instantly, and mark the other
    // cached languages stale so a later language switch refetches the edit
    // (without a redundant refetch of the view we just set).
    qc.setQueryData(qk.deviceConfig(projectId, deviceId, lang), view);
    qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId], refetchType: "none" });
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
  };
  const setParam = useMutation({
    mutationFn: (v: { refId: string; value: string }) => api.setDeviceParam(projectId, deviceId, v.refId, v.value, lang),
    onSuccess,
  });
  const setLink = useMutation({
    mutationFn: (v: { comObjRefId: string; gaRaws: number[] }) => api.setDeviceLink(projectId, deviceId, v.comObjRefId, v.gaRaws, lang),
    onSuccess,
  });
  const revert = useMutation({
    mutationFn: () => api.revertDevice(projectId, deviceId, lang),
    onSuccess,
  });
  return { setParam, setLink, revert, after };
}
