import { useState } from "react";
import { Bookmark, Clock, History, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { SnapshotMeta } from "../api.ts";
import { useSnapshots, useSnapshotActions } from "../queries.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { errMsg } from "../lib/apiError.ts";

// Restore points: a header popover that lists the project's snapshots and lets
// the user create a named one. Restoring rewrites the whole config layer, so it
// is confirmed in a dialog. Lives next to the bus indicator in the project header.
export function SnapshotPanel({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const { data: snapshots = [] } = useSnapshots(projectId);
  const { create, restore, remove } = useSnapshotActions(projectId);
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<SnapshotMeta | null>(null);

  const fmtTime = (ms: number) => new Date(ms).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  const rowLabel = (s: SnapshotMeta) =>
    s.label || (s.kind === "auto" ? t(`snapshot.reason.${s.reason}`) : t("snapshot.untitled"));

  function save() {
    const value = label.trim();
    create.mutate(value, {
      onSuccess: (snap) => { setLabel(""); toast.success(snap ? t("snapshot.saved") : t("snapshot.skipped")); },
      onError: (e) => toast.error(t("snapshot.createError"), { description: errMsg(t, e) }),
    });
  }

  function doRestore(s: SnapshotMeta) {
    restore.mutate(s.id, {
      onSuccess: (data) => {
        setConfirm(null);
        // An older restore point captured no group-address structure, so it was left as-is.
        // Say so instead of implying a full rollback.
        if (data.gaStructureRestored === false) toast.warning(t("snapshot.restored"), { description: t("snapshot.restoredNoGaStructure") });
        else toast.success(t("snapshot.restored"));
      },
      onError: (e) => toast.error(t("snapshot.restoreError"), { description: errMsg(t, e) }),
    });
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            aria-label={t("snapshot.title")}
            data-testid="snapshot-trigger"
          >
            <History className="size-3.5 shrink-0" />
            {snapshots.length > 0 && <span className="tabular-nums">{snapshots.length}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 p-3">
          <div className="mb-2 px-1 text-xs font-semibold text-muted-foreground">{t("snapshot.title")}</div>

          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              placeholder={t("snapshot.titlePlaceholder")}
              className="h-8 text-sm"
              data-testid="snapshot-title"
            />
            <Button size="sm" onClick={save} disabled={create.isPending} data-testid="snapshot-create" className="shrink-0">
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Bookmark className="size-4" />} {t("snapshot.save")}
            </Button>
          </div>

          <div className="mt-3 max-h-80 space-y-1 overflow-y-auto">
            {snapshots.length === 0 ? (
              <div className="px-1 py-2 text-xs text-muted-foreground" data-testid="snapshot-empty">{t("snapshot.empty")}</div>
            ) : (
              snapshots.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-secondary/50" data-testid={`snapshot-${s.id}`}>
                  {s.kind === "auto"
                    ? <Clock className="size-3.5 shrink-0 text-muted-foreground" />
                    : <Bookmark className="size-3.5 shrink-0 text-primary" />}
                  <div className="min-w-0 flex-1">
                    <div className={cn("truncate text-sm", s.kind === "auto" && "text-muted-foreground")}>{rowLabel(s)}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{fmtTime(s.createdAt)}</div>
                  </div>
                  <button
                    onClick={() => setConfirm(s)} aria-label={t("snapshot.restore")} title={t("snapshot.restore")}
                    className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-primary"
                    data-testid={`snapshot-restore-${s.id}`}
                  >
                    <RotateCcw className="size-4" />
                  </button>
                  <button
                    onClick={() => remove.mutate(s.id, { onError: (e) => toast.error(t("snapshot.deleteError"), { description: errMsg(t, e) }) })}
                    aria-label={t("snapshot.delete")} title={t("snapshot.delete")}
                    className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-destructive"
                    data-testid={`snapshot-delete-${s.id}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("snapshot.restoreTitle", { label: confirm ? rowLabel(confirm) : "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("snapshot.restoreBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); if (confirm) doRestore(confirm); }}
              disabled={restore.isPending} data-testid="snapshot-restore-confirm"
            >
              {restore.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} {t("snapshot.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
