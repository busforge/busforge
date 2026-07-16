import type { AppConfig, CfgType, ComObjFlags, ComObjPriority, DcaInfo, DynNode, DynWhen, ModuleDefModel, ModuleInstance } from "./appconfig.ts";
import { resolveModuleInstances } from "./modules.ts";
import { ProductError } from "./errors.ts";

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
  // Resolved com-objects reached in the active dynamic tree, keyed by resolved object
  // number. Unlike `blocks` this INCLUDES com-objects inside Access="None" blocks (hidden
  // from the UI but still present in the device's com-object table / L3) and per-instance
  // module com-objects. Carries the RESOLVED flags (ComObjectRef overrides applied), which
  // the com-object-table build needs. See buildDeviceConfig and CfgComObjImage.
  imageComObjects: Map<number, CfgComObjImage>;
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
// (equality) or one of <N, >N, <=N, >=N, !=N. Compares the raw integer value.
export function matchTest(test: string, v: number): boolean {
  for (const tok of test.trim().split(/\s+/)) {
    if (tok === "") continue;
    let m: RegExpExecArray | null;
    if ((m = /^(<=|>=|<|>|!=)(-?\d+)$/.exec(tok))) {
      const n = Number(m[2]);
      const ok = m[1] === "<" ? v < n : m[1] === ">" ? v > n : m[1] === "<=" ? v <= n : m[1] === ">=" ? v >= n : v !== n;
      if (ok) return true;
    } else if (/^-?\d+$/.test(tok)) {
      if (v === Number(tok)) return true;
    }
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
  const resolve = (defRefId: string, scope: Scope, e: Map<string, string> = env): string | undefined => {
    const instId = scope.rewrite(defRefId);
    if (e.has(instId)) return e.get(instId);
    const ref = app.refs.get(defRefId);
    if (!ref) return undefined;
    if (isMerker(ref.paramId)) return undefined; // unplaced Merker: no static default for choose evaluation
    return ref.value ?? app.params.get(ref.paramId)?.value;
  };
  // Placing a ParameterRefRef to a Merker in an active branch assigns it (the ref's value
  // or the parameter default), so a later choose on that ref sees it as set. Document-order
  // walk guarantees the assignment precedes the read.
  const assignIfMerker = (defRefId: string, scope: Scope, e: Map<string, string>) => {
    const ref = app.refs.get(defRefId);
    if (ref && isMerker(ref.paramId)) e.set(scope.rewrite(defRefId), ref.value ?? app.params.get(ref.paramId)?.value ?? "");
  };
  // Some manufacturer texts carry escaped numeric entities (e.g. "&#xA;" for a
  // layout newline); decode them so labels read cleanly.
  const codePoint = (m: string, n: number): string => (n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m);
  const decode = (s: string): string =>
    s.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => codePoint(m, parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => codePoint(m, Number(d)));
  const tr = (elemId: string | undefined, attr: string, base: string): string => {
    const t = !elemId || language === app.defaultLanguage ? base : app.translations.get(language)?.get(elemId)?.get(attr) ?? base;
    return decode(t);
  };
  const subst = (text: string, scope: Scope): string =>
    text.replace(/\{\{([^}]+)\}\}/g, (m, k) => scope.textArgs.get(k) ?? m);
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
  // union bits unwritten (hardware-confirmed: P-1=0 -> UP-11=2, P-1=2 -> UP-12=0).
  const selectWhens = (defParamRefId: string, whens: DynWhen[], scope: Scope, e: Map<string, string> = env): DynWhen[] => {
    const v = Number(resolve(defParamRefId, scope, e) ?? 0);
    const matched = whens.filter((w) => !w.isDefault && w.test !== undefined && matchTest(w.test, v));
    if (matched.length) return matched;
    const def = whens.find((w) => w.isDefault);
    return def ? [def] : [];
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
    const name = (app.paramFauxIndent.get(param.id) ?? "") + cap(subst(tr(param.id, "Text", param.text) || tr(defRefId, "Text", param.text), scope));
    const suffix = param.suffix ? subst(tr(param.id, "SuffixText", param.suffix), scope) : undefined;
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
    const fill = (s: string) => {
      const out = subst(s, scope);
      return textParamRefId ? out.replace(/\{\{0\}\}/g, resolve(textParamRefId, scope) ?? "") : out;
    };
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
        case "separator": items.push({ kind: "separator", text: subst(tr(n.id, "Text", n.text), scope), uiHint: n.uiHint, cell: n.cell }); break;
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
        case "block": break; // nested blocks become their own sections (walkBlocks)
      }
    }
  };

  // A ParameterBlock heading comes from its own (translatable) Text, or, when it
  // has none, from a referenced parameter's text (a common manufacturer pattern,
  // e.g. Theben push-buttons); only then fall back to the language-independent Name.
  const blockTitle = (n: Extract<DynNode, { kind: "block" }>, scope: Scope): string => {
    const own = tr(n.id, "Text", n.text);
    if (own) return subst(own, scope);
    const ref = n.paramRefId ? app.refs.get(n.paramRefId) : undefined;
    const param = ref ? app.params.get(ref.paramId) : undefined;
    if (param) {
      const t = tr(param.id, "Text", param.text) || tr(n.paramRefId!, "Text", param.text);
      if (t) return subst(t, scope);
    }
    return subst(n.name, scope);
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

  const walk = (nodes: DynNode[], scope: Scope, into: Node[]) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "block": {
          if (n.access === "None") break; // ETS hides Access="None" blocks
          const items: CfgItem[] = [];
          collect(n.children, items, scope);
          if (items.length) {
            let name = blockTitle(n, scope);
            if (n.textParamRefId) name = name.replace(/\{\{0\}\}/g, resolve(n.textParamRefId, scope) ?? "");
            const node: Node = { block: { id: scope.rewrite(n.id), name: cap(name), items, level: 0, ...gridOf(n, scope) }, order: headOrder(n), seq: seq++, children: [] };
            into.push(node);
            walk(n.children, scope, node.children);
          } else if (n.children.length === 0 && (n.paramRefId || n.text)) {
            // A reached but childless block is a pure category header (e.g. the
            // "Scene" section): ETS shows it as a navigable node, so emit it as an
            // empty section rather than dropping it. (Headers in inactive choose
            // branches are never reached, so this adds no noise.)
            const name = cap(blockTitle(n, scope));
            if (name) into.push({ block: { id: scope.rewrite(n.id), name, items: [], level: 0 }, order: headOrder(n), seq: seq++, children: [] });
          } else {
            walk(n.children, scope, into); // transparent wrapper: children keep this level
          }
          break;
        }
        case "container": {
          // A Channel with a heading text becomes a navigable section (e.g.
          // "GRUNDMODUL {{0}}" -> "Basic module HMG 6 T"); {{0}} is the channel's
          // TextParameterRefId value, else its Number. A text-less container
          // (ChannelIndependentBlock, Repeat, generic Channel) stays transparent.
          const heading = n.text.trim();
          if (heading) {
            const name = cap(subst(n.text, scope).replace(/\{\{0\}\}/g, (n.textParamRefId ? resolve(n.textParamRefId, scope) : undefined) ?? n.number ?? ""));
            const node: Node = { block: { id: scope.rewrite(n.id), name, items: [], level: 0 }, order: n.number ? Number(n.number) : 0, seq: seq++, children: [] };
            into.push(node);
            walk(n.children, scope, node.children);
          } else {
            walk(n.children, scope, into);
          }
          break;
        }
        case "choose": { for (const w of selectWhens(n.paramRefId, n.whens, scope)) walk(w.children, scope, into); break; }
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) walk(def.dynamic, makeScope(n.refId, def, inst), into); break; }
        // Leaves: this pass builds the BLOCK TREE, and these are the block CONTENTS, gathered by
        // collect() from inside each block above. Listed rather than defaulted, so that a node kind
        // added later shows up as a compile error here instead of vanishing from the UI.
        case "paramRef": case "comObjRef": case "separator": case "button": case "assign": case "unsupported":
          break;
      }
    }
  };
  const roots: Node[] = [];
  walk(app.dynamic, TOP, roots);

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
        case "paramRef": { assignIfMerker(n.refId, scope, imgEnv); const v = resolve(n.refId, scope, imgEnv); if (v !== undefined) imageValues.set(scope.rewrite(n.refId), v); break; }
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
        // ignored by the image build. Hardware-confirmed on 1.1.56 (Steinel M-0083): P-26
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
        case "choose": { for (const w of selectWhens(n.paramRefId, n.whens, scope, imgEnv)) imgCollect(w.children, scope); break; }
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
  imgCollect(app.dynamic, TOP);

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

  return { blocks, hasModules: app.hasModules, dca: app.dca, imageValues, imageComObjects };
}
