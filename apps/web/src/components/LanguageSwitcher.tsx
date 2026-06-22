import { useTranslation } from "react-i18next";
import { supportedLngs, setLanguage, type Lng } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Compact DE/EN segmented control. The choice is persisted in the browser.
export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? i18n.language) as Lng;
  return (
    <div className={cn("flex h-8 shrink-0 overflow-hidden rounded-md border border-border font-mono text-[11px]", className)}>
      {supportedLngs.map((lng) => (
        <button
          key={lng}
          type="button"
          onClick={() => setLanguage(lng)}
          aria-pressed={current === lng}
          className={cn(
            "px-2 uppercase transition-colors",
            current === lng ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {lng}
        </button>
      ))}
    </div>
  );
}
