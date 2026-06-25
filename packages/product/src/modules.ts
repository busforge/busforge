import type { AppConfig, DynNode, ModuleInstance } from "./appconfig.ts";
import { matchTest } from "./config.ts";

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
// the matching branch, so inactive device variants neither render nor allocate.
export function resolveModuleInstances(app: AppConfig, env: Map<string, string>): ModuleInstance[] {
  const alloc = new Map<string, number>();
  for (const a of app.allocators.values()) alloc.set(a.id, a.start);
  const out: ModuleInstance[] = [];
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
          const branches = matched.length ? matched : n.whens.filter((x) => x.isDefault);
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
              if (cur !== undefined) {
                val = String(cur);
                const allocates = def.args.find((d) => d.id === na.argId)?.allocates ?? 0;
                alloc.set(na.allocatorRefId, cur + allocates);
              }
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
        default:
          break;
      }
    }
  };
  walk(app.dynamic, (s) => s);
  return out;
}
