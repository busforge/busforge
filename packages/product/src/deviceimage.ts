import type { AppConfig, CfgParamRef, DynNode, ModuleInstance } from "./appconfig.ts";
import { toAppModel } from "./application.ts";
import { buildDeviceConfig, decodeTextEntities } from "./config.ts";
import { resolveModuleInstances } from "./modules.ts";
import { byteWidth, MAX_INT_BYTES, encode } from "./image.ts";
import { ProductError } from "./errors.ts";

// `textRefusals: "skip"`: a text parameter the codec refuses is left unowned instead of failing the
// build. Only for the read-back, which compares what it can and does not write; every path that
// writes keeps the refusal.
type TextRefusals = "refuse" | "skip";
const isTextRefusal = (e: unknown): boolean => e instanceof ProductError && e.code.startsWith("PARAM_TEXT_");

// Build the parameter memory image for the MV-0705 (absolute-segment) device model.
//
// Unlike the RelativeSegment path (buildParameterImage), these devices store
// parameters in one or more AbsoluteSegments at fixed addresses, and the correct
// image is the manufacturer <Data> default overlaid with ONLY the VISIBLE/ACTIVE
// parameters' effective values. Parameters hidden by the app's dynamic structure
// (choose/when) keep the <Data> byte; writing their defaults would corrupt it.
//
// The visible set and each parameter's effective value come from buildDeviceConfig
// (the same resolver the UI uses); the byte placement reuses the proven encode
// codec. This is hardware byte-verified on the M-0081 devices (see
// docs/device-memory-model.md). Union members and module-instance parameters ARE
// placed: per-instance offsets are resolved and a union byte is owned only for the
// actively-placed branch. Both are hardware byte-verified (docs/device-memory-model.md).

// Mark a parameter's bits as under flash authority. `owned` and `verify` hold one bit mask per
// byte (0x80 is KNX bit offset 0), because a sub-byte parameter shares its byte with others: the
// flash may change only its own bits and must carry the rest over from the device (a GVS AMMA
// parameter flash that wrote the <Data> template's bits beside a 2-bit parameter set idle union
// bits the firmware then read as a configured channel). `verify` additionally records the
// user-facing subset (Access="None" device-internal markers are written but excluded from the
// post-flash comparison; the device re-stamps them on download).
function markOwned(owned: number[], verify: number[], offset: number, bitOffset: number, sizeInBit: number, size: number, verifiable: boolean): void {
  for (let g = bitOffset; g < bitOffset + sizeInBit; g++) {
    const at = offset + (g >> 3);
    if (at >= size) break;
    const m = 0x80 >> (g & 7);
    owned[at] |= m;
    if (verifiable) verify[at] |= m;
  }
}

// The Access="None" parameters whose value no configuration of the application changes, by their
// Parameter id with that value: every ParameterRef carries the same value, no <Assign> targets one,
// no <ParameterCalculation> reads or sets one, and one of them is placed outside every choose and
// module, so the parameter is active whatever the configuration. A dynamic tree holding an element
// Busforge does not parse (an `unsupported` node, which may hide an <Assign>) or a <Button>, whose
// script may set parameters, has none. Their bits in an image are therefore the same for every project of the
// application, and a unit that holds other bits there holds them by its own doing: the download
// markers ETS writes in every download and the unit clears once it has seen one (Theben TheLuxa P300
// and Meteodata 140 S P-2228 $AA, Theben MIX 2 P-199, Jung 400021SE P-1). A difference in such bits
// alone is no change of the configuration (ETS compares against its record of what it wrote, which
// holds the value); with any other change they are written, as ETS writes them in every download.
const constantCache = new WeakMap<AppConfig, Map<string, string>>();
export function constantParams(app: AppConfig): Map<string, string> {
  const hit = constantCache.get(app);
  if (hit) return hit;
  const assigned = new Set<string>();
  const placed = new Set<string>();
  let opaque = false;
  const walk = (nodes: DynNode[], unconditional: boolean) => {
    for (const n of nodes) {
      if (n.kind === "unsupported" || n.kind === "button") opaque = true;
      else if (n.kind === "assign") assigned.add(n.target);
      else if (n.kind === "paramRef" && unconditional) placed.add(n.refId);
      else if (n.kind === "block" || n.kind === "container") walk(n.children, unconditional);
      else if (n.kind === "choose") for (const w of n.whens) walk(w.children, false);
    }
  };
  walk(app.dynamic, true);
  for (const d of app.moduleDefs.values()) walk(d.dynamic, false);
  const refsOf = new Map<string, CfgParamRef[]>();
  for (const r of app.refs.values()) refsOf.set(r.paramId, [...(refsOf.get(r.paramId) ?? []), r]);
  const out = new Map<string, string>();
  for (const p of opaque ? [] : app.params.values()) {
    if (p.access !== "None" || !p.hasMemory || p.onProperty || p.union || p.moduleDefId) continue;
    const refs = refsOf.get(p.id) ?? [];
    const values = new Set(refs.map((r) => r.value ?? p.value));
    if (values.size !== 1 || refs.some((r) => assigned.has(r.id) || app.calculationRefs.has(r.id) || (r.access !== undefined && r.access !== "None"))) continue;
    if (!refs.some((r) => placed.has(r.id))) continue;
    const [value] = values;
    if (value !== undefined) out.set(p.id, value);
  }
  constantCache.set(app, out);
  return out;
}

// The constant parameters (constantParams) of one segment that hold their bits alone: no other
// parameter placed there (a union member, a module instance's parameter) shares one of them. A colour
// in the RGB or HSV space holds three bytes (colorBits); a segment that holds a parameter of any other
// unknown width has none, since that parameter's bits cannot be told.
function constantsAlone(app: AppConfig, params: { typeId: string; offset?: number; bitOffset?: number; id: string }[], types: Map<string, { sizeInBit: number }>, size: number): Set<string> {
  const constants = constantParams(app);
  const users = new Array<number>(size * 8).fill(0);
  const span = (p: (typeof params)[number]) => {
    if (p.offset === undefined) return null;
    const declared = types.get(p.typeId)?.sizeInBit;
    const width = declared && Number.isFinite(declared) ? declared : colorBits(app, p.typeId);
    if (!width) return "unknown" as const;
    const from = p.offset * 8 + (p.bitOffset ?? 0);
    return { from, to: Math.min(from + width, size * 8) };
  };
  const all = params.map(span);
  if (all.includes("unknown")) return new Set();
  const spans = all.filter((s) => s !== "unknown");
  for (const s of spans) if (s) for (let b = s.from; b < s.to; b++) users[b]++;
  const out = new Set<string>();
  for (const [k, p] of params.entries()) {
    const s = constants.has(p.id) ? spans[k] : null;
    if (!s || s.to <= s.from) continue;
    let alone = true;
    for (let b = s.from; b < s.to; b++) if (users[b] !== 1) alone = false;
    if (alone) out.add(p.id);
  }
  return out;
}

// A byte built from `want` where `mask` owns bits and from `have` everywhere else.
export function mergeOwnedBits(have: number, want: number, mask: number): number {
  return (have & ~mask) | (want & mask);
}

export interface DeviceSegmentImage { id: string; address: number; size: number; bytes: Buffer; }

// Like DeviceSegmentImage, but also reports which bytes the image OWNS, i.e. bytes
// whose value was positively derived from an active (visible/resolved) parameter.
// The remaining bytes are modelled (manufacturer <Data> default, the zero-init of a
// Data-less segment's parameter regions, or erased-EEPROM gaps) so the whole image
// can be COMPARED against a device read-back, but the model is not authoritative for
// them: a Data-less segment cannot reconstruct ETS's precomputed non-zero defaults
// (see the M-008E 4-byte residual in docs/device-memory-model.md). The flash path
// must only WRITE owned bytes; see planAbsoluteSegmentFlash.
//
// `verify` is the subset of owned bytes a post-flash read-back may assert. It EXCLUDES
// bytes owned only by Access="None" device-internal parameters (download-recognition
// markers / counters the device computes for itself on download, e.g. M-008E's P-223 at
// AS-4B00[0:2], default 0xFFFF; the MV-0701 P-2228 "Downloaderkennung" is the same class).
// We still WRITE those bytes (they are part of the correct image), but the device overwrites
// them on download, so checking them in verify would report every successful flash as failed.
// User-facing parameters (Access != None) stay in `verify`, so a real mis-write still fails.
// `constant` is the subset of owned bits that hold a constant parameter's value (constantParams): a
// unit differing from the image only there holds the configuration. `constants` names whose they are.
export interface DeviceSegmentTarget extends DeviceSegmentImage { owned: number[]; verify: number[]; constant: number[]; constants: ConstantPlacement[]; }

// A constant parameter placed in a segment: its ParameterRef and the bits it holds there.
export interface ConstantPlacement { paramRefId: string; paramId: string; offset: number; bitOffset: number; sizeInBit: number }
// A constant parameter the unit holds other bits in than the configuration writes: a download marker
// the unit cleared, or a value another tool or application left. Reported by an `unchanged` flash, so
// the difference is seen although it is no change. `label`: the text of its ParameterRef, else of its
// Parameter, in the application's default language (entities decoded, on one line), else its name, else
// its id.
export interface ConstantDifference { paramRefId: string; label: string }

// The constants of `placements` whose bits differ between the unit (`current`) and the image, each
// parameter once.
export function differingConstants(app: AppConfig, placements: ConstantPlacement[], current: Buffer, image: Buffer): ConstantDifference[] {
  const seen = new Set<string>();
  return placements.filter((c) => {
    if (seen.has(c.paramId)) return false;
    for (let g = c.bitOffset; g < c.bitOffset + c.sizeInBit; g++) {
      const at = c.offset + (g >> 3), m = 0x80 >> (g & 7);
      if (((current[at] ^ image[at]) & m) !== 0) { seen.add(c.paramId); return true; }
    }
    return false;
  }).map((c) => {
    const p = app.params.get(c.paramId);
    const text = decodeTextEntities(app.refs.get(c.paramRefId)?.text || p?.text || "").replace(/\s+/g, " ").trim();
    return { paramRefId: c.paramRefId, label: text || p?.name || c.paramId };
  });
}

export function buildAbsoluteSegmentImages(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; textRefusals?: TextRefusals } = {},
): DeviceSegmentImage[] {
  return buildAbsoluteSegmentTargets(app, values, opts).map(({ id, address, size, bytes }) => ({ id, address, size, bytes }));
}

// The module instances an absolute build places parameters for: the project's set when given, else the
// allocators' for a from-scratch device.
export const absoluteBuildInstances = (app: AppConfig, values: Map<string, string>, moduleInstances?: ModuleInstance[]): ModuleInstance[] =>
  moduleInstances?.length ? moduleInstances : (app.hasModules ? resolveModuleInstances(app, values) : []);

export function buildAbsoluteSegmentTargets(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; textRefusals?: TextRefusals } = {},
): DeviceSegmentTarget[] {
  // Module instances: the imported project's set when given, else re-run the allocators
  // for a from-scratch device so its channel parameters are placed at the same offsets
  // ETS would compute. Threaded into BOTH the image model (to materialise the per-instance
  // params) and the config view (to resolve which of them are active).
  const instances = absoluteBuildInstances(app, values, opts.moduleInstances);
  const model = toAppModel(app, { includeUnions: true, instances });
  // Effective value of every parameter reached in the active dynamic tree, keyed by
  // ParameterRef id. This includes Access="None" internal parameters that ETS writes
  // to memory but hides from the UI, so it is the right source for the image (the
  // visible blocks alone would miss them).
  const view = buildDeviceConfig(app, values, opts.lang, instances);
  const active = view.imageValues;

  // Which absolute segments do <Memory> parameters target?
  const bySeg = new Map(app.absoluteSegments.map((s) => [s.id, s]));
  const targeted = new Set<string>();
  for (const p of model.params.values()) if (p.codeSegment && bySeg.has(p.codeSegment)) targeted.add(p.codeSegment);

  const out: DeviceSegmentTarget[] = [];
  for (const segId of targeted) {
    const seg = bySeg.get(segId)!;
    // Initialise to the EEPROM blank state (0xFF). A segment that ships a <Data>
    // default image lays that over the blank (it usually covers the whole segment).
    // A segment WITHOUT <Data> (e.g. Steinel M-008E) has no precomputed default
    // image; there ETS clears the parameter memory before downloading, so every
    // PARAMETER-owned byte starts at 0 (a disabled feature's params read back as 0)
    // while the gaps between parameters stay at the erased 0xFF. We then overlay the
    // active parameter values. Hardware-verified on M-008E: a 1024-byte Data-less
    // segment went from 339 byte diffs to 4 with this model.
    const img = Buffer.alloc(seg.size, 0xff);
    if (seg.data.length) {
      seg.data.copy(img); // manufacturer default image (covers [0, data.length))
    } else {
      for (const p of model.params.values()) {
        if (p.codeSegment !== seg.id || p.offset === undefined) continue;
        const t = model.types.get(p.typeId);
        const bytes = t ? byteWidth(t.sizeInBit, p.bitOffset) : 1;
        for (let b = 0; b < bytes && p.offset + b < seg.size; b++) img[p.offset + b] = 0;
      }
    }
    const owned = new Array<number>(seg.size).fill(0);
    const verify = new Array<number>(seg.size).fill(0);
    const constant = new Array<number>(seg.size).fill(0);
    const placements: ConstantPlacement[] = [];
    const constants = constantsAlone(app, [...model.params.values()].filter((p) => p.codeSegment === segId), model.types, seg.size);
    for (const ref of model.refs.values()) {
      const param = model.params.get(ref.paramId);
      if (!param || param.codeSegment !== segId || param.offset === undefined) continue;
      const v = active.get(ref.id);
      if (v === undefined) continue; // not visible / not active: keep the <Data> default
      const type = model.types.get(param.typeId);
      if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
      // An active text parameter on these (System 7) segments: no ETS capture of a System 7 product
      // shows one (the Meteodata 140 S's are inactive in every captured configuration), so its byte
      // layout here is not known.
      if (type.base === "Text") {
        if (opts.textRefusals === "skip") continue;
        throw new ProductError("PARAM_TEXT_UNSUPPORTED", `text parameter ${param.id} at offset ${param.offset} of ${segId}: no ETS capture shows a text parameter on this memory model`);
      }
      // Only mark bytes owned if encode ACTUALLY wrote them. A time/color/other
      // type (or a malformed value) writes nothing, so it must not claim authority over
      // its bytes: the flash path would otherwise push the segment's init/default value
      // over device memory the parameter never derived. Gating on the real write keeps
      // ownership exactly symmetric with the image, with no duplicated type gate.
      const wrote = encode(img, param.offset, param.bitOffset, type, v);
      if (!wrote) continue;
      // This parameter's value is authoritative: mark its byte(s) owned so the flash
      // path may write them. A sub-byte parameter owns the single byte it shares.
      // Access="None" params are device-internal (download markers/counters the device
      // re-stamps); they stay owned/written but are excluded from `verify` (see the type).
      const verifiable = app.params.get(ref.paramId)?.access !== "None";
      markOwned(owned, verify, param.offset, param.bitOffset, type.sizeInBit, seg.size, verifiable);
      if (constants.has(param.id) && constantParams(app).get(param.id) === v) {
        markOwned(constant, [], param.offset, param.bitOffset, type.sizeInBit, seg.size, false);
        placements.push({ paramRefId: ref.id, paramId: param.id, offset: param.offset, bitOffset: param.bitOffset ?? 0, sizeInBit: type.sizeInBit });
      }
    }
    out.push({ id: segId, address: seg.address, size: seg.size, bytes: img, owned, verify, constant, constants: placements });
  }
  return out.sort((a, b) => a.address - b.address);
}

// The RelativeSegment (System B) parameter image as a SURGICAL target: the bytes plus
// an `owned` mask of which bytes we may write. Unlike buildParameterImage (which writes
// every memory-backed ref over the <Data> default and is used unchanged for the proven
// full-image semantics), this gates ownership so the flash path can preserve bytes ETS
// computes that we cannot reproduce.
//
// Ownership rule, hardware-derived (see docs/device-memory-model.md):
//  - A plain top-level memory parameter: OWNED, value = effective default (device
//    instance value, else parameter default). System B writes every such default and
//    the device holds it (PSU M-0162 read-back: full-image byte-match only with the
//    default fallback; gating it off regressed 51 bytes). So these are authoritative.
//  - A <Union> member or a module-instance (…_MI-…) parameter: OWNED only when ACTIVE
//    (present in the visibility-resolved image set). Union members overlap one region,
//    so only the selected branch may be written; an inactive branch must keep the
//    device byte. The Theben MIX 2 "Objektlink" unions are Access="None" BinaryValue
//    members, one per module type, chosen in a hidden parameter block by the slot's
//    module type: the active one is owned and writes its enumeration's bytes, as ETS's
//    image holds them (ETS captures of all three MIX 2 products).
//  - LegacyPatchAlways params: owned like any other. ETS writes their value over the <Data> byte
//    (MDT BE-02001.02 captures; Theben MIX devices programmed by ETS hold the values, not <Data>).
//  - A plain top-level param that is INACTIVE and whose memory falls inside an active
//    module instance's region: NOT owned. That byte belongs to the channel the module
//    placed there; the top-level param is the displaced channel variant (e.g. the relay
//    "Sammelrueckmeldung" params overlapping a channel configured as a JME blind module).
//    ETS writes the module's value, not the inactive variant's default; owning it would
//    push that default into the channel memory. Hardware-mapped on HMG 6T (offsets 617,
//    1129 are the inactive "Zeit fuer zykl. Senden" param sitting in MD-12/MD-6 regions).
// Ownership is gated on encode() ACTUALLY writing, exactly like the absolute path, so a
// time/colour/malformed value claims no bytes.
// `verify` mirrors DeviceSegmentTarget.verify: owned bytes minus Access="None" device-internal
// markers, so a post-flash read-back asserts only user-facing bytes.
// An application that declares <Options DownloadInvisibleParameters="None">: ETS leaves out a parameter that
// no active branch places when every one of its placements lies in a branch of a choose ETS evaluated and
// did not take: its bytes keep the allocation fill in a full download and are not in the image of a
// parameter download. A parameter gated only by a choose on an unset Merker it writes at its default.
// Theben MIX 2 (a JMG 4 T with its second extension slot empty: offset 1129, P-63, left at 00 in the full
// download; offset 1201, P-36, absent from its parameter download; private corpus
// captures/mix2-jmg4t-ets6log-fulldownload.txt and -partial-params.txt) and Jung 400021SE (also "None",
// whose captures it leaves byte-identical). Where the application does not declare it (GVS AMMA, MEAN WELL
// PSU), ETS writes such parameters' defaults (gvs-amma-ets-*.log; the PSU's read-back).
const leavesOutInvisible = (app: AppConfig): boolean => app.downloadInvisibleParameters === "None";

// `markers`: the bits of active Access="None" LegacyPatchAlways parameters, download markers ETS writes
// set every time and the device clears (the Theben MIX 2's P-199 "A_Download erfolgt", bit 0x80 of
// offset 39). Written, never asserted.
// `constant`, `constants`: the owned bits of constant parameters and whose they are, as DeviceSegmentTarget.
// `defaulted`: inactive parameters written at their default although the values hold another value for them.
export interface RelativeSegmentTarget { lsm: number; size: number; bytes: Buffer; owned: number[]; verify: number[]; markers: number[]; constant: number[]; constants: ConstantPlacement[]; defaulted: Set<string>; }

export function buildRelativeSegmentTarget(
  app: AppConfig,
  values: Map<string, string>,
  lsm: number,
  // ownIdleUnionDefaults: own the DefaultUnionParameter member of every union with no active member,
  // as ETS writes it in both its full and its parameter download (GVS AMMA captures).
  // The read-back model leaves it unset: it compares what the configuration derives.
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; ownIdleUnionDefaults?: boolean; textRefusals?: TextRefusals } = {},
): RelativeSegmentTarget | null {
  const instances = opts.moduleInstances?.length ? opts.moduleInstances : (app.hasModules ? resolveModuleInstances(app, values) : []);
  const model = toAppModel(app, { includeUnions: true, instances });
  const seg = model.segments.find((s) => s.lsm === lsm);
  if (!seg) return null;
  const built = buildDeviceConfig(app, values, opts.lang, instances);
  const active = built.imageValues;
  const rejected = leavesOutInvisible(app) ? built.rejectedRefs : new Set<string>();
  // The unions with at least one active member (only those write an active member, not the default).
  const activeUnions = new Set<string>();
  for (const refId of active.keys()) {
    const u = app.params.get(app.refs.get(refId)?.paramId ?? "")?.unionId;
    if (u !== undefined) activeUnions.add(u);
  }

  // Memory span [min, max] of each module instance's placed params: the contiguous
  // channel region the allocator assigned. A non-module param inside one of these is a
  // displaced channel variant and must not be owned (see the doc comment).
  const moduleSpans: { min: number; max: number }[] = [];
  const spanByInst = new Map<string, { min: number; max: number }>();
  for (const ref of model.refs.values()) {
    if (!ref.id.includes("_MI-")) continue;
    const p = model.params.get(ref.paramId);
    if (!p || p.offset === undefined) continue;
    // Offsets are segment-relative; only count module params in THIS segment, else a
    // module in another LSM would pollute the span and exclude unrelated offsets here.
    if (p.codeSegment && model.segments.find((s) => s.id === p.codeSegment)?.lsm !== lsm) continue;
    const t = model.types.get(p.typeId);
    const n = t ? byteWidth(t.sizeInBit, p.bitOffset) : 1;
    const key = ref.id.match(/MD-\d+_M-\d+_MI-\d+/)?.[0];
    if (!key) continue;
    const s = spanByInst.get(key) ?? { min: Infinity, max: -Infinity };
    s.min = Math.min(s.min, p.offset);
    s.max = Math.max(s.max, p.offset + n - 1);
    spanByInst.set(key, s);
  }
  for (const s of spanByInst.values()) moduleSpans.push(s);
  const inModuleRegion = (offset: number) => moduleSpans.some((s) => offset >= s.min && offset <= s.max);

  const img = Buffer.alloc(seg.size);
  seg.data.copy(img); // manufacturer default image (overwritten where owned)
  const owned = new Array<number>(seg.size).fill(0);
  const verify = new Array<number>(seg.size).fill(0);
  const markers = new Array<number>(seg.size).fill(0);
  const constant = new Array<number>(seg.size).fill(0);
  const placements: ConstantPlacement[] = [];
  const constants = constantsAlone(app, [...model.params.values()].filter((p) => !p.codeSegment || model.segments.find((s) => s.id === p.codeSegment)?.lsm === lsm), model.types, seg.size);
  const defaulted = new Set<string>();

  for (const ref of model.refs.values()) {
    const param = model.params.get(ref.paramId);
    if (!param || param.offset === undefined) continue;
    if (param.codeSegment && model.segments.find((s) => s.id === param.codeSegment)?.lsm !== lsm) continue;
    const cfgParam = app.params.get(ref.paramId);
    // An integer parameter wider than the integer codec (6 bytes) has no encoding Busforge knows;
    // it is never owned and the device byte is preserved. A BinaryValue parameter of any width
    // writes its enumeration's bytes, a text parameter its characters.
    const wType = model.types.get(param.typeId);
    if (wType && wType.base !== "BinaryValue" && wType.base !== "Text" && Number.isFinite(wType.sizeInBit) && byteWidth(wType.sizeInBit, param.bitOffset) > MAX_INT_BYTES) continue;
    // Value source / ownership, in priority order:
    //  - union member / module-instance param: own only when ACTIVE (overlap-safe).
    //  - any active param: own, use its resolved value.
    //  - inactive plain param that is user-facing (Access != None): own at its parameter default,
    //    not at a value the project still stores for it; System B writes every such default and the
    //    device holds it (PSU byte-match). The MDT IP Interface/Router's full download writes the
    //    defaults of inactive parameters the project holds other values for (private corpus
    //    captures/mdt-router-ets6log-fulldownload.txt, RelMemory(4) +122, +124, +231, +2692).
    //  - inactive Access="None" param: NOT owned; the device byte stays.
    //  - where the application leaves out invisible parameters, an inactive plain param every placement of which
    //    lies in a branch the configuration rejects: NOT owned (below).
    const gated = ref.id.includes("_MI-") || cfgParam?.union === true;
    let v: string | undefined;
    if (gated || active.has(ref.id)) v = active.get(ref.id);
    else if (cfgParam?.access !== "None" && !inModuleRegion(param.offset) && !rejected.has(ref.id)) v = param.value;
    //  - a union with NO active member: ETS writes its DefaultUnionParameter member (GVS AMMA
    //    capture: every disabled channel's unions, byte for byte), under the same
    //    Access="None" rule as an inactive plain parameter. Module-instance unions are not
    //    covered by a capture and stay unowned.
    if (v === undefined && opts.ownIdleUnionDefaults && cfgParam?.unionDefault && cfgParam.unionId !== undefined && !ref.id.includes("_MI-")
      && !activeUnions.has(cfgParam.unionId) && cfgParam.access !== "None" && app.refs.get(ref.id)?.access !== "None"
      && !inModuleRegion(param.offset)) {
      v = values.get(ref.id) ?? app.refs.get(ref.id)?.value ?? param.value;
    }
    if (v === undefined) continue;
    const type = model.types.get(param.typeId);
    if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
    let wrote: boolean;
    try {
      wrote = encode(img, param.offset, param.bitOffset, type, v);
    } catch (e) {
      if (opts.textRefusals === "skip" && isTextRefusal(e)) continue;
      throw e;
    }
    if (!wrote) continue;
    if (!gated && !active.has(ref.id) && values.has(ref.id) && values.get(ref.id) !== v) defaulted.add(ref.id);
    const verifiable = cfgParam?.access !== "None"; // device-internal markers stay owned but unverified
    markOwned(owned, verify, param.offset, param.bitOffset, type.sizeInBit, seg.size, verifiable);
    if (!verifiable && cfgParam?.patchAlways) markOwned(markers, [], param.offset, param.bitOffset, type.sizeInBit, seg.size, false);
    if (constants.has(param.id) && constantParams(app).get(param.id) === v) {
      markOwned(constant, [], param.offset, param.bitOffset, type.sizeInBit, seg.size, false);
      placements.push({ paramRefId: ref.id, paramId: param.id, offset: param.offset, bitOffset: param.bitOffset ?? 0, sizeInBit: type.sizeInBit });
    }
  }
  return { lsm, size: seg.size, bytes: img, owned, verify, markers, constant, constants: placements, defaulted };
}

// Merge a surgical relative target onto the live segment for a System B download: write
// ONLY owned bytes, carry every unowned byte over from the device read. Returns the full
// image to flash (the bytes a download may write or keep) and the count of
// bytes that differ from `current` (== owned bytes we are actually changing; 0 means a
// no-op reconfiguration). `current` is the device read, guaranteed `target.size` long.
// A byte differing only in constant bits (`target.constant`) goes into the image but is not counted.
export function mergeRelativeTarget(current: Buffer, target: RelativeSegmentTarget): { image: Buffer; diffBytes: number } {
  const image = Buffer.from(current);
  let diffBytes = 0;
  for (let i = 0; i < target.size; i++) {
    image[i] = mergeOwnedBits(current[i], target.bytes[i], target.owned[i]);
    if (((image[i] ^ current[i]) & ~target.constant[i]) !== 0) diffBytes++;
  }
  return { image, diffBytes };
}

// Verify a read-back against intended bytes, comparing ONLY the masked positions. This is
// THE owned-byte verify authority for both memory models: unmasked bytes are not under our
// authority (device-recomputed tables, unowned defaults), so a full-buffer equality check
// would report a correct flash as failed.
// `mask` is a bit mask per byte, or true/false for a whole byte.
export function verifyMaskedBytes(back: Buffer, want: Buffer, mask: ReadonlyArray<number | boolean>): boolean {
  if (back.length < mask.length) return false;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i] === true ? 0xff : mask[i] === false ? 0 : (mask[i] as number);
    if ((back[i] ^ want[i]) & m) return false;
  }
  return true;
}

// Bytes of a read-back that rest on the device's write confirmation alone: device addresses, in runs.
export interface ConfirmedOnlyRange { address: number; length: number }

// verifyMaskedBytes for a read-back taken at device address `at` after an operation that wrote with
// the confirmed extended write (`confirmed`: the chunks the device answered with return code 0, see
// KnxDevice.confirmedWrites). A byte that reads back otherwise than wanted is accepted on the
// confirmation alone, as ETS accepts it, only where the device does not give that byte back:
// - the device confirmed writing exactly the wanted value there in this operation;
// - it reads FF there, before the operation (`before`) and after it: what a device returns for a
//   byte it does not give back (MDT IP Interface/Router, its web interface password field). A byte
//   reading data, the old value of a lost or rejected write, is a mismatch;
// - and the read-back shows the operation landed: some other byte it changed and wrote reads back as
//   written. A device that lost or reverted the whole write shows none, and is not verified.
// Returns null where a byte differs that this does not cover, else the runs resting on the
// confirmation alone (empty when every byte reads back as wanted).
export function confirmedMatch(
  back: Buffer, want: Buffer, mask: ReadonlyArray<number | boolean>, at: number,
  confirmed: ReadonlyArray<{ address: number; bytes: Buffer }>, before: Buffer | null,
): ConfirmedOnlyRange[] | null {
  if (back.length < mask.length) return null;
  const wrote = new Map<number, number>();
  for (const c of confirmed) c.bytes.forEach((b, i) => wrote.set(c.address + i, b));
  const only: number[] = [];
  let landed = false;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i] === true ? 0xff : mask[i] === false ? 0 : (mask[i] as number);
    if (!m) continue;
    const w = wrote.get(at + i);
    if (!((back[i] ^ want[i]) & m)) {
      if (w !== undefined && before && before.length > i && ((before[i] ^ want[i]) & m)) landed = true;
      continue;
    }
    if (w === undefined || ((w ^ want[i]) & m) || !before || before.length <= i || back[i] !== 0xff || before[i] !== 0xff) return null;
    only.push(at + i);
  }
  if (only.length && !landed) return null;
  return addressRuns(only);
}

// Ascending device addresses as runs.
function addressRuns(addresses: number[]): ConfirmedOnlyRange[] {
  const runs: ConfirmedOnlyRange[] = [];
  for (const a of addresses) {
    const last = runs.at(-1);
    if (last && last.address + last.length === a) last.length++;
    else runs.push({ address: a, length: 1 });
  }
  return runs;
}

// The bytes mergeRelativeTarget counts as differing where the device reads FF, at device address `at`,
// in runs: what a device returns for a byte it does not give back (confirmedMatch). A read cannot tell
// such a byte from one that holds FF, so a dry run names them (FlashResult.readsFF) and a write of them
// shows which they are: where they read FF again afterwards, they rest on its write confirmation alone.
export function differingFF(current: Buffer, image: Buffer, target: RelativeSegmentTarget, at: number): ConfirmedOnlyRange[] {
  const ff: number[] = [];
  for (let i = 0; i < target.size; i++) if (current[i] === 0xff && ((image[i] ^ current[i]) & ~target.constant[i]) !== 0) ff.push(at + i);
  return addressRuns(ff);
}

// Verify a relative flash: owned bytes minus Access="None" markers (the `verify` mask).
export function verifyRelativeOwned(back: Buffer, target: RelativeSegmentTarget): boolean {
  return verifyMaskedBytes(back, target.bytes, target.verify);
}

// A full download writes every byte of its image, so its read-back asserts every byte a
// verifiable parameter touches, the template bits beside it included, but not the bits of a
// download marker (`markers`, see RelativeSegmentTarget), which the device changes itself.
export function wholeBytes(verify: ReadonlyArray<number>, markers: ReadonlyArray<number> = []): number[] {
  return verify.map((m, i) => (m ? 0xff & ~((markers[i] ?? 0) & ~m) : 0));
}

// Which bytes of an absolute segment some parameter's memory location covers, every parameter of the
// segment whether active or not (union members and module-instance parameters included). Null when a
// parameter there has a type of no known width, so the bytes it covers cannot be told.
// `colorWidth`: count a TypeColor parameter in the RGB or the HSV space as three bytes, for the set of bytes
// a parameter download writes with the device's own values (no image path encodes a colour).
export function parameterMemoryBytes(app: AppConfig, segId: string, size: number, opts: { moduleInstances?: ModuleInstance[]; colorWidth?: boolean } = {}): boolean[] | null {
  const model = toAppModel(app, { includeUnions: true, instances: opts.moduleInstances ?? [] });
  const covered = new Array<boolean>(size).fill(false);
  for (const p of model.params.values()) {
    if (p.codeSegment !== segId || p.offset === undefined) continue;
    const t = model.types.get(p.typeId);
    const bits = t && Number.isFinite(t.sizeInBit) && t.sizeInBit > 0 ? t.sizeInBit : opts.colorWidth ? colorBits(app, p.typeId) : undefined;
    if (!bits) return null;
    for (let b = 0; b < byteWidth(bits, p.bitOffset); b++) if (p.offset + b < size) covered[p.offset + b] = true;
  }
  return covered;
}
// A TypeColor declares no SizeInBit; its memory is three bytes in the RGB and the HSV space, the bytes
// ETS's image of the MDT BE-06001.02 parameter download lists for its RGBColor and HSV parameters. Other
// spaces have no width shown by a capture. The image build encodes no colour, so a colour is never owned.
function colorBits(app: AppConfig, typeId: string): number | undefined {
  const t = app.types.get(typeId);
  return t?.kind === "TypeColor" && (t.colorSpace === "RGB" || t.colorSpace === "HSV") ? 24 : undefined;
}

// The colour parameters with memory that a configuration activates, by ParameterRef id, with their values.
export function activeColorValues(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[]): Map<string, string> {
  const model = toAppModel(app, { includeUnions: true, instances });
  const out = new Map<string, string>();
  for (const [refId, v] of buildDeviceConfig(app, values, undefined, instances).imageValues) {
    const ref = model.refs.get(refId);
    const p = ref ? model.params.get(ref.paramId) : undefined;
    if (p?.offset !== undefined && app.types.get(p.typeId)?.base === "Color") out.set(refId, v);
  }
  return out;
}

// No ETS download captured holds a colour parameter in use, so how ETS encodes a colour into memory is not
// shown, and no image path writes one (encode()). An operation that would have to write a colour refuses
// instead of leaving the device's bytes as they are and reporting the new colour programmed:
//  - a parameter or structural flash, when a colour in use differs from the configuration the device was
//    last programmed with, or comes into use (`base` given);
//  - a full download, for any colour in use (`base` absent): it knows no configuration the device holds,
//    and would leave there either the segment's <Data> (a segment loaded afresh) or the unit's bytes (a
//    segment written into the loaded application), neither shown to be the colour.
export function refuseColorWrites(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[], base?: { values: Map<string, string>; instances: ModuleInstance[] }): void {
  const now = activeColorValues(app, values, instances);
  const before = base ? activeColorValues(app, base.values, base.instances) : new Map<string, string>();
  const written = [...now].filter(([ref, v]) => !base || before.get(ref)?.toUpperCase() !== v.toUpperCase()).map(([ref]) => ref);
  if (!written.length) return;
  const what = base
    ? `this flash writes the device's parameters, and ${written.length} colour parameter(s) among them changed or came into use (e.g. ${written[0]})`
    : `the configuration has ${written.length} colour parameter(s) in use (e.g. ${written[0]}), which a full download writes`;
  throw new ProductError("PARAM_COLOR_UNSUPPORTED",
    `${what}; no ETS download shows how a colour is encoded in the device's memory, so Busforge cannot write it. Refusing rather than leaving the device's colour unchanged; apply the colour with ETS`);
}
