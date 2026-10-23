import { ShieldAlert, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeviceChanges } from "../api.ts";
import { Badge } from "@/components/ui/badge";

export const changeTotal = (c?: DeviceChanges) => (c ? c.params + c.links + (c.flags ?? 0) : 0);

// Amber badge flagging a device with unprogrammed edits, or one never programmed at all: small in a
// device row, medium in the device page header. Renders nothing when clean.
export function ChangePill({ changes, size = "sm" }: { changes?: DeviceChanges; size?: "sm" | "md" }) {
  const { t } = useTranslation();
  const n = changeTotal(changes);
  if (changes?.neverProgrammed) {
    return (
      <Badge tone="primary" size={size} mono title={t("changes.neverTitle")} data-testid="never-programmed">
        <Zap /> {t("changes.never")}
      </Badge>
    );
  }
  const security = changes?.security;
  if (!n && !security) return null;
  return (
    <>
      {n > 0 && (
        <Badge tone="primary" size={size} mono title={t("changes.title", { count: n })}>
          <Zap /> {t("changes.pill", { count: n })}
        </Badge>
      )}
      {security && (
        <Badge tone="primary" size={size} mono title={t(security === "changed" ? "changes.securityTitle" : "changes.securityUnknownTitle")} data-testid={`security-${security}`}>
          <ShieldAlert /> {t(security === "changed" ? "changes.security" : "changes.securityUnknown")}
        </Badge>
      )}
    </>
  );
}
