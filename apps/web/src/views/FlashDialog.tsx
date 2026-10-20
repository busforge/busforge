import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Download, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError, taskActive, type Device, type DeviceConfigView, type FlashResult, type MatrixOperation, type Task } from "../api.ts";
import { UntestedNotice, useRefreshOnUntested } from "@/components/UntestedNotice.tsx";
import { ConfirmedOnlyNote, ReadsFFNote } from "@/components/ConfirmedOnlyNote.tsx";
import { RestartUnprovenNote } from "@/components/RestartUnprovenNote.tsx";
import { ConstantsDifferNote } from "@/components/ConstantsDifferNote.tsx";
import { untestedOps } from "../lib/untested.ts";
import { useTasks } from "../queries.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { errMsg } from "../lib/apiError.ts";
import { offersFullDownload, leftDeviceUnloaded, etsCompletesLoad, flashFooter } from "../lib/flashRecovery.ts";
import { previewRuns, previewEffect, previewEach, type IsLive } from "../lib/previewRun.ts";

export type FlashTarget = "params" | "ga";
const runDry = (t: FlashTarget, projectId: string, deviceId: string) =>
  (t === "ga" ? api.flashDeviceGa : api.flashDevice)(projectId, deviceId, true);
const runFlash = (t: FlashTarget, projectId: string, deviceId: string, onTask: (task: Task) => void) =>
  (t === "ga" ? api.flashDeviceGa : api.flashDevice)(projectId, deviceId, false, onTask);

// One preview/write status, reused for each flash target and for the full-download sub-flow
// (same states: checking a dry-run, previewed, writing, done, or errored).
interface Part { dry: FlashResult | null; done: FlashResult | null; error: unknown; checking: boolean; flashing: boolean; }
const freshPart = (): Part => ({ dry: null, done: null, error: null, checking: false, flashing: false });

// Program a device over the bus. Handles one or both targets (parameter memory via the
// device's load procedure, and/or the group address + association tables). With both, it
// previews each, then flashes only the targets that actually differ, sequentially, each with
// a server-side backup and a read-back verify. A single target behaves like a focused flash.
export function FlashDialog({ open, onOpenChange, projectId, device, targets, onFlashed, canFullDownload = false, view }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  targets: FlashTarget[];
  onFlashed?: () => void;
  // The family can be commissioned in full (capabilities().fullDownload), so the dialog offers it.
  canFullDownload?: boolean;
  // The device's configuration view: its compatibility, whether its Product was acknowledged as
  // untested, and whether its full download loads the application (else ETS restores an unloaded device).
  view?: Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged" | "fullDownloadLoadsApplication">;
}) {
  const { t } = useTranslation();
  const [parts, setParts] = useState<Record<string, Part>>({});
  // The direct full-download sub-flow, offered when a surgical flash is refused with
  // COM_OBJECT_TABLE_STALE_USE_DOWNLOAD: the change alters the com-object table, which only a full
  // download can author. Runs on the device's EXISTING address (no programming mode / IA assign,
  // unlike CommissionDialog), because the device is already commissioned. null until the CTA is taken.
  const [dl, setDl] = useState<Part | null>(null);
  const busyRef = useRef(false); // guards against a same-tick double click
  // The writes this dialog submitted, to tell them apart from a write someone else is running.
  const ownTasks = useRef(new Set<string>());
  const own = (task: Task) => { ownTasks.current.add(task.id); };
  const refreshOnUntested = useRefreshOnUntested(projectId, device.id);
  const deviceLabel = device.name || device.ia;
  const setPart = (target: FlashTarget, patch: Partial<Part>) =>
    setParts((p) => ({ ...p, [target]: { ...(p[target] ?? freshPart()), ...patch } }));

  // Dry-run each target on open (and on retry): each opens its own bus connection, so no
  // manual connect is needed. The bus is serial server-side, so we await them in order to
  // keep the connection clean and the preview readable. One preview at a time (see previewRun.ts).
  const [previews] = useState(previewRuns);
  const previewKey = `${projectId}|${device.id}|${targets.join(",")}`;
  const preview = useCallback((live: IsLive) => {
    const init: Record<string, Part> = {};
    for (const tg of targets) init[tg] = { ...freshPart(), checking: true };
    setParts(init);
    setDl(null); // a fresh preview leaves any earlier full-download offer behind
    return previewEach(targets, (tg) => runDry(tg, projectId, device.id),
      (tg, r) => setPart(tg, "ok" in r ? { dry: r.ok, checking: false } : { error: r.error, checking: false }), live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  const check = () => previews.start(previewKey, preview);

  const list = targets.map((tg) => ({ tg, p: parts[tg] ?? freshPart() }));
  const anyChecking = list.some((x) => x.p.checking);
  const anyFlashing = list.some((x) => x.p.flashing);
  const dlBusy = !!dl && (dl.checking || dl.flashing);
  const errorCodes = list.map((x) => (x.p.error instanceof ApiError ? x.p.error.code : undefined));
  // Where the full download loads the application (else ETS restores an unloaded device).
  const fullDownloadLoads = canFullDownload && !!view?.fullDownloadLoadsApplication;

  // A write to this device that this dialog did not start (a reload lost track of it, or another
  // client runs it). The server refuses a second write meanwhile; the preview waits until it has
  // finished, because only then does it describe the device as it will be.
  const { data: tasks } = useTasks(projectId);
  const foreignWrite = open && !anyFlashing && !dlBusy
    ? tasks?.find((x) => x.deviceId === device.id && x.writes && taskActive(x) && !ownTasks.current.has(x.id))
    : undefined;
  const tasksLoaded = tasks !== undefined;
  const blocked = !!foreignWrite;
  // A result already on screen stays there: a later foreign write must not replace it with a preview.
  // So does a write that left the device unloaded, whose only way on is the full download.
  const hasResult = useRef(false);
  hasResult.current = list.some((x) => x.p.done) || !!dl?.done || (fullDownloadLoads && errorCodes.some(leftDeviceUnloaded));
  useEffect(() => previewEffect(previews, open && tasksLoaded && !blocked && !hasResult.current, previewKey, preview),
    [previews, open, previewKey, preview, tasksLoaded, blocked]);
  // A retry the effect did not start has no cleanup of its own: closing the dialog stops it here.
  useEffect(() => () => previews.pause(), [previews]);

  const anyDone = list.some((x) => x.p.done);
  // A change that alters the com-object table previews as one structural write on every target it
  // touches (parameters, com-object table and group tables in one bracket). It is written once, from
  // the first target that previewed it; the others show that it covers them.
  const structuralTarget = list.find((x) => x.p.dry?.kind === "dryRun" && x.p.dry.structural)?.tg;
  const coveredByStructure = (tg: FlashTarget) => !!structuralTarget && tg !== structuralTarget && !!parts[tg]?.dry?.structural;
  // Only targets that actually differ get written; an in-sync target is skipped.
  const toFlash = list.filter((x) => x.p.dry?.kind === "dryRun" && !x.p.done && !coveredByStructure(x.tg));
  // Connection-class failures are detected on the raw (English) message.
  const firstError = list.find((x) => x.p.error)?.p.error;
  const rawError = firstError instanceof Error ? firstError.message : "";
  const isConnError = !!firstError && /timeout|connect|tunnel|unreachable|ECONN|EHOST|network/i.test(rawError);
  // A surgical flash refused because the change rewrites the com-object table, or because the device
  // never had an application loaded: a full download is the way (the backend refuses it where the
  // family cannot commission). So is a device left unloaded (a write broke off inside its load
  // bracket, a preview found a load-state machine not LOADED, or a GA flash stopped the application),
  // where the full download loads the application; otherwise ETS is named.
  const needsDownload = list.some((x) => x.p.error instanceof ApiError && offersFullDownload(x.p.error.code, fullDownloadLoads));
  const needsEts = list.some((x) => x.p.error instanceof ApiError && etsCompletesLoad(x.p.error.code, fullDownloadLoads));
  // The operations the writes on offer run: each previewed target (or the structural flash covering
  // them) and, once taken, the full download. An untested one needs the acknowledgement first.
  const writeOps: MatrixOperation[] = dl
    ? ["fullDownload"]
    : toFlash.map((x) => (x.p.dry?.structural ? "structuralFlash" : x.tg === "ga" ? "flashLinks" : "flashParams"));
  const awaitingAck = untestedOps(view, writeOps).length > 0;
  const canFlash = !anyFlashing && !anyDone && toFlash.length > 0;
  const footer = flashFooter({ canFlash, downloadTaken: !!dl, anyFlashing, anyChecking, awaitingAck, blocked, errorCodes, anyError: !!firstError, fullDownloadLoads });

  async function flash() {
    if (busyRef.current) return;
    busyRef.current = true;
    let flashedAny = false;
    let leftUnloaded = false;
    const write = async (tg: FlashTarget) => {
      setPart(tg, { flashing: true, error: null });
      try { const r = await runFlash(tg, projectId, device.id, own); setPart(tg, { done: r, flashing: false }); if (r.kind === "flashed") flashedAny = true; return r; }
      catch (e) {
        setPart(tg, { error: e, flashing: false });
        refreshOnUntested(e);
        if (e instanceof ApiError && leftDeviceUnloaded(e.code)) leftUnloaded = true;
        return null;
      }
    };
    const covered = list.filter((x) => coveredByStructure(x.tg)).map((x) => x.tg);
    try {
      for (const { tg } of toFlash) {
        const r = await write(tg);
        // A device left unloaded takes nothing more but the full download.
        if (leftUnloaded) break;
        // The server decides again when the write runs: if it did not write the structural change after
        // all, the targets the preview counted as covered are written on their own.
        if (tg === structuralTarget && r && !r.structural) for (const c of covered) { await write(c); if (leftUnloaded) break; }
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
    api.downloadDevice(projectId, device.id, false, own)
      .then((done) => { setDl((d) => ({ ...(d ?? freshPart()), flashing: false, done })); if (done.kind === "flashed" && done.verified) onFlashed?.(); })
      .catch((e) => { refreshOnUntested(e); setDl((d) => ({ ...(d ?? freshPart()), flashing: false, error: e })); })
      .finally(() => { busyRef.current = false; });
  };

  const partName = (tg: FlashTarget) => t(tg === "ga" ? "flash.partGAs" : "flash.partParams");
  const partLine = (tg: FlashTarget, p: Part) => {
    const lead = structuralTarget ? parts[structuralTarget] : undefined;
    if (coveredByStructure(tg) && !p.error && !p.done && !p.flashing && !lead?.error) {
      return <span className="text-muted-foreground" data-testid="flash-part-covered">{t("flash.structuralCovered", { part: partName(structuralTarget!) })}</span>;
    }
    if (p.flashing) return <span className="flex items-center gap-2 text-primary"><Loader2 className="size-4 animate-spin" /> {t("flash.programming")}</span>;
    if (p.done) {
      if (p.done.kind !== "flashed") return <span className="text-muted-foreground">{t("flash.inSync")}<ConstantsDifferNote result={p.done} /></span>; // raced to in-sync between preview and write
      return p.done.verified
        ? <span className="flex items-center gap-2 text-ok" data-testid="flash-part-ok"><CheckCircle2 className="size-4 shrink-0" /> {t("flash.doneVerified", { bytes: p.done.diffBytes })}<ConfirmedOnlyNote result={p.done} /><RestartUnprovenNote result={p.done} /></span>
        : <span className="flex items-center gap-2 text-destructive" data-testid="flash-part-fail"><AlertTriangle className="size-4 shrink-0" /> {t("flash.doneUnverified")}</span>;
    }
    if (p.error) return <span className="flex items-center gap-2 text-destructive" data-testid="flash-part-fail"><AlertTriangle className="size-4 shrink-0" /> {errMsg(t, p.error)}</span>;
    if (p.checking) return <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("flash.checking")}</span>;
    if (p.dry) return p.dry.kind === "dryRun"
      ? <span data-testid={p.dry.structural ? "flash-part-structural" : undefined}>{t(p.dry.structural ? "flash.willChangeStructure" : "flash.willChange", { diff: p.dry.diffBytes, total: p.dry.imageBytes, mask: p.dry.mask })}<ReadsFFNote result={p.dry} /></span>
      : <span className="text-muted-foreground" data-testid="flash-part-insync">{t("flash.inSync")}<ConstantsDifferNote result={p.dry} /></span>;
    return <span className="text-muted-foreground">…</span>;
  };

  const downloadLine = () => {
    if (!dl) return null;
    if (dl.flashing) return <span className="flex items-center gap-2 text-primary"><Loader2 className="size-4 animate-spin" /> {t("flash.dlDownloading")}</span>;
    if (dl.done) {
      if (dl.done.kind !== "flashed") return <span className="text-muted-foreground">{t("flash.inSync")}</span>;
      return dl.done.verified
        ? <span className="flex items-center gap-2 text-ok" data-testid="flash-dl-ok"><CheckCircle2 className="size-4 shrink-0" /> {t("flash.dlDoneVerified", { bytes: dl.done.diffBytes })}<ConfirmedOnlyNote result={dl.done} /><RestartUnprovenNote result={dl.done} /></span>
        : <span className="flex items-center gap-2 text-destructive" data-testid="flash-dl-fail"><AlertTriangle className="size-4 shrink-0" /> {t("flash.dlDoneUnverified")}</span>;
    }
    if (dl.error) return <span className="flex items-center gap-2 text-destructive" data-testid="flash-dl-fail"><AlertTriangle className="size-4 shrink-0" /> {errMsg(t, dl.error)}</span>;
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
          {foreignWrite && (
            <p className="flex items-center gap-2 text-primary" data-testid="flash-foreign-write">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              {t("flash.foreignWrite", { kind: t(`task.kind.${foreignWrite.kind}`), phase: foreignWrite.phase ? t(`task.phase.${foreignWrite.phase}`) : t("task.queued") })}
            </p>
          )}
          {list.map(({ tg, p }) => (
            <div key={tg} className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">{partName(tg)}</span>
              {partLine(tg, p)}
            </div>
          ))}
          {/* Flags edited on the device page go with every write of the com-object table (the group-address
              flash, as ETS's group-address download writes them, the structural flash, the full download);
              a parameter flash alone leaves them for later. */}
          {!!device.changes?.flags && (
            <p className="text-xs text-muted-foreground" data-testid="flash-flags-note">{t("flash.flagsPending", { count: device.changes.flags })}</p>
          )}
          {/* The hint ends in "retry", which a device left unloaded is not offered. */}
          {isConnError && !footer.unloaded && <p className="text-xs text-muted-foreground">{t("flash.connHint")}</p>}
          {needsEts && <p className="text-xs text-muted-foreground" data-testid="flash-needs-ets">{t("flash.etsCompletesLoad")}</p>}
          {dl && (
            <div className="flex flex-col gap-0.5 border-t border-border pt-2">
              <span className="text-xs font-medium text-muted-foreground">{t("flash.partFullDownload")}</span>
              {downloadLine()}
            </div>
          )}
        </div>
        {((canFlash && !footer.unloaded) || (dl?.dry?.kind === "dryRun" && !dl.done)) && !anyFlashing && !dlBusy && (
          <UntestedNotice projectId={projectId} deviceId={device.id} view={view} ops={writeOps} />
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={anyFlashing || dlBusy}>{anyDone || dl?.done ? t("common.close") : t("common.cancel")}</AlertDialogCancel>
          {/* Generic target retry, only before the full-download offer is taken, not while a foreign write
              runs (the preview follows once it has finished), and not after a write left the device unloaded. */}
          {footer.retry && (
            <Button variant="outline" onClick={check} data-testid="flash-retry">
              <RefreshCw className="size-4" /> {t("common.retry")}
            </Button>
          )}
          {/* The change needs the full download (the family cannot write it otherwise, or the device was
              never programmed): offer it as the way forward. */}
          {needsDownload && !dl && !anyFlashing && !anyChecking && (
            <Button onClick={startDownload} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="flash-needs-download">
              <Download className="size-4" /> {t("flash.needsDownloadCta")}
            </Button>
          )}
          {/* A full download is always the user's choice where the family can commission, as ETS offers
              it next to the partial download. */}
          {!needsDownload && canFullDownload && !blocked && list.every((x) => x.p.dry || x.p.error) && !dl && !anyDone && !anyFlashing && !anyChecking && (
            <Button variant="outline" onClick={startDownload} data-testid="flash-full-download">
              <Download className="size-4" /> {t("flash.fullDownloadCta")}
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
            <Button onClick={runDownload} disabled={awaitingAck} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="confirm-download">
              <Download className="size-4" /> {t("flash.download")}
            </Button>
          )}
          {/* onClick returns void, so flash()'s promise is discarded explicitly. Nothing is lost by
              that: flash() catches each target's failure and shows it ON that target, and never rejects. */}
          {footer.flash !== "none" && (
            <Button onClick={() => { void flash(); }} disabled={footer.flash === "disabled"} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="confirm-flash">
              {anyFlashing ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />} {t("flash.flash")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
