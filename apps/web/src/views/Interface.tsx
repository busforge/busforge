import { useEffect, useState } from "react";
import { Loader2, Network, Plug, PlugZap } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../api.ts";
import { qk, useProject, useBusStatus } from "../queries.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/StatusBadge.tsx";
import { errMsg } from "../lib/apiError.ts";

export function InterfaceView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const qc = useQueryClient();
  const { data: project } = useProject(projectId);
  const { data: bus } = useBusStatus(projectId);
  const status = bus?.status ?? "disconnected";

  const [ip, setIp] = useState("");
  const [port, setPort] = useState("3671");
  // Seed the fields once the project loads (and when switching projects).
  useEffect(() => {
    if (project) { setIp(project.interface.interfaceIp); setPort(String(project.interface.port)); }
  }, [project?.id]);

  const refreshStatus = () => qc.invalidateQueries({ queryKey: qk.busStatus(projectId) });

  const saveMut = useMutation({
    mutationFn: () => api.saveInterface(projectId, { interfaceIp: ip, port: Number(port) }),
    onSuccess: (s) => { setIp(s.interfaceIp); setPort(String(s.port)); qc.invalidateQueries({ queryKey: qk.project(projectId) }); },
  });

  const connectMut = useMutation({
    mutationFn: async () => { await saveMut.mutateAsync(); return api.busConnect(projectId); },
    onSuccess: () => { refreshStatus(); toast.success(t("iface.connected")); },
    onError: (e) => { toast.error(t("iface.connectFailed"), { description: errMsg(t, e) }); refreshStatus(); },
  });
  const disconnectMut = useMutation({
    mutationFn: () => api.busDisconnect(projectId),
    onSuccess: () => { refreshStatus(); toast.message(t("iface.disconnected")); },
    onError: (e) => { toast.error(t("iface.disconnectFailed"), { description: errMsg(t, e) }); refreshStatus(); },
  });

  const connected = status === "connected";
  const busy = connectMut.isPending || disconnectMut.isPending;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Network className="size-4 text-primary" /> {t("iface.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>{t("iface.ipLabel")}</Label>
              <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="198.51.100.10" className="font-mono" data-testid="ip" />
            </div>
            <div className="space-y-1.5">
              <Label>{t("iface.portLabel")}</Label>
              <Input value={port} onChange={(e) => setPort(e.target.value)} className="font-mono" />
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => saveMut.mutate(undefined, { onSuccess: () => toast.success(t("iface.saved")), onError: (e) => toast.error(t("iface.saveFailed"), { description: errMsg(t, e) }) })}
            disabled={saveMut.isPending}
          >
            {t("common.save")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Plug className="size-4 text-primary" /> {t("iface.connectionTitle")}</CardTitle></CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <StatusBadge status={busy && !connected ? "connecting" : status} />
          <Button
            onClick={() => (connected ? disconnectMut.mutate() : connectMut.mutate())}
            disabled={busy} variant={connected ? "destructive" : "default"} data-testid="connect"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : connected ? <Plug className="size-4" /> : <PlugZap className="size-4" />}
            {busy ? "…" : connected ? t("iface.disconnect") : t("iface.connect")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
