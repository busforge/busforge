import type { AppConfig, DynNode, DynWhen, ModuleInstance } from "./appconfig.ts";
import { chooseSkipsTests, defaultBranchOf, matchTest, unsettledDefaultRefusal, validateTest } from "./config.ts";
import { ProductError } from "./errors.ts";

// A module argument's value as a number where it is used as one (a memory base offset, a com-object
// base number): a decimal integer, else NaN, which every caller refuses. Number() alone would read
// "" as 0 and "1.5" as 1.5, and place the module there.
export const moduleArgNumber = (value: string): number => (/^-?\d+$/.test(value) ? Number(value) : NaN);

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
// the matching branch, so inactive device variants neither render nor allocate. Its default branch is taken
// where the configuration takes it (config.ts defaultBranchOf), with the refs placed by reached ParameterRefRefs
// and the refs heading reached blocks found by walking until they settle. Where no ETS download decides a default
// branch, the instances are allocated with it taken and without, and refused (CHOOSE_DEFAULT_UNSETTLED) where the
// two differ.
export function resolveModuleInstances(app: AppConfig, env: Map<string, string>): ModuleInstance[] {
  const refsOfParam = new Map<string, string[]>();
  for (const r of app.refs.values()) (refsOfParam.get(r.paramId) ?? refsOfParam.set(r.paramId, []).get(r.paramId)!).push(r.id);
  const settled = (takeOpen: boolean) => {
    let seen = { placed: new Set<string>(), placedParams: new Set<string>(), heads: new Set<string>() };
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((r) => b.has(r));
    for (let pass = 0; ; pass++) {
      const run = allocate(app, env, refsOfParam, seen, takeOpen);
      if (same(run.placed, seen.placed) && same(run.placedParams, seen.placedParams) && same(run.heads, seen.heads)) return run;
      if (pass >= 50) throw new ProductError("CONFIG_NOT_RESOLVABLE", "the application's parameter visibility does not settle while its module instances are allocated");
      seen = run;
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
  before: { placed: Set<string>; placedParams: Set<string>; heads: Set<string> },
  takeOpen: boolean,
): { out: ModuleInstance[]; placed: Set<string>; placedParams: Set<string>; heads: Set<string>; open: Set<string> } {
  const alloc = new Map<string, number>();
  for (const a of app.allocators.values()) alloc.set(a.id, a.start);
  const out: ModuleInstance[] = [];
  const placed = new Set<string>(), placedParams = new Set<string>(), heads = new Set<string>(), open = new Set<string>();
  const miCount = new Map<string, number>(); // module-node id -> instances seen so far (for MI-n)
  const workEnv = new Map(env);

  const strip = (id: string) => (id.startsWith(`${app.id}_`) ? id.slice(app.id.length + 1) : id);

  // Effective value of a parameter ref for a choose test or Assign source: working value (stored or
  // assigned on this ref or a sibling) else the ref default else the parameter default.
  const effRaw = (defRefId: string, rewrite: (s: string) => string): string | undefined => {
    const instId = rewrite(defRefId);
    const ref = app.refs.get(defRefId);
    if (workEnv.has(instId)) return workEnv.get(instId);
    if (ref) {
      const siblingVals = new Set((refsOfParam.get(ref.paramId) ?? []).filter((r) => workEnv.has(rewrite(r))).map((r) => workEnv.get(rewrite(r))!));
      if (siblingVals.size === 1) return [...siblingVals][0];
    }
    return ref?.value ?? (ref ? app.params.get(ref.paramId)?.value : undefined);
  };
  const effVal = (defRefId: string, rewrite: (s: string) => string): number =>
    // Default a fully unresolved selector to 0, identical to config.ts selectWhens, so the
    // allocator walk and the config view never disagree on which choose branch is active
    // (their instance sets must stay interchangeable). Without this a value-less selector
    // yields NaN here but 0 there, potentially selecting different branches.
    Number(effRaw(defRefId, rewrite) ?? 0);

  const walk = (nodes: DynNode[], rewrite: (s: string) => string) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "block":
          if (n.paramRefId) heads.add(rewrite(n.paramRefId));
          walk(n.children, rewrite);
          break;
        case "container":
          if (n.repeatCount !== undefined) for (let i = 0; i < n.repeatCount; i++) walk(n.children, rewrite);
          else walk(n.children, rewrite);
          break;
        case "choose": {
          // ETS evaluates EVERY matching <when>, not just the first (see config.ts
          // selectWhens); unplaced/unstored parameters skip their tests by chooseSkipsTests, and
          // the default is taken only when none match, by defaultBranchOf. Allocation must walk
          // the same branches the config/image walk does, or a from-scratch device's instance set
          // would diverge from ETS's.
          const id = rewrite(n.paramRefId);
          const ref = app.refs.get(n.paramRefId);
          const paramPlaced = !!ref && before.placedParams.has(rewrite(ref.paramId));
          const isHeaded = before.heads.has(id);
          const hasStored = !!ref && (refsOfParam.get(ref.paramId) ?? []).some((r) => workEnv.has(rewrite(r)));
          let matched: DynWhen[];
          if (chooseSkipsTests(app, n.paramRefId, paramPlaced, isHeaded, hasStored)) {
            for (const x of n.whens) if (!x.isDefault && x.test !== undefined) validateTest(x.test);
            matched = [];
          } else {
            matched = n.whens.filter((x) => !x.isDefault && x.test !== undefined && matchTest(x.test, effVal(n.paramRefId, rewrite)));
          }
          const def = n.whens.find((x) => x.isDefault);
          let branches = matched;
          if (!matched.length && def) {
            const rule = defaultBranchOf(app, n.paramRefId, before.placed.has(id), isHeaded);
            if (rule === "open" && def.children.length) open.add(id);
            branches = rule === "take" || (rule === "open" && takeOpen) ? [def] : [];
          }
          for (const w of branches) walk(w.children, rewrite);
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
              // channel-1 memory. Refuse instead: a wrong placement is flashable damage.
              if (cur === undefined) {
                throw new ProductError("MODULE_ARG_UNRESOLVED",
                  `module instance ${instId}: argument ${strip(na.argId)} is bound to allocator ${strip(na.allocatorRefId)}, which the application does not declare; cannot place this module's memory`);
              }
              val = String(cur);
              const allocates = def.args.find((d) => d.id === na.argId)?.allocates ?? 0;
              alloc.set(na.allocatorRefId, cur + allocates);
            }
            if (val !== undefined) args.push({ refId: strip(na.argId), value: val });
          }
          for (const ta of n.textArgs) args.push({ refId: strip(ta.argId), value: ta.value });
          out.push({ id: instId, refId: strip(n.id), args });
          // Descend into the module's own dynamic so nested modules allocate in order and
          // module-internal choose branches resolve against this instance's values.
          const instFull = `${app.id}_${instId}`;
          const childRewrite = (id: string) => rewrite(id.startsWith(`${n.refId}_`) ? instFull + id.slice(n.refId.length) : id);
          walk(def.dynamic, childRewrite);
          break;
        }
        // Leaves. ParameterRefRef records placement for chooseSkipsTests and defaultBranchOf;
        // Assign updates workEnv so later chooses see assigned targets. Listed rather than left to
        // a `default`, so a node kind added later cannot be skipped silently here.
        case "paramRef": {
          placed.add(rewrite(n.refId));
          const ref = app.refs.get(n.refId);
          if (ref) placedParams.add(rewrite(ref.paramId));
          break;
        }
        case "assign":
          workEnv.set(rewrite(n.target), n.value ?? (n.source ? effRaw(n.source, rewrite) ?? "" : ""));
          break;
        case "comObjRef": case "separator": case "button": case "unsupported":
          break;
      }
    }
  };
  walk(app.dynamic, (s) => s);
  return { out, placed, placedParams, heads, open };
}
