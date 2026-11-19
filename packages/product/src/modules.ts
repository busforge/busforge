import type { AppConfig, DynNode, ModuleInstance } from "./appconfig.ts";
import { matchTest } from "./config.ts";
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
// the matching branch, so inactive device variants neither render nor allocate. Its default branch only
// where the configuration takes it (config.ts selectWhens): when the choose's ref is placed, by a reached
// ParameterRefRef or as the page parameter heading a reached block, found by walking until the placement
// settles. A module in a default branch no ETS download decides is refused (CHOOSE_DEFAULT_UNSETTLED).
export function resolveModuleInstances(app: AppConfig, env: Map<string, string>): ModuleInstance[] {
  // Rewritten ParameterRef ids: placed by a reached ParameterRefRef or page-block heading, and heading a reached
  // block without being a page parameter.
  let seen = { placed: new Set<string>(), heads: new Set<string>() };
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((r) => b.has(r));
  for (let pass = 0; ; pass++) {
    const run = allocate(app, env, seen);
    if (same(run.placed, seen.placed) && same(run.heads, seen.heads)) return run.out;
    if (pass >= 50) throw new ProductError("CONFIG_NOT_RESOLVABLE", "the application's parameter visibility does not settle while its module instances are allocated");
    seen = run;
  }
}

const containsModule = (nodes: DynNode[]): boolean =>
  nodes.some((n) => n.kind === "module" || ((n.kind === "block" || n.kind === "container") && containsModule(n.children)) || (n.kind === "choose" && n.whens.some((w) => containsModule(w.children))));

function allocate(app: AppConfig, env: Map<string, string>, before: { placed: Set<string>; heads: Set<string> }): { out: ModuleInstance[]; placed: Set<string>; heads: Set<string> } {
  const alloc = new Map<string, number>();
  for (const a of app.allocators.values()) alloc.set(a.id, a.start);
  const out: ModuleInstance[] = [];
  const placed = new Set<string>(), heads = new Set<string>();
  const miCount = new Map<string, number>(); // module-node id -> instances seen so far (for MI-n)

  const strip = (id: string) => (id.startsWith(`${app.id}_`) ? id.slice(app.id.length + 1) : id);

  // Effective value of a parameter ref for a choose test: device/override value (keyed by
  // the rewritten instance id) else the ref default else the parameter default.
  const effVal = (defRefId: string, rewrite: (s: string) => string): number => {
    const instId = rewrite(defRefId);
    const ref = app.refs.get(defRefId);
    const raw = env.get(instId) ?? ref?.value ?? (ref ? app.params.get(ref.paramId)?.value : undefined);
    // Default a fully unresolved selector to 0, identical to config.ts selectWhen, so the
    // allocator walk and the config view never disagree on which choose branch is active
    // (their instance sets must stay interchangeable). Without this a value-less selector
    // yields NaN here but 0 there, potentially selecting different branches.
    return Number(raw ?? 0);
  };

  const walk = (nodes: DynNode[], rewrite: (s: string) => string) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "block":
          if (n.paramRefId) (app.types.get(app.params.get(app.refs.get(n.paramRefId)?.paramId ?? "")?.typeId ?? "")?.kind === "TypeNone" ? placed : heads).add(rewrite(n.paramRefId));
          walk(n.children, rewrite);
          break;
        case "container":
          if (n.repeatCount !== undefined) for (let i = 0; i < n.repeatCount; i++) walk(n.children, rewrite);
          else walk(n.children, rewrite);
          break;
        case "choose": {
          // ETS evaluates EVERY matching <when>, not just the first (see config.ts
          // selectWhens); the default fires only when none match. Allocation must walk the
          // same branches the config/image walk does, or a from-scratch device's instance
          // set would diverge from ETS's.
          const v = effVal(n.paramRefId, rewrite);
          const matched = n.whens.filter((x) => !x.isDefault && x.test !== undefined && matchTest(x.test, v));
          const def = n.whens.find((x) => x.isDefault);
          const ref = app.refs.get(n.paramRefId);
          const id = rewrite(n.paramRefId);
          const open = !matched.length && !!def && !!ref && !before.placed.has(id)
            && (before.heads.has(id) || (ref.access ?? app.params.get(ref.paramId)?.access) === "None");
          if (open && containsModule(def.children)) {
            throw new ProductError("CHOOSE_DEFAULT_UNSETTLED", `the module instances depend on whether the <choose> on ${id} takes its default branch: its ParameterRef is Access="None" and no active branch places it, or it only heads a reached block, and no ETS download shows which; an ETS download of this application in this configuration settles it`);
          }
          const branches = matched.length ? matched : def && (before.placed.has(id) || open) ? [def] : [];
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
        // Leaves. None carries children or consumes an allocator; a ParameterRefRef places its ref, which
        // decides a later pass's default branches. They are listed rather than left to a `default`, so that
        // a node kind added later cannot be skipped silently by a walk that decides where a module's memory lands.
        case "paramRef":
          placed.add(rewrite(n.refId));
          break;
        case "comObjRef": case "separator": case "button": case "assign": case "unsupported":
          break;
      }
    }
  };
  walk(app.dynamic, (s) => s);
  return { out, placed, heads };
}
