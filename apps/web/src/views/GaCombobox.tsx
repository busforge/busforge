import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface GaOption { raw: number; address: string; name: string; }

// Searchable group-address picker for assigning a com-object. Passing null
// clears the link (unassigns the com-object).
export function GaCombobox({ options, value, onChange, testId }: {
  options: GaOption[];
  value: number | null;
  onChange: (raw: number | null) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const sel = options.find((o) => o.raw === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline" role="combobox" size="sm" data-testid={testId}
          className={cn("h-8 w-full justify-between font-mono text-xs", !sel && "border-dashed text-muted-foreground")}
        >
          <span className="truncate">{sel ? `${sel.address} ${sel.name}` : "assign GA…"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search group address…" />
          <CommandList>
            <CommandEmpty>No group address.</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem value="__unassign__" onSelect={() => { onChange(null); setOpen(false); }} className="gap-2 text-muted-foreground">
                  <X className="size-3.5" />
                  <span>Unassign</span>
                </CommandItem>
              )}
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
