import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { GroupRangeNode } from "../api.ts";
import { useProject } from "../queries.ts";
import { GaLabel } from "@/components/GaLabel.tsx";
import { DptBadge } from "@/components/DptBadge.tsx";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

function RangeBlock({ node, depth, filter }: { node: GroupRangeNode; depth: number; filter: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(depth < 1);
  const matchingGas = node.addresses.filter((g) => !filter || `${g.address} ${g.name} ${g.dpt}`.toLowerCase().includes(filter));
  const childBlocks = node.children.map((c) => <RangeBlock key={c.id} node={c} depth={depth + 1} filter={filter} />);
  // When filtering, prune ranges with nothing to show.
  if (filter && matchingGas.length === 0 && !node.children.some((c) => hasMatch(c, filter))) return null;

  const expanded = open || !!filter;

  return (
    <div className={depth === 0 ? "" : "ml-3 border-l border-border/70 pl-3"}>
      <Collapsible open={expanded} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 py-1.5 text-left text-sm transition-colors hover:text-primary">
          <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
          <span className="font-medium">{node.name || <span className="text-muted-foreground">{t("groups.unnamedRange")}</span>}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{node.rangeStart}-{node.rangeEnd}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {childBlocks}
          {matchingGas.length > 0 && (
            <div className="ml-5 space-y-0.5 py-1">
              {matchingGas.map((g) => (
                <div key={g.raw} className="flex items-center justify-between gap-3 rounded px-2 py-1 text-sm hover:bg-secondary/50">
                  <GaLabel name={g.name} address={g.address} className="min-w-0" />
                  <DptBadge dpt={g.dpt} />
                </div>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function hasMatch(node: GroupRangeNode, filter: string): boolean {
  return node.addresses.some((g) => `${g.address} ${g.name} ${g.dpt}`.toLowerCase().includes(filter)) || node.children.some((c) => hasMatch(c, filter));
}

// Count the group addresses matching the current filter, across the whole tree.
function countMatches(nodes: GroupRangeNode[], filter: string): number {
  let n = 0;
  for (const node of nodes) {
    n += node.addresses.filter((g) => !filter || `${g.address} ${g.name} ${g.dpt}`.toLowerCase().includes(filter)).length;
    n += countMatches(node.children, filter);
  }
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

  // Matching-address count tracks the current filter, like the device list.
  const matched = useMemo(() => countMatches(project?.groupRanges ?? [], filter), [project, filter]);

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
        <Card className="p-4">
          {project.groupRanges.map((r) => <RangeBlock key={r.id} node={r} depth={0} filter={filter} />)}
        </Card>
      )}
    </div>
  );
}
