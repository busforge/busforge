import { XMLParser } from "fast-xml-parser";
import { ProductError } from "./errors.ts";
import { type ONode, tagOf, attrsOf, kidsOf, childrenByTag, firstByTag } from "./onode.ts";
import { loadProceduresOf, type LoadProcedures } from "./loadproc.ts";

// Parse a KNX ApplicationProgram for the configuration UI: parameter types with
// their enumerations and ranges, parameters and refs, communication objects, the
// dynamic visibility tree, and translations. Separate from application.ts (which
// serves the proven memory-image path) so that stays untouched.
//
// The dynamic tree's child order is semantically significant (first-matching
// `when`, default fallback, sequence of items), so we parse order-preserving.

// `binary`: a BinaryValue enumeration's bytes (its base64 BinaryValue attribute, decoded), which
// ETS writes for that value instead of the number.
export interface EnumOption { value: number; text: string; id: string; displayOrder: number; binary?: Buffer; }
export interface CfgType {
  id: string;
  base: "Value" | "BinaryValue" | "Number" | "Float" | "Text" | "Color" | "Time" | "IPAddress" | "Other";
  kind: string; // the raw ETS inner tag (TypeFloat, TypeTime, ...), for labelling unsupported types
  sizeInBit: number;
  signed: boolean;
  enums: EnumOption[];
  min?: number;
  max?: number;
  increment?: number; // TypeNumber spinner step (ETS Increment)
  uiHint?: string;    // ETS UIHint on the type (e.g. "Slider" for a numeric range)
  colorSpace?: string; // TypeColor Space ("RGB" | "HSV")
  unit?: string;      // TypeTime Unit ("Seconds", "Milliseconds", ...): how to read the raw integer
  moduleDefId?: string; // set when merged in from a ModuleDef Static
}
// A parameter. The memory fields (offset/bitOffset/codeSegment) and the `union`
// flag feed the image projection (toAppModel); `moduleDefId` records that this
// entry was merged in from a ModuleDef's Static (so the image projection, which
// mirrors the flat static model, can drop module-def and union entries to stay
// byte-identical to the legacy image parser).
export interface CfgParam {
  id: string; typeId: string; text: string; name?: string; suffix?: string; value?: string; access?: string; hasMemory: boolean;
  // Located in an interface object property (<Property>) instead of memory: also held by the device.
  onProperty?: true;
  offset?: number; bitOffset?: number; codeSegment?: string; union?: boolean; moduleDefId?: string;
  // ETS LegacyPatchAlways: ETS always writes this parameter's value into the image, over the
  // <Data> byte, even at its default. The image build treats it like any other parameter, which
  // does the same.
  // The <Union> a union member belongs to (index in declaration order), and whether it is the
  // member marked DefaultUnionParameter: the one ETS writes when no member of its union is active.
  unionId?: string;
  unionDefault?: boolean;
  patchAlways?: boolean;
  // For a module-def parameter: the Argument id its <Memory> Offset is relative to
  // (Memory@BaseOffset). The effective device offset is `offset + <instance value of
  // that argument>`; the per-instance base is resolved either from the project 0.xml
  // (ModuleInstance args) or, for a from-scratch device, by re-running the allocators.
  baseOffsetArg?: string;
}
// `text`/`suffix` are the ref's own Text/SuffixText, which ETS shows instead of its Parameter's;
// `textParamRefId` feeds the {{0}} / {{0:default}} placeholder in that text.
export interface CfgParamRef { id: string; paramId: string; value?: string; access?: string; displayOrder?: number; moduleDefId?: string; text?: string; suffix?: string; textParamRefId?: string; }
export interface CfgSegment { id: string; lsm: number; size: number; data: Buffer; mask?: Buffer; }
// An absolute-addressed memory segment (Code/AbsoluteSegment). Used by the MV-0705
// parameter model, where parameters live in an EEPROM segment at a FIXED address
// (no allocator), with the default image in <Data>. Kept separate from the
// LSM-keyed CfgSegment so the proven RelativeSegment image path is untouched; the
// MV-0705 image build (deviceimage.ts) consumes these. `address` is the literal
// device address to read/write the segment at. `mask` is the segment's <Mask>, parallel to <Data>:
// a byte the application marks as part of its download image (0xFF) or not (0x00), absent where the
// segment declares none. Only the declared-order System 7 download reads it (deviceflash.ts).
export interface CfgAbsSegment { id: string; address: number; size: number; data: Buffer; mask?: Buffer; }

// Reserved capacity of the device's group-address and association tables, declared in the app
// program as <AddressTable MaxEntries> / <AssociationTable MaxEntries> (siblings of <ComObjectRefs>
// under <Static>). MaxEntries is the number of group addresses / associations the device reserves
// room for. This is what lets us SAFELY grow the tables: writing up to MaxEntries stays inside the
// pre-reserved segment; beyond it would overrun adjacent memory. Absent => capacity unknown.
// `addressSegment`/`associationSegment` are the AbsoluteSegment ids the two tables live in
// (<AddressTable CodeSegment> / <AssociationTable CodeSegment>). A full download needs them to
// know which of the load procedure's declared segments carry the built group tables (vs the
// static application image). Absent => the app does not declare them (older/relative devices).
// `comObjectSegment` is the AbsoluteSegment id the com-object table (L3) lives in
// (<ComObjectTable CodeSegment>). A property-mapped System 7 (MV-0705) full download authors L3 into
// that segment (see comobjbuild.ts buildComObjectTableMv0705); without it the planner would write the
// manufacturer's static default L3, which does not reflect the configured objects' flags.
export interface GroupTableCapacity { addressMaxEntries?: number; associationMaxEntries?: number; addressSegment?: string; associationSegment?: string; comObjectSegment?: string; }
export interface ComObjFlags { read: boolean; write: boolean; comm: boolean; transmit: boolean; update: boolean; readOnInit: boolean; }
// A com-object's telegram priority, which the com-object table (L3) encodes in the low two bits of
// its flags byte. These are the values the ETS product schema uses (ComObjectPriority_t), NOT the
// names a device's firmware gives the underlying KNX priority classes. Absent means Low, which is
// the schema's default and what every ordinary telegram carries.
export type ComObjPriority = "Low" | "High" | "Alert";
export interface CfgComObject {
  id: string; number: number; name: string; text: string; functionText: string;
  objectSize: string; dpt: string; flags: ComObjFlags; priority: ComObjPriority;
  textParamRefId?: string; baseNumber?: string;
}
export interface CfgComObjectRef {
  id: string; refId: string; text?: string; functionText?: string; objectSize?: string;
  dpt?: string; flags: Partial<ComObjFlags>; priority?: ComObjPriority; textParamRefId?: string;
}

// A ParameterBlock's layout. ETS renders a block as a plain list (the default), or as
// a "Grid" / "Table" whose <Rows>/<Columns> children declare the geometry ONLY: they
// carry no items. Every item inside such a block instead names its own place with
// Cell="row,column" (1-based, see DynCell). A Grid's rows/columns are anonymous
// (Name + Width) and the author labels the cells with ParameterSeparators; a Table's
// rows/columns carry the header Text shown left of / above the cells.
export type BlockLayout = "Grid" | "Table";
export interface DynGridLine { id: string; text?: string; width?: string }
export interface DynCell { row: number; col: number }

export type DynNode =
  | { kind: "block"; id: string; name: string; text: string; textParamRefId?: string; paramRefId?: string; access?: string; layout?: BlockLayout; rows?: DynGridLine[]; cols?: DynGridLine[]; children: DynNode[] }
  // `repeatCount` is set only for a <Repeat> (its literal Count): the from-scratch
  // instance resolver replays the children that many times to allocate per-instance.
  | { kind: "container"; id: string; name: string; text: string; textParamRefId?: string; number?: string; repeatCount?: number; children: DynNode[] }
  | { kind: "separator"; id: string; text: string; textParamRefId?: string; uiHint: string; cell?: DynCell }
  | { kind: "unsupported"; tag: string }
  | { kind: "paramRef"; refId: string; indent?: number; cell?: DynCell }
  | { kind: "comObjRef"; refId: string }
  // A <Button> runs an EventHandler declared in the application's <Script> (an ETS
  // dynamic-scripting function, e.g. OpenKNX's "readMeter"). busforge has no ETS
  // script host, so the handler name is carried purely so the UI can name the action
  // it CANNOT run; nothing here ever executes it.
  | { kind: "button"; id: string; text: string; handler: string; cell?: DynCell }
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
// argument values. id/refId are as ETS stores them. Structurally identical to
// @busforge/project's ModuleInstanceData (the parsed form): the same wire contract,
// serialized into the server's device_modules JSON and read back as this type
// (validated at that boundary in db/deviceparams.ts). Product's core stays free of
// 0.xml/knxproj knowledge, so this DTO is redeclared rather than imported from project.
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
  appPeiType: number; // ApplicationProgram PeiType; declared to the device in the task-segment control on a full download
  // ApplicationProgram MaxTunnelingUserEntries: how many tunnelling addresses an IP interface serves.
  // They are device-instance data (the project's AdditionalAddresses), outside the parameter image
  // and the load procedure. NaN when the attribute is present but not a non-negative integer.
  maxTunnelingUserEntries: number;
  // ApplicationProgram AdditionalAddressesCount: how many further individual addresses the device takes
  // (the project's AdditionalAddresses); 0 where absent, NaN where not a non-negative integer.
  additionalAddressesCount: number;
  // <Options ParameterByteOrder>: the byte order of multi-byte parameter values in memory.
  parameterByteOrder: "BigEndian" | "LittleEndian";
  // <Options DownloadInvisibleParameters>: "None" where ETS downloads no parameter the configuration
  // does not show (deviceimage.ts buildRelativeSegmentTarget); undefined where the application does not say.
  downloadInvisibleParameters?: string;
  // <Options TextParameterZeroTerminate="true">: a text parameter's value is stored with a closing zero,
  // so it can take at most one character less than its field.
  textParameterZeroTerminate: boolean;
  defaultLanguage: string;
  languages: string[];
  types: Map<string, CfgType>;
  params: Map<string, CfgParam>;
  refs: Map<string, CfgParamRef>;
  comObjects: Map<string, CfgComObject>;
  comObjectRefs: Map<string, CfgComObjectRef>;
  segments: CfgSegment[]; // memory segments (Code/RelativeSegment), for the image projection
  absoluteSegments: CfgAbsSegment[]; // Code/AbsoluteSegment (MV-0705 parameter model)
  groupTables: GroupTableCapacity; // declared <AddressTable>/<AssociationTable> reserved sizes
  // The application's declared <LoadProcedures>: what a download of it must execute, so what the
  // profile can offer (capabilities()) follows from it.
  loadProcedures: LoadProcedures;
  translations: Translations;
  dynamic: DynNode[];
  moduleDefs: Map<string, ModuleDefModel>;
  allocators: Map<string, Allocator>; // Static/Allocators, for from-scratch instance resolution
  hasModules: boolean;
  dca?: DcaInfo;
  // Leading whitespace from a Parameter or ParameterRef Text used as a faux-indent (nesting a
  // sub-parameter under the one above), keyed by Parameter or ParameterRef Id. The XML parser trims attribute values, so
  // this is captured from the raw source and reattached to the label. See parseParamFauxIndent.
  paramFauxIndent: Map<string, string>;
  // The ParameterRefs a <ParameterCalculation> reads or sets (its LParameters and RParameters), in the
  // application and its module definitions. Busforge does not run these scripts.
  calculationRefs: Set<string>;
}

// The order-preserving parser splits attributes (under ":@") from child elements,
// unlike the merged parser. ETS authors most fields as attributes but large payloads
// (a segment's base64 Data, long texts) as child-element text. Read either form
// uniformly, so a field authored as an element instead of an attribute still resolves
// (this is what the legacy merged parser did implicitly).
// Only text nodes contribute. An element child has no "#text" and is not text; joining it would
// have produced "[object Object]" inside the very string a segment's base64 Data is read from.
const concatText = (n: ONode): string =>
  kidsOf(n).map((k) => k["#text"]).filter((t): t is string | number => typeof t === "string" || typeof t === "number").join("");
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

// ETS app authors use leading whitespace in a Parameter's (or ParameterRef's) Text as a faux-indent to nest a
// sub-parameter visually under the one above (a workaround for ETS's layout limits, e.g.
// "    Send cyclically every" under "Cyclic sending"). The XML parser trims attribute values,
// so we recover that leading whitespace from the raw source here and reattach it to the label
// later, rendering the author's deliberate nesting faithfully. Intentional, not noise.
function parseParamFauxIndent(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<Parameter(?:Ref)?\b([^>]*?)\/?>/g;
  for (let m; (m = re.exec(xml)); ) {
    const attrs = m[1];
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1];
    const lead = /\bText="([ \t]+)/.exec(attrs)?.[1]; // leading spaces/tabs of the Text attribute only
    if (id && lead) out.set(id, lead);
  }
  return out;
}

export function parseAppConfig(xml: string): AppConfig {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", attributesGroupName: ":@", preserveOrder: true });
  const root = p.parse(xml) as ONode[];
  const app = deepFirst(root, "ApplicationProgram");
  if (!app) throw new ProductError("APP_PROGRAM_MISSING", "no ApplicationProgram in the parsed file");
  const appAttrs = attrsOf(app);
  const appKids = kidsOf(app);
  const staticNode = firstByTag(appKids, "Static");
  const staticKids = staticNode ? kidsOf(staticNode) : [];

  const types = parseTypes(staticKids);
  const { params } = parseParams(staticKids, "static");
  const refs = parseRefs(staticKids);
  const comObjects = parseComObjects(staticKids);
  const comObjectRefs = parseComObjectRefs(staticKids);
  const segments = parseSegments(staticKids);
  const absoluteSegments = parseAbsoluteSegments(staticKids);
  const allocators = parseAllocators(staticKids);
  const groupTables = parseGroupTables(staticKids);

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
    merge(params, tagMod(parseParams(mdStaticKids, mdId).params, mdId));
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
  const optionsNode = firstByTag(staticNode ? kidsOf(staticNode) : [], "Options") ?? firstByTag(appKids, "Options");
  const byteOrder = optionsNode ? attrsOf(optionsNode).ParameterByteOrder : undefined;
  if (byteOrder !== undefined && byteOrder !== "BigEndian" && byteOrder !== "LittleEndian") {
    throw new ProductError("PARAM_BYTE_ORDER_UNSUPPORTED", `the application declares ParameterByteOrder "${byteOrder}", which Busforge cannot encode`);
  }
  const parameterByteOrder = byteOrder ?? "BigEndian";
  const desc = appAttrs.VisibleDescription ?? "";
  const dca = /\bDCA\b/i.test(appAttrs.Name ?? "") || /\bDCA\b/i.test(desc) ? { hint: desc.trim() } : undefined;

  return {
    id: appAttrs.Id,
    mask: appAttrs.MaskVersion ?? "",
    appVersion: Number(appAttrs.ApplicationVersion ?? 0),
    appNumber: Number(appAttrs.ApplicationNumber ?? 0),
    appPeiType: Number(appAttrs.PeiType ?? 0),
    maxTunnelingUserEntries: appAttrs.MaxTunnelingUserEntries === undefined ? 0
      : /^\d+$/.test(appAttrs.MaxTunnelingUserEntries) ? Number(appAttrs.MaxTunnelingUserEntries) : NaN,
    additionalAddressesCount: appAttrs.AdditionalAddressesCount === undefined ? 0
      : /^\d+$/.test(appAttrs.AdditionalAddressesCount) ? Number(appAttrs.AdditionalAddressesCount) : NaN,
    parameterByteOrder,
    textParameterZeroTerminate: optionsNode ? attrsOf(optionsNode).TextParameterZeroTerminate === "true" : false,
    ...(optionsNode && attrsOf(optionsNode).DownloadInvisibleParameters !== undefined ? { downloadInvisibleParameters: attrsOf(optionsNode).DownloadInvisibleParameters } : {}),
    defaultLanguage: appAttrs.DefaultLanguage ?? "en-US",
    languages,
    loadProcedures: loadProceduresOf(root),
    types, params, refs, comObjects, comObjectRefs, segments, absoluteSegments, groupTables, translations, dynamic, moduleDefs, allocators, hasModules, dca,
    paramFauxIndent: parseParamFauxIndent(xml),
    calculationRefs: calculationRefsOf(appKids),
  };
}

function calculationRefsOf(nodes: ONode[]): Set<string> {
  const out = new Set<string>();
  const refsIn = (ns: ONode[]) => { for (const n of ns) { if (tagOf(n) === "ParameterRefRef" && attrsOf(n).RefId) out.add(attrsOf(n).RefId); refsIn(kidsOf(n)); } };
  const find = (ns: ONode[]) => { for (const n of ns) { if (tagOf(n) === "ParameterCalculation") refsIn(kidsOf(n)); else find(kidsOf(n)); } };
  find(nodes);
  return out;
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
        return { value: Number(ea.Value), text: ea.Text ?? "", id: ea.Id, displayOrder: ea.DisplayOrder !== undefined ? Number(ea.DisplayOrder) : i,
          ...(ea.BinaryValue !== undefined ? { binary: Buffer.from(String(ea.BinaryValue), "base64") } : {}) };
      }).sort((a, b) => a.displayOrder - b.displayOrder);
    } else if (tag === "TypeNumber") base = "Number";
    else if (tag === "TypeFloat") base = "Float";
    else if (tag === "TypeText") base = "Text";
    else if (tag === "TypeColor") base = "Color";
    // TypeTime is a raw unsigned integer (a count of Unit, e.g. Seconds); the image
    // codec already encodes it as Number (see imageBase). TypeIPAddress is a 4-byte
    // host address stored as a dotted-quad string; ETS omits SizeInBit, so pin it to 32.
    else if (tag === "TypeTime") base = "Time";
    else if (tag === "TypeIPAddress") base = "IPAddress";
    // KNX TypeNumber@Type is "signedInt" / "unsignedInt". Test for signedness
    // exactly: a naive includes("signed") also matches "unsignedInt", which would
    // mis-decode every unsigned value >= 128 as negative on read-back.
    const typeAttr = String(ia.Type ?? "").toLowerCase();
    // A TypeFloat carries no SizeInBit; its width lives in the Encoding: "IEEE-754 Single"
    // is a 4-byte IEEE float (DPT-14), "DPT 9" the 2-byte KNX float. Defaulting every
    // encoding to 16 silently mis-encoded IEEE-754 params as DPT-9 (hardware-observed on the
    // OpenKNX RaumController: Latitude 50.115 was written as a garbage half-float instead of
    // 0x42487625). The codec keys IEEE vs DPT-9 off sizeInBit (32 vs 16), so the width must be
    // right here. An explicit SizeInBit, if ever present, still wins.
    const floatWidth = String(ia.Encoding ?? "").includes("IEEE-754 Single") ? 32 : 16;
    out.set(id, {
      id, base, kind: tag,
      // IP host address is 4 bytes; ETS leaves SizeInBit unset, so pin it to 32.
      sizeInBit: base === "IPAddress" ? 32 : Number(ia.SizeInBit ?? (base === "Float" ? floatWidth : 0)),
      signed: typeAttr.includes("signed") && !typeAttr.includes("unsigned"),
      enums,
      min: num(ia.minInclusive),
      max: num(ia.maxInclusive),
      increment: num(ia.Increment),
      uiHint: ia.UIHint,
      colorSpace: ia.Space,
      unit: ia.Unit,
    });
  }
  return out;
}

// `unionScope` makes union ids unique across the static part and every module definition.
function parseParams(staticKids: ONode[], unionScope: string): { params: Map<string, CfgParam> } {
  const params = new Map<string, CfgParam>();
  const container = firstByTag(staticKids, "Parameters");
  // `unionMem` is the <Union>'s shared <Memory> attributes (present only for union
  // children). A normal parameter carries its own <Memory> child; a union parameter's
  // memory is the union's, and the parameter's own Offset/BitOffset ATTRIBUTES are
  // relative to that shared base (union branches overlap; only the visible one is
  // written). The union flag stays so the proven RelativeSegment image projection can
  // keep excluding them by default (toAppModel), byte-identical to the legacy parser.
  const add = (pa: ONode, union: boolean, unionMem?: Record<string, string>, unionId?: string) => {
    const a = attrsOf(pa);
    const mem = firstByTag(kidsOf(pa), "Memory");
    const ma = mem ? attrsOf(mem) : undefined;
    params.set(a.Id, {
      ...(firstByTag(kidsOf(pa), "Property") ? { onProperty: true as const } : {}),
      id: a.Id, typeId: a.ParameterType, text: a.Text ?? "", ...(a.Name ? { name: a.Name } : {}), suffix: a.SuffixText, value: a.Value, access: a.Access,
      hasMemory: unionMem ? unionMem.CodeSegment !== undefined : !!mem,
      offset: unionMem ? Number(unionMem.Offset) + Number(a.Offset ?? 0) : ma ? Number(ma.Offset) : undefined,
      bitOffset: unionMem ? Number(unionMem.BitOffset ?? 0) + Number(a.BitOffset ?? 0) : ma ? Number(ma.BitOffset ?? 0) : undefined,
      codeSegment: unionMem ? unionMem.CodeSegment : ma?.CodeSegment,
      // A union member's per-instance BaseOffset lives on the UNION's shared <Memory>,
      // not on the member (which has no own <Memory>). Reading it from `ma` would drop it,
      // placing every module union parameter at its static offset without the instance
      // base, colliding with another channel's memory. Take the union's BaseOffset, exactly
      // as offset/bitOffset/codeSegment above already do.
      baseOffsetArg: unionMem ? unionMem.BaseOffset : ma?.BaseOffset,
      patchAlways: a.LegacyPatchAlways === "true" || undefined,
      union: union || undefined,
      unionId,
      unionDefault: a.DefaultUnionParameter === "true" || undefined,
    });
  };
  for (const pa of container ? childrenByTag(kidsOf(container), "Parameter") : []) add(pa, false);
  // Union children are parameters too (overlapping memory), placed at the union's
  // shared <Memory>. Included for the UI and (opt-in) the MV-0705 image build.
  let unionCount = 0;
  for (const u of container ? childrenByTag(kidsOf(container), "Union") : []) {
    const umem = firstByTag(kidsOf(u), "Memory");
    const uma = umem ? attrsOf(umem) : undefined;
    const unionId = `${unionScope}:${unionCount++}`;
    for (const pa of childrenByTag(kidsOf(u), "Parameter")) add(pa, true, uma, unionId);
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
    const mask = attrOrText(s, "Mask");
    out.push({ id: a.Id, lsm: Number(a.LoadStateMachine), size: Number(a.Size), data: Buffer.from(attrOrText(s, "Data") ?? "", "base64"), ...(mask !== undefined ? { mask: Buffer.from(mask, "base64") } : {}) });
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
    const mask = attrOrText(s, "Mask");
    out.push({ id: a.Id, address: Number(a.Address), size: Number(a.Size), data: Buffer.from(attrOrText(s, "Data") ?? "", "base64"), ...(mask !== undefined ? { mask: Buffer.from(mask, "base64") } : {}) });
  }
  return out;
}

// <AddressTable>/<AssociationTable> are direct children of <Static>; MaxEntries is the device's
// reserved group-address / association capacity. Used by the flash path to allow growing the
// tables up to capacity (and to refuse beyond it instead of overrunning device memory).
function parseGroupTables(staticKids: ONode[]): GroupTableCapacity {
  const num = (tag: string) => { const n = firstByTag(staticKids, tag); const v = n ? attrsOf(n).MaxEntries : undefined; return v !== undefined ? Number(v) : undefined; };
  const seg = (tag: string) => { const n = firstByTag(staticKids, tag); const v = n ? attrsOf(n).CodeSegment : undefined; return v !== undefined ? String(v) : undefined; };
  return { addressMaxEntries: num("AddressTable"), associationMaxEntries: num("AssociationTable"), addressSegment: seg("AddressTable"), associationSegment: seg("AssociationTable"), comObjectSegment: seg("ComObjectTable") };
}

function parseRefs(staticKids: ONode[]): Map<string, CfgParamRef> {
  const refs = new Map<string, CfgParamRef>();
  const container = firstByTag(staticKids, "ParameterRefs");
  for (const r of container ? childrenByTag(kidsOf(container), "ParameterRef") : []) {
    const a = attrsOf(r);
    refs.set(a.Id, { id: a.Id, paramId: a.RefId, value: a.Value, access: a.Access, displayOrder: a.DisplayOrder !== undefined ? Number(a.DisplayOrder) : undefined, text: a.Text, suffix: a.SuffixText, textParamRefId: a.TextParameterRefId });
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
      priority: priorityOf(a.Priority),
      textParamRefId: a.TextParameterRefId,
      baseNumber: a.BaseNumber,
    });
  }
  return out;
}

// Absent means Low: the schema's default, and what every ordinary telegram carries. Any OTHER
// value is refused rather than quietly turned into Low: a priority is written straight into the
// device's com-object table, and silently demoting an alarm object to the lowest priority class is
// precisely the kind of wrong byte nothing downstream would ever catch.
const priorityOf = (v: string | undefined): ComObjPriority => {
  if (v === undefined || v === "") return "Low";
  if (v === "Low" || v === "High" || v === "Alert") return v;
  throw new ProductError("COM_OBJECT_PRIORITY_UNKNOWN",
    `a communication object declares the priority "${v}", which is not one of the values the ETS schema defines (Low, High, Alert); refusing to guess what to write into the device's com-object table`);
};

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
      objectSize: a.ObjectSize, dpt: a.DatapointType, flags,
      priority: a.Priority ? priorityOf(a.Priority) : undefined, // absent = inherit from the ComObject
      textParamRefId: a.TextParameterRefId,
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

// ETS places a laid-out item with Cell="row,column", 1-based. An absent or unreadable
// Cell (including a 0 index, which is not a cell) leaves the item unplaced, and the
// renderer then shows it after the grid instead of dropping it.
function parseCell(v: string | undefined): DynCell | undefined {
  const m = v ? /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(v) : null;
  if (!m) return undefined;
  const row = Number(m[1]);
  const col = Number(m[2]);
  return row >= 1 && col >= 1 ? { row, col } : undefined;
}

// The <Rows>/<Columns> geometry of a Grid/Table ParameterBlock: pure geometry, holding
// no items (every laid-out item names its own Cell instead). Returns null when a
// container is NOT that pure geometry (a Row/Column with children of its own, or a
// foreign child): the block then refuses to consume it, so it stays in the children and
// is surfaced as an unsupported element rather than being silently thrown away.
function parseGridLines(kids: ONode[], container: string, line: string): DynGridLine[] | undefined | null {
  const c = firstByTag(kids, container);
  if (!c) return undefined;
  const elems = kidsOf(c).filter((k) => !tagOf(k).startsWith("#"));
  if (elems.some((k) => tagOf(k) !== line || kidsOf(k).some((g) => !tagOf(g).startsWith("#")))) return null;
  return elems.map((l) => {
    const la = attrsOf(l);
    return { id: la.Id ?? "", text: la.Text, width: la.Width };
  });
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
    case "ParameterBlock": {
      const kids = kidsOf(n);
      // Layout="Grid"/"Table" turns the block into a cell grid. Any other value is a
      // layout we do not know (ETS also has "List", which IS the plain list a
      // layout-less block already is), so the block stays a list AND keeps any
      // <Rows>/<Columns> in its children, where they surface as unsupported: a layout
      // we cannot read must not silently swallow its own geometry.
      const declared: BlockLayout | undefined = a.Layout === "Grid" || a.Layout === "Table" ? a.Layout : undefined;
      const rows = declared ? parseGridLines(kids, "Rows", "Row") : null;
      const cols = declared ? parseGridLines(kids, "Columns", "Column") : null;
      // Consume the geometry only when ALL of it was understood (see parseGridLines).
      const grid = declared !== undefined && rows !== null && cols !== null;
      const children = kids
        .filter((k) => !(grid && (tagOf(k) === "Rows" || tagOf(k) === "Columns")))
        .map(parseDyn).filter(Boolean) as DynNode[];
      return {
        kind: "block", id: a.Id ?? "", name: a.Name ?? "", text: a.Text ?? "", textParamRefId: a.TextParameterRefId,
        paramRefId: a.ParamRefId, access: a.Access,
        layout: grid ? declared : undefined,
        rows: grid ? rows ?? undefined : undefined, // `grid` already excludes null
        cols: grid ? cols ?? undefined : undefined,
        children,
      };
    }
    case "ParameterSeparator":
      return { kind: "separator", id: a.Id ?? "", text: a.Text ?? "", textParamRefId: a.TextParameterRefId, uiHint: a.UIHint ?? "", cell: parseCell(a.Cell) };
    case "ParameterRefRef":
      return { kind: "paramRef", refId: a.RefId, indent: a.IndentLevel !== undefined ? Number(a.IndentLevel) : undefined, cell: parseCell(a.Cell) };
    case "ComObjectRefRef":
      return { kind: "comObjRef", refId: a.RefId };
    // A scripted action (EventHandler in the app's <Script>). Parsed so the UI can show
    // the real, named element instead of an "unsupported" marker; it stays inert.
    case "Button":
      return { kind: "button", id: a.Id ?? "", text: a.Text ?? "", handler: a.EventHandler ?? "", cell: parseCell(a.Cell) };
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
