import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertCircle, Ban, CheckCircle2, Clock, Cpu, Download, Loader2, Network, Plug, PlugZap, X } from "lucide-react";
import { toast } from "sonner";
import type { BusStatus, Task, TaskKind } from "../api.ts";
import { api } from "../api.ts";
import { qk, useBusStatus, useProject, useTasks } from "../queries.ts";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { errMsg, localizeError } from "../lib/apiError.ts";

const KIND_ICON: Record<TaskKind, typeof Cpu> = { read: Download, "flash-params": Cpu, "flash-ga": Network };
const pct = (t: Task) => (t.total > 0 ? Math.round((t.done / t.total) * 100) : null);
const dotColor = (s: BusStatus) => (s === "connected" ? "bg-ok" : s === "connecting" ? "bg-primary" : "bg-muted-foreground");
// A flash mid-write would corrupt the device, so only queued tasks and running reads can be cancelled.
const cancellable = (t: Task) => t.state === "queued" || (t.state === "running" && t.kind === "read");

// Combined header widget for the bus: shows the connection status when idle, the
// running operation (with live progress) when busy, and a popover that holds the
// interface configuration (IP/port + connect/disconnect) plus every queued/recent
// task. The bus is serialized server-side, so this is the single place the bus's
// configuration and activity are surfaced.
export function TaskIndicator({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: tasks = [] } = useTasks(projectId);
  const { data: bus } = useBusStatus(projectId);
  const status: BusStatus = bus?.status ?? "disconnected";
  const cancel = useMutation({
    mutationFn: (taskId: string) => api.cancelTask(projectId, taskId),
    onError: (e) => toast.error(t("task.cancelError"), { description: errMsg(t, e) }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.tasks(projectId) }),
  });

  const active = tasks.filter((x) => x.state === "running" || x.state === "queued");
  const running = tasks.find((x) => x.state === "running");
  const queued = active.filter((x) => x.state === "queued").length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs",
            active.length ? "text-primary" : status === "connected" ? "text-ok" : "text-muted-foreground",
          )}
          data-testid="task-indicator"
        >
          {running ? (
            <>
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="text-muted-foreground">{t(`task.kind.${running.kind}`)}</span>
              <DeviceLabel name={running.deviceName} ia={running.ia} placeholder={false} className="max-w-40" />
              {pct(running) !== null && <span className="shrink-0 tabular-nums text-muted-foreground">{pct(running)}%</span>}
            </>
          ) : (
            <>
              <StatusDot status={status} />
              <span className="font-mono uppercase tracking-wider">{t(`status.${status}`)}</span>
            </>
          )}
          {queued > 0 && <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">+{queued}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-3">
        <ConnectionPanel projectId={projectId} status={status} />
        <div className="mb-1.5 mt-3 border-t border-border/60 px-1 pt-2.5 text-xs font-semibold text-muted-foreground">{t("task.title")}</div>
        {tasks.length === 0 ? (
          <div className="px-1 pb-1 text-xs text-muted-foreground">{t("task.none")}</div>
        ) : (
          <div className="space-y-1">{tasks.map((task) => <TaskRow key={task.id} task={task} t={t} onCancel={cancellable(task) ? () => cancel.mutate(task.id) : undefined} canceling={cancel.isPending} />)}</div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Interface configuration + connection control, living at the top of the bus
// popover. Disconnected: the IP/port fields are editable and the primary button
// saves them and connects. Connected/connecting: the configured endpoint is shown
// read-only and the button disconnects. Replaces the former standalone Interface tab.
function ConnectionPanel({ projectId, status }: { projectId: string; status: BusStatus }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: project } = useProject(projectId);

  const [ip, setIp] = useState("");
  const [port, setPort] = useState("3671");
  // Seed the fields once the project loads (and when switching projects).
  useEffect(() => {
    if (project) { setIp(project.interface.interfaceIp); setPort(String(project.interface.port)); }
  }, [project?.id]);

  const refreshStatus = () => qc.invalidateQueries({ queryKey: qk.busStatus(projectId) });

  const connectMut = useMutation({
    mutationFn: async () => {
      const saved = await api.saveInterface(projectId, { interfaceIp: ip, port: Number(port) });
      setIp(saved.interfaceIp); setPort(String(saved.port));
      qc.invalidateQueries({ queryKey: qk.project(projectId) });
      return api.busConnect(projectId);
    },
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
  const editable = status === "disconnected" && !busy;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2 text-xs">
          <StatusDot status={busy && !connected ? "connecting" : status} />
          <span className={cn("font-mono uppercase tracking-wider", connected ? "text-ok" : "text-muted-foreground")}>
            {t(`status.${busy && !connected ? "connecting" : status}`)}
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => (connected ? disconnectMut.mutate() : connectMut.mutate())}
          disabled={busy || (!connected && !ip.trim())}
          variant={connected ? "destructive" : "default"}
          data-testid="connect"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : connected ? <Plug className="size-4" /> : <PlugZap className="size-4" />}
          {busy ? "…" : connected ? t("iface.disconnect") : t("iface.connect")}
        </Button>
      </div>

      {editable ? (
        <div className="grid grid-cols-3 gap-2 px-1">
          <div className="col-span-2 space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("iface.ipLabel")}</Label>
            <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="198.51.100.10" className="h-8 font-mono text-sm" data-testid="ip" />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">{t("iface.portLabel")}</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} className="h-8 font-mono text-sm" />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-1 font-mono text-xs text-muted-foreground">
          <Network className="size-3.5 shrink-0" />
          <span className="truncate">{ip || "—"}:{port}</span>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: BusStatus }) {
  return (
    <span className="relative flex size-2">
      {status === "connecting" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />}
      <span className={cn("relative inline-flex size-2 rounded-full", dotColor(status))} />
    </span>
  );
}

function TaskRow({ task, t, onCancel, canceling }: { task: Task; t: (k: string, o?: Record<string, unknown>) => string; onCancel?: () => void; canceling?: boolean }) {
  const Icon = KIND_ICON[task.kind];
  const p = pct(task);
  const phaseLabel = task.phase ? t(`task.phase.${task.phase}`) : "";
  return (
    <div className="rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="shrink-0 text-muted-foreground" title={t(`task.kind.${task.kind}`)}><Icon className="size-3.5" /></span>
        <DeviceLabel name={task.deviceName} ia={task.ia} className="min-w-0 flex-1" />
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {task.state === "running" && <Loader2 className="size-3.5 animate-spin text-primary" />}
          {task.state === "queued" && <Clock className="size-3.5 text-muted-foreground" />}
          {task.state === "done" && <CheckCircle2 className="size-3.5 text-ok" />}
          {task.state === "error" && <AlertCircle className="size-3.5 text-destructive" />}
          {task.state === "cancelled" && <Ban className="size-3.5 text-muted-foreground" />}
          {onCancel && (
            <Button type="button" variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" title={t("task.cancel")} disabled={canceling} onClick={onCancel}>
              <X className="size-3.5" />
            </Button>
          )}
        </span>
      </div>
      {task.state === "running" && (
        <div className="mt-1.5">
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full bg-primary transition-all", p === null && "w-1/3 animate-pulse")} style={p !== null ? { width: `${p}%` } : undefined} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>{phaseLabel}</span>
            {p !== null && <span className="tabular-nums">{task.done}/{task.total}</span>}
          </div>
        </div>
      )}
      {task.state === "queued" && <div className="mt-0.5 text-[10px] text-muted-foreground">{t("task.queued")}</div>}
      {task.state === "cancelled" && <div className="mt-0.5 text-[10px] text-muted-foreground">{t("task.cancelled")}</div>}
      {task.state === "error" && (() => { const msg = localizeError(t, task.errorCode, task.error); return <div className="mt-0.5 truncate text-[10px] text-destructive" title={msg}>{msg}</div>; })()}
    </div>
  );
}
