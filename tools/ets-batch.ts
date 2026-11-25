// The bookkeeping of an unattended batch of sweep rows (tools/ets-driver.ts batch): which rows of the catalogue list
// (tools/ets-catalogue.ts) a batch runs, which of them it has finished, where it resumes, what a failure of a row
// means for the batch, and its log. Nothing here touches ETS; the driver does.
//
// A batch writes each row as the driver writes it, under <out>/<application>/<variant>/ (the corpus's row layout,
// outside the corpus until the row is judged), and beside the row's files RESULT_FILE: how the row ended. A row
// with a result is finished and never run again unless asked; a row directory without one is a run that stopped
// in the middle (the batch paused, the bench host slept, the runner was killed): it is moved aside under
// <out>/.interrupted/ and the row runs again from its start. <out>/batch.log holds one line per row with its
// minutes and how it ended, every restart of ETS and every pause, and a heartbeat line every few minutes.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogueList, Row as ListRow } from "./ets-catalogue.ts";

// The catalogue list's format (tools/ets-catalogue.ts writes it; kept here, as that tool imports the driver).
export const CATALOGUE_LIST_FORMAT = "busforge-ets-catalogue-list/1";
export const RESULT_FILE = "batch-result.json";
export const RESULT_FORMAT = "busforge-ets-batch-result/1";
export const BATCH_LOG = "batch.log";
export const VARIANT = "defaults";

// How a row of a batch ended. completed: ETS's download into the simulator ended and the row is written, to be
// judged (tools/ets-sweep.ts); ets-failed: ETS's load task failed, the row written with it; both with any refusal of
// the unit after its restart that leaves the comparison whole named; sim-refused: no unit for the row (no donor of its
// mask, the product's identity does not fit its donor), nothing downloaded, or the unit refused a request of ETS's run
// that leaves the comparison not whole (the row written, ETS's message beside the refusal); driver-failed: the driver
// could not finish the row, or refuses to drive it, with the reason.
export type RowKind = "completed" | "ets-failed" | "sim-refused" | "driver-failed";

// One run of the row: a row runs again after ETS was restarted under it, and for each round of the identity loop.
export interface Attempt { kind: RowKind | "restarted" | "identity"; why?: string; minutes: number; dir?: string }

export interface RowResult {
  format: typeof RESULT_FORMAT;
  application: string; manufacturer: string; mask: string; orderNumber: string;
  kind: RowKind; why?: string;
  // Minutes from the row's start to its end, every attempt counted.
  minutes: number; startedAt: string; endedAt: string;
  attempts: Attempt[];
  // The unit: an own unit's id, or the catalogue unit's donor.
  unit?: string;
  // A full-resolution screenshot of the failure, a file of the row's directory.
  screenshot?: string;
}

// ---- which rows ----

export interface Selection { only?: string[]; from?: string; count?: number }

// The rows of a batch, in the list's order: those `only` names (every one of them must be a row of the list), from
// the row of the application `from` on, at most `count` of them.
export function batchRows(list: Pick<CatalogueList, "rows">, sel: Selection): ListRow[] {
  let rows = list.rows;
  if (sel.only) {
    const want = new Set(sel.only);
    const missing = [...want].filter((a) => !rows.some((r) => r.application === a));
    if (missing.length) throw new Error(`not rows of the list: ${missing.join(", ")}`);
    rows = rows.filter((r) => want.has(r.application));
  }
  if (sel.from !== undefined) {
    const i = rows.findIndex((r) => r.application === sel.from);
    if (i < 0) throw new Error(`${sel.from} is no row of the batch`);
    rows = rows.slice(i);
  }
  return sel.count === undefined ? rows : rows.slice(0, sel.count);
}

// ---- where a batch stands ----

export const rowDirOf = (out: string, application: string) => join(out, application, VARIANT);

export function readResult(dir: string): RowResult | null {
  const f = join(dir, RESULT_FILE);
  if (!existsSync(f)) return null;
  const r = JSON.parse(readFileSync(f, "utf8")) as RowResult;
  const format: unknown = r.format;
  if (format !== RESULT_FORMAT) throw new Error(`${f} is of format ${String(format)}, not ${RESULT_FORMAT}`);
  return r;
}

// What the batch does with each row: run it (no result yet, or a rerun asked for its kind or its application), or
// pass it with the result it has. A rerun by kind passes a row the driver refused by name (`why` "refused: …": it
// would be refused the same); naming the row reruns it.
export interface Plan { run: ListRow[]; finished: { row: ListRow; result: RowResult }[] }
export function planBatch(out: string, rows: ListRow[], rerun: { kinds?: RowKind[]; applications?: string[] } = {}): Plan {
  const plan: Plan = { run: [], finished: [] };
  for (const row of rows) {
    const result = readResult(rowDirOf(out, row.application));
    const again = result && ((rerun.kinds?.includes(result.kind) && !result.why?.startsWith("refused:")) || rerun.applications?.includes(row.application));
    if (result && !again) plan.finished.push({ row, result });
    else plan.run.push(row);
  }
  return plan;
}

// A row's result written whole or not at all (a stop while writing leaves no half file to read as finished).
export function writeResult(out: string, r: RowResult): void {
  const dir = rowDirOf(out, r.application), tmp = join(dir, `.${RESULT_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(r, null, 1)}\n`);
  renameSync(tmp, join(dir, RESULT_FILE));
}

// A run of a row that does not stand (ETS restarted under it, a round of the identity loop) moved from the row's
// directory to <out>/.attempts/<application>/<n>, n the next number free there (an earlier batch's attempts stay).
export function moveAttempt(out: string, application: string): string {
  const base = join(out, ".attempts", application);
  mkdirSync(base, { recursive: true });
  const n = Math.max(0, ...readdirSync(base).filter((f) => /^\d+$/.test(f)).map(Number)) + 1;
  const to = join(base, String(n));
  renameSync(rowDirOf(out, application), to);
  return to;
}

// A row's directory cleared for a run: what an earlier run left there (a run that stopped in the middle, or a
// finished row asked to run again) moved aside under <out>/.interrupted/, never deleted. Returns where it went.
export function clearRowDir(out: string, application: string, stamp: string): string | null {
  const dir = rowDirOf(out, application);
  if (!existsSync(dir) || readdirSync(dir).length === 0) return null;
  const aside = join(out, ".interrupted", `${application}-${stamp}`);
  mkdirSync(join(out, ".interrupted"), { recursive: true });
  renameSync(dir, aside);
  return aside;
}

// ---- what a failure means for the batch ----

// pause: the batch stops and returns early, the row without a result (it runs again on resume): the bench host
// does not answer (asleep), the KNX-ID login lapsed, the online catalogue does not answer, ETS cannot be started or
// brought back (the driver then pauses it: runRow). restart: ETS is gone or
// shows one of its internal errors; it is restarted and the row runs once more. dialog: a dialog the driver does
// not know; the row is driver-failed with its screenshot, the dialog closed or ETS restarted. row: the row's own
// failure, driver-failed.
export type FailureClass =
  | { kind: "pause"; reason: "host" | "login" | "catalogue" | "ets"; why: string }
  | { kind: "restart"; reason: "ets-gone" | "ets-internal"; why: string }
  | { kind: "dialog"; why: string }
  | { kind: "row"; why: string };

// The driver's messages that name a dialog it did not expect, with the dialog's text after the colon.
export const UNKNOWN_DIALOG = "ETS shows a dialog the driver does not know";

// ssh's own failures (spawnSync's and ssh's messages): the bench host is down, asleep or off the network.
// A connection dropped in the middle of a command (the host suspending or rebooting) says so in ssh's own words too.
const HOST_DOWN = /spawnSync ssh (?:ETIMEDOUT|ENOENT)|ssh: connect to host .* (?:Operation timed out|Host is down|No route to host|Connection refused|Network is unreachable)|ssh: Could not resolve hostname|Connection (?:timed out|closed by remote host) during banner exchange|kex_exchange_identification|Connection to \S+ closed by remote host|client_loop: send disconnect|Broken pipe|Connection reset by peer/;
// A login ETS asks for: its KNX ID (the online catalogue's account, logged in by a QR code on Thorben's phone).
const LOGIN = /KNX[ -]?ID|Anmeld|QR[ -]?Code|\bLogin\b|einloggen/i;
// The online catalogue that does not answer or refuses (OCR reads "fehlgeschlagen" as "fehigeschlagen").
const CATALOGUE = /Online-Katalog|Produktdownload|WebException|Katalog.{0,40}(?:nicht erreichbar|Verbindung)/i;
// ETS's internal errors: an exception's text in a dialog ("Die Sammlung wurde geändert", .NET's "Collection was
// modified"), or ETS's own error report.
const ETS_INTERNAL = /Sammlung wurde ge|Collection was modified|Exception|unerwartete[nr]? Fehler|Ein Fehler ist aufgetreten|Fehlerbericht|Unhandled/i;
const ETS_GONE = /^ETS's window is gone/;
// ETS that cannot be started or is not this driver's: nothing a row can change.
const ETS_UNAVAILABLE = /ETS did not start:|ETS needs a restart|an ETS this driver did not start|another Xvfb serves|ETS not recovered/;

// What a failure of a row means for the batch, from the driver's message.
export function classifyFailure(why: string): FailureClass {
  if (HOST_DOWN.test(why)) return { kind: "pause", reason: "host", why };
  if (ETS_UNAVAILABLE.test(why)) return { kind: "pause", reason: "ets", why };
  // ETS gone under a step, whatever the step met then (a dialog's text among it).
  if (ETS_GONE.test(why)) return { kind: "restart", reason: "ets-gone", why };
  const dialog = why.startsWith(UNKNOWN_DIALOG) || /ETS shows a dialog/.test(why) ? why.replace(/^[^:]*:\s*/, "") : null;
  if (dialog !== null) {
    if (LOGIN.test(dialog)) return { kind: "pause", reason: "login", why };
    if (CATALOGUE.test(dialog)) return { kind: "pause", reason: "catalogue", why };
    if (ETS_INTERNAL.test(dialog)) return { kind: "restart", reason: "ets-internal", why };
    return { kind: "dialog", why };
  }
  return { kind: "row", why };
}

// ---- the batch's log ----

const minutes = (m: number) => `${m.toFixed(1)} min`;
export const logLine = (at: Date, text: string) => `${at.toISOString()} ${text}\n`;
export const rowLine = (n: number, total: number, r: RowResult) =>
  `row ${n}/${total} ${r.application} ${r.manufacturer} ${r.mask}: ${r.kind} ${minutes(r.minutes)}${r.attempts.length > 1 ? ` (${r.attempts.length} attempts)` : ""}${r.why ? `: ${r.why.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
export const heartbeatLine = (n: number, total: number, application: string, step: string, rowMinutes: number) =>
  `heartbeat row ${n}/${total} ${application} at "${step}" for ${minutes(rowMinutes)}`;

export function appendLog(out: string, text: string, at = new Date()): void {
  appendFileSync(join(out, BATCH_LOG), logLine(at, text));
}

// The rows of a batch log: the last line of each row (a row run again counts once, as it ended last).
export interface LoggedRow { application: string; kind: RowKind; minutes: number; attempts: number }
export function loggedRows(log: string): LoggedRow[] {
  const out = new Map<string, LoggedRow>();
  for (const l of log.split("\n")) {
    const m = l.match(/^\S+ row \d+\/\d+ (\S+) \S+ \S+: (completed|ets-failed|sim-refused|driver-failed) ([\d.]+) min(?: \((\d+) attempts\))?/);
    if (m) { out.delete(m[1]); out.set(m[1], { application: m[1], kind: m[2] as RowKind, minutes: Number(m[3]), attempts: m[4] ? Number(m[4]) : 1 }); }
  }
  return [...out.values()];
}

// Counts and minutes per kind, as a batch ends.
export function summary(rows: LoggedRow[]): string {
  const by = Object.groupBy(rows, (r) => r.kind);
  const parts = Object.entries(by).map(([k, rs]) => `${k} ${rs!.length} (${minutes(rs!.reduce((a, r) => a + r.minutes, 0) / rs!.length)} each)`);
  return `${rows.length} rows: ${parts.join(", ")}`;
}
