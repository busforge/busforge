import type { ReactNode } from "react";
import { ShieldAlert, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeviceChanges } from "../api.ts";
import { Badge, BadgeButton } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const changeTotal = (c?: DeviceChanges) => (c ? c.params + c.links + (c.flags ?? 0) : 0);

// What a click on a mark does: the dialog that clears the state it reports, named in its tooltip.
export type ChangeTarget = { action: string; onClick: () => void };
export type ChangeTargets = { never?: ChangeTarget; changes?: ChangeTarget; security?: ChangeTarget };

function Mark({ size, explain, target, testId, children }: {
  size: "sm" | "md"; explain: string; target?: ChangeTarget; testId?: string; children: ReactNode;
}) {
  if (!target) return <Badge tone="primary" size={size} mono title={explain} data-testid={testId}>{children}</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <BadgeButton tone="primary" size={size} mono onClick={target.onClick} data-testid={testId}>
          {children}
        </BadgeButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm space-y-1">
        <p>{explain}</p>
        <p className="font-medium">{target.action}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// Amber badge flagging a device with unprogrammed edits, or one never programmed at all: small in a
// device row, medium in the device page header. With `targets` a mark opens what clears it. Renders
// nothing when clean.
export function ChangePill({ changes, size = "sm", targets }: { changes?: DeviceChanges; size?: "sm" | "md"; targets?: ChangeTargets }) {
  const { t } = useTranslation();
  const n = changeTotal(changes);
  if (changes?.neverProgrammed) {
    return (
      <Mark size={size} explain={t("changes.neverTitle")} target={targets?.never} testId="never-programmed">
        <Zap /> {t("changes.never")}
      </Mark>
    );
  }
  const security = changes?.security;
  if (!n && !security) return null;
  return (
    <>
      {n > 0 && (
        <Mark size={size} explain={t("changes.title", { count: n })} target={targets?.changes} testId="device-changes">
          <Zap /> {t("changes.pill", { count: n })}
        </Mark>
      )}
      {security && (
        <Mark size={size} explain={t(security === "changed" ? "changes.securityTitle" : "changes.securityUnknownTitle")} target={targets?.security} testId={`security-${security}`}>
          <ShieldAlert /> {t(security === "changed" ? "changes.security" : "changes.securityUnknown")}
        </Mark>
      )}
    </>
  );
}
