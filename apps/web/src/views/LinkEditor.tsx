import { useEffect, useState } from "react";
import { formatGa, type Levels } from "@busforge/knx/ga";
import { ArrowUpToLine, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GaLabel } from "@/components/GaLabel.tsx";
import { cn } from "@/lib/utils";
import { addLink, makeSender, removeLink, replaceOnly } from "@/lib/links.ts";
import { GaCombobox, type GaOption } from "./GaCombobox.tsx";

// A com-object's group addresses on the device page, in the order the device gets them: the first
// is the address the object sends on, the others it listens to. With one address or none it is the
// single picker (choosing replaces, as before); a further address turns it into a list where each
// address can be removed or made the sending one. Every change hands the whole new list to
// `onChange`; no address is dropped unless the user removes or replaces it. Each edit is built from
// the list shown, so every control is `disabled` while an edit is being saved.
export function LinkEditor({ options, gaRaws, onChange, disabled, testId, levels }: {
  options: GaOption[];
  gaRaws: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
  testId: string;
  levels: Levels;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [gaRaws.length]);
  const free = options.filter((o) => !gaRaws.includes(o.raw));
  const byRaw = new Map(options.map((o) => [o.raw, o]));
  const add = (raw: number | null) => { setAdding(false); if (raw != null) onChange(addLink(gaRaws, raw)); };
  const picker = (
    <GaCombobox options={free} value={null} onChange={add} placeholder={t("ga.addPlaceholder")} defaultOpen={gaRaws.length === 1} disabled={disabled} testId={`${testId}-add`} />
  );

  if (gaRaws.length <= 1) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <GaCombobox options={options} value={gaRaws[0] ?? null} onChange={(raw) => onChange(replaceOnly(raw))} disabled={disabled} testId={testId} />
          </div>
          {gaRaws.length === 1 && !adding && (
            <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground" disabled={disabled}
              aria-label={t("ga.addAddress")} title={t("ga.addAddress")} data-testid={`${testId}-more`} onClick={() => setAdding(true)}>
              <Plus className="size-4" />
            </Button>
          )}
        </div>
        {adding && picker}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <ul className="flex flex-col gap-1">
        {gaRaws.map((raw, i) => {
          const o = byRaw.get(raw);
          // An address the project does not hold (read back from the device) keeps its place, by number.
          const address = o?.address ?? formatGa(raw, levels);
          return (
            <li key={`${raw}-${i}`} className={cn("flex h-9 items-center gap-1 rounded-md border px-2", i === 0 && "border-primary/40")} data-testid={`${testId}-ga-${i}`}>
              <GaLabel name={o?.name ?? ""} address={address} className="min-w-0 flex-1" />
              {i === 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge tone="primary" size="sm" data-testid={`${testId}-sending`}>{t("ga.sendingAddress")}</Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64">{t("ga.sendingAddressHint")}</TooltipContent>
                </Tooltip>
              ) : (
                <IconButton size="icon-sm" className="size-7 text-muted-foreground" disabled={disabled}
                  label={t("ga.makeSending", { address })} data-testid={`${testId}-send-${i}`}
                  onClick={() => onChange(makeSender(gaRaws, raw))}>
                  <ArrowUpToLine className="size-3.5" />
                </IconButton>
              )}
              <IconButton size="icon-sm" className="size-7 text-muted-foreground" disabled={disabled}
                label={t("ga.removeAddress", { address })} data-testid={`${testId}-remove-${i}`}
                onClick={() => onChange(removeLink(gaRaws, raw))}>
                <X className="size-3.5" />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {picker}
    </div>
  );
}
