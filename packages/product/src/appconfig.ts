import { XMLParser } from "fast-xml-parser";

// Parse a KNX ApplicationProgram for the configuration UI: parameter types with
// their enumerations and ranges, parameters and refs, communication objects, the
// dynamic visibility tree, and translations. Separate from application.ts (which
// serves the proven memory-image path) so that stays untouched.
//
// The dynamic tree's child order is semantically significant (first-matching
// `when`, default fallback, sequence of items), so we parse order-preserving.

export interface EnumOption { value: number; text: string; id: string; displayOrder: number; }
export interface CfgType {
  id: string;
  base: "Value" | "BinaryValue" | "Number" | "Float" | "Text" | "Color" | "Other";
  kind: string; // the raw ETS inner tag (TypeFloat, TypeTime, ...), for labelling unsupported types
  sizeInBit: number;
  signed: boolean;
  enums: EnumOption[];
  min?: number;
  max?: number;
  increment?: number; // TypeNumber spinner step (ETS Increment)
  uiHint?: string;    // ETS UIHint on the type (e.g. "Slider" for a numeric range)
  colorSpace?: string; // TypeColor Space ("RGB" | "HSV")
  moduleDefId?: string; // set when merged in from a ModuleDef Static
}
// A parameter. The memory fields (offset/bitOffset/codeSegment) and the `union`
// flag feed the image projection (toAppModel); `moduleDefId` records that this
// entry was merged in from a ModuleDef's Static (so the image projection, which
// mirrors the flat static model, can drop module-def and union entries to stay
// byte-identical to the legacy image parser).
export interface CfgParam {
  id: string; typeId: string; text: string; suffix?: string; value?: string; access?: string; hasMemory: boolean;
  offset?: number; bitOffset?: number; codeSegment?: string; union?: boolean; moduleDefId?: string;
  // For a module-def parameter: the Argument id its <Memory> Offset is relative to
  // (Memory@BaseOffset). The effective device offset is `offset + <instance value of
  // that argument>`; the per-instance base is resolved either from the project 0.xml
  // (ModuleInstance args) or, for a from-scratch device, by re-running the allocators.
  baseOffsetArg?: string;
}
export interface CfgParamRef { id: string; paramId: string; value?: string; access?: string; displayOrder?: number; moduleDefId?: string; }
export interface CfgSegment { id: string; lsm: number; size: number; data: Buffer; }
// An absolute-addressed memory segment (Code/AbsoluteSegment). Used by the MV-0705
// parameter model, where parameters live in an EEPROM segment at a FIXED address
// (no allocator), with the default image in <Data>. Kept separate from the
// LSM-keyed CfgSegment so the proven RelativeSegment image path is untouched; the
// MV-0705 image build (deviceimage.ts) consumes these. `address` is the literal
// device address to read/write the segment at.
export interface CfgAbsSegment { id: string; address: number; size: number; data: Buffer; }
export interface ComObjFlags { read: boolean; write: boolean; comm: boolean; transmit: boolean; update: boolean; readOnInit: boolean; }
export interface CfgComObject {
  id: string; number: number; name: string; text: string; functionText: string;
  objectSize: string; dpt: string; flags: ComObjFlags; textParamRefId?: string; baseNumber?: string;
}
export interface CfgComObjectRef {
  id: string; refId: string; text?: string; functionText?: string; objectSize?: string;
  dpt?: string; flags: Partial<ComObjFlags>; textParamRefId?: string;
}

export type DynNode =
  | { kind: "block"; id: string; name: string; text: string; textParamRefId?: string; paramRefId?: string; access?: string; children: DynNode[] }
  // `repeatCount` is set only for a <Repeat> (its literal Count): the from-scratch
  // instance resolver replays the children that many times to allocate per-instance.
  | { kind: "container"; id: string; name: string; text: string; textParamRefId?: string; number?: string; repeatCount?: number; children: DynNode[] }
  | { kind: "separator"; id: string; text: string; uiHint: string }
  | { kind: "unsupported"; tag: string }
  | { kind: "paramRef"; refId: string; indent?: number }
  | { kind: "comObjRef"; refId: string }
  | { kind: "choose"; paramRefId: string; whens: DynWhen[] }
  | { kind: "assign"; target: string; source?: string; value?: string }
  // A module instantiation point. `numArgs`/`textArgs` bind the module-def arguments
  // either to a literal value or (numeric) to an allocator, the inputs the from-scratch
  // resolver needs to compute per-instance base offsets without a project 0.xml.
  | { kind: "module"; refId: string; id: string; numArgs: ModuleNumArg[]; textArgs: ModuleTextArg[] };
export interface ModuleNumArg { argId: string; allocatorRefId?: string; value?: string }
export interface ModuleTextArg { argId: string; value: string }
export interface DynWhen { test?: string; isDefault: boolean; children: DynNode[] }

export type Translations = Map<string, Map<string, Map<string, string>>>; // lang -> elemId -> attr -> text

// A module-def argument. `allocates` (ETS Allocates) is the count this argument
// consumes from its allocator per instance: re-running the allocators hands each
// successive instance `allocator.start + cumulative allocates`, which is the value a
// memory BaseOffset adds. Text arguments (names) have no Allocates.
export interface ModuleArg { id: string; name: string; type: string; allocates?: number; }
export interface ModuleDefModel { id: string; args: ModuleArg[]; dynamic: DynNode[]; }

// A from-scratch allocator (Static/Allocators): a counter that hands out the
// per-instance base values the project 0.xml otherwise pins. `start` is the first
// value; each consuming instance advances it by the argument's `allocates`.
export interface Allocator { id: string; start: number; maxInclusive: number; }

// A device's module instances (from 0.xml), pinning each instance's resolved
// argument values. id/refId are prefix-stripped as ETS stores them.
export interface ModuleInstance { id: string; refId: string; args: { refId: string; value: string }[]; }

// A device whose real configuration lives in a manufacturer ETS "DCA" (Device
// Configuration App): a Windows-only .NET/WPF plugin that runs inside ETS, e.g.
// a DALI gateway's line scan, ECG addressing, groups and scenes. busforge cannot
// run that plugin or read its proprietary config; we only flag it so the gap is
// explicit. The standard parameters below the notice are still editable and safe
// to program (the DCA's config lives in separate interface objects we never touch).
export interface DcaInfo { hint: string; module?: DcaModuleInfo }

// A busforge-native module that re-implements a specific DCA, resolved for this
// device by the server's module registry. `compatible` is false when the module
// exists but does not declare this device's application version as supported, in
// which case the UI offers it "at your own risk". Filled in server-side; the
// product layer only carries the type.
export interface DcaModuleInfo {
  id: string;
  displayName: string;
  category: string;          // generic kind, e.g. "DALI configuration"
  compatible: boolean;
  deviceVersion: number;     // this device's ETS ApplicationVersion
  supportedVersions: number[]; // versions the module declares it was built for
}

export interface AppConfig {
  id: string;
  mask: string;
  appVersion: number;
  appNumber: number;
  defaultLanguage: string;
  languages: string[];
  types: Map<string, CfgType>;
  params: Map<string, CfgParam>;
  refs: Map<string, CfgParamRef>;
  comObjects: Map<string, CfgComObject>;
  comObjectRefs: Map<string, CfgComObjectRef>;
  segments: CfgSegment[]; // memory segments (Code/RelativeSegment), for the image projection
  absoluteSegments: CfgAbsSegment[]; // Code/AbsoluteSegment (MV-0705 parameter model)
  translations: Translations;
  dynamic: DynNode[];
  moduleDefs: Map<string, ModuleDefModel>;
  allocators: Map<string, Allocator>; // Static/Allocators, for from-scratch instance resolution
  hasModules: boolean;
  dca?: DcaInfo;
}

// --- order-preserving node helpers (fast-xml-parser preserveOrder shape) ---
type ONode = Record<string, any>;
const tagOf = (n: ONode): string => Object.keys(n).find((k) => k !== ":@")!;
const attrsOf = (n: ONode): Record<string, string> => n[":@"] ?? {};
const kidsOf = (n: ONode): ONode[] => (Array.isArray(n[tagOf(n)]) ? n[tagOf(n)] : []);
const childrenByTag = (nodes: ONode[], tag: string): ONode[] => nodes.filter((n) => tagOf(n) === tag);
const firstByTag = (nodes: ONode[], tag: string): ONode | undefined => nodes.find((n) => tagOf(n) === tag);
// The order-preserving parser splits attributes (under ":@") from child elements,
// unlike the merged parser. ETS authors most fields as attributes but large payloads
// (a segment's base64 Data, long texts) as child-element text. Read either form
// uniformly, so a field authored as an element instead of an attribute still resolves
// (this is what the legacy merged parser did implicitly).
const concatText = (n: ONode): string => kidsOf(n).map((k) => k["#text"]).filter((t) => t !== undefined).join("");
function attrOrText(n: ONode, name: string): string | undefined {
  const a = attrsOf(n)[name];
  if (a !== undefined) return a;
  const child = firstByTag(kidsOf(n), name);
  return child ? concatText(child) : undefined;
}
function deepFirst(nodes: ONode[], tag: string): ONode | undefined {
  for (const n of nodes) {
    if (tagOf(n) === tag) return n;
    const r = deepFirst(kidsOf(n), tag);
    if (r) return r;
  }
  return undefined;
}

const num = (s: string | undefined): number | undefined => (s === undefined ? undefined : Number(s));
const bool = (s: string | undefined): boolean => s === "Enabled" || s === "true";

export function parseAppConfig(xml: string): AppConfig {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", attributesGroupName: ":@", preserveOrder: true });
  const root = p.parse(xml) as ONode[];
  const app = deepFirst(root, "ApplicationProgram");
  if (!app) throw new Error("no ApplicationProgram");
  const appAttrs = attrsOf(app);
  const appKids = kidsOf(app);
  const staticNode = firstByTag(appKids, "Static");
  const staticKids = staticNode ? kidsOf(staticNode) : [];

  const types = parseTypes(staticKids);
  const { params } = parseParams(staticKids);
  const refs = parseRefs(staticKids);
  const comObjects = parseComObjects(staticKids);
  const comObjectRefs = parseComObjectRefs(staticKids);
  const segments = parseSegments(staticKids);
  const absoluteSegments = parseAbsoluteSegments(staticKids);
  const allocators = parseAllocators(staticKids);

  // Module definitions: merge each def's Static (its ids are globally unique,
  // prefixed with the MD id) into the shared maps, and keep its Arguments +
  // Dynamic tree for instantiation. Merged entries are tagged with the def id so
  // the image projection can exclude them (modules are not byte-placed).
  const moduleDefs = new Map<string, ModuleDefModel>();
  const defsContainer = firstByTag(appKids, "ModuleDefs");
  const merge = <V,>(target: Map<string, V>, src: Map<string, V>) => { for (const [k, v] of src) target.set(k, v); };
  const tagMod = <V extends { moduleDefId?: string }>(m: Map<string, V>, mdId: string) => { for (const v of m.values()) v.moduleDefId = mdId; return m; };
  for (const md of defsContainer ? childrenByTag(kidsOf(defsContainer), "ModuleDef") : []) {
    const mdId = attrsOf(md).Id;
    const mdKids = kidsOf(md);
    const mdStatic = firstByTag(mdKids, "Static");
    const mdStaticKids = mdStatic ? kidsOf(mdStatic) : [];
    merge(types, tagMod(parseTypes(mdStaticKids), mdId));
    merge(params, tagMod(parseParams(mdStaticKids).params, mdId));
    merge(refs, tagMod(parseRefs(mdStaticKids), mdId));
    merge(comObjects, parseComObjects(mdStaticKids));
    merge(comObjectRefs, parseComObjectRefs(mdStaticKids));
    const args: ModuleArg[] = childrenByTag(firstByTag(mdKids, "Arguments") ? kidsOf(firstByTag(mdKids, "Arguments")!) : [], "Argument")
      .map((a) => { const aa = attrsOf(a); return { id: aa.Id, name: aa.Name ?? "", type: aa.Type ?? "Numeric", allocates: aa.Allocates !== undefined ? Number(aa.Allocates) : undefined }; });
    const mdDynamic = firstByTag(mdKids, "Dynamic");
    const dyn = mdDynamic ? kidsOf(mdDynamic).map(parseDyn).filter(Boolean) as DynNode[] : [];
    moduleDefs.set(mdId, { id: mdId, args, dynamic: dyn });
  }

  // Languages may sit inside ApplicationProgram or as a sibling after it, so
  // search the whole document.
  const langsNode = deepFirst(root, "Languages");
  const langNodes = langsNode ? childrenByTag(kidsOf(langsNode), "Language") : [];
  const translations = parseTranslations(langNodes);
  const languages = langNodes.map((l) => attrsOf(l).Identifier);

  const dynamicNode = firstByTag(appKids, "Dynamic");
  const dynamic = dynamicNode ? kidsOf(dynamicNode).map(parseDyn).filter(Boolean) as DynNode[] : [];
  const hasModules = moduleDefs.size > 0;

  // ETS marks DCA-driven application programs in their name/description (e.g.
  // "DALI-Gateway KNX plus (DCA Version)" with "you need the ETS DCA App
  // installed"). Detect that explicit marker; the manufacturer's own description
  // becomes the hint we show next to the notice.
  const desc = appAttrs.VisibleDescription ?? "";
  const dca = /\bDCA\b/i.test(appAttrs.Name ?? "") || /\bDCA\b/i.test(desc) ? { hint: desc.trim() } : undefined;

  return {
    id: appAttrs.Id,
    mask: appAttrs.MaskVersion ?? "",
    appVersion: Number(appAttrs.ApplicationVersion ?? 0),
    appNumber: Number(appAttrs.ApplicationNumber ?? 0),
    defaultLanguage: appAttrs.DefaultLanguage ?? "en-US",
    languages,
    types, params, refs, comObjects, comObjectRefs, segments, absoluteSegments, translations, dynamic, moduleDefs, allocators, hasModules, dca,
  };
}

// Allocators (Static/Allocators): named counters used to hand out per-instance base
// offsets / object numbers when ETS compiles a project. Parsed so a from-scratch
// device (no 0.xml) can re-run them; an imported device reads the pinned results.
function parseAllocators(staticKids: ONode[]): Map<string, Allocator> {
  const out = new Map<string, Allocator>();
  const container = firstByTag(staticKids, "Allocators");
  for (const a of container ? childrenByTag(kidsOf(container), "Allocator") : []) {
    const aa = attrsOf(a);
    out.set(aa.Id, { id: aa.Id, start: Number(aa.Start), maxInclusive: Number(aa.maxInclusive) });
  }
  return out;
}

function parseTypes(staticKids: ONode[]): Map<string, CfgType> {
  const out = new Map<string, CfgType>();
  const container = firstByTag(staticKids, "ParameterTypes");
  for (const t of container ? childrenByTag(kidsOf(container), "ParameterType") : []) {
    const id = attrsOf(t).Id;
    const inner = kidsOf(t)[0];
    if (!inner) { out.set(id, { id, base: "Other", kind: "", sizeInBit: 0, signed: false, enums: [] }); continue; }
    const ia = attrsOf(inner);
    const tag = tagOf(inner);
    let base: CfgType["base"] = "Other";
    let enums: EnumOption[] = [];
    if (tag === "TypeRestriction") {
      base = ia.Base === "BinaryValue" ? "BinaryValue" : "Value";
      // ETS shows enum options ordered by DisplayOrder, not document order.
      enums = childrenByTag(kidsOf(inner), "Enumeration").map((e, i) => {
        const ea = attrsOf(e);
        return { value: Number(ea.Value), text: ea.Text ?? "", id: ea.Id, displayOrder: ea.DisplayOrder !== undefined ? Number(ea.DisplayOrder) : i };
      }).sort((a, b) => a.displayOrder - b.displayOrder);
    } else if (tag === "TypeNumber") base = "Number";
    else if (tag === "TypeFloat") base = "Float";
    else if (tag === "TypeText") base = "Text";
    else if (tag === "TypeColor") base = "Color";
    // KNX TypeNumber@Type is "signedInt" / "unsignedInt". Test for signedness
    // exactly: a naive includes("signed") also matches "unsignedInt", which would
    // mis-decode every unsigned value >= 128 as negative on read-back.
    const typeAttr = String(ia.Type ?? "").toLowerCase();
    out.set(id, {
      id, base, kind: tag,
      sizeInBit: Number(ia.SizeInBit ?? (base === "Float" ? 16 : 0)),
      signed: typeAttr.includes("signed") && !typeAttr.includes("unsigned"),
      enums,
      min: num(ia.minInclusive),
      max: num(ia.maxInclusive),
      increment: num(ia.Increment),
      uiHint: ia.UIHint,
      colorSpace: ia.Space,
    });
  }
  return out;
}

function parseParams(staticKids: ONode[]): { params: Map<string, CfgParam> } {
  const params = new Map<string, CfgParam>();
  const container = firstByTag(staticKids, "Parameters");
  // `unionMem` is the <Union>'s shared <Memory> attributes (present only for union
  // children). A normal parameter carries its own <Memory> child; a union parameter's
  // memory is the union's, and the parameter's own Offset/BitOffset ATTRIBUTES are
  // relative to that shared base (union branches overlap; only the visible one is
  // written). The union flag stays so the proven RelativeSegment image projection can
  // keep excluding them by default (toAppModel), byte-identical to the legacy parser.
  const add = (pa: ONode, union: boolean, unionMem?: Record<string, string>) => {
    const a = attrsOf(pa);
    const mem = firstByTag(kidsOf(pa), "Memory");
    const ma = mem ? attrsOf(mem) : undefined;
    params.set(a.Id, {
      id: a.Id, typeId: a.ParameterType, text: a.Text ?? "", suffix: a.SuffixText, value: a.Value, access: a.Access,
      hasMemory: unionMem ? unionMem.CodeSegment !== undefined : !!mem,
      offset: unionMem ? Number(unionMem.Offset) + Number(a.Offset ?? 0) : ma ? Number(ma.Offset) : undefined,
      bitOffset: unionMem ? Number(unionMem.BitOffset ?? 0) + Number(a.BitOffset ?? 0) : ma ? Number(ma.BitOffset ?? 0) : undefined,
      codeSegment: unionMem ? unionMem.CodeSegment : ma?.CodeSegment,
      baseOffsetArg: ma?.BaseOffset,
      union: union || undefined,
    });
  };
  for (const pa of container ? childrenByTag(kidsOf(container), "Parameter") : []) add(pa, false);
  // Union children are parameters too (overlapping memory), placed at the union's
  // shared <Memory>. Included for the UI and (opt-in) the MV-0705 image build.
  for (const u of container ? childrenByTag(kidsOf(container), "Union") : []) {
    const umem = firstByTag(kidsOf(u), "Memory");
    const uma = umem ? attrsOf(umem) : undefined;
    for (const pa of childrenByTag(kidsOf(u), "Parameter")) add(pa, true, uma);
  }
  return { params };
}

// Memory segments (Code/RelativeSegment): the default image plus its size, keyed by
// the load-state-machine. Parsed once here so the image projection does not re-read
// the XML.
function parseSegments(staticKids: ONode[]): CfgSegment[] {
  const code = firstByTag(staticKids, "Code");
  const out: CfgSegment[] = [];
  for (const s of code ? childrenByTag(kidsOf(code), "RelativeSegment") : []) {
    const a = attrsOf(s);
    // Default image: ETS authors it as a <Data> child element, older catalogues as a
    // Data attribute; attrOrText resolves either form.
    out.push({ id: a.Id, lsm: Number(a.LoadStateMachine), size: Number(a.Size), data: Buffer.from(attrOrText(s, "Data") ?? "", "base64") });
  }
  return out;
}

// Absolute memory segments (Code/AbsoluteSegment): the MV-0705 parameter model. Same
// default-image shape as a RelativeSegment (a <Data> child or Data attribute), but
// placed at a fixed device Address instead of via an allocator. Only segments that
// carry a default image are useful for the parameter build; RAM scratch segments
// (no Data) are kept too so the set is faithful, and the build filters by what the
// <Memory> parameters actually target.
function parseAbsoluteSegments(staticKids: ONode[]): CfgAbsSegment[] {
  const code = firstByTag(staticKids, "Code");
  const out: CfgAbsSegment[] = [];
  for (const s of code ? childrenByTag(kidsOf(code), "AbsoluteSegment") : []) {
    const a = attrsOf(s);
    out.push({ id: a.Id, address: Number(a.Address), size: Number(a.Size), data: Buffer.from(attrOrText(s, "Data") ?? "", "base64") });
  }
  return out;
}

function parseRefs(staticKids: ONode[]): Map<string, CfgParamRef> {
  const refs = new Map<string, CfgParamRef>();
  const container = firstByTag(staticKids, "ParameterRefs");
  for (const r of container ? childrenByTag(kidsOf(container), "ParameterRef") : []) {
    const a = attrsOf(r);
    refs.set(a.Id, { id: a.Id, paramId: a.RefId, value: a.Value, access: a.Access, displayOrder: a.DisplayOrder !== undefined ? Number(a.DisplayOrder) : undefined });
  }
  return refs;
}

function parseComObjects(staticKids: ONode[]): Map<string, CfgComObject> {
  const out = new Map<string, CfgComObject>();
  // Top-level apps use <ComObjectTable>; module defs use <ComObjects>.
  const container = firstByTag(staticKids, "ComObjectTable") ?? firstByTag(staticKids, "ComObjects");
  for (const c of container ? childrenByTag(kidsOf(container), "ComObject") : []) {
    const a = attrsOf(c);
    out.set(a.Id, {
      id: a.Id, number: Number(a.Number ?? 0), name: a.Name ?? "", text: a.Text ?? "",
      functionText: a.FunctionText ?? "", objectSize: a.ObjectSize ?? "", dpt: a.DatapointType ?? "",
      flags: { read: bool(a.ReadFlag), write: bool(a.WriteFlag), comm: bool(a.CommunicationFlag), transmit: bool(a.TransmitFlag), update: bool(a.UpdateFlag), readOnInit: bool(a.ReadOnInitFlag) },
      textParamRefId: a.TextParameterRefId,
      baseNumber: a.BaseNumber,
    });
  }
  return out;
}

function parseComObjectRefs(staticKids: ONode[]): Map<string, CfgComObjectRef> {
  const out = new Map<string, CfgComObjectRef>();
  const container = firstByTag(staticKids, "ComObjectRefs");
  for (const c of container ? childrenByTag(kidsOf(container), "ComObjectRef") : []) {
    const a = attrsOf(c);
    const flags: Partial<ComObjFlags> = {};
    if (a.ReadFlag) flags.read = bool(a.ReadFlag);
    if (a.WriteFlag) flags.write = bool(a.WriteFlag);
    if (a.CommunicationFlag) flags.comm = bool(a.CommunicationFlag);
    if (a.TransmitFlag) flags.transmit = bool(a.TransmitFlag);
    if (a.UpdateFlag) flags.update = bool(a.UpdateFlag);
    if (a.ReadOnInitFlag) flags.readOnInit = bool(a.ReadOnInitFlag);
    out.set(a.Id, {
      id: a.Id, refId: a.RefId, text: a.Text, functionText: a.FunctionText,
      objectSize: a.ObjectSize, dpt: a.DatapointType, flags, textParamRefId: a.TextParameterRefId,
    });
  }
  return out;
}

function parseTranslations(langNodes: ONode[]): Translations {
  const out: Translations = new Map();
  for (const lang of langNodes) {
    const id = attrsOf(lang).Identifier;
    const elemMap = new Map<string, Map<string, string>>();
    for (const unit of childrenByTag(kidsOf(lang), "TranslationUnit")) {
      for (const el of childrenByTag(kidsOf(unit), "TranslationElement")) {
        const refId = attrsOf(el).RefId;
        const attrMap = new Map<string, string>();
        for (const tr of childrenByTag(kidsOf(el), "Translation")) {
          const ta = attrsOf(tr);
          attrMap.set(ta.AttributeName, ta.Text ?? "");
        }
        elemMap.set(refId, attrMap);
      }
    }
    out.set(id, elemMap);
  }
  return out;
}

function parseDyn(n: ONode): DynNode | null {
  const tag = tagOf(n);
  const a = attrsOf(n);
  switch (tag) {
    case "ChannelIndependentBlock":
    case "Channel":
    // A Repeat wraps a Module that is replicated once per channel (e.g. the six
    // HMG heating channels). The actual instances and their args come from the
    // device's 0.xml, so treat Repeat as transparent and let the Module case +
    // instance lookup expand each one; without this the whole repeated block (a
    // large part of channel devices) silently disappears.
    case "Repeat":
      return { kind: "container", id: a.Id ?? "", name: a.Name ?? "", text: a.Text ?? "", textParamRefId: a.TextParameterRefId, number: a.Number, repeatCount: a.Count !== undefined ? Number(a.Count) : undefined, children: kidsOf(n).map(parseDyn).filter(Boolean) as DynNode[] };
    case "ParameterBlock":
      return { kind: "block", id: a.Id ?? "", name: a.Name ?? "", text: a.Text ?? "", textParamRefId: a.TextParameterRefId, paramRefId: a.ParamRefId, access: a.Access, children: kidsOf(n).map(parseDyn).filter(Boolean) as DynNode[] };
    case "ParameterSeparator":
      return { kind: "separator", id: a.Id ?? "", text: a.Text ?? "", uiHint: a.UIHint ?? "" };
    case "ParameterRefRef":
      return { kind: "paramRef", refId: a.RefId, indent: a.IndentLevel !== undefined ? Number(a.IndentLevel) : undefined };
    case "ComObjectRefRef":
      return { kind: "comObjRef", refId: a.RefId };
    case "Assign":
      return { kind: "assign", target: a.TargetParamRefRef, source: a.SourceParamRefRef, value: a.Value };
    case "Module": {
      // ETS binds each module argument as a child <NumericArg> (literal Value or an
      // AllocatorRefId) or <TextArg> (literal name). Capture both so the from-scratch
      // resolver can allocate per-instance base offsets.
      const numArgs: ModuleNumArg[] = childrenByTag(kidsOf(n), "NumericArg").map((x) => { const xa = attrsOf(x); return { argId: xa.RefId, allocatorRefId: xa.AllocatorRefId, value: xa.Value }; });
      const textArgs: ModuleTextArg[] = childrenByTag(kidsOf(n), "TextArg").map((x) => { const xa = attrsOf(x); return { argId: xa.RefId, value: xa.Value ?? "" }; });
      return { kind: "module", refId: a.RefId, id: a.Id ?? "", numArgs, textArgs };
    }
    case "choose": {
      const whens: DynWhen[] = childrenByTag(kidsOf(n), "when").map((w) => {
        const wa = attrsOf(w);
        return { test: wa.test, isDefault: wa.default === "true", children: kidsOf(w).map(parseDyn).filter(Boolean) as DynNode[] };
      });
      return { kind: "choose", paramRefId: a.ParamRefId, whens };
    }
    default:
      // Surface a genuinely unknown ELEMENT as a visible marker instead of
      // dropping it silently (text/whitespace pseudo-nodes are ignored).
      return tag && !tag.startsWith("#") ? { kind: "unsupported", tag } : null;
  }
}
