import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, Ban, CheckCircle2, Clock, Cpu, Download, Loader2, Network, Plug, PlugZap, Rocket, Tag, Usb, X } from "lucide-react";
import { toast } from "sonner";
import type { BusStatus, ConnectionType, Task, TaskKind } from "../api.ts";
import { api } from "../api.ts";
import { qk, useBusStatus, useConnections, useProject, useTasks } from "../queries.ts";
import { ConnectionManager, connDetail } from "../views/ConnectionManager.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { errMsg, localizeError } from "../lib/apiError.ts";

const KIND_ICON: Record<TaskKind, typeof Cpu> = { read: Download, "flash-params": Cpu, "flash-ga": Network, "assign-ia": Tag, download: Rocket };
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
  // A write the server was stopped in: the device's state is unknown, which must not hide in a popover.
  const interruptedWrite = tasks.some((x) => x.state === "interrupted" && x.writes);

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
              {interruptedWrite && <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-label={t("task.interruptedWrite")} data-testid="task-interrupted-write" />}
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

const ConnIcon = ({ type, className }: { type: ConnectionType; className?: string }) =>
  type === "usb" ? <Usb className={className} /> : <Network className={className} />;

// Connection control at the top of the bus popover. You pick which SAVED
// connection a project uses (the details are configured in the connection
// manager), then connect/disconnect. Single source of truth: the project just
// references a connection from the global library.
function ConnectionPanel({ projectId, status }: { projectId: string; status: BusStatus }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: project } = useProject(projectId);
  const { data: saved = [] } = useConnections();
  const selectedId = project?.connectionId ?? null;
  const selected = saved.find((c) => c.id === selectedId) ?? null;

  const refreshStatus = () => { void qc.invalidateQueries({ queryKey: qk.busStatus(projectId) }); };

  const selectMut = useMutation({
    mutationFn: (cid: string) => api.setProjectConnection(projectId, cid),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project(projectId) }),
    onError: (e) => toast.error(errMsg(t, e)),
  });
  const connectMut = useMutation({
    mutationFn: () => api.busConnect(projectId),
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
          disabled={busy || (!connected && !selected)}
          variant={connected ? "destructive" : "default"}
          data-testid="connect"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : connected ? <Plug className="size-4" /> : <PlugZap className="size-4" />}
          {busy ? "…" : connected ? t("iface.disconnect") : t("iface.connect")}
        </Button>
      </div>

      {editable ? (
        <div className="space-y-2 px-1">
          {saved.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("iface.noConnections")}</p>
          ) : (
            <Select value={selectedId ?? undefined} onValueChange={(v) => selectMut.mutate(v)}>
              <SelectTrigger className="h-8 w-full text-sm" data-testid="connection-select">
                <SelectValue placeholder={t("iface.savedPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {saved.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="flex items-center gap-2">
                      <ConnIcon type={c.type} className="size-3.5 text-muted-foreground" />
                      <span>{c.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{connDetail(c)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex justify-end"><ConnectionManager /></div>
        </div>
      ) : (
        selected && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <ConnIcon type={selected.type} className="size-3.5 shrink-0" />
            <span className="truncate">{selected.name}</span>
            <span className="truncate font-mono text-[11px]">{connDetail(selected)}</span>
          </div>
        )
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
          {task.state === "interrupted" && <AlertTriangle className={cn("size-3.5", task.writes ? "text-destructive" : "text-muted-foreground")} />}
          {onCancel && (
            <Button type="button" variant="ghost" size="icon" className="size-6 text-muted-foreground hover:text-destructive" title={t(task.state === "running" ? "task.cancelRead" : "task.cancel")} disabled={canceling} onClick={onCancel}>
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
          {task.writes && <div className="mt-0.5 text-[10px] text-muted-foreground">{t("task.writeNotCancellable")}</div>}
        </div>
      )}
      {task.state === "queued" && <div className="mt-0.5 text-[10px] text-muted-foreground">{t("task.queued")}</div>}
      {task.state === "cancelled" && <div className="mt-0.5 text-[10px] text-muted-foreground">{task.errorCode ? localizeError(t, task.errorCode, task.error) : t("task.cancelled")}</div>}
      {(task.state === "error" || task.state === "interrupted") && (() => { const msg = localizeError(t, task.errorCode, task.error); return <div className="mt-0.5 truncate text-[10px] text-destructive" title={msg}>{msg}</div>; })()}
    </div>
  );
}
