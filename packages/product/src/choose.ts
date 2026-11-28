import type { AppConfig, CfgParam, DynNode, DynWhen } from "./appconfig.ts";
import { ProductError } from "./errors.ts";

// Shared <choose> branch-selection and parameter value-resolution logic used by
// both the device-configuration engine (config.ts) and the from-scratch module
// allocator (modules.ts). Keeping the two walks on one implementation prevents
// them from diverging on Merker placement, sibling-ref defaults, skipped tests,
// or unsettled default branches.

// Whether a parameter's value is held by the device: in memory or in a property.
export const holdsValue = (p: CfgParam): boolean => p.hasMemory || !!p.onProperty;

// Validated <Repeat Count="...">. A plain container (<Channel>, <ChannelIndependentBlock>)
// has no repeatCount and returns undefined. A non-negative integer returns that count (0 skips
// the subtree); anything else (NaN, negative, fractional, Infinity) refuses rather than guessing
// or looping unboundedly.
export function repeatCountOf(n: Extract<DynNode, { kind: "container" }>): number | undefined {
  if (n.repeatCount === undefined) return undefined;
  if (!Number.isInteger(n.repeatCount) || n.repeatCount < 0) {
    throw new ProductError("REPEAT_COUNT_INVALID", `<Repeat${n.id ? ` ${n.id}` : ""}> carries an unsupported Count (${String(n.repeatCount)}); refusing rather than guessing how many times to expand it`);
  }
  return n.repeatCount;
}

export const isSkippedRepeat = (n: Extract<DynNode, { kind: "container" }>): boolean => repeatCountOf(n) === 0;

// `test` grammar: space-separated tokens, OR-combined. A token is a bare integer
// (equality) or one of =N, !=N, <N, >N, <=N, >=N. Compares the raw integer value.
// This is ETS's own grammar for When/@test: `((-?\d+\s)*-?\d+)|((=|!=|>|<|>=|<=)-?\d+)`.
// ETS forbids mixing the list form with an operator token; accepting that superset is harmless.
//
// Every token is validated BEFORE any is evaluated, and an unrecognised one refuses. Skipping it
// would decide the branch on a partial reading of the condition: a `choose` whose branches all
// test an unknown form would fall through to `default`, and that branch's parameters go into the
// flashed image. Nothing downstream can catch it, because the device faithfully holds whatever it
// was given and reads back green.
const TEST_OP = /^(<=|>=|<|>|!=|=)(-?\d+)$/;
export function validateTest(test: string): string[] {
  const tokens = test.trim().split(/\s+/).filter((t) => t !== "");
  for (const tok of tokens) {
    if (!TEST_OP.test(tok) && !/^-?\d+$/.test(tok)) {
      throw new ProductError("PARAM_TEST_UNSUPPORTED", `unsupported token "${tok}" in parameter condition "${test}"`);
    }
  }
  return tokens;
}
export function matchTest(test: string, v: number): boolean {
  const tokens = validateTest(test);
  for (const tok of tokens) {
    const m = TEST_OP.exec(tok);
    if (m) {
      const n = Number(m[2]);
      if (m[1] === "<" ? v < n : m[1] === ">" ? v > n : m[1] === "<=" ? v <= n : m[1] === ">=" ? v >= n : m[1] === "!=" ? v !== n : v === n) return true;
    } else if (v === Number(tok)) return true;
  }
  return false;
}

// What a choose none of whose tests matches does with its default branch: takes it on a ParameterRef an active
// branch places ("take"), and on a memoryless parameter heading a reached block; not on a ref nothing places
// ("skip"); "open" where no ETS download decides it (buildDeviceConfig / resolveModuleInstances).
export function defaultBranchOf(app: AppConfig, defRefId: string, placed: boolean, heads: boolean): "take" | "skip" | "open" {
  const ref = app.refs.get(defRefId);
  if (!ref || placed) return "take";
  const param = app.params.get(ref.paramId);
  if (heads) return param && holdsValue(param) ? "open" : "take";
  return (ref.access ?? param?.access) === "None" ? "open" : "skip";
}

// Whether a <choose ParamRefId="defRefId"> skips its <when test="..."> branches because no ref of
// its parameter is placed, `defRefId` does not head a reached block, and no ref of its parameter
// holds a stored or assigned value:
// - Union members (any Access) hold no value while another member owns their memory (GVS AMMA:
//   tests of 0 on idle Forced/Delay/Counter members placed no object in ETS).
// - Non-union, non-property parameters with effective Access != "None" (`ref.access ?? p.access`)
//   likewise match no <choose> test when unplaced and unstored, even when ETS still writes a
//   memory-backed parameter's default into the parameter segment (Theben M-0048_A-0103-11-72A2:
//   memoryless Access="Read" P-68 Value="1"; I.Trust 1ITRGV_100 M-02AA_A-0081-10-72A7-O0085:
//   memory-backed P-37 offset 68 Value="1" and P-184 offset 468 Value="1" written as 0x10 and 0x11
//   in RelMemory(4) while com-objects #164 and #220 stay 00 00; M-021E_A-0016-11-6EC4: unplaced
//   memory-backed and memoryless editable parameters with Value="0"/"1"/"2" leave 14 objects 00 00).
// Unplaced Access="None" Merkers (no <Memory>, no <Property>) still read as 0, and unplaced
// non-Access="None" property-backed or Access="None" memory-backed parameters keep their default
// until a capture shows otherwise.
export function chooseSkipsTests(
  app: AppConfig,
  defRefId: string,
  paramPlaced: boolean,
  heads: boolean,
  hasStored: boolean,
): boolean {
  if (paramPlaced || heads || hasStored) return false;
  const ref = app.refs.get(defRefId);
  const p = ref ? app.params.get(ref.paramId) : undefined;
  if (!p) return false;
  return !!p.union || (!p.onProperty && (ref!.access ?? p.access) !== "None");
}

export const unsettledDefaultRefusal = (chooses: string[] | undefined) => new ProductError("CHOOSE_DEFAULT_UNSETTLED",
  `this configuration images differently depending on whether a <choose> takes its default branch${chooses?.length ? ` (on ${chooses.slice(0, 5).join(", ")})` : ""}: its ParameterRef is Access="None" and no active branch places it, or it has memory and only heads a reached block, and no ETS download shows which; an ETS download of this application in this configuration settles it`);

// Active ParameterRef placement and reached block headings discovered by fixed-point iteration.
// `placed` maps each instance-scoped Parameter id to the set of definition-scoped ParameterRef ids
// placed in active branches; `heads` holds instance-scoped ParameterRef ids heading a reached
// ParameterBlock (placed for a choose's default branch, not for the value they resolve to).
export interface ChoosePlacement {
  placed: Map<string, Set<string>>;
  heads: Set<string>;
}

export const emptyPlacement = (): ChoosePlacement => ({ placed: new Map(), heads: new Set() });

export function recordPlacedRef(app: AppConfig, target: ChoosePlacement, defRefId: string, rewrite: (id: string) => string): void {
  const ref = app.refs.get(defRefId);
  if (!ref) return;
  const key = rewrite(ref.paramId);
  (target.placed.get(key) ?? target.placed.set(key, new Set()).get(key)!).add(defRefId);
}

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

export function samePlacement(a: ChoosePlacement, b: ChoosePlacement): boolean {
  return sameSet(a.heads, b.heads) && a.placed.size === b.placed.size && [...a.placed].every(([k, v]) => {
    const w = b.placed.get(k);
    return !!w && sameSet(v, w);
  });
}

export function buildRefsOfParam(app: AppConfig): Map<string, string[]> {
  const refsOfParam = new Map<string, string[]>();
  for (const r of app.refs.values()) {
    (refsOfParam.get(r.paramId) ?? refsOfParam.set(r.paramId, []).get(r.paramId)!).push(r.id);
  }
  return refsOfParam;
}

export interface ChooseContext {
  app: AppConfig;
  refsOfParam: Map<string, string[]>;
  placement: ChoosePlacement;
  takeOpenDefaults: boolean;
  unsettled: Set<string>;
}

const storedOn = (refIds: string[], rewrite: (id: string) => string, env: Map<string, string>): string | undefined => {
  const vals = new Set(refIds.filter((r) => env.has(rewrite(r))).map((r) => env.get(rewrite(r))!));
  return vals.size === 1 ? [...vals][0] : undefined; // none, or conflicting: no shared stored value
};

export function isChooseSkipped(
  ctx: ChooseContext,
  defRefId: string,
  rewrite: (id: string) => string,
  env: Map<string, string>,
): boolean {
  const ref = ctx.app.refs.get(defRefId);
  if (!ref) return false;
  const paramPlaced = !!ctx.placement.placed.get(rewrite(ref.paramId))?.size;
  const heads = ctx.placement.heads.has(rewrite(defRefId));
  const hasStored = (ctx.refsOfParam.get(ref.paramId) ?? []).some((r) => env.has(rewrite(r)));
  return chooseSkipsTests(ctx.app, defRefId, paramPlaced, heads, hasStored);
}

// Effective value of a ParameterRef against the settled placement and current working env:
// - Several ParameterRefs of one Parameter share its single value. A ref's own Value is only the
//   default of the ref that is placed in an active branch (Jung 400021SE, docs/findings.md §9).
//   A value stored on a ref no active branch places is ETS's leftover from an earlier configuration
//   and is ignored while another ref is placed (Theben Meteodata, Auro).
// - A "Merker" (effective Access="None" without <Memory>, matching docs/findings.md §11, or
//   Access="Read" with neither <Memory> nor <Property>) has no static default in ETS until a
//   ParameterRefRef placing it is reached in an active branch (anywhere in the settled placement,
//   including after the <choose>, as in M-0001_A-20DF-22-4073-O000A) or an active <Assign>/stored
//   value sets it. While unplaced and unstored it resolves to undefined (0 in choose tests for
//   Access="None", skipped for Access="Read", unevaluated for rejectedRefs).
export function resolveParamValue(
  ctx: ChooseContext,
  defRefId: string,
  rewrite: (id: string) => string,
  env: Map<string, string>,
): string | undefined {
  const instId = rewrite(defRefId);
  const ref = ctx.app.refs.get(defRefId);
  if (!ref) return env.get(instId);
  const param = ctx.app.params.get(ref.paramId);
  // An effective Access="None" Merker (no <Memory>) is per-ParameterRef: manufacturers reuse one
  // generic Merker Parameter across unrelated flags (e.g. Theben 493B MD-7_P-7: R-7
  // [Notprogramm=ja] and R-26 [ZwangZulässig=ja]), so placing one ref must never activate its
  // sibling. It resolves to an explicit/assigned value on this ref, else its default whenever this
  // exact ref is placed in the settled placement (including forward placements after the <choose>,
  // as in M-0001_A-20DF-22-4073-O000A), else undefined.
  if (param && (ref.access ?? param.access) === "None" && !param.hasMemory) {
    if (env.has(instId)) return env.get(instId);
    const placedThis = !!ctx.placement.placed.get(rewrite(ref.paramId))?.has(defRefId);
    return placedThis ? ref.value ?? param.value : undefined;
  }
  const paramDefault = param?.value;
  const siblings = (ctx.refsOfParam.get(ref.paramId) ?? []).filter((r) => r !== defRefId);
  const placed = [...(ctx.placement.placed.get(rewrite(ref.paramId)) ?? [])];
  const isPlaced = placed.includes(defRefId);
  const placedSiblings = placed.filter((r) => r !== defRefId);
  if (isPlaced) {
    if (env.has(instId)) return env.get(instId);
    return storedOn(placedSiblings, rewrite, env) ?? ref.value ?? paramDefault;
  }
  if (placedSiblings.length) {
    const stored = storedOn(placedSiblings, rewrite, env);
    if (stored !== undefined) return stored;
    const defaults = new Set(placedSiblings.map((r) => ctx.app.refs.get(r)?.value ?? paramDefault));
    return defaults.size === 1 ? [...defaults][0] : ref.value ?? paramDefault;
  }
  const stored = (env.has(instId) ? env.get(instId) : undefined) ?? storedOn(siblings, rewrite, env);
  if (stored !== undefined) return stored;
  if (param && param.access === "Read" && !holdsValue(param)) {
    const hasAnyStored = (ctx.refsOfParam.get(ref.paramId) ?? []).some((r) => env.has(rewrite(r)));
    if (!hasAnyStored) return undefined;
  }
  return ref.value ?? paramDefault;
}

// ETS evaluates EVERY matching <when> of a <choose>, not just the first (Theben RMG 8 S:
// overlapping whens place both contact-type and union bits). The default branch fires only
// when no non-default test matches, governed by defaultBranchOf. Unplaced/unstored union
// members and non-property parameters with effective Access != "None" skip their tests
// (chooseSkipsTests), while still validating every test token so unsupported syntax refuses.
export function selectChooseWhens(
  ctx: ChooseContext,
  defParamRefId: string,
  whens: DynWhen[],
  rewrite: (id: string) => string,
  env: Map<string, string>,
): DynWhen[] {
  if (isChooseSkipped(ctx, defParamRefId, rewrite, env)) {
    for (const w of whens) if (!w.isDefault && w.test !== undefined) validateTest(w.test);
  } else {
    const v = Number(resolveParamValue(ctx, defParamRefId, rewrite, env) ?? 0);
    const matched = whens.filter((w) => !w.isDefault && w.test !== undefined && matchTest(w.test, v));
    if (matched.length) return matched;
  }
  const def = whens.find((w) => w.isDefault);
  if (!def) return [];
  const ref = ctx.app.refs.get(defParamRefId);
  const instId = rewrite(defParamRefId);
  const placed = !!ref && !!ctx.placement.placed.get(rewrite(ref.paramId))?.has(defParamRefId);
  const rule = defaultBranchOf(ctx.app, defParamRefId, placed, ctx.placement.heads.has(instId));
  if (rule !== "open") return rule === "take" ? [def] : [];
  if (def.children.length) ctx.unsettled.add(instId);
  return ctx.takeOpenDefaults ? [def] : [];
}
