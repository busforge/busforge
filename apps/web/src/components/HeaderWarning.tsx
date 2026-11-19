import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { BadgeButton } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A standing warning, as a mark in the device page header next to the device's state or in the device
// list's toolbar: a short label and a count (the number of points unless given; null where the count is
// not known), the full title and the points in the popover it opens. A warning whose points need more than a line each gives them as
// `detail`, shown in place of the list.
export function HeaderWarning({ label, title, items = [], detail, count = items.length, testId }: { label: string; title: string; items?: ReactNode[]; detail?: ReactNode; count?: number | null; testId: string }) {
  if (items.length === 0 && detail === undefined) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BadgeButton tone="warning" title={title} data-testid={testId}>
          <AlertTriangle /> {label}
          {count !== null && <span className="font-mono opacity-80">{count}</span>}
        </BadgeButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[28rem] max-w-[calc(100vw-2rem)] space-y-2 overflow-y-auto text-xs" data-testid={`${testId}-detail`}>
        <p className="text-sm font-medium">{title}</p>
        {detail ?? (
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {items.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
