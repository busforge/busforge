import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ProjectData } from "../api.ts";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "./Empty.tsx";

const manuf = (n: number) => `M-${n.toString(16).toUpperCase().padStart(4, "0")}`;

export function DevicesView({ project }: { project: ProjectData | null }) {
  const [q, setQ] = useState("");
  const devices = useMemo(() => {
    if (!project) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return project.devices;
    return project.devices.filter((d) => `${d.ia} ${d.name} ${manuf(d.manufacturer)}`.toLowerCase().includes(needle));
  }, [project, q]);

  if (!project) return <EmptyState>No project imported yet.</EmptyState>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Filter devices…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <span className="font-mono text-xs text-muted-foreground">{devices.length} / {project.devices.length}</span>
      </div>

      {/* Table on wide screens. */}
      <Card className="hidden overflow-hidden py-0 sm:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-28">Address</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-32">Manufacturer</TableHead>
              <TableHead>Application</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((d) => (
              <TableRow key={d.ia}>
                <TableCell className="font-mono text-primary">{d.ia}</TableCell>
                <TableCell className="font-medium">{d.name || <span className="text-muted-foreground">(unnamed)</span>}</TableCell>
                <TableCell><Badge variant="outline" className="font-mono">{manuf(d.manufacturer)}</Badge></TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{d.appRef}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Cards on mobile. */}
      <div className="space-y-2 sm:hidden">
        {devices.map((d) => (
          <Card key={d.ia} className="gap-2 p-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-primary">{d.ia}</span>
              <Badge variant="outline" className="font-mono text-[10px]">{manuf(d.manufacturer)}</Badge>
            </div>
            <div className="font-medium">{d.name || <span className="text-muted-foreground">(unnamed)</span>}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{d.appRef}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
