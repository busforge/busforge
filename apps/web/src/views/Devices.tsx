import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, X, Zap, Plus, Loader2, Cpu, FolderUp, FolderPlus, Building2, Check, ChevronsUpDown, Pencil, Trash2, MapPin, ShieldCheck } from "lucide-react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Device, type CatalogProduct, type SpaceNode } from "../api.ts";
import { useProject, useCatalog, useSpaceEdit, qk } from "../queries.ts";
import { ChangePill, changeTotal as total } from "@/components/ChangePill.tsx";
import { DeviceLabel } from "@/components/DeviceLabel.tsx";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { errMsg } from "../lib/apiError.ts";

const manuf = (n: number) => `M-${n.toString(16).toUpperCase().padStart(4, "0")}`;
const isChanged = (d: Device) => total(d.changes) > 0;

// Numeric individual-address order (area.line.device), matching how ETS sorts the
// device tree. A plain string sort would put "1.1.10" before "1.1.9".
const byIa = (a: Device, b: Device): number => {
  const pa = a.ia.split(".").map(Number);
  const pb = b.ia.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

// The resolved view of a space: its devices (address-sorted) and child spaces.
// Mirrors the group-address page's filtered range tree, so a floor renders as a
// heading + one card, with rooms as sub-headings inside it.
interface SpaceView { id: number; type: string; name: string; devices: Device[]; children: SpaceView[]; }

// The ETS space type a new child gets, inferred from its parent: a building holds
// floors, a floor holds rooms, anything deeper holds rooms too. Permissive on the
// server, so this is only the sensible default the UI offers.
function childType(parentType: string): string {
  if (parentType === "Building") return "Floor";
  if (parentType === "Floor") return "Room";
  return "Room";
}

// Resolve a space subtree for rendering. When filtering, devices are filtered and
// spaces with nothing left (no devices, no surviving children) are dropped; when
// organising, the whole tree is kept (empty spaces included, so they can be
// renamed / filled / removed).
function resolveTree(node: SpaceNode, byId: Map<string, Device>, passes: (d: Device) => boolean, filtering: boolean): SpaceView | null {
  let devices = node.deviceIds.map((id) => byId.get(id)).filter((d): d is Device => !!d);
  if (filtering) devices = devices.filter(passes);
  devices.sort(byIa);
  const children = node.children.map((c) => resolveTree(c, byId, passes, filtering)).filter((c): c is SpaceView => c !== null);
  if (filtering && devices.length === 0 && children.length === 0) return null;
  return { id: Number(node.id), type: node.type, name: node.name, devices, children };
}

// Every device id placed in any space of the whole project (all buildings),
// to find the devices with no location assignment.
function assignedIds(locations: SpaceNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (n: SpaceNode) => { n.deviceIds.forEach((id) => ids.add(id)); n.children.forEach(walk); };
  locations.forEach(walk);
  return ids;
}

// deviceId -> the DB id of the space it sits in (across all buildings), so a card
// can show and change its current room.
function deviceSpaceMap(locations: SpaceNode[]): Map<string, number> {
  const m = new Map<string, number>();
  const walk = (n: SpaceNode) => { n.deviceIds.forEach((id) => m.set(id, Number(n.id))); n.children.forEach(walk); };
  locations.forEach(walk);
  return m;
}

// Flat, path-labelled list of every space, for the per-device room picker. The
// building name is included in the label only when there is more than one building.
function spaceTargets(locations: SpaceNode[]): { id: number; label: string }[] {
  const multi = locations.length > 1;
  const out: { id: number; label: string }[] = [];
  const rec = (n: SpaceNode, path: string) => {
    const here = path ? `${path} › ${n.name}` : n.name;
    out.push({ id: Number(n.id), label: here });
    n.children.forEach((c) => rec(c, here));
  };
  for (const b of locations) {
    if (multi) rec(b, "");
    else { out.push({ id: Number(b.id), label: b.name }); b.children.forEach((c) => rec(c, "")); }
  }
  return out;
}

// Total devices in a space subtree (for counts + the delete-confirm warning).
function countDevices(v: SpaceView): number {
  return v.devices.length + v.children.reduce((n, c) => n + countDevices(c), 0);
}

// Does any device in the subtree have unprogrammed changes? (drives the nav/header dot)
function subtreeChanged(v: SpaceView): boolean {
  return v.devices.some(isChanged) || v.children.some(subtreeChanged);
}

// Editor openers + labels handed to the room sub-headings, so the recursive
// SubSpace component can offer add/rename/delete without re-deriving them.
interface SpaceActions {
  editable: boolean;
  openCreate: (parentId: number, parentType: string) => void;
  openRename: (spaceId: number, type: string, name: string) => void;
  openDelete: (v: SpaceView) => void;
  typeName: (ty: string) => string;
  addLabel: (parentType: string) => string;
  renameLabel: string;
  deleteLabel: string;
}

// A small ghost icon button for the heading edit affordances (mirrors the
// group-address page). Stops propagation so it never triggers a parent click.
function IconBtn({ label, onClick, children, danger, testId }: { label: string; onClick: () => void; children: ReactNode; danger?: boolean; testId?: string }) {
  return (
    <button
      type="button" aria-label={label} title={label} data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn("rounded p-1 text-muted-foreground hover:bg-secondary", danger ? "hover:text-destructive" : "hover:text-foreground")}
    >
      {children}
    </button>
  );
}

export function DevicesView() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const { data: project } = useProject(projectId);

  // Filter state is URL-encoded so back/forward and reload restore it.
  const navigate = useNavigate({ from: "/projects/$projectId/devices" });
  const search = useSearch({ from: "/projects/$projectId/devices" });
  const q = search.q ?? "";
  const onlyChanged = search.changed ?? false;
  const setQ = (val: string) => { void navigate({ search: (p) => ({ ...p, q: val || undefined }), replace: true }); };
  const toggleChanged = () => { void navigate({ search: (p) => ({ ...p, changed: p.changed ? undefined : true }), replace: true }); };
  const setBuilding = (id: string) => { void navigate({ search: (p) => ({ ...p, b: id || undefined }), replace: true }); };

  const all = project?.devices ?? [];
  const locations = project?.locations ?? [];
  const byId = useMemo(() => new Map(all.map((d) => [d.id, d])), [all]);

  // The buildings to choose between (top-level spaces). The selector only appears
  // when there is more than one; otherwise the single building is implicit.
  const buildings = locations;
  const selectedBuilding = buildings.find((b) => b.id === search.b) ?? buildings[0];

  // A device passes the active filters (deep search + "to program" toggle).
  const passes = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (d: Device) =>
      (!needle || `${d.ia} ${d.name} ${manuf(d.manufacturer)} ${d.searchText ?? ""}`.toLowerCase().includes(needle)) &&
      (!onlyChanged || isChanged(d));
  }, [q, onlyChanged]);

  const changedCount = all.filter((d) => isChanged(d) && passes(d)).length;
  const anyChanged = all.some(isChanged);
  const filtering = q.trim() !== "" || onlyChanged;
  const spaceEdit = useSpaceEdit(projectId);
  const targets = useMemo(() => spaceTargets(locations), [locations]);
  const deviceSpace = useMemo(() => deviceSpaceMap(locations), [locations]);

  // The selected building's floors as resolved view-trees (each a heading + card,
  // rooms as sub-headings inside), plus the building's own direct devices (rare) and
  // a project-wide "Unassigned" group. While filtering, empty spaces are dropped;
  // otherwise the whole tree shows so it can be organised.
  const floors = useMemo(
    () => (selectedBuilding ? selectedBuilding.children.map((c) => resolveTree(c, byId, passes, filtering)).filter((v): v is SpaceView => v !== null) : []),
    [selectedBuilding, byId, passes, filtering],
  );
  const buildingDevices = useMemo(() => {
    if (!selectedBuilding) return [];
    let ds = selectedBuilding.deviceIds.map((id) => byId.get(id)).filter((d): d is Device => !!d);
    if (filtering) ds = ds.filter(passes);
    return ds.sort(byIa);
  }, [selectedBuilding, byId, passes, filtering]);
  const unassigned = useMemo(() => {
    let ds = all.filter((d) => !assignedIds(locations).has(d.id));
    if (filtering) ds = ds.filter(passes);
    return ds.sort(byIa);
  }, [all, locations, passes, filtering]);

  // Fallback when the project carries no building structure: a single flat,
  // address-sorted list, with a hint to re-import for grouping.
  const flat = useMemo(() => (buildings.length ? [] : all.filter(passes).slice().sort(byIa)), [buildings.length, all, passes]);

  const shownCount = buildings.length
    ? floors.reduce((n, f) => n + countDevices(f), 0) + buildingDevices.length + unassigned.length
    : flat.length;
  const hasContent = floors.length > 0 || buildingDevices.length > 0 || unassigned.length > 0;

  // Carry the current filter (incl. selected building) into the device URL so its
  // back button and match highlighting can reuse it.
  const listSearch = { q: q || undefined, changed: onlyChanged || undefined, b: search.b };
  const row = (d: Device) => ({
    to: "/projects/$projectId/devices/$deviceId" as const,
    params: { projectId, deviceId: d.id },
    search: listSearch,
  });

  // Scroll-spy over the section headings, mirroring the group-address page: the
  // active section is the last whose heading sits above a small top offset.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [activeSec, setActiveSec] = useState<string | null>(null);
  const registerRef = (id: string) => (el: HTMLElement | null) => { if (el) cardRefs.current.set(id, el); else cardRefs.current.delete(id); };
  const scrollToSec = (id: string) => cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      let active: string | null = null;
      let bestTop = -Infinity;
      cardRefs.current.forEach((el, id) => {
        const top = el.getBoundingClientRect().top;
        if (top <= 112 && top > bestTop) { bestTop = top; active = id; }
      });
      if (!active && floors[0]) active = `sec-${floors[0].id}`;
      setActiveSec(active);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [floors, unassigned]);

  const [addOpen, setAddOpen] = useState(false);
  // Building-structure editing dialogs. `nameDialog` serves both create (a child of
  // `parentId` with the inferred `type`) and rename (`spaceId` set). `deleteTarget`
  // drives the delete confirmation, carrying the subtree device count for the warning.
  const [nameDialog, setNameDialog] = useState<{ parentId: number | null; spaceId?: number; type: string; initial: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ spaceId: number; name: string; deviceCount: number } | null>(null);
  const editable = !filtering; // organise (add/rename/delete) only in the unfiltered view
  // Localized space type name (Building/Floor/Room); unknown types fall back to raw.
  const typeName = (ty: string) => t(`devices.type.${ty}`, { defaultValue: ty });

  // Editor openers, passed down to the room sub-headings.
  const openCreate = (parentId: number, parentType: string) => setNameDialog({ parentId, type: childType(parentType), initial: "" });
  const openRename = (spaceId: number, type: string, name: string) => setNameDialog({ parentId: null, spaceId, type, initial: name });
  const openDelete = (v: SpaceView) => setDeleteTarget({ spaceId: v.id, name: v.name, deviceCount: countDevices(v) });
  const actions: SpaceActions = { editable, openCreate, openRename, openDelete, typeName, addLabel: (ty) => t("devices.addType", { type: typeName(childType(ty)) }), renameLabel: t("devices.rename"), deleteLabel: t("devices.delete") };

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

  // One device as a full-width row (readable name), mirroring the group-address rows.
  const deviceRow = (d: Device) => (
    <div key={d.id} className="group/row flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-secondary/50" data-testid={`device-${d.ia}`}>
      <Link {...row(d)} className="flex min-w-0 flex-1 items-center"><DeviceLabel name={d.name} ia={d.ia} className="min-w-0" /></Link>
      <div className="flex shrink-0 items-center gap-2">
        {d.secure && (
          <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400" title={t("devices.secure")} data-testid={`device-secure-${d.ia}`}>
            <ShieldCheck className="size-3" /> <span className="hidden sm:inline">{t("devices.secure")}</span>
          </Badge>
        )}
        <Badge variant="outline" className="hidden font-mono text-[10px] sm:inline-flex">{manuf(d.manufacturer)}</Badge>
        <ChangePill changes={d.changes} />
        <RoomSelect
          targets={targets} value={deviceSpace.get(d.id) ?? null} deviceIa={d.ia}
          busy={spaceEdit.assignDevice.isPending}
          onChange={(spaceId) => spaceEdit.assignDevice.mutate({ deviceId: d.id, spaceId }, { onError: (e) => toast.error(t("devices.assignFailed"), { description: errMsg(t, e) }) })}
        />
      </div>
    </div>
  );
  const deviceRows = (devices: Device[]) => devices.map(deviceRow);

  const navCount = floors.reduce((n, f) => n + 1 + f.children.length, 0) + (unassigned.length ? 1 : 0);
  const showNav = buildings.length > 0 && navCount > 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-3">
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
          {buildings.length > 1 && selectedBuilding && (
            <BuildingCombobox buildings={buildings} value={selectedBuilding.id} onChange={setBuilding} />
          )}
          {editable && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNameDialog({ parentId: null, type: "Building", initial: "" })} data-testid="add-building">
              <Building2 className="size-4" /> {t("devices.addBuilding")}
            </Button>
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
          <span className="font-mono text-xs text-muted-foreground">{t("devices.count", { shown: shownCount, total: all.length })}</span>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="add-device">
            <Plus className="size-4" /> {t("devices.addDevice")}
          </Button>
        </div>
      </div>

      <AddDeviceDialog open={addOpen} onOpenChange={setAddOpen} projectId={projectId} />

      {/* Fallback: no building structure -> a flat, address-sorted list. */}
      {buildings.length === 0 ? (
        <>
          {all.length > 0 && (
            <p className="rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground" data-testid="no-building-data">
              {t("devices.noBuildingData")}
            </p>
          )}
          {flat.length > 0 && <Card><CardContent className="space-y-1 py-4">{deviceRows(flat)}</CardContent></Card>}
        </>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          {showNav && (
            <nav className="lg:sticky lg:top-28 lg:max-h-[calc(100vh-8rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto">
              <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-x-visible lg:pb-0">
                {(() => {
                  const navBtn = (id: string, label: string, sub: boolean, changed: boolean) => {
                    const active = activeSec === id;
                    return (
                      <button
                        key={id} type="button" onClick={() => scrollToSec(id)} data-testid={`nav-${id}`}
                        className={cn(
                          "flex w-full items-center gap-1.5 whitespace-nowrap rounded border-l-2 py-1 pr-2 text-left text-sm transition-colors lg:truncate",
                          sub ? "pl-5" : "pl-2",
                          active ? "border-foreground/50 bg-secondary font-medium text-foreground"
                            : sub ? "border-transparent text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                            : "border-transparent font-medium text-foreground/80 hover:bg-secondary/60 hover:text-foreground",
                        )}
                      >
                        <span className="truncate">{label}</span>
                        {changed && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" title={t("devices.changedDot")} />}
                      </button>
                    );
                  };
                  return (
                    <>
                      {floors.map((floor) => (
                        <li key={floor.id} className="lg:contents">
                          {navBtn(`sec-${floor.id}`, floor.name, false, subtreeChanged(floor))}
                          {floor.children.map((room) => navBtn(`sec-${room.id}`, room.name, true, subtreeChanged(room)))}
                        </li>
                      ))}
                      {unassigned.length > 0 && <li>{navBtn("sec-unassigned", t("devices.unassigned"), false, unassigned.some(isChanged))}</li>}
                    </>
                  );
                })()}
              </ul>
            </nav>
          )}

          <div className="min-w-0 flex-1 space-y-6">
            {selectedBuilding && (
              <div className="flex items-center gap-1 px-1">
                <Building2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground" data-testid="building-name">{selectedBuilding.name}</span>
                {editable && (
                  <div className="flex items-center">
                    <IconBtn label={t("devices.addType", { type: typeName(childType(selectedBuilding.type)) })} onClick={() => openCreate(Number(selectedBuilding.id), selectedBuilding.type)} testId="add-floor"><FolderPlus className="size-4" /></IconBtn>
                    <IconBtn label={t("devices.rename")} onClick={() => openRename(Number(selectedBuilding.id), selectedBuilding.type, selectedBuilding.name)}><Pencil className="size-3.5" /></IconBtn>
                    <IconBtn label={t("devices.delete")} danger onClick={() => setDeleteTarget({ spaceId: Number(selectedBuilding.id), name: selectedBuilding.name, deviceCount: floors.reduce((n, f) => n + countDevices(f), 0) + buildingDevices.length })}><Trash2 className="size-3.5" /></IconBtn>
                  </div>
                )}
              </div>
            )}

            {buildingDevices.length > 0 && (
              <Card><CardContent className="space-y-1 py-4">{deviceRows(buildingDevices)}</CardContent></Card>
            )}

            {floors.map((floor) => (
              <section key={floor.id} className="space-y-2">
                <h2 id={`sec-${floor.id}`} ref={registerRef(`sec-${floor.id}`)} className="group flex scroll-mt-24 items-center gap-2 px-1 text-lg font-semibold text-foreground">
                  <span className="min-w-0 truncate">{floor.name}</span>
                  {countDevices(floor) > 0 && <span className="shrink-0 font-mono text-sm font-normal text-muted-foreground">{countDevices(floor)}</span>}
                  {subtreeChanged(floor) && <span className="size-2 shrink-0 rounded-full bg-primary" title={t("devices.changedDot")} />}
                  {editable && (
                    <div className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <IconBtn label={actions.addLabel(floor.type)} onClick={() => openCreate(floor.id, floor.type)} testId={`add-child-${floor.id}`}><FolderPlus className="size-4" /></IconBtn>
                      <IconBtn label={t("devices.rename")} onClick={() => openRename(floor.id, floor.type, floor.name)} testId={`rename-${floor.id}`}><Pencil className="size-4" /></IconBtn>
                      <IconBtn label={t("devices.delete")} danger onClick={() => openDelete(floor)} testId={`delete-${floor.id}`}><Trash2 className="size-4" /></IconBtn>
                    </div>
                  )}
                </h2>
                <Card>
                  <CardContent className="space-y-1 py-4">
                    {floor.devices.length === 0 && floor.children.length === 0 && (
                      <p className="px-2 text-sm text-muted-foreground">{t("devices.emptyRoom")}</p>
                    )}
                    {deviceRows(floor.devices)}
                    {floor.children.map((room) => (
                      <SubSpace key={room.id} node={room} depth={1} registerRef={registerRef} deviceRows={deviceRows} actions={actions} t={t} />
                    ))}
                  </CardContent>
                </Card>
              </section>
            ))}

            {unassigned.length > 0 && (
              <section className="space-y-2">
                <h2 id="sec-unassigned" ref={registerRef("sec-unassigned")} className="flex scroll-mt-24 items-center gap-2 px-1 text-lg font-semibold text-foreground">
                  <span className="min-w-0 truncate">{t("devices.unassigned")}</span>
                  <span className="shrink-0 font-mono text-sm font-normal text-muted-foreground">{unassigned.length}</span>
                  {unassigned.some(isChanged) && <span className="size-2 shrink-0 rounded-full bg-primary" title={t("devices.changedDot")} />}
                </h2>
                <Card><CardContent className="space-y-1 py-4">{deviceRows(unassigned)}</CardContent></Card>
              </section>
            )}

            {!hasContent && (
              <p className="py-10 text-center text-sm text-muted-foreground" data-testid="devices-empty">
                {filtering ? (onlyChanged ? t("devices.emptyChanged") : t("devices.emptySearch")) : t("devices.emptyBuilding")}
              </p>
            )}
          </div>
        </div>
      )}

      <SpaceNameDialog
        state={nameDialog}
        title={nameDialog ? (nameDialog.spaceId != null ? t("devices.renameTitle") : t("devices.newAreaTitle", { type: typeName(nameDialog.type) })) : ""}
        busy={spaceEdit.createSpace.isPending || spaceEdit.renameSpace.isPending}
        onClose={() => setNameDialog(null)}
        onSubmit={(name) => {
          if (!nameDialog) return;
          const onError = (e: unknown) => toast.error(t("devices.spaceEditFailed"), { description: errMsg(t, e) });
          if (nameDialog.spaceId != null) spaceEdit.renameSpace.mutate({ spaceId: nameDialog.spaceId, name }, { onSuccess: () => setNameDialog(null), onError });
          else spaceEdit.createSpace.mutate({ parentId: nameDialog.parentId, type: nameDialog.type, name }, { onSuccess: () => setNameDialog(null), onError });
        }}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("devices.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("devices.deleteBody", { name: deleteTarget?.name, count: deleteTarget?.deviceCount ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={spaceEdit.deleteSpace.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-space"
              disabled={spaceEdit.deleteSpace.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!deleteTarget) return;
                spaceEdit.deleteSpace.mutate(deleteTarget.spaceId, {
                  onSuccess: () => setDeleteTarget(null),
                  onError: (err) => toast.error(t("devices.spaceEditFailed"), { description: errMsg(t, err) }),
                });
              }}
            >
              {spaceEdit.deleteSpace.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} {t("devices.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// A room (and any deeper space) inside a floor's card: a sub-heading with its
// device rows, then nested sub-spaces indented further. Mirrors the group-address
// page's SubRange.
function SubSpace({ node, depth, registerRef, deviceRows, actions, t }: {
  node: SpaceView;
  depth: number;
  registerRef: (id: string) => (el: HTMLElement | null) => void;
  deviceRows: (devices: Device[]) => ReactNode;
  actions: SpaceActions;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const deep = depth >= 2;
  return (
    <section id={`sec-${node.id}`} ref={depth === 1 ? registerRef(`sec-${node.id}`) : undefined} className={cn("scroll-mt-24 pt-2", deep && "pl-3")}>
      <h4 className={cn("group mt-2 mb-1 flex items-center gap-2 border-l-2 pl-2 text-sm font-semibold", deep ? "border-foreground/15 text-muted-foreground" : "border-foreground/30 text-foreground")}>
        <span className="min-w-0 truncate">{node.name}</span>
        {countDevices(node) > 0 && <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">{countDevices(node)}</span>}
        {subtreeChanged(node) && <span className="size-1.5 shrink-0 rounded-full bg-primary" title={t("devices.changedDot")} />}
        {actions.editable && (
          <div className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <IconBtn label={actions.addLabel(node.type)} onClick={() => actions.openCreate(node.id, node.type)} testId={`add-child-${node.id}`}><Plus className="size-3.5" /></IconBtn>
            <IconBtn label={actions.renameLabel} onClick={() => actions.openRename(node.id, node.type, node.name)} testId={`rename-${node.id}`}><Pencil className="size-3.5" /></IconBtn>
            <IconBtn label={actions.deleteLabel} danger onClick={() => actions.openDelete(node)} testId={`delete-${node.id}`}><Trash2 className="size-3.5" /></IconBtn>
          </div>
        )}
      </h4>
      {deviceRows(node.devices)}
      {node.devices.length === 0 && node.children.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">{t("devices.emptyRoom")}</p>
      )}
      {node.children.map((c) => (
        <SubSpace key={c.id} node={c} depth={depth + 1} registerRef={registerRef} deviceRows={deviceRows} actions={actions} t={t} />
      ))}
    </section>
  );
}

// Create/rename dialog for a space. A single text input; submit on Enter or button.
function SpaceNameDialog({ state, title, busy, onClose, onSubmit }: {
  state: { initial: string } | null;
  title: string; busy: boolean; onClose: () => void; onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  useEffect(() => { if (state) setName(state.initial); }, [state]);
  const submit = () => { const v = name.trim(); if (v) onSubmit(v); };
  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="space-name-input"
          placeholder={t("devices.spaceNamePlaceholder")}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={busy || !name.trim()} data-testid="space-name-submit">
            {busy && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Per-device room picker (lazy-mounted, like the GA combobox): pick any space to
// move the device there, or remove it from its room. Mounts the Command machinery
// only once opened, since the list can hold many of these.
function RoomSelect({ targets, value, deviceIa, busy, onChange }: {
  targets: { id: number; label: string }[];
  value: number | null; deviceIa: string; busy: boolean; onChange: (spaceId: number | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const trigger = (
    <Button
      variant="ghost" size="icon" role="combobox" disabled={busy} data-testid={`room-select-${deviceIa}`}
      className={cn("size-7 text-muted-foreground", value == null && "text-primary")}
      title={value == null ? t("devices.assignRoom") : t("devices.changeRoom")}
    >
      <MapPin className="size-3.5" />
    </Button>
  );
  if (!active) return <span onClick={() => { setActive(true); setOpen(true); }}>{trigger}</span>;
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setActive(false); }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder={t("devices.roomSearchPlaceholder")} />
          <CommandList>
            <CommandEmpty>{t("devices.noRoomMatch")}</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem value="__unassign__" onSelect={() => { onChange(null); setOpen(false); }} className="gap-2 text-muted-foreground">
                  <X className="size-3.5" /> <span>{t("devices.removeFromRoom")}</span>
                </CommandItem>
              )}
              {targets.map((o) => (
                <CommandItem key={o.id} value={`${o.label} ${o.id}`} onSelect={() => { onChange(o.id); setOpen(false); }} className="gap-2">
                  <Check className={cn("size-3.5 shrink-0", o.id === value ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Searchable building picker (typeahead), shown only when a project has more than
// one top-level building. Mirrors the group-address combobox pattern.
function BuildingCombobox({ buildings, value, onChange }: {
  buildings: SpaceNode[]; value: string; onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const sel = buildings.find((b) => b.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" data-testid="building-select" className="h-9 max-w-56 justify-between gap-2 font-normal">
          <Building2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{sel?.name || t("devices.selectBuilding")}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={t("devices.buildingSearchPlaceholder")} />
          <CommandList>
            <CommandEmpty>{t("devices.noBuildingMatch")}</CommandEmpty>
            <CommandGroup>
              {buildings.map((b) => (
                <CommandItem key={b.id} value={b.name} onSelect={() => { onChange(b.id); setOpen(false); }} className="gap-2">
                  <Check className={cn("size-3.5 shrink-0", b.id === value ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 truncate">{b.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Catalog picker: search the global product catalog and place the chosen product
// into this project as a new device. The server allocates the address; on success
// we refresh the device list and open the new device's configuration.
function AddDeviceDialog({
  open, onOpenChange, projectId,
}: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const prodRef = useRef<HTMLInputElement>(null);
  const { data: catalog = [], isLoading } = useCatalog(open);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter((p) => `${p.name} ${p.orderNumber} ${manuf(p.manufacturer)}`.toLowerCase().includes(needle));
  }, [catalog, q]);

  const add = useMutation({
    mutationFn: (p: CatalogProduct) => api.addDevice(projectId, p.appRef, p.productRef),
    onSuccess: (res, p) => {
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      toast.success(t("catalog.added", { name: p.name }));
      onOpenChange(false);
      setQ("");
      void navigate({ to: "/projects/$projectId/devices/$deviceId", params: { projectId, deviceId: res.id } });
    },
    onError: (e) => toast.error(t("catalog.failed"), { description: errMsg(t, e) }),
  });

  // Ingest an official .knxprod product database into the catalog, then refresh it.
  const importProd = useMutation({
    mutationFn: (file: File) => api.importCatalog(file),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.catalog });
      toast.success(t("catalog.imported", { count: res.products }));
    },
    onError: (e) => toast.error(t("catalog.importFailed"), { description: errMsg(t, e) }),
  });
  const pickProd = (f: File | null) => { if (f) importProd.mutate(f); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setQ(""); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Cpu className="size-4 text-primary" /> {t("catalog.title")}</DialogTitle>
          <DialogDescription>{t("catalog.description")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus placeholder={t("catalog.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} className="px-9" data-testid="catalog-search" />
        </div>

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("common.loading")}</div>
          ) : catalog.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm text-muted-foreground">{t("catalog.empty")}</p>
              <Button variant="outline" size="sm" disabled={importProd.isPending} onClick={() => prodRef.current?.click()} data-testid="catalog-import-empty">
                {importProd.isPending ? <Loader2 className="size-4 animate-spin" /> : <FolderUp className="size-4 text-primary" />} {t("catalog.importProd")}
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("catalog.noMatch")}</p>
          ) : (
            filtered.map((p) => (
              <button
                key={`${p.appRef}|${p.productRef}`}
                type="button"
                disabled={add.isPending}
                onClick={() => add.mutate(p)}
                data-testid="catalog-item"
                className="flex w-full items-center justify-between gap-3 rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-50"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.name || p.productRef}</div>
                  {p.orderNumber && <div className="font-mono text-[11px] text-muted-foreground">{t("catalog.orderNo")} {p.orderNumber}</div>}
                </div>
                <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{manuf(p.manufacturer)}</Badge>
              </button>
            ))
          )}
        </div>

        {catalog.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <span>{t("catalog.count", { count: catalog.length })}</span>
            <Button variant="ghost" size="sm" disabled={importProd.isPending} onClick={() => prodRef.current?.click()} data-testid="catalog-import">
              {importProd.isPending ? <Loader2 className="size-4 animate-spin" /> : <FolderUp className="size-4 text-primary" />} {t("catalog.importProd")}
            </Button>
          </div>
        )}

        <input
          ref={prodRef} type="file" accept=".knxprod" className="hidden"
          onChange={(e) => { pickProd(e.target.files?.[0] ?? null); e.target.value = ""; }}
        />
      </DialogContent>
    </Dialog>
  );
}
