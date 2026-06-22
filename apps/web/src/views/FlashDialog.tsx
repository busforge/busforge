import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type Device, type FlashResult } from "../api.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

// Program a device's parameter segment. Previews the change with a dry-run
// before writing, then flashes and reports the verified result. Only the
// parameter segment (LSM4) is written; a backup is taken server-side.
export function FlashDialog({ open, onOpenChange, projectId, device, target, onFlashed }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  target: "params" | "ga";
  onFlashed?: () => void;
}) {
  const { t } = useTranslation();
  const [dry, setDry] = useState<FlashResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [done, setDone] = useState<FlashResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false); // guards against a same-tick double click

  const run = (dryRun: boolean) => (target === "ga" ? api.flashDeviceGa : api.flashDevice)(projectId, device.id, dryRun);
  const deviceLabel = device.name || device.ia;

  // Dry-run on open (and on retry): opens its own bus connection, so no manual
  // connect is needed first. A connection-class failure is recoverable, hence the
  // Retry button below.
  const check = useCallback(() => {
    setDry(null); setDone(null); setError(null); setChecking(true);
    run(true)
      .then(setDry)
      .catch((e) => setError((e as Error).message))
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, device.id, target]);

  useEffect(() => { if (open) check(); }, [open, check]);

  const isConnError = !!error && /timeout|connect|tunnel|unreachable|ECONN|EHOST|network/i.test(error);

  async function flash() {
    if (busyRef.current) return;
    busyRef.current = true;
    setFlashing(true); setError(null);
    try { const r = await run(false); setDone(r); if (r.flashed) onFlashed?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setFlashing(false); busyRef.current = false; }
  }

  const canFlash = dry?.changed && !done && !flashing;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2"><Cpu className="size-4 text-primary" /> {t(target === "ga" ? "flash.titleGAs" : "flash.titleParams", { device: deviceLabel })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(target === "ga" ? "flash.descGAs" : "flash.descParams", { ia: device.ia })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
          {checking && <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("flash.checking")}</span>}
          {error && (
            <div className="space-y-1">
              <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4 shrink-0" /> {error}</span>
              {isConnError && (
                <p className="pl-6 text-xs text-muted-foreground">
                  {t("flash.connHint")}
                </p>
              )}
            </div>
          )}
          {dry && !done && !error && (
            dry.changed
              ? <span>{t("flash.willChange", { diff: dry.diffBytes, total: dry.imageBytes, mask: dry.mask })}</span>
              : <span className="text-muted-foreground">{t("flash.inSync")}</span>
          )}
          {flashing && <span className="flex items-center gap-2 text-primary"><Loader2 className="size-4 animate-spin" /> {t("flash.programming")}</span>}
          {done && (
            done.verified
              ? <span className="flex items-center gap-2 text-ok"><CheckCircle2 className="size-4" /> {t("flash.doneVerified", { bytes: done.diffBytes })}</span>
              : <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4" /> {t("flash.doneUnverified")}</span>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={flashing}>{done ? t("common.close") : t("common.cancel")}</AlertDialogCancel>
          {error && !flashing && (
            <Button variant="outline" onClick={check} data-testid="flash-retry">
              <RefreshCw className="size-4" /> {t("common.retry")}
            </Button>
          )}
          {canFlash && (
            <Button onClick={flash} disabled={flashing} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="confirm-flash">
              {flashing ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />} {t("flash.flash")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
