import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type Device } from "../api.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errMsg } from "../lib/apiError.ts";

type Outcome = "activated" | "already-active";

// Switch KNX Data Secure on for a device in factory state: store the certificate printed on it,
// then activate it (security mode on, tool key written). The tool key is stored before it is
// written, so an interruption never loses the only key the device holds. Each step reports what the
// device confirmed; a failure is shown as it is.
export function SecureActivateDialog({ open, onOpenChange, projectId, device, onActivated }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  onActivated?: () => void;
}) {
  const { t } = useTranslation();
  const [certificate, setCertificate] = useState("");
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);

  const reset = () => { setCertificate(""); setOutcome(null); setError(null); };

  const activate = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRunning(true); setError(null); setOutcome(null);
    try {
      // An empty field activates with the certificate already on file (CERTIFICATE_MISSING otherwise).
      if (certificate.trim()) await api.putDeviceCertificate(projectId, device.id, certificate.trim());
      const r = await api.secureActivate(projectId, device.id);
      setOutcome(r.outcome);
      onActivated?.();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
      busyRef.current = false;
    }
  };

  return (
    // Escape must not close the dialog over a running activation: the result is the only place
    // that says which key the device holds now.
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && running) return; if (!o) reset(); onOpenChange(o); }}>
      <AlertDialogContent dismissible={!running} backdropClose={false}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" /> {t("secureActivate.title", { device: device.name || device.ia })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("secureActivate.description", { ia: device.ia })}</AlertDialogDescription>
        </AlertDialogHeader>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t("secureActivate.certificate")}</span>
          <Input
            value={certificate} onChange={(e) => setCertificate(e.target.value)} disabled={running || !!outcome}
            placeholder="AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA" className="font-mono" autoComplete="off" spellCheck={false}
            data-testid="secure-certificate"
          />
          <span className="text-xs text-muted-foreground">{t("secureActivate.certificateHint")}</span>
        </label>

        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
          {running && <span className="flex items-start gap-2 text-primary"><Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />{t("secureActivate.running")}</span>}
          {!running && outcome && (
            <span className="flex items-start gap-2 text-ok" data-testid="secure-activate-ok">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />{t(outcome === "activated" ? "secureActivate.activated" : "secureActivate.alreadyActive")}
            </span>
          )}
          {!running && !!error && (
            <span className="flex items-start gap-2 text-destructive" data-testid="secure-activate-fail">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />{errMsg(t, error)}
            </span>
          )}
          {!running && !outcome && !error && <span className="text-muted-foreground">{t("secureActivate.writes")}</span>}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>{outcome ? t("common.close") : t("common.cancel")}</AlertDialogCancel>
          {!outcome && (
            <Button onClick={() => void activate()} disabled={running} data-testid="secure-activate">
              <ShieldCheck className="size-4" /> {t("secureActivate.activate")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
