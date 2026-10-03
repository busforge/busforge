import { CheckCircle2, CircleDashed, ExternalLink, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeviceConfigView } from "../api.ts";
import { useManufacturers } from "../queries.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { MATRIX_OPS as OPS, summarize, orderOf, type Summary } from "../lib/untested.ts";

const manufacturerId = (n: number) => `M-${n.toString(16).toUpperCase().padStart(4, "0")}`;

const SUMMARY_STYLE: Record<Summary, string> = {
  tested: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  partial: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  derived: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  untested: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  unsupported: "border-border bg-secondary/40 text-muted-foreground",
};
const SUMMARY_ICON = { tested: ShieldCheck, partial: ShieldCheck, derived: ShieldQuestion, failed: ShieldAlert, untested: ShieldQuestion, unsupported: ShieldOff } as const;

const mark = (s: string | undefined) => (s === "pass" ? "✓" : s === "fail" ? "✗" : s === "conflict" ? "!" : s === "not-applicable" ? "n/a" : "–");

// What was shown on hardware for this device's Product, per operation, from the evidence the
// server ships. A summary badge next to the device name; the detail opens on click.
export function CompatibilityBadge({ view, manufacturer }: { view: Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged"> | undefined; manufacturer?: number }) {
  const { t } = useTranslation();
  const { data: manufacturers } = useManufacturers(manufacturer !== undefined);
  const c = view?.compatibility;
  if (!c) return null;
  const summary = summarize(c);
  const Icon = SUMMARY_ICON[summary];
  const maker = manufacturer !== undefined ? manufacturers?.find((m) => m.id === manufacturerId(manufacturer)) : undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="compatibility-badge"
          className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", SUMMARY_STYLE[summary])}>
          <Icon className="size-4" /> {t(`compat.summary.${summary}`)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem] max-w-[calc(100vw-2rem)] space-y-3 overflow-x-auto text-xs" data-testid="compatibility-detail">
        <p className="text-sm font-medium">{t("compat.title")}</p>
        <table className="w-full">
          <thead className="text-muted-foreground">
            <tr><th className="pb-1 text-left font-normal">{t("compat.colOperation")}</th><th className="pb-1 text-left font-normal">{t("compat.colState")}</th><th className="pb-1 text-center font-normal">{t("compat.colTransfer")}</th><th className="pb-1 text-center font-normal">{t("compat.colPersistence")}</th></tr>
          </thead>
          <tbody>
            {OPS.map((op) => {
              const v = c[op];
              return (
                <tr key={op} className="border-t border-border/60 align-top">
                  <td className="py-1 pr-2">{t(`untested.op.${op}`)}</td>
                  <td className="py-1 pr-2">
                    <span className={cn("inline-flex items-center gap-1", v.state === "tested" && "text-emerald-700 dark:text-emerald-300", (v.state === "failed" || v.state === "conflict") && "text-destructive", v.state === "refused" && "text-muted-foreground")}>
                      {v.state === "tested" ? <CheckCircle2 className="size-3" /> : <CircleDashed className="size-3" />} {t(`compat.state.${v.state}`)}
                    </span>
                    {v.derivedFrom && <div className="text-muted-foreground">{t("compat.derivedFrom", { product: orderOf(v.derivedFrom) })}</div>}
                    {v.sameAppTestedOn && <div className="text-muted-foreground">{t("compat.sameApp", { product: orderOf(v.sameAppTestedOn) })}</div>}
                    {v.firmware.length > 0 && <div className="text-muted-foreground">{v.derivedFrom ? t("compat.firmwareOf", { fw: v.firmware.join(", "), product: orderOf(v.derivedFrom) }) : t("compat.firmware", { fw: v.firmware.join(", ") })}</div>}
                    {(v.cells.tool?.transfer.state === "fail" || v.cells.tool?.transfer.state === "conflict") && <div className="text-destructive">{t("compat.toolFailed")}</div>}
                  </td>
                  <td className="py-1 text-center font-mono" aria-label={`API ${v.cells.api?.transfer.state ?? "none"}, UI ${v.cells.ui?.transfer.state ?? "none"}`}>{mark(v.cells.api?.transfer.state)} / {mark(v.cells.ui?.transfer.state)}</td>
                  <td className="py-1 text-center font-mono" aria-label={`API ${v.cells.api?.persistence.state ?? "none"}, UI ${v.cells.ui?.persistence.state ?? "none"}`}>{mark(v.cells.api?.persistence.state)} / {mark(v.cells.ui?.persistence.state)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-muted-foreground">{t("compat.explain")}</p>
        {view?.untestedAcknowledged && <p className="text-muted-foreground">{t("compat.acknowledged")}</p>}
        {maker && (
          <p className="border-t border-border pt-2">
            {maker.name}:{" "}
            {maker.productDataUrl
              ? <a href={maker.productDataUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">{t("catalog.sourceLink")} <ExternalLink className="size-3" /></a>
              : <span className="text-muted-foreground">{t("catalog.sourceNone")}</span>}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
