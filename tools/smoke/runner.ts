// The capability/behaviour smoke runner. It knows the lifecycle (provision, configure, teardown) and
// NOTHING about any device: what a device can do is read from the product at run time
// (config.capabilities), and the runner exercises exactly those capabilities in the requested
// channel, then proves the device's declared behaviours on the bus. A capability the product claims
// but the run never exercises is a HARD failure, never a skip. Everything device-specific lives in a
// DeviceSpec (specs/). See docs/testing.md and /CONTEXT.md.
//
// One channel per invocation (--channel=api|ui, default api); the bench done-bar wants BOTH green, so
// a device is run once per channel and each report recorded. Assertions always read the API; in the
// ui channel the browser is driven, never asked to confirm itself.
//
// Hardware-gated: refuses to run without BUSFORGE_BENCH=1 and a reachable bench bridge. Never part of
// `bun run check`.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { Client, ApiError, allParams, allComObjects, type DeviceCapabilities } from "./client.ts";
import { Witness } from "./witness.ts";
import { UiDriver } from "./ui.ts";
import { makePrng, gaAllocator } from "./generate.ts";
import { CAP_DRIVERS, type CapabilityResult, type CapCtx } from "./capabilities.ts";
import { verifyBehaviour, type BehaviourResult, type BehaviourCtx } from "./behaviours.ts";
import { linkChan, type ChanCtx } from "./channel.ts";
import type { Channel, DeviceSpec } from "./spec.ts";
import { SPECS } from "./specs/index.ts";
import { runEvidence } from "./evidence.ts";
import { observeReboot, judgeRestoredConfig, judgeLoadStates, type RebootObservation, type ProbeOutcome } from "./persistence.ts";
import { transportOf, gitRevision, sha256, readFirmwareRevision } from "../evidence.ts";
import { KnxIpTunnel, KnxDevice, KnxError, lsmState, SecureSession, iaToNum, type KnxTransport } from "../../packages/knx/src/index.ts";
import { loadKnxproj } from "../../packages/project/src/index.ts";
import { FaultProxy } from "./faultproxy.ts";
import { isMemoryMappedLsm, type Firmware } from "../../packages/product/src/index.ts";

// A capability that has a UI surface but no meaningful API surface, or vice versa, is recorded — never
// silently dropped. click-through is UI-only; provision is a lifecycle capability run every channel.
interface RunResult {
  spec: string; channel: Channel; seed: number; ok: boolean;
  startedAt: number; durationMs: number;
  provision: string;
  capabilities: CapabilityResult[];
  clickThrough: { state: "pass" | "fail" | "not-applicable"; detail: string };
  behaviours: BehaviourResult[];
  refusals: { capability: string; state: "pass" | "fail"; detail: string }[];
  pid: string | null;
  // The saved connection's KNXnet/IP transport ("udp", "tcp", "auto"), once the run found it.
  ipTransport: string | null;
  firmware: Firmware;
  persistence?: { state: "pass" | "fail"; detail: string };
  // Data Secure devices only: the refusals that must hold (wrong or missing key, altered answers),
  // and the proof that the imported configuration is back on the device when the run ends.
  negatives?: { name: string; state: "pass" | "fail"; detail: string }[];
  restore?: { state: "pass" | "fail"; detail: string };
}

// A Data Secure device's tool-access credentials, from the imported project file. The runner's own
// bench connections (reboot, load states, firmware, negatives) need them: a device in secure mode
// ignores a plain management service.
type Creds = { toolKey: Buffer; serial: Buffer } | undefined;
function deviceOn(tun: KnxTransport, ia: string, creds: Creds, toolKey = creds?.toolKey): KnxDevice {
  if (!creds || !toolKey) return new KnxDevice(tun, ia);
  return new KnxDevice(tun, ia, new SecureSession({ toolKey, src: tun.assignedIa, dst: iaToNum(ia), serial: creds.serial }));
}

// Read the device's firmware revision over the bench interface, like the witness: only while the
// server holds no bus operation, because the bench bridge has one tunnel channel.
async function readBenchFirmware(host: string, ia: string, creds: Creds): Promise<Firmware> {
  const tun = KnxIpTunnel.tcp(host, Number(process.env.BUSFORGE_BENCH_PORT ?? 3681));
  await tun.connect();
  const dev = deviceOn(tun, ia, creds);
  try { await dev.connect(); return await readFirmwareRevision(dev); }
  finally { try { await dev.disconnect(); } catch { /* link already gone */ } await tun.disconnect(); }
}

type LoadStates = Map<number, number | null>;

// The load state of load objects 1-4, null where the device does not report one (an empty answer).
// Any other read error is thrown: a timeout must not quietly take an object out of the check.
async function readLoadStates(tun: KnxIpTunnel, ia: string, mask: string, creds: Creds): Promise<LoadStates> {
  const dev = deviceOn(tun, ia, creds);
  const out: LoadStates = new Map();
  try {
    await dev.connect();
    for (const obj of [1, 2, 3, 4]) out.set(obj, (await lsmState(dev, obj, isMemoryMappedLsm(mask))) ?? null);
  } finally { await dev.disconnect(); }
  return out;
}

// Restart the device over the bench interface and observe the reboot (persistence.ts), with the
// load states before the restart and after the reboot. Like the firmware read, only while the
// server holds no bus operation.
async function rebootOnBench(host: string, ia: string, mask: string, creds: Creds): Promise<{ reboot: RebootObservation; before: LoadStates; after: LoadStates }> {
  const tun = KnxIpTunnel.tcp(host, Number(process.env.BUSFORGE_BENCH_PORT ?? 3681));
  await tun.connect();
  try {
    const before = await readLoadStates(tun, ia, mask, creds);
    const restart = async () => { const dev = deviceOn(tun, ia, creds); await dev.connect(); await dev.sendRestart(); await dev.disconnect(); };
    // Only the device's own silence is "silent"; an interface or tunnel error is thrown. On a secure
    // device a rebooting device leaves the Sync unanswered, which is the same silence.
    const probe = async (): Promise<ProbeOutcome> => {
      const dev = deviceOn(tun, ia, creds);
      try { await dev.connect(); await dev.deviceDescriptor(); return "answered"; }
      catch (e) { if (e instanceof KnxError && (e.code === "DEVICE_NOT_ANSWERING" || (creds && e.code === "SECURE_SYNC_NO_RESPONSE"))) return "silent"; throw e; }
      finally { await dev.disconnect(); }
    };
    const reboot = await observeReboot(restart, probe);
    const after = reboot.rebooted ? await readLoadStates(tun, ia, mask, creds) : new Map<number, number | null>();
    return { reboot, before, after };
  } finally { await tun.disconnect(); }
}

// The Data Secure robustness checks for a secure device: each is an outcome Busforge must report with
// its own code, never as success or a generic failure.
// - no tool key in the project        -> SECURE_KEY_MISSING
// - a different tool key              -> SECURE_SYNC_NO_RESPONSE, and the right key still works after
// - every secured answer bit-flipped  -> SECURE_ANSWER_REJECTED (the MAC no longer matches)
// - an earlier answer delivered again -> DEVICE_NOT_ANSWERING (an old sequence number is dropped), or
//                                        DEVICE_CLOSED_CONNECTION: the device's real answer never got
//                                        our acknowledgement, and the Jung closed the connection
//                                        (2026-09-30); either way the replay was not used
// The last two run the server's own read-back through a local pass-through (faultproxy.ts).
type Robustness = NonNullable<RunResult["negatives"]>;
async function secureRobustness(o: { client: Client; spec: DeviceSpec; host: string; benchConnId: string; pid: string; did: string; creds: NonNullable<Creds>; log: (m: string) => void }): Promise<Robustness> {
  const out: Robustness = [];
  const port = Number(process.env.BUSFORGE_BENCH_PORT ?? 3681);
  const expectCode = async (name: string, want: string | readonly string[], run: () => Promise<unknown>) => {
    const wanted: readonly string[] = typeof want === "string" ? [want] : want;
    try { await run(); out.push({ name, state: "fail", detail: `succeeded; expected ${wanted.join(" or ")}` }); }
    catch (e) {
      const code = e instanceof ApiError || e instanceof KnxError ? e.code : String(e);
      const ok = code !== undefined && wanted.includes(code);
      out.push({ name, state: ok ? "pass" : "fail", detail: ok ? `reported ${code}` : `got ${code}, expected ${wanted.join(" or ")}` });
    }
    o.log(`${name}: ${out.at(-1)!.detail}`);
  };

  const bare = await o.client.createProject(`smoke-${o.spec.id}-nokey-${Date.now()}`);
  try {
    await o.client.attachConnection(bare.id, o.benchConnId);
    const d = await o.client.placeDevice(bare.id, o.spec.device.appRef, o.spec.device.productRef, "no key");
    await o.client.setAddress(bare.id, d.id, o.spec.device.ia);
    await expectCode("no tool key", "SECURE_KEY_MISSING", () => o.client.readBack(bare.id, d.id));
  } finally { await o.client.deleteProject(bare.id).catch(() => undefined); }

  const tun = KnxIpTunnel.tcp(o.host, port);
  await tun.connect();
  try {
    const other = Buffer.from(o.creds.toolKey); other[0] ^= 0x01;
    await expectCode("different tool key", "SECURE_SYNC_NO_RESPONSE", async () => {
      const dev = deviceOn(tun, o.spec.device.ia, o.creds, other);
      try { await dev.connect(); } finally { await dev.disconnect(); }
    });
    const dev = deviceOn(tun, o.spec.device.ia, o.creds);
    try { await dev.connect(); await dev.deviceDescriptor(); out.push({ name: "right tool key afterwards", state: "pass", detail: "session opened, descriptor read" }); }
    catch (e) { out.push({ name: "right tool key afterwards", state: "fail", detail: e instanceof Error ? e.message : String(e) }); }
    finally { await dev.disconnect(); }
  } finally { await tun.disconnect(); }

  const proxy = new FaultProxy(o.host, port, iaToNum(o.spec.device.ia));
  const local = await proxy.start();
  const via = await o.client.createConnection({ name: `smoke pass-through ${local}`, type: "ip", host: "127.0.0.1", port: local, ipTransport: "tcp" });
  try {
    await o.client.attachConnection(o.pid, via.id);
    for (const [mode, name, want] of [["corrupt", "corrupted answer", "SECURE_ANSWER_REJECTED"], ["duplicate", "duplicated answer", ["DEVICE_NOT_ANSWERING", "DEVICE_CLOSED_CONNECTION"]]] as const) {
      proxy.setMode(mode);
      await expectCode(name, want, () => o.client.readBack(o.pid, o.did));
      // A check the pass-through never acted on proves nothing about the answer handling.
      if (proxy.altered === 0) { const last = out[out.length - 1]; last.state = "fail"; last.detail += "; no answer was changed"; }
      await new Promise((r) => setTimeout(r, 3000));
    }
  } finally {
    // Each step on its own: one that fails must not leave the pass-through listening, the temporary
    // connection saved, or the project pointed at 127.0.0.1.
    proxy.setMode("pass");
    await o.client.attachConnection(o.pid, o.benchConnId).catch((e) => o.log(`could not re-attach the bench connection: ${e instanceof Error ? e.message : String(e)}`));
    await o.client.deleteConnection(via.id).catch((e) => o.log(`could not delete the temporary connection: ${e instanceof Error ? e.message : String(e)}`));
    await proxy.stop().catch(() => undefined);
  }
  return out;
}

// Take the device back to the imported project file's configuration and prove it: parameters and
// links the run changed are set back to what the import held (every linked address, not only the
// first), written (a full download when a parameter changed, since one may alter the com-object
// table; otherwise a GA flash), then the GA flash dry run must find the group tables and security
// object unchanged and a read-back must show no parameter drift. The parameter flash dry run is not
// used: the Jung changes one byte of its parameter segment outside every parameter after a download.
// So the ETS project the file came from stays valid for the device.
async function restoreToImport(client: Client, pid: string, did: string, links: Map<string, number[]>, params: Map<string, string>, log: (m: string) => void, settle: (ms: number) => Promise<void>): Promise<NonNullable<RunResult["restore"]>> {
  try {
    const view = await client.getConfig(pid, did);
    const sameLinks = (a: number[], b: number[]) => a.length === b.length && a.every((g, i) => g === b[i]);
    const movedParams = allParams(view).filter((p) => params.has(p.refId) && params.get(p.refId) !== p.value);
    for (const p of movedParams) await client.setParam(pid, did, p.refId, params.get(p.refId)!);
    const now = allComObjects(await client.getConfig(pid, did));
    const movedLinks = now.filter((c) => !sameLinks(c.gaRaws ?? [], links.get(c.refId) ?? []));
    for (const c of movedLinks) await client.setLinks(pid, did, c.refId, links.get(c.refId) ?? []);
    if (movedParams.length) {
      const r = await client.downloadReal(pid, did, (p) => log(`restore ${p}`));
      if (r.kind !== "flashed" || r.verified !== true) return { state: "fail", detail: `restoring ${movedParams.length} parameter(s): download ${r.kind}, verified=${r.verified}` };
      await settle(3000);
    } else if (movedLinks.length) {
      const r = await client.flashGaReal(pid, did, (p) => log(`restore ${p}`));
      if (r.kind !== "flashed" || r.verified !== true) return { state: "fail", detail: `restoring ${movedLinks.length} link(s): flash-ga ${r.kind}, verified=${r.verified}` };
      await settle(3000);
    }
    const ga = await client.flashGaDry(pid, did);
    const rb = await client.readBack(pid, did, (p) => log(`restore read ${p}`));
    await settle(3000);
    const drift = allParams(await client.getConfig(pid, did)).filter((p) => p.changed).map((p) => p.refId.split("_").pop());
    const back = ga.kind === "unchanged" && rb?.paramsRead === true && drift.length === 0;
    return { state: back ? "pass" : "fail", detail: `${movedParams.length} parameter(s), ${movedLinks.length} object link(s) restored; group tables ${ga.kind}; parameters ${rb?.paramsRead ? `read, ${drift.length ? `drift in ${drift.join(", ")}` : "no drift"}` : "not read"}` };
  } catch (e) {
    return { state: "fail", detail: `restore aborted: ${e instanceof Error ? e.message : String(e)}` };
  }
}

class Stop extends Error { constructor(readonly phase: string, readonly detail: string) { super(detail); } }

// The capabilities checked for a guard-the-guardrail refusal when the product does NOT claim them: an
// unclaimed write capability's endpoint must refuse with a coded error, never silently succeed. Only
// dry-runs (read-only, pre-enqueue refusals) are used, so this touches no bus write.
const REFUSAL_PROBES: { key: keyof DeviceCapabilities; probe: (c: Client, pid: string, did: string) => Promise<unknown> }[] = [
  { key: "flashParams", probe: (c, pid, did) => c.flashDry(pid, did) },
  { key: "flashLinks", probe: (c, pid, did) => c.flashGaDry(pid, did) },
  { key: "fullDownload", probe: (c, pid, did) => c.downloadDry(pid, did) },
];

async function runSpec(spec: DeviceSpec, channel: Channel, seed: number): Promise<RunResult> {
  const client = new Client();
  const host = process.env.BUSFORGE_BENCH_HOST ?? "";
  const witness = new Witness(host);
  const ui = channel === "ui" ? new UiDriver() : null;
  const startedAt = Date.now();
  const log = (m: string) => process.stdout.write(`    …${m}\n`);
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const rnd = makePrng(seed);
  const allocGa = spec.fuzz ? gaAllocator(spec.fuzz) : () => { throw new Error("spec has no fuzz.gaRange; cannot allocate a group address"); };
  const capabilities: CapabilityResult[] = [];
  const behaviours: BehaviourResult[] = [];
  const refusals: RunResult["refusals"] = [];
  let clickThrough: RunResult["clickThrough"] = { state: "not-applicable", detail: channel === "ui" ? "not run" : "no UI surface in the api channel" };
  let pid: string | null = null;
  let did: string | null = null;
  let ipTransport: string | null = null;
  let firmware: Firmware = { state: "unknown" };
  let persistence: RunResult["persistence"];
  let negatives: RunResult["negatives"];
  let restore: RunResult["restore"];
  // Set once an imported project is in place; run on every path out, a failed run included.
  let restoreImported: (() => Promise<NonNullable<RunResult["restore"]>>) | null = null;
  let creds: Creds;
  let groupKeys: Map<number, Buffer> | undefined;
  let ok = true;

  try {
    // ── preflight ──────────────────────────────────────────────────────────
    if (process.env.BUSFORGE_BENCH !== "1") throw new Stop("preflight", "refused: no bench (set BUSFORGE_BENCH=1)");
    if (!host) throw new Stop("preflight", "refused: BUSFORGE_BENCH_HOST is not set; it must name the KNX interface this run drives");
    const products = await client.catalogProducts().catch((e) => { throw new Stop("preflight", `server unreachable: ${e instanceof Error ? e.message : String(e)}`); });
    const imported = spec.provision === "import-knxproj";
    if (!imported && !products.some((p) => p.appRef === spec.device.appRef && p.productRef === spec.device.productRef)) throw new Stop("preflight", `product not in catalog (${spec.device.appRef}); import the .knxprod first`);
    const password = process.env.BUSFORGE_SMOKE_KNXPROJ_PASSWORD ?? "";
    if (imported && (!spec.device.knxprod || !password)) throw new Stop("preflight", "refused: import-knxproj needs device.knxprod in the spec and BUSFORGE_SMOKE_KNXPROJ_PASSWORD set");
    try { await witness.connect(); await witness.close(); } catch (e) { throw new Stop("preflight", `bench bridge unreachable: ${e instanceof Error ? e.message : String(e)}`); }

    // ── setup + place (API plumbing) ─────────────────────────────────────────
    const conns = await client.connections();
    // Host AND port: one machine can offer several interfaces (the bench bridge and a logging proxy).
    const conn = conns.find((c) => c.type === "ip" && c.host === host && c.port === Number(process.env.BUSFORGE_BENCH_PORT ?? 3681));
    if (!conn) throw new Stop("setup", `no saved IP connection for the interface ${host}`);
    ipTransport = conn.ipTransport ?? null;
    if (imported) {
      // The project file carries the device's configuration and, for a Data Secure device, its keys:
      // the server gets them through the import, the runner reads the same file for its own bench
      // connections. Nothing key-bearing is written into the report.
      const file = resolve(join(import.meta.dir, "..", ".."), spec.device.knxprod!);
      const bytes = readFileSync(file);
      const proj = await client.importProject(bytes, basename(file), password);
      pid = proj.id;
      await client.attachConnection(pid, conn.id);
      const found = (await client.projectDevices(pid)).find((d) => d.ia === spec.device.ia);
      if (!found) throw new Stop("setup", `the imported project has no device at ${spec.device.ia}`);
      did = found.id;
      const project = loadKnxproj(bytes, password, basename(file));
      const sec = project.deviceSecurity.find((d) => d.deviceId === found.id);
      creds = sec ? { toolKey: Buffer.from(sec.toolKey, "base64"), serial: Buffer.from(sec.serialNumber, "base64") } : undefined;
      groupKeys = new Map(project.groupKeys.map((g) => [g.raw, Buffer.from(g.key, "base64")]));
      log(`imported ${basename(file)}: ${creds ? "Data Secure device" : "plain device"}, ${groupKeys.size} secured group address(es)`);
    } else {
      const proj = await client.createProject(`smoke-${spec.id}-${channel}-${startedAt}`);
      pid = proj.id;
      await client.attachConnection(pid, conn.id);
      const dev = await client.placeDevice(pid, spec.device.appRef, spec.device.productRef, `smoke ${spec.id}`);
      did = dev.id;
      await client.setAddress(pid, did, spec.device.ia);
    }
    // What the imported project links, for the restore at the end of the run.
    if (imported) {
      const view = await client.getConfig(pid, did);
      // Without every linked address per object the restore would compare empty lists and pass
      // without having looked: a server that does not report them is refused here.
      if (allComObjects(view).some((c) => c.gaRaws === undefined)) throw new Stop("setup", "the server's config view carries no gaRaws (an older build); the restore could not see the links it must put back");
      const links = new Map(allComObjects(view).map((c) => [c.refId, c.gaRaws ?? []]));
      const params = new Map(allParams(view).map((p) => [p.refId, p.value]));
      const [rp, rd] = [pid, did];
      restoreImported = () => restoreToImport(client, rp, rd, links, params, log, settle);
    }
    if (ui) { try { await ui.launch(); await ui.gotoDevice(pid, did); } catch (e) { throw new Stop("setup", `UI unavailable (is \`bun run dev:web\` up?): ${e instanceof Error ? e.message : String(e)}`); } }

    const chan: ChanCtx = { client, ui, pid, did, channel, log, settle };
    const capCtx: CapCtx = { ...chan, spec, rnd, allocGa };

    // ── provision ────────────────────────────────────────────────────────────
    if (spec.precondition) process.stdout.write(`  ! precondition: ${spec.precondition}\n`);
    if (spec.provision === "skip-if-present" || spec.provision === "import-knxproj") {
      try { await client.readBack(pid, did); } catch (e) { throw new Stop("provision", `device does not answer on ${spec.device.ia} (${e instanceof ApiError ? e.code : String(e)}); a from-virgin run needs provision:"require-prog-mode"`); }
      await settle(3000);
    } else if (channel === "api") {
      // The ui channel folds assign-ia into the CommissionDialog (fullDownload driver); the api
      // channel assigns here so the subsequent download writes to the device's own address.
      const scan = await client.progMode(pid);
      if (scan.devices.length !== 1) throw new Stop("provision", `expected exactly one device in programming mode, saw ${scan.devices.length} (press the button on ${spec.id})`);
      const r = await client.assignIa(pid, did);
      if (!r.verified) throw new Stop("provision", `assign-ia did not verify (previous ${r.previous})`);
    }

    // ── baseline configure (API plumbing: reach a known, linkable state) ──────
    for (const step of spec.configure) {
      if ("set" in step) await client.setParam(pid, did, step.set.paramRefId, step.set.value);
      else { const co = (await client.getConfig(pid, did)); const obj = allComObjects(co).find((c) => c.refId === step.link.comObjRefId || c.refId.endsWith(step.link.comObjRefId)); if (!obj) throw new Stop("configure", `baseline com-object ${step.link.comObjRefId} not visible`); await linkChan({ ...chan, channel: "api" }, { refId: obj.refId, number: obj.number }, step.link.ga); }
    }
    // The configure above runs server-side (API plumbing), but the browser page was loaded in setup
    // BEFORE it. Dynamic visibility is resolved from the config the page holds, so a switch channel the
    // baseline just enabled (its params, its com-object link rows) is still hidden in the stale page,
    // and every ui write driver would time out waiting for an element that will never appear. Reload so
    // the ui channel sees the configured, linkable state. (No-op on the api channel.)
    if (ui) await ui.gotoDevice(pid, did);

    // ── capabilities: run exactly what the product claims, in this channel ────
    const caps = (await client.getConfig(pid, did)).capabilities;
    if (!caps) throw new Stop("capabilities", "device config carried no capabilities (server did not attach classify().capabilities())");
    // A stable order: establish the device (fullDownload) before the surgical write paths, then reads.
    // Built from a Record over EVERY DeviceCapabilities key, so adding a capability field to the
    // product forces adding it here (a compile error otherwise) — no key can be silently unexercised.
    const CAP_ORDER: Record<keyof DeviceCapabilities, number> = { fullDownload: 0, flashLinks: 1, flashParams: 2, readParams: 3, readLinks: 4 };
    const ORDER = (Object.keys(CAP_ORDER) as (keyof DeviceCapabilities)[]).sort((a, b) => CAP_ORDER[a] - CAP_ORDER[b]);
    const unsafe = new Map((spec.unsafe ?? []).map((u) => [u.capability, u.reason]));
    for (const key of ORDER) {
      if (!caps[key]) continue; // unclaimed: handled by the refusal probe below
      if (unsafe.has(key)) { capabilities.push({ capability: key, channel, state: "unsafe", detail: unsafe.get(key)! }); process.stdout.write(`  · capability ${key}: unsafe on the bench, not exercised (${unsafe.get(key)})\n`); continue; }
      const driver = CAP_DRIVERS[key];
      if (!driver) throw new Stop("capabilities", `capability ${key} is claimed but has no driver (a new DeviceCapabilities key needs a driver here)`);
      process.stdout.write(`  → capability ${key} (${channel})\n`);
      await settle(2000);
      const res = await driver(capCtx).catch((e): CapabilityResult => ({ capability: key, channel, state: "fail", detail: e instanceof Error ? e.message : String(e) }));
      capabilities.push(res);
      if (res.state === "fail") ok = false;
    }

    // ── persistence: restart, prove the reboot, read back ─────────────────────
    // Right after the capabilities, so the state read back is the one they left: the download's image
    // and the link flashLinks placed, before any behaviour relinks or re-flashes. Only a write this
    // run placed can be shown to persist (evidence.ts). The read-back goes through the API in both
    // channels: it is the oracle here, not the surface under test.
    // After a failed write the project and the device disagree for a reason of their own, and the
    // read-back could not tell which write the drift belongs to, so persistence is not judged.
    const writeFailed = capabilities.some((c) => c.state === "fail");
    if (writeFailed) log("persistence not checked: a capability failed in this run");
    else if (capabilities.some((c) => c.state === "pass" && (c.capability === "fullDownload" || c.capability === "flashLinks"))) {
      process.stdout.write(`  → persistence (${channel})\n`);
      await settle(2000);
      const checked = await (async (): Promise<NonNullable<RunResult["persistence"]>> => {
        const { reboot, before, after } = await rebootOnBench(host, spec.device.ia, spec.device.mask, creds);
        log(reboot.detail);
        if (!reboot.rebooted) return { state: "fail", detail: reboot.detail };
        const states = judgeLoadStates(before, after);
        log(states.detail);
        await settle(3000);
        const coverage = await client.readBack(pid!, did!, (p) => log(`read ${p}`));
        const judged = judgeRestoredConfig(await client.getConfig(pid!, did!), coverage);
        const state = states.state === "pass" && judged.state === "pass" ? "pass" : "fail";
        return { state, detail: `${reboot.detail}; ${states.detail}; ${judged.detail}` };
      })().catch((e): NonNullable<RunResult["persistence"]> => ({ state: "fail", detail: `persistence check aborted: ${e instanceof Error ? e.message : String(e)}` }));
      persistence = checked;
      if (checked.state === "fail") ok = false;
    }

    // ── ui-click-through (lifecycle capability, UI surface only) ──────────────
    if (ui) {
      process.stdout.write("  → ui-click-through\n");
      const view = await client.getConfig(pid, did);
      try { await ui.clickThrough(allParams(view).map((p) => p.refId), allComObjects(view).map((c) => c.number)); clickThrough = { state: "pass", detail: `${allParams(view).length} params, ${allComObjects(view).length} objects rendered` }; }
      catch (e) { clickThrough = { state: "fail", detail: e instanceof Error ? e.message : String(e) }; ok = false; }
    }

    // ── behaviours: prove the device ACTS on the bus ──────────────────────────
    const behCtx: BehaviourCtx = { ...chan, witness, spec, allocGa, groupKeys };
    for (const b of spec.behaviours) {
      process.stdout.write(`  → behaviour ${b.kind}:${b.label} (${channel})\n`);
      await settle(2000);
      const res = await verifyBehaviour(behCtx, b);
      behaviours.push(res);
      if (res.state === "fail") ok = false;
    }

    // ── guard the guardrail: an UNCLAIMED write capability must be refused ─────
    for (const { key, probe } of REFUSAL_PROBES) {
      if (caps[key]) continue; // claimed: exercised above, not refused
      try { await probe(client, pid, did); refusals.push({ capability: key, state: "fail", detail: "endpoint did NOT refuse an unclaimed capability" }); ok = false; }
      catch (e) { refusals.push({ capability: key, state: e instanceof ApiError ? "pass" : "fail", detail: e instanceof ApiError ? `refused: ${e.code}` : `unexpected error: ${e instanceof Error ? e.message : String(e)}` }); if (!(e instanceof ApiError)) ok = false; }
    }

    // ── firmware: recorded when the device reports it, unknown otherwise ────────
    firmware = await readBenchFirmware(host, spec.device.ia, creds).catch((e): Firmware => { log(`firmware revision not read: ${e instanceof Error ? e.message : String(e)}`); return { state: "unknown" }; });
    process.stdout.write(`  · firmware revision: ${firmware.state === "observed" ? firmware.value : "unknown"}\n`);

    // ── Data Secure robustness: each refusal must come with its own code ──────
    if (creds) {
      process.stdout.write("  → secure robustness\n");
      await settle(2000);
      negatives = await secureRobustness({ client, spec, host, benchConnId: conn.id, pid, did, creds, log });
      if (negatives.some((n) => n.state === "fail")) ok = false;
    }

    // ── restore the imported configuration and prove it is back ──────────────
    if (restoreImported) {
      process.stdout.write("  → restore\n");
      restore = await restoreImported();
      if (restore.state === "fail") ok = false;
    }

    // ── teardown (only a clean run tidies up; a failure keeps the project) ─────
    if (ok) { await client.deleteProject(pid); pid = null; }
  } catch (e) {
    ok = false;
    if (e instanceof Stop) capabilities.push({ capability: e.phase, channel, state: "fail", detail: e.detail });
    else { capabilities.push({ capability: "?", channel, state: "fail", detail: e instanceof Error ? e.message : String(e) }); if (e instanceof Error && e.stack) process.stderr.write(`\n[unlabeled failure stack]\n${e.stack}\n`); }
  } finally {
    await witness.close().catch(() => undefined);
    // A run that stopped before its restore still owes the device its imported configuration.
    if (restoreImported && restore === undefined) {
      process.stdout.write("  → restore (after a failed run)\n");
      restore = await restoreImported();
    }
    if (ui) await ui.close().catch(() => undefined);
  }
  return { spec: spec.id, channel, seed, ok, startedAt, durationMs: Date.now() - startedAt, provision: spec.provision, capabilities, clickThrough, behaviours, refusals, pid, ipTransport, firmware, persistence, negatives, restore };
}

function report(r: RunResult): void {
  const mark = (s: string) => (s === "pass" ? "✓" : s === "fail" ? "✗" : "·");
  console.log(`\n=== smoke: ${r.spec} [${r.channel}] seed=${r.seed} — ${r.ok ? "PASS" : "FAIL"} ===`);
  for (const c of r.capabilities) console.log(`  ${mark(c.state)} cap ${c.capability} — ${c.detail}`);
  console.log(`  ${mark(r.clickThrough.state)} ui-click-through — ${r.clickThrough.detail}`);
  for (const b of r.behaviours) console.log(`  ${mark(b.state)} behaviour ${b.kind}:${b.label} — ${b.detail}`);
  if (r.persistence) console.log(`  ${mark(r.persistence.state)} persistence — ${r.persistence.detail}`);
  for (const g of r.refusals) console.log(`  ${mark(g.state)} guard ${g.capability} — ${g.detail}`);
  for (const n of r.negatives ?? []) console.log(`  ${mark(n.state)} secure ${n.name} — ${n.detail}`);
  if (r.restore) console.log(`  ${mark(r.restore.state)} restore — ${r.restore.detail}`);
  if (!r.ok && r.pid) console.log(`  kept project ${r.pid} for post-mortem`);
}

function writeReport(r: RunResult, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const iso = new Date(r.startedAt).toISOString();
  const path = join(dir, `${r.spec}-${r.channel}-${iso.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify({ ...r, keptProjectId: r.ok ? null : r.pid, startedAt: iso }, null, 2) + "\n");
  return path;
}

// The evidence records of a run (docs/evidence-contract.md), next to its report and pointing at it
// by path and hash.
async function writeEvidence(r: RunResult, spec: DeviceSpec, reportPath: string, server: { version: string; commit: string }): Promise<string> {
  const records = runEvidence(r, spec, {
    server, runnerRevision: gitRevision(),
    transport: transportOf(r.ipTransport ?? undefined, process.env.BUSFORGE_BENCH_VIA),
    firmware: r.firmware,
    source: { artifact: reportPath, sha256: sha256(new Uint8Array(await Bun.file(reportPath).arrayBuffer())) },
  });
  const path = reportPath.replace(/\.json$/, ".evidence.json");
  writeFileSync(path, JSON.stringify(records, null, 2) + "\n");
  return path;
}

async function main() {
  const args = process.argv.slice(2);
  const channelArg = args.find((a) => a.startsWith("--channel="))?.split("=")[1];
  const channel: Channel = channelArg === "ui" ? "ui" : "api";
  const seedArg = args.find((a) => a.startsWith("--seed="))?.split("=")[1];
  const seed = (seedArg ? Number(seedArg) : Date.now()) >>> 0;
  const reportArg = args.find((a) => a === "--report" || a.startsWith("--report="));
  const reportDir = reportArg ? (reportArg.includes("=") ? reportArg.slice(reportArg.indexOf("=") + 1) : join(import.meta.dir, "reports")) : null;
  const ids = args.filter((a) => !a.startsWith("--"));
  const chosen = ids.length ? SPECS.filter((s) => ids.includes(s.id)) : SPECS;
  if (!chosen.length) { console.error(`no spec matched ${ids.join(",")}; known: ${SPECS.map((s) => s.id).join(", ")}`); process.exit(2); }
  let allOk = true;
  // Read before any run: the build that executes the runs, not whatever is up once they are over.
  // Without it no run's evidence could name its build, so the bench is not touched at all.
  const server = reportDir ? await new Client().version().catch(() => null) : null;
  if (reportDir && !server) { console.error("refused: the server's /api/version is not readable, so the run's evidence could not name the build"); process.exit(2); }
  for (const spec of chosen) {
    if (spec.channels && !spec.channels.includes(channel)) { console.log(`\n=== smoke: ${spec.id} [${channel}] — SKIP (spec channels: ${spec.channels.join(",")}) ===`); continue; }
    const r = await runSpec(spec, channel, seed);
    report(r);
    if (reportDir) {
      try {
        const reportPath = writeReport(r, reportDir);
        console.log(`  report: ${reportPath}`);
        console.log(`  evidence: ${await writeEvidence(r, spec, reportPath, server!)}`);
      } catch (e) { console.error(`  report/evidence: could not be written (${e instanceof Error ? e.message : String(e)})`); allOk = false; }
    }
    allOk &&= r.ok;
  }
  process.exit(allOk ? 0 : 1);
}
await main();
