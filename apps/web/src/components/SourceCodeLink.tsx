import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

// Busforge is licensed under the AGPL-3.0-or-later; section 13 asks that users interacting with
// it over a network are offered its source, so the running app links to it.
export const SOURCE_URL = "https://github.com/busforge/busforge";

export function SourceCodeLink() {
  const { t } = useTranslation();
  return (
    <Button asChild variant="link" className="h-auto rounded-sm p-0 text-[11px] font-normal text-inherit underline-offset-2 hover:not-disabled:text-foreground" data-testid="source-code">
      <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer" title={t("footer.license")}>{t("footer.source")}</a>
    </Button>
  );
}
