import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, Cpu, Download, Info, Loader2, Puzzle, RotateCcw, Search, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CfgBlock, CfgComObjView, CfgItem, CfgParamView, DeviceConfigView, GroupRangeNode } from "../api.ts";
import { qk, useProject, useDeviceConfig, useDeviceEdit } from "../queries.ts";
import { isSecondsUnit, formatDuration, parseDuration, isValidIPv4 } from "@/lib/paramFormat.ts";
import { ChangePill, changeTotal } from "@/components/ChangePill.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FlashDialog, type FlashTarget } from "./FlashDialog.tsx";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GaCombobox, type GaOption } from "./GaCombobox.tsx";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { DcaModuleDialog } from "../dca/DcaModuleDialog.tsx";
import { cn } from "@/lib/utils";
import { errMsg } from "../lib/apiError.ts";

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

// How many com-objects that held a group address before a parameter edit are no
// longer visible after it. Their links are preserved server-side and return on
// revert, so when this is non-zero we reassure the user instead of letting the
// rows look deleted (ETS, by contrast, drops the assignment outright).
function hiddenAssignedCount(before: DeviceConfigView, after: DeviceConfigView): number {
  const nowVisible = new Set<string>();
  for (const b of after.blocks) for (const it of b.items)
    if (it.kind === "comObject") nowVisible.add(it.comObject.refId);
  let n = 0;
  for (const b of before.blocks) for (const it of b.items)
    if (it.kind === "comObject" && it.comObject.gaRaw != null && !nowVisible.has(it.comObject.refId)) n++;
  return n;
}

const flagWords = (f: CfgComObjView["flags"], t: TFn) =>
  [f.comm && t("device.flagCommunication"), f.read && t("device.flagRead"), f.write && t("device.flagWrite"), f.transmit && t("device.flagTransmit"), f.update && t("device.flagUpdate"), f.readOnInit && t("device.flagReadOnInit")]
    .filter(Boolean).join(", ");

const comObjLabel = (c: CfgComObjView) => c.functionText || c.name;
const isItemChanged = (it: CfgItem) => (it.kind === "param" && !!it.param.changed) || (it.kind === "comObject" && !!it.comObject.changed);
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
  const navigate = useNavigate({ from: "/projects/$projectId/devices/$deviceId" });
  const qRaw = search.q ?? "";
  const q = qRaw.toLowerCase();
  const setQ = (val: string) => navigate({ search: (p) => ({ ...p, q: val || undefined }), replace: true });
  const qc = useQueryClient();
  const { data: project } = useProject(projectId);
  const device = project?.devices.find((d) => d.id === deviceId);
  const gaOptions = useMemo(() => { const o: GaOption[] = []; if (project) flattenGas(project.groupRanges, o); return o; }, [project]);

  const { data: view, isLoading, error } = useDeviceConfig(projectId, deviceId);
  const { setParam, setLink, revert, revertParam, revertLink, readBack } = useDeviceEdit(projectId, deviceId);
  const saving = setParam.isPending || setLink.isPending || revert.isPending || revertParam.isPending || revertLink.isPending;
  // Which targets the flash dialog is open for (null = closed). One "Flashen" button
  // programs whatever applies (config and/or group addresses); the split dropdown narrows
  // it to a single target, and only appears when both targets apply to this device.
  const [flashTargets, setFlashTargets] = useState<FlashTarget[] | null>(null);
  const [revertOpen, setRevertOpen] = useState(false);
  const hasChanges = changeTotal(device?.changes) > 0;
  const hasParams = !!view?.blocks.some((b) => b.items.some((i) => i.kind === "param"));
  const hasComObjects = !!view?.blocks.some((b) => b.items.some((i) => i.kind === "comObject"));
  const flashTargetsAvail: FlashTarget[] = [...(hasParams ? ["params" as const] : []), ...(hasComObjects ? ["ga" as const] : [])];

  const onError = (e: unknown) => toast.error(t("device.saveError"), { description: errMsg(t, e) });
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
      onError: (e) => toast.error(t("device.readError"), { description: errMsg(t, e) }),
    });
  const afterFlash = () => {
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
    qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] });
    qc.invalidateQueries({ queryKey: qk.snapshots(projectId) }); // a real flash captures an auto restore point
  };

  // Section index. Only top-level group headers are tracked/scroll targets (one
  // per channel/area), so the index stays short and the scroll-spy reliable even
  // on devices with hundreds of rows.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeSec, setActiveSec] = useState<string | null>(null);
  const scrollToSec = (id: string) => cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Fold the flat block list into top-level groups: a level-0 block heads a
  // group, the sub-blocks that follow (level >= 1) become its sub-sections. This
  // mirrors the ETS tree (channel -> Settings/Heating/...).
  const groups = useMemo(() => {
    const gs: { head: CfgBlock; children: CfgBlock[] }[] = [];
    for (const b of view?.blocks ?? []) {
      if (b.level === 0 || gs.length === 0) gs.push({ head: b, children: [] });
      else gs[gs.length - 1].children.push(b);
    }
    return gs;
  }, [view]);

  const groupChanged = (g: { head: CfgBlock; children: CfgBlock[] }) =>
    g.head.items.some(isItemChanged) || g.children.some((c) => c.items.some(isItemChanged));

  // Filter the config by the search term: a matching section header (group or
  // sub-block name) reveals everything under it; otherwise only the matching
  // rows (param name/value, com-object label) are kept. The group header always
  // renders as context when any of its children survive.
  const filteredGroups = useMemo(() => {
    if (!q) return groups;
    const keep = (items: CfgItem[]) => items.filter((it) => itemMatches(it, q));
    const out: { head: CfgBlock; children: CfgBlock[] }[] = [];
    for (const g of groups) {
      const headMatch = norm(g.head.name).includes(q);
      const headItems = headMatch ? g.head.items : keep(g.head.items);
      const children: CfgBlock[] = [];
      // Stage a dropped level-1 block so a surviving deeper child can still show
      // its parent heading as context (kept with no items).
      let pendingParent: CfgBlock | null = null;
      for (const c of g.children) {
        const cMatch = headMatch || norm(c.name).includes(q);
        const items = cMatch ? c.items : keep(c.items);
        const kept = cMatch || items.length > 0;
        if (c.level === 1) {
          if (kept) { children.push({ ...c, items }); pendingParent = null; }
          else pendingParent = c;
        } else if (kept) {
          if (pendingParent) { children.push({ ...pendingParent, items: [] }); pendingParent = null; }
          children.push({ ...c, items });
        }
      }
      if (headMatch || headItems.length > 0 || children.length > 0)
        out.push({ head: { ...g.head, items: headItems }, children });
    }
    return out;
  }, [groups, q]);

  // Cmd/Ctrl+F focuses the config search instead of the browser find.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // What this device uses that busforge does not fully support yet, aggregated
  // for the notice at the top so the gaps are explicit, not hidden in the list.
  const gaps = useMemo(() => {
    const types = new Map<string, number>();
    const elements = new Map<string, number>();
    for (const b of view?.blocks ?? []) for (const it of b.items) {
      if (it.kind === "param" && it.param.control === "unsupported") types.set(it.param.typeLabel ?? "?", (types.get(it.param.typeLabel ?? "?") ?? 0) + 1);
      else if (it.kind === "unsupported") elements.set(it.label, (elements.get(it.label) ?? 0) + 1);
    }
    return { types: [...types.entries()], elements: [...elements.entries()] };
  }, [view]);

  // Scroll-spy: the active group is the last whose header sits above a small top
  // offset. Deterministic (always exactly one), so no flicker between sections.
  useEffect(() => {
    if (!view) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      let active: string | null = null;
      let bestTop = -Infinity;
      cardRefs.current.forEach((el, id) => {
        const top = el.getBoundingClientRect().top;
        if (top <= 96 && top > bestTop) { bestTop = top; active = id; }
      });
      if (!active && filteredGroups[0]) active = `sec-${filteredGroups[0].head.id}`;
      setActiveSec(active);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [view, filteredGroups]);

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

  const registerRef = (id: string) => (el: HTMLElement | null) => { if (el) cardRefs.current.set(id, el); else cardRefs.current.delete(id); };

  const renderItem = (item: CfgItem, key: string | number) => {
    if (item.kind === "separator") {
      if (item.uiHint === "HorizontalRuler") return <Separator key={key} className="my-2" />;
      if (!item.text) return null;
      if (item.uiHint === "Error") return <p key={key} className="py-1 text-xs text-destructive">{item.text}</p>;
      // Any other text separator is a section heading in ETS.
      return <div key={key} className="mt-4 mb-1 border-b border-border/40 pb-1 text-sm font-semibold text-foreground first:mt-0">{item.text}</div>;
    }
    if (item.kind === "comObject") {
      const co = item.comObject;
      const flags = flagWords(co.flags, t);
      const dpt = co.dpt || co.objectSize || t("device.unknownDpt");
      const info = flags
        ? t("device.objectInfoFlags", { number: co.number, dpt, flags })
        : t("device.objectInfo", { number: co.number, dpt });
      return (
        <div
          key={key}
          className={cn(
            "flex flex-col gap-1 border-l-2 py-1.5 pl-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4",
            co.changed ? "border-primary bg-primary/5" : "border-transparent",
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
    if (item.kind === "unsupported") {
      return (
        <div key={key} className="my-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{t("device.unsupportedElement", { tag: item.label })}</span>
        </div>
      );
    }
    return (
      <ParamRow
        key={key} param={item.param} changedTitle={t("device.changedDot")} revertTitle={t("device.revertRow")} reverting={saving}
        onChange={(v) => {
          const before = view;
          setParam.mutate({ refId: item.param.refId, value: v }, {
            onError,
            onSuccess: (next) => {
              const n = before ? hiddenAssignedCount(before, next) : 0;
              if (n > 0) toast.info(t("device.gaHidden", { count: n }), { description: t("device.gaHiddenHint") });
            },
          });
        }}
        onRevert={() => revertParam.mutate(item.param.refId, { onError })}
      />
    );
  };

  // The section index mirrors the (filtered) tree shown on the right, so it stays
  // useful while searching; show it whenever there is more than one place to jump.
  const navCount = filteredGroups.reduce((n, g) => n + 1 + g.children.filter((c) => c.level === 1).length, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon" aria-label={t("device.back")} className="shrink-0 text-muted-foreground">
            <Link to="/projects/$projectId/devices" params={{ projectId }} search={{ q: search.q, changed: search.changed }}><ChevronLeft className="size-5" /></Link>
          </Button>
          <div className="flex min-w-0 items-center gap-2 font-semibold leading-tight">
            <DeviceLabel name={device?.name} ia={device?.ia ?? ""} />
            <ChangePill changes={device?.changes} />
          </div>
        </div>
        {view && view.blocks.length > 0 && (
          <div className="relative w-full sm:max-w-xs sm:flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchRef} placeholder={t("device.searchPlaceholder")} value={qRaw} onChange={(e) => setQ(e.target.value)} className="px-9" data-testid="config-search" />
            {qRaw && (
              <button
                type="button" aria-label={t("device.clearSearch")} onClick={() => setQ("")} data-testid="config-search-clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 sm:shrink-0">
          {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {actionBtn("device.revert", <RotateCcw className="size-4" />, () => setRevertOpen(true), { ghost: true, disabled: !hasChanges || saving, testId: "revert-device" })}
          {actionBtn("device.readFromDevice", readBack.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />, doReadBack, { disabled: readBack.isPending || saving, testId: "read-back" })}
          {flashTargetsAvail.length > 0 && (
            <div className="flex">
              <Button
                onClick={() => setFlashTargets(flashTargetsAvail)} data-testid="program-device"
                className={cn("gap-1.5", flashTargetsAvail.length > 1 && "rounded-r-none")}
              >
                <Cpu className="size-4" /> {t("device.flash")}
              </Button>
              {flashTargetsAvail.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button className="rounded-l-none border-l border-primary-foreground/20 px-1.5" aria-label={t("device.flashChoose")} data-testid="flash-menu">
                      <ChevronDown className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setFlashTargets(["params"])} data-testid="flash-only-params">{t("device.flashOnlyParams")}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setFlashTargets(["ga"])} data-testid="flash-only-ga">{t("device.flashOnlyGAs")}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>
      </div>

      {device && flashTargets && (
        <FlashDialog
          open onOpenChange={(o) => { if (!o) setFlashTargets(null); }}
          projectId={projectId} device={device} targets={flashTargets} onFlashed={afterFlash}
        />
      )}

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

      {view?.dca && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-700 dark:text-sky-300" data-testid="dca-notice">
          <Puzzle className="size-4 shrink-0" />
          <span className="font-medium">{view.dca.module ? view.dca.module.category : t("device.dcaTitle")}</span>
          {view.dca.module && (
            <span className="text-xs text-sky-700/70 dark:text-sky-300/70">
              {view.dca.module.displayName} · {t("dca.version", { version: view.dca.module.deviceVersion })}
            </span>
          )}
          {view.dca.module && (
            <span className="ml-auto"><DcaModuleDialog projectId={projectId} deviceId={deviceId} module={view.dca.module} /></span>
          )}
        </div>
      )}

      {(gaps.types.length > 0 || gaps.elements.length > 0) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">{t("device.gapsTitle")}</p>
            <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-amber-700/90 dark:text-amber-300/90">
              {gaps.types.map(([label, n]) => <li key={`t-${label}`}>{t("device.gapType", { type: label, count: n })}</li>)}
              {gaps.elements.map(([label, n]) => <li key={`e-${label}`}>{t("device.gapElement", { tag: label, count: n })}</li>)}
            </ul>
          </div>
        </div>
      )}

      {isLoading && <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("device.loadingConfig")}</div>}
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{errMsg(t, error)}</p>}
      {view && !isLoading && view.blocks.length === 0 && !error && (
        <Card><CardContent className="text-sm text-muted-foreground">
          {t("device.noParams")}
        </CardContent></Card>
      )}

      {view && view.blocks.length > 0 && (
        <div className="space-y-4">
          {filteredGroups.length === 0 ? (
            <Card><CardContent className="py-4 text-sm text-muted-foreground">{t("device.searchEmpty")}</CardContent></Card>
          ) : (
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {navCount > 1 && (
            <nav className="lg:sticky lg:top-28 lg:max-h-[calc(100vh-8rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto">
              <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-x-visible lg:pb-0">
                {filteredGroups.map((g) => {
                  // Sidebar shows the group head plus its direct (level-1) blocks;
                  // deeper sub-blocks are reached by scrolling. Active = neutral
                  // fill + left bar; the amber dot is reserved for "has changes".
                  const navBtn = (id: string, label: string, sub: boolean, changed: boolean) => {
                    const active = activeSec === id;
                    return (
                      <button
                        key={id} type="button" onClick={() => scrollToSec(id)}
                        className={cn(
                          "flex w-full items-center gap-2 whitespace-nowrap rounded border-l-2 py-1 pr-2 text-left text-sm transition-colors lg:truncate",
                          sub ? "pl-5" : "pl-2",
                          active ? "border-foreground/50 bg-secondary font-medium text-foreground"
                            : sub ? "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                            : "border-transparent font-medium text-foreground/80 hover:bg-secondary/60 hover:text-foreground",
                        )}
                      >
                        <span className="truncate">{label}</span>
                        {changed && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" title={t("device.changedDot")} />}
                      </button>
                    );
                  };
                  return (
                    <li key={g.head.id} className="lg:contents">
                      {navBtn(`sec-${g.head.id}`, g.head.name, false, groupChanged(g))}
                      {g.children.filter((c) => c.level === 1).map((c) =>
                        navBtn(`sec-${c.id}`, c.name, true, c.items.some(isItemChanged)))}
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}

          <div ref={containerRef} className="min-w-0 flex-1 space-y-6">
            {filteredGroups.map((g) => (
              // Section heading sits ABOVE the card so each channel/group start is clear.
              <section key={g.head.id} className="space-y-2">
                <h2 id={`sec-${g.head.id}`} ref={registerRef(`sec-${g.head.id}`)} className="flex scroll-mt-20 items-center gap-2 px-1 text-lg font-semibold text-foreground">
                  <span className="min-w-0 truncate">{g.head.name}</span>
                  {groupChanged(g) && <span className="size-2 shrink-0 rounded-full bg-primary" title={t("device.changedDot")} />}
                </h2>
                <Card>
                  <CardContent className="space-y-0.5 py-4">
                  {g.head.items.length === 0 && g.children.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t("device.emptySection")}</p>
                  )}
                  {g.head.items.map((item: CfgItem, i: number) => renderItem(item, i))}
                  {g.children.map((child: CfgBlock) => {
                    const deep = child.level >= 2; // sub-block of a sub-section: indent further, lighter heading
                    return (
                      <section
                        key={child.id} id={`sec-${child.id}`}
                        ref={child.level === 1 ? registerRef(`sec-${child.id}`) : undefined}
                        className={cn("scroll-mt-20 pt-3", deep && "pl-3")}
                      >
                        <h4 className={cn("mt-2 mb-2 flex items-center gap-2 border-l-2 pl-2 text-sm font-semibold",
                          deep ? "border-foreground/15 text-muted-foreground" : "border-foreground/30 text-foreground")}>
                          <span className="min-w-0 truncate">{child.name}</span>
                          {child.items.some(isItemChanged) && <span className="size-1.5 shrink-0 rounded-full bg-primary" title={t("device.changedDot")} />}
                        </h4>
                        {child.items.map((item: CfgItem, i: number) => renderItem(item, `${child.id}-${i}`))}
                      </section>
                    );
                  })}
                  </CardContent>
                </Card>
              </section>
            ))}
          </div>
          </div>
          )}
        </div>
      )}
    </div>
  );
}

function ParamRow({ param, changedTitle, revertTitle, reverting, onChange, onRevert }: { param: CfgParamView; changedTitle: string; revertTitle: string; reverting?: boolean; onChange: (value: string) => void; onRevert: () => void }) {
  const { t } = useTranslation();
  // For a seconds-based TypeTime the input holds the hh:mm:ss text; for every other
  // control `local` is the raw value string.
  const isDuration = param.control === "time" && isSecondsUnit(param.unit);
  const [local, setLocal] = useState(() => (isDuration ? formatDuration(Number(param.value) || 0) : param.value));
  useEffect(() => setLocal(isDuration ? formatDuration(Number(param.value) || 0) : param.value), [param.value, isDuration]);

  // Read-only params are informational displays (e.g. "Info: ..."); render them
  // as plain text instead of disabled form controls, which read as broken.
  const readOnlyText = param.control === "enum"
    ? (param.options?.find((o) => String(o.value) === param.value)?.text ?? param.value)
    : isDuration
    ? formatDuration(Number(param.value) || 0)
    : param.value;

  // Commit a typed number: the native input does not enforce min/max on typed
  // input, so clamp to the range and snap to the ETS step grid (anchored at min)
  // before persisting. Empty/non-numeric input reverts to the current value.
  const commitNumber = () => {
    const raw = local.trim();
    if (raw === "" || Number.isNaN(Number(raw))) { setLocal(param.value); return; }
    let n = Number(raw);
    const base = param.min ?? 0;
    if (param.step && param.step > 1) n = base + Math.round((n - base) / param.step) * param.step;
    if (param.min !== undefined) n = Math.max(param.min, n);
    if (param.max !== undefined) n = Math.min(param.max, n);
    const s = String(n);
    setLocal(s);
    if (s !== param.value) onChange(s);
  };

  // Commit an hh:mm:ss duration: parse to seconds, clamp to the raw min/max, store the
  // raw integer. Invalid input reverts the field to the current value.
  const commitDuration = () => {
    const secs = parseDuration(local);
    if (secs === undefined) { setLocal(formatDuration(Number(param.value) || 0)); return; }
    let n = secs;
    if (param.min !== undefined) n = Math.max(param.min, n);
    if (param.max !== undefined) n = Math.min(param.max, n);
    setLocal(formatDuration(n));
    if (String(n) !== param.value) onChange(String(n));
  };

  // Commit an IP address: persist only a valid dotted quad, else revert the field.
  const commitIp = () => {
    const v = local.trim();
    if (!isValidIPv4(v)) { setLocal(param.value); return; }
    if (v !== param.value) onChange(v);
  };

  return (
    <div
      style={param.indent ? { marginLeft: `${param.indent * 1}rem` } : undefined}
      className={cn(
        "flex flex-col gap-1 border-l-2 py-1.5 pl-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        param.changed ? "border-primary bg-primary/5" : "border-transparent",
      )}
    >
      <span className="flex min-w-0 items-center gap-2 text-sm sm:flex-1">
        {param.changed ? <ChangedDot title={changedTitle} /> : null}
        <span className="min-w-0 whitespace-pre-line">{param.name}</span>
      </span>
      {param.changed && <RevertButton title={revertTitle} disabled={reverting} onClick={onRevert} />}
      <div className={cn("flex shrink-0 items-center gap-2", CONTROL_W)}>
        {param.readOnly ? (
          param.control === "color" ? (
            <span className="flex w-full items-center gap-2 text-sm text-muted-foreground" data-testid={`param-${param.refId}`}>
              <span style={{ background: param.value }} className="inline-block size-5 shrink-0 rounded border border-input" />
              <span className="font-mono">{param.value}</span>
            </span>
          ) : (
            <span className="w-full text-sm text-muted-foreground" data-testid={`param-${param.refId}`}>{readOnlyText}</span>
          )
        ) : param.control === "enum" ? (
          // Native <select>: a device can have 500+ enums; mounting that many
          // Radix Selects is the page's main render cost. Native is browser-cheap
          // and fully functional, so the whole list stays visible without lag.
          <select
            value={param.value} onChange={(e) => onChange(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid={`param-${param.refId}`}
          >
            {param.options?.map((o) => <option key={o.value} value={String(o.value)}>{o.text}</option>)}
          </select>
        ) : param.control === "number" && param.slider ? (
          // ETS UIHint="Slider": a bounded range with a live numeric readout.
          <span className="flex w-full items-center gap-2" data-testid={`param-${param.refId}`}>
            <input
              type="range" value={local} min={param.min} max={param.max} step={param.step ?? 1}
              onChange={(e) => setLocal(e.target.value)}
              onPointerUp={() => local !== param.value && onChange(local)}
              onKeyUp={() => local !== param.value && onChange(local)}
              onBlur={() => local !== param.value && onChange(local)}
              className="h-9 w-full accent-primary"
            />
            <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums">{local}</span>
          </span>
        ) : param.control === "number" ? (
          <Input
            type="number" value={local} min={param.min} max={param.max} step={param.step}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commitNumber}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            className="w-full font-mono" data-testid={`param-${param.refId}`}
          />
        ) : param.control === "text" ? (
          <Input className="w-full" value={local} onChange={(e) => setLocal(e.target.value)} onBlur={() => local !== param.value && onChange(local)} data-testid={`param-${param.refId}`} />
        ) : param.control === "color" ? (
          // TypeColor (RGB): native colour picker. Values are stored as #RRGGBB;
          // ETS uses upper-case, so normalise typed/picked input to upper-case to
          // match the stored default (no upper/lower drift) and read back exactly.
          <span className="flex w-full items-center gap-2" data-testid={`param-${param.refId}`}>
            <input
              type="color" value={(local || "#000000").toLowerCase()}
              onChange={(e) => setLocal(e.target.value.toUpperCase())}
              onBlur={() => local !== param.value && onChange(local)}
              className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background p-0.5"
            />
            <span className="font-mono text-sm text-muted-foreground">{local}</span>
          </span>
        ) : param.control === "time" ? (
          // TypeTime: seconds-based units edit as hh:mm:ss with a live raw-seconds hint;
          // any other unit edits the raw integer count with the unit as suffix.
          isDuration ? (
            <span className="flex w-full items-center gap-2" data-testid={`param-${param.refId}`}>
              <Input
                type="text" value={local}
                onChange={(e) => setLocal(e.target.value)}
                onBlur={commitDuration}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                className="w-full font-mono"
              />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">= {param.value} s</span>
            </span>
          ) : (
            <Input
              type="number" value={local} min={param.min} max={param.max} step={param.step}
              onChange={(e) => setLocal(e.target.value)}
              onBlur={commitNumber}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              className="w-full font-mono" data-testid={`param-${param.refId}`}
            />
          )
        ) : param.control === "ip" ? (
          // TypeIPAddress: validated dotted quad; invalid input reverts on blur.
          <Input
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commitIp}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            aria-invalid={local.trim() !== "" && !isValidIPv4(local)}
            className="w-full font-mono" data-testid={`param-${param.refId}`}
          />
        ) : (
          // Type we cannot edit yet: show the value read-only with an explicit
          // "not supported" badge so the gap is visible, never a blank control.
          <span className="flex w-full items-center gap-2" data-testid={`param-${param.refId}`}>
            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3" />{t("device.unsupportedType", { type: param.typeLabel ?? "?" })}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{param.value}</span>
          </span>
        )}
        {param.suffix && <span className="shrink-0 text-xs text-muted-foreground">{param.suffix}</span>}
      </div>
    </div>
  );
}
