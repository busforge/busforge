import type { Database } from "bun:sqlite";
import { getConnection } from "./connections.ts";

// THE single definition of a project's portable, project-level properties: the
// settings that ARE the project, beyond its structural rows (devices, group
// addresses, parameters, links). Both serializers that capture "the project"
// consume this one type and these two functions:
//   - the .busforge export (exportProject / importProject)
//   - config snapshots (serializeConfig / restoreSnapshot)
// so a new project-level property is added in exactly ONE place and can never be
// carried by one path while being forgotten by the other. Do NOT hand-pick
// project columns in those serializers; extend ProjectProperties here instead.
export interface ProjectProperties {
  name: string;
  // Reference to the saved connection the project uses (null = none). The
  // connection's DETAILS live in the global `connections` library and are never
  // part of a project, only this reference travels with it.
  connectionId: string | null;
}

// Read a project's properties, or null when the project does not exist.
export function readProjectProperties(db: Database, projectId: string): ProjectProperties | null {
  return (db.query("SELECT name, connection_id AS connectionId FROM projects WHERE id = ?")
    .get(projectId) as ProjectProperties | null) ?? null;
}

// Apply properties onto an existing project row (used by both snapshot restore
// and project import). connectionId is only re-applied if that saved connection
// still exists here: foreign_keys=ON would reject a dangling reference, and a
// missing connection should gracefully fall back to "none" so the user re-picks.
export function applyProjectProperties(db: Database, projectId: string, p: ProjectProperties): void {
  const connectionId = p.connectionId && getConnection(db, p.connectionId) ? p.connectionId : null;
  db.prepare("UPDATE projects SET name = ?, connection_id = ? WHERE id = ?").run(p.name, connectionId, projectId);
}
