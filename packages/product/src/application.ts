import { parseAppConfig, type AppConfig, type CfgType, type ModuleInstance } from "./appconfig.ts";
import { ProductError } from "./errors.ts";

// The memory-image model used to build/decode a parameter image: parameter types
// (sizes), parameters (with memory location), parameter refs, and the default
// segments. This is now a PROJECTION of the single unified parse (parseAppConfig):
// the flat static layer the image path needs, with module-def and union entries
// dropped so it stays byte-identical to the legacy standalone parser it replaced.
// One parser feeds both the UI (visibility/i18n) and the image (bytes); see
// docs/ets-coverage.md "unify the model".

// `base` is the parameter's value kind, needed to pick the right memory codec:
// "Float" is a KNX 2-byte float (DPT 9), the integer write/read is wrong for it.
export type ParamBase = "Value" | "Number" | "Float" | "Text" | "Time" | "IPAddress" | "Other";
export interface ParamType { id: string; base: ParamBase; sizeInBit: number; signed: boolean; }
export interface Param { id: string; typeId: string; value?: string; codeSegment?: string; offset?: number; bitOffset: number; }
export interface ParamRef { id: string; paramId: string; value?: string; }
export interface Segment { id: string; lsm: number; size: number; data: Buffer; }
export interface AppModel {
  mask: string; manufacturer: number; appNumber: number; version: number;
  types: Map<string, ParamType>;
  params: Map<string, Param>;
  refs: Map<string, ParamRef>;
  segments: Segment[];
}

const hex = (s: string) => parseInt(s, 16);

// Map the config layer's richer type to the image codec's base. Only Float / Value
// / Number drive the codec (Float = DPT codec; Value/Number = integer; everything
// else is not represented in the image). The mapping must preserve those exact
// distinctions, in particular BinaryValue -> Value (an integer-decodable enum), to
// keep images byte-identical.
function imageBase(t: { base: CfgType["base"]; kind: string }): ParamBase {
  // TypeTime (durations/periods) has no float or enum semantics: ETS stores it in the
  // parameter image as a plain unsigned integer, so encode it as Number. The config
  // layer keeps it as "Other" (still surfaced as an unsupported row in the UI) until
  // proper Time editing exists; only the image projection treats it numerically.
  // Hardware-verified on M-008E (a 16-bit TypeTime value 60 -> 0x003C matched).
  if (t.kind === "TypeTime") return "Number";
  switch (t.base) {
    case "Float": return "Float";
    case "Number": return "Number";
    case "Value": case "BinaryValue": return "Value";
    case "Text": return "Text";
    // TypeIPAddress is a 4-byte host address; the image codec encodes the dotted-quad
    // string as 4 big-endian bytes (see image.ts encode).
    case "IPAddress": return "IPAddress";
    default: return "Other"; // Color / Other / Time(handled above)
  }
}

// Project the unified config model onto the flat image model. Module-def parameters/types/refs
// are dropped from the flat pass and re-added per instance by materializeModuleParams below,
// with their per-instance offsets resolved (hardware-verified; see docs/device-memory-model.md).
// `includeUnions` keeps union parameters (overlapping-memory branches) in the model.
// Default OFF so the legacy full-image path (buildParameterImage) and its golden snapshot stay
// byte-identical; every path that actually programs or reads a device opts IN (the surgical
// segment builders and both profiles), because a model without unions decodes nothing at the
// offsets those builders write.
// The MV-0705 absolute-segment build opts in: union branches are real parameter
// memory there, and visibility resolution writes only the active branch.
export function toAppModel(app: AppConfig, opts: { includeUnions?: boolean; instances?: ModuleInstance[] } = {}): AppModel {
  const types = new Map<string, ParamType>();
  for (const t of app.types.values()) {
    if (t.moduleDefId) continue;
    types.set(t.id, { id: t.id, base: imageBase(t), sizeInBit: t.sizeInBit, signed: t.signed });
  }
  const params = new Map<string, Param>();
  for (const p of app.params.values()) {
    if (p.moduleDefId || (p.union && !opts.includeUnions) || p.patchAlways) continue; // patchAlways: ETS-managed marker, never authored
    params.set(p.id, { id: p.id, typeId: p.typeId, value: p.value, codeSegment: p.codeSegment, offset: p.offset, bitOffset: p.bitOffset ?? 0 });
  }
  const refs = new Map<string, ParamRef>();
  for (const r of app.refs.values()) {
    if (r.moduleDefId) continue;
    refs.set(r.id, { id: r.id, paramId: r.paramId, value: r.value });
  }
  // Materialise each module instance's parameters as concrete, resolved-offset image
  // entries so the codec places them and unmappedParamRefs no longer refuses them. The
  // module-def parser tagged these with moduleDefId (so the flat model above drops them);
  // here each instance rewrites the def ids to its own and adds its per-instance base
  // offset. See materializeModuleParams.
  if (opts.instances?.length) materializeModuleParams(app, opts.instances, types, params, refs);
  const manufacturer = hex(String(app.id).split("_")[0].replace("M-", "")); // "M-0162_A-..." -> 0x162
  return { mask: app.mask, manufacturer, appNumber: app.appNumber, version: app.appVersion, types, params, refs, segments: app.segments };
}

// Expand a device's module instances into flat image params. For each instance we find
// its ModuleDef and replay every one of the def's parameter refs under the instance's id
// prefix (…_MD-x_M-k_MI-n_…), resolving the per-instance memory offset as
// `def param offset + instance value of the Memory BaseOffset argument`. This is the
// placement ETS bakes into a project 0.xml; it is hardware byte-verified against the
// real Theben channel devices (see docs/device-memory-model.md).
//
// Materialised params carry NO default value: whether an instance param is actually
// WRITTEN is decided by visibility (the caller passes the resolved active values as the
// build's instanceValues). An inactive branch's param therefore stays at the segment
// default, exactly as ETS leaves it. Non-memory module params (e.g. the channel name
// text) are still materialised, with no offset, so a stored value for them counts as
// placeable (not an unmapped-ref flash refusal) even though nothing is written.
function materializeModuleParams(
  app: AppConfig,
  instances: ModuleInstance[],
  types: Map<string, ParamType>,
  params: Map<string, Param>,
  refs: Map<string, ParamRef>,
): void {
  const defIds = [...app.moduleDefs.keys()];
  for (const inst of instances) {
    const nodeFullId = `${app.id}_${inst.refId}`;          // e.g. M-0048_…_MD-7_M-19
    const defId = defIds.find((d) => nodeFullId.startsWith(`${d}_M-`));
    if (!defId) continue;
    const instFull = `${app.id}_${inst.id}`;               // e.g. M-0048_…_MD-7_M-19_MI-1
    const rewrite = (id: string) => (id.startsWith(`${defId}_`) ? instFull + id.slice(defId.length) : id);
    const argVal = new Map<string, number>();              // full arg id -> numeric value
    for (const a of inst.args) argVal.set(`${app.id}_${a.refId}`, Number(a.value));
    for (const r of app.refs.values()) {
      if (r.moduleDefId !== defId) continue;
      const param = app.params.get(r.paramId);
      if (!param || param.patchAlways) continue; // ETS-managed marker, never authored
      const refId = rewrite(r.id);
      const paramId = rewrite(r.paramId);
      // A memory param whose BaseOffset argument is missing (or non-numeric) on this
      // instance has an UNKNOWN placement. The old `?? 0` fallback placed it at the
      // module's base 0, i.e. over channel 1's memory, where a flash would then write
      // it and verify against the same wrong model. Refuse instead of guessing.
      let base = 0;
      if (param.baseOffsetArg !== undefined && param.offset !== undefined) { // non-memory params place nothing
        const v = argVal.get(param.baseOffsetArg);
        if (v === undefined || Number.isNaN(v)) {
          throw new ProductError("MODULE_ARG_UNRESOLVED",
            `module instance ${inst.id}: memory placement of ${refId} needs argument ${param.baseOffsetArg}, which the instance does not carry; refusing to place it at base 0`);
        }
        base = v;
      }
      const offset = param.offset === undefined ? undefined : param.offset + base;
      const t = app.types.get(param.typeId);
      if (t && !types.has(t.id)) types.set(t.id, { id: t.id, base: imageBase(t), sizeInBit: t.sizeInBit, signed: t.signed });
      params.set(paramId, { id: paramId, typeId: param.typeId, value: undefined, codeSegment: param.codeSegment, offset, bitOffset: param.bitOffset ?? 0 });
      refs.set(refId, { id: refId, paramId, value: undefined });
    }
  }
}

export function parseApplication(xml: string): AppModel {
  return toAppModel(parseAppConfig(xml));
}

// Stored parameter refs the static image model cannot place (no matching
// ParameterRef), e.g. channel/module-instance values (…_MI-…) because this model
// does not expand modules yet. They would be silently dropped when building the
// image, so the flash path treats a non-empty result as a refuse-to-flash signal:
// the configuration the UI shows and the image we build must cover the same refs.
export function unmappedParamRefs(model: AppModel, values: Map<string, string>): string[] {
  return [...values.keys()].filter((k) => !model.refs.has(k));
}
