import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Download, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError, type Device, type FlashResult } from "../api.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { errMsg } from "../lib/apiError.ts";

export type FlashTarget = "params" | "ga";
const runDry = (t: FlashTarget, projectId: string, deviceId: string) =>
  (t === "ga" ? api.flashDeviceGa : api.flashDevice)(projectId, deviceId, true);
const runFlash = (t: FlashTarget, projectId: string, deviceId: string) =>
  (t === "ga" ? api.flashDeviceGa : api.flashDevice)(projectId, deviceId, false);

// One preview/write status, reused for each flash target and for the full-download sub-flow
// (same states: checking a dry-run, previewed, writing, done, or errored).
interface Part { dry: FlashResult | null; done: FlashResult | null; error: unknown; checking: boolean; flashing: boolean; }
const freshPart = (): Part => ({ dry: null, done: null, error: null, checking: false, flashing: false });

// Program a device over the bus. Handles one or both targets (parameter memory via the
// device's load procedure, and/or the group address + association tables). With both, it
// previews each, then flashes only the targets that actually differ, sequentially, each with
// a server-side backup and a read-back verify. A single target behaves like a focused flash.
export function FlashDialog({ open, onOpenChange, projectId, device, targets, onFlashed }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  targets: FlashTarget[];
  onFlashed?: () => void;
}) {
  const { t } = useTranslation();
  const [parts, setParts] = useState<Record<string, Part>>({});
  // The direct full-download sub-flow, offered when a surgical flash is refused with
  // COM_OBJECT_TABLE_STALE_USE_DOWNLOAD: the change alters the com-object table, which only a full
  // download can author. Runs on the device's EXISTING address (no programming mode / IA assign,
  // unlike CommissionDialog), because the device is already commissioned. null until the CTA is taken.
  const [dl, setDl] = useState<Part | null>(null);
  const busyRef = useRef(false); // guards against a same-tick double click
  const deviceLabel = device.name || device.ia;
  const setPart = (target: FlashTarget, patch: Partial<Part>) =>
    setParts((p) => ({ ...p, [target]: { ...(p[target] ?? freshPart()), ...patch } }));

  // Dry-run each target on open (and on retry): each opens its own bus connection, so no
  // manual connect is needed. The bus is serial server-side, so we await them in order to
  // keep the connection clean and the preview readable.
  const check = useCallback(() => {
    const init: Record<string, Part> = {};
    for (const tg of targets) init[tg] = { ...freshPart(), checking: true };
    setParts(init);
    setDl(null); // a fresh preview leaves any earlier full-download offer behind
    // Deliberately not awaited: this runs the previews in the background while the dialog paints.
    // Nothing is lost by that, because every target's own failure is caught and shown ON the target
    // (setPart error) — the loop cannot reject.
    void (async () => {
      for (const tg of targets) {
        try { const r = await runDry(tg, projectId, device.id); setPart(tg, { dry: r, checking: false }); }
        catch (e) { setPart(tg, { error: e, checking: false }); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, device.id, targets.join(",")]);

  useEffect(() => { if (open) check(); }, [open, check]);

  const list = targets.map((tg) => ({ tg, p: parts[tg] ?? freshPart() }));
  const anyChecking = list.some((x) => x.p.checking);
  const anyFlashing = list.some((x) => x.p.flashing);
  const anyDone = list.some((x) => x.p.done);
  // Only targets that actually differ get written; an in-sync target is skipped.
  const toFlash = list.filter((x) => x.p.dry?.kind === "dryRun" && !x.p.done);
  const canFlash = !anyFlashing && !anyDone && toFlash.length > 0;
  // Connection-class failures are detected on the raw (English) message.
  const firstError = list.find((x) => x.p.error)?.p.error;
  const rawError = firstError instanceof Error ? firstError.message : "";
  const isConnError = !!firstError && /timeout|connect|tunnel|unreachable|ECONN|EHOST|network/i.test(rawError);
  // A surgical flash refused because the change rewrites the com-object table: the backend says a
  // full download is the way to apply it (only offered where the family can commission).
  const needsDownload = list.some((x) => x.p.error instanceof ApiError && x.p.error.code === "COM_OBJECT_TABLE_STALE_USE_DOWNLOAD");
  const dlBusy = !!dl && (dl.checking || dl.flashing);

  async function flash() {
    if (busyRef.current) return;
    busyRef.current = true;
    let flashedAny = false;
    try {
      for (const { tg } of toFlash) {
        setPart(tg, { flashing: true, error: null });
        try { const r = await runFlash(tg, projectId, device.id); setPart(tg, { done: r, flashing: false }); if (r.kind === "flashed") flashedAny = true; }
        catch (e) { setPart(tg, { error: e, flashing: false }); }
      }
    } finally {
      busyRef.current = false;
      if (flashedAny) onFlashed?.();
    }
  }

  // Full download on the existing address: preview (dry-run) first, so the user confirms the write.
  // busyRef-guarded like flash()/runDownload so a same-tick double click cannot fire two dry-runs.
  const startDownload = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setDl({ ...freshPart(), checking: true });
    api.downloadDevice(projectId, device.id, true)
      .then((dry) => setDl((d) => ({ ...(d ?? freshPart()), checking: false, dry })))
      .catch((e) => setDl((d) => ({ ...(d ?? freshPart()), checking: false, error: e })))
      .finally(() => { busyRef.current = false; });
  };
  const runDownload = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setDl((d) => ({ ...(d ?? freshPart()), flashing: true, error: null }));
    api.downloadDevice(projectId, device.id, false)
      .then((done) => { setDl((d) => ({ ...(d ?? freshPart()), flashing: false, done })); if (done.kind === "flashed" && done.verified) onFlashed?.(); })
      .catch((e) => setDl((d) => ({ ...(d ?? freshPart()), flashing: false, error: e })))
      .finally(() => { busyRef.current = false; });
  };

  const partName = (tg: FlashTarget) => t(tg === "ga" ? "flash.partGAs" : "flash.partParams");
  const partLine = (p: Part) => {
    if (p.flashing) return <span className="flex items-center gap-2 text-primary"><Loader2 className="size-4 animate-spin" /> {t("flash.programming")}</span>;
    if (p.done) {
      if (p.done.kind !== "flashed") return <span className="text-muted-foreground">{t("flash.inSync")}</span>; // raced to in-sync between preview and write
      return p.done.verified
        ? <span className="flex items-center gap-2 text-ok"><CheckCircle2 className="size-4 shrink-0" /> {t("flash.doneVerified", { bytes: p.done.diffBytes })}</span>
        : <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4 shrink-0" /> {t("flash.doneUnverified")}</span>;
    }
    if (p.error) return <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4 shrink-0" /> {errMsg(t, p.error)}</span>;
    if (p.checking) return <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("flash.checking")}</span>;
    if (p.dry) return p.dry.kind === "dryRun"
      ? <span>{t("flash.willChange", { diff: p.dry.diffBytes, total: p.dry.imageBytes, mask: p.dry.mask })}</span>
      : <span className="text-muted-foreground">{t("flash.inSync")}</span>;
    return <span className="text-muted-foreground">…</span>;
  };

  const downloadLine = () => {
    if (!dl) return null;
    if (dl.flashing) return <span className="flex items-center gap-2 text-primary"><Loader2 className="size-4 animate-spin" /> {t("flash.dlDownloading")}</span>;
    if (dl.done) {
      if (dl.done.kind !== "flashed") return <span className="text-muted-foreground">{t("flash.inSync")}</span>;
      return dl.done.verified
        ? <span className="flex items-center gap-2 text-ok"><CheckCircle2 className="size-4 shrink-0" /> {t("flash.dlDoneVerified", { bytes: dl.done.diffBytes })}</span>
        : <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4 shrink-0" /> {t("flash.dlDoneUnverified")}</span>;
    }
    if (dl.error) return <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4 shrink-0" /> {errMsg(t, dl.error)}</span>;
    if (dl.checking) return <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("flash.checking")}</span>;
    if (dl.dry) return dl.dry.kind === "dryRun"
      ? <span>{t("flash.dlWillWrite", { total: dl.dry.imageBytes, mask: dl.dry.mask })}</span>
      : <span className="text-muted-foreground">{t("flash.inSync")}</span>;
    return <span className="text-muted-foreground">…</span>;
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Cpu className="size-4 text-primary" /> {t("flash.titleDevice", { device: deviceLabel })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("flash.descDevice", { ia: device.ia })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* One consistent layout for any scope: a labelled row per target it covers, whether
            that is configuration, group addresses, or both. */}
        <div className="space-y-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
          {list.map(({ tg, p }) => (
            <div key={tg} className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">{partName(tg)}</span>
              {partLine(p)}
            </div>
          ))}
          {isConnError && <p className="text-xs text-muted-foreground">{t("flash.connHint")}</p>}
          {dl && (
            <div className="flex flex-col gap-0.5 border-t border-border pt-2">
              <span className="text-xs font-medium text-muted-foreground">{t("flash.partFullDownload")}</span>
              {downloadLine()}
            </div>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={anyFlashing || dlBusy}>{anyDone || dl?.done ? t("common.close") : t("common.cancel")}</AlertDialogCancel>
          {/* Generic target retry, only before the full-download offer is taken. */}
          {!!firstError && !anyFlashing && !anyChecking && !dl && (
            <Button variant="outline" onClick={check} data-testid="flash-retry">
              <RefreshCw className="size-4" /> {t("common.retry")}
            </Button>
          )}
          {/* The change rewrites the com-object table: offer the full download that can author it. */}
          {needsDownload && !dl && !anyFlashing && !anyChecking && (
            <Button onClick={startDownload} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="flash-needs-download">
              <Download className="size-4" /> {t("flash.needsDownloadCta")}
            </Button>
          )}
          {/* Re-run the download after a preview or write failure (a dry-run is read-only, so this is safe). */}
          {!!dl?.error && !dlBusy && !dl.done && (
            <Button variant="outline" onClick={startDownload} data-testid="flash-download-retry">
              <RefreshCw className="size-4" /> {t("common.retry")}
            </Button>
          )}
          {/* Confirm the previewed full download. */}
          {dl?.dry?.kind === "dryRun" && !dl.done && !dlBusy && (
            <Button onClick={runDownload} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="confirm-download">
              <Download className="size-4" /> {t("flash.download")}
            </Button>
          )}
          {/* onClick returns void, so flash()'s promise is discarded explicitly. Nothing is lost by
              that: flash() catches each target's failure and shows it ON that target, and never rejects. */}
          {canFlash && !dl && (
            <Button onClick={() => { void flash(); }} disabled={anyFlashing} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="confirm-flash">
              {anyFlashing ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />} {t("flash.flash")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
