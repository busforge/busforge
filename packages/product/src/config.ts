import type { AppConfig, CfgParam, CfgParamRef, CfgType, ComObjFlags, ComObjPriority, DcaInfo, DynNode, DynWhen, ModuleDefModel, ModuleInstance } from "./appconfig.ts";
import { resolveModuleInstances } from "./modules.ts";
import { ProductError } from "./errors.ts";
import type { MatrixOperation, OperationVerdict } from "./compatibility.ts";

// A human label for a datapoint type the engine cannot edit yet, shown on the
// "not supported" row so the gap is explicit (never a blank/empty control).
function unsupportedTypeLabel(type: CfgType | undefined): string {
  const byTag: Record<string, string> = {
    TypeFloat: "Float", TypeTime: "Time",
    TypeIPAddress: "IP address", TypePicture: "Picture", TypeNone: "Display",
  };
  // Only RGB colour is editable; other colour spaces (HSV) are surfaced as
  // unsupported so we never write an sRGB hex into a differently-encoded register.
  if (type?.kind === "TypeColor") return type.colorSpace ? `Color (${type.colorSpace})` : "Color";
  if (type?.kind && byTag[type.kind]) return byTag[type.kind];
  if (type?.base === "BinaryValue") return "Binary";
  return type?.kind || "Unknown type";
}

// The device-configuration engine: given an application program, a device's
// parameter values, and its module instances, produce the visible, grouped,
// localized parameter tree plus the device's com-objects. Pure and re-runnable
// on every edit so conditional visibility updates live.
//
// Module instances are expanded via a per-instance "scope" that rewrites the
// module-def ids to the device's flattened instance ids (…_MD-x_M-k_MI-n_…),
// substitutes text arguments ({{ChNo}}, {{ObjName}}), and supplies the resolved
// numeric base for com-object numbering. ETS pins the resolved argument values
// in the device's 0.xml, so no allocator computation is needed here.

export interface CfgParamView {
  refId: string;
  name: string;
  control: "enum" | "number" | "text" | "color" | "time" | "ip" | "display" | "unsupported";
  value: string;
  options?: { value: number; text: string }[];
  min?: number;
  max?: number;
  suffix?: string;
  step?: number; // number spinner step (ETS Increment)
  slider?: boolean; // ETS UIHint="Slider": render a range slider (needs min+max)
  unit?: string; // for control "time": the TypeTime Unit (e.g. "Seconds") the raw value counts
  float?: boolean; // control "number" backing a TypeFloat: accept decimal input (step="any")
  readOnly?: boolean;
  changed?: boolean; // differs from the programmed baseline; filled in by the server
  defaultValue?: string; // value with no user override (ref/param default), for change detection
  typeLabel?: string; // for control "unsupported": a human label of the datapoint type we can't edit yet
  indent?: number; // ETS IndentLevel of the row within its block (1 or 2)
}
export interface CfgComObjView {
  refId: string; number: number; name: string; functionText: string;
  objectSize: string; dpt: string; flags: ComObjFlags;
  gaRaw?: number | null; // current GA link, filled in by the server from stored links
  gaRaws?: number[];     // every linked GA, in link order (gaRaw is the first); filled in by the server
  changed?: boolean; // GA link differs from the programmed baseline; filled in by the server
}
// The minimal resolved facts the com-object-table (L3) build needs for one reached
// com-object: its number, its datapoint size, and its RESOLVED flags. Captured for
// every reached object including hidden ones (see DeviceConfigView.imageComObjects).
export interface CfgComObjImage { number: number; objectSize: string; flags: ComObjFlags; priority: ComObjPriority; refId: string; }
// Where a laid-out item sits in its block's grid (1-based, as ETS authors Cell="row,col").
// Only set for items inside a Grid/Table ParameterBlock; a list block has none.
export interface CfgCell { row: number; col: number }
// One declared grid row/column. `text` is the header caption (Table only), `width` the
// ETS percentage of the block width (Grid columns).
export interface CfgGridLine { text?: string; width?: string }
// A scripted ETS action. busforge has no ETS script host, so `handler` is the NAME of
// the action we cannot run; the UI renders the button inert and says so. It is never
// invoked, and it holds no device state.
export interface CfgButtonView { text: string; handler: string }
export type CfgItem =
  | { kind: "separator"; text: string; uiHint: string; cell?: CfgCell }
  | { kind: "param"; param: CfgParamView; cell?: CfgCell }
  | { kind: "comObject"; comObject: CfgComObjView }
  | { kind: "button"; button: CfgButtonView; cell?: CfgCell }
  | { kind: "unsupported"; label: string }; // an ETS dynamic element the engine does not handle yet
export interface CfgBlock {
  id: string; name: string; items: CfgItem[]; level: number; parentId?: string;
  // ETS Layout="Grid"/"Table" (absent = plain list). `rows`/`cols` are the declared
  // geometry; the items carry the Cell that places them in it.
  layout?: "Grid" | "Table"; rows?: CfgGridLine[]; cols?: CfgGridLine[];
}
// The read-back facts the server attaches to a config response (never set by
// buildDeviceConfig). Defined once here so the server's ReadbackSummary and the web client
// bind to the SAME shape: a field renamed here breaks both sides at compile time instead of
// silently leaving the client reading undefined.
export interface DeviceReadbackInfo { paramsRead: boolean; linksRead: boolean; linkGaps: number }

// What can be done with a device today, split by aspect. Read and write are independent
// capabilities (an unsupported family may be neither), as are parameters and links. Defined here
// (the lower module) so the wire view can carry it without config.ts importing profiles.ts, which
// imports config.ts; profiles.ts re-exports it so `classify().capabilities()` reads the same shape.
export interface DeviceCapabilities {
  readParams: boolean; readLinks: boolean; flashParams: boolean; flashLinks: boolean;
  // Can this device be commissioned from nothing: application id, parameter image, com-object
  // table and group tables all written in one bracket? A parameter-only download rewrites an
  // existing segment and cannot bring a virgin device to life.
  fullDownload: boolean;
  // Can a parameter change that alters the com-object table be written without a full download:
  // parameters, com-object table and group tables in one bracket, only what differs from the device?
  structuralFlash: boolean;
}

// The SERIALIZABLE device-configuration wire view: the HTTP contract itself, imported directly
// by the web client (apps/web api.ts) so there is one authoritative definition instead of a
// hand-mirror that drifts. It deliberately carries NO Maps, because JSON.stringify renders a Map as
// `{}`, so the image-build Maps would ship as empty fields. They live only on the internal build
// product (DeviceConfigBuild) and are projected away before the view is serialized (see
// apps/server buildDeviceView).
export interface DeviceConfigView {
  blocks: CfgBlock[];
  hasModules: boolean;
  dca?: DcaInfo;
  // Which aspects of this device can be verified against the hardware via read-back.
  // Attached by the server (not buildDeviceConfig). When params/links is false, the
  // shown change state was never confirmed against the device. See readbackSupport.
  readbackSupport?: { params: boolean; links: boolean };
  // The full capability record for this device (classify().capabilities()), attached by the
  // server. The single source of truth the server gate, the UI, and the smoke framework all read,
  // so the UI never offers a flash the server's capability gate would refuse (refusals from the
  // device's state, such as linkBaseGaps below, come on top). readbackSupport is the read subset,
  // kept for the read-back honesty text.
  capabilities?: DeviceCapabilities;
  // Why an operation capabilities() withholds is withheld, where the application itself is the reason
  // (its declared load procedure): the error code the server answers that write with, for the UI to
  // say instead of only greying it out. Attached by the server.
  refusals?: Partial<Record<keyof DeviceCapabilities, string>>;
  // Whether the full download offered here also brings back a device that holds no running
  // application (DeviceProfile.fullDownloadLoadsApplication); false sends such a device to ETS.
  // Attached by the server.
  fullDownloadLoadsApplication?: boolean;
  // What was shown on hardware for this device's Product and application program, per operation
  // (compatibility.ts buildMatrix over the evidence bundle the server ships). Attached by the server.
  compatibility?: Record<MatrixOperation, OperationVerdict>;
  // The user acknowledged, once for this project, that this Product is written although an
  // operation is not tested on hardware. The server refuses such a write without it (PRODUCT_UNTESTED).
  untestedAcknowledged?: boolean;
  // Device links the last read-back could not show on this page (-1: not counted since the check
  // was added). While non-zero the server refuses a group-address flash (LINK_BASELINE_INCOMPLETE).
  linkBaseGaps?: number;
  // Present only on a read-back response: what the read actually covered. Attached by the
  // server (the read-back route), never by buildDeviceConfig.
  readback?: DeviceReadbackInfo;
}

// What buildDeviceConfig returns: the wire view PLUS the internal image-build products. The two
// Maps are consumed only server-side (the com-object-table build and the surgical image target:
// comobjbuild.ts, deviceimage.ts, comobjtable.ts, profiles.ts) and must never be serialized.
export interface DeviceConfigBuild extends DeviceConfigView {
  // Resolved effective value of every parameter reached in the active dynamic tree,
  // keyed by (rewritten) ParameterRef id. Unlike `blocks` this INCLUDES Access="None"
  // internal parameters, which ETS writes to the memory image even though they are
  // hidden from the UI; the image build needs them. See buildDeviceConfig.
  imageValues: Map<string, string>;
  // The top-level ParameterRefs every placement of which lies in a branch of a choose the image
  // pass evaluated and did not take. A choose on an unset Merker evaluates nothing, so what it
  // gates is not in here; neither is a ref placed nowhere.
  rejectedRefs: Set<string>;
  // Resolved com-objects reached in the active dynamic tree, keyed by resolved object
  // number. Unlike `blocks` this INCLUDES com-objects inside Access="None" blocks (hidden
  // from the UI but still present in the device's com-object table / L3) and per-instance
  // module com-objects. Carries the RESOLVED flags (ComObjectRef overrides applied), which
  // the com-object-table build needs. See buildDeviceConfig and CfgComObjImage.
  imageComObjects: Map<number, CfgComObjImage>;
  // The highest com-object number the application DECLARES (across every choose branch and
  // module instance, not only the active ones), i.e. the length the firmware's group-object
  // table must have. thelsing/knx getGroupObject(n) is unbounded and OpenKNX modules address
  // their objects by fixed number, so a table sized to the highest ACTIVE number instead sends
  // the firmware off the end of its array on boot (hardware-proven: the RaumController reverts).
  // The com-object-table build (comobjbuild.ts) sizes the table to this. See buildDeviceConfig.
  maxComObjectNumber: number;
  // The value a top-level ParameterRef holds in this configuration, resolved like the view does
  // (device value, a placed sibling ref's value, ref or parameter default) against the final
  // working values after the walk. An unknown ref yields only a value stored under that id.
  paramValue: (refId: string) => string | undefined;
}

interface Scope {
  rewrite: (id: string) => string;     // module-def id -> device instance id (identity at top level)
  textArgs: Map<string, string>;       // arg name -> value, for {{name}} substitution
  argValue: (argId: string) => number; // resolved numeric arg, for com-object base numbering
}
// Top-level scope: a BaseNumber argument can only be satisfied inside a module
// instance; a com-object that demands one at top level is a malformed catalogue,
// so refuse instead of silently numbering it from 0.
const TOP: Scope = {
  rewrite: (id) => id,
  textArgs: new Map(),
  argValue: (argId) => { throw new ProductError("COMOBJ_ARG_UNRESOLVED", `com-object numbering references module argument ${argId} outside any module instance`); },
};

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
export function matchTest(test: string, v: number): boolean {
  const tokens = test.trim().split(/\s+/).filter((t) => t !== "");
  for (const tok of tokens) {
    if (!TEST_OP.test(tok) && !/^-?\d+$/.test(tok)) {
      throw new ProductError("PARAM_TEST_UNSUPPORTED", `unsupported token "${tok}" in parameter condition "${test}"`);
    }
  }
  for (const tok of tokens) {
    const m = TEST_OP.exec(tok);
    if (m) {
      const n = Number(m[2]);
      if (m[1] === "<" ? v < n : m[1] === ">" ? v > n : m[1] === "<=" ? v <= n : m[1] === ">=" ? v >= n : m[1] === "!=" ? v !== n : v === n) return true;
    } else if (v === Number(tok)) return true;
  }
  return false;
}

// Map a requested language to one the catalogue actually carries. The UI sends a
// short code ("de", "en") while catalogues use full identifiers ("de-DE",
// "en-GB"); match exactly first, then by primary subtag, else fall back to the
// catalogue's default (its untranslated base text).
export function resolveLanguage(app: AppConfig, requested?: string): string {
  if (!requested) return app.defaultLanguage;
  const want = requested.toLowerCase();
  const prefix = want.split("-")[0];
  const all = [app.defaultLanguage, ...app.languages];
  return (
    all.find((l) => l.toLowerCase() === want) ??
    all.find((l) => l.toLowerCase().split("-")[0] === prefix) ??
    app.defaultLanguage
  );
}

// Some manufacturer texts carry escaped numeric entities (e.g. "&#xA;" for a
// layout newline); decode them so labels read cleanly.
const codePoint = (m: string, n: number): string => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
const decode = (s: string): string =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => codePoint(m, parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => codePoint(m, Number(d)));

// An ETS text names the value of the parameter its element's TextParameterRefId points at:
// `{{0}}` is that value, `{{0:text}}` the value or, while it is empty, `text` verbatim. Index 0 is
// the only one, since an element names one text parameter. Module arguments inside the default
// ("{{0:Button {{ChNo}}}}") are substituted before this runs. `value` is undefined when nothing
// feeds the placeholder; it then stays visible rather than being guessed away.
const textParamPlaceholder = /\{\{0(?::([^{}]*))?\}\}/g;
const fillTextParam = (text: string, value: string | undefined): string =>
  value === undefined ? text : text.replace(textParamPlaceholder, (_m, def: string | undefined) => (value !== "" ? value : def ?? ""));

export function buildDeviceConfig(
  app: AppConfig,
  overrides: Map<string, string>,
  lang?: string,
  moduleInstances: ModuleInstance[] = [],
): DeviceConfigBuild {
  const language = resolveLanguage(app, lang);
  // A from-scratch device (placed from the catalogue, no imported 0.xml) has no pinned
  // module instances. Re-run the allocators to synthesise the same set ETS would compile,
  // so its channel blocks render and its per-instance offsets resolve. An imported device
  // keeps its 0.xml instances. See resolveModuleInstances.
  const instances = moduleInstances.length || !app.hasModules ? moduleInstances : resolveModuleInstances(app, overrides);
  const env = new Map(overrides); // working values; Assign mutates this

  // Effective value: device instance value (keyed by the rewritten instance id)
  // else the module-def ref default else the parameter default. `e` is the working
  // value map; it defaults to the UI walk's `env`, but the image pass passes its own
  // so its Assigns resolve in document order independently of the UI pass.
  // A "Merker": an Access=None parameter with no memory, used purely as a visibility
  // flag in choose conditions. ETS does NOT give it its static default; it is UNSET
  // until a ParameterRefRef placing it is reached in an active branch (which assigns the
  // ref's value). So a never-placed Merker reads as unset, its choose tests fail, and the
  // blocks it gates stay hidden, exactly as ETS leaves their parameter memory at the
  // segment default. Hardware-verified on the Theben HMG6T Notprogramm block (gated by a
  // Merker that is only placed when its real switch P-6 = 1; with P-6 = 0 the device
  // keeps those bytes at 0, which only this rule reproduces). Memory-backed or visible
  // parameters are unaffected and keep their default.
  const isMerker = (paramId: string): boolean => {
    const p = app.params.get(paramId);
    return !!p && p.access === "None" && !p.hasMemory;
  };
  // Several ParameterRefs of one Parameter share its single value. A ref's own Value is only the
  // default of the ref that is shown (placed in an active branch): ETS applies it when that ref is
  // placed, and a ref that a choose merely tests reads the same value (Jung 400021SE: P-505 has
  // R-107 with the parameter's default 5 and R-1 with Value 0; with R-107 placed, ETS evaluated a
  // choose on R-1 as 5, and its own project export stores no value for the parameter at all;
  // docs/findings.md §9). So the value is the placed ref's: one stored on a placed ref, else the
  // default of the placed ref. A value stored on a ref no active branch places is ETS's leftover from
  // an earlier configuration and is not written (Theben Meteodata full-download capture, ETS-programmed
  // Auros). A ref placed itself keeps its own default when no value is stored, and so does every ref
  // of a parameter whose placed refs carry different defaults: which one ETS would use is not known.
  // Only a parameter with no placed ref at all reads a value stored on its refs.
  //
  // `placement` (per instance-scoped parameter id, the def ref ids placed in active branches) is
  // fixed before the walks below, and all of them read the same one. It is found by walking the tree
  // until it no longer changes.
  let placement = new Map<string, Set<string>>();
  const refsOfParam = new Map<string, string[]>();
  for (const r of app.refs.values()) (refsOfParam.get(r.paramId) ?? refsOfParam.set(r.paramId, []).get(r.paramId)!).push(r.id);
  const storedOn = (refIds: string[], scope: Scope, e: Map<string, string>): string | undefined => {
    const vals = new Set(refIds.filter((r) => e.has(scope.rewrite(r))).map((r) => e.get(scope.rewrite(r))!));
    return vals.size === 1 ? [...vals][0] : undefined; // none, or conflicting: no shared stored value
  };
  // A union member none of whose refs is placed and none of which holds a stored value.
  const isUnplacedUnionMember = (defRefId: string, scope: Scope, e: Map<string, string>): boolean => {
    const ref = app.refs.get(defRefId);
    if (!ref || !app.params.get(ref.paramId)?.union) return false;
    if (placement.get(scope.rewrite(ref.paramId))?.size) return false;
    return !(refsOfParam.get(ref.paramId) ?? []).some((r) => e.has(scope.rewrite(r)));
  };
  const resolve = (defRefId: string, scope: Scope, e: Map<string, string> = env): string | undefined => {
    const instId = scope.rewrite(defRefId);
    const ref = app.refs.get(defRefId);
    if (!ref) return e.get(instId);
    if (isMerker(ref.paramId)) return e.get(instId); // unplaced Merker: no static default for choose evaluation
    const paramDefault = app.params.get(ref.paramId)?.value;
    const siblings = (refsOfParam.get(ref.paramId) ?? []).filter((r) => r !== defRefId);
    const placed = [...(placement.get(scope.rewrite(ref.paramId)) ?? [])];
    const isPlaced = placed.includes(defRefId);
    const placedSiblings = placed.filter((r) => r !== defRefId);
    if (isPlaced) {
      if (e.has(instId)) return e.get(instId);
      return storedOn(placedSiblings, scope, e) ?? ref.value ?? paramDefault;
    }
    if (placedSiblings.length) {
      const stored = storedOn(placedSiblings, scope, e);
      if (stored !== undefined) return stored;
      const defaults = new Set(placedSiblings.map((r) => app.refs.get(r)?.value ?? paramDefault));
      return defaults.size === 1 ? [...defaults][0] : ref.value ?? paramDefault;
    }
    return (e.has(instId) ? e.get(instId) : undefined) ?? storedOn(siblings, scope, e) ?? ref.value ?? paramDefault;
  };
  // Placing a ParameterRefRef to a Merker in an active branch assigns it (the ref's value
  // or the parameter default), so a later choose on that ref sees it as set. Document-order
  // walk guarantees the assignment precedes the read.
  const assignIfMerker = (defRefId: string, scope: Scope, e: Map<string, string>) => {
    const ref = app.refs.get(defRefId);
    if (ref && isMerker(ref.paramId)) e.set(scope.rewrite(defRefId), ref.value ?? app.params.get(ref.paramId)?.value ?? "");
  };
  const tr = (elemId: string | undefined, attr: string, base: string): string => {
    const t = !elemId || language === app.defaultLanguage ? base : app.translations.get(language)?.get(elemId)?.get(attr) ?? base;
    return decode(t);
  };
  const subst = (text: string, scope: Scope): string =>
    text.replace(/\{\{([^{}]+)\}\}/g, (m, k) => scope.textArgs.get(k) ?? m);
  // Tidy a display label: normalize newlines, drop the manufacturer's leading/
  // trailing whitespace (often a faux-indent), and upper-case the first letter in
  // the catalogue's language (some texts are authored lower-case). The leading faux-
  // indent is reattached separately (see app.paramFauxIndent / buildParam) so the
  // author's deliberate nesting still renders without leaking whitespace everywhere.
  const cap = (s: string): string => { const t = s.replace(/\r\n?/g, "\n").trim(); return t ? t.charAt(0).toLocaleUpperCase(language) + t.slice(1) : t; };

  // ETS evaluates EVERY matching <when> of a <choose>, not just the first. The
  // default branch fires only when no non-default test matches. This matters where a
  // single choose drives two independent overlapping placements: e.g. the Theben RMG 8 S
  // contact block has one choose on P-1 whose whens "0 1 3"/"2 4" place the contact-type
  // param (bits 0-1) AND whose whens "0 1"/"2 3 4" place a union member (bits 2-3), so
  // every P-1 value matches two whens and ETS places both. First-match-wins left the
  // union bits unwritten (hardware-confirmed on an RMG 8 S: P-1=0 -> UP-11=2, P-1=2 -> UP-12=0).
  const selectWhens = (defParamRefId: string, whens: DynWhen[], scope: Scope, e: Map<string, string> = env): DynWhen[] => {
    // A choose on a union member that no active branch places matches none of its tests: that
    // member holds no value, since its union's memory belongs to whichever member is placed (GVS
    // AMMA, ETS partial download: tests of 0 on the idle Forced/Delay/Counter members
    // placed no object in ETS). An unset Merker still reads as 0 here.
    if (isUnplacedUnionMember(defParamRefId, scope, e)) { const def = whens.find((w) => w.isDefault); return def ? [def] : []; }
    const v = Number(resolve(defParamRefId, scope, e) ?? 0);
    const matched = whens.filter((w) => !w.isDefault && w.test !== undefined && matchTest(w.test, v));
    if (matched.length) return matched;
    const def = whens.find((w) => w.isDefault);
    return def ? [def] : [];
  };

  // A parameter's label as ETS shows it: the ParameterRef's own Text where it declares a non-empty
  // one (in the view's language), else its Parameter's. An empty ref Text keeps the Parameter's:
  // whether ETS clears the label instead is not known, and dropping a label ETS shows would hide it. The ref's TextParameterRefId feeds the {{0}} /
  // {{0:default}} in it; a Parameter has no TextParameterRefId of its own. `fallbackTp` feeds a
  // ref that names none (a block headed by a parameter passes its own).
  const paramRefText = (defRefId: string, ref: CfgParamRef, param: CfgParam, scope: Scope, fallbackTp?: string): string => {
    const text = ref.text ? tr(defRefId, "Text", ref.text) : tr(param.id, "Text", param.text) || tr(defRefId, "Text", param.text);
    const tp = ref.textParamRefId ?? fallbackTp;
    return fillTextParam(subst(text, scope), tp ? resolve(tp, scope) ?? "" : undefined);
  };

  const buildParam = (defRefId: string, scope: Scope): CfgItem | null => {
    const ref = app.refs.get(defRefId);
    if (!ref) return null;
    const param = app.params.get(ref.paramId);
    if (!param) return null;
    // Access "None" parameters are internal/hidden in ETS; skip them.
    const access = ref.access ?? param.access ?? "ReadWrite";
    if (access === "None") return null;
    const type = app.types.get(param.typeId);
    const value = resolve(defRefId, scope) ?? "";
    // Reattach the author's leading-space faux-indent (the XML parser trimmed it). cap()
    // tidies the visible text; the preserved whitespace nests the row under the one above.
    const name = (app.paramFauxIndent.get(ref.text ? defRefId : param.id) ?? "") + cap(paramRefText(defRefId, ref, param, scope));
    const suffixText = ref.suffix !== undefined ? tr(defRefId, "SuffixText", ref.suffix) : param.suffix ? tr(param.id, "SuffixText", param.suffix) : "";
    const suffix = suffixText ? subst(suffixText, scope) : undefined;
    // TypeNone is a display-only element (no datapoint). A nameless one is a pure
    // ETS layout spacer with nothing to show or support; drop only that case. A
    // named one falls through and is shown (as an unsupported "Display" row).
    if (type?.kind === "TypeNone" && !name.trim()) return null;

    let control: CfgParamView["control"] = "unsupported";
    let options: CfgParamView["options"];
    if (type?.base === "Value" && type.enums.length) {
      control = "enum";
      options = type.enums.map((e) => ({ value: e.value, text: tr(e.id, "Text", e.text) }));
    } else if (type?.base === "Number") control = "number";
    // TypeFloat (KNX 2-byte DPT-9 / 4-byte DPT-14): a decimal number. Reuse the number
    // control but allow decimal entry (frontend uses step="any"); the image codec already
    // encodes it as a float. Clamp to the type's min/max like any number.
    else if (type?.base === "Float") control = "number";
    else if (type?.base === "Text") control = "text";
    // TypeColor stores an #RRGGBB hex. Only the RGB space maps directly to the
    // native sRGB colour picker; HSV (and any other space) stays unsupported
    // until its encoding is verified, so we never write a wrong colour back.
    else if (type?.base === "Color" && type.colorSpace === "RGB") control = "color";
    // TypeTime: a raw integer count of `unit` (e.g. Seconds), encoded as an integer in
    // the image. The frontend renders an hh:mm:ss duration for second-based units, else a
    // number + unit input.
    else if (type?.base === "Time") control = "time";
    // TypeIPAddress: a dotted-quad host address; validated text input, 4-byte codec.
    else if (type?.base === "IPAddress") control = "ip";
    // A named TypeNone is a display-only caption/heading (no datapoint): show it as a
    // read-only label, not an "unsupported" warning. Nameless ones are dropped above.
    else if (type?.kind === "TypeNone") control = "display";

    const defaultValue = ref.value ?? param.value ?? "";
    const typeLabel = control === "unsupported" ? unsupportedTypeLabel(type) : undefined;
    // ETS spinner step / slider hint live on the TypeNumber; a slider needs a
    // bounded range to render, so fall back to the plain number input without one.
    const step = control === "number" ? type?.increment : undefined;
    const slider = control === "number" && type?.uiHint === "Slider" && type.min !== undefined && type.max !== undefined;
    const unit = control === "time" ? type?.unit : undefined;
    // A float number accepts decimals; the frontend uses step="any" so the browser does
    // not reject a fractional value against an integer step grid.
    const float = type?.base === "Float" || undefined;
    return { kind: "param", param: { refId: scope.rewrite(defRefId), name, control, value, options, min: type?.min, max: type?.max, suffix, step, slider, unit, float, readOnly: access === "Read" || control === "display", defaultValue, typeLabel } };
  };

  // Resolve just the table-relevant facts of a com-object (number with the module
  // instance base applied, datapoint size, flags with ComObjectRef overrides applied).
  // Shared by the visible build and the image (L3) pass so both agree on the numbering.
  const resolveComObjImage = (defRefId: string, scope: Scope): CfgComObjImage | null => {
    const ref = app.comObjectRefs.get(defRefId);
    const obj = ref ? app.comObjects.get(ref.refId) : app.comObjects.get(defRefId);
    if (!obj) return null;
    return {
      number: obj.number + (obj.baseNumber ? scope.argValue(obj.baseNumber) : 0),
      objectSize: ref?.objectSize ?? obj.objectSize,
      flags: { ...obj.flags, ...ref?.flags },
      priority: ref?.priority ?? obj.priority, // a ref overrides only when it states one
      refId: scope.rewrite(defRefId),
    };
  };

  const buildComObj = (defRefId: string, scope: Scope): CfgItem | null => {
    const ref = app.comObjectRefs.get(defRefId);
    const obj = ref ? app.comObjects.get(ref.refId) : app.comObjects.get(defRefId);
    if (!obj) return null;
    const pick = (r: string | undefined, o: string) => (r !== undefined ? r : o);
    const textParamRefId = ref?.textParamRefId ?? obj.textParamRefId;
    const fill = (s: string) => fillTextParam(subst(s, scope), textParamRefId ? resolve(textParamRefId, scope) ?? "" : undefined);
    const elem = ref?.id ?? obj.id;
    const img = resolveComObjImage(defRefId, scope)!; // obj exists (guarded above)
    return {
      kind: "comObject",
      comObject: {
        refId: img.refId,
        number: img.number,
        name: fill(tr(elem, "Text", pick(ref?.text, obj.text)) || obj.name),
        functionText: fill(tr(elem, "FunctionText", pick(ref?.functionText, obj.functionText))),
        objectSize: img.objectSize,
        dpt: pick(ref?.dpt, obj.dpt),
        flags: img.flags,
      },
    };
  };

  // Build the per-instance scope: rewrite def ids -> instance ids, collect text
  // and numeric arguments from the instance's pinned values.
  const makeScope = (moduleNodeRefId: string, def: ModuleDefModel, inst: ModuleInstance): Scope => {
    const instFullId = `${app.id}_${inst.id}`;
    const textArgs = new Map<string, string>();
    const argMap = new Map<string, number>();
    for (const a of inst.args) {
      const fullArgId = `${app.id}_${a.refId}`;
      const defArg = def.args.find((d) => d.id === fullArgId);
      if (defArg) textArgs.set(defArg.name, a.value); // any arg can appear in {{name}} text
      argMap.set(fullArgId, Number(a.value));         // numeric base for com-object numbering (NaN for text args, unused)
    }
    return {
      // Match on the id boundary ("_") so MD-1 never wrongly captures MD-10's ids.
      rewrite: (id) => (id.startsWith(`${moduleNodeRefId}_`) ? instFullId + id.slice(moduleNodeRefId.length) : id),
      textArgs,
      // Only consulted when a com-object declares a BaseNumber argument. A missing or
      // non-numeric argument used to fall back to 0, silently renumbering the instance's
      // com-objects onto channel 1's numbers (colliding entries then overwrite each other
      // in the image tables). Unknown numbering must refuse, not guess.
      argValue: (argId) => {
        const v = argMap.get(argId);
        if (v === undefined || Number.isNaN(v)) {
          throw new ProductError("COMOBJ_ARG_UNRESOLVED",
            `module instance ${inst.id}: com-object numbering needs argument ${argId}, which the instance does not carry (or it is not numeric)`);
        }
        return v;
      },
    };
  };
  const instancesFor = (moduleNodeId: string) => instances.filter((mi) => `${app.id}_${mi.refId}` === moduleNodeId);

  // Walk a node sequence in order, appending items to the current block. Active
  // choose branches inline their items; Assign mutates env; Module nodes expand
  // each device instance with its own scope.
  const collect = (nodes: DynNode[], items: CfgItem[], scope: Scope) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "separator": items.push({ kind: "separator", text: fillTextParam(subst(tr(n.id, "Text", n.text), scope), n.textParamRefId ? resolve(n.textParamRefId, scope) ?? "" : undefined), uiHint: n.uiHint, cell: n.cell }); break;
        case "paramRef": { assignIfMerker(n.refId, scope, env); const it = buildParam(n.refId, scope); if (it) { if (it.kind === "param" && n.indent) it.param.indent = n.indent; if (it.kind === "param") it.cell = n.cell; items.push(it); } break; }
        case "comObjRef": { const it = buildComObj(n.refId, scope); if (it) items.push(it); break; }
        // A scripted action. Carried through as itself (label + handler name) so the UI
        // can show an inert, honestly-labelled control; busforge never runs the script.
        case "button": items.push({ kind: "button", button: { text: subst(tr(n.id, "Text", n.text), scope), handler: n.handler }, cell: n.cell }); break;
        case "assign": env.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope) ?? "" : "")); break;
        case "choose": { for (const w of selectWhens(n.paramRefId, n.whens, scope)) collect(w.children, items, scope); break; }
        case "container": collect(n.children, items, scope); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) collect(def.dynamic, items, makeScope(n.refId, def, inst)); break; }
        case "unsupported": items.push({ kind: "unsupported", label: n.tag }); break; // surface, never drop
        // Nested blocks become their own sections (handled by walk, which also runs a hidden
        // block's Merker/Assign side effects via applyEnv). Known limit: a hidden block nested
        // DIRECTLY inside a visible ParameterBlock is not descended here, so a Merker it places
        // would read stale for a choose collected at this same visible level. No device authored
        // that way is known (Jung/HMG place the hidden block at container/top level, where walk
        // orders it correctly). Should one leave the view's objects different from the image's,
        // the configuration is refused (CONFIG_VIEW_INCOMPLETE below), not shown short.
        case "block": break;
      }
    }
  };

  // A ParameterBlock heading comes from its own (translatable) Text, or, when it
  // has none, from a referenced parameter's text (a common manufacturer pattern,
  // e.g. Theben push-buttons); only then fall back to the language-independent Name.
  const blockTitle = (n: Extract<DynNode, { kind: "block" }>, scope: Scope): string => {
    const fill = (t: string) => fillTextParam(subst(t, scope), n.textParamRefId ? resolve(n.textParamRefId, scope) ?? "" : undefined);
    const own = tr(n.id, "Text", n.text);
    if (own) return fill(own);
    const ref = n.paramRefId ? app.refs.get(n.paramRefId) : undefined;
    const param = ref ? app.params.get(ref.paramId) : undefined;
    if (ref && param) {
      const t = paramRefText(n.paramRefId!, ref, param, scope, n.textParamRefId);
      if (t) return t;
    }
    return fill(n.name);
  };

  // Build the section tree in document order (so Assign side effects and choose
  // visibility evaluate exactly as authored), then order each set of siblings the
  // way ETS does: by the DisplayOrder of the block's heading parameter, not by
  // document order. A block with its own items is a nesting parent (channels are
  // level 0, their sub-blocks level 1); an item-less block stays transparent.
  interface Node { block: CfgBlock; order: number; seq: number; children: Node[] }
  let seq = 0;
  const headOrder = (n: Extract<DynNode, { kind: "block" }>): number =>
    (n.paramRefId ? app.refs.get(n.paramRefId)?.displayOrder : undefined) ?? 0;

  // The block's declared grid geometry, with the Table header captions localized. Only
  // emitted for a Grid/Table block; a plain list block carries none.
  const gridOf = (n: Extract<DynNode, { kind: "block" }>, scope: Scope): Pick<CfgBlock, "layout" | "rows" | "cols"> => {
    if (!n.layout) return {};
    const lines = (ls: typeof n.rows): CfgGridLine[] | undefined =>
      ls?.map((l) => ({ text: l.text !== undefined ? subst(tr(l.id, "Text", l.text), scope) : undefined, width: l.width }));
    return { layout: n.layout, rows: lines(n.rows), cols: lines(n.cols) };
  };

  // A block marked Access="None" is not shown, but its side effects on `env` still matter: a
  // manufacturer often computes a "Merker" helper parameter (or Assigns one) inside an invisible
  // block and then gates a later, VISIBLE choose on it. The Jung 400021SE hides its whole channel set
  // exactly this way ("Kanal N anzeigen" is a Merker computed in the "Unsichtbar" block, and every
  // channel's module hangs off a choose on it), so skipping the block wholesale left the Merker unset
  // and every channel hidden. Run the env-mutating side effects of an invisible subtree (Merker
  // assignments and Assigns) in document order, descending into blocks regardless of access, emitting
  // no parameter. Same choose selection and value resolution as the display walk, so a later choose
  // reads exactly the env it should (the image pass does the equivalent via imgEnv).
  // The block's communication objects stay active (ETS links them and its tables hold them: the MIX 2
  // "Gemeinsame Objekte" block), so they go to `objects`, the section that encloses the block.
  const applyEnv = (nodes: DynNode[], scope: Scope, objects: CfgItem[]) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "paramRef": assignIfMerker(n.refId, scope, env); break;
        case "assign": env.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope) ?? "" : "")); break;
        case "choose": for (const w of selectWhens(n.paramRefId, n.whens, scope)) applyEnv(w.children, scope, objects); break;
        case "container": case "block": applyEnv(n.children, scope, objects); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) applyEnv(def.dynamic, makeScope(n.refId, def, inst), objects); break; }
        case "comObjRef": { const it = buildComObj(n.refId, scope); if (it) objects.push(it); break; }
        case "separator": case "button": case "unsupported": break;
      }
    }
  };

  // `loose` receives the leaves placed outside every ParameterBlock: a ComObjectRefRef or
  // ParameterRefRef directly under a <Channel> or ChannelIndependentBlock (Theben places its
  // measured-value objects there; ETS lists them and its tables link them). Inside a block it is
  // null, because collect() has already gathered that block's leaves, nested containers included.
  // `section` is the items of the nearest enclosing section, where a hidden block's objects go.
  const walk = (nodes: DynNode[], scope: Scope, into: Node[], loose: CfgItem[] | null, section: CfgItem[]) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "block": {
          if (n.access === "None") { applyEnv(n.children, scope, section); break; } // hidden, but its Merker/Assign side effects still gate later chooses
          const items: CfgItem[] = [];
          collect(n.children, items, scope);
          if (items.length) {
            const name = blockTitle(n, scope);
            const node: Node = { block: { id: scope.rewrite(n.id), name: cap(name), items, level: 0, ...gridOf(n, scope) }, order: headOrder(n), seq: seq++, children: [] };
            into.push(node);
            walk(n.children, scope, node.children, null, items);
          } else if (n.children.length === 0 && (n.paramRefId || n.text)) {
            // A reached but childless block is a pure category header (e.g. the
            // "Scene" section): ETS shows it as a navigable node, so emit it as an
            // empty section rather than dropping it. (Headers in inactive choose
            // branches are never reached, so this adds no noise.)
            const name = cap(blockTitle(n, scope));
            if (name) into.push({ block: { id: scope.rewrite(n.id), name, items: [], level: 0 }, order: headOrder(n), seq: seq++, children: [] });
          } else {
            walk(n.children, scope, into, null, section); // transparent wrapper: children keep this level; its leaves are none (collect found no items)
          }
          break;
        }
        case "container": {
          // A Channel with a heading text becomes a navigable section (e.g.
          // "GRUNDMODUL {{0}}" -> "Basic module HMG 6 T"); {{0}} is the channel's
          // TextParameterRefId value, else its Number (see fillTextParam). A text-less container
          // (ChannelIndependentBlock, Repeat, generic Channel) stays transparent.
          // Its own leaves (outside every ParameterBlock) become the section's items; a text-less
          // container gets a section of its own, named by its Name, only when it has such leaves.
          const heading = n.text.trim();
          const own: CfgItem[] | null = loose === null ? null : [];
          if (heading) {
            const name = cap(fillTextParam(subst(n.text, scope), (n.textParamRefId ? resolve(n.textParamRefId, scope) : undefined) ?? n.number ?? ""));
            const items = own ?? [];
            const node: Node = { block: { id: scope.rewrite(n.id), name, items, level: 0 }, order: n.number ? Number(n.number) : 0, seq: seq++, children: [] };
            into.push(node);
            walk(n.children, scope, node.children, own, items);
          } else {
            const at = into.length, mySeq = seq++;
            walk(n.children, scope, into, own, own ?? section);
            // A ChannelIndependentBlock carries no Id or Name; its section is keyed by its place.
            if (own?.length) into.splice(at, 0, { block: { id: scope.rewrite(n.id || `${app.id}_CIB-${mySeq}`), name: cap(subst(n.name, scope)), items: own, level: 0 }, order: n.number ? Number(n.number) : 0, seq: mySeq, children: [] });
          }
          break;
        }
        case "choose": { for (const w of selectWhens(n.paramRefId, n.whens, scope)) walk(w.children, scope, into, loose, section); break; }
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) walk(def.dynamic, makeScope(n.refId, def, inst), into, loose, section); break; }
        // Leaves: inside a block collect() has gathered them; outside every block they belong to the
        // enclosing container. Listed rather than defaulted, so that a node kind added later shows up
        // as a compile error here instead of vanishing from the UI.
        case "paramRef": case "comObjRef": case "separator": case "button": case "assign": case "unsupported":
          if (loose) collect([n], loose, scope);
          break;
      }
    }
  };
  // The placement the walks read (see resolve): the image pass's traversal, recording only which
  // refs it places, repeated until the placement it finds is the one it walked with.
  const findPlacement = (): Map<string, Set<string>> => {
    const found = new Map<string, Set<string>>();
    const penv = new Map(overrides);
    const visit = (nodes: DynNode[], scope: Scope) => {
      for (const n of nodes) {
        switch (n.kind) {
          case "paramRef": {
            const ref = app.refs.get(n.refId);
            if (ref) { const key = scope.rewrite(ref.paramId); (found.get(key) ?? found.set(key, new Set()).get(key)!).add(n.refId); }
            assignIfMerker(n.refId, scope, penv);
            break;
          }
          case "assign": penv.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope, penv) ?? "" : "")); break;
          case "choose": for (const w of selectWhens(n.paramRefId, n.whens, scope, penv)) visit(w.children, scope); break;
          case "container": case "block": visit(n.children, scope); break;
          case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) visit(def.dynamic, makeScope(n.refId, def, inst)); break; }
          case "comObjRef": case "button": case "separator": case "unsupported": break;
        }
      }
    };
    visit(app.dynamic, TOP);
    return found;
  };
  const samePlacement = (a: Map<string, Set<string>>, b: Map<string, Set<string>>) =>
    a.size === b.size && [...a].every(([k, v]) => { const w = b.get(k); return !!w && w.size === v.size && [...v].every((x) => w.has(x)); });
  // A placement seen before without having settled is a cycle: the application admits no single
  // reading of its shared values, and picking one of the cycle's states would be a guess.
  const seen: Map<string, Set<string>>[] = [];
  for (;;) {
    const next = findPlacement();
    if (samePlacement(next, placement)) break;
    if (seen.some((p) => samePlacement(p, next))) {
      throw new ProductError("CONFIG_NOT_RESOLVABLE", "the application's parameter visibility does not settle: which parameter references are active keeps changing with the values they share");
    }
    seen.push(placement);
    placement = next;
  }

  const roots: Node[] = [];
  const outsideEveryContainer: CfgItem[] = [];
  walk(app.dynamic, TOP, roots, outsideEveryContainer, outsideEveryContainer);
  // The schema places leaves only inside a Channel, a ChannelIndependentBlock or a ParameterBlock.
  // One outside all of them has no section ETS would show it in: refuse rather than drop it.
  if (outsideEveryContainer.length) {
    throw new ProductError("CONFIG_VIEW_INCOMPLETE", `the application places ${outsideEveryContainer.map((it) => it.kind).join(", ")} outside every channel and parameter block, where the view has no section for it`);
  }

  // Image values: the value ETS writes for EVERY parameter reached in the active
  // dynamic tree, including Access="None" internal params (hidden from the UI walk
  // above, but still written to memory) and the params inside Access="None" blocks.
  // Same choose/when selection and value resolution as the UI; no Access filtering.
  // Internal params often select their value through which ParameterRef the active
  // branch references (refs carry distinct Value attributes), so this must visit the
  // reachable paramRef nodes, not just the displayed ones.
  // Its own working map (not the UI walk's `env`): Assigns and choose conditions must
  // resolve in this pass's own document order, not against the already-fully-mutated
  // UI env (which would mis-select branches controlled by a later Assign).
  const imageValues = new Map<string, string>();
  const imageComObjects = new Map<number, CfgComObjImage>();
  const imgEnv = new Map(overrides);
  const imgCollect = (nodes: DynNode[], scope: Scope) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "paramRef": { if (scope === TOP) place(n.refId, false); assignIfMerker(n.refId, scope, imgEnv); const v = resolve(n.refId, scope, imgEnv); if (v !== undefined) imageValues.set(scope.rewrite(n.refId), v); break; }
        // Record EVERY reached com-object (active branches, descending into Access="None"
        // blocks, per module instance) with its resolved flags, so the com-object-table
        // build sees hidden objects' flags too. Keyed by resolved number; a later active
        // placement overrides an earlier one (document order), matching what ETS compiles.
        case "comObjRef": { const c = resolveComObjImage(n.refId, scope); if (c) imageComObjects.set(c.number, c); break; }
        // An <Assign> sets the target parameter's value, and ETS writes that value to the
        // target's memory even if the target's own ParameterRef is only placed in an
        // inactive branch (a common pattern: assign a hidden Access="None" param from a
        // visible one in branch A, place it in branch B). So the assigned value belongs in
        // imageValues, not just imgEnv. Non-memory targets (Merker) have no offset and are
        // ignored by the image build. Hardware-confirmed on a Steinel M-0083 device: P-26
        // SendFallingOnInit is assigned from P-1 SendRisingOnInit and written to bit 4.
        // A UNION-member target is NOT recorded: union branches overlap one region and the
        // image build owns a union byte only for the actively-placed branch, so injecting an
        // assigned alternative would let two members claim the same byte (the relative
        // builder iterates refs unordered). The active branch's own placement still writes it.
        case "assign": {
          const tid = scope.rewrite(n.target);
          const av = n.value ?? (n.source ? resolve(n.source, scope, imgEnv) ?? "" : "");
          imgEnv.set(tid, av);
          if (!app.params.get(app.refs.get(n.target)?.paramId ?? "")?.union) imageValues.set(tid, av);
          break;
        }
        case "choose": {
          const taken = selectWhens(n.paramRefId, n.whens, scope, imgEnv);
          if (scope === TOP) {
            const evaluated = resolve(n.paramRefId, scope, imgEnv) !== undefined;
            for (const w of n.whens) if (!taken.includes(w)) placements(w.children, evaluated);
          }
          for (const w of taken) imgCollect(w.children, scope);
          break;
        }
        // A Button owns no memory (it only names a script action), so it contributes
        // nothing to the image. A Grid/Table block is a layout, not a memory scope: its
        // <Rows>/<Columns> hold no parameters, and the placed items are the ordinary
        // paramRef/comObjRef children walked here, exactly as in a list block.
        case "button": break;
        case "container": case "block": imgCollect(n.children, scope); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) imgCollect(def.dynamic, makeScope(n.refId, def, inst)); break; }
        // Neither owns a byte of the parameter image: a separator is a caption, and an unsupported
        // node is one the config layer already refuses to render. Listed rather than defaulted, so
        // a node kind added later cannot silently drop out of the image the device is programmed
        // with — the one place where a missing value is a wrong device, not a missing label.
        case "separator": case "unsupported": break;
      }
    }
  };
  // Each top-level ParameterRef's placements: reached, or in a branch not taken (rejected when its
  // choose was evaluated). Everything inside a branch not taken counts as that branch.
  const placedRejected = new Map<string, boolean>();
  const place = (refId: string, rejected: boolean) => placedRejected.set(refId, (placedRejected.get(refId) ?? true) && rejected);
  const placements = (nodes: DynNode[], rejected: boolean) => {
    for (const n of nodes) {
      if (n.kind === "paramRef") place(n.refId, rejected);
      else if (n.kind === "container" || n.kind === "block") placements(n.children, rejected);
      else if (n.kind === "choose") for (const w of n.whens) placements(w.children, rejected);
    }
  };
  imgCollect(app.dynamic, TOP);
  const rejectedRefs = new Set([...placedRejected].filter(([, rejected]) => rejected).map(([r]) => r));

  // The com-object TABLE length the firmware needs: the highest com-object number the app DECLARES,
  // active or not. imageComObjects is choose-gated (it only sees the objects the current config
  // reaches), but the firmware's group-object array is sized to the DECLARATION: a table shorter than
  // the highest declared number lets the unbounded getGroupObject(n) read off the end of the heap on
  // boot (hardware-proven: the OpenKNX RaumController death-loops and reverts to factory when the table
  // claims 138 objects and a module addresses object 1359).
  //
  // A flat (top-level) com-object's declared Number IS its on-device number, so take it straight from
  // the declaration — independent of whether any dynamic node places it, so a declared-but-unreferenced
  // object can never shorten the table. A module (BaseNumber) com-object only acquires a device number
  // inside an instance scope (its Number plus the instance's BaseNumber), so those are resolved by
  // walking each module instance, in a scope where every argument is present (no unresolved-arg abort).
  // Every branch is walked, not selectWhens: an object placed only under an inactive choose still sizes
  // the table, because the firmware indexes by number regardless of the active configuration.
  let maxComObjectNumber = 0;
  for (const o of app.comObjects.values()) if (!o.baseNumber) maxComObjectNumber = Math.max(maxComObjectNumber, o.number);
  const scanModuleComObjNums = (nodes: DynNode[], scope: Scope, inModule: boolean) => {
    for (const n of nodes) {
      switch (n.kind) {
        // Only record inside a module instance: top-level (flat) numbers are covered by the declaration
        // scan above, and resolving them here would risk a BaseNumber that only makes sense per instance.
        case "comObjRef": { if (inModule) { const c = resolveComObjImage(n.refId, scope); if (c) maxComObjectNumber = Math.max(maxComObjectNumber, c.number); } break; }
        case "choose": for (const w of n.whens) scanModuleComObjNums(w.children, scope, inModule); break; // every branch, not selectWhens
        case "container": case "block": scanModuleComObjNums(n.children, scope, inModule); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) scanModuleComObjNums(def.dynamic, makeScope(n.refId, def, inst), true); break; }
        // Own no com-object number. Listed, not defaulted, so a new node kind is a compile error here.
        case "paramRef": case "separator": case "button": case "assign": case "unsupported": break;
      }
    }
  };
  scanModuleComObjNums(app.dynamic, TOP, false);

  // Stable sort each sibling list by DisplayOrder (equal/missing keeps document order).
  const blocks: CfgBlock[] = [];
  const emit = (nodes: Node[], level: number, parentId?: string) => {
    nodes.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    for (const node of nodes) {
      node.block.level = level;
      node.block.parentId = parentId;
      blocks.push(node.block);
      emit(node.children, level + 1, node.block.id);
    }
  };
  emit(roots, 0);

  // Links are resolved against the view, by reference: an active object the view does not list would
  // lose its links without a word, and one it lists that the image pass does not reach would take links
  // no table holds. Either mismatch refuses the configuration.
  const listedNums = new Set<number>(), listedRefs = new Set<string>();
  for (const b of blocks) for (const it of b.items) if (it.kind === "comObject") { listedNums.add(it.comObject.number); listedRefs.add(it.comObject.refId); }
  const unlisted = [...imageComObjects.values()].filter((o) => !listedRefs.has(o.refId)).map((o) => o.number);
  const inactive = [...listedNums].filter((n) => !imageComObjects.has(n));
  if (unlisted.length || inactive.length) {
    throw new ProductError("CONFIG_VIEW_INCOMPLETE", `the configuration view does not match the active communication objects (not listed: ${unlisted.slice(0, 10).join(", ") || "none"}; listed but inactive: ${inactive.slice(0, 10).join(", ") || "none"}); their links would be lost`);
  }

  return { blocks, hasModules: app.hasModules, dca: app.dca, imageValues, rejectedRefs, imageComObjects, maxComObjectNumber, paramValue: (refId) => resolve(refId, TOP) };
}

// One com-object of an application program's full declaration, resolved the way the
// config view resolves it (ComObjectRef overrides applied over the base ComObject).
export interface ComObjUniverseEntry {
  refId: string; number: number; name: string; functionText: string;
  dpt: string; objectSize: string; flags: ComObjFlags;
}

// The display texts of one top-level ComObjectRef outside the config view (an object the view does
// not reach): translated like buildComObj, its {{0}} / {{0:default}} fed by the value `valueOf` gives
// for the TextParameterRefId (a device's DeviceConfigBuild.paramValue), else by that parameter's
// default (ref value over param value), which is what an override-free device holds. Undefined for
// a dangling ref.
export function comObjectRefTexts(app: AppConfig, fullRefId: string, lang?: string, valueOf?: (refId: string) => string | undefined): { name: string; functionText: string } | undefined {
  const ref = app.comObjectRefs.get(fullRefId);
  const obj = ref ? app.comObjects.get(ref.refId) : undefined;
  if (!ref || !obj) return undefined;
  const language = resolveLanguage(app, lang);
  const tr = (attr: string, base: string): string =>
    decode(language === app.defaultLanguage ? base : app.translations.get(language)?.get(fullRefId)?.get(attr) ?? base);
  const tpRef = ref.textParamRefId ?? obj.textParamRefId;
  const tp = tpRef ? app.refs.get(tpRef) : undefined;
  const value = tpRef ? valueOf?.(tpRef) ?? (tp ? tp.value ?? app.params.get(tp.paramId)?.value : undefined) ?? "" : undefined;
  return {
    name: fillTextParam(tr("Text", ref.text ?? obj.text) || obj.name, value),
    functionText: fillTextParam(tr("FunctionText", ref.functionText ?? obj.functionText), value),
  };
}

// The COMPLETE com-object universe of an application program: one entry per
// ComObjectRef, deliberately NOT gated by parameter visibility. A stored GA link may
// legitimately target an object that only becomes visible once channel parameters are
// set (the GA-preserve semantics), so a link-mapping UI must see every object the app
// declares, not just the ones the default configuration shows.
//
// Resolution mirrors buildComObj/resolveComObjImage above (same precedence, same
// translation lookup); `lang` resolves like the config view's (default = the
// catalogue's own language). A {{0}} / {{0:default}} text placeholder resolves against its
// TextParameterRef's DEFAULT value: with no device there are no overrides.
//
// Module-def applications are REFUSED, not listed incompletely: their real
// com-objects exist only per module instance (synthetic per-instance ref ids,
// BaseNumber-shifted numbers), so a flat listing would offer template refs no placed
// device ever carries and silently omit the instances a device actually has.
export function comObjectUniverse(app: AppConfig, lang?: string): ComObjUniverseEntry[] {
  // A ModuleDef ALONE does not make the com-objects per-instance: an app may carry an unused
  // ModuleDef stub yet expand every channel to flat, top-level com-objects at generation time
  // (OpenKNX's RaumController does exactly this, see docs/commissioning.md). What actually forces
  // per-instance objects is a com-object whose number is BaseNumber-relative, resolvable only
  // inside a module instance. So refuse only when such an object really exists, not merely
  // because `hasModules` is set; otherwise a whole family of enumerable apps is refused wrongly.
  const perInstance = [...app.comObjectRefs.values()].some((ref) => app.comObjects.get(ref.refId)?.baseNumber);
  if (perInstance) {
    throw new ProductError("COMOBJ_UNIVERSE_MODULES_UNSUPPORTED",
      "this application program builds its com-objects from channel modules; enumerating their per-instance objects is not supported yet, refusing to return an incomplete list");
  }
  const out: ComObjUniverseEntry[] = [];
  for (const [fullId, ref] of app.comObjectRefs) {
    const obj = app.comObjects.get(ref.refId);
    // A dangling ComObjectRef cannot appear on any device (buildComObj skips it the
    // same way), so it is not part of the universe.
    if (!obj) continue;
    // A BaseNumber can only be satisfied inside a module instance; at top level it is
    // a malformed catalogue. Same refusal the config view's TOP scope raises.
    if (obj.baseNumber) {
      throw new ProductError("COMOBJ_ARG_UNRESOLVED",
        `com-object ${obj.id} numbering references module argument ${obj.baseNumber} outside any module instance`);
    }
    out.push({
      refId: fullId,
      number: obj.number,
      ...comObjectRefTexts(app, fullId, lang)!,
      dpt: ref.dpt ?? obj.dpt,
      objectSize: ref.objectSize ?? obj.objectSize,
      flags: { ...obj.flags, ...ref.flags },
    });
  }
  return out;
}
