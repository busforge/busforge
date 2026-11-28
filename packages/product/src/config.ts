import type { ConstantDifference } from "./deviceimage.ts";
import { isSubModuleInstance, moduleInstanceArgLookup, moduleInstanceArgNumber, resolveParamDefault, resolveParamRef, type AppConfig, type CfgParam, type CfgParamRef, type CfgType, type ComObjFlags, type ComObjPriority, type DcaInfo, type DynNode, type DynWhen, type ModuleDefModel, type ModuleInstance, type ParamArgLookup } from "./appconfig.ts";
import { resolveModuleInstances } from "./modules.ts";
import { ProductError } from "./errors.ts";
import type { MatrixOperation, OperationVerdict } from "./compatibility.ts";
import {
  buildRefsOfParam,
  emptyPlacement,
  holdsValue,
  isChooseSkipped,
  isSkippedRepeat,
  recordPlacedRef,
  resolveParamValue,
  samePlacement,
  selectChooseWhens,
  unsettledDefaultRefusal,
  type ChooseContext,
  type ChoosePlacement,
} from "./choose.ts";

export { validateTest, matchTest, defaultBranchOf, chooseSkipsTests, unsettledDefaultRefusal, repeatCountOf, isSkippedRepeat } from "./choose.ts";

// A human label for a datapoint type the engine cannot edit yet, shown on the
// "not supported" row so the gap is explicit (never a blank/empty control).
function unsupportedTypeLabel(type: CfgType | undefined): string {
  const byTag: Record<string, string> = {
    TypeFloat: "Float", TypeTime: "Time",
    TypeIPAddress: "IP address", TypeNone: "Display", TypePicture: "Picture naming no image",
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
  control: "enum" | "number" | "text" | "color" | "time" | "ip" | "display" | "picture" | "unsupported";
  value: string;
  options?: { value: number; text: string }[];
  min?: number;
  max?: number;
  suffix?: string;
  step?: number; // number spinner step (ETS Increment)
  slider?: boolean; // ETS UIHint="Slider": render a range slider (needs min+max)
  checkbox?: boolean; // ETS UIHint="CheckBox" on a 0..1 range: 1 is ticked, 0 unticked
  unit?: string; // for control "time": the TypeTime Unit (e.g. "Seconds") the raw value counts
  float?: boolean; // control "number" backing a TypeFloat: accept decimal input (step="any")
  readOnly?: boolean;
  changed?: boolean; // differs from the programmed baseline; filled in by the server
  defaultValue?: string; // value with no user override (ref/param default), for change detection
  typeLabel?: string; // for control "unsupported": a human label of the datapoint type we can't edit yet
  // For control "picture" (ETS TypePicture): the product Baggage id of the image, its HorizontalAlignment,
  // and where the image is served, set by the server only when the catalogue holds its file.
  picture?: { baggageId: string; align?: string; url?: string };
  indent?: number; // ETS IndentLevel of the row within its block (1 or 2)
  // The parameter has neither a memory nor a property location: the device does not hold it, so no
  // read-back recovers it (a read-back can only be asked to assume its value).
  memoryless?: true;
  // The value shown is one a read-back took as assumed and the device could not tell from another value
  // of the parameter (DeviceReadbackInfo.unprovenAssumptions): the baseline holds it, the device never
  // showed it. Filled in by the server, only while the project holds that value.
  assumed?: true;
  // The baseline (the state last read from or programmed onto the device) holds this value, which is
  // no value of the parameter's type: no option of its enumeration, or a number outside its bounds.
  // Shown as such, never taken into the project. Filled in by the server.
  baseOutsideType?: string;
  // The parameter is an input or a result of the application's <ParameterCalculation>s: one mark per calculation
  // (calculations.ts annotateCalculations). Filled in by the server.
  calculations?: CfgCalculationMark[];
}
// computed: Busforge ran the script and builds the image with its results. defaults: every input is at its default,
// so the results keep the values the configuration stores, as ETS keeps them. refused: Busforge does not run the
// calculation and computes none of its results; `refusal` says why by code, which the app names in the user's
// language, `reason` the same in English.
export type CalcState = { state: "computed" | "defaults"; reason?: undefined; refusal?: undefined } | { state: "refused"; reason: string; refusal: CalcRefusal };
export type CfgCalculationMark = CalcState & {
  name: string; // the calculation's Name, else its Id
  role: "input" | "result";
  // A parameter on the other side of the calculation has memory, lies in a property or decides what the configuration
  // places: where Busforge does not run the calculation, a write that changes this parameter is refused.
  otherSideReaches: boolean;
  // A result: the value Busforge builds the image with for this parameter (absent where the calculation is refused).
  // A row the user can edit keeps the value the project stores, which can differ.
  value?: string;
  // Each result: the value Busforge builds the image with (absent where the calculation is refused), and whether an
  // active branch of the configuration places it.
  results: { refId: string; name: string; value?: string; placed: boolean }[];
};
// Why Busforge does not run a <ParameterCalculation> (calculations.ts staticRefusal and its run), with the values its
// text names: func, detail, ref, type, name, value.
export type CalcRefusalCode =
  | "lrFunc" | "noScript" | "numericCharRef" | "scriptOutside" | "paramMissing" | "paramType" | "noVariable" | "sharedVariable"
  | "resultInProperty" | "resultSteers" | "inputNotNumeric" | "numberForText" | "textForNumber" | "notFinite" | "outsideRange"
  | "typeRejects" | "resultUnset" | "scriptFailed" | "clash" | "unsettled";
export interface CalcRefusal { code: CalcRefusalCode; params?: Record<string, string> }
export interface CfgComObjView {
  refId: string; number: number; name: string; functionText: string;
  objectSize: string; dpt: string; flags: ComObjFlags; priority: ComObjPriority;
  gaRaw?: number | null; // current GA link, filled in by the server from stored links
  gaRaws?: number[];     // every linked GA, in link order (gaRaw is the first); filled in by the server
  changed?: boolean; // GA link differs from the programmed baseline; filled in by the server
  // The flags the project sets differently from the application (ComObjectInstanceRef); `flags`
  // then carries them. Filled in by the server (effectiveComObjFlags).
  overriddenFlags?: (keyof ComObjFlags)[];
  overriddenPriority?: boolean; // as overriddenFlags, for `priority`
  // The flags or priority the project sets differ from the ones the device was last written with;
  // filled in by the server.
  flagsChanged?: boolean;
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
  // ETS Inline="true": the block belongs to its parent's page, not a page of its own, so it has no
  // entry in the page index, and a heading only from its Text or the text of the parameter it names
  // (ParamRefId), never from its Name. `at` is where it stands among the parent's items (it comes
  // before parent.items[at]), as authored; set when the parent is a block.
  inline?: true; at?: number;
}
// The read-back facts the server attaches to a config response (never set by
// buildDeviceConfig). Defined once here so the server's ReadbackSummary and the web client
// bind to the SAME shape: a field renamed here breaks both sides at compile time instead of
// silently leaving the client reading undefined.
// `unresolvedObjects`: the object numbers of the device links counted in `linkGaps`, when there are any,
// split by what can resolve them: `unplacedObjects` no object of the device's own configuration takes
// (only another value of a parameter no read sees, an assumption, can place them); `hiddenObjects` the
// device's configuration places and only the project's own values hide (Revert, then read again);
// `unknownObjects` the read cannot tell (it did not read the device's parameters).
// `unprovenAssumptions`: assumed parameters (read-back `assume`) whose value another value of theirs
// writes the same (objects, image), so the device could not tell them apart; taken all the same.
// `neverProgrammedKept`: why a device never programmed from this project stays so after this read, each
// reason once; `code` is the error code of why the image was not compared, where the read knows one.
// `constantsDiffer`: the constant parameters (deviceimage.ts constantParams) the device holds other bits
// in, which the image check counts as no change (FlashResult.constantsDiffer).
// `flagsRead`: the read took each object's flags and priority from the device's com-object table into
// the flag baseline; `flagsUndecoded`: the objects whose flags it could not take (their baseline kept);
// `flagsUnreadable`: why the table gave no flags, where it gave none. `hiddenDiffer`: asked for (compareHidden)
// and where the read compares them (DeviceReadback.hiddenDiffer), the device's bytes at the parameters its configuration hides that are not
// the image's, as address ranges (empty: none differ; absent: no such bit compared).
export type NeverProgrammedReason = "readIncomplete" | "linksUnresolved" | "otherApplication" | "applicationIdNotReported" | "notLoaded" | "imageDiffers" | "imageNotCompared";
export interface DeviceReadbackInfo { paramsRead: boolean; linksRead: boolean; linkGaps: number; unresolvedObjects?: number[]; unplacedObjects?: number[]; hiddenObjects?: number[]; unknownObjects?: number[]; unprovenAssumptions?: string[]; neverProgrammedKept?: { reason: NeverProgrammedReason; code?: string }[]; constantsDiffer?: ConstantDifference[]; flagsRead?: boolean; flagsUndecoded?: number[]; flagsUnreadable?: string; hiddenDiffer?: { address: number; length: number }[] }

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
  // The answer to a whole-device revert: the parameters it left at the project's value because the
  // baseline holds no value of their type there (CfgParamView.baseOutsideType). Absent where none.
  revertKept?: string[];
  hasModules: boolean;
  dca?: DcaInfo;
  // Which aspects of this device can be verified against the hardware via read-back.
  // Attached by the server (not buildDeviceConfig). When params/links is false, the
  // shown change state was never confirmed against the device. See readbackSupport.
  readbackSupport?: { params: boolean; links: boolean; flags: boolean };
  // The com-object flags (and "priority") the device page lets the user set per object; attached by the
  // server (buildDeviceView).
  comObjFlagsEditable?: (keyof ComObjFlags | "priority")[];
  // The com-object numbers whose flags no write carries, as the family's table holds no entry for them
  // (DeviceProfile.comObjNumbersWithoutEntry); none of comObjFlagsEditable applies to them.
  comObjFlagsUneditable?: number[];
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
  // Parameters whose baseline value a read-back assumed, not proven, that this configuration does not
  // show (so no row carries their `assumed` mark). Attached by the server; absent when none.
  assumedHidden?: number;
  // Why the project's own com-object flags cannot be laid over the application's (an error code,
  // as every write that authors the com-object table refuses): the objects' flags are then the
  // application's and must not be shown as the device's. Attached by the server.
  comObjFlagsRefused?: string;
  // What the last read-back actually covered: its task's result (the read-back route's Task.result),
  // which a client sets on the view it fetches after the read. Never set by the server.
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
  // pass evaluated and did not take. A choose on an unset Merker or an unplaced, unstored
  // parameter whose tests are skipped (chooseSkipsTests) evaluates nothing, so what it gates is
  // not in here; neither is a ref placed nowhere.
  rejectedRefs: Set<string>;
  // Resolved com-objects reached in the active dynamic tree, keyed by resolved object
  // number. Unlike `blocks` this INCLUDES com-objects inside Access="None" blocks (hidden
  // from the UI but still present in the device's com-object table / L3) and per-instance
  // module com-objects. Carries the RESOLVED flags (ComObjectRef overrides applied), which
  // the com-object-table build needs. See buildDeviceConfig and CfgComObjImage.
  imageComObjects: Map<number, CfgComObjImage>;
  // The System B com-object table entry count: the highest declared com-object number across flat
  // `<ComObjectTable>` declarations and every module instance/branch, EXCEPT when `<ComObjectTable />`
  // declares no flat com-objects at all and the active configuration reaches zero communication
  // objects (`imageComObjects.size === 0`), in which case ETS allocates 2 bytes (`00 00`, count 0)
  // rather than sizing from inactive module declarations (VIMAR 01506 at defaults). Whenever flat
  // declarations exist or any com-object is active, the table covers every declared object because
  // firmware such as thelsing/knx indexes `getGroupObject(n)` without bounds checks (hardware-proven:
  // shortening the OpenKNX RaumController table from 1359 to the active maximum reverted the unit to
  // factory). `buildComObjectTable` sizes the table to this. See buildDeviceConfig.
  maxComObjectNumber: number;
  // The highest declared com-object number across flat declarations and every module instance/branch,
  // or null when the application declares no com-objects at all. Unlike maxComObjectNumber (clamped
  // at 0 for 1-based System B and 0 for empty-`<ComObjectTable />` modular apps with zero active
  // objects), null distinguishes "none declared" from "only object #0 declared" for 0-based MV-0705
  // com-object tables and bounds System B read-back across any module object the device may hold.
  maxDeclaredComObject: number | null;
  // The value a top-level ParameterRef holds in this configuration, resolved like the view does
  // (device value, a placed sibling ref's value, ref or parameter default) against the final
  // working values after the walk. An unknown ref yields only a value stored under that id.
  paramValue: (refId: string) => string | undefined;
  // The reading in which the chooses whose default branch no ETS download decides (unsettledChooses, by ref id) do
  // not take it, where it reaches other values with memory than this one but the same com-objects. The segment
  // builders build both and refuse where their bytes differ (buildDeviceConfig).
  otherReading?: DeviceConfigBuild;
  unsettledChooses?: string[];
  // The Module nodes (by id) the image pass reached.
  modulesReached: Set<string>;
  // The module instances the configuration is built from: the device's own, or those the allocators make of its
  // values where it has none (resolveModuleInstances).
  moduleInstances: ModuleInstance[];
}

interface Scope {
  rewrite: (id: string) => string;     // module-def id -> device instance id (identity at top level)
  textArgs: Map<string, string>;       // arg name -> value, for {{name}} substitution
  argValue: (argId: string) => number; // resolved numeric arg, for com-object base numbering
  paramArgValue?: ParamArgLookup;      // resolved numeric arg, for parameter BaseValue (undefined at top level -> resolveParamDefault refuses)
}
// Top-level scope: a BaseNumber or BaseValue argument can only be satisfied inside a module
// instance; a declaration that demands one at top level is a malformed catalogue, so refuse
// instead of silently falling back to 0.
const TOP: Scope = {
  rewrite: (id) => id,
  textArgs: new Map(),
  argValue: (argId) => { throw new ProductError("COMOBJ_ARG_UNRESOLVED", `com-object numbering references module argument ${argId} outside any module instance`); },
};

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

// The values ETS gives a device's parameters when it is added to a project in `lang`, where they differ from the
// defaults, by ParameterRef id: a text Parameter's InitialValue as translated into that language. Shown by ETS 6.4.1
// on bussard's syn-text-initialvalue (private corpus captures/external/bussard-synthetic/), added to a de-DE project:
// the Parameter's Value and InitialValue "Buzzard nest", its de-DE InitialValue "Bussardhorst Süd", which ETS wrote.
// An InitialValue no capture shows ETS taking refuses the placement where it differs from the default and its
// parameter reaches the device (memory, a property, the test of a <choose>, an <Assign> or <ParameterCalculation>
// into one that does): an untranslated one (the application's default language, or one the language does not
// translate), one on a ParameterRef or beside a ParameterRef's own Value, one of a parameter of another type, and
// one of a module definition, whose instances are made after the device is placed. One that reaches no device byte keeps its
// default: the Jung 400021SE translates the InitialValues of memoryless ParameterRefs its <Assign>s set and read
// among themselves, which only name its pages in the view.
export function initialValues(app: AppConfig, lang?: string): Map<string, string> {
  const language = resolveLanguage(app, lang);
  const translated = (id: string, base: string | undefined) =>
    language === app.defaultLanguage ? base : app.translations.get(language)?.get(id)?.get("InitialValue") ?? base;
  const paramOf = (refId: string | undefined) => (refId ? resolveParamRef(app, refId)?.param : undefined);
  const tested = new Set<string>(); // Parameter ids a <choose> tests
  const assigns = new Map<string, Set<string>>(); // Parameter id -> the Parameter ids <Assign>s set from it
  const walk = (nodes: DynNode[]) => {
    for (const n of nodes) {
      if (n.kind === "choose") { const p = paramOf(n.paramRefId); if (p) tested.add(p.id); }
      if (n.kind === "assign") {
        const from = paramOf(n.source), to = paramOf(n.target);
        if (from && to) assigns.set(from.id, (assigns.get(from.id) ?? new Set()).add(to.id));
      }
      if (n.kind === "block") walk(n.children);
      else if (n.kind === "container") { if (!isSkippedRepeat(n)) walk(n.children); }
      else if (n.kind === "choose") for (const w of n.whens) walk(w.children);
    }
  };
  walk(app.dynamic);
  for (const d of app.moduleDefs.values()) walk(d.dynamic);
  // The Parameter ids whose value reaches the device: in memory, in a property, tested by a <choose>, read by an
  // <Assign> into one that does, or computed with by a <ParameterCalculation> one of whose other parameters does.
  const calcs = app.calculations.map((c) => new Set([...c.lRefs, ...c.rRefs].flatMap((r) => paramOf(r)?.id ?? [])));
  const reaching = new Set([...app.params.values()].filter((p) => holdsValue(p) || tested.has(p.id)).map((p) => p.id));
  for (let grew = true; grew;) {
    grew = false;
    const add = (id: string) => { if (!reaching.has(id)) { reaching.add(id); grew = true; } };
    for (const [from, to] of assigns) if ([...to].some((t) => reaching.has(t))) add(from);
    for (const c of calcs) for (const id of c) if ([...c].some((o) => o !== id && reaching.has(o))) add(id);
  }
  const out = new Map<string, string>();
  for (const ref of app.refs.values()) {
    const param = app.params.get(ref.paramId);
    if (!param) continue;
    const def = ref.value ?? param.value ?? "";
    const ofParam = translated(param.id, param.initialValue);
    const ofRef = translated(ref.id, ref.initialValue);
    // The capture shows a translation, in the project's language, of a text Parameter's InitialValue.
    const shown = ofRef === undefined && ofParam !== undefined && ofParam !== param.initialValue && ref.value === undefined
      && !param.moduleDefId && !ref.moduleDefId && app.types.get(param.typeId)?.base === "Text";
    const start = ofRef ?? ofParam;
    if (start === undefined || start === def) continue;
    if (shown) { out.set(ref.id, start); continue; }
    if (!reaching.has(param.id)) continue;
    const why = ofRef !== undefined ? "the InitialValue is the ParameterRef's" : ref.value !== undefined ? "the ParameterRef has a Value of its own"
      : param.moduleDefId || ref.moduleDefId ? "it is a parameter of a module definition"
      : app.types.get(param.typeId)?.base !== "Text" ? "it is no text parameter" : "it is the untranslated InitialValue";
    throw new ProductError("PARAM_INITIAL_VALUE_UNSUPPORTED", `parameter ${ref.id} starts in ${language} at "${start}", not at its default "${def}", and ${why}; no ETS capture shows which value ETS gives it there. Refusing to place the device rather than start it at a value ETS may not give; add it with ETS and import the project`);
  }
  return out;
}

// Some manufacturer texts carry escaped numeric entities (e.g. "&#xA;" for a
// layout newline); decode them so labels read cleanly.
const codePoint = (m: string, n: number): string => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
const decode = (s: string): string =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => codePoint(m, parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => codePoint(m, Number(d)));
export const decodeTextEntities = decode;

// An ETS text names the value of the parameter its element's TextParameterRefId points at:
// `{{0}}` is that value, `{{0:text}}` the value or, while it is empty, `text` verbatim. Index 0 is
// the only one, since an element names one text parameter. Module arguments inside the default
// ("{{0:Button {{ChNo}}}}") are substituted before this runs. `value` is undefined when nothing
// feeds the placeholder; it then stays visible rather than being guessed away.
const textParamPlaceholder = /\{\{0(?::([^{}]*))?\}\}/g;
const fillTextParam = (text: string, value: string | undefined): string =>
  value === undefined ? text : text.replace(textParamPlaceholder, (_m, def: string | undefined) => (value !== "" ? value : def ?? ""));

// A choose on a ParameterRef no active branch places takes no default branch (docs/findings.md, "A choose on a
// ParameterRef nothing places takes no default branch"); one on a memoryless parameter heading a reached block
// takes it. ETS's downloads show both; none shows a choose on an Access="None" ref nothing places (an internal
// value no branch places by design) or on a parameter with memory that only heads a reached block. Such a choose
// is built both ways: other com-objects refuse the configuration here, its view included; other values with
// memory are left to the segment builders, which refuse where the two readings make other bytes.
export function buildDeviceConfig(
  app: AppConfig,
  overrides: Map<string, string>,
  lang?: string,
  moduleInstances: ModuleInstance[] = [],
): DeviceConfigBuild {
  const taken = buildDeviceConfigReading(app, overrides, lang, moduleInstances, true);
  if (!taken.unsettled.size) return taken.build;
  const skipped = buildDeviceConfigReading(app, overrides, lang, moduleInstances, false).build;
  const unsettledChooses = [...taken.unsettled];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  // Other com-objects make another com-object table.
  const objects = (b: DeviceConfigBuild) => [...b.imageComObjects].sort((x, y) => x[0] - y[0]);
  if (!same(objects(taken.build), objects(skipped))) throw unsettledDefaultRefusal(unsettledChooses);
  // A value without memory or property reaches no byte, except as the input of a calculation; what it gates shows
  // in the other entries.
  const calculated = new Set([...app.calculationRefs].map((r) => resolveParamRef(app, r)?.param?.id));
  const reaches = (refId: string) => {
    const p = resolveParamRef(app, refId)?.param;
    return !!p && (holdsValue(p) || calculated.has(p.id));
  };
  const byId = (x: string, y: string) => x.localeCompare(y);
  const imageInput = (b: DeviceConfigBuild) => [
    [...b.imageValues].filter(([r]) => reaches(r)).sort((x, y) => byId(x[0], y[0])),
    [...b.rejectedRefs].filter(reaches).sort(byId),
  ];
  if (same(imageInput(taken.build), imageInput(skipped))) return taken.build;
  return { ...taken.build, otherReading: skipped, unsettledChooses };
}

// Module instances the allocators were re-run for (resolveModuleInstances) are refused where one belongs to a Module
// node the configuration does not reach, or where the configuration reaches a Module node the allocator never
// instantiated: although both walks share choose.ts, this guard still catches any remaining mismatch (e.g. a
// <Repeat> loop mutating state across iterations) so memory and com-object offsets never shift silently.
export function refuseUnreachedInstances(app: AppConfig, build: DeviceConfigBuild, instances: ModuleInstance[]): void {
  const off = instances.filter((mi) => !build.modulesReached.has(`${app.id}_${mi.refId}`));
  if (off.length) {
    throw new ProductError("MODULE_INSTANCES_UNREACHED", `the module instances re-run for this configuration include ${off.length} the configuration does not reach (e.g. ${off[0].id}), so where the instances after them lie in memory is not known; a device imported from an ETS project carries ETS's own instances`);
  }
  const allocated = new Set(instances.map((mi) => `${app.id}_${mi.refId}`));
  const missing = [...build.modulesReached].filter((id) => !allocated.has(id));
  if (missing.length) {
    throw new ProductError("MODULE_INSTANCES_UNREACHED", `the configuration reaches ${missing.length} module node(s) the allocator did not instantiate (e.g. ${missing[0]}), so their memory and com-object offsets are not known; a device imported from an ETS project carries ETS's own instances`);
  }
}

// Every reading of a configuration: the build, and the other reading where it has one (buildDeviceConfig).
export const readingsOf = (b: DeviceConfigBuild): DeviceConfigBuild[] => (b.otherReading ? [b, b.otherReading] : [b]);

function buildDeviceConfigReading(
  app: AppConfig,
  overrides: Map<string, string>,
  lang: string | undefined,
  moduleInstances: ModuleInstance[],
  // Whether a choose whose default branch no ETS download decides takes it (buildDeviceConfig).
  takeOpenDefaults: boolean,
): { build: DeviceConfigBuild; unsettled: Set<string> } {
  const language = resolveLanguage(app, lang);
  // A from-scratch device (placed from the catalogue, no imported 0.xml) has no pinned
  // module instances. Re-run the allocators to synthesise the same set ETS would compile,
  // so its channel blocks render and its per-instance offsets resolve. An imported device
  // keeps its 0.xml instances. See resolveModuleInstances.
  const instances = moduleInstances.length || !app.hasModules ? moduleInstances : resolveModuleInstances(app, overrides);
  const env = new Map(overrides); // working values; Assign mutates this

  // Shared <choose> and value-resolution context (choose.ts): `placement` is found by fixed-point
  // iteration below so forward-placed Merkers and sibling-ref defaults resolve consistently across
  // the UI walk, the image pass, and the module allocator.
  const chooseCtx: ChooseContext = {
    app,
    refsOfParam: buildRefsOfParam(app),
    placement: emptyPlacement(),
    takeOpenDefaults,
    unsettled: new Set(),
  };
  const resolve = (defRefId: string, scope: Scope, e: Map<string, string> = env): string | undefined =>
    resolveParamValue(chooseCtx, defRefId, scope.rewrite, e, scope.paramArgValue);
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

  const selectWhens = (defParamRefId: string, whens: DynWhen[], scope: Scope, e: Map<string, string> = env): DynWhen[] =>
    selectChooseWhens(chooseCtx, defParamRefId, whens, scope.rewrite, e, scope.paramArgValue);

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
    // TypePicture shows an image from the product's baggage and holds no value.
    else if (type?.kind === "TypePicture" && type.pictureRefId) control = "picture";

    const defaultValue = resolveParamDefault(ref, param, scope.paramArgValue) ?? "";
    const typeLabel = control === "unsupported" ? unsupportedTypeLabel(type) : undefined;
    // ETS spinner step / slider hint live on the TypeNumber; a slider needs a
    // bounded range to render, so fall back to the plain number input without one.
    const step = control === "number" ? type?.increment : undefined;
    const slider = control === "number" && type?.uiHint === "Slider" && type.min !== undefined && type.max !== undefined;
    // A checkbox has two states, and ETS stores 1 for a ticked box over the default 0: only the range 0..1
    // names them. Any other range keeps the number input, which shows every value of it.
    const checkbox = (control === "number" && type?.base === "Number" && type.uiHint === "CheckBox" && type.min === 0 && type.max === 1) || undefined;
    const unit = control === "time" ? type?.unit : undefined;
    // A float number accepts decimals; the frontend uses step="any" so the browser does
    // not reject a fractional value against an integer step grid.
    const float = type?.base === "Float" || undefined;
    return { kind: "param", param: { refId: scope.rewrite(defRefId), name, control, value, options, min: type?.min, max: type?.max, suffix, step, slider, checkbox, unit, float, readOnly: access === "Read" || control === "display" || control === "picture", defaultValue, typeLabel,
      ...(control === "picture" ? { picture: { baggageId: type!.pictureRefId!, ...(type!.pictureAlign ? { align: type!.pictureAlign } : {}) } } : {}), ...(!holdsValue(param) ? { memoryless: true as const } : {}) } };
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
        priority: img.priority,
      },
    };
  };

  // Build the per-instance scope: rewrite def ids -> instance ids, collect text
  // and numeric arguments from the instance's pinned values.
  const makeScope = (moduleNodeRefId: string, def: ModuleDefModel, inst: ModuleInstance): Scope => {
    const instFullId = `${app.id}_${inst.id}`;
    const textArgs = new Map<string, string>();
    for (const a of inst.args) {
      const fullArgId = `${app.id}_${a.refId}`;
      const defArg = def.args.find((d) => d.id === fullArgId);
      if (defArg) textArgs.set(defArg.name, a.value); // any arg can appear in {{name}} text
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
        const v = moduleInstanceArgNumber(app, inst, argId);
        if (v === undefined) {
          throw new ProductError("COMOBJ_ARG_UNRESOLVED",
            `module instance ${inst.id}: com-object numbering needs argument ${argId}, which the instance does not carry (or it is not an integer)`);
        }
        return v;
      },
      // Consulted when a parameter declares BaseValue="<ArgumentId>".
      paramArgValue: moduleInstanceArgLookup(app, inst),
    };
  };
  // In 0.xml, a nested <SubModuleDefs> instance still carries its enclosing <Module>'s RefId.
  // Match only direct instances of `moduleNodeId` so a submodule instance is not instantiated
  // under the outer ModuleDef; the image builders refuse imported submodule instances explicitly.
  const instancesFor = (moduleNodeId: string) =>
    instances.filter((mi) => `${app.id}_${mi.refId}` === moduleNodeId && !isSubModuleInstance(mi));

  // Where each shown inline block stands among its parent's items, keyed by its instance id (a
  // module's nodes are shared by its instances), and how many collect() has met: collect() records
  // them, walk() reads them right after.
  const inlineAt = new Map<string, number>();
  let inlineSeen = 0;
  // Walk a node sequence in order, appending items to the current block. Active
  // choose branches inline their items; Assign mutates env; Module nodes expand
  // each device instance with its own scope.
  const collect = (nodes: DynNode[], items: CfgItem[], scope: Scope) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "separator": items.push({ kind: "separator", text: fillTextParam(subst(tr(n.id, "Text", n.text), scope), n.textParamRefId ? resolve(n.textParamRefId, scope) ?? "" : undefined), uiHint: n.uiHint, cell: n.cell }); break;
        case "paramRef": { const it = buildParam(n.refId, scope); if (it) { if (it.kind === "param" && n.indent) it.param.indent = n.indent; if (it.kind === "param") it.cell = n.cell; items.push(it); } break; }
        case "comObjRef": { const it = buildComObj(n.refId, scope); if (it) items.push(it); break; }
        // A scripted action. Carried through as itself (label + handler name) so the UI
        // can show an inert, honestly-labelled control; busforge never runs the script.
        case "button": items.push({ kind: "button", button: { text: subst(tr(n.id, "Text", n.text), scope), handler: n.handler }, cell: n.cell }); break;
        case "assign": env.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope) ?? "" : "")); break;
        case "choose": { for (const w of selectWhens(n.paramRefId, n.whens, scope)) collect(w.children, items, scope); break; }
        case "container": if (!isSkippedRepeat(n)) collect(n.children, items, scope); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) collect(def.dynamic, items, makeScope(n.refId, def, inst)); break; }
        case "unsupported": items.push({ kind: "unsupported", label: n.tag }); break; // surface, never drop
        // Visible nested blocks become their own sections (handled by walk). A hidden Access="None"
        // block nested inside a visible block runs its <Assign> side effects and emits its
        // communication objects here in document order, so a later choose at this level sees them;
        // walk replays only its <Assign>s while inside a visible block (loose === null) so objects emit once.
        case "block":
          if (n.access === "None") applyEnv(n.children, scope, items);
          else if (n.inline) { inlineAt.set(scope.rewrite(n.id), items.length); inlineSeen++; }
          break;
      }
    }
  };

  // A ParameterBlock heading comes from its own (translatable) Text, or, when it
  // has none, from a referenced parameter's text (a common manufacturer pattern,
  // e.g. Theben push-buttons); only then fall back to the language-independent Name.
  // An inline block never takes its Name: it has no page to name, and its Name is an
  // identifier (OpenKNX "BASE_StartupDelayCycle"), never a caption.
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
    return n.inline ? "" : fill(n.name);
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

  // A block marked Access="None" is not shown, but its <Assign> side effects on `env` still matter:
  // a manufacturer often computes a helper parameter via <Assign> inside an invisible block and then
  // gates a later, VISIBLE choose on it (Merker placements inside invisible blocks are already
  // recorded upfront by findPlacement, which descends into all blocks regardless of access). Run the
  // <Assign> side effects of an invisible subtree in document order, descending into blocks
  // regardless of access, emitting no parameter. Same choose selection and value resolution as the
  // display walk, so a later choose reads exactly the env it should (the image pass does the
  // equivalent via imgEnv).
  // The block's communication objects stay active (ETS links them and its tables hold them: the MIX 2
  // "Gemeinsame Objekte" block), so they go to `objects` when provided (null suppresses duplicate
  // emission when walk replays Assigns after collect already emitted the block's objects).
  const applyEnv = (nodes: DynNode[], scope: Scope, objects: CfgItem[] | null) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "paramRef": break;
        case "assign": env.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope) ?? "" : "")); break;
        case "choose": for (const w of selectWhens(n.paramRefId, n.whens, scope)) applyEnv(w.children, scope, objects); break;
        case "container": if (!isSkippedRepeat(n)) applyEnv(n.children, scope, objects); break;
        case "block": applyEnv(n.children, scope, objects); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) applyEnv(def.dynamic, makeScope(n.refId, def, inst), objects); break; }
        case "comObjRef": { if (objects) { const it = buildComObj(n.refId, scope); if (it) objects.push(it); } break; }
        case "separator": case "button": case "unsupported": break;
      }
    }
  };

  const inlineOf = (n: Extract<DynNode, { kind: "block" }>, id: string): Pick<CfgBlock, "inline" | "at"> => {
    if (!n.inline) return {};
    const at = inlineAt.get(id);
    return at === undefined ? { inline: true } : { inline: true, at };
  };
  const restoreEnv = (snapshot: Map<string, string>) => {
    env.clear();
    for (const [k, v] of snapshot) env.set(k, v);
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
          // Hidden block: outside a visible block (loose !== null) run its Assigns and emit its
          // objects into `section`. Inside a visible block (loose === null), collect() already
          // emitted its objects, so replay only its Assigns in document order for sibling chooses.
          if (n.access === "None") { applyEnv(n.children, scope, loose !== null ? section : null); break; }
          const envBefore = new Map(env);
          const items: CfgItem[] = [];
          const inlineBefore = inlineSeen;
          collect(n.children, items, scope);
          // A page whose rows all sit in inline blocks is still a page: they stand on it, not above it.
          if (items.length || inlineSeen > inlineBefore) {
            const name = blockTitle(n, scope);
            const id = scope.rewrite(n.id);
            // An inline block keeps its authored place among its siblings: DisplayOrder orders pages, not rows on one.
            const node: Node = { block: { id, name: cap(name), items, level: 0, ...gridOf(n, scope), ...inlineOf(n, id) }, order: n.inline ? 0 : headOrder(n), seq: seq++, children: [] };
            into.push(node);
            // Restore env before descending into children so a later <Assign> inside this block
            // does not retroactively alter an earlier <choose> guarding a nested ParameterBlock.
            restoreEnv(envBefore);
            walk(n.children, scope, node.children, null, items);
          } else if (n.children.length === 0 && (n.paramRefId || n.text)) {
            // A reached but childless block is a pure category header (e.g. the
            // "Scene" section): ETS shows it as a navigable node, so emit it as an
            // empty section rather than dropping it. (Headers in inactive choose
            // branches are never reached, so this adds no noise.)
            const name = cap(blockTitle(n, scope));
            const id = scope.rewrite(n.id);
            if (name) into.push({ block: { id, name, items: [], level: 0, ...inlineOf(n, id) }, order: headOrder(n), seq: seq++, children: [] });
          } else {
            restoreEnv(envBefore);
            walk(n.children, scope, into, null, section); // transparent wrapper: children keep this level; its leaves are none (collect found no items)
          }
          break;
        }
        case "container": {
          if (isSkippedRepeat(n)) break;
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
        // enclosing container. Assign still runs when loose === null so nested blocks see prior Assigns
        // in document order after env was restored to the block's entry state. Listed rather than
        // defaulted, so that a node kind added later shows up as a compile error here instead of
        // vanishing from the UI.
        case "assign":
          if (loose) collect([n], loose, scope);
          else env.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope) ?? "" : ""));
          break;
        case "paramRef": case "comObjRef": case "separator": case "button": case "unsupported":
          if (loose) collect([n], loose, scope);
          break;
      }
    }
  };
  // The placement the walks read (see resolveParamValue): the image pass's traversal, recording only
  // which refs it places, repeated until the placement it finds is the one it walked with.
  const findPlacement = (): { found: ChoosePlacement; unresolvedArgError?: ProductError } => {
    const found = emptyPlacement();
    const penv = new Map(overrides);
    let unresolvedArgError: ProductError | undefined;
    const visit = (nodes: DynNode[], scope: Scope) => {
      for (const n of nodes) {
        switch (n.kind) {
          case "paramRef":
            recordPlacedRef(app, found, n.refId, scope.rewrite);
            break;
          case "assign":
            try {
              penv.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope, penv) ?? "" : ""));
            } catch (e) {
              // Defer MODULE_ARG_UNRESOLVED until placement settles so a provisional pass-0 walk
              // (before a placed sibling ref or forward Merker is discovered) does not abort a valid config.
              if (e instanceof ProductError && e.code === "MODULE_ARG_UNRESOLVED") { unresolvedArgError ??= e; break; }
              throw e;
            }
            break;
          case "choose": {
            let whens;
            try {
              whens = selectWhens(n.paramRefId, n.whens, scope, penv);
            } catch (e) {
              if (e instanceof ProductError && e.code === "MODULE_ARG_UNRESOLVED") { unresolvedArgError ??= e; break; }
              throw e;
            }
            for (const w of whens) visit(w.children, scope);
            break;
          }
          case "container": if (!isSkippedRepeat(n)) visit(n.children, scope); break;
          case "block": if (n.paramRefId) found.heads.add(scope.rewrite(n.paramRefId)); visit(n.children, scope); break;
          case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) visit(def.dynamic, makeScope(n.refId, def, inst)); break; }
          case "comObjRef": case "button": case "separator": case "unsupported": break;
        }
      }
    };
    visit(app.dynamic, TOP);
    return { found, unresolvedArgError };
  };
  // A placement seen before without having settled is a cycle: the application admits no single
  // reading of its shared values, and picking one of the cycle's states would be a guess.
  // Track every open default consulted during convergence too: a default branch that places its own
  // Access="None" Merker would otherwise look "placed" on the next pass and drop out of `unsettled`,
  // silently hiding that takeOpenDefaults=false settles to a different configuration.
  const seen: ChoosePlacement[] = [];
  const everUnsettled = new Set<string>();
  for (;;) {
    chooseCtx.unsettled.clear();
    const { found: next, unresolvedArgError } = findPlacement();
    for (const id of chooseCtx.unsettled) everUnsettled.add(id);
    if (samePlacement(next, chooseCtx.placement)) {
      if (unresolvedArgError) throw unresolvedArgError;
      break;
    }
    if (seen.some((p) => samePlacement(p, next))) {
      throw new ProductError("CONFIG_NOT_RESOLVABLE", "the application's parameter visibility does not settle: which parameter references are active keeps changing with the values they share");
    }
    seen.push(chooseCtx.placement);
    chooseCtx.placement = next;
  }
  chooseCtx.unsettled.clear();

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
  const modulesReached = new Set<string>();
  const imgEnv = new Map(overrides);
  const imgCollect = (nodes: DynNode[], scope: Scope) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "paramRef": { if (scope === TOP) place(n.refId, false); const v = resolve(n.refId, scope, imgEnv); if (v !== undefined) imageValues.set(scope.rewrite(n.refId), v); break; }
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
            const evaluated = !isChooseSkipped(chooseCtx, n.paramRefId, scope.rewrite, imgEnv) && resolve(n.paramRefId, scope, imgEnv) !== undefined;
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
        case "container": if (!isSkippedRepeat(n)) imgCollect(n.children, scope); break;
        case "block": imgCollect(n.children, scope); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) { modulesReached.add(n.id); for (const inst of instancesFor(n.id)) imgCollect(def.dynamic, makeScope(n.refId, def, inst)); } break; }
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
      else if (n.kind === "container") { if (!isSkippedRepeat(n)) placements(n.children, rejected); }
      else if (n.kind === "block") placements(n.children, rejected);
      else if (n.kind === "choose") for (const w of n.whens) placements(w.children, rejected);
    }
  };
  imgCollect(app.dynamic, TOP);
  const rejectedRefs = new Set([...placedRejected].filter(([, rejected]) => rejected).map(([r]) => r));

  // Declared com-object bounds:
  // - `maxDeclaredComObject`: the highest com-object number across flat `<ComObjectTable>`
  //   declarations and every module instance's declarations across all choose branches (used to
  //   bound MV-0705 linked-bit clearing and System B read-back).
  // - `maxComObjectNumber`: the System B com-object table entry count. Equals `max(0, maxDeclaredComObject)`
  //   whenever the application declares any flat `<ComObject>` in `<Static><ComObjectTable>` (even
  //   when zero objects are active, as ETS writes on the GVS AMMA, or when active objects are lower,
  //   as required by unbounded firmware such as the OpenKNX RaumController) or activates at least
  //   one com-object. Only when `<ComObjectTable />` has no flat `<ComObject>`s AND zero com-objects
  //   are active (`imageComObjects.size === 0`) does ETS allocate 2 bytes (`00 00`, count 0) instead
  //   of sizing from inactive module declarations (VIMAR 01506 at defaults); partially active
  //   modular cases stay at `maxDeclaredComObject` until a capture establishes otherwise.
  let maxDeclaredComObject: number | null = null;
  let hasStaticComObject = false;
  const noteDeclared = (n: number) => { maxDeclaredComObject = maxDeclaredComObject === null ? n : Math.max(maxDeclaredComObject, n); };
  const comObjsByMod = new Map<string, typeof app.comObjects extends Map<string, infer V> ? V[] : never>();
  for (const o of app.comObjects.values()) {
    if (o.moduleDefId) {
      const list = comObjsByMod.get(o.moduleDefId);
      if (list) list.push(o);
      else comObjsByMod.set(o.moduleDefId, [o]);
    } else if (!o.baseNumber) {
      hasStaticComObject = true;
      noteDeclared(o.number);
    }
  }
  const scanModuleComObjNums = (nodes: DynNode[], scope: Scope, inModule: boolean) => {
    for (const n of nodes) {
      switch (n.kind) {
        // Only record inside a module instance: top-level (flat) numbers are covered by the declaration
        // scan above, and resolving them here would risk a BaseNumber that only makes sense per instance.
        case "comObjRef": { if (inModule) { const c = resolveComObjImage(n.refId, scope); if (c) noteDeclared(c.number); } break; }
        case "choose": for (const w of n.whens) scanModuleComObjNums(w.children, scope, inModule); break; // every branch, not selectWhens
        case "container": if (!isSkippedRepeat(n)) scanModuleComObjNums(n.children, scope, inModule); break;
        case "block": scanModuleComObjNums(n.children, scope, inModule); break;
        case "module": {
          const def = app.moduleDefs.get(n.refId);
          if (def) {
            for (const inst of instancesFor(n.id)) {
              const modScope = makeScope(n.refId, def, inst);
              for (const o of comObjsByMod.get(n.refId) ?? []) noteDeclared(o.number + (o.baseNumber ? modScope.argValue(o.baseNumber) : 0));
              scanModuleComObjNums(def.dynamic, modScope, true);
            }
          }
          break;
        }
        // Own no com-object number. Listed, not defaulted, so a new node kind is a compile error here.
        case "paramRef": case "separator": case "button": case "assign": case "unsupported": break;
      }
    }
  };
  scanModuleComObjNums(app.dynamic, TOP, false);
  const maxComObjectNumber = !hasStaticComObject && imageComObjects.size === 0 ? 0 : Math.max(0, maxDeclaredComObject ?? 0);

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

  const build: DeviceConfigBuild = { blocks, hasModules: app.hasModules, dca: app.dca, imageValues, rejectedRefs, imageComObjects, maxComObjectNumber, maxDeclaredComObject, modulesReached, moduleInstances: instances, paramValue: (refId) => resolve(refId, TOP) };
  if (!moduleInstances.length) refuseUnreachedInstances(app, build, instances);
  return { build, unsettled: chooseCtx.unsettled.size ? chooseCtx.unsettled : everUnsettled };
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
// The parameters without memory a configuration shows that a read-back can be asked to assume (CfgParamView
// memoryless, editable, an enumeration or a whole number: what the read-back route takes), by ParameterRef id:
// the settings no read-back recovers that decide, with the rest, what the configuration hides. A read-only
// row, a text or a float decides nothing a choose tests.
export function assumableMemorylessRefs(build: DeviceConfigBuild): string[] {
  return [...new Set(build.blocks.flatMap((b) => b.items.flatMap((i) => (i.kind === "param" && i.param.memoryless && !i.param.readOnly
    && ((i.param.control === "enum" && !!i.param.options?.length) || (i.param.control === "number" && !i.param.float)) ? [i.param.refId] : []))))];
}

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
