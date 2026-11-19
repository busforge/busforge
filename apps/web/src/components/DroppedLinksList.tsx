import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { DroppedLink } from "@/api.ts";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { GaLabel } from "@/components/GaLabel.tsx";
import { Badge } from "@/components/ui/badge";

// The com-objects whose ETS links an import did not take over in full, grouped by device in the file's
// order: each object with what ETS linked it to, the first address being the one it sends on, and why
// the links were left out. With `projectId` a device heads its group as a link to its page, where the
// object can be linked again.
export function DroppedLinksList({ links, projectId, showDevice = true }: { links: DroppedLink[]; projectId?: string; showDevice?: boolean }) {
  const { t } = useTranslation();
  const byDevice = new Map<string, DroppedLink[]>();
  for (const l of links) byDevice.set(l.deviceId, [...(byDevice.get(l.deviceId) ?? []), l]);
  return (
    <div className="space-y-3" data-testid="dropped-links">
      {[...byDevice].map(([deviceId, objs]) => (
        <section key={deviceId} className="space-y-1.5" data-testid={`dropped-device-${objs[0].ia}`}>
          {showDevice && (projectId
            ? <Link to="/projects/$projectId/devices/$deviceId" params={{ projectId, deviceId }} className="inline-flex rounded-md outline-none transition hover:brightness-125 focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <DeviceLabel name={objs[0].deviceName} ia={objs[0].ia} />
              </Link>
            : <DeviceLabel name={objs[0].deviceName} ia={objs[0].ia} />)}
          <ul className="space-y-2">
            {objs.map((o) => (
              <li key={o.comObjRefId} className="space-y-1 rounded-md border border-border/60 bg-background/40 px-2.5 py-2" data-testid="dropped-object">
                <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                  {o.comObjNumber !== null
                    ? <>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{t("import.dropped.object", { number: o.comObjNumber })}</span>
                        <span className="truncate text-foreground">{[o.comObjName, o.functionText].filter(Boolean).join(" · ")}</span>
                      </>
                    : <>
                        <span className="text-muted-foreground">{t("import.dropped.objectUnknown")}</span>
                        <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{o.comObjRefId}</span>
                      </>}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {o.gas.map((g, i) => g.address !== null
                    ? <GaLabel key={i} name={g.name ?? undefined} address={g.address} />
                    : <Badge key={i} tone="outline" size="md" className="border-dashed" title={t("import.dropped.gaMissingTitle", { id: g.etsId })}>
                        {t("import.dropped.gaMissing")} <span className="font-mono opacity-80">{g.etsId}</span>
                      </Badge>)}
                </div>
                <p className="text-xs text-muted-foreground">{t(`import.dropped.reason.${o.reason}`)}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
