import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { DroppedLink } from "@/api.ts";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { GaLabel } from "@/components/GaLabel.tsx";
import { HeaderWarning } from "@/components/HeaderWarning.tsx";
import { Badge } from "@/components/ui/badge";
import { errMsg, localizeError } from "@/lib/apiError.ts";

// What stands in place of an object the device's configuration does not place.
const UNRESOLVED_TEXT = {
  noApplication: "import.dropped.objectNoApplication",
  moduleInstanceGone: "import.dropped.objectModuleInstanceGone",
  notInApplication: "import.dropped.objectNotInApplication",
  notInConfiguration: "import.dropped.objectUnknown",
} as const;

// The project's links not taken over, as a mark in a page header: a warning counting the entries a link made
// by hand can still close; where every entry is one no link reaches, a plain mark without a count, so the list
// stays reachable and nothing reads as all taken over.
export function DroppedLinksMark({ links, error, testId, projectId, showDevice }: { links: DroppedLink[] | undefined; error: unknown; testId: string; projectId?: string; showDevice?: boolean }) {
  const { t } = useTranslation();
  if (error) return <HeaderWarning label={t("import.dropped.label")} title={t("import.dropped.title")} count={null} testId={testId} items={[t("import.dropped.error", { reason: errMsg(t, error) })]} />;
  if (!links?.length) return null;
  const open = links.filter((l) => !l.unrecoverable).length;
  return (
    <HeaderWarning
      label={t("import.dropped.label")} title={t("import.dropped.title")} testId={testId}
      tone={open ? "warning" : "neutral"} count={open || null}
      detail={<DroppedLinksDetail links={links} projectId={projectId} showDevice={showDevice} />}
    />
  );
}

// The mark's popover: what the list is, when an object leaves it (while one can), and the list.
export function DroppedLinksDetail({ links, projectId, showDevice }: { links: DroppedLink[]; projectId?: string; showDevice?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-muted-foreground">{t("import.dropped.hint")}{links.some((l) => !l.unrecoverable) && <> {t("import.dropped.open")}</>}</p>
      <DroppedLinksList links={links} projectId={projectId} showDevice={showDevice} />
    </>
  );
}

// The com-objects whose ETS links an import did not take over in full, grouped by device in the file's
// order: each object with what ETS linked it to, the first address being the one it sends on, and why
// the links were left out. Those no link made in Busforge reaches follow apart, each saying why. With
// `projectId` a device heads its group as a link to its page, where the object can be linked again.
export function DroppedLinksList({ links, projectId, showDevice = true }: { links: DroppedLink[]; projectId?: string; showDevice?: boolean }) {
  const { t } = useTranslation();
  const open = links.filter((l) => !l.unrecoverable);
  const lost = links.filter((l) => l.unrecoverable);
  return (
    <div className="space-y-3" data-testid="dropped-links">
      <ObjectsByDevice links={open} projectId={projectId} showDevice={showDevice} testId="dropped-device" />
      {lost.length > 0 && (
        <section className={open.length ? "space-y-2 border-t border-border/60 pt-3" : "space-y-2"} data-testid="dropped-unrecoverable">
          <p className="text-sm font-medium">{t("import.dropped.unrecoverable")}</p>
          <p className="text-xs text-muted-foreground">{t("import.dropped.unrecoverableHint")}</p>
          <ObjectsByDevice links={lost} projectId={projectId} showDevice={showDevice} testId="dropped-unrecoverable-device" />
        </section>
      )}
    </div>
  );
}

function ObjectsByDevice({ links, projectId, showDevice, testId }: { links: DroppedLink[]; projectId?: string; showDevice: boolean; testId: string }) {
  const { t } = useTranslation();
  const byDevice = new Map<string, DroppedLink[]>();
  for (const l of links) byDevice.set(l.deviceId, [...(byDevice.get(l.deviceId) ?? []), l]);
  return [...byDevice].map(([deviceId, objs]) => (
    <section key={deviceId} className="space-y-1.5" data-testid={`${testId}-${objs[0].ia}`}>
      {showDevice && (projectId
        ? <Link to="/projects/$projectId/devices/$deviceId" params={{ projectId, deviceId }} className="inline-flex rounded-md outline-none transition hover:brightness-125 focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <DeviceLabel name={objs[0].deviceName} ia={objs[0].ia} />
          </Link>
        : <DeviceLabel name={objs[0].deviceName} ia={objs[0].ia} />)}
      <ul className="space-y-2">
        {objs.map((o, i) => (
          <li key={i} className="space-y-1 rounded-md border border-border/60 bg-background/40 px-2.5 py-2" data-testid="dropped-object">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              {o.comObjNumber !== null
                ? <>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{t("import.dropped.object", { number: o.comObjNumber })}</span>
                    <span className="truncate text-foreground">{[o.comObjName, o.functionText].filter(Boolean).join(" · ")}</span>
                  </>
                : <>
                    <span className="text-muted-foreground">
                      {o.unresolved === "refused"
                        ? t("import.dropped.objectRefused", { reason: localizeError(t, o.refusal, o.refusal) })
                        : t(UNRESOLVED_TEXT[o.unresolved ?? "notInConfiguration"])}
                    </span>
                    <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{o.comObjRefId}</span>
                  </>}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {o.gas.map((g, j) => g.inProject && g.address !== null
                ? <GaLabel key={j} name={g.name ?? undefined} address={g.address} />
                : <Badge key={j} tone="outline" size="md" className="border-dashed" title={t("import.dropped.gaMissingTitle", { id: g.etsId })}>
                    {t("import.dropped.gaMissing")} <span className="font-mono opacity-80">{g.address ?? g.etsId}</span>
                  </Badge>)}
            </div>
            <p className="text-xs text-muted-foreground">{t(`import.dropped.reason.${o.reason}`)}</p>
          </li>
        ))}
      </ul>
    </section>
  ));
}
