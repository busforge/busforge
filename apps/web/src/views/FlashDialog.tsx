import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Loader2 } from "lucide-react";
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
  const [dry, setDry] = useState<FlashResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [done, setDone] = useState<FlashResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false); // guards against a same-tick double click

  const run = (dryRun: boolean) => (target === "ga" ? api.flashDeviceGa : api.flashDevice)(projectId, device.id, dryRun);
  const what = target === "ga" ? "group addresses" : "parameters";
  const segment = target === "ga" ? "address and association tables" : "parameter segment (LSM4)";

  useEffect(() => {
    if (!open) return;
    setDry(null); setDone(null); setError(null); setChecking(true);
    run(true)
      .then(setDry)
      .catch((e) => setError((e as Error).message))
      .finally(() => setChecking(false));
  }, [open, projectId, device.id, target]);

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
          <AlertDialogTitle className="flex items-center gap-2"><Cpu className="size-4 text-primary" /> Program {what} on {device.name || device.ia}</AlertDialogTitle>
          <AlertDialogDescription>
            Writes the {segment} to <span className="font-mono">{device.ia}</span> over the bus.
            {target === "ga" ? " The com-object flags are read from the device and kept unchanged." : " The addressing and group tables are not touched."}
            {" "}A backup is taken first and the result is read back and verified.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
          {checking && <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking for changes…</span>}
          {error && <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4" /> {error}</span>}
          {dry && !done && !error && (
            dry.changed
              ? <span><span className="font-mono">{dry.diffBytes}</span> of <span className="font-mono">{dry.imageBytes}</span> bytes will change (device mask <span className="font-mono">{dry.mask}</span>).</span>
              : <span className="text-muted-foreground">Device is already in sync, nothing to program.</span>
          )}
          {flashing && <span className="flex items-center gap-2 text-primary"><Loader2 className="size-4 animate-spin" /> Programming… the device restarts, this takes a few seconds.</span>}
          {done && (
            done.verified
              ? <span className="flex items-center gap-2 text-ok"><CheckCircle2 className="size-4" /> Programmed and verified ({done.diffBytes} bytes written).</span>
              : <span className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4" /> Flashed but read-back did not verify. Check the device.</span>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={flashing}>{done ? "Close" : "Cancel"}</AlertDialogCancel>
          {canFlash && (
            <Button onClick={flash} disabled={flashing} className="bg-primary text-primary-foreground hover:bg-primary/90" data-testid="confirm-flash">
              {flashing ? <Loader2 className="size-4 animate-spin" /> : <Cpu className="size-4" />} Flash
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
