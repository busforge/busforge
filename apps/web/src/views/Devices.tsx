import { useEffect, useMemo, useRef } from "react";
import { Search, X, Zap } from "lucide-react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { Device } from "../api.ts";
import { useProject } from "../queries.ts";
import { ChangePill, changeTotal as total } from "@/components/ChangePill.tsx";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const manuf = (n: number) => `M-${n.toString(16).toUpperCase().padStart(4, "0")}`;
const isChanged = (d: Device) => total(d.changes) > 0;

export function DevicesView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);

  // Filter state is URL-encoded so back/forward and reload restore it.
  const navigate = useNavigate({ from: "/projects/$projectId/devices" });
  const search = useSearch({ from: "/projects/$projectId/devices" });
  const q = search.q ?? "";
  const onlyChanged = search.changed ?? false;
  const setQ = (val: string) => navigate({ search: (p) => ({ ...p, q: val || undefined }), replace: true });
  const toggleChanged = () => navigate({ search: (p) => ({ ...p, changed: p.changed ? undefined : true }), replace: true });

  const all = project?.devices ?? [];
  // Search across address, name, manufacturer and the server-built deep-search
  // blob (device comment + channel/actuator names).
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((d) => `${d.ia} ${d.name} ${manuf(d.manufacturer)} ${d.searchText ?? ""}`.toLowerCase().includes(needle));
  }, [all, q]);

  // "to program" count tracks the current search, not the whole project.
  const changedCount = searched.filter(isChanged).length;
  const anyChanged = all.some(isChanged);

  const devices = useMemo(() => {
    const list = onlyChanged ? searched.filter(isChanged) : searched;
    // Devices with unprogrammed changes float to the top (stable within groups).
    return [...list].sort((a, b) => (isChanged(b) ? 1 : 0) - (isChanged(a) ? 1 : 0));
  }, [searched, onlyChanged]);

  // Carry the current filter into the device URL so its back button and match
  // highlighting can reuse it.
  const listSearch = { q: q || undefined, changed: onlyChanged || undefined };
  const row = (d: Device) => ({
    to: "/projects/$projectId/devices/$deviceId" as const,
    params: { projectId, deviceId: d.id },
    search: listSearch,
  });

  // Cmd/Ctrl+F focuses the device search instead of the browser find.
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={searchRef} placeholder={t("devices.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} className="px-9" data-testid="device-search" />
          {q && (
            <button
              type="button" aria-label={t("devices.clearSearch")} onClick={() => setQ("")} data-testid="device-search-clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {anyChanged && (
            <Button
              size="sm" variant="outline" aria-pressed={onlyChanged}
              disabled={!onlyChanged && changedCount === 0}
              onClick={toggleChanged} data-testid="filter-changed"
              className={cn("gap-1.5 font-mono text-xs", onlyChanged ? "border-primary/50 bg-primary/10 text-primary" : "text-primary")}
              title={t("devices.toProgramTitle")}
            >
              <Zap className="size-3.5" /> {t("devices.toProgram", { count: changedCount })}
            </Button>
          )}
          <span className="font-mono text-xs text-muted-foreground">{t("devices.count", { shown: devices.length, total: all.length })}</span>
        </div>
      </div>

      {/* Table on wide screens. */}
      <Card className={cn("hidden overflow-hidden py-0", devices.length > 0 && "sm:block")}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-28">{t("devices.colAddress")}</TableHead>
              <TableHead>{t("devices.colName")}</TableHead>
              <TableHead className="w-32">{t("devices.colManufacturer")}</TableHead>
              <TableHead>{t("devices.colApplication")}</TableHead>
              <TableHead className="w-28 text-right">{t("devices.colStatus")}</TableHead>
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
                  <TableCell className="font-medium"><Link {...row(d)} className="block">{d.name || <span className="text-muted-foreground">{t("common.unnamed")}</span>}</Link></TableCell>
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
                <div className="font-medium">{d.name || <span className="text-muted-foreground">{t("common.unnamed")}</span>}</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-muted-foreground">{d.appRef}</span>
                  <ChangePill changes={d.changes} />
                </div>
              </Card>
            </Link>
          );
        })}
      </div>

      {devices.length === 0 && (
        <p className="py-10 text-center text-sm text-muted-foreground" data-testid="devices-empty">
          {onlyChanged ? t("devices.emptyChanged") : t("devices.emptySearch")}
        </p>
      )}
    </div>
  );
}
