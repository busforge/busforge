import { ShieldAlert, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeviceChanges } from "../api.ts";

export const changeTotal = (c?: DeviceChanges) => (c ? c.params + c.links + (c.flags ?? 0) : 0);

// Amber pill flagging a device with unprogrammed edits, or one never programmed at all. Renders
// nothing when clean.
export function ChangePill({ changes }: { changes?: DeviceChanges }) {
  const { t } = useTranslation();
  const n = changeTotal(changes);
  if (changes?.neverProgrammed) {
    return (
      <span
        title={t("changes.neverTitle")} data-testid="never-programmed"
        className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary"
      >
        <Zap className="size-3" /> {t("changes.never")}
      </span>
    );
  }
  const security = changes?.security;
  if (!n && !security) return null;
  return (
    <>
      {n > 0 && (
        <span
          title={t("changes.title", { count: n })}
          className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary"
        >
          <Zap className="size-3" /> {t("changes.pill", { count: n })}
        </span>
      )}
      {security && (
        <span
          title={t(security === "changed" ? "changes.securityTitle" : "changes.securityUnknownTitle")} data-testid={`security-${security}`}
          className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary"
        >
          <ShieldAlert className="size-3" /> {t(security === "changed" ? "changes.security" : "changes.securityUnknown")}
        </span>
      )}
    </>
  );
}
