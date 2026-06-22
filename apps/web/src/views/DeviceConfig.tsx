import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Cpu, Loader2, Network } from "lucide-react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CfgParamView, GroupRangeNode } from "../api.ts";
import { qk, useProject, useDeviceConfig, useDeviceEdit } from "../queries.ts";
import { ChangePill } from "@/components/ChangePill.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FlashDialog } from "./FlashDialog.tsx";
import { GaCombobox, type GaOption } from "./GaCombobox.tsx";
import { cn } from "@/lib/utils";

function flattenGas(ranges: GroupRangeNode[], out: GaOption[]) {
  for (const r of ranges) { for (const g of r.addresses) out.push({ raw: g.raw, address: g.address, name: g.name }); flattenGas(r.children, out); }
}

export function DeviceConfig() {
  const { projectId, deviceId } = useParams({ from: "/projects/$projectId/devices/$deviceId" });
  const qc = useQueryClient();
  const { data: project } = useProject(projectId);
  const device = project?.devices.find((d) => d.id === deviceId);
  const gaOptions = useMemo(() => { const o: GaOption[] = []; if (project) flattenGas(project.groupRanges, o); return o; }, [project]);

  const { data: view, isLoading, error } = useDeviceConfig(projectId, deviceId);
  const { setParam, setLink } = useDeviceEdit(projectId, deviceId);
  const saving = setParam.isPending || setLink.isPending;
  const [flashOpen, setFlashOpen] = useState(false);
  const [flashGaOpen, setFlashGaOpen] = useState(false);

  const onError = (e: unknown) => toast.error("Could not save", { description: (e as Error).message });
  const relink = (comObjRefId: string, gaRaw: number | null) =>
    setLink.mutate({ comObjRefId, gaRaws: gaRaw == null ? [] : [gaRaw] }, { onError });
  const afterFlash = () => {
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
    qc.invalidateQueries({ queryKey: qk.deviceConfig(projectId, deviceId) });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label="Back to devices" className="text-muted-foreground">
          <Link to="/projects/$projectId/devices" params={{ projectId }}><ChevronLeft className="size-5" /></Link>
        </Button>
        <div className="leading-tight">
          <div className="flex items-center gap-2 font-semibold">
            {device?.name || "(unnamed)"}
            <ChangePill changes={device?.changes} />
          </div>
          <div className="font-mono text-xs text-primary">{device?.ia}</div>
        </div>
        {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setFlashGaOpen(true)} data-testid="program-ga">
          <Network className="size-4" /> Program GAs
        </Button>
        <Button variant="outline" size="sm" onClick={() => setFlashOpen(true)} data-testid="program-device">
          <Cpu className="size-4" /> Program device
        </Button>
      </div>

      {device && <FlashDialog open={flashOpen} onOpenChange={setFlashOpen} projectId={projectId} device={device} target="params" onFlashed={afterFlash} />}
      {device && <FlashDialog open={flashGaOpen} onOpenChange={setFlashGaOpen} projectId={projectId} device={device} target="ga" onFlashed={afterFlash} />}

      {isLoading && <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading configuration…</div>}
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{(error as Error).message}</p>}
      {view && !isLoading && view.blocks.length === 0 && !error && (
        <Card><CardContent className="text-sm text-muted-foreground">
          No editable parameters for this device.
        </CardContent></Card>
      )}

      {view && view.blocks.map((block) => (
        <Card key={block.id}>
          <CardContent className="space-y-1 py-4">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{block.name}</h3>
            {block.items.map((item, i) => {
              if (item.kind === "separator") {
                if (item.uiHint === "HorizontalRuler") return <Separator key={i} className="my-2" />;
                if (!item.text) return null;
                if (item.uiHint === "Headline") return <div key={i} className="pt-2 text-sm font-medium text-foreground">{item.text}</div>;
                return <p key={i} className={cn("py-1 text-xs", item.uiHint === "Error" ? "text-destructive" : "text-muted-foreground")}>{item.text}</p>;
              }
              if (item.kind === "comObject") {
                const co = item.comObject;
                const flags = [co.flags.comm && "C", co.flags.read && "R", co.flags.write && "W", co.flags.transmit && "T", co.flags.update && "U"].filter(Boolean).join("");
                return (
                  <div key={i} className="flex items-center gap-3 border-l-2 border-border/60 py-1.5 pl-3 text-sm">
                    <span className="w-7 shrink-0 font-mono text-xs text-muted-foreground" title="Communication-object number">#{co.number}</span>
                    <span className="min-w-0 flex-1 truncate"><span className="text-muted-foreground">{co.functionText}</span>{co.functionText && co.name ? " · " : ""}{co.name}</span>
                    {co.dpt
                      ? <Badge variant="outline" className="font-mono text-[10px]">{co.dpt}</Badge>
                      : <span className="font-mono text-[10px] text-muted-foreground">{co.objectSize}</span>}
                    {flags && <Badge variant="secondary" className="font-mono text-[10px]">{flags}</Badge>}
                    <div className="w-44 shrink-0"><GaCombobox options={gaOptions} value={co.gaRaw ?? null} onChange={(raw) => relink(co.refId, raw)} testId={`link-${co.number}`} /></div>
                  </div>
                );
              }
              return <ParamRow key={i} param={item.param} onChange={(v) => setParam.mutate({ refId: item.param.refId, value: v }, { onError })} />;
            })}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ParamRow({ param, onChange }: { param: CfgParamView; onChange: (value: string) => void }) {
  const [local, setLocal] = useState(param.value);
  useEffect(() => setLocal(param.value), [param.value]);

  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="min-w-0 flex-1 text-sm">{param.name}</span>
      <div className="flex w-56 shrink-0 items-center gap-2">
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
            className="font-mono" data-testid={`param-${param.refId}`}
          />
        )}
        {param.control === "text" && (
          <Input value={local} readOnly={param.readOnly} onChange={(e) => setLocal(e.target.value)} onBlur={() => !param.readOnly && local !== param.value && onChange(local)} data-testid={`param-${param.refId}`} />
        )}
        {param.control === "unsupported" && <span className="font-mono text-xs text-muted-foreground">{param.value}</span>}
        {param.suffix && <span className="shrink-0 text-xs text-muted-foreground">{param.suffix}</span>}
      </div>
    </div>
  );
}
