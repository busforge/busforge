// <ParameterCalculation>: product data derives some parameter values with a script (its LRTransformation) from
// others, and a download writes the results like any other parameter value. ETS runs the script once a value it
// reads (an LParameter) differs from its default and stores the results in the RParameters; with every input at its
// default the results keep their stored values (bussard's synthetic captures of `syn-param-calculation`: at the
// defaults both outputs hold their declared default, with the input changed both hold the script's result, the
// shown read-only one and the hidden LegacyPatchAlways one).
//
// Busforge computes a calculation from the configuration alone: its results are the script's whenever an input is
// off its default, else what the configuration stores. It runs the script with the interpreter in ./script/, and
// leaves a calculation it cannot run as ETS does to the refusal in deviceimage.ts (refuseCalculationWrites): a script
// outside the subset or named as a function of the application's <Script>, a parameter type scripts are not run with,
// a script that reads or leaves unset a result (it would keep ETS's earlier one), a result the output's type does
// not take, results that steer
// the configuration or sit in a property (the com-object and property writes do not recompute them), and
// calculations whose results do not settle.

import { resolveParamRef, sameParamValue, takesValue, type AppConfig, type CfgCalculation, type DynNode, type ModuleInstance } from "./appconfig.ts";
import { buildDeviceConfig, type DeviceConfigBuild } from "./config.ts";
import { resolveModuleInstances } from "./modules.ts";
import { runScript, scriptRefusal, ScriptError, type ScriptValue } from "./script/index.ts";

export interface CalculationRun {
  calc: CfgCalculation;
  label: string; // the calculation's Name, else its Id
  instance?: ModuleInstance; // the module instance a <ModuleDef>'s calculation ran in
  // defaults: every input at its default, the outputs keep their stored values. computed: `outputs` holds the
  // results. refused: `reason` says why Busforge cannot run it as ETS does.
  state: "defaults" | "computed" | "refused";
  reason?: string;
  outputs: Map<string, string>; // the RParameter refs, scoped to the instance, and their computed values
  keys: string[]; // the parameters of both sides, keyed by instance and Parameter id (paramKey)
}
export interface AppliedCalculations {
  values: Map<string, string>; // the configuration with every computed result stored on each ref of its parameter
  computed: Map<string, string>; // each ref holding a computed result, scoped to the instance -> the run's label
  runs: CalculationRun[];
}

// How often the results are recomputed from each other's before calculations feeding each other are refused.
const MAX_PASSES = 16;

// A parameter of a configuration by instance and Parameter id: one value for all of its refs.
export const instanceMarker = (refId: string): string => refId.match(/_M-\d+_MI-\d+/)?.[0] ?? "";
export function paramKey(app: AppConfig, refId: string): string | undefined {
  const id = resolveParamRef(app, refId)?.param?.id;
  return id === undefined ? undefined : instanceMarker(refId) + id;
}

// The Parameter ids a <choose> tests or an <Assign> reads or sets: they decide what else the configuration writes.
const steeringCache = new WeakMap<AppConfig, Set<string>>();
export function steeringParamIds(app: AppConfig): Set<string> {
  const cached = steeringCache.get(app);
  if (cached) return cached;
  const out = new Set<string>();
  const walk = (nodes: DynNode[]) => {
    for (const n of nodes) {
      const ids = n.kind === "choose" ? [n.paramRefId] : n.kind === "assign" ? [n.target, n.source] : [];
      for (const r of ids) { const id = r ? resolveParamRef(app, r)?.param?.id : undefined; if (id) out.add(id); }
      if (n.kind === "block" || n.kind === "container") walk(n.children);
      else if (n.kind === "choose") for (const w of n.whens) walk(w.children);
    }
  };
  walk(app.dynamic);
  for (const d of app.moduleDefs.values()) walk(d.dynamic);
  steeringCache.set(app, out);
  return out;
}

// How a script sees a parameter: as a number (an integer, enumeration or float parameter) or as a string (a text
// parameter); undefined for a type the scripts are not run with.
function scriptKind(app: AppConfig, refId: string): "number" | "text" | undefined {
  const type = resolveParamRef(app, refId)?.type;
  if (!type) return undefined;
  if (type.base === "Text") return "text";
  if (type.base === "Number" || type.base === "Float" || (type.base === "Value" && Number.isFinite(type.sizeInBit))) return "number";
  return undefined;
}

// Why Busforge cannot run a calculation whatever the configuration, else null.
const staticCache = new WeakMap<AppConfig, Map<string, string | null>>();
function staticRefusal(app: AppConfig, c: CfgCalculation): string | null {
  const cache = staticCache.get(app) ?? staticCache.set(app, new Map()).get(app)!;
  if (cache.has(c.id)) return cache.get(c.id)!;
  const reason = ((): string | null => {
    if (c.lrFunc !== undefined) return `its LRTransformationFunc "${c.lrFunc}" names a function of the application's script, which Busforge does not run`;
    if (c.lrScript === undefined || c.lrScript.trim() === "") return "it declares no LRTransformation script";
    const parse = scriptRefusal(c.language ?? "", c.lrScript);
    if (parse) return `its script is outside what Busforge runs: ${parse}`;
    const names = new Map<string, string>(); // script variable -> Parameter id
    const caseless = (c.language ?? "").toLowerCase() === "vbscript";
    for (const r of [...c.lRefs, ...c.rRefs]) {
      const { param, type } = resolveParamRef(app, r) ?? {};
      if (!param) return `its parameter ${r} does not exist`;
      if (!scriptKind(app, r)) return `its parameter ${r} has a type (${type?.kind || "unknown"}) scripts are not run with`;
      const name = c.aliases[r] ?? param.name;
      if (!name) return `its parameter ${r} has no script variable name`;
      const key = caseless ? name.toLowerCase() : name;
      if (names.has(key) && names.get(key) !== param.id) return `two of its parameters share the script variable ${name}`;
      names.set(key, param.id);
    }
    const steering = steeringParamIds(app);
    for (const r of c.rRefs) {
      const param = resolveParamRef(app, r)!.param!;
      if (param.onProperty) return `its result ${r} sits in a property, which Busforge does not recompute`;
      if (steering.has(param.id)) return `its result ${r} decides what else the configuration places, which Busforge does not recompute`;
    }
    return null;
  })();
  cache.set(c.id, reason);
  return reason;
}

// The <ModuleDef> a calculation belongs to (`MD-3` for `…_MD-3_PC-1`, `MD-1_SM-2` for `…_MD-1_SM-2_PC-1`), undefined
// for an application-level one.
function calcModuleDef(app: AppConfig, calcId: string): string | undefined {
  const rel = calcId.startsWith(`${app.id}_`) ? calcId.slice(app.id.length + 1) : calcId;
  const at = rel.lastIndexOf("_PC-");
  return rel.startsWith("MD-") && at > 0 ? rel.slice(0, at) : undefined;
}

// A module instance's refs are the ModuleDef's with the instance in their id; application-level refs stay.
const scoper = (app: AppConfig, def: string | undefined, inst: ModuleInstance | undefined) => {
  if (!def || !inst) return (r: string) => r;
  const defFull = `${app.id}_${def}`, instFull = `${app.id}_${inst.id}`;
  return (r: string) => (r.startsWith(`${defFull}_`) ? instFull + r.slice(defFull.length) : r);
};

// The value of a parameter in a configuration: that of a ref of it the configuration places, else one stored on any
// of its refs, else the default of the ref asked for.
function valueReader(app: AppConfig, values: Map<string, string>, view: DeviceConfigBuild) {
  const placed = new Map<string, string>(), stored = new Map<string, string>();
  for (const [into, from] of [[placed, view.imageValues], [stored, values]] as const) {
    for (const [ref, v] of from) { const key = paramKey(app, ref); if (key !== undefined && !into.has(key)) into.set(key, v); }
  }
  return (ref: string): string => {
    const key = paramKey(app, ref)!;
    return placed.get(key) ?? stored.get(key) ?? defaultOf(app, ref);
  };
}
const defaultOf = (app: AppConfig, ref: string): string => { const r = resolveParamRef(app, ref); return r?.ref.value ?? r?.param?.value ?? ""; };

// Every ref of the parameter a (ModuleDef) ref names, scoped to the instance.
function siblingRefs(app: AppConfig, ref: string, scope: (r: string) => string): string[] {
  const paramId = resolveParamRef(app, ref)?.param?.id;
  if (paramId === undefined) return [scope(ref)];
  return [...app.refs.values()].filter((r) => r.paramId === paramId).map((r) => scope(r.id));
}

const toScript = (kind: "number" | "text", ref: string, value: string): ScriptValue => {
  if (kind === "text") return value;
  const n = value.trim() === "" ? NaN : Number(value);
  if (!Number.isFinite(n)) throw new ScriptError("unsupported", `parameter ${ref} is numeric but holds "${value}"`);
  return n;
};

// A script's result as the stored value of the output `ref`, or why it is not one.
function storedForm(app: AppConfig, ref: string, v: ScriptValue): string {
  const kind = scriptKind(app, ref)!;
  const type = resolveParamRef(app, ref)!.type!;
  if (kind === "text") {
    if (typeof v !== "string") throw new ScriptError("unsupported", `it computes the number ${v} for the text parameter ${ref}`);
    return v;
  }
  if (typeof v !== "number") throw new ScriptError("unsupported", `it computes the text "${v}" for the numeric parameter ${ref}`);
  if (!Number.isFinite(v)) throw new ScriptError("unsupported", `it computes ${v} for ${ref}`);
  if (type.base === "Float") return String(v);
  const s = String(v === 0 ? 0 : v); // -0 is stored as 0
  if (takesValue(type, s) !== true) throw new ScriptError("unsupported", `it computes ${v} for ${ref}, which its type does not take`);
  return s;
}

export function applyCalculations(app: AppConfig, values: Map<string, string>, moduleInstances: ModuleInstance[]): AppliedCalculations {
  const unchanged = (runs: CalculationRun[]): AppliedCalculations => ({ values, computed: new Map(), runs });
  if (!app.calculations.length) return unchanged([]);
  const refusedRun = (calc: CfgCalculation, reason: string, instance?: ModuleInstance): CalculationRun =>
    ({ calc, label: calc.name || calc.id, instance, state: "refused", reason, outputs: new Map(), keys: keysOf(calc, instance) });
  const keysOf = (calc: CfgCalculation, instance?: ModuleInstance): string[] => {
    const scope = scoper(app, calcModuleDef(app, calc.id), instance);
    return [...calc.lRefs, ...calc.rRefs].flatMap((r) => paramKey(app, scope(r)) ?? []);
  };
  const runnable = app.calculations.filter((c) => staticRefusal(app, c) === null);
  const staticRuns = app.calculations.filter((c) => staticRefusal(app, c) !== null).map((c) => refusedRun(c, staticRefusal(app, c)!));
  if (!runnable.length) return unchanged(staticRuns);

  const instances = moduleInstances.length || !app.hasModules ? moduleInstances : resolveModuleInstances(app, values);
  const same = sameParamValue(app);
  const view0 = buildDeviceConfig(app, values, undefined, instances);

  // One pass: every runnable calculation, in each module instance the configuration places, from `cur`.
  const pass = (cur: Map<string, string>, view: DeviceConfigBuild): CalculationRun[] => {
    const valueOf = valueReader(app, cur, view);
    const runs: CalculationRun[] = [];
    for (const calc of runnable) {
      const def = calcModuleDef(app, calc.id);
      const scopes: (ModuleInstance | undefined)[] = def === undefined ? [undefined]
        : instances.filter((i) => i.id.startsWith(`${def}_`) && /^_M-\d+_MI-\d+$/.test(i.id.slice(def.length))
          && [...view.imageValues.keys()].some((k) => k.startsWith(`${app.id}_${i.id}_`)));
      for (const instance of scopes) runs.push(runOne(calc, instance, valueOf));
    }
    return runs;
  };
  const runOne = (calc: CfgCalculation, instance: ModuleInstance | undefined, valueOf: (ref: string) => string): CalculationRun => {
    const scope = scoper(app, calcModuleDef(app, calc.id), instance);
    const run: CalculationRun = { calc, label: calc.name || calc.id, instance, state: "defaults", outputs: new Map(), keys: keysOf(calc, instance) };
    if (!calc.lRefs.some((r) => !same(scope(r), valueOf(scope(r)), defaultOf(app, r)))) return run;
    const variable = (r: string) => calc.aliases[r] ?? resolveParamRef(app, r)!.param!.name!;
    try {
      const inputs = calc.lRefs.map((r) => [variable(r), toScript(scriptKind(app, r)!, r, valueOf(scope(r)))] as const);
      // The outputs are not bound: a script that reads one before setting it, or leaves one with memory unset, would
      // take what ETS computed when it last ran, which Busforge does not know.
      const results = runScript(calc.language!, calc.lrScript!, inputs, calc.rRefs.map(variable));
      calc.rRefs.forEach((r, k) => {
        const v = results[k];
        if (v !== undefined) run.outputs.set(scope(r), storedForm(app, scope(r), v));
        else if (resolveParamRef(app, r)!.param!.hasMemory) throw new ScriptError("unsupported", `it leaves its result ${scope(r)} unset for these inputs, which keeps what ETS computed when it last ran`);
      });
      return { ...run, state: "computed" };
    } catch (e) {
      if (e instanceof ScriptError) return { ...run, state: "refused", reason: e.message };
      throw e;
    }
  };

  let cur = values, view = view0;
  for (let k = 0; k < MAX_PASSES; k++) {
    let runs = pass(cur, view);
    // Two calculations computing different values for one parameter: neither is written.
    const writes = new Map<string, { value: string; run: CalculationRun }>();
    const clashing = new Set<CalculationRun>();
    for (const run of runs) for (const [ref, v] of run.outputs) {
      const key = paramKey(app, ref)!;
      const had = writes.get(key);
      if (had && !same(ref, had.value, v)) { clashing.add(had.run); clashing.add(run); }
      else writes.set(key, { value: v, run });
    }
    runs = runs.map((r) => (clashing.has(r) ? { ...r, state: "refused", outputs: new Map(), reason: "another calculation computes a different value for one of its results" } : r));
    const next = new Map(values), computed = new Map<string, string>();
    for (const run of runs) {
      const scope = scoper(app, calcModuleDef(app, run.calc.id), run.instance);
      for (const r of run.calc.rRefs) {
        const v = run.outputs.get(scope(r));
        if (v !== undefined) for (const sib of siblingRefs(app, r, scope)) { next.set(sib, v); computed.set(sib, run.label); }
      }
    }
    if (next.size === cur.size && [...next].every(([r, v]) => cur.get(r) === v)) return { values: computed.size ? next : values, computed, runs: [...staticRuns, ...runs] };
    cur = next;
    view = buildDeviceConfig(app, cur, undefined, instances);
  }
  // Results that still change after the last pass never settle (calculations feeding each other): none is written.
  return unchanged([...staticRuns, ...runnable.map((c) => refusedRun(c, "its results did not settle (calculations feeding each other)"))]);
}
