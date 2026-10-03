import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type DeviceConfigView, type MatrixOperation } from "../api.ts";
import { Button } from "@/components/ui/button";
import { errMsg } from "../lib/apiError.ts";

// Operations of `ops` this device's Product has not been tested for on hardware. Empty when all are
// tested, the user acknowledged the Product for this project, or the server attached no matrix
// (then it does not gate the write either).
export function untestedOps(view: Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged"> | undefined, ops: MatrixOperation[]): MatrixOperation[] {
  if (!view?.compatibility || view.untestedAcknowledged) return [];
  return ops.filter((op) => view.compatibility![op].state !== "tested" && view.compatibility![op].state !== "refused");
}

// A write the server refused as untested means the view the dialog showed was stale (not loaded
// yet, or the product changed elsewhere): reload it, so the notice appears.
export function useRefreshOnUntested(projectId: string, deviceId: string): (e: unknown) => void {
  const qc = useQueryClient();
  return (e) => {
    if (e instanceof ApiError && e.code === "PRODUCT_UNTESTED") void qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] });
  };
}

// "M-0004_H-…_P-400021SE" -> "400021SE": KNX ids escape characters as .XX hex.
const orderOf = (productRef: string) => (productRef.split("_P-")[1] ?? productRef).replace(/\.([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

// The notice before writing a Product untested on hardware: names each operation's state and takes
// the user's one acknowledgement for this project. The write stays disabled until then.
export function UntestedNotice({ projectId, deviceId, view, ops }: {
  projectId: string; deviceId: string; ops: MatrixOperation[];
  view: Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged"> | undefined;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = untestedOps(view, ops);
  if (open.length === 0) return null;
  const acknowledge = () => {
    setBusy(true);
    setError(null);
    api.acknowledgeUntested(projectId, deviceId)
      .then(() => qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] }))
      .catch((e) => setError(errMsg(t, e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300" data-testid="untested-notice">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1.5">
        <p className="font-medium">{t("untested.title")}</p>
        <ul className="space-y-0.5 text-amber-700/90 dark:text-amber-300/90">
          {open.map((op) => {
            const v = view!.compatibility![op];
            return (
              <li key={op}>
                {t(`untested.op.${op}`)}: {v.state === "derived"
                  ? t("untested.derived", { product: orderOf(v.derivedFrom!) })
                  : t(`untested.state.${v.state}`)}
              </li>
            );
          })}
        </ul>
        <p>{t("untested.explain")}</p>
        {error && <p className="text-destructive">{error}</p>}
        <Button size="sm" variant="outline" onClick={acknowledge} disabled={busy} data-testid="untested-acknowledge">
          {busy && <Loader2 className="size-4 animate-spin" />} {t("untested.acknowledge")}
        </Button>
      </div>
    </div>
  );
}
