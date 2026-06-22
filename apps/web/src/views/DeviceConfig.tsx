import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Cpu, Download, Info, Loader2, Network, RotateCcw } from "lucide-react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CfgComObjView, CfgItem, CfgParamView, DeviceConfigView, GroupRangeNode } from "../api.ts";
import { qk, useProject, useDeviceConfig, useDeviceEdit } from "../queries.ts";
import { ChangePill, changeTotal } from "@/components/ChangePill.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FlashDialog } from "./FlashDialog.tsx";
import { GaCombobox, type GaOption } from "./GaCombobox.tsx";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { cn } from "@/lib/utils";

// Shared width of the right-hand control column, so parameter inputs and the
// group-address picker line up and none of them get cut off.
const CONTROL_W = "w-full sm:w-72";

function flattenGas(ranges: GroupRangeNode[], out: GaOption[]) {
  for (const r of ranges) { for (const g of r.addresses) out.push({ raw: g.raw, address: g.address, name: g.name }); flattenGas(r.children, out); }
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

// Small amber dot marking a row whose value differs from the programmed state.
function ChangedDot({ title }: { title: string }) {
  return <span className="size-1.5 shrink-0 rounded-full bg-primary" title={title} />;
}

// Per-row revert: discard one row's drift back to the device/baseline value.
function RevertButton({ title, disabled, onClick }: { title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" title={title} disabled={disabled} onClick={onClick}>
      <RotateCcw className="size-3.5" />
    </Button>
  );
}

// Count the rows currently flagged as drifting from the device, for the read-back toast.
function countChanged(view: DeviceConfigView): number {
  let n = 0;
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind === "param") { if (it.param.changed) n++; }
    else if (it.kind === "comObject") { if (it.comObject.changed) n++; }
  }
  return n;
}

const flagWords = (f: CfgComObjView["flags"], t: TFn) =>
  [f.comm && t("device.flagCommunication"), f.read && t("device.flagRead"), f.write && t("device.flagWrite"), f.transmit && t("device.flagTransmit"), f.update && t("device.flagUpdate")]
    .filter(Boolean).join(", ");

const comObjLabel = (c: CfgComObjView) => c.functionText || c.name;
const norm = (s?: string) => (s ?? "").toLowerCase();
// Whether an item matches the carried search term (mirrors the device-list deep
// search: param name/value and com-object function/name).
function itemMatches(item: CfgItem, q: string): boolean {
  if (!q) return false;
  if (item.kind === "param") return norm(item.param.name).includes(q) || norm(item.param.value).includes(q);
  if (item.kind === "comObject") return norm(comObjLabel(item.comObject)).includes(q) || norm(item.comObject.name).includes(q);
  return false;
}

export function DeviceConfig() {
  const { t } = useTranslation();
  const { projectId, deviceId } = useParams({ from: "/projects/$projectId/devices/$deviceId" });
  const search = useSearch({ from: "/projects/$projectId/devices/$deviceId" });
  const q = (search.q ?? "").toLowerCase();
  const qc = useQueryClient();
  const { data: project } = useProject(projectId);
  const device = project?.devices.find((d) => d.id === deviceId);
  const gaOptions = useMemo(() => { const o: GaOption[] = []; if (project) flattenGas(project.groupRanges, o); return o; }, [project]);

  const { data: view, isLoading, error } = useDeviceConfig(projectId, deviceId);
  const { setParam, setLink, revert, revertParam, revertLink, readBack } = useDeviceEdit(projectId, deviceId);
  const saving = setParam.isPending || setLink.isPending || revert.isPending || revertParam.isPending || revertLink.isPending;
  const [flashOpen, setFlashOpen] = useState(false);
  const [flashGaOpen, setFlashGaOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const hasChanges = changeTotal(device?.changes) > 0;

  const onError = (e: unknown) => toast.error(t("device.saveError"), { description: (e as Error).message });
  const relink = (comObjRefId: string, gaRaw: number | null) =>
    setLink.mutate({ comObjRefId, gaRaws: gaRaw == null ? [] : [gaRaw] }, { onError });
  const doRevert = () =>
    revert.mutate(undefined, {
      onSuccess: () => { setRevertOpen(false); toast.success(t("device.reverted")); },
      onError: (e) => { setRevertOpen(false); onError(e); },
    });
  const doReadBack = () =>
    readBack.mutate(undefined, {
      onSuccess: (v) => { const n = countChanged(v); toast.success(n ? t("device.readDrift", { count: n }) : t("device.readNoDrift")); },
      onError: (e) => toast.error(t("device.readError"), { description: (e as Error).message }),
    });
  const afterFlash = () => {
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
    qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] });
  };

  // Section table-of-contents: scroll to a card and track the active one.
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeSec, setActiveSec] = useState<string | null>(null);
  const scrollToSec = (id: string) => cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  useEffect(() => {
    if (!view) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActiveSec(top.target.id);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    cardRefs.current.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [view]);

  // Jump to the first row matching the carried search term.
  useEffect(() => {
    if (!q || !view) return;
    const el = containerRef.current?.querySelector('[data-match="true"]');
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [q, view]);

  const actionBtn = (key: string, icon: ReactNode, onClick: () => void, opts?: { ghost?: boolean; disabled?: boolean; testId?: string }) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={opts?.ghost ? "ghost" : "outline"} size="icon"
          className={cn("size-9", opts?.ghost && "text-muted-foreground")}
          disabled={opts?.disabled} onClick={onClick} aria-label={t(key)} data-testid={opts?.testId}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t(key)}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon" aria-label={t("device.back")} className="shrink-0 text-muted-foreground">
            <Link to="/projects/$projectId/devices" params={{ projectId }} search={{ q: search.q, changed: search.changed }}><ChevronLeft className="size-5" /></Link>
          </Button>
          <div className="flex min-w-0 items-center gap-2 font-semibold leading-tight">
            <DeviceLabel name={device?.name} ia={device?.ia ?? ""} />
            <ChangePill changes={device?.changes} />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {actionBtn("device.revert", <RotateCcw className="size-4" />, () => setRevertOpen(true), { ghost: true, disabled: !hasChanges || saving, testId: "revert-device" })}
          {actionBtn("device.readFromDevice", readBack.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />, doReadBack, { disabled: readBack.isPending || saving, testId: "read-back" })}
          {actionBtn("device.programGAs", <Network className="size-4" />, () => setFlashGaOpen(true), { testId: "program-ga" })}
          {actionBtn("device.programDevice", <Cpu className="size-4" />, () => setFlashOpen(true), { testId: "program-device" })}
        </div>
      </div>

      {device && <FlashDialog open={flashOpen} onOpenChange={setFlashOpen} projectId={projectId} device={device} target="params" onFlashed={afterFlash} />}
      {device && <FlashDialog open={flashGaOpen} onOpenChange={setFlashGaOpen} projectId={projectId} device={device} target="ga" onFlashed={afterFlash} />}

      <AlertDialog open={revertOpen} onOpenChange={setRevertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("device.revertTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("device.revertBody", { ia: device?.ia })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revert.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); doRevert(); }} disabled={revert.isPending} data-testid="confirm-revert">
              {revert.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} {t("device.revert")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isLoading && <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("device.loadingConfig")}</div>}
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{(error as Error).message}</p>}
      {view && !isLoading && view.blocks.length === 0 && !error && (
        <Card><CardContent className="text-sm text-muted-foreground">
          {t("device.noParams")}
        </CardContent></Card>
      )}

      {view && view.blocks.length > 0 && (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {view.blocks.length > 1 && (
            <nav className="lg:sticky lg:top-16 lg:w-56 lg:shrink-0">
              <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
                {view.blocks.map((block) => {
                  const id = `sec-${block.id}`;
                  return (
                    <li key={block.id}>
                      <button
                        type="button" onClick={() => scrollToSec(id)}
                        className={cn(
                          "w-full whitespace-nowrap rounded px-2 py-1 text-left text-sm transition-colors lg:truncate",
                          activeSec === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                        )}
                      >
                        {block.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}

          <div ref={containerRef} className="min-w-0 flex-1 space-y-4">
            {view.blocks.map((block) => (
              <Card key={block.id} id={`sec-${block.id}`} ref={(el) => { if (el) cardRefs.current.set(`sec-${block.id}`, el); }} className="scroll-mt-20">
                <CardContent className="space-y-0.5 py-4">
                  <h3 className="mb-3 border-b border-border/60 pb-2 text-base font-semibold text-foreground">{block.name}</h3>
                  {block.items.map((item, i) => {
                    if (item.kind === "separator") {
                      if (item.uiHint === "HorizontalRuler") return <Separator key={i} className="my-2" />;
                      if (!item.text) return null;
                      if (item.uiHint === "Error") return <p key={i} className="py-1 text-xs text-destructive">{item.text}</p>;
                      // Any other text separator is a section heading in ETS.
                      return <div key={i} className="mt-4 mb-1 border-b border-border/40 pb-1 text-sm font-semibold text-foreground first:mt-0">{item.text}</div>;
                    }
                    if (item.kind === "comObject") {
                      const co = item.comObject;
                      const flags = flagWords(co.flags, t);
                      const dpt = co.dpt || co.objectSize || t("device.unknownDpt");
                      const info = flags
                        ? t("device.objectInfoFlags", { number: co.number, dpt, flags })
                        : t("device.objectInfo", { number: co.number, dpt });
                      const hl = itemMatches(item, q);
                      return (
                        <div
                          key={i} data-match={hl || undefined}
                          className={cn(
                            "flex flex-col gap-1 border-l-2 py-1.5 pl-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4",
                            co.changed ? "border-primary bg-primary/5" : "border-transparent",
                            hl && "rounded-md bg-ok/10 ring-1 ring-ok/50",
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2 sm:flex-1">
                            {co.changed ? <ChangedDot title={t("device.changedDot")} /> : null}
                            <span className="min-w-0">{comObjLabel(co)}</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button type="button" aria-label={info} className="shrink-0 text-muted-foreground"><Info className="size-3.5" /></button>
                              </TooltipTrigger>
                              <TooltipContent className="whitespace-pre-line">{info}</TooltipContent>
                            </Tooltip>
                          </span>
                          <div className="flex shrink-0 items-center gap-2">
                            {co.changed && <RevertButton title={t("device.revertRow")} disabled={saving} onClick={() => revertLink.mutate(co.refId, { onError })} />}
                            <div className={cn("shrink-0", CONTROL_W)}><GaCombobox options={gaOptions} value={co.gaRaw ?? null} onChange={(raw) => relink(co.refId, raw)} testId={`link-${co.number}`} /></div>
                          </div>
                        </div>
                      );
                    }
                    return (
                      <ParamRow
                        key={i} param={item.param} changedTitle={t("device.changedDot")} revertTitle={t("device.revertRow")} reverting={saving}
                        highlight={itemMatches(item, q)}
                        onChange={(v) => setParam.mutate({ refId: item.param.refId, value: v }, { onError })}
                        onRevert={() => revertParam.mutate(item.param.refId, { onError })}
                      />
                    );
                  })}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ParamRow({ param, changedTitle, revertTitle, reverting, highlight, onChange, onRevert }: { param: CfgParamView; changedTitle: string; revertTitle: string; reverting?: boolean; highlight: boolean; onChange: (value: string) => void; onRevert: () => void }) {
  const [local, setLocal] = useState(param.value);
  useEffect(() => setLocal(param.value), [param.value]);

  // Read-only params are informational displays (e.g. "Info: ..."); render them
  // as plain text instead of disabled form controls, which read as broken.
  const readOnlyText = param.control === "enum"
    ? (param.options?.find((o) => String(o.value) === param.value)?.text ?? param.value)
    : param.value;

  return (
    <div
      data-match={highlight || undefined}
      className={cn(
        "flex flex-col gap-1 border-l-2 py-1.5 pl-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        param.changed ? "border-primary bg-primary/5" : "border-transparent",
        highlight && "rounded-md bg-ok/10 ring-1 ring-ok/50",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm sm:flex-1">
        {param.changed ? <ChangedDot title={changedTitle} /> : null}
        <span className="min-w-0">{param.name}</span>
      </span>
      {param.changed && <RevertButton title={revertTitle} disabled={reverting} onClick={onRevert} />}
      <div className={cn("flex shrink-0 items-center gap-2", CONTROL_W)}>
        {param.readOnly ? (
          <span className="w-full text-sm text-muted-foreground" data-testid={`param-${param.refId}`}>{readOnlyText}</span>
        ) : param.control === "enum" ? (
          <Select value={param.value} onValueChange={onChange}>
            <SelectTrigger className="w-full" data-testid={`param-${param.refId}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {param.options?.map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.text}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : param.control === "number" ? (
          <Input
            type="number" value={local} min={param.min} max={param.max}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={() => local !== param.value && onChange(local)}
            className="w-full font-mono" data-testid={`param-${param.refId}`}
          />
        ) : param.control === "text" ? (
          <Input className="w-full" value={local} onChange={(e) => setLocal(e.target.value)} onBlur={() => local !== param.value && onChange(local)} data-testid={`param-${param.refId}`} />
        ) : (
          <span className="font-mono text-xs text-muted-foreground">{param.value}</span>
        )}
        {param.suffix && <span className="shrink-0 text-xs text-muted-foreground">{param.suffix}</span>}
      </div>
    </div>
  );
}
