import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink, MessageSquareWarning, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useCatalog, useManufacturers, useVersion } from "../queries.ts";
import { buildIssueDraft, REPORT_TEMPLATES, subjectOf, type ReportDevice, type ReportKind } from "../lib/issueReport.ts";
import { cn } from "@/lib/utils";

// A prefilled GitHub issue (docs/reporting.md). The dialog shows every value the link carries before
// the user opens it; GitHub then shows the whole form again for review and submission.

export function ReportDialog({ open, onOpenChange, device }: { open: boolean; onOpenChange: (open: boolean) => void; device?: ReportDevice }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ReportKind>("problem");
  // Kept while the dialog is closed, so a click outside loses nothing; cleared once the link carries it
  // to GitHub (a text too long for the link stays, to be copied).
  const [text, setText] = useState("");
  const copyRef = useRef<HTMLTextAreaElement>(null);
  const { data: version } = useVersion();
  const { data: catalog } = useCatalog(open && !!device);
  const { data: manufacturers } = useManufacturers(open && !!device);
  const subject = useMemo(() => device ? subjectOf(device, catalog, manufacturers) : undefined, [device, catalog, manufacturers]);

  const draft = useMemo(() => version ? buildIssueDraft({ kind, version, subject, description: text }) : null, [kind, version, subject, text]);
  const descriptionLabel = t(`report.fields.${REPORT_TEMPLATES[kind].description}`);

  // The clipboard API needs a secure origin; a self-hosted Busforge over plain HTTP has none, so the
  // cleaned text (the one the link would carry) is selected for the user to copy instead.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft?.description ?? "");
      toast.success(t("report.copied"));
    } catch {
      copyRef.current?.focus();
      copyRef.current?.select();
      toast.info(t("report.copySelected"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MessageSquareWarning className="size-4 text-primary" /> {t("report.title")}</DialogTitle>
          <DialogDescription>{t("report.intro")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1" data-testid="report-dialog">
          {/* Device feedback is about one device; without one there is only the problem report. */}
          {device && (
            <div role="radiogroup" aria-label={t("report.kindLabel")} className="inline-flex rounded-md bg-muted p-[3px]">
              {(["problem", "feedback"] as const).map((k) => (
                <button
                  key={k} type="button" role="radio" aria-checked={kind === k} tabIndex={kind === k ? 0 : -1} data-testid={`report-kind-${k}`}
                  onClick={() => setKind(k)}
                  onKeyDown={(e) => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
                    e.preventDefault();
                    const next = kind === "problem" ? "feedback" : "problem";
                    setKind(next);
                    (e.currentTarget.parentElement?.querySelector(`[data-testid=report-kind-${next}]`) as HTMLElement | null)?.focus();
                  }}
                  className={cn("rounded-sm px-3 py-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50", kind === k && "bg-background text-foreground shadow-sm")}
                >
                  {t(`report.kinds.${k}.label`)}
                </button>
              ))}
            </div>
          )}
          <p className="text-sm text-muted-foreground" data-testid="report-kind-explain">{device ? t(`report.kinds.${kind}.explain`) : t("report.kinds.problem.explainNoDevice")}</p>

          <div className="space-y-1">
            <p className="text-sm font-medium">{t("report.filledTitle")}</p>
            {draft ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs" data-testid="report-fields">
                <dt className="text-muted-foreground">{t("report.fields.title")}</dt><dd className="break-all font-mono" data-field="title">{draft.title}</dd>
                {draft.fields.map((f) => (
                  <div key={f.id} className="contents">
                    <dt className="text-muted-foreground">{t(`report.fields.${f.id}`)}</dt><dd className="break-all font-mono" data-field={f.id}>{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
            {draft && draft.withheld.length > 0 && <p className="text-xs text-muted-foreground" data-testid="report-withheld">{t("report.withheld")}</p>}
            <p className="text-xs text-muted-foreground">{t("report.notIncluded")}</p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="report-text">{t("report.textLabel", { field: descriptionLabel })}</Label>
            <textarea
              id="report-text" value={text} onChange={(e) => setText(e.target.value)} rows={5} data-testid="report-text"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <p className="text-xs text-muted-foreground">{t("report.textHint")}</p>
          </div>

          {draft && !draft.descriptionInUrl && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400" data-testid="report-too-long">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-2">
                <p>{t("report.tooLong", { field: descriptionLabel })}</p>
                <textarea ref={copyRef} readOnly value={draft.description} rows={3} aria-label={t("report.copy")} data-testid="report-copy-text"
                  className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground" />
                <Button variant="outline" size="sm" onClick={() => void copy()} data-testid="report-copy"><Copy className="size-4" /> {t("report.copy")}</Button>
              </div>
            </div>
          )}

          {kind === "problem" && device && <p className="text-xs text-muted-foreground" data-testid="report-diagnostic">{t("report.diagnostic")}</p>}
          {draft?.searchUrl && (
            <a href={draft.searchUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline" data-testid="report-search">
              <Search className="size-3" /> {t("report.search")}
            </a>
          )}
          <p className="text-xs text-muted-foreground">{t("report.account")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
          {draft && (
            <Button asChild data-testid="report-open">
              <a href={draft.url} target="_blank" rel="noopener noreferrer" onClick={() => {
                // After the browser has followed this href: a state change now would reach it first.
                if (draft.descriptionInUrl) setTimeout(() => setText(""), 0);
              }}><ExternalLink className="size-4" /> {t("report.open")}</a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
