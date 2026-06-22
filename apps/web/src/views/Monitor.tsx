import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Trash2 } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { decodeDpt } from "@busforge/knx/dpt";
import { type GroupRangeNode, type Telegram } from "../api.ts";
import { useProject, useBusStatus, useTelegrams } from "../queries.ts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface GaInfo { name: string; dpt: string; }
function indexGas(ranges: GroupRangeNode[], into: Map<number, GaInfo>) {
  for (const r of ranges) {
    for (const g of r.addresses) into.set(g.raw, { name: g.name, dpt: g.dpt });
    indexGas(r.children, into);
  }
}

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

export function MonitorView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);
  const { data: bus } = useBusStatus(projectId);
  const status = bus?.status ?? "disconnected";
  const { data: history } = useTelegrams(projectId);

  const gaIndex = useMemo(() => { const m = new Map<number, GaInfo>(); if (project) indexGas(project.groupRanges, m); return m; }, [project]);
  // Source individual address -> device name, so the monitor reads
  // "<device> <kind> <group address name>" instead of bare addresses.
  const deviceIndex = useMemo(() => {
    const m = new Map<string, string>();
    if (project) for (const d of project.devices) if (d.name) m.set(d.ia, d.name);
    return m;
  }, [project]);
  const [rows, setRows] = useState<Telegram[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bottomRef = useRef<HTMLDivElement>(null);

  // Seed from the recorded history once it loads (and when switching projects);
  // live telegrams below append onto this.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (history && seededFor.current !== projectId) { setRows(history); seededFor.current = projectId; }
  }, [history, projectId]);

  // Stream live telegrams while connected.
  useEffect(() => {
    if (status !== "connected") return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/projects/${projectId}/bus/monitor`);
    ws.onmessage = (ev) => {
      if (pausedRef.current) return;
      setRows((prev) => [...prev.slice(-499), JSON.parse(ev.data) as Telegram]);
    };
    return () => ws.close();
  }, [projectId, status]);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows, paused]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {t("monitor.telegrams", { count: rows.length })} {paused && <span className="text-primary">· {t("monitor.paused")}</span>}
          {status !== "connected" && <span className="text-muted-foreground"> · {t("monitor.offline")}</span>}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)} data-testid="monitor-pause">
            {paused ? <><Play className="size-3.5" /> {t("monitor.resume")}</> : <><Pause className="size-3.5" /> {t("monitor.pause")}</>}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRows([])}><Trash2 className="size-3.5" /> {t("monitor.clear")}</Button>
        </div>
      </div>

      <Card className="overflow-hidden py-0">
        <div className="max-h-[65vh] overflow-y-auto">
          {/* Table on wide screens. */}
          <table className="hidden w-full border-collapse text-xs sm:table">
            <thead className="sticky top-0 z-10 bg-secondary/95 text-left font-sans uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium">{t("monitor.colTime")}</th>
                <th className="px-3 py-2 font-medium">{t("monitor.colSource")}</th>
                <th className="px-3 py-2 font-medium">{t("monitor.colKind")}</th>
                <th className="px-3 py-2 font-medium">{t("monitor.colDestination")}</th>
                <th className="px-3 py-2 font-medium">{t("monitor.colValue")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => {
                const ga = gaIndex.get(t.dstRaw);
                const srcName = deviceIndex.get(t.src);
                const value = decodeDpt(t.raw, ga?.dpt);
                return (
                  <tr key={i} className="border-t border-border/40 transition-colors hover:bg-secondary/40">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">{time(t.ts)}</td>
                    <td className="px-3 py-1.5">
                      <div className="max-w-48 truncate">{srcName ?? <span className="font-mono text-muted-foreground">{t.src}</span>}</div>
                      {srcName && <div className="font-mono text-[10px] text-muted-foreground">{t.src}</div>}
                    </td>
                    <td className="px-3 py-1.5"><KindChip kind={t.kind} /></td>
                    <td className="px-3 py-1.5">
                      <div className="max-w-56 truncate">{ga?.name || <span className="font-mono text-primary">{t.dst}</span>}</div>
                      {ga?.name && <div className="font-mono text-[10px] text-primary">{t.dst}</div>}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-foreground" title={`0x${t.raw}`}>{value}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Cards on mobile. */}
          <div className="divide-y divide-border/40 sm:hidden">
            {rows.map((t, i) => {
              const ga = gaIndex.get(t.dstRaw);
              const srcName = deviceIndex.get(t.src);
              const value = decodeDpt(t.raw, ga?.dpt);
              return (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm">{srcName ?? <span className="font-mono text-muted-foreground">{t.src}</span>}</span>
                      <KindChip kind={t.kind} />
                    </div>
                    <div className="truncate text-xs">{ga?.name || <span className="font-mono text-primary">{t.dst}</span>}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{time(t.ts)} · {t.src} → {t.dst}</div>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-foreground" title={`0x${t.raw}`}>{value}</span>
                </div>
              );
            })}
          </div>

          {rows.length === 0 && (
            <div className="px-3 py-10 text-center font-mono text-xs text-muted-foreground">
              {status === "connected" ? t("monitor.waiting") : t("monitor.emptyHistory")}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </Card>
    </div>
  );
}
