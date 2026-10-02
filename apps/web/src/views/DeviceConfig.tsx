import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronLeft, Cpu, Download, Info, KeyRound, Loader2, MapPin, MoreVertical, Puzzle, RadioTower, Repeat2, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CfgBlock, CfgComObjView, CfgItem, CfgParamView, DeviceConfigView, GroupRangeNode } from "../api.ts";
import { qk, useProject, useDeviceConfig, useDeviceEdit } from "../queries.ts";
import { isSecondsUnit, formatDuration, parseDuration, isValidIPv4, normalizeFloat } from "@/lib/paramFormat.ts";
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
import { ReplaceDeviceDialog } from "./ReplaceDeviceDialog.tsx";
import { CommissionDialog } from "./CommissionDialog.tsx";
import { SecureActivateDialog } from "./SecureActivateDialog.tsx";
import { ToolKeyDialog } from "./ToolKeyDialog.tsx";
import { AddressDialog } from "./AddressDialog.tsx";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GaCombobox, type GaOption } from "./GaCombobox.tsx";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { DcaModuleDialog } from "../dca/DcaModuleDialog.tsx";
import { cn } from "@/lib/utils";
import { errMsg } from "../lib/apiError.ts";
import { ApiError } from "../api.ts";

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
  const setQ = (val: string) => { void navigate({ search: (p) => ({ ...p, q: val || undefined }), replace: true }); };
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
  // A link the server held back because it would turn a secured address plain, waiting for the user.
  const [plainLink, setPlainLink] = useState<{ comObjRefId: string; gaRaw: number } | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [commissionOpen, setCommissionOpen] = useState(false);
  const [secureOpen, setSecureOpen] = useState(false);
  const [toolKeyOpen, setToolKeyOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const hasChanges = changeTotal(device?.changes) > 0;
  const hasParams = !!view?.blocks.some((b) => b.items.some((i) => i.kind === "param"));
  const hasComObjects = !!view?.blocks.some((b) => b.items.some((i) => i.kind === "comObject"));
  // Gate each flash target on the device's real capability (classify().capabilities()), not just on
  // whether params/com-objects exist, so the UI never offers a flash the server would refuse. When
  // capabilities are not yet loaded, fall back to presence (the prior behaviour).
  const caps = view?.capabilities;
  const flashTargetsAvail: FlashTarget[] = [
    ...(hasParams && (caps ? caps.flashParams : true) ? ["params" as const] : []),
    ...(hasComObjects && (caps ? caps.flashLinks : true) ? ["ga" as const] : []),
  ];

  // Honest read-back disclosure: every way the shown change state was NOT confirmed
  // against the hardware. Device-class limits (params/links unsupported) plus the
  // type-level blind spot: text and colour parameters are not image-representable, so
  // read-back can never verify them even on an otherwise supported device.
  const rb = view?.readbackSupport;
  const hasTextColorParams = !!view?.blocks.some((b) => b.items.some((i) => i.kind === "param" && (i.param.control === "text" || i.param.control === "color")));
  const readbackNotes: string[] = [];
  if (rb) {
    if (!rb.params && !rb.links) readbackNotes.push(t("device.readbackUnsupportedBoth"));
    else {
      if (!rb.params) readbackNotes.push(t("device.readbackUnsupportedParams"));
      if (!rb.links) readbackNotes.push(t("device.readbackUnsupportedLinks"));
    }
    if (rb.params !== false && hasTextColorParams) readbackNotes.push(t("device.readbackUnverifiableTextColor"));
    // Com-object flags / active object set (L3) are not programmed or compared; only links are.
    if (rb.links && hasComObjects) readbackNotes.push(t("device.readbackComObjectFlags"));
  }

  const onError = (e: unknown) => toast.error(t("device.saveError"), { description: errMsg(t, e) });
  const relink = (comObjRefId: string, gaRaw: number | null) =>
    setLink.mutate({ comObjRefId, gaRaws: gaRaw == null ? [] : [gaRaw] }, {
      onError: (e) => {
        if (gaRaw != null && e instanceof ApiError && e.code === "SECURE_GA_TURNS_PLAIN") setPlainLink({ comObjRefId, gaRaw });
        else onError(e);
      },
    });
  const confirmPlainLink = () => {
    if (!plainLink) return;
    setLink.mutate({ comObjRefId: plainLink.comObjRefId, gaRaws: [plainLink.gaRaw], allowPlain: true }, {
      onSuccess: () => setPlainLink(null),
      onError: (e) => { setPlainLink(null); onError(e); },
    });
  };
  const doRevert = () =>
    revert.mutate(undefined, {
      onSuccess: () => { setRevertOpen(false); toast.success(t("device.reverted")); },
      onError: (e) => { setRevertOpen(false); onError(e); },
    });
  const doReadBack = () =>
    readBack.mutate(undefined, {
      onSuccess: (v) => {
        const n = countChanged(v);
        toast.success(n ? t("device.readDrift", { count: n }) : t("device.readNoDrift"));
        // Device associations that mapped to no known com-object are NOT in the baseline;
        // drift there stays invisible. Say so instead of implying a complete read.
        const gaps = v.readback?.linkGaps ?? 0;
        if (gaps > 0) toast.warning(t("device.readLinkGaps", { count: gaps }));
      },
      onError: (e) => toast.error(t("device.readError"), { description: errMsg(t, e) }),
    });
  const afterFlash = () => {
    void qc.invalidateQueries({ queryKey: qk.project(projectId) });
    void qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] });
    void qc.invalidateQueries({ queryKey: qk.snapshots(projectId) }); // a real flash captures an auto restore point
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

  // `compact` renders an item as a GRID CELL: no full-width row, no repeated label
  // (in an ETS grid the author labels the cells with separators, in a table with the
  // column headers), so the cells of one row line up as ETS lays them out.
  const renderItem = (item: CfgItem, key: string | number, compact = false) => {
    if (item.kind === "separator") {
      if (item.uiHint === "HorizontalRuler") return <Separator key={key} className="my-2" />;
      if (!item.text) return null;
      if (item.uiHint === "Error") return <p key={key} className="py-1 text-xs text-destructive">{item.text}</p>;
      // In a grid cell a plain separator is the label of its row, not a section
      // heading; only an explicit Headline keeps the heading weight.
      if (compact) {
        return (
          <span key={key} className={cn("block min-w-0 whitespace-pre-wrap text-sm", item.uiHint === "Headline" ? "font-semibold text-foreground" : "text-foreground")}>
            {item.text}
          </span>
        );
      }
      // Any other text separator is a section heading in ETS.
      return <div key={key} className="mt-4 mb-1 border-b border-border/40 pb-1 text-sm font-semibold text-foreground first:mt-0">{item.text}</div>;
    }
    // An ETS <Button> runs a manufacturer script action (EventHandler) inside ETS.
    // busforge has no ETS script host, so the control is rendered DISABLED and says
    // which action it would run: a button that looked alive but did nothing would be
    // worse than no button at all.
    if (item.kind === "button") {
      const why = t("device.buttonNotSupported", { handler: item.button.handler || "?" });
      return (
        <Tooltip key={key}>
          <TooltipTrigger asChild>
            <span className={cn("inline-flex", compact ? "min-w-0 max-w-full" : "my-1")} data-testid={`button-${item.button.handler}`}>
              <Button type="button" variant="outline" size="sm" disabled aria-disabled className="min-w-0 justify-start">
                <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="truncate">{item.button.text}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{why}</TooltipContent>
        </Tooltip>
      );
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
        key={key} param={item.param} compact={compact} changedTitle={t("device.changedDot")} revertTitle={t("device.revertRow")} reverting={saving}
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

  // A block's items. A Grid/Table ParameterBlock (ETS Layout=) places its items by
  // Cell="row,column"; anything else is the plain top-to-bottom list.
  const renderItems = (block: CfgBlock, keyPrefix: string) =>
    block.layout ? renderGrid(block, keyPrefix) : block.items.map((item, i) => renderItem(item, `${keyPrefix}-${i}`));

  // ETS grid: <Rows>/<Columns> declare the geometry (column widths, and for a Table the
  // header captions), every item names its cell. Cells are rendered in place; several
  // items can legitimately land in one cell (two active choose branches), so a cell
  // holds a list and never drops one. Items WITHOUT a cell (com-objects, or an item
  // whose Cell we could not read) follow below the grid instead of disappearing.
  const renderGrid = (block: CfgBlock, keyPrefix: string) => {
    const cells = new Map<string, CfgItem[]>();
    const loose: CfgItem[] = [];
    let maxRow = block.rows?.length ?? 0;
    let maxCol = block.cols?.length ?? 0;
    for (const item of block.items) {
      const cell = item.kind === "comObject" || item.kind === "unsupported" ? undefined : item.cell;
      if (!cell) { loose.push(item); continue; }
      maxRow = Math.max(maxRow, cell.row);
      maxCol = Math.max(maxCol, cell.col);
      const key = `${cell.row},${cell.col}`;
      const at = cells.get(key);
      if (at) at.push(item); else cells.set(key, [item]);
    }
    // A Table shows the authored headers, so it needs a leading column for the row
    // captions and a leading row for the column captions; a Grid has neither.
    const table = block.layout === "Table";
    const off = table ? 1 : 0;
    // ETS authors a column width as a percentage. Anything else is a width we cannot
    // read, and interpolating it raw would invalidate the whole grid-template-columns
    // declaration and collapse the block: fall back to an auto track for that column.
    const width = (w?: string) => (w && /^\d+(\.\d+)?(%|px|rem|em)$/.test(w) ? w : "auto");
    const widths = Array.from({ length: maxCol }, (_, i) => `minmax(0, ${width(block.cols?.[i]?.width)})`);
    const template = (table ? "auto " : "") + widths.join(" ");
    return (
      <div key={keyPrefix} className="my-1 grid items-center gap-x-3 gap-y-1" style={{ gridTemplateColumns: template }}>
        {table && block.cols?.map((c, i) => c.text ? (
          <span key={`${keyPrefix}-ch-${i}`} style={{ gridRow: 1, gridColumn: i + 2 }} className="border-b border-border/40 pb-1 text-xs font-semibold text-muted-foreground">{c.text}</span>
        ) : null)}
        {table && block.rows?.map((r, i) => r.text ? (
          <span key={`${keyPrefix}-rh-${i}`} style={{ gridRow: i + 2, gridColumn: 1 }} className="pr-2 text-sm text-muted-foreground">{r.text}</span>
        ) : null)}
        {[...cells].map(([key, items]) => {
          const [row, col] = key.split(",").map(Number);
          return (
            <div key={`${keyPrefix}-${key}`} style={{ gridRow: row + off, gridColumn: col + off }} className="min-w-0">
              {items.map((item, i) => renderItem(item, `${keyPrefix}-${key}-${i}`, true))}
            </div>
          );
        })}
        {/* Pinned to the row AFTER the last one: CSS auto-placement would otherwise drop
            this full-width block into the first empty row (e.g. a row whose items all sit
            in an inactive choose branch), i.e. into the middle of the grid. */}
        {loose.length > 0 && (
          <div style={{ gridRow: maxRow + off + 1, gridColumn: "1 / -1" }} className="min-w-0">
            {loose.map((item, i) => renderItem(item, `${keyPrefix}-loose-${i}`))}
          </div>
        )}
      </div>
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
          {actionBtn("device.readFromDevice", readBack.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />, doReadBack, { disabled: readBack.isPending || saving || (!!view?.readbackSupport && !view.readbackSupport.params && !view.readbackSupport.links), testId: "read-back" })}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-9" aria-label={t("device.moreActions")} data-testid="device-menu">
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setAddressOpen(true)} disabled={!device} data-testid="change-address">
                <MapPin className="size-4" /> {t("address.menu")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setReplaceOpen(true)} disabled={!view} data-testid="replace-product">
                <Repeat2 className="size-4" /> {t("replace.menu")}
              </DropdownMenuItem>
              {/* Commissioning is a full download; only offer it where the device can be commissioned. */}
              <DropdownMenuItem onClick={() => setCommissionOpen(true)} disabled={!!caps && !caps.fullDownload} data-testid="commission-device">
                <RadioTower className="size-4" /> {t("commission.menu")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSecureOpen(true)} data-testid="secure-activate-device">
                <ShieldCheck className="size-4" /> {t("secureActivate.menu")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setToolKeyOpen(true)} data-testid="tool-key-device">
                <KeyRound className="size-4" /> {t("toolKey.menu")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {device && flashTargets && (
        <FlashDialog
          open onOpenChange={(o) => { if (!o) setFlashTargets(null); }}
          projectId={projectId} device={device} targets={flashTargets} onFlashed={afterFlash}
          canFullDownload={!!view?.capabilities?.fullDownload}
        />
      )}

      {device && view && (
        <ReplaceDeviceDialog
          open={replaceOpen} onOpenChange={setReplaceOpen}
          projectId={projectId} device={device} view={view} gaOptions={gaOptions}
        />
      )}

      {/* A successful download baselines the config and captures an auto restore
          point, exactly like a flash: reuse the same invalidations. */}
      {device && (
        <CommissionDialog
          open={commissionOpen} onOpenChange={setCommissionOpen}
          projectId={projectId} device={device} onCommissioned={afterFlash}
        />
      )}

      {device && (
        <AddressDialog
          open={addressOpen} onOpenChange={setAddressOpen}
          projectId={projectId} device={device}
          onSaved={() => qc.invalidateQueries({ queryKey: qk.project(projectId) })}
          onAssign={() => setCommissionOpen(true)}
        />
      )}

      {device && (
        <SecureActivateDialog
          open={secureOpen} onOpenChange={setSecureOpen}
          projectId={projectId} device={device}
          onActivated={() => void qc.invalidateQueries({ queryKey: qk.project(projectId) })}
        />
      )}

      {device && (
        <ToolKeyDialog
          open={toolKeyOpen} onOpenChange={setToolKeyOpen}
          projectId={projectId} device={device}
          onStored={() => void qc.invalidateQueries({ queryKey: qk.project(projectId) })}
        />
      )}

      <AlertDialog open={plainLink !== null} onOpenChange={(o) => { if (!o) setPlainLink(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("device.plainLinkTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("device.plainLinkBody", { ga: gaOptions.find((o) => o.raw === plainLink?.gaRaw)?.address ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={setLink.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmPlainLink(); }} disabled={setLink.isPending} data-testid="confirm-plain-link">
              {setLink.isPending && <Loader2 className="size-4 animate-spin" />} {t("device.plainLinkConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      {!!view?.linkBaseGaps && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-700 dark:text-amber-300" data-testid="link-gaps-notice">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{view.linkBaseGaps > 0 ? t("device.linkGapsBlocked", { count: view.linkBaseGaps }) : t("device.linkGapsUnknown")}</span>
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

      {readbackNotes.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300" data-testid="readback-unsupported">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">{t("device.readbackUnsupportedTitle")}</p>
            <ul className="space-y-0.5 text-amber-700/90 dark:text-amber-300/90">
              {readbackNotes.map((n, i) => <li key={i}>{n}</li>)}
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
                  {renderItems(g.head, g.head.id)}
                  {g.children.map((child: CfgBlock) => {
                    const deep = child.level >= 2; // sub-block of a sub-section: indent further, lighter heading
                    return (
                      <section
                        key={child.id} id={`sec-${child.id}`}
                        ref={child.level === 1 ? registerRef(`sec-${child.id}`) : undefined}
                        className={cn("scroll-mt-20 pt-3", deep && "pl-3")}
                      >
                        {/* Channel sub-heading: the label followed by a hairline that fades out,
                            so each sub-block reads as its own section without a heavy left bar. */}
                        <h4 className={cn("mb-3 flex items-center gap-2.5 font-semibold first:mt-0",
                          deep ? "mt-4 text-sm text-muted-foreground" : "mt-5 text-foreground")}>
                          <span className="min-w-0 shrink truncate">{child.name}</span>
                          {child.items.some(isItemChanged) && <span className="size-1.5 shrink-0 rounded-full bg-primary" title={t("device.changedDot")} />}
                          <span className={cn("h-px flex-1 bg-gradient-to-r to-transparent", deep ? "from-border/40" : "from-border/70")} />
                        </h4>
                        {renderItems(child, child.id)}
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

function ParamRow({ param, compact, changedTitle, revertTitle, reverting, onChange, onRevert }: { param: CfgParamView; compact?: boolean; changedTitle: string; revertTitle: string; reverting?: boolean; onChange: (value: string) => void; onRevert: () => void }) {
  const { t } = useTranslation();
  // The displayed string for the current value: hh:mm:ss for a seconds-based TypeTime,
  // a plain decimal for a TypeFloat (ETS stores those in scientific notation), else raw.
  const isDuration = param.control === "time" && isSecondsUnit(param.unit);
  const display = (v: string) => (isDuration ? formatDuration(Number(v) || 0) : param.float ? normalizeFloat(v) : v);
  const [local, setLocal] = useState(() => display(param.value));
  useEffect(() => setLocal(display(param.value)), [param.value, isDuration, param.float]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read-only params are informational displays (e.g. "Info: ..."); render them
  // as plain text instead of disabled form controls, which read as broken.
  const readOnlyText = param.control === "enum"
    ? (param.options?.find((o) => String(o.value) === param.value)?.text ?? param.value)
    : display(param.value);

  // Commit a typed number: the native input does not enforce min/max on typed
  // input, so clamp to the range and snap to the ETS step grid (anchored at min)
  // before persisting. Empty/non-numeric input reverts to the current value.
  const commitNumber = () => {
    const raw = local.trim();
    if (raw === "" || Number.isNaN(Number(raw))) { setLocal(display(param.value)); return; }
    let n = Number(raw);
    const base = param.min ?? 0;
    if (param.step && param.step > 1) n = base + Math.round((n - base) / param.step) * param.step;
    if (param.min !== undefined) n = Math.max(param.min, n);
    if (param.max !== undefined) n = Math.min(param.max, n);
    const s = String(n);
    setLocal(s);
    // Compare numerically for floats: the stored default is scientific notation
    // ("1.5E+001"), so a string compare would mark an unchanged float as drifted on blur.
    const same = param.float ? Number(s) === Number(param.value) : s === param.value;
    if (!same) onChange(s);
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

  // In a grid cell the control has no visible label of its own (the author's separator or
  // the table's column header names it), so carry the parameter's own text as the control's
  // accessible name instead of leaving it nameless.
  const label = compact ? param.name.trim() || undefined : undefined;

  return (
    <div
      // In a grid cell the label is the author's separator / column header and the row
      // chrome (own label column, indent, fixed control width) would break the layout,
      // so the cell shows the control alone and keeps the label as its tooltip.
      style={param.indent && !compact ? { marginLeft: `${param.indent * 1}rem` } : undefined}
      title={label}
      className={cn(
        compact
          ? "flex min-w-0 items-center gap-1.5 border-l-2 py-1 pl-1.5"
          : "flex flex-col gap-1 border-l-2 py-1.5 pl-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        param.changed ? "border-primary bg-primary/5" : "border-transparent",
      )}
    >
      {compact ? (
        param.changed ? <ChangedDot title={changedTitle} /> : null
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-sm sm:flex-1">
          {param.changed ? <ChangedDot title={changedTitle} /> : null}
          {/* pre-wrap (not pre-line) so an ETS author's leading-space faux-indent renders */}
          <span className="min-w-0 whitespace-pre-wrap">{param.name}</span>
        </span>
      )}
      {param.changed && <RevertButton title={revertTitle} disabled={reverting} onClick={onRevert} />}
      <div className={cn("flex items-center gap-2", compact ? "min-w-0 flex-1" : cn("shrink-0", CONTROL_W))}>
        {/* A type we cannot edit stays explicit even when it is read-only: rendering it
            as a plain read-only value would show an empty field (e.g. a TypePicture,
            whose image lives in the manufacturer baggage we do not import) and pass the
            gap off as a value. */}
        {param.control === "unsupported" ? (
          <span className="flex w-full min-w-0 items-center gap-2" data-testid={`param-${param.refId}`}>
            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3" />{t("device.unsupportedType", { type: param.typeLabel ?? "?" })}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{param.value}</span>
          </span>
        ) : param.readOnly ? (
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
            value={param.value} onChange={(e) => onChange(e.target.value)} aria-label={label}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid={`param-${param.refId}`}
          >
            {param.options?.map((o) => <option key={o.value} value={String(o.value)}>{o.text}</option>)}
          </select>
        ) : param.control === "number" && param.slider ? (
          // ETS UIHint="Slider": a bounded range with a live numeric readout.
          <span className="flex w-full items-center gap-2" data-testid={`param-${param.refId}`}>
            <input
              type="range" value={local} min={param.min} max={param.max} step={param.step ?? 1} aria-label={label}
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
            type="number" value={local} min={param.min} max={param.max} step={param.float ? "any" : param.step} aria-label={label}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commitNumber}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            className="w-full font-mono" data-testid={`param-${param.refId}`}
          />
        ) : param.control === "text" ? (
          <Input className="w-full" value={local} onChange={(e) => setLocal(e.target.value)} onBlur={() => local !== param.value && onChange(local)} aria-label={label} data-testid={`param-${param.refId}`} />
        ) : param.control === "color" ? (
          // TypeColor (RGB): native colour picker. Values are stored as #RRGGBB;
          // ETS uses upper-case, so normalise typed/picked input to upper-case to
          // match the stored default (no upper/lower drift) and read back exactly.
          <span className="flex w-full items-center gap-2" data-testid={`param-${param.refId}`}>
            <input
              type="color" value={(local || "#000000").toLowerCase()} aria-label={label}
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
                type="text" value={local} aria-label={label}
                onChange={(e) => setLocal(e.target.value)}
                onBlur={commitDuration}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                className="w-full font-mono"
              />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">= {param.value} s</span>
            </span>
          ) : (
            <Input
              type="number" value={local} min={param.min} max={param.max} step={param.step} aria-label={label}
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
            aria-invalid={local.trim() !== "" && !isValidIPv4(local)} aria-label={label}
            className="w-full font-mono" data-testid={`param-${param.refId}`}
          />
        ) : (
          // Defensive fallback only: every control the engine emits is handled above (an
          // unsupported type takes the first branch, and "display" is always read-only).
          // A future control kind shows its value read-only instead of an empty cell.
          <span className="w-full text-sm text-muted-foreground" data-testid={`param-${param.refId}`}>{readOnlyText}</span>
        )}
        {param.suffix && <span className="shrink-0 text-xs text-muted-foreground">{param.suffix}</span>}
      </div>
    </div>
  );
}
