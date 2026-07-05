// Shared HTTP response helpers for the API route modules.

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
// Error responses carry a stable `code` (for client localization) plus the
// English `message` as a fallback/log line.
export const err = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);
