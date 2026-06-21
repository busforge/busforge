import type { AppConfig, ComObjFlags, DynNode, DynWhen } from "./appconfig.ts";

// The device-configuration engine: given an application program and a device's
// parameter values, produce the visible, grouped, localized parameter tree plus
// the device's communication objects. Pure and re-runnable on every edit so
// conditional visibility updates live. Module instantiation is Phase 2.

export interface CfgParamView {
  refId: string;
  name: string;
  control: "enum" | "number" | "text" | "unsupported";
  value: string;
  options?: { value: number; text: string }[];
  min?: number;
  max?: number;
  suffix?: string;
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

export function buildDeviceConfig(app: AppConfig, overrides: Map<string, string>, lang?: string): DeviceConfigView {
  const language = lang ?? app.defaultLanguage;
  const env = new Map(overrides); // working values; Assign mutates this

  const resolve = (refId: string): string | undefined => {
    if (env.has(refId)) return env.get(refId);
    const ref = app.refs.get(refId);
    return ref?.value ?? (ref ? app.params.get(ref.paramId)?.value : undefined);
  };
  const tr = (elemId: string | undefined, attr: string, base: string): string => {
    if (!elemId || language === app.defaultLanguage) return base;
    return app.translations.get(language)?.get(elemId)?.get(attr) ?? base;
  };

  const selectWhen = (paramRefId: string, whens: DynWhen[]): DynWhen | undefined => {
    const v = Number(resolve(paramRefId) ?? 0);
    for (const w of whens) if (!w.isDefault && w.test !== undefined && matchTest(w.test, v)) return w;
    return whens.find((w) => w.isDefault);
  };

  const buildParam = (refId: string): CfgItem | null => {
    const ref = app.refs.get(refId);
    if (!ref) return null;
    const param = app.params.get(ref.paramId);
    if (!param) return null;
    const type = app.types.get(param.typeId);
    const value = resolve(refId) ?? "";
    const name = tr(param.id, "Text", param.text) || tr(refId, "Text", param.text);
    const suffix = param.suffix ? tr(param.id, "SuffixText", param.suffix) : undefined;

    let control: CfgParamView["control"] = "unsupported";
    let options: CfgParamView["options"];
    if (type?.base === "Value" && type.enums.length) {
      control = "enum";
      options = type.enums.map((e) => ({ value: e.value, text: tr(e.id, "Text", e.text) }));
    } else if (type?.base === "Number") control = "number";
    else if (type?.base === "Text") control = "text";

    return { kind: "param", param: { refId, name, control, value, options, min: type?.min, max: type?.max, suffix } };
  };

  const buildComObj = (refId: string): CfgItem | null => {
    const ref = app.comObjectRefs.get(refId);
    const obj = ref ? app.comObjects.get(ref.refId) : app.comObjects.get(refId);
    if (!obj) return null;
    const pick = (r: string | undefined, o: string) => (r !== undefined ? r : o);
    const textParamRefId = ref?.textParamRefId ?? obj.textParamRefId;
    const subst = (s: string) => (textParamRefId ? s.replace(/\{\{0\}\}/g, resolve(textParamRefId) ?? "") : s);
    const elem = ref?.id ?? obj.id;
    return {
      kind: "comObject",
      comObject: {
        refId,
        number: obj.number,
        name: subst(tr(elem, "Text", pick(ref?.text, obj.text)) || obj.name),
        functionText: subst(tr(elem, "FunctionText", pick(ref?.functionText, obj.functionText))),
        objectSize: pick(ref?.objectSize, obj.objectSize),
        dpt: pick(ref?.dpt, obj.dpt),
        flags: { ...obj.flags, ...ref?.flags },
      },
    };
  };

  // Walk a node sequence in order, appending items to the current block. Active
  // choose branches inline their items; Assign mutates env for later chooses.
  const collect = (nodes: DynNode[], items: CfgItem[]) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "separator": items.push({ kind: "separator", text: tr(n.id, "Text", n.text), uiHint: n.uiHint }); break;
        case "paramRef": { const it = buildParam(n.refId); if (it) items.push(it); break; }
        case "comObjRef": { const it = buildComObj(n.refId); if (it) items.push(it); break; }
        case "assign": env.set(n.target, n.value ?? (n.source ? resolve(n.source) ?? "" : "")); break;
        case "choose": { const w = selectWhen(n.paramRefId, n.whens); if (w) collect(w.children, items); break; }
        case "container": collect(n.children, items); break;
        case "block": break;  // nested blocks handled as their own sections (see walkBlocks)
        case "module": break; // Phase 2
      }
    }
  };

  // Emit a UI section per ParameterBlock, descending through containers and
  // active choose branches to find them in document order.
  const blocks: CfgBlock[] = [];
  const walkBlocks = (nodes: DynNode[]) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "block": {
          const items: CfgItem[] = [];
          collect(n.children, items);
          if (items.length) blocks.push({ id: n.id, name: tr(n.id, "Text", n.text) || n.name, items });
          walkBlocks(n.children); // surface any nested ParameterBlocks too
          break;
        }
        case "container": walkBlocks(n.children); break;
        case "choose": { const w = selectWhen(n.paramRefId, n.whens); if (w) walkBlocks(w.children); break; }
        default: break;
      }
    }
  };
  walkBlocks(app.dynamic);

  return { blocks, hasModules: app.hasModules };
}
