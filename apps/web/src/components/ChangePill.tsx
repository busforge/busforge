import type { ReactNode } from "react";
import { CheckCircle2, ShieldAlert, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DeviceChanges } from "../api.ts";
import { Badge, BadgeButton } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const changeTotal = (c?: DeviceChanges) => (c ? c.params + c.links + (c.flags ?? 0) : 0);

// What a click on a mark does: the dialog that clears the state it reports, named in its tooltip.
export type ChangeTarget = { action: string; onClick: () => void };
export type ChangeTargets = { never?: ChangeTarget; changes?: ChangeTarget; security?: ChangeTarget };

function Mark({ size, explain, target, tapHeight, testId, children }: {
  size: "sm" | "md"; explain: string; target?: ChangeTarget; tapHeight: boolean; testId?: string; children: ReactNode;
}) {
  if (!target) return <Badge tone="warning" size={size} tapHeight={tapHeight} title={explain} data-testid={testId}>{children}</Badge>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <BadgeButton tone="warning" size={size} onClick={target.onClick} data-testid={testId}>
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

// Warning mark flagging a device with unprogrammed edits, or one never programmed at all, in the one
// tone of every mark that warns: small in a device row, medium in the device page header. With
// `targets` (the header) a mark opens what clears it, and a mark without a remedy is as tall on a touch
// screen as those beside it. A clean device renders nothing, or with `showProgrammed` (the header) a
// quiet "programmed" mark: the project's record (ETS's at import, or Busforge's last verified write or
// read-back), not a read of the device, so it is neutral, never ok.
export function ChangePill({ changes, size = "sm", targets, showProgrammed = false }: { changes?: DeviceChanges; size?: "sm" | "md"; targets?: ChangeTargets; showProgrammed?: boolean }) {
  const { t, i18n } = useTranslation();
  const n = changeTotal(changes);
  const tap = targets !== undefined;
  // ETS downloaded the device once, so "never programmed" would be false: name what ETS has still to
  // download. The state and its remedy are those of a never-programmed device.
  const ets = changes?.neverProgrammed ? changes.etsNotDownloaded : undefined;
  if (ets?.length) {
    const parts = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(ets.map((p) => t(`changes.etsPart.${p}`)));
    return (
      <Mark size={size} tapHeight={tap} explain={t("changes.etsTitle", { parts })} target={targets?.never} testId="ets-not-downloaded">
        <Zap /> {t("changes.ets")}
      </Mark>
    );
  }
  if (changes?.neverProgrammed) {
    return (
      <Mark size={size} tapHeight={tap} explain={t("changes.neverTitle")} target={targets?.never} testId="never-programmed">
        <Zap /> {t("changes.never")}
      </Mark>
    );
  }
  const security = changes?.security;
  if (!n && !security) {
    if (!showProgrammed || !changes) return null;
    return (
      <Badge tone="neutral" size={size} tapHeight={tap} title={t("changes.programmedTitle")} data-testid="programmed">
        <CheckCircle2 /> {t("changes.programmed")}
      </Badge>
    );
  }
  return (
    <>
      {n > 0 && (
        <Mark size={size} tapHeight={tap} explain={t("changes.title", { count: n })} target={targets?.changes} testId="device-changes">
          <Zap /> {t("changes.pill", { count: n })}
        </Mark>
      )}
      {security && (
        <Mark size={size} tapHeight={tap} explain={t(security === "changed" ? "changes.securityTitle" : "changes.securityUnknownTitle")} target={targets?.security} testId={`security-${security}`}>
          <ShieldAlert /> {t(security === "changed" ? "changes.security" : "changes.securityUnknown")}
        </Mark>
      )}
    </>
  );
}
