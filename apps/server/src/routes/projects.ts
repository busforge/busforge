import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadKnxproj, extractAppPrograms, extractCatalogProducts, extractPictureBaggage, type CatalogProduct } from "@busforge/project";
import { insertProject, createProject, listProjects, getProject, deleteProject, renameProject, projectExists, setProjectConnection, countSpacesByType, listDeviceAppRefs, importSourceOf, setProjectSource } from "../db/projects.ts";
import { getConnection } from "../db/connections.ts";
import { listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } from "../db/snapshots.ts";
import { putAppProgram, putCatalogProduct, putCatalogBaggage, gcAppPrograms } from "../db/catalog.ts";
import { putBaggage, readCheckedBaggage, checkBaggageSize } from "../db/baggage.ts";
import { exportProject } from "../db/exportProject.ts";
import { exportKeyring } from "../db/keyringExport.ts";
import { importProjectExport, validateExport, busforgeGaps } from "../db/importProject.ts";
import { packBusforge, unpackBusforge } from "../db/busforgeArtifact.ts";
import { recentTelegrams } from "../db/telegrams.ts";
import { putGroupSenders } from "../db/groupSenders.ts";
import { putDeviceSecurity, countOwnToolKeys } from "../db/deviceSecurity.ts";
import { putGroupKeys } from "../db/groupKeys.ts";
import { resolveAppXml, importGaps, securityChanges } from "../deviceservice.ts";
import { json, err, text } from "../httputil.ts";
import type { AppState } from "../app.ts";

// Project lifecycle: list/create, .knxproj and .busforge import (+ analyze
// preview), get/rename/delete, the saved-connection pointer, telegrams, the
// .busforge export, and snapshots.
// The Hardware2Program ids of the products in a project file that carry no application program.
const applicationless = (products: CatalogProduct[]): Set<string> => new Set(products.filter((p) => !p.hasApplication).map((p) => p.appRef));

export async function handle(req: Request, url: URL, seg: string[], state: AppState): Promise<Response | null> {
  const { db, bus } = state;

  // /api/projects
  if (seg.length === 2 && req.method === "GET") return json(listProjects(db));

  // /api/projects  (POST: create a blank project, no import)
  if (seg.length === 2 && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = text(body.name);
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
    const password = text(form.get("password")) || undefined; // trim to match /analyze, else a previewed file fails on import
    const name = (file instanceof File ? file.name : "project").replace(/\.knxproj$/i, "");
    const bytes = Buffer.from(await file.arrayBuffer());
    const project = loadKnxproj(bytes, password, name);
    // Extract the referenced application programs up front (pure, reads the zip),
    // so a bad archive fails before anything is written to disk or the DB.
    const programs = extractAppPrograms(bytes, project.devices.map((d) => d.appRef));
    // Catalog product metadata for browsing/placing devices later. Keep only the
    // products whose program we actually stored, so every catalog entry is placeable,
    // and the products that carry no application program at all.
    const products = extractCatalogProducts(bytes);
    const used = new Set(project.devices.map((d) => d.appRef));
    const catalog = products.filter((p) => programs.has(p.appProgramId) || (!p.hasApplication && used.has(p.appRef)));
    const withoutApplication = applicationless(products);
    const pictures = extractPictureBaggage(bytes, programs);

    const id = randomUUID();
    // DCA baggage (BinaryData/UserFiles, e.g. a DALI gateway's backup-store): the
    // inner zip is only decryptable here, with the import password in hand. Never
    // block an import on it, but never HIDE the loss either: a silently vanished
    // backup store used to surface only much later as an inexplicably empty module
    // view (and export/re-import propagated the loss). The gap rides in the import
    // result next to the other importGaps. Flattened name keeps the device-id
    // prefix the baggage endpoint filters on.
    const { baggage, baggageUnreadable } = readCheckedBaggage(bytes, password);
    // The embedded-file limits hold for the DCA baggage and the product images together.
    checkBaggageSize([...[...pictures.values()].flatMap((m) => [...m.values()]).map((f) => ({ name: f.name, bytes: f.data.length })),
      ...[...baggage].map(([bname, buf]) => ({ name: bname, bytes: buf.length }))]);

    // Everything is stored in the DB; no project files are written at import. The
    // raw .knxproj is not kept (app programs live in the catalog, baggage in the
    // DB), only its name, hash and size (the source_* columns), so an import is one
    // atomic transaction with nothing to clean up on failure. The legacy on-disk
    // path column source_file stays empty.
    db.transaction(() => {
      insertProject(db, id, project, "", state.now(), withoutApplication);
      setProjectSource(db, id, importSourceOf("knxproj", file instanceof File ? file.name : "project.knxproj", bytes));
      for (const [pid, xml] of programs) putAppProgram(db, pid, xml);
      for (const [pid, files] of pictures) putCatalogBaggage(db, pid, files);
      for (const p of catalog) putCatalogProduct(db, p);
      for (const [bname, buf] of baggage) putBaggage(db, id, bname.replace(/[/\\]/g, "__"), buf);
      // KNX Data Secure tool keys, sealed under the instance master key. Only
      // secure-commissioned devices have one (project.deviceSecurity is otherwise empty).
      if (project.deviceSecurity.length) {
        putDeviceSecurity(db, id, project.deviceSecurity.map((s) => ({
          deviceId: s.deviceId,
          toolKey: Buffer.from(s.toolKey, "base64"),
          serialNumber: Buffer.from(s.serialNumber, "base64"),
          sequenceNumber: s.sequenceNumber,
          source: "import" as const,
        })), state.masterKey);
      }
      if (project.groupKeys.length) {
        putGroupKeys(db, id, project.groupKeys.map((g) => ({ raw: g.raw, key: Buffer.from(g.key, "base64"), source: "import" as const })), state.masterKey);
      }
      if (project.secureSenders.length) putGroupSenders(db, id, project.secureSenders.map((s) => ({ gaRaw: s.gaRaw, ia: s.ia, source: "import" as const })));
    })();
    // Surface what did NOT fully import: devices whose application program was not in
    // the archive (they import as un-configurable husks) and group-address links that
    // referenced an address not in the tree (silently lost). The count alone is no
    // longer the only success signal.
    return json({ id, name: project.name, deviceCount: project.devices.length, gaCount: project.groupAddresses.length, ...importGaps(project, programs, withoutApplication), baggageUnreadable });
  }

  // /api/projects/analyze  (POST: parse a file's metadata for an import preview,
  // persisting nothing). Sniffs by magic: a "PK" zip is a .knxproj, anything else
  // a .busforge artifact. The client confirms with /import or /import-busforge.
  if (seg.length === 3 && seg[2] === "analyze" && req.method === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
    const password = text(form.get("password")) || undefined;
    const bytes = Buffer.from(await file.arrayBuffer());
    const isZip = bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
    if (isZip) {
      const name = (file instanceof File ? file.name : "project").replace(/\.knxproj$/i, "");
      const project = loadKnxproj(bytes, password, name);
      // Run the same program/link resolution the real import does, so the preview's
      // gaps match what import will actually produce (no clean-looking false promise).
      const programs = extractAppPrograms(bytes, project.devices.map((d) => d.appRef));
      const { baggageUnreadable } = readCheckedBaggage(bytes, password);
      return json({ kind: "knxproj", name: project.name, deviceCount: project.devices.length, gaCount: project.groupAddresses.length, snapshotCount: 0, ...countSpacesByType(project.locations), modifiedAt: null, ...importGaps(project, programs, applicationless(extractCatalogProducts(bytes))), baggageUnreadable });
    }
    const data = await unpackBusforge(bytes, password); // throws a coded ApiError (encrypted/wrong-password/invalid)
    validateExport(data);
    // Surface the same gap the knxproj preview does: devices whose app program is not in
    // the artifact re-import as husks. The count alone must not read as a clean transfer.
    return json({ kind: "busforge", name: data.project.name, deviceCount: data.devices.length, gaCount: data.groupAddresses.length, snapshotCount: data.snapshots?.length ?? 0, ...countSpacesByType(data.spaces ?? []), modifiedAt: data.exportedAt ?? null, ...busforgeGaps(data) });
  }

  // /api/projects/import-busforge  (POST: re-import a .busforge project artifact)
  if (seg.length === 3 && seg[2] === "import-busforge" && req.method === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return err("FILE_MISSING", "missing file");
    const password = text(form.get("password")) || undefined;
    const bytes = Buffer.from(await file.arrayBuffer());
    const data = await unpackBusforge(bytes, password); // sniffs gzip/encrypted/legacy; throws a coded ApiError
    validateExport(data); // throws a coded ImportError on a bad shape/version
    const id = randomUUID();
    importProjectExport(db, data, id, state.now(), state.masterKey, importSourceOf("busforge", file instanceof File ? file.name : "project.busforge", bytes));
    // Report husk devices (app program not in the artifact) the same way /import does, so a
    // re-import never propagates the loss silently as "N devices imported".
    return json({ id, name: data.project.name, deviceCount: data.devices.length, gaCount: data.groupAddresses.length, ...busforgeGaps(data) }, 201);
  }

  const id = seg[2];

  // /api/projects/:id
  if (seg.length === 3 && req.method === "GET") {
    const p = getProject(db, id, securityChanges(state, id));
    return p ? json(p) : err("PROJECT_NOT_FOUND", "project not found", 404);
  }
  if (seg.length === 3 && req.method === "PATCH") {
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };
    const name = text(body.name);
    if (!name) return err("PROJECT_NAME_REQUIRED", "a project name is required");
    if (!renameProject(db, id, name)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    return json({ id, name });
  }
  if (seg.length === 3 && req.method === "DELETE") {
    // A tool key busforge generated exists nowhere else: deleting it locks the device out until a
    // master reset. Only an explicit acknowledgement (after an export) deletes such a project.
    const ownKeys = countOwnToolKeys(db, id);
    if (ownKeys > 0 && url.searchParams.get("keysExported") !== "1") {
      return err("PROJECT_HOLDS_OWN_KEYS", `this project holds ${ownKeys} tool key(s) that only busforge has; export the project first, then delete it with keysExported=1`, 409);
    }
    if (!deleteProject(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
    if (bus.activeProjectId === id) await bus.disconnect();
    gcAppPrograms(db); // drop catalog entries no longer referenced by any project
    rmSync(join(state.dataDir, "projects", id), { recursive: true, force: true }); // legacy file store + flash backups
    return json({ ok: true });
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
    const body = (await req.json().catch(() => ({}))) as { password?: unknown };
    // A password that is neither absent nor a string is refused, not read as absent. Everywhere
    // else a malformed text field can safely mean "not given"; here it would hand back a plain
    // gzip artifact carrying the project's KNX Data Secure tool keys in clear, to a caller who
    // asked for it sealed.
    if (body.password !== undefined && body.password !== null && typeof body.password !== "string") {
      return err("EXPORT_PASSWORD_INVALID", "password must be a string");
    }
    // Backfill every referenced app program into the catalog (a legacy project resolves
    // its from the file) so the export carries what it can. A husk device (or a legacy
    // project whose source file is gone) still exports WITHOUT its program; that loss is
    // not hidden: analyze/import-busforge report it as devicesWithoutProgram on re-import.
    for (const appRef of listDeviceAppRefs(db, id)) resolveAppXml(state, id, appRef);
    const data = exportProject(db, id, state.now(), state.masterKey);
    if (!data) return err("PROJECT_NOT_FOUND", "project not found", 404);
    const safe = data.project.name.replace(/[^\w.-]+/g, "_") || "project";
    const artifact = await packBusforge(data, text(body.password) || undefined);
    return new Response(new Uint8Array(artifact), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${safe}.busforge"` },
    });
  }

  // /api/projects/:id/keyring  -> the project's KNX Data Secure keys as an ETS keyring (.knxkeys),
  // encrypted under the password given in the body (required: the format has no unencrypted form).
  if (seg.length === 4 && seg[3] === "keyring" && req.method === "POST") {
    const body = ((await req.json().catch(() => null)) ?? {}) as { password?: unknown };
    // Trimmed as the .busforge export's password is, so the same entry opens both files.
    const password = typeof body.password === "string" ? body.password.trim() : "";
    if (!password) return err("KEYRING_PASSWORD_INVALID", "a keyring password is required");
    const { xml, name } = exportKeyring(db, id, password, state.now(), state.masterKey);
    const safe = name.replace(/[^\w.-]+/g, "_") || "project";
    return new Response(xml, {
      headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${safe}.knxkeys"` },
    });
  }

  // /api/projects/:id/snapshots  -> list restore points / create a manual one
  if (seg.length === 4 && seg[3] === "snapshots") {
    if (req.method === "GET") return json(listSnapshots(db, id));
    if (req.method === "POST") {
      if (!projectExists(db, id)) return err("PROJECT_NOT_FOUND", "project not found", 404);
      const body = (await req.json().catch(() => ({}))) as { label?: unknown };
      const snap = createSnapshot(db, id, { label: text(body.label), kind: "manual", reason: "manual" }, state.now());
      return json(snap, 201);
    }
  }

  // /api/projects/:id/snapshots/:sid/restore  -> roll the config back to a snapshot
  if (seg.length === 6 && seg[3] === "snapshots" && seg[5] === "restore" && req.method === "POST") {
    const restored = restoreSnapshot(db, id, decodeURIComponent(seg[4]), state.now());
    if (!restored.ok) return err("SNAPSHOT_NOT_FOUND", "snapshot not found", 404);
    return json({ ...getProject(db, id, securityChanges(state, id)), gaStructureRestored: restored.gaStructureRestored });
  }

  // /api/projects/:id/snapshots/:sid  -> delete a restore point
  if (seg.length === 5 && seg[3] === "snapshots" && req.method === "DELETE") {
    if (!deleteSnapshot(db, id, decodeURIComponent(seg[4]))) return err("SNAPSHOT_NOT_FOUND", "snapshot not found", 404);
    return json({ ok: true });
  }

  return null;
}
