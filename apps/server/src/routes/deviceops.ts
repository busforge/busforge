import { parseAppConfig, comObjectTableChanges, type AppConfig, type ModuleInstance, type WriteGate } from "@busforge/product";
import { getProjectConnection, getGaMeta } from "../db/projects.ts";
import type { Connection } from "../db/connections.ts";
import { isConnectionReady } from "../transport.ts";
import { createSnapshot, listSnapshots } from "../db/snapshots.ts";
import { getDeviceLinks, getDeviceParams, getDeviceParamBase, getDeviceModules, getDeviceForFlash, replaceParamBase, replaceLinkBase, resetParamBase, resetLinkBase, setLinkBaseGaps, getLinkBaseGaps, keepLinkBaseOnly, clearNeverProgrammed } from "../db/deviceparams.ts";
import { getDeviceSecurity, putDeviceSecurity, setDeviceSequence, setToolKeySource } from "../db/deviceSecurity.ts";
import { getDeviceCertificate, putDeviceCertificate } from "../db/deviceCertificates.ts";
import { getGroupKeys } from "../db/groupKeys.ts";
import { sendersByGroup, nextSendSequence } from "../db/groupSenders.ts";
import { decodeCertificate, groupValueRead, secureEncode, SCF, SECURE_APDU_OVERHEAD, numToIa, numToGa, toolSequenceNow } from "@busforge/knx";
import { flashDeviceParameters, flashDeviceGroupAddresses, flashDeviceStructure, downloadDeviceFull, secureTablesUnsupported, readDeviceState, secureIdentify, activateDevice, classify, assignDeviceAddress, readDevicesInProgMode, type FlashResult } from "../deviceprofile.ts";
import { buildDeviceView, loadApp, resolveAppXml, resolveDeviceLinks, deviceConfigRefs, readbackLinkBase, unwrittenParamRefs, secureCredsFor, securityTablesWithFingerprint, setSecurityBase } from "../deviceservice.ts";
import { ApiError } from "../errors.ts";
import { CancelledError, type CommitFn, type ProgressFn, type TaskMeta } from "../taskqueue.ts";
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

// A surgical flash writes only what differs from the programmed baseline. A device nothing from this
// project was ever verified on has no baseline to differ from, and may run another application or
// none, so it takes a full download first (the flash dialog offers it on this code). A family that
// cannot be downloaded in full keeps the surgical flash, the only way it is programmed; its verified
// result then ends the state (gaEndsNever, paramsEndNever).
const canDownloadFull = (app: AppConfig | null) => !!app && classify(app).capabilities().fullDownload;
function refuseNeverProgrammed(dev: { neverProgrammed: boolean }, app: AppConfig | null): void {
  if (dev.neverProgrammed && canDownloadFull(app)) {
    throw new ApiError("NEVER_PROGRAMMED_USE_DOWNLOAD", "no configuration of this project has been verified on this device since it was placed or its product replaced; a full download commissions it first", 400);
  }
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
  run: () => Promise<FlashResult>, commit: CommitFn, adopt: () => void, onUnchanged?: () => void,
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
  // "unchanged" is a comparison with what the device holds: whatever it covers may be recorded as such.
  if (!dry && result.kind === "unchanged") onUnchanged?.();
  return result;
}

// A real write answers 202 with its task as soon as it is queued: a download runs for minutes,
// longer than an HTTP request can be trusted to stay open, and its outcome must not depend on the
// client still listening. The client polls GET .../tasks/:taskId for the result. A dry run is a
// read-only preview the dialog waits for, so it stays a plain request.
async function programOrPreview(
  state: AppState, meta: Omit<TaskMeta, "writes">, dry: boolean, reason: "before-flash" | "before-flash-ga" | "before-download",
  run: (progress: ProgressFn, commit: CommitFn, gate: WriteGate) => Promise<FlashResult>,
): Promise<Response> {
  if (dry) return json(await state.queue.enqueue({ ...meta, writes: false }, (progress, signal, commit) => run(progress, commit, { signal })));
  state.queue.refuseAdmission();
  state.queue.refuseConcurrentWrite(meta.projectId, meta.deviceId);
  // Auto restore point of the about-to-be-programmed config. When it would duplicate the latest
  // snapshot none is stored, and that latest one holds exactly the submitted configuration.
  const snapshot = createSnapshot(state.db, meta.projectId, { kind: "auto", reason }, state.now())
    ?? listSnapshots(state.db, meta.projectId)[0] ?? null;
  // Cancellable until the flash's first write (WriteGate): the backup and compare before it only read.
  const task = state.queue.submit({ ...meta, writes: true, snapshotId: snapshot?.id ?? null, cancelBeforeWrite: true },
    (progress, signal, commit, enterWrites) => run(progress, commit, { signal, beforeWrite: enterWrites }));
  return json(task, 202);
}

// A parameter or link change that alters the device's com-object table (L3) cannot be a parameter
// or group-address flash alone: those keep the table the device was last programmed with (see
// @busforge/product comobjtable.ts). Where the family can write it as a structural flash (parameters,
// the com-object table they imply and the group tables in one bracket), that is what runs. Otherwise a
// family that can commission from scratch is pointed at the full download with a distinct code (the
// FlashDialog offers it), and any other is refused. Returns "surgical" when the table stays, a
// "structural" verdict, or the refusal to short-circuit with. Runs pre-enqueue, like the capability
// guards: no snapshot, no bus.
function comObjectTableGuard(
  app: AppConfig | null,
  base: Map<string, string>,
  now: Map<string, string>,
  modules: ModuleInstance[],
  secure: boolean,
): "surgical" | "structural" | Response {
  if (!app) return "surgical"; // no cfg: the profile layer's requireCfg refuses downstream
  if (!comObjectTableChanges(app, base, now, modules).length) return "surgical";
  if (secure && !classify(app).loadsSecurityObject) return secureTablesRefusal();
  const caps = classify(app).capabilities();
  if (caps.structuralFlash) return "structural";
  return caps.fullDownload
    ? err("COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", "this change alters the device's communication objects, which needs its com-object table rewritten; run a full download to apply it", 400)
    : err("COM_OBJECT_TABLE_STALE", "this change alters the device's communication objects, which needs its com-object table rewritten; busforge cannot do that for this device family yet", 400);
}

// The structural flash both flash routes run for a change that alters the com-object table. It writes
// the group tables whole, so it takes the group-address flash's link-baseline guard, and a verified
// result adopts the parameter and the link baseline, as the full download does.
function structuralFlash(
  state: AppState, url: URL, projectId: string, deviceId: string,
  dev: NonNullable<ReturnType<typeof getDeviceForFlash>>, conn: Connection, appXml: string,
): Response | Promise<Response> {
  const { db } = state;
  const resolved = resolveDeviceLinks(state, projectId, deviceId);
  if (!resolved) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
  if (getLinkBaseGaps(db, projectId, deviceId) !== 0) throw linkBaselineIncomplete(db, projectId, deviceId);
  const submittedLinks = getDeviceLinks(db, projectId, deviceId);
  const params = getDeviceParams(db, projectId, deviceId);
  const baseParams = getDeviceParamBase(db, projectId, deviceId);
  const modules = getDeviceModules(db, projectId, deviceId);
  const dry = url.searchParams.get("dry") === "1";
  let fingerprint: string | null = null;
  return programOrPreview(state,
    { projectId, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-structure" }, dry, "before-flash",
    (progress, commit, gate) => programSubmission(state, projectId, deviceId, dev.programmingToken, dry, () => {
      if (getLinkBaseGaps(db, projectId, deviceId) !== 0) throw linkBaselineIncomplete(db, projectId, deviceId);
      const tables = securityTablesWithFingerprint(state, projectId, deviceId, resolved.links, dev.ia);
      fingerprint = tables.fingerprint;
      return flashDeviceStructure({
        projectId, deviceId, ia: dev.ia, appXml,
        connection: conn, dataDir: state.dataDir, ...tables.ctx,
        params, baseParams, links: resolved.links, moduleInstances: modules,
        dryRun: dry, onProgress: progress, ...gate,
      });
    }, commit, () => {
      resetParamBase(db, projectId, deviceId, params, unwrittenParamRefs(state, projectId, deviceId, params, modules));
      resetLinkBase(db, projectId, deviceId, resolved.flashedRefIds, submittedLinks);
      keepLinkBaseOnly(db, projectId, deviceId, new Set([...resolved.flashedRefIds, ...submittedLinks.keys()]));
      setLinkBaseGaps(db, projectId, deviceId, 0);
      setSecurityBase(state, projectId, deviceId, fingerprint);
    }),
  );
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
        // A cancel accepted during the read leaves the baselines as they were.
        if (signal.aborted) throw new CancelledError();
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

  // /api/projects/:id/devices/:deviceId/secure-identify -> read a device's identity (descriptor +
  // serial) and its security mode. With a stored tool key over the secure channel, which replaces the
  // opaque MV-FFFF a plain read returns; without one plainly (`secure: false`). Read-only.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "secure-identify" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const dev = getDeviceForFlash(db, id, deviceId);
    if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const secure = secureCredsFor(state, id, deviceId);
    const conn = getProjectConnection(db, id);
    if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
    const result = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read", writes: false },
      async (progress) => secureIdentify(conn, dev.ia, secure, progress),
    );
    return json({ ia: dev.ia, ...result });
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

  // /api/projects/:id/devices/:deviceId/tool-key  -> deposit a tool key by hand (one another tool
  // gave the device). It is stored only after the device answered a secure Sync under it: a device
  // does not answer a Sync under a key it does not hold, so an unanswered or unauthenticated Sync
  // refuses the deposit and leaves the key on file as it was. The Sync carries the device's serial,
  // which a device in secure mode does not give a plain read: it comes from the key or certificate on
  // file, else from the request. Nothing is written to the device.
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "tool-key" && req.method === "PUT") {
    const deviceId = decodeURIComponent(seg[4]);
    const dev = getDeviceForFlash(db, id, deviceId);
    if (!dev) return err("DEVICE_NOT_FOUND", "device not found", 404);
    const body = (await req.json().catch(() => ({}))) as { toolKey?: unknown; serial?: unknown };
    const hex = (v: unknown, bytes: number): Buffer | null => {
      if (typeof v !== "string") return null;
      const s = v.replace(/[\s:-]/g, "");
      return new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(s) ? Buffer.from(s, "hex") : null;
    };
    const toolKey = hex(body.toolKey, 16);
    if (!toolKey) return err("TOOL_KEY_INVALID", "a tool key is 16 bytes as 32 hex digits; a serial, when given, 6 bytes as 12", 400);
    let given: Buffer | null = null;
    if (body.serial !== undefined && body.serial !== "") {
      given = hex(body.serial, 6);
      if (!given) return err("TOOL_KEY_INVALID", "a tool key is 16 bytes as 32 hex digits; a serial, when given, 6 bytes as 12", 400);
    }
    const onFile = getDeviceSecurity(db, id, deviceId, state.masterKey);
    const known = onFile?.serialNumber ?? getDeviceCertificate(db, id, deviceId, state.masterKey)?.serialNumber;
    if (known && given && !known.equals(given)) {
      return err("TOOL_KEY_SERIAL_MISMATCH", `the serial ${given.toString("hex")} differs from this device's on file, ${known.toString("hex")}`, 400);
    }
    const serial = known ?? given;
    if (!serial) return err("TOOL_KEY_SERIAL_MISSING", "the device's serial is needed for the secure Sync and none is on file; enter it", 400);
    const conn = getProjectConnection(db, id);
    if (!isConnectionReady(conn)) return err("INTERFACE_NOT_SET", "configure a bus connection first");
    const source = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read", writes: false },
      async (progress) => {
        let peer: bigint | null = null;
        const found = await secureIdentify(conn, dev.ia, { toolKey, serial, onPeerSequence: (s) => { peer = s; } }, progress);
        // A device in factory state answers a Sync under its factory key with its security mode
        // off; that key is not a tool key, and storing it would let an activation adopt it.
        if (found.securityMode.state === "off") {
          throw new ApiError("TOOL_KEY_SECURITY_MODE_OFF", "the device answered under this key but states its security mode is off: this is its factory key, not a tool key; activate it from its device certificate", 400);
        }
        if (found.serial !== null && found.serial !== serial.toString("hex")) {
          throw new ApiError("TOOL_KEY_SERIAL_MISMATCH", `the device reports serial ${found.serial}, not ${serial.toString("hex")}`, 400);
        }
        // Read inside the job: an activation queued before this one may have changed the entry.
        // The key busforge already holds keeps its origin (a provisioned key stays busforge's own),
        // and a pending one is now confirmed on the device.
        const current = getDeviceSecurity(db, id, deviceId, state.masterKey);
        const same = current?.toolKey.equals(toolKey);
        const src = same ? (current!.source === "pending" ? "provisioned" : current!.source) : "manual";
        putDeviceSecurity(db, id, [{ deviceId, toolKey, serialNumber: serial, sequenceNumber: peer !== null ? String(peer) : current?.sequenceNumber ?? "", source: src }], state.masterKey);
        return src;
      },
    );
    return json({ serial: serial.toString("hex"), source });
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
        }, progress, (seq) => setDeviceSequence(db, id, deviceId, seq));
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
    const gaFamilyApp = loadApp(state, id, deviceId);
    refuseNeverProgrammed(dev, gaFamilyApp);
    const gaEndsNever = dev.neverProgrammed && !canDownloadFull(gaFamilyApp);
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
    // If wiring these links would leave the device's kept-from-device com-object table stale, the
    // structural flash writes it (or the full download, or a refusal). Pre-enqueue.
    const gaStale = comObjectTableGuard(gaApp, gaBase, gaParams, gaModules, secureCredsFor(state, id, deviceId) !== undefined);
    if (gaStale === "structural") return structuralFlash(state, url, id, deviceId, dev, conn, gaAppXml);
    if (gaStale !== "surgical") return gaStale;
    let gaFingerprint: string | null = null;
    return programOrPreview(state,
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-ga" }, dryGa, "before-flash-ga",
      (progress, commit, gate) => programSubmission(state, id, deviceId, dev.programmingToken, dryGa, () => {
        // Re-checked when the job starts: a read-back queued ahead of it may have found gaps.
        if (getLinkBaseGaps(db, id, deviceId) !== 0) throw linkBaselineIncomplete(db, id, deviceId);
        const tables = securityTablesWithFingerprint(state, id, deviceId, resolved.links, dev.ia);
        gaFingerprint = tables.fingerprint;
        return flashDeviceGroupAddresses({
          projectId: id, deviceId, ia: dev.ia, appXml: gaAppXml, links: resolved.links,
          params: gaParams, baseParams: gaBase, moduleInstances: gaModules,
          connection: conn, dataDir: state.dataDir, ...tables.ctx,
          dryRun: dryGa, onProgress: progress, ...gate,
        });
      }, commit, () => {
        resetLinkBase(db, id, deviceId, resolved.flashedRefIds, submittedLinks);
        keepLinkBaseOnly(db, id, deviceId, new Set([...resolved.flashedRefIds, ...submittedLinks.keys()]));
        setLinkBaseGaps(db, id, deviceId, 0);
        setSecurityBase(state, id, deviceId, gaFingerprint);
        if (gaEndsNever) clearNeverProgrammed(db, id, deviceId);
      }, () => setSecurityBase(state, id, deviceId, gaFingerprint)),
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
    let dlFingerprint: string | null = null;
    return programOrPreview(state,
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "download" }, dryDl, "before-download",
      (progress, commit, gate) => programSubmission(state, id, deviceId, dev.programmingToken, dryDl, () => {
        const tables = securityTablesWithFingerprint(state, id, deviceId, resolved.links, dev.ia);
        dlFingerprint = tables.fingerprint;
        return downloadDeviceFull({
          projectId: id, deviceId, ia: dev.ia, appXml,
          connection: conn, dataDir: state.dataDir, ...tables.ctx,
          params: dlParams, links: resolved.links, moduleInstances: dlModules,
          dryRun: dryDl, onProgress: progress, ...gate,
        });
      }, commit, () => {
        resetParamBase(db, id, deviceId, dlParams, unwrittenParamRefs(state, id, deviceId, dlParams, dlModules));
        resetLinkBase(db, id, deviceId, resolved.flashedRefIds, submittedLinks);
        keepLinkBaseOnly(db, id, deviceId, new Set([...resolved.flashedRefIds, ...submittedLinks.keys()]));
        setLinkBaseGaps(db, id, deviceId, 0);
        setSecurityBase(state, id, deviceId, dlFingerprint);
        clearNeverProgrammed(db, id, deviceId);
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
    refuseNeverProgrammed(dev, flApp);
    const paramsEndNever = dev.neverProgrammed && !canDownloadFull(flApp);
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
    if (flStale === "structural") return structuralFlash(state, url, id, deviceId, dev, conn, appXml);
    if (flStale !== "surgical") return flStale;
    return programOrPreview(state,
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-params" }, dryParams, "before-flash",
      (progress, commit, gate) => programSubmission(state, id, deviceId, dev.programmingToken, dryParams, () => flashDeviceParameters({
          projectId: id, deviceId, ia: dev.ia, appXml,
          connection: conn, secure,
          params: flashParams, baseParams: flashBase, moduleInstances: flashModules, dataDir: state.dataDir,
          dryRun: dryParams, onProgress: progress, ...gate,
        }), commit, () => {
        resetParamBase(db, id, deviceId, flashParams, unwrittenParamRefs(state, id, deviceId, flashParams, flashModules));
        if (paramsEndNever) clearNeverProgrammed(db, id, deviceId);
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

  // /api/projects/:id/tasks/:taskId/cancel  -> cancel a queued task, a running one that writes
  // nothing, or a running write still in its read-only part (Task.cancellable)
  if (seg.length === 6 && seg[3] === "tasks" && seg[5] === "cancel" && req.method === "POST") {
    const task = state.queue.get(decodeURIComponent(seg[4]));
    if (!task || task.projectId !== id) return err("TASK_NOT_FOUND", "task not found", 404);
    const cancelled = state.queue.cancel(task.id);
    if (cancelled) return json({ cancelled });
    if (task.state === "running" && task.writes) {
      return err("TASK_WRITE_NOT_CANCELLABLE", "a running write cannot be cancelled: stopping it mid-write can leave the device reset; wait for its result", 409);
    }
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
    // POST /api/projects/:id/bus/group {ga, service: "write"|"read", value?: hex}
    if (seg[4] === "group" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { ga?: unknown; service?: unknown; value?: unknown };
      return json(await sendGroupTelegram(state, id, body));
    }
  }

  return null;
}

// A GroupValueWrite or GroupValueRead the user sends, handed to the interface over the monitor
// connection (whether it reached the bus is not confirmed; see Bus.sendGroup). The value's form
// follows the address's datapoint type: DPT 1-3 travel in the six bits of the APCI octet, every other
// type after it; for an address without a type a value that fits both forms is refused.
//
// On a secured address it is encrypted with the address's key, and only if the tunnel sends from an
// address the project lists as a sender of it: a receiver drops a secured telegram from anyone else
// (docs/findings.md §20), so sending it would only look like it worked. A secured telegram longer
// than a standard frame is refused: extended frames on this path are not implemented.
async function sendGroupTelegram(state: AppState, projectId: string, body: { ga?: unknown; service?: unknown; value?: unknown }): Promise<{ handedToInterface: true; secured: boolean }> {
  const ga = typeof body.ga === "number" ? body.ga : NaN;
  const meta = Number.isInteger(ga) && ga >= 1 && ga <= 0xffff ? getGaMeta(state.db, projectId, ga) : null;
  if (!meta) throw new ApiError("GA_NOT_FOUND", "group address not found", 404);
  let apdu: Buffer;
  if (body.service === "read") apdu = groupValueRead();
  else if (body.service === "write") {
    const hex = typeof body.value === "string" ? body.value : "";
    if (!/^([0-9a-fA-F]{2}){1,14}$/.test(hex)) throw new ApiError("GROUP_VALUE_INVALID", "a group value is 1 to 14 bytes of hex");
    const v = Buffer.from(hex, "hex");
    const main = parseInt(meta.dpt, 10);
    const fitsCompact = v.length === 1 && v[0] <= 0x3f;
    let compact: boolean;
    if ([1, 2, 3].includes(main)) {
      if (!fitsCompact) throw new ApiError("GROUP_VALUE_INVALID", `a DPT ${main} value is 6 bits (00 to 3f)`);
      compact = true;
    } else if (Number.isFinite(main)) compact = false;
    else if (fitsCompact) throw new ApiError("GROUP_VALUE_AMBIGUOUS", "this group address has no datapoint type, and the value fits both the 6-bit and the byte form; give the address a type first");
    else compact = false;
    apdu = compact ? Buffer.from([0x00, 0x80 | v[0]]) : Buffer.concat([Buffer.from([0x00, 0x80]), v]);
  } else throw new ApiError("GROUP_SERVICE_INVALID", "service must be write or read");

  const src = state.bus.senderIa(projectId);
  const key = getGroupKeys(state.db, projectId, state.masterKey).get(ga);
  if (!key) {
    await state.bus.sendGroup(projectId, ga, apdu);
    return { handedToInterface: true, secured: false };
  }
  // A standard frame carries at most 16 TPDU octets; the secure envelope adds SECURE_APDU_OVERHEAD.
  if (apdu.length + SECURE_APDU_OVERHEAD > 16) {
    throw new ApiError("SECURE_VALUE_TOO_LONG", "a secured telegram of this length needs an extended frame, which sending does not support yet; only values up to 6 bits (DPT 1-3) can be sent secured");
  }
  const from = numToIa(src);
  if (!(sendersByGroup(state.db, projectId).get(ga) ?? []).includes(from)) {
    throw new ApiError("SECURE_SENDER_NOT_LISTED", `${numToGa(ga)} is secured and ${from}, the address this connection sends from, is not one of its senders; add it and download the devices on the address first`, 409);
  }
  const seq = Buffer.alloc(6);
  seq.writeUIntBE(Number(nextSendSequence(state.db, projectId, from, toolSequenceNow())), 0, 6);
  const secured = Buffer.concat([Buffer.from([0x03, 0xf1]), secureEncode({
    key, src, dst: ga, dstIsGroup: true, seq, scf: SCF.AUTH_CONF, tpci: 0x03, aad: Buffer.from([SCF.AUTH_CONF]), plaintext: apdu,
  })]);
  await state.bus.sendGroup(projectId, ga, secured);
  return { handedToInterface: true, secured: true };
}
