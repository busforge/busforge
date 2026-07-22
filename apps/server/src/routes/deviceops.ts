import { parseAppConfig, comObjectTableChanges, type AppConfig, type ModuleInstance } from "@busforge/product";
import { getProjectConnection } from "../db/projects.ts";
import type { Connection } from "../db/connections.ts";
import { isConnectionReady } from "../transport.ts";
import { createSnapshot } from "../db/snapshots.ts";
import { getDeviceParams, getDeviceParamBase, getDeviceModules, getDeviceForFlash, replaceParamBase, replaceLinkBase, resetParamBase, resetLinkBase } from "../db/deviceparams.ts";
import { getDeviceSecurity } from "../db/deviceSecurity.ts";
import { flashDeviceParameters, flashDeviceGroupAddresses, downloadDeviceFull, readDeviceState, secureIdentify, classify, assignDeviceAddress, readDevicesInProgMode } from "../deviceprofile.ts";
import { buildDeviceView, loadApp, resolveAppXml, resolveDeviceLinks, deviceParamRefs, readbackLinkBase, unwrittenParamRefs, secureCredsFor } from "../deviceservice.ts";
import { ApiError } from "../errors.ts";
import { json, err } from "../httputil.ts";
import type { AppState } from "../app.ts";

// The shared preamble of the on-bus device operations (read-back / flash /
// flash-ga): resolve the device, require a ready bus connection, resolve the
// application XML. Codes, messages, statuses and their precedence are the
// routes' locked contract; the per-route capability guard stays in each route
// because the checked capability and the refusal code differ.
function busOpPreamble(state: AppState, projectId: string, deviceId: string): { dev: { ia: string; appRef: string; name: string }; conn: Connection; appXml: string } {
  const dev = getDeviceForFlash(state.db, projectId, deviceId);
  if (!dev) throw new ApiError("DEVICE_NOT_FOUND", "device not found", 404);
  const conn = getProjectConnection(state.db, projectId);
  if (!isConnectionReady(conn)) throw new ApiError("INTERFACE_NOT_SET", "configure a bus connection first");
  const appXml = resolveAppXml(state, projectId, dev.appRef);
  if (!appXml) throw new ApiError("APP_PROGRAM_MISSING", "application program not found in project", 404);
  return { dev, conn, appXml };
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
): Response | null {
  if (!app) return null; // no cfg: the profile layer's requireCfg refuses downstream
  if (!comObjectTableChanges(app, base, now, modules).length) return null;
  return classify(app).capabilities().fullDownload
    ? err("COM_OBJECT_TABLE_STALE_USE_DOWNLOAD", "this change alters the device's communication objects, which needs its com-object table rewritten; run a full download to apply it", 400)
    : err("COM_OBJECT_TABLE_STALE", "this change alters the device's communication objects, which needs its com-object table rewritten; busforge cannot do that for this device family yet", 400);
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
      { projectId: id, deviceId: "-", deviceName: "programming mode", ia: "-", kind: "read" },
      async () => {
        if (bus.activeProjectId) await bus.disconnect(); // free the bus for the probe
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
    const result = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "assign-ia" },
      async (progress) => {
        if (bus.activeProjectId) await bus.disconnect();
        return assignDeviceAddress(conn, dev.ia, progress);
      },
    );
    return json(result);
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
    const relevantRefs = deviceParamRefs(state, id, deviceId);
    const rb = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read" },
      async (progress, signal) => {
        // Free the bus so the read holds the only connection-oriented link.
        if (bus.activeProjectId) await bus.disconnect();
        return readDeviceState({
          ia: dev.ia, appXml,
          connection: conn, secure: secureCredsFor(state, id, deviceId),
          liveParams: getDeviceParams(db, id, deviceId), baseParams: getDeviceParamBase(db, id, deviceId),
          moduleInstances: getDeviceModules(db, id, deviceId), relevantRefs, onProgress: progress, signal,
        });
      },
    );
    // Persist ONLY the aspects actually read off the device. An aspect we couldn't
    // read keeps its existing baseline rather than getting a fabricated/garbage one.
    if (rb.paramsRead) replaceParamBase(db, id, deviceId, rb.paramBase);
    let linkGaps = 0;
    if (rb.linksRead) {
      const lb = readbackLinkBase(state, id, deviceId, rb.links);
      replaceLinkBase(db, id, deviceId, lb.base);
      linkGaps = lb.gaps;
    }
    // `readback` tells the client what this read actually covered: `linkGaps` counts
    // device associations that could not be mapped onto a known com-object and are
    // therefore NOT in the baseline (drift there stays invisible). Surfaced instead of
    // letting the read-back pass as a complete links baseline.
    return json(buildDeviceView(state, id, deviceId, body.lang, { readback: { paramsRead: rb.paramsRead, linksRead: rb.linksRead, linkGaps } }));
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
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "read" },
      async (progress) => {
        if (bus.activeProjectId) await bus.disconnect();
        return secureIdentify(conn, dev.ia, sec.toolKey, sec.serialNumber, progress);
      },
    );
    return json({ ia: dev.ia, secure: true, ...result });
  }

  // /api/projects/:id/devices/:deviceId/flash-ga?dry=1  -> program the group tables
  if (seg.length === 6 && seg[3] === "devices" && seg[5] === "flash-ga" && req.method === "POST") {
    const deviceId = decodeURIComponent(seg[4]);
    const { dev, conn, appXml: gaAppXml } = busOpPreamble(state, id, deviceId);
    const resolved = resolveDeviceLinks(state, id, deviceId);
    if (!resolved) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
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
    const gaStale = comObjectTableGuard(gaApp, gaBase, gaParams, gaModules);
    if (gaStale) return gaStale;
    // Auto restore point of the about-to-be-programmed config (real flash only).
    if (!dryGa) createSnapshot(db, id, { kind: "auto", reason: "before-flash-ga" }, state.now());
    const result = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-ga" },
      async (progress) => {
        if (bus.activeProjectId) await bus.disconnect();
        return flashDeviceGroupAddresses({
          projectId: id, deviceId, ia: dev.ia, appXml: gaAppXml, links: resolved.links,
          params: gaParams, baseParams: gaBase, moduleInstances: gaModules,
          connection: conn, secure: secureCredsFor(state, id, deviceId), dataDir: state.dataDir,
          dryRun: dryGa, onProgress: progress,
        });
      },
    );
    // The device's group tables now match our links: clear the marker for ONLY the links we
    // actually flashed (skipped links stay as drift; see resetLinkBase / resolveDeviceLinks).
    // An unverified flash keeps the old baseline: nothing was confirmed on the device.
    if (result.kind === "flashed" && result.verified) resetLinkBase(db, id, deviceId, resolved.flashedRefIds);
    return json(result);
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
    if (!resolved) return err("APP_PROGRAM_MISSING", "application program not found in project", 404);
    const dlParams = getDeviceParams(db, id, deviceId);
    const dlModules = getDeviceModules(db, id, deviceId);
    const keepDrift = unwrittenParamRefs(state, id, deviceId, dlParams, dlModules);
    const dryDl = url.searchParams.get("dry") === "1";
    if (!dryDl) createSnapshot(db, id, { kind: "auto", reason: "before-download" }, state.now());
    const result = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "download" },
      async (progress) => {
        if (bus.activeProjectId) await bus.disconnect();
        return downloadDeviceFull({
          projectId: id, deviceId, ia: dev.ia, appXml,
          connection: conn, secure: secureCredsFor(state, id, deviceId), dataDir: state.dataDir,
          params: dlParams, links: resolved.links, moduleInstances: dlModules,
          dryRun: dryDl, onProgress: progress,
        });
      },
    );
    // The device now holds this configuration, parameters AND links: baseline both, but only on a
    // verified download. An unverified one leaves every baseline alone, so the UI keeps showing the
    // configuration as unprogrammed, which is the truth.
    if (result.kind === "flashed" && result.verified) {
      resetParamBase(db, id, deviceId, keepDrift);
      resetLinkBase(db, id, deviceId, resolved.flashedRefIds);
    }
    return json(result);
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
    // Snapshot the stored config ONCE, before the (long, bus-bound) flash is queued, and use
    // the same snapshot for both the image and the post-flash baseline decision. A param edit
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
    const flStale = comObjectTableGuard(flApp, flashBase, flashParams, flashModules);
    if (flStale) return flStale;
    const keepDrift = unwrittenParamRefs(state, id, deviceId, flashParams, flashModules);
    // Auto restore point of the about-to-be-programmed config (real flash only).
    if (!dryParams) createSnapshot(db, id, { kind: "auto", reason: "before-flash" }, state.now());
    const result = await state.queue.enqueue(
      { projectId: id, deviceId, deviceName: dev.name, ia: dev.ia, kind: "flash-params" },
      async (progress) => {
        // Free the bus so the flash holds the only connection-oriented link.
        if (bus.activeProjectId) await bus.disconnect();
        return flashDeviceParameters({
          projectId: id, deviceId, ia: dev.ia, appXml,
          connection: conn, secure: secureCredsFor(state, id, deviceId),
          params: flashParams, baseParams: flashBase, moduleInstances: flashModules, dataDir: state.dataDir,
          dryRun: dryParams, onProgress: progress,
        });
      },
    );
    // The device's parameter segment now matches our values: clear the marker, EXCEPT for
    // params the flash did NOT write (keepDrift): memory-backed text/colour the codec refuses,
    // AND currently-hidden overrides the image builder skipped. Their rows were not programmed,
    // so adopting them into the baseline would clear a "changed" chip for a value that never
    // reached the device.
    if (result.kind === "flashed" && result.verified) resetParamBase(db, id, deviceId, keepDrift);
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

  return null;
}
