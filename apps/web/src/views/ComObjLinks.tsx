import { formatGa, type Levels } from "@busforge/knx/ga";
import { Loader2, Waypoints } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGaDevicesOf } from "../queries.ts";
import { ComObjRow } from "@/components/GaPill.tsx";
import { GaLabel } from "@/components/GaLabel.tsx";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger, useRoomierSide } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errMsg } from "@/lib/apiError";
import { linkedObjects } from "@/lib/linkedObjects.ts";
import type { GaOption } from "./GaCombobox.tsx";

interface Props {
  projectId: string;
  deviceId: string;
  number: number;
  label: string;
  gaRaws: number[];
  options: GaOption[];
  levels: Levels;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// A com-object's links on its device page: for each of its group addresses, in its order (the first
// is the one it sends on), the other objects on that address, on other devices and on this one, each
// with whether it sends or receives there and its flags, and each leading to its row on its device's
// page. The same address views the group-address overlay shows (GaPill), without the object itself.
// `open` is the page's URL state: following a row leaves it in the page's history entry, so the
// browser's back button returns to the open list.
export function ComObjLinks(props: Props) {
  const { t } = useTranslation();
  const placement = useRoomierSide(props.open);
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild ref={placement.ref}>
        <IconButton variant="outline" size="icon-sm" className="size-7 shrink-0 text-muted-foreground" label={t("linkedObjects.open")} data-testid={`links-${props.number}`}>
          <Waypoints className="size-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" side={placement.side} className="flex w-[26rem] flex-col p-0" data-testid={`links-${props.number}-panel`}>
        <LinksPanel {...props} />
      </PopoverContent>
    </Popover>
  );
}

// The open list; mounted only while the popover is open, so a closed row loads and builds nothing.
function LinksPanel({ projectId, deviceId, number, label, gaRaws, options, levels }: Props) {
  const { t } = useTranslation();
  const results = useGaDevicesOf(projectId, gaRaws);
  const byRaw = new Map(options.map((o) => [o.raw, o]));
  return (
    <>
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium">{t("linkedObjects.title")}</div>
        <div className="mt-0.5 flex min-w-0 gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 font-mono tabular-nums">{number}</span>
          <span className="truncate" title={label}>{label}</span>
        </div>
      </div>
      <div className="max-h-96 scroll-shadow-y space-y-3 overflow-y-auto p-3">
        {gaRaws.map((raw, i) => {
          const q = results[i];
          const o = byRaw.get(raw);
          const rows = q.data ? linkedObjects(q.data, { deviceId, comObjNumber: number }) : [];
          return (
            <section key={raw} data-testid={`links-${number}-ga-${i}`}>
              <div className="mb-1.5 flex min-w-0 items-center gap-2">
                <GaLabel name={q.data?.name ?? o?.name ?? ""} address={q.data?.address ?? o?.address ?? formatGa(raw, levels)} className="min-w-0" />
                {i === 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild tapToOpen>
                      <Badge tone="primary" size="sm" className="ml-auto">{t("linkedObjects.sendingAddress")}</Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-64">{t("ga.sendingAddressHint")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {q.isPending ? (
                <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> {t("gaDevices.loading")}</div>
              ) : q.error ? (
                <p className="px-1 text-xs text-destructive">{errMsg(t, q.error)}</p>
              ) : rows.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground" data-testid={`links-${number}-ga-${i}-empty`}>{t("linkedObjects.none")}</p>
              ) : (
                <ul className="space-y-0.5">
                  {rows.map((r) => (
                    <li key={`${r.deviceId}-${r.comObjRefId}`}>
                      <ComObjRow projectId={projectId} entry={r} direction={r} sameDevice={r.sameDevice} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
