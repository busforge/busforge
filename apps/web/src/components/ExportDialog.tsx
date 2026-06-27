import { useState } from "react";
import { Download, KeyRound, Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../api.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { errMsg } from "../lib/apiError.ts";

// Download the project as a portable .busforge artifact, optionally AES-256-GCM
// encrypted with a password the user sets here. Without a password the file is a
// plain gzip stream anyone can open with `gunzip`.
// Without open/onOpenChange it renders its own trigger button (the in-project
// header use). With them it is controlled and the trigger is omitted, so a menu
// item elsewhere (e.g. the dashboard card menu) can open it.
export function ExportDialog({ projectId, open: openProp, onOpenChange }: { projectId: string; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const { t } = useTranslation();
  const controlled = openProp !== undefined;
  const [openState, setOpenState] = useState(false);
  const open = controlled ? openProp : openState;
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() { setPassword(""); setError(null); }
  const setOpen = (o: boolean) => { if (!o) reset(); controlled ? onOpenChange?.(o) : setOpenState(o); };

  const exportMut = useMutation({
    mutationFn: () => api.exportProject(projectId, password.trim() || undefined),
    onSuccess: () => { toast.success(t("export.done")); setOpen(false); },
    onError: (e) => { const msg = errMsg(t, e); setError(msg); toast.error(t("export.failed"), { description: msg }); },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={t("nav.exportProject")}
            title={t("nav.exportProject")}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            data-testid="export-project"
          >
            <Download className="size-3.5 shrink-0" />
          </button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Download className="size-4 text-primary" /> {t("export.title")}</DialogTitle>
          <DialogDescription>{t("export.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> {t("export.passwordLabel")}</Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            placeholder={t("export.passwordPlaceholder")}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") exportMut.mutate(); }}
            data-testid="export-password"
          />
          <p className="text-xs text-muted-foreground">{t("export.passwordHint")}</p>
        </div>

        {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
          <Button onClick={() => exportMut.mutate()} disabled={exportMut.isPending} data-testid="export-submit">
            {exportMut.isPending ? <><Loader2 className="size-4 animate-spin" /> {t("export.exporting")}</> : t("export.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
