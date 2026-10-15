import { useTranslation } from "react-i18next";
import type { FlashResult } from "../api.ts";

// Shown beside a verified write's success line, in the warning colour, where the device did not confirm
// its restart (FlashResult.restartUnproven): the read-back after the restart shows the bytes, not that the
// device stored them for good.
export function RestartUnprovenNote({ result }: { result: FlashResult }) {
  const { t } = useTranslation();
  if (result.kind !== "flashed" || !result.verified || !result.restartUnproven) return null;
  return <span className="text-amber-600 dark:text-amber-400" data-testid="flash-restart-unproven">{t("flash.restartUnproven")}</span>;
}
