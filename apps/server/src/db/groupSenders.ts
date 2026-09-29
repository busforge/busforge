import type { Database } from "bun:sqlite";
import { iaToNum, numToIa } from "@busforge/knx";
import { ApiError } from "../errors.ts";

// Individual addresses a project lets send on a group address besides the devices' own linked objects:
// the bus interfaces (tunnelling channels) ETS assigns to an address, and the ones added in Busforge.
// For a secured address, every receiving device lists them in its security individual address table
// (PID 54), or it drops their secured telegrams. See docs/knx-secure.md.

export type SenderSource = "import" | "busforge";
export interface GroupSenderRow { gaRaw: number; ia: string; source: SenderSource; }

function checkGa(gaRaw: number): void {
  if (!Number.isInteger(gaRaw) || gaRaw < 1 || gaRaw > 0xffff) throw new ApiError("GA_NOT_FOUND", `${gaRaw} is not a group address`, 404);
}
// Whether a string is an individual address "a.l.d" with each part in range, 0.0.0 excluded.
export function isIndividualAddress(ia: string): boolean {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/.exec(ia.trim());
  return !!m && Number(m[1]) <= 15 && Number(m[2]) <= 15 && Number(m[3]) <= 255 && iaToNum(ia.trim()) !== 0;
}
// Canonical "a.l.d"; a sender must be one bus device.
export function checkSenderIa(ia: string): string {
  if (!isIndividualAddress(ia)) throw new ApiError("SENDER_INVALID", `${ia} is not an individual address`);
  return numToIa(iaToNum(ia.trim()));
}
// A 6-byte sequence: the largest a secured telegram can carry.
export const MAX_SEQUENCE = 2n ** 48n - 1n;

export function putGroupSenders(db: Database, projectId: string, rows: GroupSenderRow[]): void {
  const ins = db.prepare("INSERT OR IGNORE INTO group_senders (project_id, ga_raw, ia, source) VALUES (?, ?, ?, ?)");
  db.transaction(() => { for (const r of rows) { checkGa(r.gaRaw); ins.run(projectId, r.gaRaw, checkSenderIa(r.ia), r.source); } })();
}

export function addGroupSender(db: Database, projectId: string, gaRaw: number, ia: string): void {
  checkGa(gaRaw);
  db.prepare("INSERT OR IGNORE INTO group_senders (project_id, ga_raw, ia, source) VALUES (?, ?, ?, 'busforge')").run(projectId, gaRaw, checkSenderIa(ia));
}

export function removeGroupSender(db: Database, projectId: string, gaRaw: number, ia: string): boolean {
  return db.prepare("DELETE FROM group_senders WHERE project_id = ? AND ga_raw = ? AND ia = ?").run(projectId, gaRaw, checkSenderIa(ia)).changes > 0;
}

// Ordered by address and then by individual address as a number, the order a device's table takes.
export function listGroupSenders(db: Database, projectId: string): GroupSenderRow[] {
  const rows = db.query("SELECT ga_raw AS gaRaw, ia, source FROM group_senders WHERE project_id = ?").all(projectId) as GroupSenderRow[];
  return rows.sort((a, b) => a.gaRaw - b.gaRaw || iaToNum(a.ia) - iaToNum(b.ia));
}

export function sendersByGroup(db: Database, projectId: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const r of listGroupSenders(db, projectId)) out.set(r.gaRaw, [...(out.get(r.gaRaw) ?? []), r.ia]);
  return out;
}

// The next secured group sequence a sender uses: above the last one it used from this project, and
// never behind the clock-derived start (the tool sequence epoch), so it also stays ahead of whatever
// a receiver saw from an earlier installation of Busforge. Persisted before the telegram is sent.
export function nextSendSequence(db: Database, projectId: string, ia: string, clock: bigint): bigint {
  return db.transaction(() => {
    const row = db.query("SELECT last FROM send_sequences WHERE project_id = ? AND ia = ?").get(projectId, ia) as { last: string } | null;
    const next = row && BigInt(row.last) >= clock ? BigInt(row.last) + 1n : clock;
    if (next > MAX_SEQUENCE) throw new ApiError("SECURE_SEQUENCE_EXHAUSTED", `the secured sequence of ${ia} has reached its 48-bit end`, 409);
    db.prepare("INSERT OR REPLACE INTO send_sequences (project_id, ia, last) VALUES (?, ?, ?)").run(projectId, ia, next.toString());
    return next;
  })();
}

export function listSendSequences(db: Database, projectId: string): { ia: string; last: string }[] {
  return db.query("SELECT ia, last FROM send_sequences WHERE project_id = ? ORDER BY ia").all(projectId) as { ia: string; last: string }[];
}
export function putSendSequences(db: Database, projectId: string, rows: { ia: string; last: string }[]): void {
  const ins = db.prepare("INSERT OR REPLACE INTO send_sequences (project_id, ia, last) VALUES (?, ?, ?)");
  for (const r of rows) ins.run(projectId, checkSenderIa(r.ia), BigInt(r.last).toString());
}
