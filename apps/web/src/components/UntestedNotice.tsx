import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type DeviceConfigView, type MatrixOperation } from "../api.ts";
import { untestedOps, failedOps, orderOf, appVersionOf } from "../lib/untested.ts";
import { Button } from "@/components/ui/button";
import { errMsg } from "../lib/apiError.ts";

// A write the server refused as untested means the view the dialog showed was stale (not loaded
// yet, or the product changed elsewhere): reload it, so the notice appears.
export function useRefreshOnUntested(projectId: string, deviceId: string): (e: unknown) => void {
  const qc = useQueryClient();
  return (e) => {
    if (e instanceof ApiError && e.code === "PRODUCT_UNTESTED") void qc.invalidateQueries({ queryKey: ["deviceConfig", projectId, deviceId] });
  };
}


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
  const blocking = untestedOps(view, ops);
  // Acknowledged already: a failure on hardware still shows, without asking again.
  const open = blocking.length > 0 ? blocking : failedOps(view, ops);
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
        <p className="font-medium">{t(blocking.length > 0 ? "untested.title" : "untested.failedTitle")}</p>
        <ul className="space-y-0.5 text-amber-700/90 dark:text-amber-300/90">
          {open.map((op) => {
            const v = view!.compatibility![op];
            return (
              <li key={op}>
                {t(`untested.op.${op}`)}: {v.state === "derived"
                  ? t("untested.derived", { product: orderOf(v.derivedFrom!) })
                  : v.state === "otherVersion"
                    ? t("untested.otherVersion", { app: appVersionOf(v.otherVersionTested!.appProgramId), product: orderOf(v.otherVersionTested!.productRef) })
                    : t(`untested.state.${v.state}`)}
              </li>
            );
          })}
        </ul>
        <p>{t(blocking.length > 0 ? "untested.explain" : "untested.failedExplain")}</p>
        {error && <p className="text-destructive">{error}</p>}
        {blocking.length > 0 && <Button size="sm" variant="outline" onClick={acknowledge} disabled={busy} data-testid="untested-acknowledge">
          {busy && <Loader2 className="size-4 animate-spin" />} {t("untested.acknowledge")}
        </Button>}
      </div>
    </div>
  );
}
