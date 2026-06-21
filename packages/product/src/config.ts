import type { AppConfig, ComObjFlags, DynNode, DynWhen, ModuleDefModel, ModuleInstance } from "./appconfig.ts";

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
  control: "enum" | "number" | "text" | "unsupported";
  value: string;
  options?: { value: number; text: string }[];
  min?: number;
  max?: number;
  suffix?: string;
  readOnly?: boolean;
}
export interface CfgComObjView {
  refId: string; number: number; name: string; functionText: string;
  objectSize: string; dpt: string; flags: ComObjFlags;
}
export type CfgItem =
  | { kind: "separator"; text: string; uiHint: string }
  | { kind: "param"; param: CfgParamView }
  | { kind: "comObject"; comObject: CfgComObjView };
export interface CfgBlock { id: string; name: string; items: CfgItem[]; }
export interface DeviceConfigView { blocks: CfgBlock[]; hasModules: boolean; }

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

export function buildDeviceConfig(
  app: AppConfig,
  overrides: Map<string, string>,
  lang?: string,
  moduleInstances: ModuleInstance[] = [],
): DeviceConfigView {
  const language = lang ?? app.defaultLanguage;
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
    const name = subst(tr(param.id, "Text", param.text) || tr(defRefId, "Text", param.text), scope);
    const suffix = param.suffix ? subst(tr(param.id, "SuffixText", param.suffix), scope) : undefined;

    let control: CfgParamView["control"] = "unsupported";
    let options: CfgParamView["options"];
    if (type?.base === "Value" && type.enums.length) {
      control = "enum";
      options = type.enums.map((e) => ({ value: e.value, text: tr(e.id, "Text", e.text) }));
    } else if (type?.base === "Number") control = "number";
    else if (type?.base === "Text") control = "text";

    return { kind: "param", param: { refId: scope.rewrite(defRefId), name, control, value, options, min: type?.min, max: type?.max, suffix, readOnly: access === "Read" } };
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
        case "paramRef": { const it = buildParam(n.refId, scope); if (it) items.push(it); break; }
        case "comObjRef": { const it = buildComObj(n.refId, scope); if (it) items.push(it); break; }
        case "assign": env.set(scope.rewrite(n.target), n.value ?? (n.source ? resolve(n.source, scope) ?? "" : "")); break;
        case "choose": { const w = selectWhen(n.paramRefId, n.whens, scope); if (w) collect(w.children, items, scope); break; }
        case "container": collect(n.children, items, scope); break;
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) collect(def.dynamic, items, makeScope(n.refId, def, inst)); break; }
        case "block": break; // nested blocks become their own sections (walkBlocks)
      }
    }
  };

  // Emit a UI section per ParameterBlock, descending through containers, active
  // choose branches, and module instances in document order.
  const blocks: CfgBlock[] = [];
  const walkBlocks = (nodes: DynNode[], scope: Scope) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "block": {
          const items: CfgItem[] = [];
          collect(n.children, items, scope);
          if (items.length) {
            let name = subst(tr(n.id, "Text", n.text) || n.name, scope);
            if (n.textParamRefId) name = name.replace(/\{\{0\}\}/g, resolve(n.textParamRefId, scope) ?? "");
            blocks.push({ id: scope.rewrite(n.id), name, items });
          }
          walkBlocks(n.children, scope);
          break;
        }
        case "container": walkBlocks(n.children, scope); break;
        case "choose": { const w = selectWhen(n.paramRefId, n.whens, scope); if (w) walkBlocks(w.children, scope); break; }
        case "module": { const def = app.moduleDefs.get(n.refId); if (def) for (const inst of instancesFor(n.id)) walkBlocks(def.dynamic, makeScope(n.refId, def, inst)); break; }
        default: break;
      }
    }
  };
  walkBlocks(app.dynamic, TOP);

  return { blocks, hasModules: app.hasModules };
}
