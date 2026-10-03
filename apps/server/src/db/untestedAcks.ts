import type { Database } from "bun:sqlite";

export function acknowledgeUntested(db: Database, projectId: string, productRef: string, appProgramId: string, now: number): void {
  db.prepare("INSERT OR IGNORE INTO untested_acks (project_id, product_ref, app_program_id, acknowledged_at) VALUES (?, ?, ?, ?)")
    .run(projectId, productRef, appProgramId, now);
}

export function isUntestedAcknowledged(db: Database, projectId: string, productRef: string, appProgramId: string): boolean {
  return !!db.query("SELECT 1 FROM untested_acks WHERE project_id = ? AND product_ref = ? AND app_program_id = ?").get(projectId, productRef, appProgramId);
}
