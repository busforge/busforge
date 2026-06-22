import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Unified group-address identity: the GA name (or a placeholder) next to its
// address in mono. A deliberate mirror of DeviceLabel kept in its own file so the
// two can evolve independently. `placeholder={false}` drops the filler and shows
// just the address for unnamed group addresses.
export function GaLabel({ name, address, className, placeholder = true }: { name?: string; address: string; className?: string; placeholder?: boolean }) {
  const { t } = useTranslation();
  const label = name?.trim();
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}>
      {(label || placeholder) && <span className="truncate">{label || t("common.unnamed")}</span>}
      <span className="shrink-0 font-mono text-xs text-primary">{address}</span>
    </span>
  );
}
