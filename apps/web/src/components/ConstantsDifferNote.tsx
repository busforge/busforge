import { useTranslation } from "react-i18next";
import type { FlashResult } from "../api.ts";

// Shown with an unchanged result whose device holds other bits only in constant parameters
// (FlashResult.constantsDiffer): no change of the configuration, mostly a download marker the device
// clears itself, but named so a difference that is none is not overlooked.
export function ConstantsDifferNote({ result }: { result: FlashResult }) {
  const { t } = useTranslation();
  if (result.kind !== "unchanged" || !result.constantsDiffer?.length) return null;
  // A long list is cut to three lines; the whole text stays in the tooltip.
  const msg = t("flash.constantsDiffer", { params: result.constantsDiffer.map((c) => c.label).join(", ") });
  return <span className="line-clamp-3 text-amber-600 dark:text-amber-400" title={msg} data-testid="flash-constants-differ">{msg}</span>;
}
