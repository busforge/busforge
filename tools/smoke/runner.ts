// The generic smoke runner: it knows the lifecycle phases and the verification layers, and
// NOTHING about any device — all device facts come from the recipe. It drives the production API
// (the same endpoints the UI calls) and a witness tunnel for the functional bus drive, and it
// asserts against the server's own honesty contract (FlashResult.verified, the coded refusals).
//
// Two drive channels (docs/e2e-smoke-framework.md §5): by default every step runs through the API;
// with `--ui` the P4 configure steps (parameter edits AND GA links) run through the real web app in
// Chromium (tools/smoke/ui.ts). Every UI step has an API twin, and the assertions always read the
// API: the browser is driven, never asked to confirm itself.
//
// Hardware-gated: refuses to run without BUSFORGE_BENCH=1 and a reachable bench bridge. Never part
// of `bun run check`.
import { gaToNum } from "../../packages/knx/src/index.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, ApiError, findComObject, type ConfigView, type FlashResult } from "./client.ts";
import { Witness } from "./witness.ts";
import { UiDriver } from "./ui.ts";
import type { Recipe } from "./recipe.ts";
import { RECIPES } from "./recipes/index.ts";

type PhaseState = "pass" | "fail" | "skip" | "not-run";
interface PhaseResult { name: string; state: PhaseState; detail?: string; durationMs?: number }
interface LayerResult { layer: string; state: "pass" | "fail" | "not-declared"; detail?: string }
// The structured evidence a docs/next-steps.md claim can cite: the actual FlashResults the run
// obtained, keyed by the step that produced them (dry, commission, and P7's mutate/revert flashes).
type RunResult = { ok: boolean; phases: PhaseResult[]; layers: LayerResult[]; pid: string | null; startedAt: number; durationMs: number; flash: Record<string, FlashResult> };

const gasOf = (view: ConfigView): number[] => {
  const out: number[] = [];
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") { const g = (it as { comObject: { gaRaw: number | null } }).comObject.gaRaw; if (g !== null) out.push(g); }
  return out;
};
const paramVal = (view: ConfigView, refId: string): string | undefined => {
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param" && (it as { param: { refId: string } }).param.refId === refId) return (it as { param: { value: string } }).param.value;
  return undefined;
};

class Stop extends Error { constructor(readonly phase: string, readonly detail: string) { super(detail); } }

async function runRecipe(recipe: Recipe, useUi: boolean): Promise<RunResult> {
  const client = new Client();
  const witness = new Witness();
  // The UI drive channel (Playwright against the real web app). When on, the parameter edits in
  // P4 go through the browser instead of the API; every other step keeps its API path (the design's
  // UI-vs-API policy, §5: assertions always read the API, the source of truth the UI renders).
  const ui = useUi ? new UiDriver() : null;
  const phases: PhaseResult[] = [];
  const layers: LayerResult[] = [];
  const flash: Record<string, FlashResult> = {};
  const startedAt = Date.now();
  let lastAt = startedAt; // phase-boundary clock: each recorded phase carries the time since the last
  const stamp = (): number => { const now = Date.now(); const d = now - lastAt; lastAt = now; return d; };
  const pass = (name: string, detail?: string) => phases.push({ name, state: "pass", detail, durationMs: stamp() });
  const skip = (name: string, detail: string) => phases.push({ name, state: "skip", detail, durationMs: stamp() });
  let pid: string | null = null;
  let did: string | null = null;
  let ok = true;
  // A small settle between bus ops. This used to be load-bearing for the wrong reason: back-to-back
  // ops tripped a bridge bug where a just-closed channel's dying send queue dropped the SUCCESSOR
  // that reused its id (fixed in packages/knx/src/ipserver.ts — identity-checked drop). It is kept
  // as a courtesy to the single-channel bench interface, no longer a workaround.
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // A transient bench-bridge TRANSPORT glitch (a dropped tunnel channel) is worth retrying; a
  // coded product refusal (FLASH_UNVERIFIED, LOAD_PROC_CHECK_FAILED, GA_TABLE_TOO_LARGE, …) is a
  // REAL result and must never be retried away, that is the regression the harness exists to catch.
  // "abort" is deliberately NOT here: on the OpenKNX bench that was a client-timeout abort of a 4 min
  // read, and retrying just fired another doomed 4 min read. The read-back's own task poll (client.ts)
  // is the right fix for that, not a retry.
  const transient = (e: unknown): boolean => {
    const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    return m.includes("tunnel") || m.includes("acknowledg") || m.includes("econnreset") || m.includes("socket hang");
  };
  const withRetry = async <T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (attempt >= tries || !transient(e)) {
          process.stdout.write(`    …${label}: FAILED (attempt ${attempt}/${tries}, ${transient(e) ? "transient but out of tries" : "not transient"}): ${e instanceof Error ? e.message : String(e)}\n`);
          throw e;
        }
        process.stdout.write(`    …${label}: transient bus glitch (${e instanceof Error ? e.message : String(e)}); settle + retry ${attempt}/${tries - 1}\n`);
        await settle(6000);
      }
    }
  };

  try {
    // ── P0 preflight ─────────────────────────────────────────────────────────
    if (process.env.BUSFORGE_BENCH !== "1") throw new Stop("P0", "refused: no bench (set BUSFORGE_BENCH=1)");
    const products = await client.catalogProducts().catch((e) => { throw new Stop("P0", `server unreachable: ${e instanceof Error ? e.message : String(e)}`); });
    if (!products.some((p) => p.appRef === recipe.device.appRef && p.productRef === recipe.device.productRef)) {
      throw new Stop("P0", `product not in catalog (${recipe.device.appRef}); import the .knxprod first`);
    }
    try { await witness.connect(); await witness.close(); } catch (e) { throw new Stop("P0", `bench bridge unreachable: ${e instanceof Error ? e.message : String(e)}`); }
    pass("P0 preflight", `product present, bridge reachable`);

    // ── P1 setup ─────────────────────────────────────────────────────────────
    const conns = await client.connections();
    const benchHost = process.env.BUSFORGE_BENCH_HOST ?? "198.51.100.231";
    const conn = conns.find((c) => c.type === "ip" && c.host === benchHost);
    if (!conn) throw new Stop("P1", `no saved IP connection for the bench host ${benchHost}`);
    const proj = await client.createProject(`smoke-${recipe.id}-${Date.now()}`);
    pid = proj.id;
    await client.attachConnection(pid, conn.id);
    // UI mode links a com-object by selecting a PROJECT group address in the picker, so those group
    // addresses must exist before the browser loads the page. (Harmless for the API path too.)
    if (ui) for (const step of recipe.configure) if ("link" in step) await client.ensureGa(pid, step.link.ga);
    pass("P1 setup", `project ${pid.slice(0, 8)}, connection ${conn.host}${ui ? ", GAs created" : ""}`);

    // ── P2 place ─────────────────────────────────────────────────────────────
    const dev = await client.placeDevice(pid, recipe.device.appRef, recipe.device.productRef, `smoke ${recipe.id}`);
    did = dev.id;
    await client.setAddress(pid, did, recipe.device.ia);
    pass("P2 place", `${recipe.device.ia}`);
    if (ui) {
      try { await ui.launch(); await ui.gotoDevice(pid, did); }
      catch (e) { throw new Stop("P2", `UI unavailable (is \`bun run dev:web\` up?): ${e instanceof Error ? e.message : String(e)}`); }
    }

    // ── P3 provision ─────────────────────────────────────────────────────────
    if (recipe.precondition) skip("P3 precondition", recipe.precondition);
    if (recipe.provision === "skip-if-present") {
      // A read-back reaches the device connection-oriented; success proves it answers on its IA.
      try { await withRetry("readback", () => client.readBack(pid!, did!)); pass("P3 provision", "device present, assign-ia skipped"); }
      catch (e) { throw new Stop("P3", `device does not answer on ${recipe.device.ia} (${e instanceof ApiError ? e.code : String(e)}); a from-virgin run needs provision:"require-prog-mode"`); }
    } else {
      const scan = await client.progMode(pid);
      if (scan.devices.length !== 1) throw new Stop("P3", `expected exactly one device in programming mode, saw ${scan.devices.length} (press the button on ${recipe.id})`);
      const r = await client.assignIa(pid, did);
      if (!r.verified) throw new Stop("P3", `assign-ia did not verify (previous ${r.previous})`);
      pass("P3 provision", `assign-ia ${r.previous} -> ${r.assigned}, progModeCleared=${r.progModeCleared}`);
    }

    // ── P4 configure (params first, they reveal com-objects; then links) ──────
    // Both params and GA links go through the browser when --ui is on: the params drive the dynamic
    // config editors, the links drive the GaCombobox (P1 pre-created the project group addresses so
    // the picker has something to select). Assertions still read the API, the source of truth.
    for (const step of recipe.configure) {
      if ("set" in step) { if (ui) await ui.setParam(step.set.paramRefId, step.set.value); else await client.setParam(pid, did, step.set.paramRefId, step.set.value); }
      else if (ui) {
        // The GA picker is addressed by the com-object NUMBER, which the config resolves from the
        // ref the recipe declares (the object is visible now that its enabling params are set).
        const co = findComObject(await client.getConfig(pid, did), step.link.comObjRefId);
        if (!co) throw new Stop("P4", `com-object ${step.link.comObjRefId} is not visible for the UI link`);
        await ui.linkGa(co.number, step.link.ga);
      } else await client.link(pid, did, step.link.comObjRefId, step.link.ga);
    }
    pass("P4 configure", `${recipe.configure.length} step(s)${ui ? " (via UI)" : ""}`);

    // ── P5 commission ────────────────────────────────────────────────────────
    await settle(3000); // let the P3 read-back's tunnel fully release before the download opens one
    process.stdout.write("  → P5 dry-run\n");
    const dry = await withRetry("dry-run", () => (recipe.commission === "download" ? client.downloadDry(pid!, did!) : client.flashDry(pid!, did!)));
    flash["dry-run"] = dry;
    await settle(3000);
    if (dry.kind !== "dryRun") throw new Stop("P5", `dry-run returned ${dry.kind}, expected dryRun`);
    process.stdout.write(`  → P5 commission (${recipe.commission})\n`);
    const result = await withRetry("commission", () => (recipe.commission === "download"
      ? client.downloadReal(pid!, did!, (p) => process.stdout.write(`    …${p}\n`))
      : client.flashReal(pid!, did!, (p) => process.stdout.write(`    …${p}\n`))), 2);
    flash["commission"] = result;
    // L0: the endpoint's own honesty contract.
    if (result.kind !== "flashed") { layers.push({ layer: "L0 endpoint", state: "fail", detail: `kind=${result.kind}` }); throw new Stop("P5", `commission returned ${result.kind}, expected flashed`); }
    if (result.verified !== true) { layers.push({ layer: "L0 endpoint", state: "fail", detail: "verified=false" }); throw new Stop("P5", "device did not verify the download (verified=false)"); }
    if (recipe.device.mask && result.mask && result.mask !== recipe.device.mask) { layers.push({ layer: "L0 endpoint", state: "fail", detail: `mask ${result.mask}` }); throw new Stop("P5", `mask ${result.mask} != expected ${recipe.device.mask}`); }
    // The stored task outcome does not always carry imageBytes; the dry-run's is the same image.
    const bytes = result.imageBytes ?? dry.imageBytes ?? "?";
    layers.push({ layer: "L0 endpoint", state: "pass", detail: `flashed verified, ${bytes}B, mask ${result.mask}` });
    pass("P5 commission", `${recipe.commission}, ${bytes}B`);

    // ── P6 verify ────────────────────────────────────────────────────────────
    // L1: an independent read-back re-reads the device and the config view must show the expected
    // GAs on the device's decoded group tables.
    process.stdout.write("  → P6 verify (read-back + bus)\n");
    // The closing A_Restart rebooted the device; give it time to boot its application and re-attach
    // to the bus before the read-back's connection-oriented read starts (the read itself polls its
    // task to completion, so a slow read is fine, but starting it mid-reboot only wastes time).
    await settle(8000);
    await withRetry("readback", () => client.readBack(pid!, did!, (p) => process.stdout.write(`    …read ${p}\n`)));
    await settle(3000);
    const view = await client.getConfig(pid, did);
    const present = new Set(gasOf(view));
    const missing = recipe.verify.readback.expectGas.filter((ga) => !present.has(gaToNum(ga)));
    if (missing.length) { layers.push({ layer: "L1 read-back", state: "fail", detail: `missing GAs ${missing.join(",")}` }); throw new Stop("P6", `read-back missing GAs: ${missing.join(", ")}`); }
    layers.push({ layer: "L1 read-back", state: "pass", detail: `GAs ${recipe.verify.readback.expectGas.join(",")} present` });

    // L2: functional bus drive via the witness (only between API calls; the bus is idle now).
    if (recipe.verify.bus?.length) {
      await witness.connect();
      try {
        for (const chk of recipe.verify.bus) {
          if ("groupRead" in chk) {
            const v = await witness.groupRead(chk.groupRead.ga);
            if (v === null) throw new Stop("P6", `no GroupValueResponse on ${chk.groupRead.ga}`);
            if (chk.groupRead.expectValue && v !== chk.groupRead.expectValue) throw new Stop("P6", `${chk.groupRead.ga} answered 0x${v}, expected 0x${chk.groupRead.expectValue}`);
          } else {
            await witness.groupWrite(chk.groupWrite.ga, chk.groupWrite.value);
            if (chk.readBack) {
              await new Promise((r) => setTimeout(r, 500));
              const v = await witness.groupRead(chk.readBack.ga);
              if (v !== chk.readBack.expectValue) throw new Stop("P6", `${chk.readBack.ga} read 0x${v ?? "none"}, expected 0x${chk.readBack.expectValue}`);
            }
          }
        }
      } finally { await witness.close(); }
      layers.push({ layer: "L2 bus drive", state: "pass", detail: `${recipe.verify.bus.length} check(s)` });
    } else layers.push({ layer: "L2 bus drive", state: "not-declared" });
    layers.push({ layer: "L3 camera", state: "not-declared" });
    pass("P6 verify", "L0+L1" + (recipe.verify.bus?.length ? "+L2" : ""));

    // ── P7 mutate + revert (the write-path proof, run every time) ─────────────
    // Change one parameter, flash it (a surgical param flash, not a full download), require the
    // device's own read-back to verify it, then flash it back to the canonical value and require
    // that to verify too. This is the change+restore pattern every manual bench session used, made
    // mechanical, and it is what exercises the write path on a device that already holds its config.
    if (recipe.mutation) {
      process.stdout.write("  → P7 mutate + revert\n");
      const { paramRefId, value: to } = recipe.mutation;
      const canonical = paramVal(await client.getConfig(pid, did), paramRefId);
      if (canonical === undefined) throw new Stop("P7", `mutation parameter ${paramRefId} is not on this device`);
      if (canonical === to) throw new Stop("P7", `mutation value ${to} equals the canonical value; pick a different one`);
      const flashOnce = async (label: string) => {
        await settle(3000);
        const r = await withRetry(label, () => client.flashReal(pid!, did!, (p) => process.stdout.write(`    …${p}\n`)), 2);
        flash[label] = r;
        if (r.kind !== "flashed" || r.verified !== true) throw new Stop("P7", `${label} not verified (${r.kind}, verified=${r.verified})`);
      };
      await client.setParam(pid, did, paramRefId, to); await flashOnce("mutate");
      await client.setParam(pid, did, paramRefId, canonical); await flashOnce("revert");
      pass("P7 mutate+revert", `${paramRefId.split("_").pop()} ${canonical}→${to}→${canonical}, both verified`);
    } else skip("P7 mutate+revert", "no mutation declared");

    // ── P8 teardown ───────────────────────────────────────────────────────────
    await client.deleteProject(pid); pid = null;
    pass("P8 teardown", "throwaway project deleted");
  } catch (e) {
    ok = false;
    if (e instanceof Stop) phases.push({ name: e.phase, state: "fail", detail: e.detail, durationMs: stamp() });
    else {
      phases.push({ name: "?", state: "fail", detail: e instanceof Error ? e.message : String(e), durationMs: stamp() });
      if (e instanceof Error && e.stack) process.stderr.write(`\n[unlabeled failure stack]\n${e.stack}\n`);
    }
  } finally {
    await witness.close().catch(() => undefined);
    if (ui) await ui.close().catch(() => undefined);
  }
  return { ok, phases, layers, pid, startedAt, durationMs: Date.now() - startedAt, flash };
}

function report(recipe: Recipe, r: Awaited<ReturnType<typeof runRecipe>>): void {
  const mark = (s: PhaseState) => (s === "pass" ? "✓" : s === "fail" ? "✗" : s === "skip" ? "skip" : "·");
  console.log(`\n=== smoke: ${recipe.id} — ${r.ok ? "PASS" : "FAIL"} ===`);
  for (const p of r.phases) console.log(`  ${mark(p.state)} ${p.name}${p.detail ? ` — ${p.detail}` : ""}`);
  console.log("  layers: " + (r.layers.length ? r.layers.map((l) => `${l.layer}=${l.state === "pass" ? "✓" : l.state === "fail" ? "✗" : "—"}`).join("  ") : "(none)"));
  if (!r.ok && r.pid) console.log(`  kept project ${r.pid} for post-mortem`);
}

// One run, one JSON artifact: the machine-readable evidence a docs/next-steps.md claim can cite
// (the FlashResults, the per-phase durations, the layer verdicts). Written only with --report; the
// terminal summary is always printed. Returns the path so the caller can point at it.
function writeReport(recipe: Recipe, r: RunResult, dir: string, useUi: boolean): string {
  mkdirSync(dir, { recursive: true });
  const iso = new Date(r.startedAt).toISOString();
  const path = join(dir, `${recipe.id}-${iso.replace(/[:.]/g, "-")}.json`);
  const artifact = {
    recipe: recipe.id,
    device: { ia: recipe.device.ia, mask: recipe.device.mask, appRef: recipe.device.appRef },
    channel: useUi ? "ui" : "api",
    startedAt: iso,
    durationMs: r.durationMs,
    ok: r.ok,
    phases: r.phases,
    layers: r.layers,
    flash: r.flash, // FlashResults keyed by step: dry-run, commission, and P7's mutate/revert
    keptProjectId: r.ok ? null : r.pid, // a failed run keeps its project for post-mortem
  };
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n");
  return path;
}

async function main() {
  const args = process.argv.slice(2);
  const useUi = args.includes("--ui"); // drive the parameter edits through the real web app (needs dev:web)
  // --report writes a JSON artifact per recipe; --report=<dir> overrides the default location.
  const reportArg = args.find((a) => a === "--report" || a.startsWith("--report="));
  const reportDir = reportArg ? (reportArg.includes("=") ? reportArg.slice(reportArg.indexOf("=") + 1) : join(import.meta.dir, "reports")) : null;
  const ids = args.filter((a) => !a.startsWith("--"));
  const chosen = ids.length ? RECIPES.filter((r) => ids.includes(r.id)) : RECIPES;
  if (!chosen.length) { console.error(`no recipe matched ${ids.join(",")}; known: ${RECIPES.map((r) => r.id).join(", ")}`); process.exit(2); }
  let allOk = true;
  for (const recipe of chosen) {
    const r = await runRecipe(recipe, useUi);
    report(recipe, r);
    // The artifact is a side effect: a failure to write it must not eat the run's real verdict
    // (already printed) nor skip the remaining recipes. Fail loud, keep going.
    if (reportDir) {
      try { console.log(`  report: ${writeReport(recipe, r, reportDir, useUi)}`); }
      catch (e) { console.error(`  report: could not be written (${e instanceof Error ? e.message : String(e)})`); }
    }
    allOk &&= r.ok;
  }
  process.exit(allOk ? 0 : 1);
}
await main();
