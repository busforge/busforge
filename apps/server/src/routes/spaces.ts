import { createSpace, renameSpace, deleteSpace, spaceDeviceImpact, assignDeviceSpace, spaceExists } from "../db/spaceedit.ts";
import { getProject, projectExists } from "../db/projects.ts";
import { createSnapshot } from "../db/snapshots.ts";
import { securityChanges } from "../deviceservice.ts";
import { json, err, text } from "../httputil.ts";
import type { AppState } from "../app.ts";

// --- building structure (spaces). Edits are pure project organisation, never
// flashed; all return the refreshed project. Consistent with group-address
// editing: the structure rides in every snapshot payload + the .busforge export
// (so a restore reverts it), and the destructive delete captures an undo point.
export async function handle(req: Request, _url: URL, seg: string[], state: AppState): Promise<Response | null> {
  const { db } = state;
  const id = seg[2];

  // /api/projects/:id/spaces  -> create a building/floor/room under a parent (null = root)
  if (seg.length === 4 && seg[3] === "spaces" && req.method === "POST") {
    if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    const body = (await req.json().catch(() => ({}))) as { parentId?: number | null; type?: unknown; name?: unknown };
    const type = text(body.type);
    if (!type) return err("SPACE_FIELDS_REQUIRED", "space type required");
    createSpace(db, id, body.parentId ?? null, type, text(body.name));
    return json(getProject(db, id, securityChanges(state, id)), 201);
  }
  // /api/projects/:id/spaces/:spaceId/impact  -> devices unassigned if deleted
  if (seg.length === 6 && seg[3] === "spaces" && seg[5] === "impact" && req.method === "GET") {
    return json({ devices: spaceDeviceImpact(db, id, Number(decodeURIComponent(seg[4]))) });
  }
  // /api/projects/:id/spaces/:spaceId  -> rename, or delete (subtree + memberships
  // cascade; the devices themselves survive as unassigned).
  if (seg.length === 5 && seg[3] === "spaces") {
    const spaceId = Number(decodeURIComponent(seg[4]));
    if (req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (!renameSpace(db, id, spaceId, text(body.name))) return err("SPACE_NOT_FOUND", "space not found", 404);
      return json(getProject(db, id, securityChanges(state, id)));
    }
    if (req.method === "DELETE") {
      if (!spaceExists(db, id, spaceId)) return err("SPACE_NOT_FOUND", "space not found", 404);
      createSnapshot(db, id, { kind: "auto", reason: "before-space-edit" }, state.now());
      deleteSpace(db, id, spaceId);
      return json(getProject(db, id, securityChanges(state, id)));
    }
  }
  // /api/projects/:id/devices/:deviceId/space  -> assign device to a space (or null to unassign)
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "space" && req.method === "PUT") {
    const deviceId = decodeURIComponent(seg[4]);
    const body = (await req.json().catch(() => ({}))) as { spaceId?: number | null };
    if (!assignDeviceSpace(db, id, deviceId, body.spaceId ?? null)) return err("SPACE_ASSIGN_FAILED", "device or space not found", 404);
    return json(getProject(db, id, securityChanges(state, id)));
  }

  return null;
}
