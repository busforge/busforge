import { useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { GaComObj } from "../api.ts";
import { useGaDevices } from "../queries.ts";
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
export function GaPill({ projectId, raw, name, address, fallback, className }: {
  projectId: string;
  raw: number;
  name?: string;
  address: string;
  fallback?: string;
  className?: string;
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
          <div className="truncate text-sm font-medium" title={crumbs.join(" / ")}>
            {crumbs.length ? crumbs.join(" / ") : <span className="text-muted-foreground">{t("common.unnamed")}</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="font-mono text-xs text-primary">{address}</span>
            {data?.dpt && <DptBadge dpt={data.dpt} />}
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
            <p className="py-4 text-center text-sm text-muted-foreground">{t("gaDevices.empty")}</p>
          ) : (
            <div className="space-y-3">
              <Section icon={<ArrowUpFromLine className="size-3.5" />} title={t("gaDevices.senders")} entries={data?.senders ?? []} projectId={projectId} emptyHint={t("gaDevices.noSenders")} onNavigate={() => setOpen(false)} />
              <Section icon={<ArrowDownToLine className="size-3.5" />} title={t("gaDevices.receivers")} entries={data?.receivers ?? []} projectId={projectId} emptyHint={t("gaDevices.noReceivers")} onNavigate={() => setOpen(false)} />
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
