// Pure formatting/validation helpers for the editable parameter controls in
// DeviceConfig. Kept here (not inline in the component) so they can be unit-tested:
// the byte codec is covered in @busforge/product, but these drive the UI round-trip.

// A TypeTime whose Unit counts whole seconds can be edited as an hh:mm:ss duration.
// Any other (or unknown) unit keeps its raw integer + unit suffix, so we never apply a
// wrong conversion.
export function isSecondsUnit(unit?: string): boolean {
  return unit === undefined || unit === "Seconds";
}

export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// Parse "h:m:s", "m:s", or a plain seconds count into total seconds, or undefined if
// any part is not a non-negative integer.
export function parseDuration(text: string): number | undefined {
  const parts = text.trim().split(":").map((p) => p.trim());
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
  const n = parts.map(Number);
  if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
  if (n.length === 2) return n[0] * 60 + n[1];
  return n[0];
}

export function isValidIPv4(s: string): boolean {
  const parts = s.trim().split(".");
  return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255);
}

// ETS stores float defaults in scientific notation (e.g. "1.500000000000000E+001").
// Render them as a plain decimal ("15") for editing; leave non-numeric/empty as-is.
export function normalizeFloat(v: string): string {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? String(n) : v;
}
