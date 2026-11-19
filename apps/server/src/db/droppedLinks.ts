import type { Database } from "bun:sqlite";
import type { DroppedLink, DroppedLinkReason } from "@busforge/project";

// The com-objects whose ETS links an import did not take over in full, kept with the project so the
// links can be made again by hand (import_dropped_links). Written once, at import; read for the
// project's list of them.

const REASONS: ReadonlySet<string> = new Set<DroppedLinkReason>(["addressNotInProject", "senderNotInProject", "noSingleSender", "moduleInstanceGone"]);

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isGaList = (x: unknown): x is DroppedLink["gas"] => Array.isArray(x) && x.every((g) =>
  isRecord(g) && typeof g.etsId === "string" && (g.raw === undefined || (Number.isInteger(g.raw) && (g.raw as number) >= 0 && (g.raw as number) <= 0xffff)));

// Whether a value is a DroppedLink (a stored row's or a .busforge export's).
export function isDroppedLink(x: unknown): x is DroppedLink {
  return isRecord(x) && typeof x.deviceId === "string" && typeof x.comObjRefId === "string" && typeof x.reason === "string" && REASONS.has(x.reason) && isGaList(x.gas);
}

// Runs inside the caller's transaction (an import writes the project in one).
export function putDroppedLinks(db: Database, projectId: string, links: DroppedLink[]): void {
  const ins = db.prepare("INSERT INTO import_dropped_links (project_id, seq, device_id, com_obj_ref_id, reason, gas) VALUES (?, ?, ?, ?, ?, ?)");
  links.forEach((l, seq) => ins.run(projectId, seq, l.deviceId, l.comObjRefId, l.reason, JSON.stringify(l.gas.map(({ etsId, raw }) => (raw === undefined ? { etsId } : { etsId, raw })))));
}

// In import order, for the devices the project still has.
export function listDroppedLinks(db: Database, projectId: string): DroppedLink[] {
  const rows = db.query(`SELECT l.device_id AS deviceId, l.com_obj_ref_id AS comObjRefId, l.reason, l.gas FROM import_dropped_links l
    JOIN devices d ON d.project_id = l.project_id AND d.instance_id = l.device_id WHERE l.project_id = ? ORDER BY l.seq`).all(projectId) as { deviceId: string; comObjRefId: string; reason: string; gas: string }[];
  return rows.map((r) => {
    const link = { deviceId: r.deviceId, comObjRefId: r.comObjRefId, reason: r.reason, gas: JSON.parse(r.gas) as unknown };
    if (!isDroppedLink(link)) throw new Error(`import_dropped_links row ${projectId}/${r.deviceId}/${r.comObjRefId} is not a DroppedLink (corrupt store)`);
    return link;
  });
}
