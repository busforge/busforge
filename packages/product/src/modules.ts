import { moduleInstanceArgLookup, type AppConfig, type DynNode, type ModuleInstance, type ParamArgLookup } from "./appconfig.ts";
import {
  buildRefsOfParam,
  emptyPlacement,
  recordPlacedRef,
  repeatCountOf,
  resolveParamValue,
  samePlacement,
  selectChooseWhens,
  unsettledDefaultRefusal,
  type ChooseContext,
  type ChoosePlacement,
} from "./choose.ts";
import { ProductError } from "./errors.ts";

// Re-run a device's module allocators to produce the same ModuleInstance set that ETS
// pins into a project 0.xml. This is the FROM-SCRATCH path: when there is no imported
// project, we cannot read the resolved per-instance base offsets, so we recompute them
// exactly as ETS does at compile time.
//
// The output is byte-for-byte the shape parse.ts extracts from 0.xml (app-prefix
// stripped ids and arg refs), so the two are interchangeable: an imported device reads
// its instances from 0.xml, a from-scratch device gets them from here, and everything
// downstream (config view, image build, flash) is identical. That interchangeability is
// also the validation oracle: resolveModuleInstances(app, <0.xml values>) must equal the
// 0.xml's own ModuleInstances, asserted in the test suite against the real corpus.
//
// How allocation works: each allocator is a counter starting at its `start`. Walking the
// active (visibility-resolved) dynamic tree in document order, every module instance that
// binds an argument to an allocator takes the current counter and advances it by that
// argument's `allocates`. A `<Repeat Count="k">` replays its body k times, so a six-channel
// block yields six instances at start, start+allocates, ... A `choose` descends only into
// the matching branch(es), sharing choose.ts's selectChooseWhens and resolveParamValue with
// config.ts so the allocator and the configuration walk cannot diverge on branch selection,
// Merker placement, sibling defaults, skipped tests, or unsettled default branches. Where no
// ETS download decides a default branch, the instances are allocated with it taken and without,
// and refused (CHOOSE_DEFAULT_UNSETTLED) where the two differ.
export function resolveModuleInstances(app: AppConfig, env: Map<string, string>): ModuleInstance[] {
  const refsOfParam = buildRefsOfParam(app);
  const settled = (takeOpen: boolean) => {
    let placement = emptyPlacement();
    const seen: ChoosePlacement[] = [];
    const everOpen = new Set<string>();
    for (let pass = 0; ; pass++) {
      const run = allocate(app, env, refsOfParam, placement, takeOpen);
      for (const id of run.open) everOpen.add(id);
      if (samePlacement(run.placement, placement)) {
        if (run.unresolvedArgError) throw run.unresolvedArgError;
        return { ...run, open: run.open.size ? run.open : everOpen };
      }
      if (pass >= 50 || seen.some((p) => samePlacement(p, run.placement))) {
        throw new ProductError("CONFIG_NOT_RESOLVABLE", "the application's parameter visibility does not settle while its module instances are allocated");
      }
      seen.push(placement);
      placement = run.placement;
    }
  };
  const taken = settled(true);
  if (!taken.open.size) return taken.out;
  if (JSON.stringify(settled(false).out) !== JSON.stringify(taken.out)) throw unsettledDefaultRefusal([...taken.open]);
  return taken.out;
}

// One allocation walk over the placement `before` found. `open`: the chooses whose default branch it took or left
// by `takeOpen` alone.
function allocate(
  app: AppConfig,
  env: Map<string, string>,
  refsOfParam: Map<string, string[]>,
  before: ChoosePlacement,
  takeOpen: boolean,
): { out: ModuleInstance[]; placement: ChoosePlacement; open: Set<string>; unresolvedArgError?: ProductError } {
  const alloc = new Map<string, number>();
  for (const a of app.allocators.values()) alloc.set(a.id, a.start);
  const out: ModuleInstance[] = [];
  const nextPlacement = emptyPlacement();
  const miCount = new Map<string, number>(); // module-node id -> instances seen so far (for MI-n)
  const workEnv = new Map(env);
  let unresolvedArgError: ProductError | undefined;
  const chooseCtx: ChooseContext = {
    app,
    refsOfParam,
    placement: before,
    takeOpenDefaults: takeOpen,
    unsettled: new Set(),
  };

  const strip = (id: string) => (id.startsWith(`${app.id}_`) ? id.slice(app.id.length + 1) : id);

  const walk = (nodes: DynNode[], rewrite: (s: string) => string, paramArgValue?: ParamArgLookup) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "block":
          if (n.paramRefId) nextPlacement.heads.add(rewrite(n.paramRefId));
          walk(n.children, rewrite, paramArgValue);
          break;
        case "container": {
          const count = repeatCountOf(n);
          if (count !== undefined) for (let i = 0; i < count; i++) walk(n.children, rewrite, paramArgValue);
          else walk(n.children, rewrite, paramArgValue);
          break;
        }
        case "choose": {
          let whens;
          try {
            whens = selectChooseWhens(chooseCtx, n.paramRefId, n.whens, rewrite, workEnv, paramArgValue);
          } catch (e) {
            // Defer MODULE_ARG_UNRESOLVED until placement settles so a provisional pass-0 branch
            // (before a Merker's placement is known) does not abort a valid config.
            if (e instanceof ProductError && e.code === "MODULE_ARG_UNRESOLVED") { unresolvedArgError ??= e; break; }
            throw e;
          }
          for (const w of whens) walk(w.children, rewrite, paramArgValue);
          break;
        }
        case "module": {
          const def = app.moduleDefs.get(n.refId);
          if (!def) break;
          const k = (miCount.get(n.id) ?? 0) + 1;
          miCount.set(n.id, k);
          const instId = `${strip(n.id)}_MI-${k}`; // e.g. MD-7_M-19_MI-1
          const args: { refId: string; value: string }[] = [];
          for (const na of n.numArgs) {
            let val: string | undefined;
            if (na.value !== undefined) {
              val = na.value; // a literal binding (e.g. a fixed object base)
            } else if (na.allocatorRefId !== undefined) {
              const cur = alloc.get(na.allocatorRefId);
              // An arg bound to an undeclared allocator means the whole allocation chain
              // (this instance AND every later one) is unknowable. Silently omitting the
              // arg used to make downstream placement fall back to base offset 0, i.e.
              // channel-1 memory. Refuse once placement has settled so a provisional pass-0
              // branch (before a Merker's placement is known) does not abort a valid config.
              if (cur === undefined) {
                unresolvedArgError ??= new ProductError("MODULE_ARG_UNRESOLVED",
                  `module instance ${instId}: argument ${strip(na.argId)} is bound to allocator ${strip(na.allocatorRefId)}, which the application does not declare; cannot place this module's memory`);
              } else {
                val = String(cur);
                const allocates = def.args.find((d) => d.id === na.argId)?.allocates ?? 0;
                alloc.set(na.allocatorRefId, cur + allocates);
              }
            }
            if (val !== undefined) args.push({ refId: strip(na.argId), value: val });
          }
          for (const ta of n.textArgs) args.push({ refId: strip(ta.argId), value: ta.value });
          const inst: ModuleInstance = { id: instId, refId: strip(n.id), args };
          out.push(inst);
          // Descend into the module's own dynamic so nested modules allocate in order and
          // module-internal choose branches resolve against this instance's values and BaseValue args.
          const instFull = `${app.id}_${instId}`;
          const childRewrite = (id: string) => rewrite(id.startsWith(`${n.refId}_`) ? instFull + id.slice(n.refId.length) : id);
          walk(def.dynamic, childRewrite, moduleInstanceArgLookup(app, inst));
          break;
        }
        // Leaves. ParameterRefRef records placement for selectChooseWhens and resolveParamValue;
        // Assign updates workEnv so later chooses see assigned targets. Listed rather than left to
        // a `default`, so a node kind added later cannot be skipped silently here.
        case "paramRef":
          recordPlacedRef(app, nextPlacement, n.refId, rewrite);
          break;
        case "assign":
          try {
            workEnv.set(rewrite(n.target), n.value ?? (n.source ? resolveParamValue(chooseCtx, n.source, rewrite, workEnv, paramArgValue) ?? "" : ""));
          } catch (e) {
            if (e instanceof ProductError && e.code === "MODULE_ARG_UNRESOLVED") { unresolvedArgError ??= e; break; }
            throw e;
          }
          break;
        case "comObjRef": case "separator": case "button": case "unsupported":
          break;
      }
    }
  };
  walk(app.dynamic, (s) => s);
  return { out, placement: nextPlacement, open: chooseCtx.unsettled, unresolvedArgError };
}
