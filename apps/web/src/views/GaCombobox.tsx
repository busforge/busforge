import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface GaOption { raw: number; address: string; name: string; }

// Searchable group-address picker for re-pointing a com-object.
export function GaCombobox({ options, value, onChange, testId }: {
  options: GaOption[];
  value: number | null;
  onChange: (raw: number) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const sel = options.find((o) => o.raw === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" size="sm" className="h-8 w-full justify-between font-mono text-xs" data-testid={testId}>
          <span className="truncate">{sel ? `${sel.address} ${sel.name}` : "unassigned"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search group address…" />
          <CommandList>
            <CommandEmpty>No group address.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem key={o.raw} value={`${o.address} ${o.name}`} onSelect={() => { onChange(o.raw); setOpen(false); }} className="gap-2">
                  <Check className={cn("size-3.5", o.raw === value ? "opacity-100" : "opacity-0")} />
                  <span className="w-16 shrink-0 font-mono text-primary">{o.address}</span>
                  <span className="truncate">{o.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
