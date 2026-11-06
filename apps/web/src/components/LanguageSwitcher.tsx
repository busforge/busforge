import { useTranslation } from "react-i18next";
import { supportedLngs, setLanguage, type Lng } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// The UI language in use; setLanguage changes it and keeps the choice in the browser.
export function useUiLanguage(): Lng {
  const { i18n } = useTranslation();
  return (i18n.resolvedLanguage ?? i18n.language) as Lng;
}

// Compact DE/EN segmented control. The choice is persisted in the browser.
export function LanguageSwitcher({ className }: { className?: string }) {
  const current = useUiLanguage();
  return (
    <div className={cn("flex h-8 shrink-0 overflow-hidden rounded-md border border-border font-mono text-[11px]", className)}>
      {supportedLngs.map((lng) => (
        <button
          key={lng}
          type="button"
          onClick={() => setLanguage(lng)}
          aria-pressed={current === lng}
          className={cn(
            "cursor-pointer px-2 uppercase outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
            current === lng ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {lng}
        </button>
      ))}
    </div>
  );
}
