import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-border py-20 text-center text-sm text-muted-foreground">
      <Inbox className="mb-3 size-7 opacity-50" />
      {children}
    </div>
  );
}
