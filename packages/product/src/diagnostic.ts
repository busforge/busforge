import type { CollectPackage, CollectRecord } from "./collect.ts";

// The diagnostic package (docs/raw-acquisition.md, "Diagnostic package"): what a user can save and
// hand on, built from a collector package by removing what identifies the installation and is not
// needed to understand the device. Memory and property bytes stay as the device gave them: Busforge
// cannot tell which of them are installation data, so the package says they are not anonymized.

export type DiagnosticConnection =
  | { kind: "ip"; ipTransport: string }
  | { kind: "usb"; usbVendorId: number | null; usbProductId: number | null };

export interface DiagnosticRecord extends Omit<CollectRecord, "bytes" | "raw"> {
  bytes?: string;
  raw?: string;
  // What was taken out of this record, in place of its bytes.
  removed?: string;
}

export interface DiagnosticPackage {
  format: "busforge-diagnostic/1";
  cleaned: { removed: string[]; notAnonymized: string[] };
  busforge: { version: string; commit: string };
  connection: DiagnosticConnection;
  ia: string;
  mask: string | null;
  family: string | null;
  secured: boolean;
  authorizeLevel: number | null;
  maxApdu: number | null;
  plan: CollectPackage["plan"];
  records: DiagnosticRecord[];
  limits: string[];
  stop: CollectPackage["stop"];
  // A failure of the link or of Busforge around the collection; null when there was none.
  error: string | null;
  counts: CollectPackage["counts"];
  startedAt: number;
  finishedAt: number;
  // When the job took the bus, closed an open monitor (null: none was open) and released the bus.
  bus: { takenAt: number; monitorClosedAt: number | null; releasedAt: number };
}

export const DIAGNOSTIC_REMOVED = [
  "project, device and task id",
  "the connection's host and port, and the interface's USB serial number",
  "the device's serial number (its length is kept)",
];
export const DIAGNOSTIC_NOT_ANONYMIZED = ["memory bytes", "property bytes"];

export interface DiagnosticContext {
  busforge: { version: string; commit: string };
  connection: DiagnosticConnection;
  error: string | null;
  bus: DiagnosticPackage["bus"];
  // Values that must not appear in any text of the package (host, port, USB serial, ids, the device
  // serial). Error texts of the link can carry them; IP address literals are removed from texts too,
  // since a host saved by name reaches the error texts as its address.
  secrets: string[];
}

// Where a device's serial number is read: PID 11 of any interface object (the identity read and the
// scan; element 0 is the element count, not the serial), and the memory resource the M112 plan names
// for it.
const isSerial = (r: CollectRecord) =>
  (r.space === "property" && r.target.pid === 11 && r.target.start !== 0)
  || ((r.space === "memory" || r.space === "memory-extended") && r.step === "serial number");

// An IPv4 address with an optional port.
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\d])/g;
// Anything that may be an IPv6 address, with an optional zone, brackets and port; isIpv6 decides.
const IPV6_CANDIDATE = /(\[)?(?<![\w:.])([0-9a-f]*:[0-9a-f:.]*)(%[\w.-]+)?(\])?(:\d{1,5})?(?![\w:])/gi;
const isIpv4 = (s: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(s);
// Eight groups, or fewer around one "::"; the last two may be written as an IPv4 address. A time of
// day (14:03:30) has neither.
function isIpv6(s: string): boolean {
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  let count = groups.length;
  const last = groups.at(-1);
  if (last?.includes(".")) { if (!isIpv4(last)) return false; groups.pop(); count += 1; }
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return halves.length === 2 ? count <= 7 : count === 8;
}
const scrubIpv6 = (text: string) => text.replace(IPV6_CANDIDATE, (m, open: string | undefined, core: string, _zone, close: string | undefined, port: string | undefined) => {
  if (!isIpv6(core)) return m;
  // Without brackets a trailing ":port" is part of the candidate's core already.
  return `<removed>${!open && close ? close : ""}${!close && port ? port : ""}`;
});

export function toDiagnosticPackage(pkg: CollectPackage, ctx: DiagnosticContext): DiagnosticPackage {
  const secrets = ctx.secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  const scrub = (text: string) => secrets.reduce((t, s) => t.split(s).join("<removed>"), text)
    .replace(/[^\s]+/g, scrubIpv6).replace(IPV4, "<removed>");
  const records = pkg.records.map((r): DiagnosticRecord => {
    const out: DiagnosticRecord = { ...r, detail: r.detail === undefined ? undefined : scrub(r.detail) };
    if (out.detail === undefined) delete out.detail;
    const value = r.bytes ?? r.raw ?? "";
    if (!isSerial(r) || value.length === 0) return out;
    const octets = value.length / 2;
    delete out.bytes;
    delete out.raw;
    out.removed = `serial number, ${octets} byte${octets === 1 ? "" : "s"}`;
    return out;
  });
  return {
    format: "busforge-diagnostic/1",
    cleaned: { removed: DIAGNOSTIC_REMOVED, notAnonymized: DIAGNOSTIC_NOT_ANONYMIZED },
    busforge: ctx.busforge,
    connection: ctx.connection,
    ia: pkg.ia, mask: pkg.mask, family: pkg.family, secured: pkg.secured, authorizeLevel: pkg.authorizeLevel, maxApdu: pkg.maxApdu,
    plan: pkg.plan && { ...pkg.plan, notAttempted: pkg.plan.notAttempted.map((n) => ({ ...n, reason: scrub(n.reason) })) },
    records,
    limits: pkg.limits.map(scrub),
    stop: pkg.stop && { reason: pkg.stop.reason, detail: scrub(pkg.stop.detail) },
    error: ctx.error === null ? null : scrub(ctx.error),
    counts: pkg.counts,
    startedAt: pkg.startedAt, finishedAt: pkg.finishedAt,
    bus: ctx.bus,
  };
}
