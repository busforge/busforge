import { useTranslation } from "react-i18next";
import { dptSubtypeLabel } from "@/lib/dpts.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Renders a KNX datapoint type ("9.021", "1.005", …) as a two-segment pill: the
// human-readable meaning next to the raw DPT id. The name prefers the specific
// subtype label ("Current (mA)", "Alarm") from the catalog and falls back to the
// main-type family name ("Float", "Boolean") keyed by the part before the dot in
// the `dpt` locale namespace. A longer explanation (size, example) shows in a
// tooltip. Unknown types fall back to a plain id chip.
export function DptBadge({ dpt, className }: { dpt: string; className?: string }) {
  const { t } = useTranslation();
  if (!dpt) return null;
  const main = dpt.split(".")[0];
  const name = dptSubtypeLabel(dpt) || t(`dpt.${main}.name`, { defaultValue: "" });
  const detail = t(`dpt.${main}.detail`, { defaultValue: "" });

  const pill = (
    <span className={cn("inline-flex shrink-0 items-stretch overflow-hidden rounded-md border border-border bg-secondary/40 text-xs", className)}>
      {name && <span className="bg-secondary/60 px-1.5 py-0.5 font-medium text-secondary-foreground">{name}</span>}
      <span className={cn("px-1.5 py-0.5 font-mono text-muted-foreground", name && "border-l border-border")}>{dpt}</span>
    </span>
  );

  if (!detail) return pill;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`${name} ${dpt}: ${detail}`} className="cursor-default">{pill}</button>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}
