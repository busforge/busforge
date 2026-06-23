import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Visual identity of a KNX entity, shown as a colour-coded pill: a leading type
// icon, the entity name, then its address split off behind a thin divider. Colour
// encodes the kind so the two are recognisable at a glance (devices = blue,
// group addresses = amber). DeviceLabel and GaLabel are thin wrappers that just
// pick the icon and variant; this keeps their formatting in one place.
const VARIANTS = {
  device: { wrap: "border-chart-2/30 bg-chart-2/10", accent: "text-chart-2", divider: "bg-chart-2/30" },
  ga: { wrap: "border-primary/30 bg-primary/10", accent: "text-primary", divider: "bg-primary/30" },
} as const;

export function IdentityPill({ icon: Icon, name, value, variant, placeholder = true, fallback, className }: {
  icon: LucideIcon;
  name?: string;
  value: string;
  variant: keyof typeof VARIANTS;
  placeholder?: boolean;
  // Text shown (muted) in place of a missing name. Defaults to the "(unnamed)"
  // filler; callers that resolve an entity by address (e.g. the bus monitor) pass
  // "(unknown)" so a name we simply don't know reads differently from a known but
  // unnamed entity. Only shown when `placeholder` is true.
  fallback?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const v = VARIANTS[variant];
  const label = name?.trim();
  const showName = !!label || placeholder;
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 align-middle text-sm", v.wrap, className)}>
      <Icon className={cn("size-3.5 shrink-0", v.accent)} />
      {showName && <span className={cn("truncate", label ? "text-foreground" : "text-muted-foreground")}>{label || fallback || t("common.unnamed")}</span>}
      {showName && <span className={cn("h-3 w-px shrink-0", v.divider)} />}
      <span className={cn("shrink-0 font-mono text-xs", v.accent)}>{value}</span>
    </span>
  );
}
