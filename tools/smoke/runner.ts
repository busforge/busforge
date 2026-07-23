// The capability/behaviour smoke runner. It knows the lifecycle (provision, configure, teardown) and
// NOTHING about any device: what a device can do is read from the product at run time
// (config.capabilities), and the runner exercises exactly those capabilities in the requested
// channel, then proves the device's declared behaviours on the bus. A capability the product claims
// but the run never exercises is a HARD failure, never a skip. Everything device-specific lives in a
// DeviceSpec (specs/). See docs/smoke-framework-redesign.md and /CONTEXT.md.
//
// One channel per invocation (--channel=api|ui, default api); the bench done-bar wants BOTH green, so
// a device is run once per channel and each report recorded. Assertions always read the API; in the
// ui channel the browser is driven, never asked to confirm itself.
//
// Hardware-gated: refuses to run without BUSFORGE_BENCH=1 and a reachable bench bridge. Never part of
// `bun run check`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, ApiError, allParams, allComObjects, type DeviceCapabilities } from "./client.ts";
import { Witness } from "./witness.ts";
import { UiDriver } from "./ui.ts";
import { makePrng, gaAllocator } from "./generate.ts";
import { CAP_DRIVERS, type CapabilityResult, type CapCtx } from "./capabilities.ts";
import { verifyBehaviour, type BehaviourResult, type BehaviourCtx } from "./behaviours.ts";
import { linkChan, type ChanCtx } from "./channel.ts";
import type { Channel, DeviceSpec } from "./spec.ts";
import { SPECS } from "./specs/index.ts";

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
  const witness = new Witness();
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
  let ok = true;

  try {
    // ── preflight ──────────────────────────────────────────────────────────
    if (process.env.BUSFORGE_BENCH !== "1") throw new Stop("preflight", "refused: no bench (set BUSFORGE_BENCH=1)");
    const products = await client.catalogProducts().catch((e) => { throw new Stop("preflight", `server unreachable: ${e instanceof Error ? e.message : String(e)}`); });
    if (!products.some((p) => p.appRef === spec.device.appRef && p.productRef === spec.device.productRef)) throw new Stop("preflight", `product not in catalog (${spec.device.appRef}); import the .knxprod first`);
    try { await witness.connect(); await witness.close(); } catch (e) { throw new Stop("preflight", `bench bridge unreachable: ${e instanceof Error ? e.message : String(e)}`); }

    // ── setup + place (API plumbing) ─────────────────────────────────────────
    const conns = await client.connections();
    const benchHost = process.env.BUSFORGE_BENCH_HOST ?? "198.51.100.231";
    const conn = conns.find((c) => c.type === "ip" && c.host === benchHost);
    if (!conn) throw new Stop("setup", `no saved IP connection for the bench host ${benchHost}`);
    const proj = await client.createProject(`smoke-${spec.id}-${channel}-${startedAt}`);
    pid = proj.id;
    await client.attachConnection(pid, conn.id);
    const dev = await client.placeDevice(pid, spec.device.appRef, spec.device.productRef, `smoke ${spec.id}`);
    did = dev.id;
    await client.setAddress(pid, did, spec.device.ia);
    if (ui) { try { await ui.launch(); await ui.gotoDevice(pid, did); } catch (e) { throw new Stop("setup", `UI unavailable (is \`bun run dev:web\` up?): ${e instanceof Error ? e.message : String(e)}`); } }

    const chan: ChanCtx = { client, ui, pid, did, channel, log, settle };
    const capCtx: CapCtx = { ...chan, spec, rnd, allocGa };

    // ── provision ────────────────────────────────────────────────────────────
    if (spec.precondition) process.stdout.write(`  ! precondition: ${spec.precondition}\n`);
    if (spec.provision === "skip-if-present") {
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

    // ── ui-click-through (lifecycle capability, UI surface only) ──────────────
    if (ui) {
      process.stdout.write("  → ui-click-through\n");
      const view = await client.getConfig(pid, did);
      try { await ui.clickThrough(allParams(view).map((p) => p.refId), allComObjects(view).map((c) => c.number)); clickThrough = { state: "pass", detail: `${allParams(view).length} params, ${allComObjects(view).length} objects rendered` }; }
      catch (e) { clickThrough = { state: "fail", detail: e instanceof Error ? e.message : String(e) }; ok = false; }
    }

    // ── behaviours: prove the device ACTS on the bus ──────────────────────────
    const behCtx: BehaviourCtx = { ...chan, witness, spec, allocGa };
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

    // ── teardown (only a clean run tidies up; a failure keeps the project) ─────
    if (ok) { await client.deleteProject(pid); pid = null; }
  } catch (e) {
    ok = false;
    if (e instanceof Stop) capabilities.push({ capability: e.phase, channel, state: "fail", detail: e.detail });
    else { capabilities.push({ capability: "?", channel, state: "fail", detail: e instanceof Error ? e.message : String(e) }); if (e instanceof Error && e.stack) process.stderr.write(`\n[unlabeled failure stack]\n${e.stack}\n`); }
  } finally {
    await witness.close().catch(() => undefined);
    if (ui) await ui.close().catch(() => undefined);
  }
  return { spec: spec.id, channel, seed, ok, startedAt, durationMs: Date.now() - startedAt, provision: spec.provision, capabilities, clickThrough, behaviours, refusals, pid };
}

function report(r: RunResult): void {
  const mark = (s: string) => (s === "pass" ? "✓" : s === "fail" ? "✗" : "·");
  console.log(`\n=== smoke: ${r.spec} [${r.channel}] seed=${r.seed} — ${r.ok ? "PASS" : "FAIL"} ===`);
  for (const c of r.capabilities) console.log(`  ${mark(c.state)} cap ${c.capability} — ${c.detail}`);
  console.log(`  ${mark(r.clickThrough.state)} ui-click-through — ${r.clickThrough.detail}`);
  for (const b of r.behaviours) console.log(`  ${mark(b.state)} behaviour ${b.kind}:${b.label} — ${b.detail}`);
  for (const g of r.refusals) console.log(`  ${mark(g.state)} guard ${g.capability} — ${g.detail}`);
  if (!r.ok && r.pid) console.log(`  kept project ${r.pid} for post-mortem`);
}

function writeReport(r: RunResult, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const iso = new Date(r.startedAt).toISOString();
  const path = join(dir, `${r.spec}-${r.channel}-${iso.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify({ ...r, keptProjectId: r.ok ? null : r.pid, startedAt: iso }, null, 2) + "\n");
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
  for (const spec of chosen) {
    if (spec.channels && !spec.channels.includes(channel)) { console.log(`\n=== smoke: ${spec.id} [${channel}] — SKIP (spec channels: ${spec.channels.join(",")}) ===`); continue; }
    const r = await runSpec(spec, channel, seed);
    report(r);
    if (reportDir) { try { console.log(`  report: ${writeReport(r, reportDir)}`); } catch (e) { console.error(`  report: could not be written (${e instanceof Error ? e.message : String(e)})`); } }
    allOk &&= r.ok;
  }
  process.exit(allOk ? 0 : 1);
}
await main();
