import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Lock, Pause, Play, Send, Trash2 } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { type GroupRangeNode, type Telegram } from "../api.ts";
import { useProject, useBusStatus, useTelegrams, useSendGroup } from "../queries.ts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { GaLabel } from "@/components/GaLabel.tsx";
import { GaPill } from "@/components/GaPill.tsx";
import { cn } from "@/lib/utils";
import { telegramValue } from "@/lib/telegramValue.ts";
import { errMsg } from "@/lib/apiError";

interface GaInfo { name: string; dpt: string; address: string; }
function indexGas(ranges: GroupRangeNode[], into: Map<number, GaInfo>) {
  for (const r of ranges) {
    for (const g of r.addresses) into.set(g.raw, { name: g.name, dpt: g.dpt, address: g.address });
    indexGas(r.children, into);
  }
}

const kindStyle: Record<string, string> = {
  GroupValueWrite: "border-primary/40 bg-primary/10 text-primary",
  GroupValueRead: "border-border bg-secondary text-muted-foreground",
  GroupValueResponse: "border-ok/40 bg-ok/10 text-ok",
};
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour12: false }) + "." + String(ts % 1000).padStart(3, "0");

function KindChip({ telegram }: { telegram: Telegram }) {
  const { t } = useTranslation();
  const { kind, security } = telegram;
  return (
    <span className="inline-flex items-center gap-1">
      {security && <span title={t(`monitor.secure.${security}`)} data-testid="telegram-secured"><Lock className="size-3 text-muted-foreground" aria-label={t(`monitor.secure.${security}`)} /></span>}
      {/* A secured telegram that was not opened has no known service; the lock and the value column say why. */}
      {!(security && security !== "decrypted") && (
        <span className={cn("inline-flex rounded border px-1.5 py-0.5 text-[10px]", kindStyle[kind] ?? "border-border text-muted-foreground")}>
          {kind.replace("GroupValue", "")}
        </span>
      )}
    </span>
  );
}

function ValueText({ telegram, dpt, className }: { telegram: Telegram; dpt: string | undefined; className: string }) {
  const { t } = useTranslation();
  const shown = telegramValue(telegram, dpt);
  if ("secureState" in shown) return <span className={cn(className, "font-sans italic text-muted-foreground")}>{t(`monitor.secure.${shown.secureState}`)}</span>;
  return <span className={cn(className, "text-foreground")} title={`0x${telegram.raw}`}>{shown.value}</span>;
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
  const [newestFirst, setNewestFirst] = useState(true); // default: latest telegrams on top
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // `rows` is chronological (oldest first); flip for display when newest-first.
  const displayRows = useMemo(() => (newestFirst ? [...rows].reverse() : rows), [rows, newestFirst]);
  // Hoisted because `t` is shadowed by the telegram variable inside the row maps.
  const unknownLabel = t("common.unknown");

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
    if (paused) return;
    if (newestFirst) listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows, paused, newestFirst]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs text-muted-foreground">
          {t("monitor.telegrams", { count: rows.length })} {paused && <span className="text-primary">· {t("monitor.paused")}</span>}
          {status !== "connected" && <span className="text-muted-foreground"> · {t("monitor.offline")}</span>}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setNewestFirst((s) => !s)} title={t(newestFirst ? "monitor.newestFirst" : "monitor.oldestFirst")} data-testid="monitor-sort">
            <ArrowDownUp className="size-3.5" /> {t(newestFirst ? "monitor.newestFirst" : "monitor.oldestFirst")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)} data-testid="monitor-pause">
            {paused ? <><Play className="size-3.5" /> {t("monitor.resume")}</> : <><Pause className="size-3.5" /> {t("monitor.pause")}</>}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRows([])}><Trash2 className="size-3.5" /> {t("monitor.clear")}</Button>
        </div>
      </div>

      {status === "connected" && <SendPanel projectId={projectId} gas={gaIndex} />}

      <Card className="overflow-hidden py-0">
        <div ref={listRef} className="max-h-[65vh] overflow-y-auto">
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
              {displayRows.map((t, i) => {
                const ga = gaIndex.get(t.dstRaw);
                const srcName = deviceIndex.get(t.src);
                return (
                  <tr key={i} className="border-t border-border/40 transition-colors hover:bg-secondary/40">
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">{time(t.ts)}</td>
                    <td className="px-3 py-1.5"><DeviceLabel name={srcName} ia={t.src} fallback={unknownLabel} className="max-w-48" /></td>
                    <td className="px-3 py-1.5"><KindChip telegram={t} /></td>
                    <td className="px-3 py-1.5">{ga ? <GaPill projectId={projectId} raw={t.dstRaw} name={ga.name} address={t.dst} className="max-w-56" /> : <GaLabel address={t.dst} fallback={unknownLabel} className="max-w-56" />}</td>
                    <td className="px-3 py-1.5"><ValueText telegram={t} dpt={ga?.dpt} className="font-mono" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Cards on mobile. */}
          <div className="divide-y divide-border/40 sm:hidden">
            {displayRows.map((t, i) => {
              const ga = gaIndex.get(t.dstRaw);
              const srcName = deviceIndex.get(t.src);
              return (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <DeviceLabel name={srcName} ia={t.src} fallback={unknownLabel} className="text-sm" />
                      <KindChip telegram={t} />
                    </div>
                    {ga ? <GaPill projectId={projectId} raw={t.dstRaw} name={ga.name} address={t.dst} className="text-xs" /> : <GaLabel address={t.dst} fallback={unknownLabel} className="text-xs" />}
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{time(t.ts)} · {t.src} → {t.dst}</div>
                  </div>
                  <ValueText telegram={t} dpt={ga?.dpt} className="shrink-0 font-mono text-xs" />
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

// Send a GroupValueWrite or GroupValueRead over the monitor's connection. The value is raw hex (for a
// switch, 01 = on, 00 = off); a secured address is encrypted by the server, which refuses when this
// connection's address is not one of the address's senders. The telegram is handed to the interface;
// it appears in the table only through what the devices answer.
function SendPanel({ projectId, gas }: { projectId: string; gas: Map<number, GaInfo> }) {
  const { t } = useTranslation();
  const options = useMemo(() => [...gas.entries()].sort(([a], [b]) => a - b), [gas]);
  const [ga, setGa] = useState<number | null>(null);
  const [value, setValue] = useState("01");
  const send = useSendGroup(projectId);
  const target = ga ?? options[0]?.[0] ?? null;
  if (target === null) return null;
  const go = (service: "write" | "read") => send.mutate({ ga: target, service, value: service === "write" ? value.trim() : undefined });
  return (
    <Card className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid="monitor-send">
      <Send className="size-3.5 text-muted-foreground" />
      <select value={target} onChange={(e) => setGa(Number(e.target.value))} className="h-8 min-w-0 max-w-72 rounded-md border bg-background px-2 text-xs" aria-label={t("monitor.sendGa")} data-testid="monitor-send-ga">
        {options.map(([raw, g]) => <option key={raw} value={raw}>{g.address} {g.name}</option>)}
      </select>
      <input value={value} onChange={(e) => setValue(e.target.value)} className="h-8 w-24 rounded-md border bg-background px-2 font-mono text-xs" aria-label={t("monitor.sendValue")} placeholder="01" data-testid="monitor-send-value" />
      <Button size="sm" variant="outline" onClick={() => go("write")} disabled={send.isPending} data-testid="monitor-send-write">{t("monitor.sendWrite")}</Button>
      <Button size="sm" variant="outline" onClick={() => go("read")} disabled={send.isPending} data-testid="monitor-send-read">{t("monitor.sendRead")}</Button>
      {send.error && <span className="text-xs text-destructive" data-testid="monitor-send-error">{errMsg(t, send.error)}</span>}
      {send.data && !send.error && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="monitor-send-done">
          {send.data.secured && <Lock className="size-3" />} {t(send.data.secured ? "monitor.handedSecured" : "monitor.handed")}
        </span>
      )}
    </Card>
  );
}

