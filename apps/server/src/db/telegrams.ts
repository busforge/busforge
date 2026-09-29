import type { Database } from "bun:sqlite";
import { numToGa } from "@busforge/knx";
import type { Telegram, TelegramKind, TelegramSecurity } from "../telegram.ts";

export function insertTelegram(db: Database, projectId: string, t: Telegram): void {
  db.prepare("INSERT INTO telegrams (project_id, ts, src, dst_raw, kind, data, security) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(projectId, t.ts, t.src, t.dstRaw, t.kind, t.raw, t.security ?? null);
}

// The most recent telegrams for a project, oldest first (ready to replay as a
// monitor backlog). GA name and decoded value are resolved client-side.
export function recentTelegrams(db: Database, projectId: string, limit: number): Telegram[] {
  const rows = db.query(`
    SELECT t.ts, t.src, t.dst_raw AS dstRaw, t.kind, t.data, t.security
    FROM telegrams t WHERE t.project_id = ?
    ORDER BY t.ts DESC, t.id DESC LIMIT ?
  `).all(projectId, limit) as { ts: number; src: string; dstRaw: number; kind: TelegramKind; data: string; security: TelegramSecurity | null }[];

  return rows.reverse().map((r) => ({
    ts: r.ts, src: r.src, dst: numToGa(r.dstRaw), dstRaw: r.dstRaw, kind: r.kind, raw: r.data,
    ...(r.security ? { security: r.security } : {}),
  }));
}

// Drop telegrams older than the cutoff. Returns how many rows were removed.
export function pruneTelegrams(db: Database, olderThanTs: number): number {
  return db.prepare("DELETE FROM telegrams WHERE ts < ?").run(olderThanTs).changes;
}
