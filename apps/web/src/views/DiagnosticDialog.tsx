import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Ban, Check, Circle, Download, FileJson, Loader2, ShieldAlert, Stethoscope, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError, taskActive, type DiagnosticPackage, type Task } from "../api.ts";
import { qk } from "../queries.ts";
import { errMsg, localizeError } from "../lib/apiError.ts";
import { diagnosticFileName, diagnosticFileText, diagnosticStatus, diagnosticSummary } from "../lib/diagnostic.ts";

// The diagnostic package (docs/raw-acquisition.md, "Diagnostic package"): consent to one fixed read,
// its progress with a cancel that discards everything, then the cleaned file, reviewed in full before
// the browser saves it. Opened from the device page (consent first) or for a task that already
// exists (taskId: progress or review straight away).

const PHASES = ["connect", "descriptor", "authorize", "identity", "scan", "memory", "security-mode"] as const;

type DeviceRef = { id: string; ia: string; name: string; secure?: boolean };

export function DiagnosticDialog({ projectId, device, taskId: initialTaskId, open, onOpenChange }: {
  projectId: string; device: DeviceRef; taskId?: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [taskId, setTaskId] = useState<string | null>(initialTaskId ?? null);
  // Set once the user asked to cancel: the task stays running until the read has stopped.
  const [cancelAsked, setCancelAsked] = useState(false);
  // The read had finished before the cancel reached the server; its package was dropped all the same.
  const [discarded, setDiscarded] = useState(false);
  useEffect(() => { if (open) { setTaskId(initialTaskId ?? null); setCancelAsked(false); setDiscarded(false); } }, [open, initialTaskId]);

  const start = useMutation({
    mutationFn: () => api.createDiagnostic(projectId, device.id),
    onSuccess: (task) => { setTaskId(task.id); void qc.invalidateQueries({ queryKey: qk.tasks(projectId) }); },
    onError: (e) => toast.error(t("diagnostic.failedEarly"), { description: errMsg(t, e) }),
  });
  const taskQ = useQuery({
    queryKey: ["task", projectId, taskId],
    queryFn: () => api.task(projectId, taskId!),
    enabled: open && taskId !== null,
    refetchInterval: (q) => {
      if (q.state.status === "error") return false;
      const d = q.state.data as Task | undefined;
      return !d || taskActive(d) ? 500 : false;
    },
  });
  const task = taskQ.data && taskQ.data.id === taskId ? taskQ.data : null;
  // A task that ended in an error has a package only when the link broke off mid-read (COLLECT_FAILED).
  const hasPackage = !!task && (task.state === "done" || (task.state === "error" && task.errorCode === "COLLECT_FAILED"));
  const pkgQ = useQuery({
    queryKey: ["diagnostic", projectId, taskId],
    queryFn: () => api.diagnostic(projectId, taskId!),
    enabled: open && hasPackage && !discarded,
    retry: false,
    // A package past its lifetime must not come back from the cache.
    gcTime: 0,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelTask(projectId, taskId!),
    onMutate: () => setCancelAsked(true),
    // "discarded": the read had finished before the cancel arrived; the server dropped its package.
    onSuccess: (r) => { if (r.cancelled === "discarded") setDiscarded(true); },
    onError: (e) => { setCancelAsked(false); toast.error(t("task.cancelError"), { description: errMsg(t, e) }); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["task", projectId, taskId] }); void qc.invalidateQueries({ queryKey: qk.tasks(projectId) }); },
  });

  const stage: "consent" | "running" | "cancelled" | "preview" | "missing" | "failed" | "loading" =
    taskId === null ? "consent"
      : !task ? (taskQ.isError ? "missing" : "loading")
      : taskActive(task) ? "running"
      : task.state === "cancelled" || discarded ? "cancelled"
      : !hasPackage ? "failed"
      : pkgQ.data && !pkgQ.isError ? "preview"
      : pkgQ.isError ? (pkgQ.error instanceof ApiError && pkgQ.error.code === "DIAGNOSTIC_NOT_FOUND" ? "missing" : "failed")
      : "loading";
  // A running read is left by its own cancel button only: closing the dialog would leave no way back
  // to it.
  const dismissible = stage !== "running";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (o || dismissible) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl" dismissible={dismissible}>
        {stage === "consent" && <Consent device={device} starting={start.isPending} onStart={() => start.mutate()} onCancel={() => onOpenChange(false)} />}
        {stage === "running" && task && <Progress task={task} device={device} cancelling={cancelAsked} onCancel={() => cancel.mutate()} />}
        {stage === "cancelled" && (
          <Notice icon={<Ban className="size-4 text-muted-foreground" />} title={t("diagnostic.cancelled.title")} body={t("diagnostic.cancelled.body")} onClose={() => onOpenChange(false)} />
        )}
        {stage === "missing" && (
          <Notice icon={<FileJson className="size-4 text-muted-foreground" />} title={t("diagnostic.missing.title")} body={t("diagnostic.missing.body")} onClose={() => onOpenChange(false)} />
        )}
        {stage === "failed" && (
          <Notice
            icon={<ShieldAlert className="size-4 text-destructive" />} title={t("diagnostic.failedEarly")}
            body={task ? localizeError(t, task.errorCode, task.error) : errMsg(t, pkgQ.error)} onClose={() => onOpenChange(false)}
          />
        )}
        {stage === "loading" && <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
        {stage === "preview" && pkgQ.data && <Preview pkg={pkgQ.data} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function Notice({ icon, title, body, onClose }: { icon: React.ReactNode; title: string; body: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">{icon} {title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
      </DialogHeader>
      <DialogFooter><Button variant="outline" onClick={onClose}>{t("diagnostic.preview.close")}</Button></DialogFooter>
    </>
  );
}

function Consent({ device, starting, onStart, onCancel }: { device: DeviceRef; starting: boolean; onStart: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Stethoscope className="size-4 text-primary" /> {t("diagnostic.consent.title")}</DialogTitle>
        <DialogDescription>{t("diagnostic.consent.intro", { ia: device.ia, name: device.name })}</DialogDescription>
      </DialogHeader>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1" data-testid="diag-consent">
        <Section title={t("diagnostic.consent.whatTitle")}>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("diagnostic.consent.identity")}</li>
            <li>{t("diagnostic.consent.objects")}</li>
            <li>{t("diagnostic.consent.memory")}</li>
          </ul>
          {device.secure && <p className="mt-2" data-testid="diag-consent-secure">{t("diagnostic.consent.secure")}</p>}
        </Section>
        <Section title={t("diagnostic.consent.limitsTitle")}>{t("diagnostic.consent.limits")}</Section>
        <Section title={t("diagnostic.consent.busTitle")}>{t("diagnostic.consent.bus")}</Section>
        <Section title={t("diagnostic.consent.staysTitle")}>{t("diagnostic.consent.stays")}</Section>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button onClick={onStart} disabled={starting} data-testid="diag-start">
          {starting && <Loader2 className="size-4 animate-spin" />} {t("diagnostic.consent.start")}
        </Button>
      </DialogFooter>
    </>
  );
}

const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

function Progress({ task, device, cancelling, onCancel }: { task: Task; device: DeviceRef; cancelling: boolean; onCancel: () => void }) {
  const { t } = useTranslation();
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  const current = task.state === "running" ? Math.max(0, PHASES.indexOf((task.phase ?? "connect") as typeof PHASES[number])) : -1;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Loader2 className="size-4 animate-spin text-primary" /> {t("diagnostic.progress.title")}</DialogTitle>
        <DialogDescription>{device.ia} · {device.name}</DialogDescription>
      </DialogHeader>
      {task.state === "queued" ? (
        <p className="text-sm text-muted-foreground" data-testid="diag-queued">{t("diagnostic.progress.queued")}</p>
      ) : (
        <ol className="space-y-2" data-testid="diag-progress">
          {PHASES.map((p, i) => {
            // Steps before the current one are behind the read; a mask's plan may have skipped some.
            const state = i < current ? "done" : i === current ? "active" : "todo";
            return (
              <li key={p} className="flex items-center gap-2 text-sm" data-state={state}>
                {state === "done" ? <Check className="size-4 text-muted-foreground" /> : state === "active" ? <Loader2 className="size-4 animate-spin text-primary" /> : <Circle className="size-4 text-muted-foreground/50" />}
                <span className={state === "todo" ? "text-muted-foreground" : ""}>{t(`diagnostic.progress.phases.${p}`)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {task.state === "running" && (
        <p className="font-mono text-xs text-muted-foreground" data-testid="diag-counters">
          {t("diagnostic.progress.counters", { count: task.done, elapsed: mmss(Date.now() - (task.startedAt ?? Date.now())) })}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t("diagnostic.progress.cancelHint")}</p>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={cancelling} data-testid="diag-cancel">
          {cancelling ? <><Loader2 className="size-4 animate-spin" /> {t("diagnostic.progress.cancelling")}</> : <><X className="size-4" /> {t("diagnostic.progress.cancel")}</>}
        </Button>
      </DialogFooter>
    </>
  );
}

function Preview({ pkg, onClose }: { pkg: DiagnosticPackage; onClose: () => void }) {
  const { t } = useTranslation();
  const text = useMemo(() => diagnosticFileText(pkg), [pkg]);
  const fileName = diagnosticFileName(pkg);
  const size = useMemo(() => new Blob([text]).size, [text]);
  const s = useMemo(() => diagnosticSummary(pkg), [pkg]);
  const status = diagnosticStatus(pkg);
  const save = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = fileName; a.click();
    // Revoked only after the browser has taken the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const kind = pkg.connection.kind === "usb"
    ? t("diagnostic.preview.kinds.usb", { model: [pkg.connection.usbVendorId, pkg.connection.usbProductId].map((n) => n === null ? "?" : n.toString(16).padStart(4, "0")).join(":") })
    : t("diagnostic.preview.kinds.ip", { transport: pkg.connection.ipTransport.toUpperCase() });
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FileJson className="size-4 text-primary" /> {t("diagnostic.preview.title")}</DialogTitle>
        <DialogDescription data-testid="diag-status" data-status={status.key}>{t(`diagnostic.preview.status.${status.key}`)}</DialogDescription>
      </DialogHeader>
      <Tabs defaultValue="summary" className="min-w-0" data-testid="diag-preview">
        <TabsList>
          <TabsTrigger value="summary">{t("diagnostic.preview.tabSummary")}</TabsTrigger>
          <TabsTrigger value="file" data-testid="diag-tab-file">{t("diagnostic.preview.tabFile")}</TabsTrigger>
        </TabsList>
        <TabsContent value="summary" data-testid="diag-summary" className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
          <Section title={t("diagnostic.preview.containsTitle")}>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("diagnostic.preview.contains.identity", { ia: pkg.ia, mask: pkg.mask ?? "?" })}</li>
              <li>{t("diagnostic.preview.contains.objects", { count: s.objects, props: s.properties })}</li>
              <li>{t("diagnostic.preview.contains.memory", { bytes: s.memoryBytes })}</li>
              <li>{t("diagnostic.preview.contains.gaps", { count: s.gaps })}</li>
              <li>{t("diagnostic.preview.contains.connection", { kind })}</li>
              <li>{t("diagnostic.preview.contains.times")}</li>
              <li>{t("diagnostic.preview.contains.version", { version: `${pkg.busforge.version} (${pkg.busforge.commit})` })}</li>
            </ul>
          </Section>
          <Section title={t("diagnostic.preview.removedTitle")}>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("diagnostic.preview.removed.ids")}</li>
              <li>{t("diagnostic.preview.removed.route")}</li>
              <li>{t("diagnostic.preview.removed.serial")}</li>
            </ul>
          </Section>
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <div><p className="font-medium">{t("diagnostic.preview.rawTitle")}</p><p>{t("diagnostic.preview.raw")}</p></div>
          </div>
          <Section title={t("diagnostic.preview.keepTitle")}>
            <p>{t("diagnostic.preview.keep")}</p>
            <p className="mt-1">{t("diagnostic.preview.lifetime")}</p>
          </Section>
        </TabsContent>
        <TabsContent value="file" className="min-w-0 space-y-2">
          <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono" data-testid="diag-file-name">{fileName}</span>
            <span className="shrink-0">{size} B · {t("diagnostic.preview.fileHint")}</span>
          </p>
          <pre className="max-h-[50vh] w-full overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11px] leading-snug" data-testid="diag-file">{text}</pre>
        </TabsContent>
      </Tabs>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t("diagnostic.preview.close")}</Button>
        <Button onClick={save} data-testid="diag-save"><Download className="size-4" /> {t("diagnostic.preview.save")}</Button>
      </DialogFooter>
    </>
  );
}
