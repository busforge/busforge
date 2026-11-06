import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Visual identity of a KNX entity: a leading type icon, the entity name, then its address in mono
// behind a thin divider. The icon tells the kind apart (device or group address); the pill itself is
// a neutral slate, because amber is reserved for pending work, selection and the primary action
// (docs/design-system.md). `columns` lays a list row out as ETS does: the address first, in a fixed-width column, so the
// addresses of a list line up and read top to bottom; the name follows (no icon, the list says the kind).
// DeviceLabel and GaLabel are thin wrappers that pick the icon; this keeps their formatting in one place.
export function IdentityPill({ icon: Icon, name, value, placeholder = true, fallback, columns = false, className }: {
  icon: LucideIcon;
  name?: string;
  value: string;
  placeholder?: boolean;
  // Text shown (muted) in place of a missing name. Defaults to the "(unnamed)"
  // filler; callers that resolve an entity by address (e.g. the bus monitor) pass
  // "(unknown)" so a name we simply don't know reads differently from a known but
  // unnamed entity. Only shown when `placeholder` is true.
  fallback?: string;
  columns?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = name?.trim();
  const showName = !!label || placeholder;
  const nameText = label || fallback || t("common.unnamed");
  if (columns) {
    return (
      <span className={cn("flex min-w-0 max-w-full items-center gap-3 text-sm", className)}>
        <span className="w-(--addr-col) shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{value}</span>
        <span className={cn("truncate", label ? "text-foreground" : "text-muted-foreground")}>{nameText}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-1.5 py-0.5 align-middle text-sm",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {showName && <span className={cn("truncate", label ? "text-foreground" : "text-muted-foreground")}>{nameText}</span>}
      {showName && <span className="h-3 w-px shrink-0 bg-border" />}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{value}</span>
    </span>
  );
}
