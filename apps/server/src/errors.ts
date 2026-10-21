// Coded API errors. The `code` is a stable, machine-readable identifier the web
// client maps to a localized string (see apps/web/src/lib/apiError.ts and the
// `errors` block in the locale catalogs). `message` is the English fallback for
// codes a client has not (yet) localized and for logs.
export class ApiError extends Error {
  // `details`: structured facts behind the refusal a client may act on (e.g. object numbers).
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

// Duck-typed code accessor: any thrown value may carry a string `code` (ApiError here,
// plus KnxprojError / ProductError / KnxError thrown from the @busforge/* packages).
// Reading it duck-typed keeps this mapper decoupled from those classes. Returns the code
// if present, else undefined.
export function errorCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null | undefined)?.code;
  return typeof c === "string" ? c : undefined;
}

// The structured facts of a refusal (ApiError.details), or null.
export function errorDetails(e: unknown): Record<string, unknown> | null {
  return e instanceof ApiError && e.details ? e.details : null;
}
