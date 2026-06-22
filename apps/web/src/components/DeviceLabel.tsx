import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

// Unified device identity: the device name (or a placeholder) next to its KNX
// individual address in mono. Used wherever a device is referenced so the format
// stays consistent. `placeholder={false}` drops the "(unnamed)" filler in tight
// spots, showing just the address for nameless devices.
export function DeviceLabel({ name, ia, className, placeholder = true }: { name?: string; ia: string; className?: string; placeholder?: boolean }) {
  const { t } = useTranslation();
  const label = name?.trim();
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}>
      {(label || placeholder) && <span className="truncate">{label || t("common.unnamed")}</span>}
      <span className="shrink-0 font-mono text-xs text-primary">{ia}</span>
    </span>
  );
}
