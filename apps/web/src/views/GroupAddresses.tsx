import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FolderPlus, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { GroupAddress, GroupRangeNode } from "../api.ts";
import { useProject } from "../queries.ts";
import { GaPill } from "@/components/GaPill.tsx";
import { DptBadge } from "@/components/DptBadge.tsx";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionNav } from "@/components/SectionNav.tsx";
import { RowActions } from "@/components/RowActions.tsx";
import { useScrollSpy } from "@/lib/scrollSpy.ts";
import { Input } from "@/components/ui/input";
import { GroupEditor, type Editor, type Levels } from "./GroupEditDialogs.tsx";
import { cn } from "@/lib/utils";

// The group number shown in front of each range name. Lets you read where you are in the address
// tree at a glance (main group, then main/middle). Neutral, as amber marks pending work only.
function NumTag({ value, className }: { value: string; className?: string }) {
  return <span className={cn("shrink-0 rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono font-semibold text-foreground/80", className)}>{value}</span>;
}

function firstGaAddress(node: GroupRangeNode): string | undefined {
  if (node.addresses[0]) return node.addresses[0].address;
  for (const c of node.children) { const a = firstGaAddress(c); if (a) return a; }
  return undefined;
}

// The number(s) for a range at a given depth: the address segments up to and
// including this level. Depth 0 (main group) -> "0", depth 1 (middle) -> "0/1".
function rangeNumber(node: GroupRangeNode, depth: number): string | undefined {
  const addr = firstGaAddress(node);
  if (!addr) return undefined;
  const segs = addr.split("/");
  if (segs.length <= depth) return undefined;
  return segs.slice(0, depth + 1).join("/");
}

const matchesGa = (g: GroupAddress, filter: string) => !filter || `${g.address} ${g.name} ${g.dpt}`.toLowerCase().includes(filter);

function filterNode(node: GroupRangeNode, filter: string): GroupRangeNode | null {
  if (!filter) return node;
  const addresses = node.addresses.filter((g) => matchesGa(g, filter));
  const children = node.children.map((c) => filterNode(c, filter)).filter((c): c is GroupRangeNode => c !== null);
  if (addresses.length === 0 && children.length === 0) return null;
  return { ...node, addresses, children };
}

function countGas(nodes: GroupRangeNode[]): number {
  let n = 0;
  for (const node of nodes) { n += node.addresses.length; n += countGas(node.children); }
  return n;
}

// Smallest number in 0..max not already taken.
function nextFree(used: Set<number>, max: number): number {
  for (let i = 0; i <= max; i++) if (!used.has(i)) return i;
  return 0;
}

// Handlers the headings and rows call to open the right editor dialog.
interface Actions {
  levels: Levels;
  addMiddle: (main: GroupRangeNode) => void;
  addGa: (range: GroupRangeNode) => void;
  renameRange: (node: GroupRangeNode) => void;
  deleteRange: (node: GroupRangeNode) => void;
  editGa: (g: GroupAddress) => void;
  deleteGa: (g: GroupAddress) => void;
}

export function GroupAddressesView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);

  // Filter state is URL-encoded so back/forward and reload restore it.
  const navigate = useNavigate({ from: "/projects/$projectId/groups" });
  const search = useSearch({ from: "/projects/$projectId/groups" });
  const q = search.q ?? "";
  const setQ = (val: string) => { void navigate({ search: (p) => ({ ...p, q: val || undefined }), replace: true }); };
  const filter = q.trim().toLowerCase();

  const [editor, setEditor] = useState<Editor>(null);
  // The project's persisted group-address style, not inferred from formatted strings, so a
  // two-level project (even an empty one) edits and previews as m/s from the start.
  const levels: Levels = project?.groupAddressLevels ?? 3;
  const block = levels === 3 ? 256 : 2048;

  // Datalist suggestions for the DPT field: the datapoint types already in use.
  const dptSuggestions = useMemo(() => {
    const set = new Set<string>();
    const scan = (n: GroupRangeNode) => { for (const a of n.addresses) if (a.dpt) set.add(a.dpt); n.children.forEach(scan); };
    (project?.groupRanges ?? []).forEach(scan);
    return [...set].sort();
  }, [project]);

  // The (filtered) main groups, each rendered as its own card.
  const sections = useMemo(
    () => (project?.groupRanges ?? []).map((r) => filterNode(r, filter)).filter((r): r is GroupRangeNode => r !== null),
    [project, filter],
  );
  const matched = useMemo(() => countGas(sections), [sections]);

  // Look up nodes in the UNFILTERED tree so the "next free" defaults and used-set
  // validation are correct even while a search filter hides siblings/addresses.
  const nodeById = useMemo(() => {
    const m = new Map<string, GroupRangeNode>();
    const walk = (n: GroupRangeNode) => { m.set(n.id, n); n.children.forEach(walk); };
    (project?.groupRanges ?? []).forEach(walk);
    return m;
  }, [project]);

  // Editor openers (compute a sensible default number from what is already used).
  const actions: Actions = {
    levels,
    addMiddle: (mainArg) => {
      const main = nodeById.get(mainArg.id) ?? mainArg;
      const usedNumbers = main.children.map((c) => (c.rangeStart >> 8) & 7);
      setEditor({ kind: "range-create", parentId: Number(main.id), isMain: false, defaultNumber: nextFree(new Set(usedNumbers), 7), parentMain: main.rangeStart >> 11, usedNumbers });
    },
    addGa: (rangeArg) => {
      const range = nodeById.get(rangeArg.id) ?? rangeArg;
      const base = Math.floor(range.rangeStart / block) * block;
      const usedSubs = range.addresses.map((a) => a.raw - base);
      setEditor({ kind: "ga-create", rangeId: Number(range.id), rangeStart: range.rangeStart, defaultSub: nextFree(new Set(usedSubs), block - 1), usedSubs });
    },
    renameRange: (node) => setEditor({ kind: "range-rename", rangeId: Number(node.id), name: node.name }),
    deleteRange: (node) => setEditor({ kind: "range-delete", rangeId: Number(node.id), name: node.name }),
    editGa: (g) => setEditor({ kind: "ga-edit", raw: g.raw, name: g.name, dpt: g.dpt, security: g.security }),
    deleteGa: (g) => setEditor({ kind: "ga-delete", raw: g.raw, name: g.name, address: g.address }),
  };

  const addMainGroup = () => {
    const usedNumbers = (project?.groupRanges ?? []).map((r) => r.rangeStart >> 11);
    setEditor({ kind: "range-create", parentId: null, isMain: true, defaultNumber: nextFree(new Set(usedNumbers), 31), usedNumbers });
  };

  // Section index for the sidebar: main groups plus their direct middle groups.
  const { active: activeSec, registerRef, jump: scrollToSec } = useScrollSpy(sections[0] ? `sec-${sections[0].id}` : null, sections);
  const navCount = sections.reduce((n, m) => n + 1 + m.children.length, 0);

  // Cmd/Ctrl+F focuses the group-address search instead of the browser find.
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


  if (!project) return null;

  const gaRows = (addresses: GroupAddress[]) =>
    addresses.map((g) => (
      <div key={g.raw} className="group flex items-center gap-2 rounded-md border-b border-border/30 px-2 py-1 text-sm last:border-b-0 hover:bg-secondary/50">
        {/* Narrow screens put the DPT under the name, so the name keeps the row's width. */}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <GaPill projectId={projectId} raw={g.raw} name={g.name} address={g.address} columns className="min-w-0 hover:brightness-100 hover:[&_span]:text-foreground" onEdit={() => actions.editGa(g)} />
          <DptBadge dpt={g.dpt} className="max-sm:ml-[calc(var(--addr-col)+0.75rem)]" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RowActions menuLabel={t("common.moreActions")} actions={[
            { label: t("groupEdit.edit"), icon: <Pencil className="size-3.5" />, onClick: () => actions.editGa(g) },
            { label: t("groupEdit.delete"), icon: <Trash2 className="size-3.5" />, onClick: () => actions.deleteGa(g), danger: true },
          ]} />
        </div>
      </div>
    ));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-xs sm:flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchRef} placeholder={t("groups.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} className="px-9" data-testid="group-search" />
          {q && (
            <IconButton
              size="icon-xs" tooltip={false} label={t("groups.clearSearch")} onClick={() => setQ("")} data-testid="group-search-clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              <X className="size-4" />
            </IconButton>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground" data-testid="group-count">{t("groups.count", { shown: matched, total: project.gaCount })}</span>
          <Button variant="outline" onClick={addMainGroup} data-testid="add-main-group">
            <Plus className="size-4" /> {t("groupEdit.addMainGroup")}
          </Button>
        </div>
      </div>

      {project.groupRanges.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground" data-testid="groups-empty">{t("groups.empty")}</p>
      ) : matched === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground" data-testid="groups-empty">{t("groups.emptySearch")}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {navCount > 1 && (
            <SectionNav
              label={t("groups.jumpTo")} active={activeSec} onJump={scrollToSec}
              entries={sections.flatMap((main) => {
                const head = rangeNumber(main, 0);
                return [
                  { id: `sec-${main.id}`, label: main.name || t("groups.unnamedRange"), prefix: head && <NumTag value={head} className="px-1 py-0 text-[10px]" /> },
                  ...main.children.map((mid) => {
                    const num = rangeNumber(mid, 1);
                    return { id: `sec-${mid.id}`, label: mid.name || t("groups.unnamedRange"), sub: true, prefix: num && <NumTag value={num} className="px-1 py-0 text-[10px]" /> };
                  }),
                ];
              })}
            />
          )}

          <div className="min-w-0 flex-1 space-y-6">
            {sections.map((main) => {
              const num = rangeNumber(main, 0);
              return (
                <section key={main.id} className="space-y-2">
                  <h2 id={`sec-${main.id}`} ref={registerRef(`sec-${main.id}`)} className="group flex scroll-mt-chrome items-center gap-2 px-1 text-lg font-semibold text-foreground">
                    {num && <NumTag value={num} className="text-sm" />}
                    <span className="min-w-0 truncate">{main.name || t("groups.unnamedRange")}</span>
                    <RowActions className="ml-auto" menuLabel={t("common.moreActions")} actions={[
                      levels === 3
                        ? { label: t("groupEdit.addMiddleGroup"), icon: <FolderPlus className="size-4" />, onClick: () => actions.addMiddle(main) }
                        : { label: t("groupEdit.addGa"), icon: <Plus className="size-4" />, onClick: () => actions.addGa(main) },
                      { label: t("groupEdit.rename"), icon: <Pencil className="size-4" />, onClick: () => actions.renameRange(main) },
                      { label: t("groupEdit.delete"), icon: <Trash2 className="size-4" />, danger: true, onClick: () => actions.deleteRange(main) },
                    ]} />
                  </h2>
                  <Card className="gap-0 py-0">
                    <CardContent className="space-y-1 px-4 py-3 sm:px-6">
                      {main.addresses.length === 0 && main.children.length === 0 && (
                        <p className="px-2 text-sm text-muted-foreground">{t("groups.emptyRange")}</p>
                      )}
                      {gaRows(main.addresses)}
                      {main.children.map((mid) => (
                        <SubRange key={mid.id} node={mid} depth={1} registerRef={registerRef} gaRows={gaRows} actions={actions} unnamed={t("groups.unnamedRange")} t={t} />
                      ))}
                    </CardContent>
                  </Card>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <GroupEditor editor={editor} onClose={() => setEditor(null)} projectId={projectId} levels={levels} dptSuggestions={dptSuggestions} />
    </div>
  );
}

// A middle group (and any deeper nesting) inside a main-group card: a heading
// with its number tag, its addresses, then any sub-ranges, indented further.
function SubRange({ node, depth, registerRef, gaRows, actions, unnamed, t }: {
  node: GroupRangeNode;
  depth: number;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
  gaRows: (addresses: GroupAddress[]) => ReactNode;
  actions: Actions;
  unnamed: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const num = rangeNumber(node, depth);
  const deep = depth >= 2;
  return (
    <section
      id={`sec-${node.id}`}
      ref={depth === 1 ? registerRef(`sec-${node.id}`) : undefined}
      className={cn("scroll-mt-chrome pt-2 first:pt-0", deep && "pl-3")}
    >
      <h4 className={cn("group mt-2 mb-1 flex items-center gap-2 border-l-2 pl-2 text-sm font-semibold", deep ? "border-foreground/15 text-muted-foreground" : "border-foreground/30 text-foreground")}>
        {num && <NumTag value={num} className="px-1 py-0 text-[10px]" />}
        <span className="min-w-0 truncate">{node.name || unnamed}</span>
        <RowActions className="ml-auto" menuLabel={t("common.moreActions")} actions={[
          { label: t("groupEdit.addGa"), icon: <Plus className="size-3.5" />, onClick: () => actions.addGa(node) },
          { label: t("groupEdit.rename"), icon: <Pencil className="size-3.5" />, onClick: () => actions.renameRange(node) },
          { label: t("groupEdit.delete"), icon: <Trash2 className="size-3.5" />, onClick: () => actions.deleteRange(node), danger: true },
        ]} />
      </h4>
      {gaRows(node.addresses)}
      {node.children.map((c) => (
        <SubRange key={c.id} node={c} depth={depth + 1} registerRef={registerRef} gaRows={gaRows} actions={actions} unnamed={unnamed} t={t} />
      ))}
    </section>
  );
}
