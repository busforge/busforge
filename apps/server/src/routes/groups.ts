import { createGroupRange, renameGroupRange, deleteGroupRange, createGroupAddress, updateGroupAddress, deleteGroupAddress, rangeLinkImpact, countLinksForRaws, groupRangeExists, groupAddressExists } from "../db/groupedit.ts";
import { getProject, projectExists } from "../db/projects.ts";
import { createSnapshot } from "../db/snapshots.ts";
import { buildGaDevicesView } from "../deviceservice.ts";
import { addGroupSender, removeGroupSender } from "../db/groupSenders.ts";
import { json, err, text } from "../httputil.ts";
import type { AppState } from "../app.ts";

// Group-address structure editing (ranges + addresses) and the GA devices overlay.
export async function handle(req: Request, url: URL, seg: string[], state: AppState): Promise<Response | null> {
  const { db } = state;
  const id = seg[2];

  // /api/projects/:id/group-addresses/:raw/devices?lang=  -> which devices use this GA
  if (seg.length === 6 && seg[3] === "group-addresses" && seg[5] === "devices" && req.method === "GET") {
    const raw = Number(decodeURIComponent(seg[4]));
    if (!Number.isInteger(raw)) return err("GA_NOT_FOUND", "group address not found", 404);
    return json(buildGaDevicesView(state, id, raw, url.searchParams.get("lang") ?? undefined));
  }

  // /api/projects/:id/group-addresses/:raw/senders  (POST {ia})  and  .../senders/:ia  (DELETE)
  // The individual addresses the project assigns as senders of the address (a tunnelling channel).
  // For a secured address they go into its receivers' security tables with their next GA flash.
  if (seg[3] === "group-addresses" && seg[5] === "senders" && (seg.length === 6 || seg.length === 7)) {
    const raw = Number(decodeURIComponent(seg[4]));
    if (!Number.isInteger(raw) || !groupAddressExists(db, id, raw)) return err("GA_NOT_FOUND", "group address not found", 404);
    if (seg.length === 6 && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { ia?: unknown };
      addGroupSender(db, id, raw, text(body.ia));
      return json(buildGaDevicesView(state, id, raw));
    }
    if (seg.length === 7 && req.method === "DELETE") {
      if (!removeGroupSender(db, id, raw, decodeURIComponent(seg[6]))) return err("SENDER_NOT_FOUND", "that address is not a sender of this group address", 404);
      return json(buildGaDevicesView(state, id, raw));
    }
  }

  // --- group-address structure editing -------------------------------------
  // /api/projects/:id/group-ranges  -> create a main/middle range
  if (seg.length === 4 && seg[3] === "group-ranges" && req.method === "POST") {
    if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    const body = (await req.json().catch(() => ({}))) as { parentId?: number | null; name?: unknown; number?: number };
    if (typeof body.number !== "number") return err("GA_NUMBER_INVALID", "number required");
    createGroupRange(db, id, body.parentId ?? null, text(body.name), body.number);
    return json(getProject(db, id), 201);
  }
  // /api/projects/:id/group-ranges/:rangeId/impact  -> live links lost if deleted
  if (seg.length === 6 && seg[3] === "group-ranges" && seg[5] === "impact" && req.method === "GET") {
    return json({ links: rangeLinkImpact(db, id, Number(decodeURIComponent(seg[4]))) });
  }
  // /api/projects/:id/group-ranges/:rangeId  -> rename, or delete (deletes
  // capture an undo snapshot first, but only once the target is known to exist).
  if (seg.length === 5 && seg[3] === "group-ranges") {
    const rangeId = Number(decodeURIComponent(seg[4]));
    if (req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown };
      if (!renameGroupRange(db, id, rangeId, text(body.name))) return err("GA_RANGE_NOT_FOUND", "range not found", 404);
      return json(getProject(db, id));
    }
    if (req.method === "DELETE") {
      if (!groupRangeExists(db, id, rangeId)) return err("GA_RANGE_NOT_FOUND", "range not found", 404);
      createSnapshot(db, id, { kind: "auto", reason: "before-ga-edit" }, state.now());
      deleteGroupRange(db, id, rangeId);
      return json(getProject(db, id));
    }
  }
  // /api/projects/:id/group-addresses  -> create a group address in a range
  if (seg.length === 4 && seg[3] === "group-addresses" && req.method === "POST") {
    if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    const body = (await req.json().catch(() => ({}))) as { rangeId?: number; sub?: number; name?: unknown; dpt?: unknown };
    if (typeof body.rangeId !== "number" || typeof body.sub !== "number") return err("GA_FIELDS_REQUIRED", "rangeId and sub required");
    createGroupAddress(db, id, body.rangeId, body.sub, text(body.name), text(body.dpt));
    return json(getProject(db, id), 201);
  }
  // /api/projects/:id/group-addresses/:raw/impact  -> live links lost if deleted
  if (seg.length === 6 && seg[3] === "group-addresses" && seg[5] === "impact" && req.method === "GET") {
    return json({ links: countLinksForRaws(db, id, [Number(decodeURIComponent(seg[4]))]) });
  }
  // /api/projects/:id/group-addresses/:raw  -> edit name+dpt, or delete (deletes
  // capture an undo snapshot first, but only once the target is known to exist).
  if (seg.length === 5 && seg[3] === "group-addresses") {
    const raw = Number(decodeURIComponent(seg[4]));
    if (req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { name?: unknown; dpt?: unknown };
      if (!updateGroupAddress(db, id, raw, text(body.name), text(body.dpt))) return err("GA_NOT_FOUND", "group address not found", 404);
      return json(getProject(db, id));
    }
    if (req.method === "DELETE") {
      if (!groupAddressExists(db, id, raw)) return err("GA_NOT_FOUND", "group address not found", 404);
      createSnapshot(db, id, { kind: "auto", reason: "before-ga-edit" }, state.now());
      deleteGroupAddress(db, id, raw);
      return json(getProject(db, id));
    }
  }

  return null;
}
