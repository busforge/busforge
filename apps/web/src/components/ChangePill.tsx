import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeviceChanges } from "../api.ts";

export const changeTotal = (c?: DeviceChanges) => (c ? c.params + c.links : 0);

// Amber pill flagging a device with unprogrammed edits. Renders nothing when clean.
export function ChangePill({ changes }: { changes?: DeviceChanges }) {
  const { t } = useTranslation();
  const n = changeTotal(changes);
  if (!n || !changes) return null;
  return (
    <span
      title={t("changes.title", { count: n })}
      className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary"
    >
      <Zap className="size-3" /> {t("changes.pill", { count: n })}
    </span>
  );
}
