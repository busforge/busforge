import { parseAppConfig, comObjectTableChanges, type AppConfig, type ModuleInstance } from "@busforge/product";
import { getProjectConnection } from "../db/projects.ts";
import type { Connection } from "../db/connections.ts";
import { isConnectionReady } from "../transport.ts";
import { createSnapshot, listSnapshots } from "../db/snapshots.ts";
import { getDeviceLinks, getDeviceParams, getDeviceParamBase, getDeviceModules, getDeviceForFlash, replaceParamBase, replaceLinkBase, resetParamBase, resetLinkBase, setLinkBaseGaps, getLinkBaseGaps, keepLinkBaseOnly } from "../db/deviceparams.ts";
import { getDeviceSecurity, putDeviceSecurity, setToolKeySource } from "../db/deviceSecurity.ts";
import { getDeviceCertificate, putDeviceCertificate } from "../db/deviceCertificates.ts";
import { getGroupKeys } from "../db/groupKeys.ts";
import { decodeCertificate } from "@busforge/knx";
import { flashDeviceParameters, flashDeviceGroupAddresses, downloadDeviceFull, secureTablesUnsupported, readDeviceState, secureIdentify, activateDevice, classify, assignDeviceAddress, readDevicesInProgMode, type FlashResult } from "../deviceprofile.ts";
import { buildDeviceView, loadApp, resolveAppXml, resolveDeviceLinks, deviceConfigRefs, readbackLinkBase, unwrittenParamRefs, secureCredsFor, secureTablesFor } from "../deviceservice.ts";
import { ApiError } from "../errors.ts";
import type { CommitFn, ProgressFn, TaskMeta } from "../taskqueue.ts";
import { json, err } from "../httputil.ts";
import type { AppState } from "../app.ts";

// The shared preamble of the on-bus device operations (read-back / flash /
// flash-ga): resolve the device, require a ready bus connection, resolve the
// application XML. Codes, messages, statuses and their precedence are the
// routes' locked contract; the per-route capability guard stays in each route
// because the checked capability and the refusal code differ.
function busOpPreamble(state: AppState, projectId: string, deviceId: string): { dev: NonNullable<ReturnType<typeof getDeviceForFlash>>; conn: Connection; appXml: string } {
  const dev = getDeviceForFlash(state.db, projectId, deviceId);
  if (!dev) throw new ApiError("DEVICE_NOT_FOUND", "device not found", 404);
  const conn = getProjectConnection(state.db, projectId);
  if (!isConnectionReady(conn)) throw new ApiError("INTERFACE_NOT_SET", "configure a bus connection first");
  const appXml = resolveAppXml(state, projectId, dev.appRef);
  if (!appXml) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project", 404);
  return { dev, conn, appXml };
}

// A group-address flash writes the tables whole. While the last read-back left device links out of
// what the device page shows (or they have not been counted since the check was added, -1), the
// flash would overwrite links nobody has seen.
function linkBaselineIncomplete(db: AppState["db"], projectId: string, deviceId: string): ApiError {
  const gaps = getLinkBaseGaps(db, projectId, deviceId);
  return new ApiError("LINK_BASELINE_INCOMPLETE", gaps < 0
    ? "this device's links have not been counted since this check was added; read it back before programming its group addresses"
    : `the last read-back found ${gaps} device association(s) the device page cannot show; a group-address flash would overwrite them unseen`, 409);
}

// Adoption belongs inside the queued job: a following job must see the committed baseline,
// and a replaced/deleted target must never inherit success from its predecessor.
async function programSubmission(
  state: AppState, projectId: string, deviceId: string, programmingToken: string, dry: boolean,
  run: () => Promise<FlashResult>, commit: CommitFn, adopt: () => void,
): Promise<FlashResult> {
  const assertTarget = () => {
    if (getDeviceForFlash(state.db, projectId, deviceId)?.programmingToken !== programmingToken) {
      throw new ApiError("DEVICE_TARGET_CHANGED", "device was replaced, removed or readdressed after submission; review it before programming again", 409);
    }
  };
  assertTarget();
  const result = await run();
  assertTarget();
  // The commit is the job's last step: a restart that finds it recorded closes the task as done.
  if (!dry && result.kind === "flashed" && result.verified) commit(result, adopt);
  return result;
}

// A real write answers 202 with its task as soon as it is queued: a download runs for minutes,
// longer than an HTTP request can be trusted to stay open, and its outcome must not depend on the
// client still listening. The client polls GET .../tasks/:taskId for the result. A dry run is a
// read-only preview the dialog waits for, so it stays a plain request.
async function programOrPreview(
  state: AppState, meta: Omit<TaskMeta, "writes">, dry: boolean, reason: "before-flash" | "before-flash-ga" | "before-download",
  run: (progress: ProgressFn, commit: CommitFn) => Promise<FlashResult>,
): Promise<Response> {
  if (dry) return json(await state.queue.enqueue({ ...meta, writes: false }, (progress, _signal, commit) => run(progress, commit)));
  state.queue.refuseAdmission();
  state.queue.refuseConcurrentWrite(meta.projectId, meta.deviceId);
  // Auto restore point of the about-to-be-programmed config. When it would duplicate the latest
  // snapshot none is stored, and that latest one holds exactly the submitted configuration.
  const snapshot = createSnapshot(state.db, meta.projectId, { kind: "auto", reason }, state.now())
    ?? listSnapshots(state.db, meta.projectId)[0] ?? null;
  const task = state.queue.submit({ ...meta, writes: true, snapshotId: snapshot?.id ?? null }, (progress, _signal, commit) => run(progress, commit));
  return json(task, 202);
}

// A parameter or link change that would alter the device's com-object table (L3) cannot be a
// surgical flash: busforge keeps L3 from the device (see @busforge/product comobjtable.ts). The
// honest resolution is a full download, which AUTHORS L3, so where the family can commission from
// scratch we point the UI at that with a distinct code (the FlashDialog offers the download);
// where it cannot, we refuse honestly. Returns an error Response to short-circuit with, or null to
// let the surgical flash proceed. Runs pre-enqueue, like the capability guards: no snapshot, no bus.
function comObjectTableGuard(
  app: AppConfig | null,
  base: Map<string, string>,
  now: Map<string, string>,
  modules: ModuleInstance[],
  secure: boolean,
): Response | null {
  if (!app) return null; // no cfg: the profile layer's requireCfg refuses downstream
  if (!comObjectTableChanges(app, base, now, modules).length) return null;
  if (secure && !classify(app).loadsSecurityObject) return secureTablesRefusal();
  return classify(app).capabilities().fullDownload
    ? err("COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", "this change alters the device's communication objects, which needs its com-object table rewritten; run a full download to apply it", 400)
    : err("COM_OBJECT_TABLE_STALE", "this change alters the device's communication objects, which needs its com-object table rewritten; busforge cannot do that for this device family yet", 400);
}

function secureTablesRefusal(): Response {
  const e = secureTablesUnsupported();
  return err(e.code, e.message, 400);
}

// On-bus device operations: read-back, secure identify, the two flash routes,
// the task queue views, and the bus connection lifecycle.
export async function handle(req: Request, url: URL, seg: string[], state: AppState): Promise<Response | null> {
  const { db, bus } = state;
  const id = seg[2];

  // /api/projects/:id/prog-mode  -> which devices are in programming mode right now.
  // A broadcast probe, so it needs a bus connection but no device: this is what tells the
  // user whether they pressed the programming button, and whether they pressed only ONE.
  //
  // Through the queue like every other bus operation: ONE physical interface backs them all, so
  // opening a second transport while a flash is mid-write would fight the flash for the interface
  // (and inject a broadcast into it). It is a read, so it queues as one.
  if (seg.length === 4 && seg[3] === "prog-mode" && req.method === "GET") {
    const conn = getProjectConnection(db, id);
    if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
    const devices = await state.queue.enqueue(
      { projectId: id, deviceId: "-", deviceName: "programming mode", ia: "-", kind: "read", writes: false },
      async () => {
        return readDevicesInProgMode(conn);
      },
    );
    return json({ devices });
  }

  // /api/projects/:id/devices/:deviceId/assign-ia  -> write the device's individual address
  // (the one the project holds for it) into the physical device in programming mode.
  //
  // Deliberately NOT guarded by the usual mask gate: the whole point is to reach a device that
  // may not have a usable address yet, so it is addressed by broadcast and identifies itself by
  // being the one in programming mode. The safety rails are different and live in the knx layer
  // (exactly one device in programming mode; the target address must not already answer; the
  // result is proven on the new address). See @busforge/knx individualaddress.ts.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "assign-ia" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const dev = getDeviceForFlash(db, id, deviceId);
    if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const conn = getProjectConnection(db, id);
    if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
    const task = state.queue.submit(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "assign-ia", writes: true },
      async (progress) => {
        return assignDeviceAddress(conn, dev.ia, progress);
      },
    );
    return json(task, 202);
  }

  // /api/projects/:id/devices/:deviceId/read-back  -> read the device's current
  // state off the bus and store it as the baseline, so drift shows as a change.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "read-back" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const { dev, conn, appXml } = busOpPreamble(state, id, deviceId);
    const body = (await req.json().catch(() => ({}))) as { lang?: string };
    // Refuse up front for device classes whose state we cannot read at all: reading anyway
    // would fabricate a "verified" parameter baseline or corrupt the link baseline. System B
    // and System 7 both read; a recognised-but-unimplemented family (e.g. System 1 / BCU1)
    // resolves to UnsupportedProfile (all capabilities false) and is refused here. Honest
    // refusal beats false confidence.
    const rbCaps = classify(parseAppConfig(appXml)).capabilities();
    if (!rbCaps.readParams && !rbCaps.readLinks) {
      return err("DEVICE_READBACK_UNSUPPORTED", "reading this device's state back off the bus is not supported yet; its values cannot be verified against the device");
    }
    // Only record drift for refs the device config actually exposes (matches
    // what the UI shows; keeps module devices from flagging flat-model refs).
    const modules = getDeviceModules(db, id, deviceId);
    const configFor = (values: Map<string, string>) => deviceConfigRefs(state, id, deviceId, values, modules);
    // The baselines are persisted inside the queued job, so a write queued behind this read sees
    // them (and its gap count) when it starts, not whatever was there when it was submitted.
    const rb = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read", writes: false },
      async (progress, signal) => {
        const read = await readDeviceState({
          ia: dev.ia, appXml,
          connection: conn, secure: secureCredsFor(state, id, deviceId),
          liveParams: getDeviceParams(db, id, deviceId), baseParams: getDeviceParamBase(db, id, deviceId),
          moduleInstances: modules, configFor, onProgress: progress, signal,
        });
        // Persist ONLY the aspects actually read off the device. An aspect we couldn't
        // read keeps its existing baseline rather than getting a fabricated/garbage one.
        // One transaction: a link baseline must never stand with a stale gap count.
        const lb = read.linksRead ? readbackLinkBase(state, id, deviceId, read.links, read.deviceConfig) : null;
        db.transaction(() => {
          if (read.paramsRead) replaceParamBase(db, id, deviceId, read.paramBase);
          if (lb) { replaceLinkBase(db, id, deviceId, lb.base); setLinkBaseGaps(db, id, deviceId, lb.gaps); }
        })();
        return { paramsRead: read.paramsRead, linksRead: read.linksRead, linkGaps: lb?.gaps ?? 0 };
      },
    );
    // `readback` tells the client what this read actually covered: `linkGaps` counts
    // device associations the baseline could not show (see readbackLinkBase), surfaced
    // instead of letting the read-back pass as a complete links baseline.
    return json(buildDeviceView(state, id, deviceId, body.lang, { readback: rb }));
  }

  // /api/projects/:id/devices/:deviceId/secure-identify -> read a Data Secure device's
  // real identity (descriptor + serial) over the secure channel, using its stored tool
  // key. Replaces the opaque MV-FFFF a plain read returns. Read-only.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "secure-identify" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const dev = getDeviceForFlash(db, id, deviceId);
    if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const sec = getDeviceSecurity(db, id, deviceId, state.masterKey);
    if (!sec) return err("DEVICE_NOT_SECURE", "this device has no stored tool key (not a Data Secure device, or its keys were not imported)");
    const conn = getProjectConnection(db, id);
    if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
    const result = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read", writes: false },
      async (progress) => {
        return secureIdentify(conn, dev.ia, sec.toolKey, sec.serialNumber, progress);
      },
    );
    return json({ ia: dev.ia, secure: true, ...result });
  }

  // /api/projects/:id/devices/:deviceId/certificate  -> store the device certificate printed on a
  // secure device (its serial and factory key), sealed. Nothing is sent to the device.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "certificate" && req.method === "PUT") {
    const deviceId = decodeURIComponent(seg[4]);
    if (!getDeviceForFlash(db, id, deviceId)) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const body = (await req.json().catch(() => ({}))) as { certificate?: unknown };
    let cert: { serial: Buffer; fdsk: Buffer };
    try { cert = decodeCertificate(typeof body.certificate === "string" ? body.certificate : ""); }
    catch (e) { return err("CERTIFICATE_INVALID", e instanceof Error ? e.message : String(e), 400); }
    const known = getDeviceSecurity(db, id, deviceId, state.masterKey)?.serialNumber;
    if (known && !known.equals(cert.serial)) {
      return err("CERTIFICATE_SERIAL_MISMATCH", `the certificate is for serial ${cert.serial.toString("hex")}, this device is ${known.toString("hex")}`, 400);
    }
    putDeviceCertificate(db, id, { deviceId, fdsk: cert.fdsk, serialNumber: cert.serial }, state.masterKey);
    return json({ serial: cert.serial.toString("hex") });
  }

  // /api/projects/:id/devices/:deviceId/secure-activate  -> take the device from its factory key
  // to a tool key of busforge's, persisted before it is written (see activateDevice). Repeatable:
  // a device that already holds the key on file is left alone.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "secure-activate" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const dev = getDeviceForFlash(db, id, deviceId);
    if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const cert = getDeviceCertificate(db, id, deviceId, state.masterKey);
    if (!cert) return err("CERTIFICATE_MISSING", "no device certificate is stored for this device", 400);
    const conn = getProjectConnection(db, id);
    if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
    const task = state.queue.submit(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "secure-activate", writes: true },
      async (progress) => {
        const stored = getDeviceSecurity(db, id, deviceId, state.masterKey);
        // A key busforge generates is kept as pending before it is written, and marked provisioned
        // once the device is confirmed under it; a key already on file keeps its origin.
        let generated = false;
        const result = await activateDevice(conn, dev.ia, { fdsk: cert.fdsk, serial: cert.serialNumber }, stored?.toolKey, (key) => {
          generated = !stored;
          putDeviceSecurity(db, id, [{ deviceId, toolKey: key, serialNumber: cert.serialNumber, sequenceNumber: stored?.sequenceNumber ?? "", source: stored?.source ?? "pending" }], state.masterKey);
        }, progress);
        if (generated || stored?.source === "pending") setToolKeySource(db, id, deviceId, "provisioned");
        return result;
      },
    );
    return json(task, 202);
  }

  // /api/projects/:id/devices/:deviceId/flash-ga?dry=1  -> program the group tables
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash-ga" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const { dev, conn, appXml: gaAppXml } = busOpPreamble(state, id, deviceId);
    const resolved = resolveDeviceLinks(state, id, deviceId);
    const submittedLinks = getDeviceLinks(db, id, deviceId);
    if (!resolved) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
    // The group tables are written whole, so links the last read-back could not place in the
    // baseline (and the user therefore never saw as drift) would be overwritten silently.
    if (getLinkBaseGaps(db, id, deviceId) !== 0) throw linkBaselineIncomplete(db, id, deviceId);
    // Each memory model knows whether its group tables can be WRITTEN today: System B and
    // System 7 (MV-0705) yes (both hardware-verified), recognised-but-unsupported families no.
    // The capability guards the flash path so a model we cannot program never corrupts the
    // device's tables while reporting success.
    const gaApp = loadApp(state, id, deviceId);
    if (gaApp && !classify(gaApp).capabilities().flashLinks) {
      // A WRITE-capability refusal, not the read-side GROUP_TABLE_UNREADABLE: this fires only
      // for a recognised-but-unimplemented family (UnsupportedProfile). System B and MV-0705
      // both program group addresses, so they never reach here.
      return err("GA_FLASH_UNSUPPORTED", "this device's memory model is recognised but programming its group addresses is not implemented yet");
    }
    const dryGa = url.searchParams.get("dry") === "1";
    // The links carry the LIVE configuration's com-object numbers, so the profile checks them
    // against the com-object table the device was last programmed with (same gate as the
    // parameter flash). Read at the same pre-enqueue point, for the same TOCTOU reason.
    const gaParams = getDeviceParams(db, id, deviceId);
    const gaBase = getDeviceParamBase(db, id, deviceId);
    const gaModules = getDeviceModules(db, id, deviceId);
    // If wiring these links would leave the device's kept-from-device com-object table stale,
    // a surgical GA flash cannot fix it: promote to a full download (or refuse). Pre-enqueue.
    const gaStale = comObjectTableGuard(gaApp, gaBase, gaParams, gaModules, false);
    if (gaStale) return gaStale;
    return programOrPreview(state,
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-ga" }, dryGa, "before-flash-ga",
      (progress, commit) => programSubmission(state, id, deviceId, dev.programmingToken, dryGa, () => {
        // Re-checked when the job starts: a read-back queued ahead of it may have found gaps.
        if (getLinkBaseGaps(db, id, deviceId) !== 0) throw linkBaselineIncomplete(db, id, deviceId);
        return flashDeviceGroupAddresses({
          projectId: id, deviceId, ia: dev.ia, appXml: gaAppXml, links: resolved.links,
          params: gaParams, baseParams: gaBase, moduleInstances: gaModules,
          connection: conn, dataDir: state.dataDir, ...secureTablesFor(state, id, deviceId),
          dryRun: dryGa, onProgress: progress,
        });
      }, commit, () => {
        resetLinkBase(db, id, deviceId, resolved.flashedRefIds, submittedLinks);
        keepLinkBaseOnly(db, id, deviceId, new Set([...resolved.flashedRefIds, ...submittedLinks.keys()]));
        setLinkBaseGaps(db, id, deviceId, 0);
      }),
    );
  }

  // /api/projects/:id/devices/:deviceId/download  -> COMMISSION the device from nothing:
  // application id + parameter image + com-object table + group tables, in one bracket.
  //
  // This is the only write that AUTHORS the com-object table rather than keeping the device's, and
  // the device's firmware validates none of it, so the read-back afterwards is the only proof. The
  // programmed baseline is adopted ONLY if that read-back verified.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "download" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const { dev, conn, appXml } = busOpPreamble(state, id, deviceId);
    const app = loadApp(state, id, deviceId);
    if (app && !classify(app).capabilities().fullDownload) {
      return err("FULL_DOWNLOAD_UNSUPPORTED", "commissioning this device's memory model from scratch is not supported yet");
    }
    const resolved = resolveDeviceLinks(state, id, deviceId);
    const submittedLinks = getDeviceLinks(db, id, deviceId);
    if (!resolved) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
    const dlParams = getDeviceParams(db, id, deviceId);
    const dlModules = getDeviceModules(db, id, deviceId);
    const dryDl = url.searchParams.get("dry") === "1";
    return programOrPreview(state,
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "download" }, dryDl, "before-download",
      (progress, commit) => programSubmission(state, id, deviceId, dev.programmingToken, dryDl, () => downloadDeviceFull({
          projectId: id, deviceId, ia: dev.ia, appXml,
          connection: conn, dataDir: state.dataDir, ...secureTablesFor(state, id, deviceId),
          params: dlParams, links: resolved.links, moduleInstances: dlModules,
          dryRun: dryDl, onProgress: progress,
        }), commit, () => {
        resetParamBase(db, id, deviceId, dlParams, unwrittenParamRefs(state, id, deviceId, dlParams, dlModules));
        resetLinkBase(db, id, deviceId, resolved.flashedRefIds, submittedLinks);
        keepLinkBaseOnly(db, id, deviceId, new Set([...resolved.flashedRefIds, ...submittedLinks.keys()]));
        setLinkBaseGaps(db, id, deviceId, 0);
      }),
    );
  }

  // /api/projects/:id/devices/:deviceId/flash?dry=1  -> program the parameter segment
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const { dev, conn, appXml } = busOpPreamble(state, id, deviceId);
    // Refuse an unsupported device up front (mirrors flash-ga), so we don't create a snapshot
    // and connect the bus just to have the profile throw.
    const flApp = loadApp(state, id, deviceId);
    if (flApp && !classify(flApp).capabilities().flashParams) {
      return err("DEVICE_FAMILY_UNSUPPORTED", "this device's family does not support parameter programming yet");
    }
    const dryParams = url.searchParams.get("dry") === "1";
    const secure = secureCredsFor(state, id, deviceId);
    // Snapshot the stored config ONCE, before the (long, bus-bound) flash is queued, and use
    // the same values for the image and the post-flash baseline decision. A param edit
    // that lands while the flash runs must not change which refs count as "written" (the GA
    // path resolves flashedRefIds pre-enqueue for exactly this reason).
    const flashParams = getDeviceParams(db, id, deviceId);
    const flashModules = getDeviceModules(db, id, deviceId);
    // The configuration the device was last programmed with, hence the one its com-object
    // table was compiled for: the profile refuses the flash if ours implies a different table
    // (see @busforge/product comobjtable.ts). Read from the same pre-enqueue snapshot point.
    const flashBase = getDeviceParamBase(db, id, deviceId);
    // If these parameters change which com-objects the device has (or their flags), a surgical
    // parameter flash would leave its kept-from-device com-object table stale. Promote to a full
    // download where the family can commission, else refuse. Pre-enqueue: no snapshot, no bus.
    const flStale = comObjectTableGuard(flApp, flashBase, flashParams, flashModules, secure !== undefined);
    if (flStale) return flStale;
    return programOrPreview(state,
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-params" }, dryParams, "before-flash",
      (progress, commit) => programSubmission(state, id, deviceId, dev.programmingToken, dryParams, () => flashDeviceParameters({
          projectId: id, deviceId, ia: dev.ia, appXml,
          connection: conn, secure,
          params: flashParams, baseParams: flashBase, moduleInstances: flashModules, dataDir: state.dataDir,
          dryRun: dryParams, onProgress: progress,
        }), commit, () => {
        resetParamBase(db, id, deviceId, flashParams, unwrittenParamRefs(state, id, deviceId, flashParams, flashModules));
      }),
    );
  }

  // /api/projects/:id/tasks  -> the device's queued/running/recent bus operations
  if (seg.length === 4 && seg[3] === "tasks" && req.method === "GET") {
    return json(state.queue.list(id));
  }

  // /api/projects/:id/tasks/:taskId  -> one task, however long ago it finished: how a client
  // that submitted a write collects its outcome, including after a reload or a server restart
  if (seg.length === 5 && seg[3] === "tasks" && req.method === "GET") {
    const task = state.queue.get(decodeURIComponent(seg[4]));
    if (!task || task.projectId !== id) return err("TASK_NOT_FOUND", "task not found", 404);
    return json(task);
  }

  // /api/projects/:id/tasks/:taskId/cancel  -> cancel a queued (or running read) task
  if (seg.length === 6 && seg[3] === "tasks" && seg[5] === "cancel" && req.method === "POST") {
    const task = state.queue.get(decodeURIComponent(seg[4]));
    if (!task || task.projectId !== id) return err("TASK_NOT_FOUND", "task not found", 404);
    const cancelled = state.queue.cancel(task.id);
    if (cancelled) return json({ cancelled });
    if (task.state === "running" && task.writes) {
      return err("TASK_WRITE_NOT_CANCELLABLE", "a running write cannot be cancelled: stopping it mid-write can leave the device reset; wait for its result", 409);
    }
    if (task.state === "running") return err("TASK_NOT_CANCELLABLE", "this running task cannot be interrupted; it writes nothing, wait for its result", 409);
    return err("TASK_ALREADY_FINISHED", "task has already finished", 409);
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
      await bus.connect(id, conn, getGroupKeys(db, id, state.masterKey));
      return json({ status: bus.status, projectId: id });
    }
    if (seg[4] === "disconnect" && req.method === "POST") {
      if (bus.activeProjectId === id) await bus.disconnect();
      return json({ status: "disconnected" });
    }
  }

  return null;
}
