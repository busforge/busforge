import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type Device } from "../api.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errMsg } from "../lib/apiError.ts";

// Deposit a tool key another tool gave the device. The server stores it only after the device
// answered a secure Sync under it; a refusal is shown as the server words it.
export function ToolKeyDialog({ open, onOpenChange, projectId, device, onStored }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  onStored?: () => void;
}) {
  const { t } = useTranslation();
  const [toolKey, setToolKey] = useState("");
  const [serial, setSerial] = useState("");
  const [running, setRunning] = useState(false);
  const [stored, setStored] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);

  const reset = () => { setToolKey(""); setSerial(""); setStored(null); setError(null); };

  const check = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRunning(true); setError(null); setStored(null);
    try {
      const r = await api.putToolKey(projectId, device.id, toolKey.trim(), serial.trim());
      setStored(r.serial);
      onStored?.();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
      busyRef.current = false;
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && running) return; if (!o) reset(); onOpenChange(o); }}>
      <AlertDialogContent dismissible={!running} backdropClose={false}>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" /> {t("toolKey.title", { device: device.name || device.ia })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("toolKey.description", { ia: device.ia })}</AlertDialogDescription>
        </AlertDialogHeader>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t("toolKey.key")}</span>
          <Input
            type="password" value={toolKey} onChange={(e) => setToolKey(e.target.value)} disabled={running || !!stored}
            placeholder="00112233445566778899AABBCCDDEEFF" className="font-mono" autoComplete="off" spellCheck={false}
            data-testid="tool-key-input"
          />
          <span className="text-xs text-muted-foreground">{t("toolKey.keyHint")}</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">{t("toolKey.serial")}</span>
          <Input
            value={serial} onChange={(e) => setSerial(e.target.value)} disabled={running || !!stored}
            placeholder="00FA01020304" className="font-mono" autoComplete="off" spellCheck={false}
            data-testid="tool-key-serial"
          />
          <span className="text-xs text-muted-foreground">{t("toolKey.serialHint")}</span>
        </label>

        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
          {running && <span className="flex items-start gap-2 text-primary"><Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />{t("toolKey.running")}</span>}
          {!running && stored && (
            <span className="flex items-start gap-2 text-ok" data-testid="tool-key-ok">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />{t("toolKey.stored", { serial: stored })}
            </span>
          )}
          {!running && !!error && (
            <span className="flex items-start gap-2 text-destructive" data-testid="tool-key-fail">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />{errMsg(t, error)}
            </span>
          )}
          {!running && !stored && !error && <span className="text-muted-foreground">{t("toolKey.idle")}</span>}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>{stored ? t("common.close") : t("common.cancel")}</AlertDialogCancel>
          {!stored && (
            <Button onClick={() => void check()} disabled={running || !toolKey.trim()} data-testid="tool-key-check">
              <KeyRound className="size-4" /> {t("toolKey.check")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
