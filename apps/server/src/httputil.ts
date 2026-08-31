// Shared HTTP response helpers for the API route modules.

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
// Error responses carry a stable `code` (for client localization) plus the
// English `message` as a fallback/log line.
export const err = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

// Read a client-supplied field as trimmed text. A parsed JSON body (or a multipart part) can
// carry a number, an object or a File where a string was expected; calling String.trim on that
// throws, and the catch-all turns the throw into a 500 whose message echoes handler source back
// to the caller. Anything that is not a string is therefore an empty value, which every caller
// already rejects the same way it rejects "".
export const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
