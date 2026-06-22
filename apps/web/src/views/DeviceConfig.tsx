import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Cpu, Info, Loader2, Network, RotateCcw } from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CfgComObjView, CfgParamView, GroupRangeNode } from "../api.ts";
import { qk, useProject, useDeviceConfig, useDeviceEdit } from "../queries.ts";
import { ChangePill, changeTotal } from "@/components/ChangePill.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FlashDialog } from "./FlashDialog.tsx";
import { GaCombobox, type GaOption } from "./GaCombobox.tsx";
import { cn } from "@/lib/utils";

// Shared width of the right-hand control column, so parameter inputs and the
// group-address picker line up and none of them get cut off.
const CONTROL_W = "w-full sm:w-72";

function flattenGas(ranges: GroupRangeNode[], out: GaOption[]) {
  for (const r of ranges) { for (const g of r.addresses) out.push({ raw: g.raw, address: g.address, name: g.name }); flattenGas(r.children, out); }
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

// Small amber dot marking a row whose value differs from the programmed state.
function ChangedDot({ title }: { title: string }) {
  return <span className="size-1.5 shrink-0 rounded-full bg-primary" title={title} />;
}

const flagWords = (f: CfgComObjView["flags"], t: TFn) =>
  [f.comm && t("device.flagCommunication"), f.read && t("device.flagRead"), f.write && t("device.flagWrite"), f.transmit && t("device.flagTransmit"), f.update && t("device.flagUpdate")]
    .filter(Boolean).join(", ");

export function DeviceConfig() {
  const { t } = useTranslation();
  const { projectId, deviceId } = useParams({ from: "/projects/$projectId/devices/$deviceId" });
  const qc = useQueryClient();
  const { data: project } = useProject(projectId);
  const device = project?.devices.find((d) => d.id === deviceId);
  const gaOptions = useMemo(() => { const o: GaOption[] = []; if (project) flattenGas(project.groupRanges, o); return o; }, [project]);

  const { data: view, isLoading, error } = useDeviceConfig(projectId, deviceId);
  const { setParam, setLink, revert } = useDeviceEdit(projectId, deviceId);
  const saving = setParam.isPending || setLink.isPending || revert.isPending;
  const [flashOpen, setFlashOpen] = useState(false);
  const [flashGaOpen, setFlashGaOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const hasChanges = changeTotal(device?.changes) > 0;

  const onError = (e: unknown) => toast.error(t("device.saveError"), { description: (e as Error).message });
  const relink = (comObjRefId: string, gaRaw: number | null) =>
    setLink.mutate({ comObjRefId, gaRaws: gaRaw == null ? [] : [gaRaw] }, { onError });
  const doRevert = () =>
    revert.mutate(undefined, {
      onSuccess: () => { setRevertOpen(false); toast.success(t("device.reverted")); },
      onError: (e) => { setRevertOpen(false); onError(e); },
    });
  const afterFlash = () => {
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
    qc.invalidateQueries({ queryKey: qk.deviceConfig(projectId, deviceId) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label={t("device.back")} className="text-muted-foreground">
          <Link to="/projects/$projectId/devices" params={{ projectId }}><ChevronLeft className="size-5" /></Link>
        </Button>
        <div className="leading-tight">
          <div className="flex items-center gap-2 font-semibold">
            {device?.name || t("common.unnamed")}
            <ChangePill changes={device?.changes} />
          </div>
          <div className="font-mono text-xs text-primary">{device?.ia}</div>
        </div>
        {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <Button
          variant="ghost" size="sm" className="ml-auto text-muted-foreground"
          disabled={!hasChanges || saving} onClick={() => setRevertOpen(true)} data-testid="revert-device"
        >
          <RotateCcw className="size-4" /> {t("device.revert")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setFlashGaOpen(true)} data-testid="program-ga">
          <Network className="size-4" /> {t("device.programGAs")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setFlashOpen(true)} data-testid="program-device">
          <Cpu className="size-4" /> {t("device.programDevice")}
        </Button>
      </div>

      {device && <FlashDialog open={flashOpen} onOpenChange={setFlashOpen} projectId={projectId} device={device} target="params" onFlashed={afterFlash} />}
      {device && <FlashDialog open={flashGaOpen} onOpenChange={setFlashGaOpen} projectId={projectId} device={device} target="ga" onFlashed={afterFlash} />}

      <AlertDialog open={revertOpen} onOpenChange={setRevertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("device.revertTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("device.revertBody", { ia: device?.ia })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revert.isPending}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); doRevert(); }} disabled={revert.isPending} data-testid="confirm-revert">
              {revert.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} {t("device.revert")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isLoading && <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("device.loadingConfig")}</div>}
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{(error as Error).message}</p>}
      {view && !isLoading && view.blocks.length === 0 && !error && (
        <Card><CardContent className="text-sm text-muted-foreground">
          {t("device.noParams")}
        </CardContent></Card>
      )}

      {view && view.blocks.map((block) => (
        <Card key={block.id}>
          <CardContent className="space-y-0.5 py-4">
            <h3 className="mb-3 border-b border-border/60 pb-2 text-base font-semibold text-foreground">{block.name}</h3>
            {block.items.map((item, i) => {
              if (item.kind === "separator") {
                if (item.uiHint === "HorizontalRuler") return <Separator key={i} className="my-2" />;
                if (!item.text) return null;
                if (item.uiHint === "Headline")
                  return <div key={i} className="mt-4 mb-1 border-b border-border/40 pb-1 text-sm font-semibold text-foreground first:mt-0">{item.text}</div>;
                return <p key={i} className={cn("py-1 text-xs", item.uiHint === "Error" ? "text-destructive" : "text-muted-foreground")}>{item.text}</p>;
              }
              if (item.kind === "comObject") {
                const co = item.comObject;
                // Just the function ("Schalten EIN/AUS"); the channel/device name is
                // redundant (the assigned GA already names it) so it is dropped.
                const label = co.functionText || co.name;
                const flags = flagWords(co.flags, t);
                const dpt = co.dpt || co.objectSize || t("device.unknownDpt");
                const infoTitle = flags
                  ? t("device.objectInfoFlags", { number: co.number, dpt, flags })
                  : t("device.objectInfo", { number: co.number, dpt });
                return (
                  <div key={i} className={cn("flex items-center justify-between gap-4 border-l-2 py-1.5 pl-3 text-sm", co.changed ? "border-primary bg-primary/5" : "border-transparent")}>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {co.changed ? <ChangedDot title={t("device.changedDot")} /> : null}
                      <span className="truncate">{label}</span>
                      <span title={infoTitle} className="shrink-0 cursor-help text-muted-foreground"><Info className="size-3.5" /></span>
                    </span>
                    <div className={cn("shrink-0", CONTROL_W)}><GaCombobox options={gaOptions} value={co.gaRaw ?? null} onChange={(raw) => relink(co.refId, raw)} testId={`link-${co.number}`} /></div>
                  </div>
                );
              }
              return <ParamRow key={i} param={item.param} changedTitle={t("device.changedDot")} onChange={(v) => setParam.mutate({ refId: item.param.refId, value: v }, { onError })} />;
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ParamRow({ param, changedTitle, onChange }: { param: CfgParamView; changedTitle: string; onChange: (value: string) => void }) {
  const [local, setLocal] = useState(param.value);
  useEffect(() => setLocal(param.value), [param.value]);

  return (
    <div className={cn("flex items-center justify-between gap-4 border-l-2 py-1.5 pl-3", param.changed ? "border-primary bg-primary/5" : "border-transparent")}>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        {param.changed ? <ChangedDot title={changedTitle} /> : null}
        <span className="truncate">{param.name}</span>
      </span>
      <div className={cn("flex shrink-0 items-center gap-2", CONTROL_W)}>
        {param.control === "enum" && (
          <Select value={param.value} onValueChange={onChange} disabled={param.readOnly}>
            <SelectTrigger className="w-full" data-testid={`param-${param.refId}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {param.options?.map((o) => <SelectItem key={o.value} value={String(o.value)}>{o.text}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {param.control === "number" && (
          <Input
            type="number" value={local} min={param.min} max={param.max} readOnly={param.readOnly}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={() => !param.readOnly && local !== param.value && onChange(local)}
            className="w-full font-mono" data-testid={`param-${param.refId}`}
          />
        )}
        {param.control === "text" && (
          <Input className="w-full" value={local} readOnly={param.readOnly} onChange={(e) => setLocal(e.target.value)} onBlur={() => !param.readOnly && local !== param.value && onChange(local)} data-testid={`param-${param.refId}`} />
        )}
        {param.control === "unsupported" && <span className="font-mono text-xs text-muted-foreground">{param.value}</span>}
        {param.suffix && <span className="shrink-0 text-xs text-muted-foreground">{param.suffix}</span>}
      </div>
    </div>
  );
}
