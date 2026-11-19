import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, LocateFixed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type Device, type LocateResult } from "../api.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { errMsg } from "../lib/apiError.ts";

// How long the programming LED stays on unless switched off first.
const SECONDS = 30;

const ENDED = { time: "locate.endedTime", cancel: "locate.endedCancel", device: "locate.endedDevice" } as const;

// Find a device physically: switch its programming LED on over the bus for a while, then off. The
// server reads the mode back after switching it off; a run that cannot show it off is an error that
// tells the user to press the button.
export function LocateDialog({ open, onOpenChange, projectId, device }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
}) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [result, setResult] = useState<LocateResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const taskId = useRef<string | null>(null);
  const busyRef = useRef(false);

  const reset = () => { setResult(null); setError(null); setStopping(false); };

  const start = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    taskId.current = null;
    setRunning(true); setStopping(false); setError(null); setResult(null);
    try {
      setResult(await api.locateDevice(projectId, device.id, SECONDS, (task) => { taskId.current = task.id; }));
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
      busyRef.current = false;
    }
  };

  // The task ends the hold and switches the mode off; the result arrives through start().
  const stop = async () => {
    if (!taskId.current) return;
    setStopping(true);
    try { await api.cancelTask(projectId, taskId.current); }
    catch (e) { setStopping(false); setError(e); }
  };

  return (
    // Not closable while it runs: the result is what says the mode is off again.
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && running) return; if (!o) reset(); onOpenChange(o); }}>
      <AlertDialogContent dismissible={!running} backdropClose={false}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <LocateFixed className="size-4 text-primary" /> {t("locate.title", { device: device.name || device.ia })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("locate.description", { ia: device.ia, seconds: SECONDS })}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm" data-testid="locate-state">
          {running && (
            <span className="flex items-start gap-2 text-primary">
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />{t(stopping ? "locate.stopping" : "locate.running")}
            </span>
          )}
          {!running && result && (
            <span className="flex items-start gap-2 text-ok" data-testid="locate-ok">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />{t(ENDED[result.endedBy])}
            </span>
          )}
          {!running && !!error && (
            <span className="flex items-start gap-2 text-destructive" data-testid="locate-fail">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />{errMsg(t, error)}
            </span>
          )}
          {!running && !result && !error && <span className="text-muted-foreground">{t("locate.writes")}</span>}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>{t("common.close")}</AlertDialogCancel>
          {running ? (
            <Button variant="outline" onClick={() => void stop()} disabled={stopping} data-testid="locate-stop">
              {t("locate.stop")}
            </Button>
          ) : (
            <Button onClick={() => void start()} data-testid="locate-start">
              <LocateFixed className="size-4" /> {t("locate.start")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
