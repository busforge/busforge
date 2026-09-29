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

// A group-address pill that opens a details overlay on click: the address's
// readable range path and datapoint type, plus the devices that use it, split
// into senders (transmit) and receivers (write). Each device links to its
// configuration. Wraps GaLabel so the resting appearance is unchanged; used
// wherever a GA is shown standalone (group list, bus monitor).
export function GaPill({ projectId, raw, name, address, fallback, className, onEdit }: {
  projectId: string;
  raw: number;
  name?: string;
  address: string;
  fallback?: string;
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
        <button type="button" className={cn("min-w-0 max-w-full cursor-pointer rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}>
          <GaLabel name={name} address={address} fallback={fallback} className="min-w-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-medium" title={crumbs.join(" / ")}>
              {crumbs.length ? crumbs.join(" / ") : <span className="text-muted-foreground">{t("common.unnamed")}</span>}
            </div>
            {onEdit && (
              <button
                type="button" aria-label={t("groupEdit.edit")} title={t("groupEdit.edit")}
                onClick={() => { setOpen(false); onEdit(); }}
                className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                data-testid="ga-overlay-edit"
              >
                <Pencil className="size-3.5" />
              </button>
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
            <li key={`${e.deviceId}-${e.comObjNumber}-${i}`}>
              <Link
                to="/projects/$projectId/devices/$deviceId"
                params={{ projectId, deviceId: e.deviceId }}
                onClick={onNavigate}
                className="flex flex-col gap-0.5 rounded px-1.5 py-1 hover:bg-secondary/60"
              >
                <DeviceLabel name={e.deviceName} ia={e.ia} className="max-w-full" />
                <span className="truncate pl-1 text-xs text-muted-foreground" title={[e.comObjName, e.functionText].filter(Boolean).join(" · ")}>
                  {e.comObjName}{e.functionText && e.functionText !== e.comObjName ? ` · ${e.functionText}` : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
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
            <li key={s.ia} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-secondary/60">
              <span className="font-mono">{s.ia}</span>
              <span className="text-xs text-muted-foreground">{t(`gaDevices.senderSource.${s.source}`)}</span>
              <button type="button" className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={t("gaDevices.removeSender", { ia: s.ia })}
                title={t("gaDevices.removeSender", { ia: s.ia })} onClick={() => remove.mutate(s.ia)} disabled={remove.isPending} data-testid={`ga-sender-remove-${s.ia}`}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="mt-2 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (ia.trim()) add.mutate(ia.trim(), { onSuccess: () => setIa("") }); }}>
        <input value={ia} onChange={(e) => setIa(e.target.value)} placeholder="1.1.100" aria-label={t("gaDevices.addSender")}
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs" data-testid="ga-sender-input" />
        <button type="submit" disabled={add.isPending || !ia.trim()} className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-secondary disabled:opacity-50" data-testid="ga-sender-add">
          <Plus className="size-3.5" /> {t("gaDevices.addSender")}
        </button>
      </form>
      {failure && <p className="mt-1 text-xs text-destructive">{errMsg(t, failure)}</p>}
      {data.secured && <p className="mt-1.5 text-xs text-muted-foreground">{t("gaDevices.sendersNeedDownload")}</p>}
    </div>
  );
}

