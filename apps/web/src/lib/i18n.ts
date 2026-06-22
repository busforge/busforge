import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en";
import de from "@/locales/de";

// react-i18next over the default i18next instance (no provider needed). The UI
// language is persisted in the browser (localStorage); first visit falls back to
// the browser language, then English.
export const supportedLngs = ["en", "de"] as const;
export type Lng = (typeof supportedLngs)[number];
const STORAGE_KEY = "busforge.lang";

const isLng = (v: unknown): v is Lng => typeof v === "string" && (supportedLngs as readonly string[]).includes(v);

function initialLng(): Lng {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLng(stored)) return stored;
  } catch { /* localStorage unavailable */ }
  const nav = typeof navigator !== "undefined" ? navigator.language.slice(0, 2) : "en";
  return nav === "de" ? "de" : "en";
}

const lng = initialLng();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, de: { translation: de } },
  lng,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

if (typeof document !== "undefined") document.documentElement.lang = lng;

// Switch language and persist the choice.
export function setLanguage(next: Lng): void {
  void i18n.changeLanguage(next);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

export default i18n;
