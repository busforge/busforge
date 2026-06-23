import { ApiError } from "../api.ts";

// Minimal translate signature, satisfied by react-i18next's `t` and by the
// loosely-typed local `t` aliases some views use.
type Translate = (key: string, opts?: Record<string, unknown>) => string;

// Localize an error code to a user-facing string, falling back to the raw
// (English) message for codes not present in the locale catalog. Used for both
// thrown ApiErrors and code-carrying task errors.
export function localizeError(t: Translate, code: string | null | undefined, message: string | null | undefined): string {
  const fallback = message ?? "";
  return code ? t(`errors.${code}`, { defaultValue: fallback }) : fallback;
}

// Convenience for catch blocks: localize a thrown value, using its code if it is
// an ApiError.
export function errMsg(t: Translate, e: unknown): string {
  if (e instanceof ApiError) return localizeError(t, e.code, e.message);
  return e instanceof Error ? e.message : String(e);
}
