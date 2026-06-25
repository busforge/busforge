import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { GroupAddress, GroupRangeNode } from "../api.ts";
import { useProject } from "../queries.ts";
import { GaPill } from "@/components/GaPill.tsx";
import { DptBadge } from "@/components/DptBadge.tsx";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The bright orange group number shown in front of each range name. Lets you read
// where you are in the address tree at a glance (main group, then main/middle).
function NumTag({ value, className }: { value: string; className?: string }) {
  return <span className={cn("shrink-0 rounded bg-primary/15 px-1.5 py-0.5 font-mono font-semibold text-primary", className)}>{value}</span>;
}

// First group address found anywhere under a range, used to derive its display
// number from a real address (style-agnostic: works for two- and three-level
// projects without having to know the project's address style).
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

// Prune a range to what matches the filter: only matching addresses and ranges
// that still have something to show survive. Returns null when nothing remains.
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

export function GroupAddressesView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);

  // Filter state is URL-encoded so back/forward and reload restore it.
  const navigate = useNavigate({ from: "/projects/$projectId/groups" });
  const search = useSearch({ from: "/projects/$projectId/groups" });
  const q = search.q ?? "";
  const setQ = (val: string) => navigate({ search: (p) => ({ ...p, q: val || undefined }), replace: true });
  const filter = q.trim().toLowerCase();

  // The (filtered) main groups, each rendered as its own card.
  const sections = useMemo(
    () => (project?.groupRanges ?? []).map((r) => filterNode(r, filter)).filter((r): r is GroupRangeNode => r !== null),
    [project, filter],
  );
  const matched = useMemo(() => countGas(sections), [sections]);

  // Section index for the sidebar: main groups plus their direct middle groups.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [activeSec, setActiveSec] = useState<string | null>(null);
  const scrollToSec = (id: string) => cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const registerRef = (id: string) => (el: HTMLElement | null) => { if (el) cardRefs.current.set(id, el); else cardRefs.current.delete(id); };
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

  // Scroll-spy: the active section is the last whose heading sits above a small
  // top offset. Deterministic (always exactly one), so it never flickers.
  useEffect(() => {
    if (!project) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      let active: string | null = null;
      let bestTop = -Infinity;
      cardRefs.current.forEach((el, id) => {
        const top = el.getBoundingClientRect().top;
        if (top <= 112 && top > bestTop) { bestTop = top; active = id; }
      });
      if (!active && sections[0]) active = `sec-${sections[0].id}`;
      setActiveSec(active);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [project, sections]);

  if (!project) return null;

  const gaRows = (addresses: GroupAddress[]) =>
    addresses.map((g) => (
      <div key={g.raw} className="flex items-center justify-between gap-3 rounded px-2 py-1 text-sm hover:bg-secondary/50">
        <GaPill projectId={projectId} raw={g.raw} name={g.name} address={g.address} className="min-w-0" />
        <DptBadge dpt={g.dpt} />
      </div>
    ));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchRef} placeholder={t("groups.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} className="px-9" data-testid="group-search" />
          {q && (
            <button
              type="button" aria-label={t("groups.clearSearch")} onClick={() => setQ("")} data-testid="group-search-clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <span className="font-mono text-xs text-muted-foreground" data-testid="group-count">{t("groups.count", { shown: matched, total: project.gaCount })}</span>
      </div>

      {matched === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground" data-testid="groups-empty">{filter ? t("groups.emptySearch") : t("groups.empty")}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {navCount > 1 && (
            <nav className="lg:sticky lg:top-28 lg:max-h-[calc(100vh-8rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto">
              <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-x-visible lg:pb-0">
                {sections.map((main) => {
                  const navBtn = (id: string, num: string | undefined, label: string, sub: boolean) => {
                    const active = activeSec === id;
                    return (
                      <button
                        key={id} type="button" onClick={() => scrollToSec(id)}
                        className={cn(
                          "flex w-full items-center gap-1.5 whitespace-nowrap rounded border-l-2 py-1 pr-2 text-left text-sm transition-colors lg:truncate",
                          sub ? "pl-5" : "pl-2",
                          active ? "border-foreground/50 bg-secondary font-medium text-foreground"
                            : sub ? "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                            : "border-transparent font-medium text-foreground/80 hover:bg-secondary/60 hover:text-foreground",
                        )}
                      >
                        {num && <NumTag value={num} className="px-1 py-0 text-[10px]" />}
                        <span className="truncate">{label || t("groups.unnamedRange")}</span>
                      </button>
                    );
                  };
                  return (
                    <li key={main.id} className="lg:contents">
                      {navBtn(`sec-${main.id}`, rangeNumber(main, 0), main.name, false)}
                      {main.children.map((mid) => navBtn(`sec-${mid.id}`, rangeNumber(mid, 1), mid.name, true))}
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}

          <div className="min-w-0 flex-1 space-y-6">
            {sections.map((main) => {
              const num = rangeNumber(main, 0);
              return (
                <section key={main.id} className="space-y-2">
                  <h2 id={`sec-${main.id}`} ref={registerRef(`sec-${main.id}`)} className="flex scroll-mt-24 items-center gap-2 px-1 text-lg font-semibold text-foreground">
                    {num && <NumTag value={num} className="text-sm" />}
                    <span className="min-w-0 truncate">{main.name || t("groups.unnamedRange")}</span>
                  </h2>
                  <Card>
                    <CardContent className="space-y-1 py-4">
                      {main.addresses.length === 0 && main.children.length === 0 && (
                        <p className="px-2 text-sm text-muted-foreground">{t("groups.emptyRange")}</p>
                      )}
                      {gaRows(main.addresses)}
                      {main.children.map((mid) => (
                        <SubRange key={mid.id} node={mid} depth={1} registerRef={registerRef} gaRows={gaRows} unnamed={t("groups.unnamedRange")} />
                      ))}
                    </CardContent>
                  </Card>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// A middle group (and any deeper nesting) inside a main-group card: a heading
// with its number tag, its addresses, then any sub-ranges, indented further.
function SubRange({ node, depth, registerRef, gaRows, unnamed }: {
  node: GroupRangeNode;
  depth: number;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
  gaRows: (addresses: GroupAddress[]) => ReactNode;
  unnamed: string;
}) {
  const num = rangeNumber(node, depth);
  const deep = depth >= 2;
  return (
    <section
      id={`sec-${node.id}`}
      ref={depth === 1 ? registerRef(`sec-${node.id}`) : undefined}
      className={cn("scroll-mt-24 pt-2", deep && "pl-3")}
    >
      <h4 className={cn("mt-2 mb-1 flex items-center gap-2 border-l-2 pl-2 text-sm font-semibold", deep ? "border-foreground/15 text-muted-foreground" : "border-foreground/30 text-foreground")}>
        {num && <NumTag value={num} className="px-1 py-0 text-[10px]" />}
        <span className="min-w-0 truncate">{node.name || unnamed}</span>
      </h4>
      {gaRows(node.addresses)}
      {node.children.map((c) => (
        <SubRange key={c.id} node={c} depth={depth + 1} registerRef={registerRef} gaRows={gaRows} unnamed={unnamed} />
      ))}
    </section>
  );
}
