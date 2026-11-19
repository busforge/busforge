import { useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2, Lock, Pencil, Plus, Radio, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { GaComObj, GaDevicesView } from "../api.ts";
import { useGaDevices, useGaSenders } from "../queries.ts";
import { GaLabel } from "@/components/GaLabel.tsx";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { DptBadge } from "@/components/DptBadge.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errMsg } from "@/lib/apiError";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { flagLetters } from "@/lib/comObjFlags.ts";
import { flagsKnown, objectSearch } from "@/lib/linkedObjects.ts";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";

// A group-address pill that opens a details overlay on click: the address's
// readable range path and datapoint type, plus the devices that use it, split
// into senders (transmit flag, the object's first address) and receivers (write
// flag), by the flags each device gets. Each object links to its row on its
// device's page. Wraps GaLabel so the resting appearance is unchanged; used
// wherever a GA is shown standalone (group list, bus monitor).
export function GaPill({ projectId, raw, name, address, fallback, columns, className, onEdit }: {
  projectId: string;
  raw: number;
  name?: string;
  address: string;
  fallback?: string;
  // A list row's address-first layout (IdentityPill `columns`).
  columns?: boolean;
  className?: string;
  // When set, an edit pencil appears in the overlay's top-right; clicking it
  // closes the overlay and invokes this (the caller opens the GA edit dialog).
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useGaDevices(projectId, raw, open);

  // Breadcrumb of the address's place in the group hierarchy (range path + name).
  const crumbs = [...(data?.path ?? []), data?.name || name].filter(Boolean) as string[];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn("min-w-0 max-w-full cursor-pointer rounded-md text-left outline-none transition-[filter] hover:brightness-125 focus-visible:ring-[3px] focus-visible:ring-ring/50", className)}>
          <GaLabel name={name} address={address} fallback={fallback} columns={columns} className="min-w-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-medium" title={crumbs.join(" / ")}>
              {crumbs.length ? crumbs.join(" / ") : <span className="text-muted-foreground">{t("common.unnamed")}</span>}
            </div>
            {onEdit && (
              <IconButton
                size="icon-sm" label={t("groupEdit.edit")}
                onClick={() => { setOpen(false); onEdit(); }}
                className="-mr-1.5 -mt-1 text-muted-foreground"
                data-testid="ga-overlay-edit"
              >
                <Pencil className="size-3.5" />
              </IconButton>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="font-mono text-xs text-primary">{address}</span>
            {data?.dpt && <DptBadge dpt={data.dpt} />}
            {data?.secured && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="ga-secured"><Lock className="size-3" /> {t("gaDevices.secured")}</span>}
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto p-3">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("gaDevices.loading")}
            </div>
          ) : error ? (
            <p className="py-4 text-center text-sm text-destructive">{errMsg(t, error)}</p>
          ) : data && data.senders.length === 0 && data.receivers.length === 0 ? (
            <div className="space-y-3">
              <p className="py-4 text-center text-sm text-muted-foreground">{t("gaDevices.empty")}</p>
              <InterfaceSenders projectId={projectId} raw={raw} data={data} />
            </div>
          ) : (
            <div className="space-y-3">
              <Section icon={<ArrowUpFromLine className="size-3.5" />} title={t("gaDevices.senders")} entries={data?.senders ?? []} projectId={projectId} emptyHint={t("gaDevices.noSenders")} onNavigate={() => setOpen(false)} />
              <Section icon={<ArrowDownToLine className="size-3.5" />} title={t("gaDevices.receivers")} entries={data?.receivers ?? []} projectId={projectId} emptyHint={t("gaDevices.noReceivers")} onNavigate={() => setOpen(false)} />
              {data && <InterfaceSenders projectId={projectId} raw={raw} data={data} />}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ icon, title, entries, projectId, emptyHint, onNavigate }: {
  icon: ReactNode;
  title: string;
  entries: GaComObj[];
  projectId: string;
  emptyHint: string;
  onNavigate: () => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon} {title} <span className="font-mono normal-case">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <ul className="space-y-0.5">
          {entries.map((e, i) => (
            <li key={`${e.deviceId}-${e.comObjRefId}-${i}`}>
              <ComObjRow projectId={projectId} entry={e} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One linked com-object of a group address: its device, number, texts and flags (where they are the
// device's), leading to its row on the device's page (`co` in the page's URL), or to the page where its
// configuration hides it. `direction` adds whether it sends or receives on the address, where the list
// does not say it by its section, like the flags only where they are the device's. `sameDevice` marks an
// object of the device the list is shown from; hidden there, it leads nowhere, the page being the one shown.
export function ComObjRow({ projectId, entry: e, onNavigate, direction, sameDevice }: {
  projectId: string;
  entry: GaComObj;
  onNavigate?: () => void;
  direction?: { sends: boolean; receives: boolean };
  sameDevice?: boolean;
}) {
  const { t } = useTranslation();
  const known = flagsKnown(e);
  const letters = known ? flagLetters(e.flags, t) : "";
  const testId = `co-row-${e.ia}-${e.comObjNumber}${e.hidden ? "-hidden" : ""}`;
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <DeviceLabel name={e.deviceName} ia={e.ia} className="min-w-0 max-w-full" />
        {sameDevice && <Badge tone="outline" size="sm">{t("gaDevices.sameDevice")}</Badge>}
        {known && direction?.sends && <Badge size="sm" className="ml-auto" data-testid="co-row-sends"><ArrowUpFromLine /> {t("gaDevices.sends")}</Badge>}
        {known && direction?.receives && <Badge size="sm" className={cn(!direction.sends && "ml-auto")} data-testid="co-row-receives"><ArrowDownToLine /> {t("gaDevices.receives")}</Badge>}
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5 pl-1 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono tabular-nums">{e.comObjNumber}</span>
        <span className="min-w-0 flex-1 truncate" title={[e.comObjName, e.functionText].filter(Boolean).join(" · ")}>
          {e.comObjName}{e.functionText && e.functionText !== e.comObjName ? ` · ${e.functionText}` : ""}
        </span>
        {letters && <span className="shrink-0 font-mono" title={t("gaDevices.flags")}>{letters}</span>}
      </span>
      {e.hidden && <span className="pl-1 text-xs text-warning" data-testid="ga-object-hidden">{t(direction ? "gaDevices.hidden" : "gaDevices.hiddenSorted")}</span>}
      {e.flagsRefused && <span className="pl-1 text-xs text-warning" data-testid="ga-flags-refused">{t(direction ? "linkedObjects.flagsRefused" : "gaDevices.flagsRefused")}</span>}
    </>
  );
  if (sameDevice && e.hidden) return <div className="flex flex-col gap-0.5 px-1.5 py-1" data-testid={testId}>{body}</div>;
  return (
    <Link
      to="/projects/$projectId/devices/$deviceId"
      params={{ projectId, deviceId: e.deviceId }}
      search={objectSearch(e)}
      onClick={onNavigate}
      className="flex flex-col gap-0.5 rounded-md px-1.5 py-1 outline-none hover:bg-secondary/60 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      data-testid={testId}
    >
      {body}
    </Link>
  );
}

// The individual addresses the project assigns as senders besides the linked objects: a tunnelling
// channel an app or visualisation sends from. On a secured address the devices on it only accept
// such a sender once their security table lists it, which takes a group-address download.
function InterfaceSenders({ projectId, raw, data }: { projectId: string; raw: number; data: GaDevicesView }) {
  const { t } = useTranslation();
  const [ia, setIa] = useState("");
  const { add, remove } = useGaSenders(projectId, raw);
  const failure = add.error ?? remove.error;
  return (
    <div data-testid="ga-interface-senders">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Radio className="size-3.5" /> {t("gaDevices.interfaceSenders")} <span className="font-mono normal-case">{data.interfaceSenders.length}</span>
      </div>
      {data.interfaceSenders.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{t("gaDevices.noInterfaceSenders")}</p>
      ) : (
        <ul className="space-y-0.5">
          {data.interfaceSenders.map((s) => (
            <li key={s.ia} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-secondary/60">
              <span className="font-mono">{s.ia}</span>
              <span className="text-xs text-muted-foreground">{t(`gaDevices.senderSource.${s.source}`)}</span>
              <IconButton size="icon-xs" className="ml-auto text-muted-foreground" label={t("gaDevices.removeSender", { ia: s.ia })}
                onClick={() => remove.mutate(s.ia)} disabled={remove.isPending} data-testid={`ga-sender-remove-${s.ia}`}>
                <X className="size-3.5" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (ia.trim()) add.mutate(ia.trim(), { onSuccess: () => setIa("") }); }}>
        <Input value={ia} onChange={(e) => setIa(e.target.value)} placeholder="1.2.250" aria-label={t("gaDevices.addSender")}
          className="h-7 min-w-0 flex-1 px-2 font-mono text-xs md:text-xs" data-testid="ga-sender-input" />
        <Button type="submit" variant="outline" size="xs" className="h-7" disabled={add.isPending || !ia.trim()} data-testid="ga-sender-add">
          <Plus className="size-3.5" /> {t("gaDevices.addSender")}
        </Button>
      </form>
      {failure && <p className="mt-1 text-xs text-destructive">{errMsg(t, failure)}</p>}
      {data.secured && <p className="mt-1.5 text-xs text-muted-foreground">{t("gaDevices.sendersNeedDownload")}</p>}
    </div>
  );
}

