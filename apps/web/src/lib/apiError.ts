import { ApiError } from "../api.ts";

// Minimal translate signature, satisfied by react-i18next's `t` and by the
// loosely-typed local `t` aliases some views use.
type Translate = (key: string, opts?: Record<string, unknown>) => string;

// Localize an error code to a user-facing string, falling back to the raw
// (English) message for codes not present in the locale catalog. Used for both
// thrown ApiErrors and code-carrying task errors. A localized text is followed by
// what the refusal's details add in the user's language (errorDetailText); the
// English fallback message already says it.
export function localizeError(t: Translate, code: string | null | undefined, message: string | null | undefined, details?: Record<string, unknown> | null): string {
  const fallback = message ?? "";
  const localized = code ? t(`errors.${code}`, { defaultValue: "" }) : "";
  if (!localized) return fallback;
  const extra = errorDetailText(t, details);
  return extra ? `${localized} ${extra}` : localized;
}

// The sentence a refusal's details add, or "" for details that add none.
// `lsmErrorCode`: what a load-state machine in ERROR gave for its error code (PID 28, DPT 20.011):
// the code, "none" when the device gives none, "unreadable" when it did not answer.
function errorDetailText(t: Translate, details: Record<string, unknown> | null | undefined): string {
  const c = details?.lsmErrorCode;
  if (typeof c === "number") {
    const name = t(`errorDetails.lsmErrorClass.${c}`, { defaultValue: "" }) || t("errorDetails.lsmErrorClassUndefined");
    return t("errorDetails.lsmErrorCode", { code: c, name });
  }
  if (c === "none") return t("errorDetails.lsmErrorCodeNone");
  if (c === "unreadable") return t("errorDetails.lsmErrorCodeUnreadable");
  return "";
}

// Convenience for catch blocks: localize a thrown value, using its code if it is
// an ApiError.
export function errMsg(t: Translate, e: unknown): string {
  if (e instanceof ApiError) return localizeError(t, e.code, e.message, e.details);
  return e instanceof Error ? e.message : String(e);
}
