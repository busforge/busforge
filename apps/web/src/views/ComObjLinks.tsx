import { formatGa, type Levels } from "@busforge/knx/ga";
import { Loader2, Waypoints } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGaDevicesOf } from "../queries.ts";
import { ComObjRow } from "@/components/GaPill.tsx";
import { GaLabel } from "@/components/GaLabel.tsx";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errMsg } from "@/lib/apiError";
import { linkedObjects } from "@/lib/linkedObjects.ts";
import type { GaOption } from "./GaCombobox.tsx";

// A com-object's links on its device page: for each of its group addresses, in its order (the first
// is the one it sends on), the other objects on that address, on other devices and on this one, each
// with whether it sends or receives there and its flags, and each leading to its row on its device's
// page. The same address views the group-address overlay shows (GaPill), without the object itself.
// `open` is the page's URL state: following a row leaves it in the page's history entry, so the
// browser's back button returns to the open list.
export function ComObjLinks({ projectId, deviceId, number, label, gaRaws, options, levels, open, onOpenChange }: {
  projectId: string;
  deviceId: string;
  number: number;
  label: string;
  gaRaws: number[];
  options: GaOption[];
  levels: Levels;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const results = useGaDevicesOf(projectId, gaRaws, open);
  const byRaw = new Map(options.map((o) => [o.raw, o]));
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <IconButton variant="outline" size="icon-sm" className="size-7 shrink-0 text-muted-foreground" label={t("linkedObjects.open")} data-testid={`links-${number}`}>
          <Waypoints className="size-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} className="w-[min(26rem,calc(100vw-2rem))] p-0" data-testid={`links-${number}-panel`}>
        <div className="border-b px-4 py-3">
          <div className="text-sm font-medium">{t("linkedObjects.title")}</div>
          <div className="mt-0.5 flex min-w-0 gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 font-mono tabular-nums">{number}</span>
            <span className="truncate" title={label}>{label}</span>
          </div>
        </div>
        <div className="max-h-96 space-y-3 overflow-y-auto p-3">
          {gaRaws.map((raw, i) => {
            const q = results[i];
            const o = byRaw.get(raw);
            const rows = q?.data ? linkedObjects(q.data, { deviceId, comObjNumber: number }) : [];
            return (
              <section key={raw} data-testid={`links-${number}-ga-${i}`}>
                <div className="mb-1.5 flex min-w-0 items-center gap-2">
                  <GaLabel name={q?.data?.name ?? o?.name ?? ""} address={q?.data?.address ?? o?.address ?? formatGa(raw, levels)} className="min-w-0" />
                  {i === 0 && <Badge tone="primary" size="sm" className="ml-auto" title={t("ga.sendingAddressHint")}>{t("ga.sendingAddress")}</Badge>}
                </div>
                {!q || q.isLoading ? (
                  <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> {t("gaDevices.loading")}</div>
                ) : q.error ? (
                  <p className="px-1 text-xs text-destructive">{errMsg(t, q.error)}</p>
                ) : rows.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground" data-testid={`links-${number}-ga-${i}-empty`}>{t("linkedObjects.none")}</p>
                ) : (
                  <ul className="space-y-0.5">
                    {rows.map((r) => (
                      <li key={`${r.deviceId}-${r.comObjNumber}`}>
                        <ComObjRow projectId={projectId} entry={r} direction={r} sameDevice={r.sameDevice} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
