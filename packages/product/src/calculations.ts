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
// not take, results that steer the configuration or sit in a property (the com-object and property writes do not
// recompute them), and calculations whose results do not settle.
//
// The trigger rule, the passes until the results settle and the refusal of results that do not follow bussard's
// evaluation of calculations (https://github.com/tmbo/bussard, commit 0a537ce12a821b18122f292e2c7d5fbbe2e081a4,
// crates/bussard-model/src/dynamic.rs, CalcRuns), Copyright (c) 2026 Tom Bocklisch, MIT License
// (./script/LICENSE).

import { resolveParamRef, sameParamValue, takesValue, type AppConfig, type CfgCalculation, type DynNode, type ModuleInstance } from "./appconfig.ts";
import { buildDeviceConfig, decodeTextEntities, isSkippedRepeat, resolveLanguage, type CalcRefusal, type CalcRefusalCode, type CalcState, type CfgCalculationMark, type DeviceConfigBuild } from "./config.ts";
import { resolveModuleInstances } from "./modules.ts";
import { runScript, scriptRefusal, ScriptError, type ScriptValue } from "./script/index.ts";

// defaults: every input at its default, the outputs keep their stored values. computed: `outputs` holds the
// results. refused: `refusal` says why Busforge cannot run it as ETS does, `reason` the same in English.
export type CalculationRun = CalcState & {
  calc: CfgCalculation;
  label: string; // the calculation's Name, else its Id
  instance?: ModuleInstance; // the module instance a <ModuleDef>'s calculation ran in
  inputs: string[]; // the LParameter refs, scoped to the instance
  outputs: Map<string, string>; // the RParameter refs, scoped to the instance, and their computed values
  keys: string[]; // the parameters of both sides, keyed by instance and Parameter id (paramKey)
};
export interface AppliedCalculations {
  values: Map<string, string>; // the configuration with every computed result stored on each ref of its parameter
  computed: Map<string, string>; // each ref holding a computed result, scoped to the instance -> the run's label
  runs: CalculationRun[];
}

// How often the results are recomputed from each other's before calculations feeding each other are refused.
const MAX_PASSES = 16;

// Each reason Busforge does not run a calculation, in English; `{key}` stands for the refusal's `params[key]`. The app
// names the same reasons by their code in the user's language (locales, device.calcRefusal), in English alike.
export const CALC_REFUSAL_TEXT: Record<CalcRefusalCode, string> = {
  lrFunc: "its LRTransformationFunc \"{func}\" names a function of the application's script, which Busforge does not run",
  noScript: "it declares no LRTransformation script",
  numericCharRef: "its script holds a numeric character reference, which Busforge cannot read unambiguously after the XML parser",
  scriptOutside: "its script is outside what Busforge runs: {detail}",
  paramMissing: "its parameter {ref} does not exist",
  paramType: "its parameter {ref} has a type ({type}) scripts are not run with",
  noVariable: "its parameter {ref} has no script variable name",
  sharedVariable: "two of its parameters share the script variable {name}",
  resultInProperty: "its result {ref} sits in a property, which Busforge does not recompute",
  resultSteers: "its result {ref} decides what else the configuration places, which Busforge does not recompute",
  inputNotNumeric: "parameter {ref} is numeric but holds \"{value}\"",
  numberForText: "it computes the number {value} for the text parameter {ref}",
  textForNumber: "it computes the text \"{value}\" for the numeric parameter {ref}",
  notFinite: "it computes {value} for {ref}",
  outsideRange: "it computes {value} for {ref}, outside its type's range",
  typeRejects: "it computes {value} for {ref}, which its type does not take",
  resultUnset: "it leaves its result {ref} unset for these inputs, which keeps what ETS computed when it last ran",
  scriptFailed: "{detail}",
  clash: "another calculation computes a different value for one of its results",
  unsettled: "its results did not settle (calculations feeding each other)",
};
const calcRefusalText = (r: CalcRefusal): string => CALC_REFUSAL_TEXT[r.code].replace(/\{(\w+)\}/g, (_, k: string) => r.params?.[k] ?? "");
const refusal = (code: CalcRefusalCode, params?: Record<string, string>): CalcRefusal => (params ? { code, params } : { code });
// A script's run refused by this module rather than by the interpreter (a value it does not take or leaves).
class CalcRefused extends Error {
  constructor(readonly refusal: CalcRefusal) { super(calcRefusalText(refusal)); }
}
const stateOf = (run: CalcState): CalcState => (run.state === "refused" ? { state: run.state, reason: run.reason, refusal: run.refusal } : { state: run.state });
const refusedAs = (why: CalcRefusal) => ({ state: "refused" as const, reason: calcRefusalText(why), refusal: why });

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
      if (n.kind === "block") walk(n.children);
      else if (n.kind === "container") { if (!isSkippedRepeat(n)) walk(n.children); }
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
const staticCache = new WeakMap<AppConfig, Map<string, CalcRefusal | null>>();
function staticRefusal(app: AppConfig, c: CfgCalculation): CalcRefusal | null {
  const cache = staticCache.get(app) ?? staticCache.set(app, new Map()).get(app)!;
  if (cache.has(c.id)) return cache.get(c.id)!;
  const reason = ((): CalcRefusal | null => {
    if (c.lrFunc !== undefined) return refusal("lrFunc", { func: c.lrFunc });
    if (c.lrScript === undefined || c.lrScript.trim() === "") return refusal("noScript");
    // The XML parser decodes the named entities and leaves the numeric ones, so what such a reference stood for in
    // the file (a character, or the text `&#…;` written as `&amp;#…;`) is no longer known.
    if (/&#x?[0-9a-f]+;/i.test(c.lrScript)) return refusal("numericCharRef");
    const parse = scriptRefusal(c.language ?? "", c.lrScript);
    if (parse) return refusal("scriptOutside", { detail: parse });
    const names = new Map<string, string>(); // script variable -> Parameter id
    const caseless = (c.language ?? "").toLowerCase() === "vbscript";
    for (const r of [...c.lRefs, ...c.rRefs]) {
      const { param, type } = resolveParamRef(app, r) ?? {};
      if (!param) return refusal("paramMissing", { ref: r });
      if (!scriptKind(app, r)) return refusal("paramType", { ref: r, type: type?.kind || "unknown" });
      const name = c.aliases[r] ?? param.name;
      if (!name) return refusal("noVariable", { ref: r });
      const key = caseless ? name.toLowerCase() : name;
      if (names.has(key) && names.get(key) !== param.id) return refusal("sharedVariable", { name });
      names.set(key, param.id);
    }
    const steering = steeringParamIds(app);
    for (const r of c.rRefs) {
      const param = resolveParamRef(app, r)!.param!;
      if (param.onProperty) return refusal("resultInProperty", { ref: r });
      if (steering.has(param.id)) return refusal("resultSteers", { ref: r });
    }
    return null;
  })();
  cache.set(c.id, reason);
  return reason;
}

// The id of the <ModuleDef> that declares a calculation, relative to the application (its `…_MD-n_PC-k` id names
// it); undefined for one the application declares itself.
function calcModuleDef(app: AppConfig, calcId: string): string | undefined {
  const rel = calcId.startsWith(`${app.id}_`) ? calcId.slice(app.id.length + 1) : calcId;
  return /^(MD-\d+)_PC-/.exec(rel)?.[1];
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
  if (!Number.isFinite(n)) throw new CalcRefused(refusal("inputNotNumeric", { ref, value }));
  return n;
};

// A script's result as the stored value of the output `ref`, or why it is not one.
function storedForm(app: AppConfig, ref: string, v: ScriptValue): string {
  const kind = scriptKind(app, ref)!;
  const type = resolveParamRef(app, ref)!.type!;
  if (kind === "text") {
    if (typeof v !== "string") throw new CalcRefused(refusal("numberForText", { value: String(v), ref }));
    return v;
  }
  if (typeof v !== "number") throw new CalcRefused(refusal("textForNumber", { value: v, ref }));
  if (!Number.isFinite(v)) throw new CalcRefused(refusal("notFinite", { value: String(v), ref }));
  const s = String(v === 0 ? 0 : v); // -0 is stored as 0
  if (type.base === "Float") {
    if ((type.min !== undefined && v < type.min) || (type.max !== undefined && v > type.max)) throw new CalcRefused(refusal("outsideRange", { value: String(v), ref }));
    return s;
  }
  if (takesValue(type, s) !== true) throw new CalcRefused(refusal("typeRejects", { value: String(v), ref }));
  return s;
}

export function applyCalculations(app: AppConfig, values: Map<string, string>, moduleInstances: ModuleInstance[]): AppliedCalculations {
  const unchanged = (runs: CalculationRun[]): AppliedCalculations => ({ values, computed: new Map(), runs });
  if (!app.calculations.length) return unchanged([]);
  const refusedRun = (calc: CfgCalculation, why: CalcRefusal, instance?: ModuleInstance): CalculationRun =>
    ({ calc, label: calc.name || calc.id, instance, ...refusedAs(why), inputs: calc.lRefs, outputs: new Map(), keys: keysOf(calc, instance) });
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
    const run: CalculationRun = { calc, label: calc.name || calc.id, instance, state: "defaults", inputs: calc.lRefs.map(scope), outputs: new Map(), keys: keysOf(calc, instance) };
    if (!calc.lRefs.some((r) => !same(scope(r), valueOf(scope(r)), defaultOf(app, r)))) return run;
    const variable = (r: string) => calc.aliases[r] ?? resolveParamRef(app, r)!.param!.name!;
    try {
      const inputs = calc.lRefs.map((r) => [variable(r), toScript(scriptKind(app, r)!, r, valueOf(scope(r)))] as const);
      // The outputs are not bound: a script that reads one before setting it, or leaves one with memory unset, would
      // take what ETS computed when it last ran, which Busforge does not know.
      const results = runScript(calc.language!, calc.lrScript!, inputs, calc.rRefs.map(variable));
      const outputs = new Map<string, string>();
      calc.rRefs.forEach((r, k) => {
        const v = results[k];
        if (v !== undefined) outputs.set(scope(r), storedForm(app, scope(r), v));
        else if (resolveParamRef(app, r)!.param!.hasMemory) throw new CalcRefused(refusal("resultUnset", { ref: scope(r) }));
      });
      return { ...run, state: "computed", outputs };
    } catch (e) {
      if (e instanceof CalcRefused) return { ...run, ...refusedAs(e.refusal) };
      if (e instanceof ScriptError) return { ...run, ...refusedAs(refusal("scriptFailed", { detail: e.message })) };
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
    runs = runs.map((r) => (clashing.has(r) ? { ...r, ...refusedAs(refusal("clash")), outputs: new Map() } : r));
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
  return unchanged([...staticRuns, ...runnable.map((c) => refusedRun(c, refusal("unsettled")))]);
}

// What a device page says about the parameters of the <ParameterCalculation>s: every shown parameter of one gets a
// mark per calculation it is an input or a result of, with the value Busforge builds the image with for each result
// (the configuration applyCalculations hands the image builders), and a shown read-only result shows that value instead
// of the one the project stores. Whether a write then takes the image or refuses it is refuseCalculationWrites' to say.
// A result Busforge computes never decides what the configuration places (staticRefusal), so `view`, built from the
// stored values, shows the same rows as one built from the computed ones.
export function annotateCalculations(app: AppConfig, values: Map<string, string>, moduleInstances: ModuleInstance[], view: DeviceConfigBuild, lang?: string): void {
  if (!app.calculations.length) return;
  // The module instances the image builders resolve for this configuration.
  const instances = moduleInstances.length || !app.hasModules ? moduleInstances : resolveModuleInstances(app, values);
  const applied = applyCalculations(app, values, instances);
  const valueOf = valueReader(app, applied.values, applied.values === values ? view : buildDeviceConfig(app, applied.values, undefined, instances));
  const placed = new Set<string>(); // per instance and Parameter id: placed by an active branch
  for (const r of view.imageValues.keys()) { const k = paramKey(app, r); if (k !== undefined) placed.add(k); }
  const language = resolveLanguage(app, lang);
  const shownName = new Map<string, string>(); // per instance and Parameter id: the name of a row that shows it
  for (const b of view.blocks) for (const it of b.items) if (it.kind === "param") { const k = paramKey(app, it.param.refId); if (k !== undefined && !shownName.has(k)) shownName.set(k, it.param.name); }
  // A result's name as its row shows it; for one the page does not show, its Text in the page's language, or its
  // Name where it has no Text or one that takes arguments ({{…}}) only the configuration's view fills in.
  const nameOf = (refId: string): string => {
    const shown = shownName.get(paramKey(app, refId)!);
    if (shown !== undefined) return shown;
    const { ref, param } = resolveParamRef(app, refId)!;
    const tr = (id: string, base: string | undefined) => (language === app.defaultLanguage ? base : app.translations.get(language)?.get(id)?.get("Text") ?? base);
    const text = tr(ref.id, ref.text) || tr(param!.id, param!.text);
    return decodeTextEntities(text && !text.includes("{{") ? text : param!.name || param!.id).trim();
  };
  const steering = steeringParamIds(app);
  const reaches = (refs: string[]) => refs.some((r) => { const p = resolveParamRef(app, r)?.param; return !!p && (p.hasMemory || !!p.onProperty || steering.has(p.id)); });
  // Per instance and Parameter id, the marks keyed by run and role: a parameter on both sides gets both.
  const marks = new Map<string, Map<string, CfgCalculationMark>>();
  for (const [n, run] of applied.runs.entries()) {
    const scope = scoper(app, calcModuleDef(app, run.calc.id), run.instance);
    const results = new Map<string, CfgCalculationMark["results"][number]>();
    for (const r of run.calc.rRefs) {
      const key = paramKey(app, scope(r));
      if (key === undefined || results.has(key)) continue;
      results.set(key, { refId: scope(r), name: nameOf(scope(r)), placed: placed.has(key), ...(run.state !== "refused" ? { value: valueOf(scope(r)) } : {}) });
    }
    for (const [role, refs, other] of [["input", run.calc.lRefs, run.calc.rRefs], ["result", run.calc.rRefs, run.calc.lRefs]] as const) for (const r of refs) {
      const key = paramKey(app, scope(r));
      if (key === undefined) continue;
      const of = marks.get(key) ?? marks.set(key, new Map()).get(key)!;
      if (!of.has(`${n}:${role}`)) of.set(`${n}:${role}`, { name: run.label, role, ...stateOf(run), otherSideReaches: reaches(other), results: [...results.values()] });
    }
  }
  // Calculations refused in no module instance (whatever the configuration, or because their results do not settle)
  // are keyed by Parameter id alone.
  const bare = (key: string) => key.replace(/^_M-\d+_MI-\d+/, "");
  for (const b of view.blocks) for (const it of b.items) {
    if (it.kind !== "param") continue;
    const key = paramKey(app, it.param.refId);
    if (key === undefined) continue;
    const found = [...(marks.get(key)?.values() ?? []), ...(bare(key) !== key ? marks.get(bare(key))?.values() ?? [] : [])];
    if (!found.length) continue;
    // A result names the value Busforge computes for its own parameter; a read-only one shows it.
    it.param.calculations = found.map((m) => (m.role === "result" && m.state !== "refused" ? { ...m, value: valueOf(it.param.refId) } : m));
    if (it.param.readOnly && found.some((m) => m.role === "result" && m.state !== "refused")) it.param.value = valueOf(it.param.refId);
  }
}
