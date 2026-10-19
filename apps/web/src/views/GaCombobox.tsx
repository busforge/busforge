import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { GaLabel } from "@/components/GaLabel.tsx";
import { cn } from "@/lib/utils";

export interface GaOption { raw: number; address: string; name: string; }

// Searchable group-address picker for assigning a com-object. Passing null
// clears the link (unassigns the com-object). `placeholder` labels the empty
// picker; `defaultOpen` opens it on mount (a picker the user just asked for).
export function GaCombobox({ options, value, onChange, testId, placeholder, defaultOpen = false, disabled }: {
  options: GaOption[];
  value: number | null;
  onChange: (raw: number | null) => void;
  testId?: string;
  placeholder?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  // Mount the Popover/Command machinery only once interacted with: a device can
  // have 100+ of these, and mounting them all up front is a real render cost.
  // Until then render just the light trigger button.
  const [active, setActive] = useState(defaultOpen);
  const sel = options.find((o) => o.raw === value);
  const triggerClass = cn("h-9 w-full justify-between font-normal", !sel && "border-dashed font-mono text-xs text-muted-foreground");
  const label = <>{sel ? <GaLabel name={sel.name} address={sel.address} className="min-w-0" /> : <span className="truncate">{placeholder ?? t("ga.assign")}</span>}<ChevronsUpDown className="size-3.5 shrink-0 opacity-50" /></>;

  if (!active) {
    return (
      <Button variant="outline" role="combobox" data-testid={testId} className={triggerClass} disabled={disabled}
        onClick={() => { setActive(true); setOpen(true); }}>
        {label}
      </Button>
    );
  }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setActive(false); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" data-testid={testId} className={triggerClass} disabled={disabled}>
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder={t("ga.searchPlaceholder")} />
          <CommandList>
            <CommandEmpty>{t("ga.empty")}</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem value="__unassign__" onSelect={() => { onChange(null); setOpen(false); }} className="gap-2 text-muted-foreground">
                  <X className="size-3.5" />
                  <span>{t("ga.unassign")}</span>
                </CommandItem>
              )}
              {options.map((o) => (
                <CommandItem key={o.raw} value={`${o.address} ${o.name}`} onSelect={() => { onChange(o.raw); setOpen(false); }} className="gap-2">
                  <Check className={cn("size-3.5 shrink-0", o.raw === value ? "opacity-100" : "opacity-0")} />
                  <GaLabel name={o.name} address={o.address} className="min-w-0" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
