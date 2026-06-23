import type { AppConfig, CfgType, ComObjFlags, DcaInfo, DynNode, DynWhen, ModuleDefModel, ModuleInstance } from "./appconfig.ts";

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
  control: "enum" | "number" | "text" | "color" | "unsupported";
  value: string;
  options?: { value: number; text: string }[];
  min?: number;
  max?: number;
  suffix?: string;
  step?: number; // number spinner step (ETS Increment)
  slider?: boolean; // ETS UIHint="Slider": render a range slider (needs min+max)
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
export type CfgItem =
  | { kind: "separator"; text: string; uiHint: string }
  | { kind: "param"; param: CfgParamView }
  | { kind: "comObject"; comObject: CfgComObjView }
  | { kind: "unsupported"; label: string }; // an ETS dynamic element the engine does not handle yet
export interface CfgBlock { id: string; name: string; items: CfgItem[]; level: number; parentId?: string; }
export interface DeviceConfigView { blocks: CfgBlock[]; hasModules: boolean; dca?: DcaInfo; }

interface Scope {
  rewrite: (id: string) => string;     // module-def id -> device instance id (identity at top level)
  textArgs: Map<string, string>;       // arg name -> value, for {{name}} substitution
  argValue: (argId: string) => number; // resolved numeric arg, for com-object base numbering
}
const TOP: Scope = { rewrite: (id) => id, textArgs: new Map(), argValue: () => 0 };

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
): DeviceConfigView {
  const language = resolveLanguage(app, lang);
  const env = new Map(overrides); // working values; Assign mutates this

  // Effective value: device instance value (keyed by the rewritten instance id)
  // else the module-def ref default else the parameter default.
  const resolve = (defRefId: string, scope: Scope): string | undefined => {
    const instId = scope.rewrite(defRefId);
    if (env.has(instId)) return env.get(instId);
    const ref = app.refs.get(defRefId);
    return ref?.value ?? (ref ? app.params.get(ref.paramId)?.value : undefined);
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
  // the catalogue's language (some texts are authored lower-case).
  const cap = (s: string): string => { const t = s.replace(/\r\n?/g, "\n").trim(); return t ? t.charAt(0).toLocaleUpperCase(language) + t.slice(1) : t; };

  const selectWhen = (defParamRefId: string, whens: DynWhen[], scope: Scope): DynWhen | undefined => {
    const v = Number(resolve(defParamRefId, scope) ?? 0);
    for (const w of whens) if (!w.isDefault && w.test !== undefined && matchTest(w.test, v)) return w;
    return whens.find((w) => w.isDefault);
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
    const name = cap(subst(tr(param.id, "Text", param.text) || tr(defRefId, "Text", param.text), scope));
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
    else if (type?.base === "Text") control = "text";
    // TypeColor stores an #RRGGBB hex. Only the RGB space maps directly to the
    // native sRGB colour picker; HSV (and any other space) stays unsupported
    // until its encoding is verified, so we never write a wrong colour back.
    else if (type?.base === "Color" && type.colorSpace === "RGB") control = "color";

    const defaultValue = ref.value ?? param.value ?? "";
    const typeLabel = control === "unsupported" ? unsupportedTypeLabel(type) : undefined;
    // ETS spinner step / slider hint live on the TypeNumber; a slider needs a
    // bounded range to render, so fall back to the plain number input without one.
    const step = control === "number" ? type?.increment : undefined;
    const slider = control === "number" && type?.uiHint === "Slider" && type.min !== undefined && type.max !== undefined;
    return { kind: "param", param: { refId: scope.rewrite(defRefId), name, control, value, options, min: type?.min, max: type?.max, suffix, step, slider, readOnly: access === "Read", defaultValue, typeLabel } };
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
    return {
      kind: "comObject",
      comObject: {
        refId: scope.rewrite(defRefId),
        number: obj.number + (obj.baseNumber ? scope.argValue(obj.baseNumber) : 0),
        name: fill(tr(elem, "Text", pick(ref?.text, obj.text)) || obj.name),
        functionText: fill(tr(elem, "FunctionText", pick(ref?.functionText, obj.functionText))),
        objectSize: pick(ref?.objectSize, obj.objectSize),
        dpt: pick(ref?.dpt, obj.dpt),
        flags: { ...obj.flags, ...ref?.flags },
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
      argValue: (argId) => argMap.get(argId) ?? 0,
    };
  };
  const instancesFor = (moduleNodeId: string) => moduleInstances.filter((mi) => `${app.id}_${mi.refId}` === moduleNodeId);

  // Walk a node sequence in order, appending items to the current block. Active
  // choose branches inline their items; Assign mutates env; Module nodes expand
  // each device instance with its own scope.
  const collect = (nodes: DynNode[], items: CfgItem[], scope: Scope) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "separator": items.push({ kind: "separator", text: subst(tr(n.id, "Text", n.text), scope), uiHint: n.uiHint }); break;
        case "paramRef": { const it = buildParam(n.refId, scope); if (it) { if (it.kind === "param" && n.indent) it.param.indent = n.indent; items.push(it); } break; }
        case "comObjRef": { const it = buildComObj(n.refId, scope); if (it) items.push(it); break; }
        case "assign": env.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope) ?? "" : "")); break;
        case "choose": { const w = selectWhen(n.paramRefId, n.whens, scope); if (w) collect(w.children, items, scope); break; }
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
            const node: Node = { block: { id: scope.rewrite(n.id), name: cap(name), items, level: 0 }, order: headOrder(n), seq: seq++, children: [] };
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
        case "choose": { const w = selectWhen(n.paramRefId, n.whens, scope); if (w) walk(w.children, scope, into); break; }
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) walk(def.dynamic, makeScope(n.refId, def, inst), into); break; }
        default: break;
      }
    }
  };
  const roots: Node[] = [];
  walk(app.dynamic, TOP, roots);

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

  return { blocks, hasModules: app.hasModules, dca: app.dca };
}
