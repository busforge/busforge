import { useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { GroupRangeNode, ProjectData } from "../api.ts";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { EmptyState } from "./Empty.tsx";

function RangeBlock({ node, depth, filter }: { node: GroupRangeNode; depth: number; filter: string }) {
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
          <span className="font-medium">{node.name || <span className="text-muted-foreground">(unnamed range)</span>}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{node.rangeStart}-{node.rangeEnd}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {childBlocks}
          {matchingGas.length > 0 && (
            <div className="ml-5 space-y-0.5 py-1">
              {matchingGas.map((g) => (
                <div key={g.raw} className="flex items-center gap-3 rounded px-2 py-1 text-sm hover:bg-secondary/50">
                  <span className="w-16 shrink-0 font-mono text-primary">{g.address}</span>
                  <span className="flex-1 truncate">{g.name || <span className="text-muted-foreground">(unnamed)</span>}</span>
                  {g.dpt && <Badge variant="outline" className="font-mono text-[10px]">{g.dpt}</Badge>}
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

export function GroupAddressesView({ project }: { project: ProjectData | null }) {
  const [q, setQ] = useState("");
  const filter = q.trim().toLowerCase();

  if (!project) return <EmptyState>No project imported yet.</EmptyState>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Filter group addresses…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <span className="font-mono text-xs text-muted-foreground">{project.gaCount} addresses</span>
      </div>
      <Card className="p-4">
        {project.groupRanges.map((r) => <RangeBlock key={r.id} node={r} depth={0} filter={filter} />)}
      </Card>
    </div>
  );
}
