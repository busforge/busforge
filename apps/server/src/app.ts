import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { loadKnxproj, readAppProgram, extractAppPrograms, extractCatalogProducts, appProgramId, readBaggage, type Project } from "@busforge/project";
import { parseAppConfig, buildDeviceConfig, type AppConfig, type ComObjectLink, type ComObjFlags } from "@busforge/product";
import { Bus } from "./bus.ts";
import { openDb } from "./db/schema.ts";
import { insertProject, createProject, addDevice, listProjects, getProject, deleteProject, renameProject, projectExists, getProjectConnection, setProjectConnection, getGaMeta, countSpacesByType } from "./db/projects.ts";
import { listConnections, getConnection, createConnection, updateConnection, deleteConnection, type ConnectionInput } from "./db/connections.ts";
import { isConnectionReady } from "./transport.ts";
import { searchInterfaces, listUsbInterfaces } from "@busforge/knx";
import { listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } from "./db/snapshots.ts";
import { createGroupRange, renameGroupRange, deleteGroupRange, createGroupAddress, updateGroupAddress, deleteGroupAddress, rangeLinkImpact, countLinksForRaws } from "./db/groupedit.ts";
import { createSpace, renameSpace, deleteSpace, spaceDeviceImpact, assignDeviceSpace } from "./db/spaceedit.ts";
import { putAppProgram, getAppProgram, gcAppPrograms, putCatalogProduct, listCatalogProducts, getCatalogProduct, backfillCatalogFromDevices } from "./db/catalog.ts";
import { putBaggage, getDeviceBaggage, projectHasBaggage } from "./db/baggage.ts";
import { exportProject } from "./db/exportProject.ts";
import { importProjectExport, validateExport } from "./db/importProject.ts";
import { packBusforge, unpackBusforge } from "./db/busforgeArtifact.ts";
import { insertTelegram, recentTelegrams } from "./db/telegrams.ts";
import { getDeviceParams, getDeviceParamBase, setDeviceParam, deleteDeviceParam, getDeviceModules, getDeviceLinks, setDeviceLink, getDeviceAppRef, getDeviceForFlash, getSourceFile, getDeviceChangedKeys, revertDevice, revertDeviceParam, revertDeviceLink, replaceParamBase, replaceLinkBase, resetParamBase, resetLinkBase, getGaLinks } from "./db/deviceparams.ts";
import { flashDeviceParameters, flashDeviceGroupAddresses, readDeviceState, classify } from "./deviceprofile.ts";
import { versionInfo } from "./version.ts";
import { ApiError, errorCode } from "./errors.ts";
import { TaskQueue } from "./taskqueue.ts";
import { resolveDcaModule } from "./dca.ts";

export interface AppState {
  db: Database;
  bus: Bus;
  dataDir: string;
  now: () => number;
  // One physical interface, so bus operations (read/flash) run serially through
  // this queue instead of rejecting each other; it also surfaces their progress.
  queue: TaskQueue;
  // Parsed application programs cached per application-program id; catalog entries
  // are immutable manufacturer data, so this never needs invalidation within a run.
  appCache: Map<string, AppConfig>;
}

const DEFAULT_DATA_DIR = join(import.meta.dir, "..", "data");

export function createState(opts?: { dbPath?: string; dataDir?: string; now?: () => number }): AppState {
  const dataDir = opts?.dataDir ?? DEFAULT_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(opts?.dbPath ?? join(dataDir, "busforge.db"));
  const bus = new Bus(opts?.now);
  // Persistent writer: every telegram of the active project is stored, whether
  // or not a monitor WebSocket is open.
  bus.subscribe((t) => { if (bus.activeProjectId) insertTelegram(db, bus.activeProjectId, t); });
  const now = opts?.now ?? (() => Date.now());
  return { db, bus, dataDir, now, appCache: new Map(), queue: new TaskQueue(now) };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
// Error responses carry a stable `code` (for client localization) plus the
// English `message` as a fallback/log line.
const err = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

// Validate a saved-connection payload for the connection library. Returns the
// normalized fields, or an English error string on invalid input.
function parseConnInput(raw: unknown): ConnectionInput | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  // type defaults to 'ip', inferring 'usb' when a usb identity is supplied.
  const type = b.type === "usb" ? "usb" : b.type === "ip" ? "ip" : (b.usbVendorId != null ? "usb" : "ip");
  if (type === "ip") {
    const host = (typeof b.host === "string" ? b.host : "").trim();
    if (!host) return "host (IP address) required for an IP connection";
    const port = Number(b.port) || 3671;
    return { name: name || host, type, host, port, usbVendorId: null, usbProductId: null, usbSerial: null };
  }
  const usbVendorId = Number(b.usbVendorId);
  const usbProductId = Number(b.usbProductId);
  if (!Number.isInteger(usbVendorId) || !Number.isInteger(usbProductId)) return "usbVendorId and usbProductId required for a USB connection";
  const usbSerial = typeof b.usbSerial === "string" ? b.usbSerial : null;
  return { name: name || "KNX-USB", type, host: "", port: 3671, usbVendorId, usbProductId, usbSerial };
}

// Handle an /api/* request. Returns null for non-API paths so the caller can
// fall through to static serving.
export async function handleApi(req: Request, state: AppState): Promise<Response | null> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean); // ["api","projects",":id",...]
  if (seg[0] !== "api") return null;
  const { db, bus } = state;

  try {
    // /api/version  -> build/version info for the UI footer (no project scope)
    if (seg[1] === "version" && seg.length === 2 && req.method === "GET") return json(versionInfo());

    // /api/catalog/...  -> browsable device catalog for placing into projects
    if (seg[1] === "catalog") {
      if (seg.length === 3 && seg[2] === "products" && req.method === "GET") {
        // Surface products from projects imported before the catalog table existed.
        backfillCatalogFromDevices(db);
        return json(listCatalogProducts(db));
      }
      // /api/catalog/import  -> ingest an official .knxprod product database into the
      // catalog (products + their application programs). No project is created; the
      // products are pinned so they persist independent of any project.
      if (seg.length === 3 && seg[2] === "import" && req.method === "POST") {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
        const bytes = Buffer.from(await file.arrayBuffer());
        // A non-zip (or a zip without manufacturer data) is the realistic wrong-file
        // case; report it as "not a product database" rather than leaking the
        // .knxproj-worded INVALID_KNXPROJ from the zip reader.
        let products: ReturnType<typeof extractCatalogProducts> = [];
        try { products = extractCatalogProducts(bytes); } catch { products = []; }
        if (products.length === 0) return err("CATALOG_IMPORT_EMPTY", "no manufacturer products found in the archive");
        const programs = extractAppPrograms(bytes, products.map((p) => p.appRef));
        // Only keep products whose application program is present, so every catalog
        // entry stays placeable.
        const placeable = products.filter((p) => programs.has(p.appProgramId));
        db.transaction(() => {
          for (const [pid, xml] of programs) putAppProgram(db, pid, xml);
          for (const p of placeable) putCatalogProduct(db, p, true);
        })();
        return json({ products: placeable.length, programs: programs.size }, 201);
      }
      return err("NOT_FOUND", "not found", 404);
    }

    // /api/connections  -> reusable library of saved bus connections (IP / USB)
    if (seg[1] === "connections") {
      // discovery: enumerate gateways on the LAN / KNX-USB sticks for the picker
      if (seg.length === 3 && seg[2] === "discover-ip" && req.method === "GET") {
        return json(await searchInterfaces());
      }
      if (seg.length === 3 && seg[2] === "discover-usb" && req.method === "GET") {
        try { return json(await listUsbInterfaces()); }
        catch { return err("USB_UNAVAILABLE", "USB support is not available on this server"); }
      }
      if (seg.length === 2 && req.method === "GET") return json(listConnections(db));
      if (seg.length === 2 && req.method === "POST") {
        const input = parseConnInput(await req.json().catch(() => ({})));
        if (typeof input === "string") return err("CONNECTION_FIELDS_INVALID", input);
        return json(createConnection(db, randomUUID(), input, state.now()), 201);
      }
      if (seg.length === 3) {
        const cid = decodeURIComponent(seg[2]);
        if (req.method === "PUT") {
          const input = parseConnInput(await req.json().catch(() => ({})));
          if (typeof input === "string") return err("CONNECTION_FIELDS_INVALID", input);
          const updated = updateConnection(db, cid, input);
          return updated ? json(updated) : err("CONNECTION_NOT_FOUND", "connection not found", 404);
        }
        if (req.method === "DELETE") {
          return deleteConnection(db, cid) ? json({ ok: true }) : err("CONNECTION_NOT_FOUND", "connection not found", 404);
        }
      }
      return err("NOT_FOUND", "not found", 404);
    }
    if (seg[1] !== "projects") return err("NOT_FOUND", "not found", 404);

    // /api/projects
    if (seg.length === 2 && req.method === "GET") return json(listProjects(db));

    // /api/projects  (POST: create a blank project, no import)
    if (seg.length === 2 && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = (body.name ?? "").trim();
      if (!name) return err("PROJECT_NAME_REQUIRED", "project name required");
      const id = randomUUID();
      createProject(db, id, name, state.now());
      return json({ id, name, deviceCount: 0, gaCount: 0, snapshotCount: 0, buildingCount: 0, floorCount: 0, roomCount: 0 }, 201);
    }

    // /api/projects/import
    if (seg.length === 3 && seg[2] === "import" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
      const password = (form.get("password") as string)?.trim() || undefined; // trim to match /analyze, else a previewed file fails on import
      const name = (file instanceof File ? file.name : "project").replace(/\.knxproj$/i, "");
      const bytes = Buffer.from(await file.arrayBuffer());
      const project = loadKnxproj(bytes, password, name);
      // Extract the referenced application programs up front (pure, reads the zip),
      // so a bad archive fails before anything is written to disk or the DB.
      const programs = extractAppPrograms(bytes, project.devices.map((d) => d.appRef));
      // Catalog product metadata for browsing/placing devices later. Keep only the
      // products whose program we actually stored, so every catalog entry is placeable.
      const catalog = extractCatalogProducts(bytes).filter((p) => programs.has(p.appProgramId));

      const id = randomUUID();
      // DCA baggage (BinaryData/UserFiles, e.g. a DALI gateway's backup-store):
      // the inner zip is only decryptable here, with the import password in hand.
      // Best-effort; never block an import on it. Flattened name keeps the device-id
      // prefix the baggage endpoint filters on.
      let baggage = new Map<string, Buffer>();
      try { baggage = readBaggage(bytes, password); } catch { /* best-effort */ }

      // Everything is stored in the DB; no project files are written at import. The
      // raw .knxproj is not kept (app programs live in the catalog, baggage in the
      // DB), so an import is one atomic transaction with nothing to clean up on
      // failure. source_file is left empty (only legacy projects have a file).
      db.transaction(() => {
        insertProject(db, id, project, "", state.now());
        for (const [pid, xml] of programs) putAppProgram(db, pid, xml);
        for (const p of catalog) putCatalogProduct(db, p);
        for (const [bname, buf] of baggage) putBaggage(db, id, bname.replace(/[/\\]/g, "__"), buf);
      })();
      // Surface what did NOT fully import: devices whose application program was not in
      // the archive (they import as un-configurable husks) and group-address links that
      // referenced an address not in the tree (silently lost). The count alone is no
      // longer the only success signal.
      return json({ id, name: project.name, deviceCount: project.devices.length, gaCount: project.groupAddresses.length, ...importGaps(project, programs) });
    }

    // /api/projects/analyze  (POST: parse a file's metadata for an import preview,
    // persisting nothing). Sniffs by magic: a "PK" zip is a .knxproj, anything else
    // a .busforge artifact. The client confirms with /import or /import-busforge.
    if (seg.length === 3 && seg[2] === "analyze" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
      const password = (form.get("password") as string)?.trim() || undefined;
      const bytes = Buffer.from(await file.arrayBuffer());
      const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
      if (isZip) {
        const name = (file instanceof File ? file.name : "project").replace(/\.knxproj$/i, "");
        const project = loadKnxproj(bytes, password, name);
        // Run the same program/link resolution the real import does, so the preview's
        // gaps match what import will actually produce (no clean-looking false promise).
        const programs = extractAppPrograms(bytes, project.devices.map((d) => d.appRef));
        return json({ kind: "knxproj", name: project.name, deviceCount: project.devices.length, gaCount: project.groupAddresses.length, snapshotCount: 0, ...countSpacesByType(project.locations), modifiedAt: null, ...importGaps(project, programs) });
      }
      const data = await unpackBusforge(bytes, password); // throws a coded ApiError (encrypted/wrong-password/invalid)
      validateExport(data);
      return json({ kind: "busforge", name: data.project.name, deviceCount: data.devices.length, gaCount: data.groupAddresses.length, snapshotCount: data.snapshots?.length ?? 0, ...countSpacesByType(data.spaces ?? []), modifiedAt: data.exportedAt ?? null });
    }

    // /api/projects/import-busforge  (POST: re-import a .busforge project artifact)
    if (seg.length === 3 && seg[2] === "import-busforge" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
      const password = (form.get("password") as string)?.trim() || undefined;
      const bytes = Buffer.from(await file.arrayBuffer());
      const data = await unpackBusforge(bytes, password); // sniffs gzip/encrypted/legacy; throws a coded ApiError
      validateExport(data); // throws a coded ImportError on a bad shape/version
      const id = randomUUID();
      importProjectExport(db, data, id, state.now());
      return json({ id, name: data.project.name, deviceCount: data.devices.length, gaCount: data.groupAddresses.length }, 201);
    }

    const id = seg[2];

    // /api/projects/:id
    if (seg.length === 3 && req.method === "GET") {
      const p = getProject(db, id);
      return p ? json(p) : err("PROJECT_NOT_FOUND", "project not found", 404);
    }
    if (seg.length === 3 && req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = (body.name ?? "").trim();
      if (!name) return err("PROJECT_NAME_REQUIRED", "a project name is required");
      if (!renameProject(db, id, name)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      return json({ id, name });
    }
    if (seg.length === 3 && req.method === "DELETE") {
      if (!deleteProject(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      if (bus.activeProjectId === id) await bus.disconnect();
      gcAppPrograms(db); // drop catalog entries no longer referenced by any project
      rmSync(join(state.dataDir, "projects", id), { recursive: true, force: true }); // legacy file store + flash backups
      return json({ ok: true });
    }

    // /api/projects/:id/devices  (POST: place a catalog product as a new device)
    if (seg.length === 4 && seg[3] === "devices" && req.method === "POST") {
      if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const body = (await req.json().catch(() => ({}))) as { appRef?: string; productRef?: string; name?: string };
      if (!body.appRef || !body.productRef) return err("DEVICE_FIELDS_REQUIRED", "appRef and productRef required");
      const product = getCatalogProduct(db, body.appRef, body.productRef);
      if (!product) return err("CATALOG_PRODUCT_NOT_FOUND", "product not in catalog", 404);
      if (!getAppProgram(db, product.appProgramId)) return err("APP_PROGRAM_MISSING", "application program not in catalog", 404);
      const device = addDevice(db, id, product, (body.name ?? "").trim());
      return json(device, 201);
    }

    // /api/projects/:id/interface
    // /api/projects/:id/connection  -> point the project at a saved connection
    // (or clear it with connectionId: null).
    if (seg.length === 4 && seg[3] === "connection" && req.method === "PUT") {
      const body = (await req.json().catch(() => ({}))) as { connectionId?: string | null };
      const cid = body.connectionId ?? null;
      if (cid !== null && !getConnection(db, cid)) return err("CONNECTION_NOT_FOUND", "connection not found", 404);
      if (!setProjectConnection(db, id, cid)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      return json({ connectionId: cid });
    }

    // /api/projects/:id/telegrams?limit=
    if (seg.length === 4 && seg[3] === "telegrams" && req.method === "GET") {
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") ?? 500)));
      return json(recentTelegrams(db, id, limit));
    }

    // /api/projects/:id/export  -> download the whole project + referenced catalog
    // as a portable .busforge artifact (our own format, not KNX): gzip of the
    // export JSON, AES-256-GCM sealed when a password is given. POST (not GET) so
    // the password rides in the body, never the URL/history. See busforgeArtifact.ts.
    if (seg.length === 4 && seg[3] === "export" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { password?: string };
      // Ensure every referenced app program is in the catalog (backfills a legacy
      // project from its file) so the export is self-contained.
      const refs = db.query("SELECT DISTINCT app_ref AS appRef FROM devices WHERE project_id = ?").all(id) as { appRef: string }[];
      for (const r of refs) resolveAppXml(state, id, r.appRef);
      const data = exportProject(db, id, state.now());
      if (!data) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const safe = data.project.name.replace(/[^\w.-]+/g, "_") || "project";
      const artifact = await packBusforge(data, body.password?.trim() || undefined);
      return new Response(artifact, {
        headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${safe}.busforge"` },
      });
    }

    // /api/projects/:id/snapshots  -> list restore points / create a manual one
    if (seg.length === 4 && seg[3] === "snapshots") {
      if (req.method === "GET") return json(listSnapshots(db, id));
      if (req.method === "POST") {
        if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
        const body = (await req.json().catch(() => ({}))) as { label?: string };
        const snap = createSnapshot(db, id, { label: (body.label ?? "").trim(), kind: "manual", reason: "manual" }, state.now());
        return json(snap, 201);
      }
    }

    // /api/projects/:id/snapshots/:sid/restore  -> roll the config back to a snapshot
    if (seg.length === 6 && seg[3] === "snapshots" && seg[5] === "restore" && req.method === "POST") {
      const restored = restoreSnapshot(db, id, decodeURIComponent(seg[4]), state.now());
      if (!restored.ok) return err("SNAPSHOT_NOT_FOUND", "snapshot not found", 404);
      return json({ ...getProject(db, id), gaStructureRestored: restored.gaStructureRestored });
    }

    // /api/projects/:id/snapshots/:sid  -> delete a restore point
    if (seg.length === 5 && seg[3] === "snapshots" && req.method === "DELETE") {
      if (!deleteSnapshot(db, id, decodeURIComponent(seg[4]))) return err("SNAPSHOT_NOT_FOUND", "snapshot not found", 404);
      return json({ ok: true });
    }

    // /api/projects/:id/devices/:deviceId/config?lang=
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "config" && req.method === "GET") {
      return deviceConfig(state, id, decodeURIComponent(seg[4]), url.searchParams.get("lang") ?? undefined);
    }
    // /api/projects/:id/group-addresses/:raw/devices?lang=  -> which devices use this GA
    if (seg.length === 6 && seg[3] === "group-addresses" && seg[5] === "devices" && req.method === "GET") {
      const raw = Number(decodeURIComponent(seg[4]));
      if (!Number.isInteger(raw)) return err("GA_NOT_FOUND", "group address not found", 404);
      return gaDevices(state, id, raw, url.searchParams.get("lang") ?? undefined);
    }

    // --- group-address structure editing -------------------------------------
    // /api/projects/:id/group-ranges  -> create a main/middle range
    if (seg.length === 4 && seg[3] === "group-ranges" && req.method === "POST") {
      if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const body = (await req.json().catch(() => ({}))) as { parentId?: number | null; name?: string; number?: number };
      if (typeof body.number !== "number") return err("GA_NUMBER_INVALID", "number required");
      createGroupRange(db, id, body.parentId ?? null, (body.name ?? "").trim(), body.number);
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
        const body = (await req.json().catch(() => ({}))) as { name?: string };
        if (!renameGroupRange(db, id, rangeId, (body.name ?? "").trim())) return err("GA_RANGE_NOT_FOUND", "range not found", 404);
        return json(getProject(db, id));
      }
      if (req.method === "DELETE") {
        if (!db.query("SELECT 1 FROM group_ranges WHERE id = ? AND project_id = ?").get(rangeId, id)) return err("GA_RANGE_NOT_FOUND", "range not found", 404);
        createSnapshot(db, id, { kind: "auto", reason: "before-ga-edit" }, state.now());
        deleteGroupRange(db, id, rangeId);
        return json(getProject(db, id));
      }
    }
    // /api/projects/:id/group-addresses  -> create a group address in a range
    if (seg.length === 4 && seg[3] === "group-addresses" && req.method === "POST") {
      if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const body = (await req.json().catch(() => ({}))) as { rangeId?: number; sub?: number; name?: string; dpt?: string };
      if (typeof body.rangeId !== "number" || typeof body.sub !== "number") return err("GA_FIELDS_REQUIRED", "rangeId and sub required");
      createGroupAddress(db, id, body.rangeId, body.sub, (body.name ?? "").trim(), (body.dpt ?? "").trim());
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
        const body = (await req.json().catch(() => ({}))) as { name?: string; dpt?: string };
        if (!updateGroupAddress(db, id, raw, (body.name ?? "").trim(), (body.dpt ?? "").trim())) return err("GA_NOT_FOUND", "group address not found", 404);
        return json(getProject(db, id));
      }
      if (req.method === "DELETE") {
        if (!db.query("SELECT 1 FROM group_addresses WHERE project_id = ? AND raw = ?").get(id, raw)) return err("GA_NOT_FOUND", "group address not found", 404);
        createSnapshot(db, id, { kind: "auto", reason: "before-ga-edit" }, state.now());
        deleteGroupAddress(db, id, raw);
        return json(getProject(db, id));
      }
    }

    // --- building structure (spaces). Edits are pure project organisation, never
    // flashed; all return the refreshed project. Consistent with group-address
    // editing: the structure rides in every snapshot payload + the .busforge export
    // (so a restore reverts it), and the destructive delete captures an undo point.
    // /api/projects/:id/spaces  -> create a building/floor/room under a parent (null = root)
    if (seg.length === 4 && seg[3] === "spaces" && req.method === "POST") {
      if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const body = (await req.json().catch(() => ({}))) as { parentId?: number | null; type?: string; name?: string };
      const type = (body.type ?? "").trim();
      if (!type) return err("SPACE_FIELDS_REQUIRED", "space type required");
      createSpace(db, id, body.parentId ?? null, type, (body.name ?? "").trim());
      return json(getProject(db, id), 201);
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
        const body = (await req.json().catch(() => ({}))) as { name?: string };
        if (!renameSpace(db, id, spaceId, (body.name ?? "").trim())) return err("SPACE_NOT_FOUND", "space not found", 404);
        return json(getProject(db, id));
      }
      if (req.method === "DELETE") {
        if (!db.query("SELECT 1 FROM spaces WHERE id = ? AND project_id = ?").get(spaceId, id)) return err("SPACE_NOT_FOUND", "space not found", 404);
        createSnapshot(db, id, { kind: "auto", reason: "before-space-edit" }, state.now());
        deleteSpace(db, id, spaceId);
        return json(getProject(db, id));
      }
    }
    // /api/projects/:id/devices/:deviceId/space  -> assign device to a space (or null to unassign)
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "space" && req.method === "PUT") {
      const deviceId = decodeURIComponent(seg[4]);
      const body = (await req.json().catch(() => ({}))) as { spaceId?: number | null };
      if (!assignDeviceSpace(db, id, deviceId, body.spaceId ?? null)) return err("SPACE_ASSIGN_FAILED", "device or space not found", 404);
      return json(getProject(db, id));
    }

    // /api/projects/:id/devices/:deviceId/baggage  -> DCA config blobs for this
    // device (base64), consumed by native DCA-replacement modules.
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "baggage" && req.method === "GET") {
      const deviceId = decodeURIComponent(seg[4]);
      // DB is authoritative for projects imported with DB baggage; fall back to the
      // on-disk store only for legacy projects that have no baggage rows at all.
      if (projectHasBaggage(db, id)) return json(getDeviceBaggage(db, id, deviceId));
      const bagDir = join(state.dataDir, "projects", id, "baggage");
      const out: Record<string, string> = {};
      if (existsSync(bagDir)) {
        for (const f of readdirSync(bagDir)) {
          if (f.startsWith(`${deviceId}_`)) out[f] = readFileSync(join(bagDir, f)).toString("base64");
        }
      }
      return json(out);
    }
    // /api/projects/:id/devices/:deviceId/params
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "params" && req.method === "PUT") {
      const deviceId = decodeURIComponent(seg[4]);
      const body = (await req.json()) as { paramRefId?: string; value?: string; lang?: string };
      if (!body.paramRefId || body.value === undefined) return err("PARAM_FIELDS_REQUIRED", "paramRefId and value required");
      const value = String(body.value);
      // If the value equals the parameter's default, drop the override instead of
      // storing it, so restoring the default clears the "changed" marker (the
      // sparse baseline has no row for default-valued params). A float default is
      // stored in scientific notation; compare it numerically so the canonical decimal
      // the UI sends still collapses to it.
      const pv = resolveParamForEdit(state, id, deviceId, body.paramRefId);
      const def = pv?.defaultValue;
      const isDefault = def !== undefined && (value === def || (pv?.float === true && Number(value) === Number(def)));
      if (isDefault) deleteDeviceParam(db, id, deviceId, body.paramRefId);
      else setDeviceParam(db, id, deviceId, body.paramRefId, value);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/links  -> re-point a com-object to a GA
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "links" && req.method === "PUT") {
      const deviceId = decodeURIComponent(seg[4]);
      const body = (await req.json()) as { comObjRefId?: string; gaRaws?: number[]; lang?: string };
      if (!body.comObjRefId || !Array.isArray(body.gaRaws)) return err("COMOBJ_FIELDS_REQUIRED", "comObjRefId and gaRaws required");
      const app = loadApp(state, id, deviceId);
      if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
      // Accept the full (view) ref id or the stored stripped key.
      const key = body.comObjRefId.startsWith(`${app.id}_`) ? body.comObjRefId.slice(app.id.length + 1) : body.comObjRefId;
      setDeviceLink(db, id, deviceId, key, body.gaRaws.map(Number));
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/revert  -> discard unprogrammed edits
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      if (!getDeviceForFlash(db, id, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const body = (await req.json().catch(() => ({}))) as { lang?: string };
      revertDevice(db, id, deviceId);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/revert-param  -> discard one param's drift
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert-param" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      if (!getDeviceForFlash(db, id, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const body = (await req.json().catch(() => ({}))) as { paramRefId?: string; lang?: string };
      if (!body.paramRefId) return err("PARAM_REF_REQUIRED", "paramRefId required");
      revertDeviceParam(db, id, deviceId, body.paramRefId);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/revert-link  -> discard one com-object's drift
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "revert-link" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const app = loadApp(state, id, deviceId);
      if (!app) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const body = (await req.json().catch(() => ({}))) as { comObjRefId?: string; lang?: string };
      if (!body.comObjRefId) return err("COMOBJ_REF_REQUIRED", "comObjRefId required");
      const key = body.comObjRefId.startsWith(`${app.id}_`) ? body.comObjRefId.slice(app.id.length + 1) : body.comObjRefId;
      revertDeviceLink(db, id, deviceId, key);
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/read-back  -> read the device's current
    // state off the bus and store it as the baseline, so drift shows as a change.
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "read-back" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const conn = getProjectConnection(db, id);
      if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
      const appXml = resolveAppXml(state, id, dev.appRef);
      if (!appXml) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
      const body = (await req.json().catch(() => ({}))) as { lang?: string };
      // Refuse up front for device classes whose state we cannot read at all: reading anyway
      // would fabricate a "verified" parameter baseline or corrupt the link baseline. System B
      // and System 7 both read; a recognised-but-unimplemented family (e.g. System 1 / BCU1)
      // resolves to UnsupportedProfile (all capabilities false) and is refused here. Honest
      // refusal beats false confidence.
      const rbCaps = classify(parseAppConfig(appXml)).capabilities(getDeviceParams(db, id, deviceId), getDeviceModules(db, id, deviceId));
      if (!rbCaps.readParams && !rbCaps.readLinks) {
        return err("DEVICE_READBACK_UNSUPPORTED", "reading this device's state back off the bus is not supported yet; its values cannot be verified against the device");
      }
      // Only record drift for refs the device config actually exposes (matches
      // what the UI shows; keeps module devices from flagging flat-model refs).
      const relevantRefs = deviceParamRefs(state, id, deviceId);
      const rb = await state.queue.enqueue(
        { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read" },
        async (progress, signal) => {
          // Free the bus so the read holds the only connection-oriented link.
          if (bus.activeProjectId) await bus.disconnect();
          return readDeviceState({
            ia: dev.ia, appXml,
            connection: conn,
            liveParams: getDeviceParams(db, id, deviceId), moduleInstances: getDeviceModules(db, id, deviceId), relevantRefs, onProgress: progress, signal,
          });
        },
      );
      // Persist ONLY the aspects actually read off the device. An aspect we couldn't
      // read keeps its existing baseline rather than getting a fabricated/garbage one.
      if (rb.paramsRead) replaceParamBase(db, id, deviceId, rb.paramBase);
      if (rb.linksRead) replaceLinkBase(db, id, deviceId, readbackLinkBase(state, id, deviceId, rb.links));
      return deviceConfig(state, id, deviceId, body.lang);
    }

    // /api/projects/:id/devices/:deviceId/flash-ga?dry=1  -> program the group tables
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash-ga" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const conn = getProjectConnection(db, id);
      if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
      const resolved = resolveDeviceLinks(state, id, deviceId);
      if (!resolved) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
      // Each memory model knows whether its group tables can be WRITTEN today: System B and
      // System 7 (MV-0705) yes (both hardware-verified), recognised-but-unsupported families no.
      // The capability guards the flash path so a model we cannot program never corrupts the
      // device's tables while reporting success.
      const gaApp = loadApp(state, id, deviceId);
      if (gaApp && !classify(gaApp).capabilities(getDeviceParams(db, id, deviceId), getDeviceModules(db, id, deviceId)).flashLinks) {
        return err("GROUP_TABLE_UNREADABLE", "this device's memory model does not support programming its group addresses yet");
      }
      const dryGa = url.searchParams.get("dry") === "1";
      // Auto restore point of the about-to-be-programmed config (real flash only).
      if (!dryGa) createSnapshot(db, id, { kind: "auto", reason: "before-flash-ga" }, state.now());
      const result = await state.queue.enqueue(
        { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-ga" },
        async (progress) => {
          if (bus.activeProjectId) await bus.disconnect();
          return flashDeviceGroupAddresses({
            projectId: id, deviceId, ia: dev.ia, expectedMask: resolved.mask, links: resolved.links,
            connection: conn, dataDir: state.dataDir,
            dryRun: dryGa, onProgress: progress,
          });
        },
      );
      // The device's group tables now match our links: clear the change marker.
      if (result.flashed && result.verified !== false) resetLinkBase(db, id, deviceId);
      return json(result);
    }

    // /api/projects/:id/devices/:deviceId/flash?dry=1  -> program the parameter segment
    if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash" && req.method === "POST") {
      const deviceId = decodeURIComponent(seg[4]);
      const dev = getDeviceForFlash(db, id, deviceId);
      if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
      const conn = getProjectConnection(db, id);
      if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
      const appXml = resolveAppXml(state, id, dev.appRef);
      if (!appXml) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
      const dryParams = url.searchParams.get("dry") === "1";
      // Auto restore point of the about-to-be-programmed config (real flash only).
      if (!dryParams) createSnapshot(db, id, { kind: "auto", reason: "before-flash" }, state.now());
      const result = await state.queue.enqueue(
        { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-params" },
        async (progress) => {
          // Free the bus so the flash holds the only connection-oriented link.
          if (bus.activeProjectId) await bus.disconnect();
          return flashDeviceParameters({
            projectId: id, deviceId, ia: dev.ia, appXml,
            connection: conn,
            params: getDeviceParams(db, id, deviceId), moduleInstances: getDeviceModules(db, id, deviceId), dataDir: state.dataDir,
            dryRun: dryParams, onProgress: progress,
          });
        },
      );
      // The device's parameter segment now matches our values: clear the marker.
      if (result.flashed && result.verified !== false) resetParamBase(db, id, deviceId);
      return json(result);
    }

    // /api/projects/:id/tasks  -> the device's queued/running/recent bus operations
    if (seg.length === 4 && seg[3] === "tasks" && req.method === "GET") {
      return json(state.queue.list(id));
    }

    // /api/projects/:id/tasks/:taskId/cancel  -> cancel a queued (or running read) task
    if (seg.length === 6 && seg[3] === "tasks" && seg[5] === "cancel" && req.method === "POST") {
      const cancelled = state.queue.cancel(decodeURIComponent(seg[4]));
      if (!cancelled) return err("TASK_NOT_CANCELLABLE", "task cannot be cancelled", 409);
      return json({ cancelled });
    }

    // /api/projects/:id/bus/{connect,disconnect,status}
    if (seg.length === 5 && seg[3] === "bus") {
      if (seg[4] === "status" && req.method === "GET") {
        const active = bus.activeProjectId === id;
        return json({ status: active ? bus.status : "disconnected", error: active ? bus.error : null, projectId: bus.activeProjectId });
      }
      if (seg[4] === "connect" && req.method === "POST") {
        const conn = getProjectConnection(db, id);
        if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
        if (bus.activeProjectId && bus.activeProjectId !== id) await bus.disconnect();
        await bus.connect(id, conn);
        return json({ status: bus.status, projectId: id });
      }
      if (seg[4] === "disconnect" && req.method === "POST") {
        if (bus.activeProjectId === id) await bus.disconnect();
        return json({ status: "disconnected" });
      }
    }

    return err("NOT_FOUND", "not found", 404);
  } catch (e) {
    // Coded errors (ApiError / KnxprojError) carry a client-localizable code;
    // anything else is an unexpected failure surfaced raw under INTERNAL.
    const code = errorCode(e);
    const status = e instanceof ApiError ? e.status : code ? 400 : 500;
    return err(code ?? "INTERNAL", (e as Error).message, status);
  }
}

// Resolve a device's application-program XML: from the shared catalog, falling
// back to the stored .knxproj for projects imported before the catalog existed
// (and backfilling the catalog so the next read hits the DB). The catalog is
// keyed by application-program id, so this is shared across devices and projects.
function resolveAppXml(state: AppState, projectId: string, appRef: string): string | null {
  const id = appProgramId(appRef);
  const cached = getAppProgram(state.db, id);
  if (cached) return cached;
  const sourceFile = getSourceFile(state.db, projectId);
  if (!sourceFile || !existsSync(sourceFile)) return null;
  const xml = readAppProgram(readFileSync(sourceFile), appRef);
  if (xml) putAppProgram(state.db, id, xml);
  return xml;
}

// Gaps an import does not fully cover, surfaced so the device/GA counts are not the
// only success signal: devices whose application program was missing from the archive
// (they import but cannot be opened, configured, or flashed) and group-address link
// tokens that referenced an address not in the tree (silently dropped during parse).
export function importGaps(project: Project, programs: Map<string, string>): { devicesWithoutProgram: { ia: string; name: string }[]; unresolvedLinks: number } {
  const devicesWithoutProgram = project.devices
    .filter((d) => !programs.has(appProgramId(d.appRef)))
    .map((d) => ({ ia: d.ia, name: d.name }));
  return { devicesWithoutProgram, unresolvedLinks: project.unresolvedLinks };
}

// Load and cache a device's parsed application program from the catalog.
function loadApp(state: AppState, projectId: string, deviceId: string): AppConfig | null {
  const appRef = getDeviceAppRef(state.db, projectId, deviceId);
  if (!appRef) return null;
  const cacheKey = appProgramId(appRef); // catalog is global, immutable once stored
  let app = state.appCache.get(cacheKey);
  if (!app) {
    const xml = resolveAppXml(state, projectId, appRef);
    if (!xml) return null;
    app = parseAppConfig(xml);
    state.appCache.set(cacheKey, app);
  }
  return app;
}

// The default value of a parameter (ref/param default, ignoring user overrides),
// resolved from the built config view so module-instance params work too.
function resolveParamForEdit(state: AppState, projectId: string, deviceId: string, refId: string): { defaultValue?: string; float?: boolean } | undefined {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return undefined;
  const view = buildDeviceConfig(app, getDeviceParams(state.db, projectId, deviceId), undefined, getDeviceModules(state.db, projectId, deviceId));
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param" && it.param.refId === refId) return { defaultValue: it.param.defaultValue, float: it.param.float };
  return undefined;
}

// Build a device's configuration view and overlay each com-object's stored GA link.
function deviceConfig(state: AppState, projectId: string, deviceId: string, lang?: string): Response {
  const { db } = state;
  if (!getDeviceForFlash(db, projectId, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
  const app = loadApp(state, projectId, deviceId);
  if (!app) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), lang, getDeviceModules(db, projectId, deviceId));
  // Offer a native DCA-replacement module if one matches this app program.
  const module = resolveDcaModule(app.id, app.appVersion);
  if (module) view.dca = { ...(view.dca ?? { hint: "" }), module };
  // Honest read-back capability: which aspects (parameters / group-address links)
  // can be verified against the device. When false, the change indicators reflect
  // edits-vs-import only and were NEVER confirmed against the hardware, so the UI
  // must say so rather than imply a verified "no changes".
  const rbCaps = classify(app).capabilities(getDeviceParams(db, projectId, deviceId), getDeviceModules(db, projectId, deviceId));
  view.readbackSupport = { params: rbCaps.readParams, links: rbCaps.readLinks };
  const links = getDeviceLinks(db, projectId, deviceId);
  const changed = getDeviceChangedKeys(db, projectId, deviceId);
  // For float params the override/baseline strings can differ purely in form (the UI
  // writes a canonical decimal, ETS stored scientific notation), which the string-based
  // change detection flags as drift. Compare those numerically so an unchanged float is
  // not shown as edited.
  const overrides = getDeviceParams(db, projectId, deviceId);
  const baseline = getDeviceParamBase(db, projectId, deviceId);
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind === "param") {
      let isChanged = changed.params.has(it.param.refId);
      if (isChanged && it.param.float) {
        const o = overrides.get(it.param.refId), bv = baseline.get(it.param.refId);
        if (o !== undefined && bv !== undefined && Number(o) === Number(bv)) isChanged = false;
      }
      it.param.changed = isChanged;
    } else if (it.kind === "comObject") {
      const key = it.comObject.refId.slice(app.id.length + 1);
      it.comObject.gaRaw = links.get(key)?.[0] ?? null;
      it.comObject.changed = changed.links.has(key);
    }
  }
  return json(view);
}

// One device's communication object on a group address, for the GA details
// overlay. `flags` carries the KNX read/write/transmit semantics so the UI can
// split senders (transmit) from receivers (write).
interface GaComObj {
  deviceId: string; deviceName: string; ia: string;
  comObjName: string; functionText: string; comObjNumber: number;
  flags: ComObjFlags;
}
export interface GaDevicesView {
  address: string; name: string; dpt: string; path: string[];
  senders: GaComObj[];
  receivers: GaComObj[];
}

// A device's com-objects keyed by their stored (stripped) ref id, carrying the
// resolved name and read/write flags. Built from the flat application model so
// hidden objects are covered too, then overridden by the module-resolved config
// view (translated names, module-instance numbering). Mirrors deviceConfig's key
// stripping (`refId.slice(app.id.length + 1)`).
function comObjsByKey(app: AppConfig, view: ReturnType<typeof buildDeviceConfig>): Map<string, { name: string; functionText: string; number: number; flags: ComObjFlags }> {
  const out = new Map<string, { name: string; functionText: string; number: number; flags: ComObjFlags }>();
  for (const [full, ref] of app.comObjectRefs) {
    const obj = app.comObjects.get(ref.refId);
    if (!obj) continue;
    out.set(full.slice(app.id.length + 1), {
      name: ref.text ?? obj.text ?? obj.name,
      functionText: ref.functionText ?? obj.functionText,
      number: obj.number,
      flags: { ...obj.flags, ...ref.flags },
    });
  }
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind !== "comObject") continue;
    out.set(it.comObject.refId.slice(app.id.length + 1), {
      name: it.comObject.name, functionText: it.comObject.functionText, number: it.comObject.number, flags: it.comObject.flags,
    });
  }
  return out;
}

// Which devices use a group address, split by role. A linked com-object is a
// sender when it has the transmit flag (it writes the address on change) and a
// receiver when it has the write flag (it consumes writes); an object with both
// appears in both lists. Links whose com-object resolves to neither flag fall
// back to the receiver list (e.g. a read-only responder), so nothing is dropped.
function gaDevices(state: AppState, projectId: string, raw: number, lang?: string): Response {
  const { db } = state;
  if (!projectExists(db, projectId)) return err("PROJECT_NOT_FOUND", "project not found", 404);
  const meta = getGaMeta(db, projectId, raw);
  if (!meta) return err("GA_NOT_FOUND", "group address not found", 404);

  // Group the project-wide links by device, so each device's app is built once.
  const byDevice = new Map<string, string[]>();
  for (const l of getGaLinks(db, projectId, raw)) {
    const a = byDevice.get(l.deviceId) ?? [];
    a.push(l.comObjRefId);
    byDevice.set(l.deviceId, a);
  }

  const senders: GaComObj[] = [];
  const receivers: GaComObj[] = [];
  for (const [deviceId, refIds] of byDevice) {
    const dev = getDeviceForFlash(db, projectId, deviceId);
    const app = loadApp(state, projectId, deviceId);
    if (!dev || !app) continue; // a stale link to a removed device/app: skip, don't fail the overlay
    const comObjs = comObjsByKey(app, buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), lang, getDeviceModules(db, projectId, deviceId)));
    for (const refId of refIds) {
      const co = comObjs.get(refId);
      if (!co) continue; // link to a com-object absent from the app model: skip
      const entry: GaComObj = { deviceId, deviceName: dev.name, ia: dev.ia, comObjName: co.name, functionText: co.functionText, comObjNumber: co.number, flags: co.flags };
      if (co.flags.transmit) senders.push(entry);
      if (co.flags.write) receivers.push(entry);
      else if (!co.flags.transmit) receivers.push(entry);
    }
  }
  const byIa = (a: GaComObj, b: GaComObj) => a.ia.localeCompare(b.ia, undefined, { numeric: true });
  return json({ address: meta.address, name: meta.name, dpt: meta.dpt, path: meta.path, senders: senders.sort(byIa), receivers: receivers.sort(byIa) } satisfies GaDevicesView);
}

// Choose which stored com-object links to program into the device's association
// table. A link is flashed only when its com-object is in the active view
// (visible under the current parameter values); every other stored link is
// skipped. This matches ETS, which drops a hidden object's group address from
// the device. The skipped link stays in the project (device_links) and returns
// to the device the next time the parameters re-activate the object, so nothing
// is lost. We deliberately do not try to tell a "hidden" link from a corrupt one
// and block the flash on it: that distinction is not reliably computable here
// (module com-objects use synthetic per-instance ref ids absent from the flat
// com-object tables, and objects behind an inactive choose branch are never
// enumerated), and the safe default for any unresolved link is to leave it
// stored and unflashed, never to abort the whole flash. `stored` keys are
// stripped ref ids; `numByRef` is keyed by the full `${appId}_${refId}` form.
export function selectFlashLinks(
  stored: Map<string, number[]>,
  numByRef: Map<string, number>,
  appId: string,
): ComObjectLink[] {
  const links: ComObjectLink[] = [];
  for (const [refId, gaRaws] of stored) {
    const num = numByRef.get(`${appId}_${refId}`);
    if (num !== undefined) links.push({ comObjNum: num, gaRaws });
  }
  return links;
}

// Resolve a device's stored links to (comObjNum -> GAs) for flashing the group
// tables. Com-object numbers come from the (module-resolved) config view.
function resolveDeviceLinks(state: AppState, projectId: string, deviceId: string): { mask: string; links: ComObjectLink[] } | null {
  const { db } = state;
  const app = loadApp(state, projectId, deviceId);
  if (!app) return null;
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), undefined, getDeviceModules(db, projectId, deviceId));
  const numByRef = new Map<string, number>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") numByRef.set(it.comObject.refId, it.comObject.number);
  const links = selectFlashLinks(getDeviceLinks(db, projectId, deviceId), numByRef, app.id);
  return { mask: app.mask, links };
}

// The parameter refs that make up a device's actual configuration (the config
// view's keys): for module devices these are instance-expanded, so they differ
// from the flat application model. Used to keep read-back drift consistent with
// what the UI shows.
function deviceParamRefs(state: AppState, projectId: string, deviceId: string): Set<string> {
  const app = loadApp(state, projectId, deviceId);
  if (!app) return new Set();
  const view = buildDeviceConfig(app, getDeviceParams(state.db, projectId, deviceId), undefined, getDeviceModules(state.db, projectId, deviceId));
  const refs = new Set<string>();
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") refs.add(it.param.refId);
  return refs;
}

const sameGaSet = (a: number[], b: number[]) => { const x = [...a].sort((m, n) => m - n), y = [...b].sort((m, n) => m - n); return x.length === y.length && x.every((v, i) => v === y[i]); };

// Merge a device's read-back links into the sparse link baseline: copy the live
// links, then override only where the device differs. Non-module devices map 1:1,
// so a com-object missing from the device read is genuinely unassigned (cleared).
// Module devices can't reverse instance numbering reliably, so only links that map
// onto a known live com-object are trusted; others are neither invented nor dropped.
export function mergeLinkBaseline(live: Map<string, number[]>, device: Map<string, number[]>, hasModules: boolean): Map<string, number[]> {
  const base = new Map(live);
  if (hasModules) {
    for (const [key, dev] of device) {
      if (live.has(key) && !sameGaSet(live.get(key) ?? [], dev)) base.set(key, dev);
    }
  } else {
    for (const key of new Set([...live.keys(), ...device.keys()])) {
      const proj = live.get(key) ?? [];
      const dev = device.get(key) ?? [];
      if (!sameGaSet(proj, dev)) { if (dev.length) base.set(key, dev); else base.delete(key); }
    }
  }
  return base;
}

// Turn the links read off a device (keyed by com-object number) into the sparse
// link baseline keyed by stored ref id: copy the live links, then override only
// the com-objects whose device GA set differs from the project, so the live-vs-
// base diff flags exactly the drift. Inverse of resolveDeviceLinks' numbering.
function readbackLinkBase(state: AppState, projectId: string, deviceId: string, deviceLinks: ComObjectLink[]): Map<string, number[]> {
  const { db } = state;
  const app = loadApp(state, projectId, deviceId);
  if (!app) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project");
  const view = buildDeviceConfig(app, getDeviceParams(db, projectId, deviceId), undefined, getDeviceModules(db, projectId, deviceId));
  // number -> stored ref key. App covers hidden com-objects; the view's
  // module-resolved numbers take precedence.
  const keyByNum = new Map<number, string>();
  for (const [full, cor] of app.comObjectRefs) {
    const num = app.comObjects.get(cor.refId)?.number;
    if (num !== undefined) keyByNum.set(num, full.slice(app.id.length + 1));
  }
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") keyByNum.set(it.comObject.number, it.comObject.refId.slice(app.id.length + 1));

  const device = new Map<string, number[]>();
  for (const l of deviceLinks) { const key = keyByNum.get(l.comObjNum); if (key) device.set(key, l.gaRaws); }

  return mergeLinkBaseline(getDeviceLinks(db, projectId, deviceId), device, app.hasModules);
}
