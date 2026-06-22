import { useTranslation } from "react-i18next";
import type { BusStatus } from "../api.ts";
import { cn } from "@/lib/utils";

// Connection status pill with a live dot. Amber pulse while connecting, green
// when connected, dim when off.
export function StatusBadge({ status }: { status: BusStatus }) {
  const { t } = useTranslation();
  const dot = status === "connected" ? "bg-ok" : status === "connecting" ? "bg-primary" : "bg-muted-foreground";
  const text = status === "connected" ? "text-ok" : status === "connecting" ? "text-primary" : "text-muted-foreground";
  return (
    <div className={cn("inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 font-mono text-xs uppercase tracking-wider", text)}>
      <span className="relative flex size-2">
        {status === "connecting" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />}
        <span className={cn("relative inline-flex size-2 rounded-full", dot)} />
      </span>
      {t(`status.${status}`)}
    </div>
  );
}
