import { Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, Puzzle } from "lucide-react";
import { api, type DcaModuleInfo } from "../api.ts";
import { dcaModules, decodeBaggage } from "./registry.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { errMsg } from "../lib/apiError.ts";

// The entry point for a native DCA-replacement module: a compact button on the
// device's DCA notice that opens the module's UI in a wide dialog, kept visually
// separate from the standard parameter form. Handles version compatibility (offer
// "open anyway" when the module was not verified for this device's application
// version) and lazy-loads both the module code and its config baggage on open.
export function DcaModuleDialog({ projectId, deviceId, module }: { projectId: string; deviceId: string; module: DcaModuleInfo }) {
  const { t } = useTranslation();
  const entry = dcaModules[module.id];
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  // No client code shipped for this module id: nothing to open.
  if (!entry) return null;

  const gated = !module.compatible && !acknowledged;
  const incompatibleNote = t("dca.incompatible", { device: module.deviceVersion, supported: module.supportedVersions.join(", ") });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 gap-1.5" title={module.compatible ? undefined : incompatibleNote} onClick={() => !module.compatible && setAcknowledged(true)}>
          {module.compatible ? <Puzzle className="size-3.5" /> : <AlertTriangle className="size-3.5 text-amber-500" />}
          {module.compatible ? t("dca.open") : t("dca.openAnyway")}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] w-[92vw] max-w-6xl overflow-y-auto sm:max-w-6xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Puzzle className="size-4" /> {module.displayName}</DialogTitle>
        </DialogHeader>
        {!module.compatible && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3.5 shrink-0" /> {incompatibleNote}
          </p>
        )}
        {open && !gated && <DcaModuleBody projectId={projectId} deviceId={deviceId} moduleId={module.id} />}
      </DialogContent>
    </Dialog>
  );
}

function DcaModuleBody({ projectId, deviceId, moduleId }: { projectId: string; deviceId: string; moduleId: string }) {
  const { t } = useTranslation();
  const entry = dcaModules[moduleId];
  const { data, isLoading, error } = useQuery({
    queryKey: ["dcaBaggage", projectId, deviceId],
    queryFn: () => api.deviceBaggage(projectId, deviceId),
  });

  const model = useMemo(() => {
    if (!data) return undefined;
    const name = Object.keys(data).find((n) => n.includes(entry.baggageToken));
    if (!name) return null;
    return entry.parse(decodeBaggage(data[name]));
  }, [data, entry]);

  if (isLoading) return <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("dca.loading")}</p>;
  if (error) return <p className="py-6 text-sm text-destructive">{errMsg(t, error)}</p>;
  if (model === null) return <p className="py-6 text-sm text-muted-foreground">{t("dca.noData")}</p>;

  const View = entry.View;
  return (
    <Suspense fallback={<p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t("dca.loading")}</p>}>
      <View model={model} />
    </Suspense>
  );
}
