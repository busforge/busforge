import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, MapPin, RadioTower } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type Device } from "../api.ts";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errMsg } from "../lib/apiError.ts";

// Change the individual address a device should hold in the project. Nothing reaches the bus: the
// device keeps answering at its old address until the new one is assigned to it (commissioning), so
// once saved the dialog says so and offers that step.
export function AddressDialog({ open, onOpenChange, projectId, device, onSaved, onAssign }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  onSaved?: () => Promise<unknown>;
  onAssign?: () => void;
}) {
  const { t } = useTranslation();
  const [ia, setIa] = useState(device.ia);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const busyRef = useRef(false);

  // Each opening starts from the device's current address; the page can change devices under it.
  useEffect(() => { if (open) { setIa(device.ia); setSaved(null); setError(null); } }, [open, device.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true); setError(null);
    try {
      const from = device.ia;
      const r = await api.setDeviceAddress(projectId, device.id, ia.trim());
      // Wait for the refetch, so the commission step offered next shows the new address.
      await onSaved?.();
      setSaved({ from, to: r.ia });
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
      busyRef.current = false;
    }
  };

  const unchanged = ia.trim() === device.ia;

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && saving) return; onOpenChange(o); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <MapPin className="size-4 text-primary" /> {t("address.title", { device: device.name || device.ia })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("address.description")}</AlertDialogDescription>
        </AlertDialogHeader>

        {!saved && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">{t("address.label")}</span>
            <Input
              value={ia} onChange={(e) => { setIa(e.target.value); setError(null); }} disabled={saving}
              onKeyDown={(e) => { if (e.key === "Enter" && !unchanged) void save(); }}
              placeholder="1.2.32" className="font-mono" autoComplete="off" spellCheck={false} data-testid="device-address"
            />
          </label>
        )}

        {saved && (
          <div role="status" className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm" data-testid="device-address-saved">
            {t("address.saved", { from: saved.from, to: saved.to })}
          </div>
        )}
        {!saving && !!error && (
          <div role="alert" className="flex items-start gap-2 text-sm text-destructive" data-testid="device-address-fail">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />{errMsg(t, error)}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>{saved ? t("common.close") : t("common.cancel")}</AlertDialogCancel>
          {!saved && (
            <Button onClick={() => void save()} disabled={saving || unchanged || !ia.trim()} data-testid="device-address-save">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <MapPin className="size-4" />} {t("address.save")}
            </Button>
          )}
          {saved && onAssign && (
            <Button autoFocus onClick={() => { onOpenChange(false); onAssign(); }} data-testid="device-address-assign">
              <RadioTower className="size-4" /> {t("address.assign")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
