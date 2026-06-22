import { useMemo, useState } from "react";
import { Search, Zap } from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import type { Device } from "../api.ts";
import { useProject } from "../queries.ts";
import { ChangePill, changeTotal as total } from "@/components/ChangePill.tsx";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const manuf = (n: number) => `M-${n.toString(16).toUpperCase().padStart(4, "0")}`;

export function DevicesView() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);
  const [q, setQ] = useState("");

  const all = project?.devices ?? [];
  const devices = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? all.filter((d) => `${d.ia} ${d.name} ${manuf(d.manufacturer)}`.toLowerCase().includes(needle))
      : all;
    // Devices with unprogrammed changes float to the top (stable within groups).
    return [...filtered].sort((a, b) => (total(b.changes) > 0 ? 1 : 0) - (total(a.changes) > 0 ? 1 : 0));
  }, [all, q]);

  const changedCount = all.filter((d) => total(d.changes) > 0).length;

  const row = (d: Device) => ({
    to: "/projects/$projectId/devices/$deviceId" as const,
    params: { projectId, deviceId: d.id },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Filter devices…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <div className="flex items-center gap-3">
          {changedCount > 0 && (
            <span className="inline-flex items-center gap-1.5 font-mono text-xs text-primary" title="Devices with edits not yet programmed">
              <Zap className="size-3.5" /> {changedCount} to program
            </span>
          )}
          <span className="font-mono text-xs text-muted-foreground">{devices.length} / {all.length}</span>
        </div>
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
              <TableHead className="w-28 text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((d) => {
              const changed = total(d.changes) > 0;
              return (
                <TableRow key={d.ia} className={cn("cursor-pointer", changed && "bg-primary/[0.04]")} data-testid={`device-${d.ia}`}>
                  <TableCell className={cn("font-mono text-primary", changed && "border-l-2 border-primary")}>
                    <Link {...row(d)} className="block">{d.ia}</Link>
                  </TableCell>
                  <TableCell className="font-medium"><Link {...row(d)} className="block">{d.name || <span className="text-muted-foreground">(unnamed)</span>}</Link></TableCell>
                  <TableCell><Badge variant="outline" className="font-mono">{manuf(d.manufacturer)}</Badge></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{d.appRef}</TableCell>
                  <TableCell className="text-right"><ChangePill changes={d.changes} /></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Cards on mobile. */}
      <div className="space-y-2 sm:hidden">
        {devices.map((d) => {
          const changed = total(d.changes) > 0;
          return (
            <Link key={d.ia} {...row(d)} className="block">
              <Card className={cn("gap-2 p-3", changed && "border-l-2 border-l-primary bg-primary/[0.04]")}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-primary">{d.ia}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">{manuf(d.manufacturer)}</Badge>
                </div>
                <div className="font-medium">{d.name || <span className="text-muted-foreground">(unnamed)</span>}</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-muted-foreground">{d.appRef}</span>
                  <ChangePill changes={d.changes} />
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
