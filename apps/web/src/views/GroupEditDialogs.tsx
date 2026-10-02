import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { api, type GroupAddressSecurity } from "../api.ts";
import { useGroupEdit } from "../queries.ts";
import { mergeDpts, dptSubtypeLabel } from "@/lib/dpts.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { errMsg } from "../lib/apiError.ts";
import { formatGa, type Levels } from "@busforge/knx/ga";

export type { Levels };

// The address preview a new group address will get. Level math lives in the shared
// dependency-free @busforge/knx/ga (formatGa), the same formatter the server uses.
function gaRawInRange(rangeStart: number, sub: number, levels: Levels): number {
  const block = levels === 3 ? 256 : 2048;
  return Math.floor(rangeStart / block) * block + sub;
}

// The open editor and its context. Held by the parent so the affordances and the
// dialogs stay decoupled; null means nothing is open.
export type Editor =
  | { kind: "range-create"; parentId: number | null; isMain: boolean; defaultNumber: number; parentMain?: number; usedNumbers: number[] }
  | { kind: "range-rename"; rangeId: number; name: string }
  | { kind: "range-delete"; rangeId: number; name: string }
  | { kind: "ga-create"; rangeId: number; rangeStart: number; defaultSub: number; usedSubs: number[] }
  | { kind: "ga-edit"; raw: number; name: string; dpt: string; security: GroupAddressSecurity }
  | { kind: "ga-delete"; raw: number; name: string; address: string }
  | null;

export function GroupEditor({ editor, onClose, projectId, levels, dptSuggestions }: {
  editor: Editor;
  onClose: () => void;
  projectId: string;
  levels: Levels;
  dptSuggestions: string[];
}) {
  if (!editor) return null;
  switch (editor.kind) {
    case "range-create":
    case "range-rename":
      return <RangeDialog editor={editor} onClose={onClose} projectId={projectId} />;
    case "ga-create":
    case "ga-edit":
      return <GaDialog editor={editor} onClose={onClose} projectId={projectId} levels={levels} dptSuggestions={dptSuggestions} />;
    case "range-delete":
    case "ga-delete":
      return <DeleteDialog editor={editor} onClose={onClose} projectId={projectId} />;
  }
}

// Searchable, creatable datapoint-type picker (typeahead). Offers the catalog plus
// any types already in the project; an unmatched query can be used verbatim so no
// custom DPT is locked out.
function DptCombobox({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: ReturnType<typeof mergeDpts> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pick = (id: string) => { onChange(id); setQuery(""); setOpen(false); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" data-testid="ga-dpt" className="h-9 w-56 justify-between font-normal">
          {/* A plain chip, not DptBadge: that renders its own tooltip <button>, which
              cannot be nested inside this trigger button. */}
          {value
            ? <span className="inline-flex items-center gap-1.5"><span className="font-mono text-xs">{value}</span><span className="truncate text-muted-foreground">{dptSubtypeLabel(value) || t(`dpt.${value.split(".")[0]}.name`, { defaultValue: "" })}</span></span>
            : <span className="text-muted-foreground">{t("groupEdit.dptPlaceholder")}</span>}
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      {/* Portaled INTO the dialog content, not the document body. The dialog's
          scroll-lock (react-remove-scroll) only allows wheel scrolling within its
          own subtree: a body-portaled list would not scroll on the wheel, while a
          non-portaled one is laid out in flow and nudges the dialog's size. This
          keeps the list both out of flow and wheel-scrollable. */}
      <PopoverPrimitive.Portal container={typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-slot=dialog-content]") : undefined}>
        <PopoverPrimitive.Content
          align="start" sideOffset={4}
          className="z-50 w-72 rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-hidden"
        >
          <Command>
          <CommandInput placeholder={t("groupEdit.dptSearch")} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{t("groupEdit.dptEmpty")}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                // Search by id, the subtype label, and the localized main-type name
                // (so "Boolean" finds every 1.x, "Float" every 9.x/14.x, etc.).
                const mainName = t(`dpt.${o.id.split(".")[0]}.name`, { defaultValue: "" });
                return (
                  <CommandItem key={o.id} value={`${o.id} ${o.label} ${mainName}`} onSelect={() => pick(o.id)} className="gap-2">
                    <Check className={`size-3.5 shrink-0 ${o.id === value ? "opacity-100" : "opacity-0"}`} />
                    <span className="font-mono text-xs">{o.id}</span>
                    {(o.label || mainName) && <span className="truncate text-muted-foreground">{o.label || mainName}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}

function RangeDialog({ editor, onClose, projectId }: {
  editor: Extract<Editor, { kind: "range-create" | "range-rename" }>;
  onClose: () => void;
  projectId: string;
}) {
  const { t } = useTranslation();
  const { createRange, renameRange } = useGroupEdit(projectId);
  const isCreate = editor.kind === "range-create";
  const [name, setName] = useState(isCreate ? "" : editor.name);
  const [number, setNumber] = useState(isCreate ? String(editor.defaultNumber) : "");
  const pending = createRange.isPending || renameRange.isPending;
  // Three-level main groups span 0..31, middle groups 0..7.
  const maxNumber = !isCreate ? 0 : editor.isMain ? 31 : 7;
  const n = Number(number);

  // Inline validation: name required; a create needs a valid, free number.
  const nameError = name.trim() === "" ? t("groupEdit.nameRequired") : null;
  const numberError = !isCreate ? null
    : number.trim() === "" || !Number.isInteger(n) || n < 0 || n > maxNumber ? t("groupEdit.numberRange", { max: maxNumber })
    : editor.usedNumbers.includes(n) ? t("groupEdit.numberTaken")
    : null;
  const invalid = !!nameError || !!numberError;
  // Preview the resulting group number (main, or main/middle).
  const preview = isCreate && !numberError ? (editor.isMain ? String(n) : `${editor.parentMain}/${n}`) : null;

  const submit = () => {
    if (invalid) return;
    if (isCreate) {
      createRange.mutate({ parentId: editor.parentId, name: name.trim(), number: n }, {
        onSuccess: () => { toast.success(t("groupEdit.rangeCreated")); onClose(); },
        onError: (e) => toast.error(t("groupEdit.failed"), { description: errMsg(t, e) }),
      });
    } else {
      renameRange.mutate({ rangeId: editor.rangeId, name: name.trim() }, {
        onSuccess: () => { toast.success(t("groupEdit.renamed")); onClose(); },
        onError: (e) => toast.error(t("groupEdit.failed"), { description: errMsg(t, e) }),
      });
    }
  };

  const title = !isCreate ? t("groupEdit.renameRange") : editor.isMain ? t("groupEdit.newMainGroup") : t("groupEdit.newMiddleGroup");

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("groupEdit.rangeDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isCreate && (
            <div className="space-y-1.5">
              <Label htmlFor="range-number">{editor.isMain ? t("groupEdit.mainNumber") : t("groupEdit.middleNumber")}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="range-number" type="number" min={0} max={maxNumber} value={number}
                  onChange={(e) => setNumber(e.target.value)} data-testid="range-number" className="w-32 font-mono"
                  aria-invalid={!!numberError}
                />
                {preview && <span className="font-mono text-sm text-primary" data-testid="range-preview">{preview}</span>}
              </div>
              {numberError && <p className="text-xs text-destructive">{numberError}</p>}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="range-name">{t("groupEdit.name")}</Label>
            <Input
              id="range-name" value={name} autoFocus={!isCreate} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} data-testid="range-name" aria-invalid={!!nameError}
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={pending || invalid} data-testid="range-save">
            {pending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GaDialog({ editor, onClose, projectId, levels, dptSuggestions }: {
  editor: Extract<Editor, { kind: "ga-create" | "ga-edit" }>;
  onClose: () => void;
  projectId: string;
  levels: Levels;
  dptSuggestions: string[];
}) {
  const { t } = useTranslation();
  const { createGa, updateGa } = useGroupEdit(projectId);
  const isCreate = editor.kind === "ga-create";
  const [name, setName] = useState(isCreate ? "" : editor.name);
  const [dpt, setDpt] = useState(isCreate ? "" : editor.dpt);
  const [sub, setSub] = useState(isCreate ? String(editor.defaultSub) : "");
  const [security, setSecurity] = useState<GroupAddressSecurity>(isCreate ? "auto" : editor.security);
  const pending = createGa.isPending || updateGa.isPending;
  const maxSub = levels === 3 ? 255 : 2047;
  const s = Number(sub);
  const dptOptions = mergeDpts([...dptSuggestions, dpt]);

  const nameError = name.trim() === "" ? t("groupEdit.nameRequired") : null;
  const subError = !isCreate ? null
    : sub.trim() === "" || !Number.isInteger(s) || s < 0 || s > maxSub ? t("groupEdit.numberRange", { max: maxSub })
    : editor.usedSubs.includes(s) ? t("groupEdit.addressTaken")
    : null;
  const invalid = !!nameError || !!subError;
  const preview = isCreate && !subError ? formatGa(gaRawInRange(editor.rangeStart, s, levels), levels) : null;

  const submit = () => {
    if (invalid) return;
    if (isCreate) {
      createGa.mutate({ rangeId: editor.rangeId, sub: s, name: name.trim(), dpt: dpt.trim() }, {
        onSuccess: () => { toast.success(t("groupEdit.gaCreated")); onClose(); },
        onError: (e) => toast.error(t("groupEdit.failed"), { description: errMsg(t, e) }),
      });
    } else {
      updateGa.mutate({ raw: editor.raw, name: name.trim(), dpt: dpt.trim(), security }, {
        onSuccess: () => { toast.success(t("groupEdit.gaSaved")); onClose(); },
        onError: (e) => toast.error(t("groupEdit.failed"), { description: errMsg(t, e) }),
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isCreate ? t("groupEdit.newGa") : t("groupEdit.editGa")}</DialogTitle>
          <DialogDescription>{isCreate ? t("groupEdit.gaCreateDescription") : t("groupEdit.gaEditDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {isCreate && (
            <div className="space-y-1.5">
              <Label htmlFor="ga-sub">{t("groupEdit.addressNumber")}</Label>
              <div className="flex items-center gap-3">
                <Input id="ga-sub" type="number" min={0} max={maxSub} value={sub} onChange={(e) => setSub(e.target.value)} data-testid="ga-sub" className="w-32 font-mono" aria-invalid={!!subError} />
                {preview && <span className="font-mono text-sm text-primary" data-testid="ga-preview">{preview}</span>}
              </div>
              {subError && <p className="text-xs text-destructive">{subError}</p>}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="ga-name">{t("groupEdit.name")}</Label>
            <Input id="ga-name" value={name} autoFocus={!isCreate} onChange={(e) => setName(e.target.value)} data-testid="ga-name" aria-invalid={!!nameError} />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>{t("groupEdit.dpt")}</Label>
            <DptCombobox value={dpt} onChange={setDpt} options={dptOptions} />
          </div>
          {!isCreate && (
            <div className="space-y-1.5">
              <Label htmlFor="ga-security">{t("groupEdit.security")}</Label>
              <select id="ga-security" value={security} onChange={(e) => setSecurity(e.target.value as GroupAddressSecurity)} data-testid="ga-security"
                className="h-9 w-56 rounded-md border bg-background px-2 text-sm">
                {(["auto", "on", "off"] as const).map((m) => <option key={m} value={m}>{t(`groupEdit.securityMode.${m}`)}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{t(`groupEdit.securityHint.${security}`)}</p>
              {security !== editor.security && <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="ga-security-changed">{t("groupEdit.securityRewrite")}</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={pending || invalid} data-testid="ga-save">
            {pending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ editor, onClose, projectId }: {
  editor: Extract<Editor, { kind: "range-delete" | "ga-delete" }>;
  onClose: () => void;
  projectId: string;
}) {
  const { t } = useTranslation();
  const { deleteRange, deleteGa } = useGroupEdit(projectId);
  const isRange = editor.kind === "range-delete";
  const pending = deleteRange.isPending || deleteGa.isPending;

  // Fetch how many device links this delete would drop, to warn before committing.
  const impact = useQuery({
    queryKey: ["gaImpact", projectId, editor.kind, isRange ? editor.rangeId : editor.raw],
    queryFn: () => (isRange ? api.rangeImpact(projectId, editor.rangeId) : api.gaImpact(projectId, editor.raw)),
  });
  const links = impact.data?.links ?? 0;

  const confirm = () => {
    const onErr = (e: unknown) => toast.error(t("groupEdit.failed"), { description: errMsg(t, e) });
    const ok = () => { toast.success(t("groupEdit.deleted")); onClose(); };
    if (isRange) deleteRange.mutate(editor.rangeId, { onSuccess: ok, onError: onErr });
    else deleteGa.mutate(editor.raw, { onSuccess: ok, onError: onErr });
  };

  const label = isRange ? editor.name || t("groups.unnamedRange") : `${editor.name || t("common.unnamed")} (${editor.address})`;

  return (
    <AlertDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isRange ? t("groupEdit.deleteRangeTitle") : t("groupEdit.deleteGaTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {isRange ? t("groupEdit.deleteRangeBody", { name: label }) : t("groupEdit.deleteGaBody", { name: label })}
            {impact.isLoading ? null : links > 0 ? ` ${t("groupEdit.deleteImpact", { count: links })}` : ` ${t("groupEdit.deleteNoImpact")}`}
            {" "}{t("groupEdit.deleteUndoHint")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={(e) => { e.preventDefault(); confirm(); }} disabled={pending} data-testid="confirm-delete" className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {pending && <Loader2 className="size-4 animate-spin" />} {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
