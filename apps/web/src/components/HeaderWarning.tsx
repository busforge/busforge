import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { BadgeButton } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A standing warning about the device page, as a mark in the header's second row: a short label and
// a count (the number of points unless given; null where the count is not known), the full title and
// the points in the popover it opens.
export function HeaderWarning({ label, title, items, count = items.length, testId }: { label: string; title: string; items: ReactNode[]; count?: number | null; testId: string }) {
  if (items.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BadgeButton tone="warning" title={title} data-testid={testId}>
          <AlertTriangle /> {label}
          {count !== null && <span className="font-mono opacity-80">{count}</span>}
        </BadgeButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[28rem] max-w-[calc(100vw-2rem)] space-y-2 text-xs" data-testid={`${testId}-detail`}>
        <p className="text-sm font-medium">{title}</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {items.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
