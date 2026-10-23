import { useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronsUpDown, Loader2, Repeat2, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, type AppComObject, type CatalogProduct, type Device, type DeviceConfigView, type ReplaceMappingEntry } from "../api.ts";
import { useAppComObjects, useCatalog, useDeviceEdit } from "../queries.ts";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GaLabel } from "@/components/GaLabel.tsx";
import type { GaOption } from "./GaCombobox.tsx";
import { cn } from "@/lib/utils";
import { errMsg } from "../lib/apiError.ts";

const manuf = (n: number) => `M-${n.toString(16).toUpperCase().padStart(4, "0")}`;

// One row of the mapping table: a com-object the device currently links to a GA.
interface CurrentLink { refId: string; number: number; label: string; gaRaw: number }

// The device's current links, straight from the loaded config view. Only VISIBLE
// com-objects appear here; a link preserved on a hidden com-object (GA-preserve)
// cannot be offered, and the server then refuses the replace as incomplete
// (REPLACE_MAPPING_INCOMPLETE) rather than dropping it silently.
function currentLinks(view: DeviceConfigView): CurrentLink[] {
  const out: CurrentLink[] = [];
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind !== "comObject") continue;
    const co = it.comObject;
    const gaRaw = co.gaRaw;
    if (gaRaw != null) out.push({ refId: co.refId, number: co.number, label: co.functionText || co.name, gaRaw });
  }
  return out.sort((a, b) => a.number - b.number);
}

// Replace the device's product because the physical device was swapped for another
// model: pick the new catalog product, then map every current GA link onto a
// com-object of the new application (or drop it explicitly). A project-model edit
// only; the new hardware still needs commissioning afterwards.
export function ReplaceDeviceDialog({ open, onOpenChange, projectId, device, view, gaOptions }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  device: Device;
  view: DeviceConfigView;
  gaOptions: GaOption[];
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  // from-refId -> chosen target refId (null = drop). A row absent here is UNCHOSEN,
  // which blocks Confirm: an implicit drop is exactly the silent loss we refuse.
  const [mapping, setMapping] = useState<Record<string, string | null>>({});

  const { data: catalog = [], isLoading: catalogLoading } = useCatalog(open);
  const universe = useAppComObjects(product?.appProgramId ?? "", open && !!product);
  const { replaceProduct } = useDeviceEdit(projectId, device.id);

  const links = useMemo(() => currentLinks(view), [view]);
  const gaByRaw = useMemo(() => new Map(gaOptions.map((o) => [o.raw, o])), [gaOptions]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter((p) => `${p.name} ${p.orderNumber} ${manuf(p.manufacturer)}`.toLowerCase().includes(needle));
  }, [catalog, q]);

  const reset = () => { setQ(""); setProduct(null); setMapping({}); replaceProduct.reset(); };
  const close = (o: boolean) => { if (!o) reset(); onOpenChange(o); };

  const allChosen = links.every((l) => l.refId in mapping);
  // Client-side echo of the server's collision refusal, so the user sees it
  // while mapping instead of only on Confirm.
  const chosenTargets = links.map((l) => mapping[l.refId]).filter((v): v is string => typeof v === "string");
  const hasCollision = new Set(chosenTargets).size !== chosenTargets.length;
  const canConfirm = !!product && universe.isSuccess && allChosen && !hasCollision && !replaceProduct.isPending;

  const confirm = () => {
    if (!product || !allChosen) return;
    const entries: ReplaceMappingEntry[] = links.map((l) => ({ from: l.refId, to: mapping[l.refId] ?? null }));
    replaceProduct.mutate({ appRef: product.appRef, productRef: product.productRef, mapping: entries }, {
      onSuccess: () => { toast.success(t("replace.done")); close(false); },
      // Kept in the dialog (inline box below) so the mapping is not lost on a refusal.
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={cn(product ? "max-w-2xl" : "max-w-lg")} backdropClose={!product} dismissible={!replaceProduct.isPending}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat2 className="size-4 text-primary" /> {t("replace.title")}
          </DialogTitle>
          <DialogDescription>{product ? t("replace.mapDescription") : t("replace.pickDescription")}</DialogDescription>
        </DialogHeader>

        {!product ? (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus placeholder={t("catalog.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} className="px-9" data-testid="replace-search" />
            </div>
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {catalogLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("common.loading")}</div>
              ) : catalog.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("catalog.empty")}</p>
              ) : filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t("catalog.noMatch")}</p>
              ) : (
                filtered.map((p) => (
                  <button
                    key={`${p.appRef}|${p.productRef}`}
                    type="button"
                    onClick={() => setProduct(p)}
                    data-testid="replace-catalog-item"
                    className="flex w-full items-center justify-between gap-3 rounded-md border border-transparent px-3 py-2 text-left outline-none transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{p.name || p.productRef}</div>
                      {p.orderNumber && <div className="font-mono text-[11px] text-muted-foreground">{t("catalog.orderNo")} {p.orderNumber}</div>}
                    </div>
                    <Badge tone="outline" size="sm" mono>{manuf(p.manufacturer)}</Badge>
                  </button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm">
              <span className="min-w-0 truncate font-medium">{product.name || product.productRef}</span>
              <Badge tone="outline" size="sm" mono>{manuf(product.manufacturer)}</Badge>
            </div>

            {universe.isLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("replace.loadingObjects")}</div>
            ) : universe.error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="replace-universe-error">
                {errMsg(t, universe.error)}
              </p>
            ) : links.length === 0 ? (
              <p className="rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-sm text-muted-foreground" data-testid="replace-no-links">
                {t("replace.noLinks")}
              </p>
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">{t("replace.colCurrent")}</th>
                      <th className="px-3 py-2 font-medium">{t("replace.colGa")}</th>
                      <th className="px-3 py-2 font-medium">{t("replace.colNew")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((l) => {
                      const ga = gaByRaw.get(l.gaRaw);
                      return (
                        <tr key={l.refId} className="border-b border-border/40 last:border-0">
                          <td className="px-3 py-1.5">
                            <span className="flex items-center gap-2">
                              <Badge tone="outline" size="sm" mono>{l.number}</Badge>
                              <span className="min-w-0 truncate" title={l.label}>{l.label}</span>
                            </span>
                          </td>
                          <td className="px-3 py-1.5">
                            {ga ? <GaLabel name={ga.name} address={ga.address} className="min-w-0" /> : <span className="font-mono text-xs">{l.gaRaw}</span>}
                          </td>
                          <td className="w-64 px-3 py-1.5">
                            <TargetPicker
                              options={universe.data ?? []}
                              value={l.refId in mapping ? mapping[l.refId] : undefined}
                              onChange={(to) => setMapping((m) => ({ ...m, [l.refId]: to }))}
                              testId={`replace-target-${l.number}`}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {hasCollision && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {t("replace.collision")}
              </p>
            )}
            {!!replaceProduct.error && (
              <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="replace-error">
                <p>{errMsg(t, replaceProduct.error)}</p>
                {/* Every row shown here was covered, so an "incomplete" refusal means the
                    device holds a link on a com-object the current parameters HIDE (its GA
                    is preserved). That row cannot be listed from the config view, so name
                    the way out instead of leaving a dead end. */}
                {replaceProduct.error instanceof ApiError && replaceProduct.error.code === "REPLACE_MAPPING_INCOMPLETE" && allChosen && (
                  <p className="text-xs text-destructive/80">{t("replace.hiddenLinkHint")}</p>
                )}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          {product && (
            <Button variant="outline" disabled={replaceProduct.isPending} onClick={() => { setProduct(null); setMapping({}); replaceProduct.reset(); }} data-testid="replace-back">
              {t("replace.back")}
            </Button>
          )}
          <Button variant="ghost" disabled={replaceProduct.isPending} onClick={() => close(false)}>{t("common.cancel")}</Button>
          {product && (
            <Button onClick={confirm} disabled={!canConfirm} data-testid="confirm-replace">
              {replaceProduct.isPending ? <Loader2 className="size-4 animate-spin" /> : <Repeat2 className="size-4" />} {t("replace.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Searchable picker for one mapping row's target: a com-object of the new
// application, or the explicit "drop this link" choice. `undefined` = not chosen
// yet, `null` = drop. Mounts the Command machinery only once opened (a device can
// have many linked rows), mirroring GaCombobox.
function TargetPicker({ options, value, onChange, testId }: {
  options: AppComObject[];
  value: string | null | undefined;
  onChange: (to: string | null) => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const sel = typeof value === "string" ? options.find((o) => o.refId === value) : undefined;
  const triggerClass = cn(
    "h-9 w-full justify-between font-normal",
    value === undefined && "border-dashed text-muted-foreground",
    value === null && "text-muted-foreground",
  );
  const label = (
    <>
      {sel ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{sel.number}</span>
          <span className="truncate">{sel.functionText || sel.name}</span>
        </span>
      ) : (
        <span className="truncate text-xs">{value === null ? t("replace.dropped") : t("replace.pickTarget")}</span>
      )}
      <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
    </>
  );

  if (!active) {
    return (
      <Button variant="outline" role="combobox" data-testid={testId} className={triggerClass}
        onClick={() => { setActive(true); setOpen(true); }}>
        {label}
      </Button>
    );
  }
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setActive(false); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" data-testid={testId} className={triggerClass}>
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0" align="end">
        <Command>
          <CommandInput placeholder={t("replace.targetSearchPlaceholder")} />
          <CommandList>
            <CommandEmpty>{t("replace.targetEmpty")}</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__drop__" onSelect={() => { onChange(null); setOpen(false); }} className="gap-2 text-muted-foreground">
                <X className="size-3.5" /> <span>{t("replace.drop")}</span>
              </CommandItem>
              {/* refId in the cmdk value keeps every item unique (two objects can share number+texts). */}
              {options.map((o) => (
                <CommandItem key={o.refId} value={`${o.number} ${o.name} ${o.functionText} ${o.refId}`} onSelect={() => { onChange(o.refId); setOpen(false); }} className="gap-2">
                  <Check className={cn("size-3.5 shrink-0", o.refId === value ? "opacity-100" : "opacity-0")} />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{o.number}</span>
                  <span className="min-w-0 truncate">{o.functionText || o.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
