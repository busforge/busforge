import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, RadioTower, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type AssignIaResult, type Device, type DeviceConfigView, type FlashResult } from "../api.ts";
import { UntestedNotice, useRefreshOnUntested } from "@/components/UntestedNotice.tsx";
import { untestedOps } from "../lib/untested.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { errMsg } from "../lib/apiError.ts";

interface ScanState { running: boolean; devices: string[] | null; error: unknown }
interface AssignState { running: boolean; result: AssignIaResult | null; error: unknown }
interface DownloadState { checking: boolean; dry: FlashResult | null; running: boolean; done: FlashResult | null; error: unknown }
const freshScan = (): ScanState => ({ running: false, devices: null, error: null });
const freshAssign = (): AssignState => ({ running: false, result: null, error: null });
const freshDownload = (): DownloadState => ({ checking: false, dry: null, running: false, done: null, error: null });

// The bytes of a verified write the device does not give back when read, resting on its write
// confirmation alone (FlashResult.confirmedOnly).
const confirmedOnlyBytes = (r: FlashResult) => (r.kind === "flashed" && r.confirmedOnly ? r.confirmedOnly.reduce((n, x) => n + x.length, 0) : 0);

// Commission a device onto the bus: scan for programming mode, assign the
// project's individual address to the ONE device in programming mode, then run
// the full download (application id + parameters + com-object table + group
// tables). Every step is gated on the previous one having VERIFIED: an
// unverified assign or download is shown as the failure it is, never as success.
export function CommissionDialog({ open, onOpenChange, projectId, device, onCommissioned, view }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  onCommissioned?: () => void;
  // The device's configuration view: its compatibility and whether its Product was acknowledged as untested.
  view?: Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged">;
}) {
  const { t } = useTranslation();
  const [scan, setScan] = useState<ScanState>(freshScan);
  const [assign, setAssign] = useState<AssignState>(freshAssign);
  const [dl, setDl] = useState<DownloadState>(freshDownload);
  // The full download of an untested Product needs the acknowledgement; assigning the address does
  // not (the server does not gate it, and an address change runs through this dialog too). The notice
  // shows from the start, so the user knows before assigning.
  const awaitingAck = untestedOps(view, ["fullDownload"]).length > 0;
  const refreshOnUntested = useRefreshOnUntested(projectId, device.id);
  const busyRef = useRef(false); // guards against a same-tick double click

  const doScan = useCallback(() => {
    // A rescan restarts the whole flow: the assign step trusts THIS scan's picture.
    setScan({ ...freshScan(), running: true });
    setAssign(freshAssign());
    setDl(freshDownload());
    api.progMode(projectId)
      .then((devices) => setScan({ running: false, devices, error: null }))
      .catch((e) => setScan({ running: false, devices: null, error: e }));
  }, [projectId]);

  useEffect(() => { if (open) doScan(); }, [open, doScan]);

  // Dry-run the download right after a verified assign, so the user confirms the
  // real write against a concrete byte count (mirrors FlashDialog's preview).
  const runCheck = () => {
    setDl({ ...freshDownload(), checking: true });
    api.downloadDevice(projectId, device.id, true)
      .then((dry) => setDl((d) => ({ ...d, checking: false, dry })))
      .catch((e) => setDl((d) => ({ ...d, checking: false, error: e })));
  };

  const doAssign = () => {
    if (busyRef.current || assign.running) return;
    busyRef.current = true;
    setAssign({ ...freshAssign(), running: true });
    api.assignIa(projectId, device.id)
      .then((result) => {
        setAssign({ running: false, result, error: null });
        if (result.verified) runCheck();
      })
      .catch((e) => setAssign({ running: false, result: null, error: e }))
      .finally(() => { busyRef.current = false; });
  };

  const doDownload = () => {
    if (busyRef.current || dl.running) return;
    busyRef.current = true;
    setDl((d) => ({ ...d, running: true, error: null }));
    api.downloadDevice(projectId, device.id, false)
      .then((done) => {
        setDl((d) => ({ ...d, running: false, done }));
        if (done.kind === "flashed" && done.verified) onCommissioned?.();
      })
      .catch((e) => { refreshOnUntested(e); setDl((d) => ({ ...d, running: false, error: e })); })
      .finally(() => { busyRef.current = false; });
  };

  const busOpRunning = assign.running || dl.running;
  const assignVerified = !!assign.result?.verified;
  const scanReady = !scan.running && !!scan.devices;
  const exactlyOne = scan.devices?.length === 1;
  const canAssign = scanReady && exactlyOne && !assign.result && !assign.error && !busOpRunning;
  const canDownload = assignVerified && dl.dry?.kind === "dryRun" && !dl.done && !busOpRunning && !dl.checking;
  const finished = !!dl.done;

  const line = (icon: ReactNode, text: ReactNode, tone: "muted" | "ok" | "warn" | "err" | "run" = "muted") => (
    <span className={{
      muted: "flex items-start gap-2 text-muted-foreground",
      ok: "flex items-start gap-2 text-ok",
      warn: "flex items-start gap-2 text-amber-600 dark:text-amber-400",
      err: "flex items-start gap-2 text-destructive",
      run: "flex items-start gap-2 text-primary",
    }[tone]}>{icon}{text}</span>
  );
  const spinner = <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />;
  const okIcon = <CheckCircle2 className="mt-0.5 size-4 shrink-0" />;
  const warnIcon = <AlertTriangle className="mt-0.5 size-4 shrink-0" />;

  const scanLine = () => {
    if (scan.running) return line(spinner, t("commission.scanning"), "run");
    if (scan.error) return line(warnIcon, errMsg(t, scan.error), "err");
    if (!scan.devices) return <span className="text-muted-foreground">…</span>;
    if (scan.devices.length === 0) return line(warnIcon, `${t("commission.scanNone")} ${t("commission.scanHint")}`, "warn");
    if (scan.devices.length > 1) return line(warnIcon, t("commission.scanMany", { count: scan.devices.length, ias: scan.devices.join(", ") }), "warn");
    return line(okIcon, t("commission.scanOne", { ia: scan.devices[0] }), "ok");
  };

  const assignLine = () => {
    if (assign.running) return line(spinner, t("commission.assigning"), "run");
    // A failed or unverified assign is a terminal commission failure; mark it so a driver waiting on
    // the download step sees the failure instead of hanging (the smoke UI channel keys on this).
    if (assign.error) return <span data-testid="commission-fail">{line(warnIcon, errMsg(t, assign.error), "err")}</span>;
    const r = assign.result;
    if (!r) return <span className="text-muted-foreground">…</span>;
    return (
      <span className="flex flex-col gap-0.5">
        {r.verified
          ? line(okIcon, t("commission.assigned", { previous: r.previous, assigned: r.assigned }), "ok")
          : <span data-testid="commission-fail">{line(warnIcon, t("commission.assignedUnverified", { ia: device.ia }), "err")}</span>}
        {r.verified && !r.progModeCleared && line(warnIcon, t("commission.progModeNotCleared", { error: r.progModeError ?? "?" }), "warn")}
      </span>
    );
  };

  const downloadLine = () => {
    if (dl.running) return line(spinner, t("commission.downloading"), "run");
    if (dl.done) {
      if (dl.done.kind !== "flashed") return <span className="text-muted-foreground">{t("flash.inSync")}</span>;
      return dl.done.verified
        ? <span data-testid="commission-ok">{line(okIcon, t("commission.doneVerified", { bytes: dl.done.diffBytes }), "ok")}{confirmedOnlyBytes(dl.done) > 0 && <span className="text-muted-foreground" data-testid="flash-confirmed-only">{t("flash.confirmedOnly", { bytes: confirmedOnlyBytes(dl.done) })}</span>}</span>
        : <span data-testid="commission-fail">{line(warnIcon, t("commission.doneUnverified"), "err")}</span>;
    }
    if (dl.error) return <span data-testid="commission-fail">{line(warnIcon, errMsg(t, dl.error), "err")}</span>;
    if (dl.checking) return line(spinner, t("commission.checking"), "run");
    if (dl.dry) return dl.dry.kind === "dryRun"
      ? <span>{t("commission.willWrite", { diff: dl.dry.diffBytes, total: dl.dry.imageBytes, mask: dl.dry.mask })}</span>
      : <span className="text-muted-foreground">{t("flash.inSync")}</span>;
    return <span className="text-muted-foreground">…</span>;
  };

  const steps: { label: string; body: ReactNode }[] = [
    { label: t("commission.stepScan"), body: scanLine() },
    { label: t("commission.stepAssign"), body: assignLine() },
    { label: t("commission.stepDownload"), body: downloadLine() },
  ];

  return (
    // Escape must not close the dialog over a running bus write: reopening would
    // reset the step state around the still-running task and let a fresh scan run
    // beside it, so the dialog stays up until the operation reports its result.
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && busOpRunning) return; onOpenChange(o); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <RadioTower className="size-4 text-primary" /> {t("commission.title", { device: device.name || device.ia })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("commission.description", { ia: device.ia })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
          {steps.map((s, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">{i + 1} · {s.label}</span>
              {s.body}
            </div>
          ))}
        </div>

        {!finished && <UntestedNotice projectId={projectId} deviceId={device.id} view={view} ops={["fullDownload"]} />}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busOpRunning}>{finished ? t("common.close") : t("common.cancel")}</AlertDialogCancel>
          {!assign.result && !busOpRunning && !scan.running && (
            <Button variant="outline" onClick={doScan} data-testid="commission-rescan">
              <RefreshCw className="size-4" /> {scan.devices || scan.error ? t("commission.rescan") : t("commission.scan")}
            </Button>
          )}
          {canAssign && (
            <Button onClick={doAssign} data-testid="commission-assign">
              <RadioTower className="size-4" /> {t("commission.assign", { ia: device.ia })}
            </Button>
          )}
          {/* Retry the failed preview without redoing the (already verified) assign. */}
          {assignVerified && !!dl.error && !dl.done && !busOpRunning && !dl.checking && (
            <Button variant="outline" onClick={runCheck} data-testid="commission-recheck">
              <RefreshCw className="size-4" /> {t("common.retry")}
            </Button>
          )}
          {canDownload && (
            <Button onClick={doDownload} disabled={awaitingAck} data-testid="commission-download">
              <Download className="size-4" /> {t("commission.download")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
