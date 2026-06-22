import { useRef, useState } from "react";
import { Flame, FolderUp, KeyRound, Loader2, Trash2, Cpu, Network } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, type ProjectSummary } from "../api.ts";
import { qk, useProjects } from "../queries.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { LanguageSwitcher } from "@/components/LanguageSwitcher.tsx";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

const fmtDate = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ProjectsScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: projects = [], isLoading } = useProjects();
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);

  const open = (id: string) => navigate({ to: "/projects/$projectId/devices", params: { projectId: id } });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: qk.projects });
      toast.message(t("projects.deleted", { name: projects.find((p) => p.id === id)?.name ?? "project" }));
    },
    onError: (e) => toast.error(t("projects.deleteFailed"), { description: (e as Error).message }),
  });

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-4 py-8 sm:px-6">
      <header className="mb-8 flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-md bg-primary text-primary-foreground shadow-[0_0_24px_-4px] shadow-primary/50">
          <Flame className="size-6" strokeWidth={2.5} />
        </div>
        <div className="leading-none">
          <div className="text-xl font-extrabold tracking-[0.2em]">BUSFORGE</div>
          <div className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t("common.tagline")}</div>
        </div>
        <LanguageSwitcher className="ml-auto" />
      </header>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{t("projects.heading")}</h2>
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("common.loading")}</div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
            {t("projects.empty")}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <Card key={p.id} className="group cursor-pointer transition-colors hover:border-primary/60" onClick={() => open(p.id)}>
                <CardContent className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-lg font-bold">{p.name}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant="secondary" className="gap-1 font-mono"><Cpu className="size-3" />{p.deviceCount}</Badge>
                      <Badge variant="secondary" className="gap-1 font-mono"><Network className="size-3" />{p.gaCount}</Badge>
                    </div>
                    <div className="mt-2 font-mono text-[11px] text-muted-foreground">{fmtDate(p.importedAt)}</div>
                  </div>
                  <Button
                    variant="ghost" size="icon"
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); setPendingDelete(p); }}
                    aria-label={t("projects.deleteAria")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className="mt-8">
        <ImportCard onImported={(id) => { qc.invalidateQueries({ queryKey: qk.projects }); open(id); }} />
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.deleteTitle", { name: pendingDelete?.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.deleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { const target = pendingDelete; setPendingDelete(null); if (target) del.mutate(target.id); }}
              className="bg-destructive text-white hover:bg-destructive/90" data-testid="confirm-delete"
            >
              {t("projects.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ImportCard({ onImported }: { onImported: (id: string) => void }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function pick(f: File | null) { setFile(f); setError(null); }

  const importMut = useMutation({
    mutationFn: () => api.importProject(file!, password),
    onSuccess: (res) => {
      toast.success(t("import.imported", { name: res.name }), { description: t("import.importedDesc", { devices: res.deviceCount, gas: res.gaCount }) });
      setFile(null); setPassword("");
      onImported(res.id);
    },
    onError: (e) => { const msg = (e as Error).message; setError(msg); toast.error(t("import.failed"), { description: msg }); },
  });

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><FolderUp className="size-4 text-primary" /> {t("import.title")}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label>{t("import.fileLabel")}</Label>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files?.[0] ?? null); }}
              className={cn(
                "flex h-20 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-sm transition-colors",
                drag ? "border-primary bg-primary/5" : "border-border bg-secondary/30 hover:border-primary/60 hover:bg-secondary/50",
              )}
            >
              {file
                ? <span className="font-mono text-foreground">{file.name}</span>
                : <span className="text-muted-foreground">{t("import.dropHint")}</span>}
            </button>
            <input ref={inputRef} type="file" accept=".knxproj" className="hidden" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          </div>
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> {t("import.password")}</Label>
            <Input type="password" value={password} placeholder={t("import.passwordPlaceholder")} onChange={(e) => setPassword(e.target.value)} className="sm:w-44" />
          </div>
        </div>
        {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <Button onClick={() => importMut.mutate()} disabled={!file || importMut.isPending} data-testid="import-submit">
          {importMut.isPending ? <><Loader2 className="size-4 animate-spin" /> {t("import.importing")}</> : t("import.submit")}
        </Button>
      </CardContent>
    </Card>
  );
}
