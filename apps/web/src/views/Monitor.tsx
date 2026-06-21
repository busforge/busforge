import { useEffect, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import type { BusStatus, Telegram } from "../api.ts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { EmptyState } from "./Empty.tsx";

const kindStyle: Record<string, string> = {
  GroupValueWrite: "border-primary/40 bg-primary/10 text-primary",
  GroupValueRead: "border-border bg-secondary text-muted-foreground",
  GroupValueResponse: "border-ok/40 bg-ok/10 text-ok",
};
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour12: false }) + "." + String(ts % 1000).padStart(3, "0");

function KindChip({ kind }: { kind: string }) {
  return (
    <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[10px]", kindStyle[kind] ?? "border-border text-muted-foreground")}>
      {kind.replace("GroupValue", "")}
    </span>
  );
}

export function MonitorView({ status }: { status: BusStatus }) {
  const [rows, setRows] = useState<Telegram[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== "connected") return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/bus/monitor`);
    ws.onmessage = (ev) => {
      if (pausedRef.current) return;
      const t = JSON.parse(ev.data) as Telegram;
      setRows((prev) => [...prev.slice(-499), t]);
    };
    return () => ws.close();
  }, [status]);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows, paused]);

  if (status !== "connected") return <EmptyState>Connect to the bus in Settings to watch live telegrams.</EmptyState>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {rows.length} telegrams {paused && <span className="text-primary">· paused</span>}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)} data-testid="monitor-pause">
            {paused ? <><Play className="size-3.5" /> Resume</> : <><Pause className="size-3.5" /> Pause</>}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRows([])}><Trash2 className="size-3.5" /> Clear</Button>
        </div>
      </div>

      <Card className="overflow-hidden py-0">
        <div className="max-h-[65vh] overflow-y-auto">
          {/* Table on wide screens. */}
          <table className="hidden w-full border-collapse text-xs sm:table">
            <thead className="sticky top-0 z-10 bg-secondary/95 text-left font-sans uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Dest</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((t, i) => (
                <tr key={i} className="border-t border-border/40 transition-colors hover:bg-secondary/40">
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{time(t.ts)}</td>
                  <td className="px-3 py-1.5">{t.src}</td>
                  <td className="px-3 py-1.5 text-primary">{t.dst}</td>
                  <td className="px-3 py-1.5"><KindChip kind={t.kind} /></td>
                  <td className="px-3 py-1.5 text-foreground">0x{t.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Cards on mobile. */}
          <div className="divide-y divide-border/40 sm:hidden">
            {rows.map((t, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-primary">{t.dst}</span>
                    <KindChip kind={t.kind} />
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{time(t.ts)} · from {t.src}</div>
                </div>
                <span className="shrink-0 font-mono text-xs text-foreground">0x{t.raw}</span>
              </div>
            ))}
          </div>

          {rows.length === 0 && (
            <div className="px-3 py-8 text-center font-mono text-xs text-muted-foreground">Waiting for bus traffic…</div>
          )}
          <div ref={bottomRef} />
        </div>
      </Card>
    </div>
  );
}
