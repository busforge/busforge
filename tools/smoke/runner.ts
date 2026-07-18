// The generic smoke runner: it knows the lifecycle phases and the verification layers, and
// NOTHING about any device — all device facts come from the recipe. It drives the production API
// (the same endpoints the UI calls) and a witness tunnel for the functional bus drive, and it
// asserts against the server's own honesty contract (FlashResult.verified, the coded refusals).
//
// This is the API-driven core (docs/e2e-smoke-framework.md, `--api-only`). The UI-driven variant
// (playwright-cli against apps/web, needing the DeviceConfig test hooks) is the documented next
// layer; every step here already has its API twin, which is what that layer would assert through.
//
// Hardware-gated: refuses to run without BUSFORGE_BENCH=1 and a reachable bench bridge. Never part
// of `bun run check`.
import { gaToNum } from "../../packages/knx/src/index.ts";
import { Client, ApiError, type ConfigView } from "./client.ts";
import { Witness } from "./witness.ts";
import type { Recipe } from "./recipe.ts";
import { RECIPES } from "./recipes/index.ts";

type PhaseState = "pass" | "fail" | "skip" | "not-run";
interface PhaseResult { name: string; state: PhaseState; detail?: string }
interface LayerResult { layer: string; state: "pass" | "fail" | "not-declared"; detail?: string }

const gasOf = (view: ConfigView): number[] => {
  const out: number[] = [];
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "comObject") { const g = (it as { comObject: { gaRaw: number | null } }).comObject.gaRaw; if (g !== null) out.push(g); }
  return out;
};

class Stop extends Error { constructor(readonly phase: string, readonly detail: string) { super(detail); } }

async function runRecipe(recipe: Recipe): Promise<{ ok: boolean; phases: PhaseResult[]; layers: LayerResult[]; pid: string | null }> {
  const client = new Client();
  const witness = new Witness();
  const phases: PhaseResult[] = [];
  const layers: LayerResult[] = [];
  const pass = (name: string, detail?: string) => phases.push({ name, state: "pass", detail });
  const skip = (name: string, detail: string) => phases.push({ name, state: "skip", detail });
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
  // REAL result and must never be retried away — that is the regression the harness exists to catch.
  const transient = (e: unknown): boolean => {
    const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    return m.includes("tunnel") || m.includes("acknowledg") || m.includes("econnreset") || m.includes("socket hang");
  };
  const withRetry = async <T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (e) {
        if (attempt >= tries || !transient(e)) throw e;
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
    pass("P1 setup", `project ${pid.slice(0, 8)}, connection ${conn.host}`);

    // ── P2 place ─────────────────────────────────────────────────────────────
    const dev = await client.placeDevice(pid, recipe.device.appRef, recipe.device.productRef, `smoke ${recipe.id}`);
    did = dev.id;
    await client.setAddress(pid, did, recipe.device.ia);
    pass("P2 place", `${recipe.device.ia}`);

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
    for (const step of recipe.configure) {
      if ("set" in step) await client.setParam(pid, did, step.set.paramRefId, step.set.value);
      else await client.link(pid, did, step.link.comObjRefId, step.link.ga);
    }
    pass("P4 configure", `${recipe.configure.length} step(s)`);

    // ── P5 commission ────────────────────────────────────────────────────────
    await settle(3000); // let the P3 read-back's tunnel fully release before the download opens one
    const dry = await withRetry("dry-run", () => (recipe.commission === "download" ? client.downloadDry(pid!, did!) : client.flashDry(pid!, did!)));
    await settle(3000);
    if (dry.kind !== "dryRun") throw new Stop("P5", `dry-run returned ${dry.kind}, expected dryRun`);
    const result = await withRetry("commission", () => (recipe.commission === "download"
      ? client.downloadReal(pid!, did!, (p) => process.stdout.write(`    …${p}\n`))
      : client.flashReal(pid!, did!, (p) => process.stdout.write(`    …${p}\n`))), 2);
    // L0: the endpoint's own honesty contract.
    if (result.kind !== "flashed") { layers.push({ layer: "L0 endpoint", state: "fail", detail: `kind=${result.kind}` }); throw new Stop("P5", `commission returned ${result.kind}, expected flashed`); }
    if (result.verified !== true) { layers.push({ layer: "L0 endpoint", state: "fail", detail: "verified=false" }); throw new Stop("P5", "device did not verify the download (verified=false)"); }
    if (recipe.device.mask && result.mask && result.mask !== recipe.device.mask) { layers.push({ layer: "L0 endpoint", state: "fail", detail: `mask ${result.mask}` }); throw new Stop("P5", `mask ${result.mask} != expected ${recipe.device.mask}`); }
    layers.push({ layer: "L0 endpoint", state: "pass", detail: `flashed verified, ${result.imageBytes}B, mask ${result.mask}` });
    pass("P5 commission", `${recipe.commission}, ${result.imageBytes}B`);

    // ── P6 verify ────────────────────────────────────────────────────────────
    // L1: an independent read-back re-reads the device and the config view must show the expected
    // GAs on the device's decoded group tables.
    await settle(3000); // the download closed its tunnel after the restart; let the bridge release it
    await withRetry("readback", () => client.readBack(pid!, did!));
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

    // ── P8 teardown (P7 mutate+revert is a documented follow-up) ──────────────
    await client.deleteProject(pid); pid = null;
    pass("P8 teardown", "throwaway project deleted");
  } catch (e) {
    ok = false;
    if (e instanceof Stop) phases.push({ name: e.phase, state: "fail", detail: e.detail });
    else phases.push({ name: "?", state: "fail", detail: e instanceof Error ? e.message : String(e) });
  } finally {
    await witness.close().catch(() => undefined);
  }
  return { ok, phases, layers, pid };
}

function report(recipe: Recipe, r: Awaited<ReturnType<typeof runRecipe>>): void {
  const mark = (s: PhaseState) => (s === "pass" ? "✓" : s === "fail" ? "✗" : s === "skip" ? "skip" : "·");
  console.log(`\n=== smoke: ${recipe.id} — ${r.ok ? "PASS" : "FAIL"} ===`);
  for (const p of r.phases) console.log(`  ${mark(p.state)} ${p.name}${p.detail ? ` — ${p.detail}` : ""}`);
  console.log("  layers: " + (r.layers.length ? r.layers.map((l) => `${l.layer}=${l.state === "pass" ? "✓" : l.state === "fail" ? "✗" : "—"}`).join("  ") : "(none)"));
  if (!r.ok && r.pid) console.log(`  kept project ${r.pid} for post-mortem`);
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const chosen = ids.length ? RECIPES.filter((r) => ids.includes(r.id)) : RECIPES;
  if (!chosen.length) { console.error(`no recipe matched ${ids.join(",")}; known: ${RECIPES.map((r) => r.id).join(", ")}`); process.exit(2); }
  let allOk = true;
  for (const recipe of chosen) {
    const r = await runRecipe(recipe);
    report(recipe, r);
    allOk &&= r.ok;
  }
  process.exit(allOk ? 0 : 1);
}
await main();
