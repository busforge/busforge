import { resolveParamRef, sameParamValue, type AppConfig, type CfgParamRef, type DynNode, type ModuleInstance } from "./appconfig.ts";
import { toAppModel, type Param, type ParamType } from "./application.ts";
import { buildDeviceConfig, decodeTextEntities, readingsOf, refuseUnreachedInstances, unsettledDefaultRefusal, type DeviceConfigBuild } from "./config.ts";
import { resolveModuleInstances } from "./modules.ts";
import { byteWidth, MAX_INT_BYTES, encode, textLength } from "./image.ts";
import { ProductError } from "./errors.ts";
import { maskInfo } from "./masks.ts";
import { applyCalculations, instanceMarker, paramKey, steeringParamIds, type CalculationRun } from "./calculations.ts";

// `textRefusals: "skip"`: a text parameter the codec refuses (and, on the relative segment, a colour) is
// left unowned instead of failing the build, and so are the bits two active members of one union contest
// (noteUnionWrite). Only for the read-back, which compares what it can and does not write; every path that
// writes keeps the refusal.
type TextRefusals = "refuse" | "skip";
const isTextRefusal = (e: unknown): boolean => e instanceof ProductError && e.code.startsWith("PARAM_TEXT_");

// Build the parameter memory image for the MV-0705 (absolute-segment) device model.
//
// Unlike the RelativeSegment path (buildParameterImage), these devices store
// parameters in one or more AbsoluteSegments at fixed addresses, and the correct
// image is the manufacturer <Data> default overlaid with the VISIBLE/ACTIVE parameters'
// effective values. A parameter hidden by the app's dynamic structure (choose/when) keeps
// the <Data> byte or takes its default as hiddenParameterRule says.
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

// Two active members of one <Union> placed on the same bits: ETS writes the member that comes later, where
// the order of the ParameterRefs and the document order of the configuration's tree agree. The OpenKNX
// RaumController's 1-Wire device id (a text) and family code share their first byte, both active; ETS logs
// the overlap and its full download holds the family code's 00 there, the member later in both orders
// (private corpus captures/openknx-ets6log-fulldownload.txt, RelMemory(4) $0145). Where the two orders
// disagree, no capture shows which member ETS writes: a member that changes bits another active member of
// its union wrote is refused there, or, for a read-back (`contested` given), those bits are recorded in
// `contested` and the caller leaves them unowned. Members that agree on their shared bits build either way.
// The image builds encode refs in ParameterRef order, so the member encoded later wins by that order where
// it comes later in the tree than every other member that wrote those bits. A ref the tree places more than
// once has no single place in it, so where it takes part in such a contest the orders count as disagreeing.
// Two refs of one member are one member.
// `writes`: per bit of the segment (byte * 8 + KNX bit offset), every union member that wrote it (its union,
// parameter and ref). `tree`: each active ref's place in the configuration's tree (the image values'
// order), and the refs the tree places more than once. `before`: the image bytes of the member's field
// before it was encoded.
type UnionWrites = Map<number, { union: string; param: string; ref: string }[]>;
interface TreeOrder { place: Map<string, number>; repeated: Set<string> }
function noteUnionWrite(writes: UnionWrites, tree: TreeOrder, contested: number[] | null, app: AppConfig, refId: string, paramId: string, before: Buffer, img: Buffer, offset: number, bitOffset: number, sizeInBit: number, segId: string): void {
  const instance = paramId.match(/_M-\d+_MI-\d+/)?.[0] ?? "";
  const unionId = app.params.get(paramId.replace(instance, ""))?.unionId;
  if (unionId === undefined) return;
  const union = unionId + instance;
  const once = (ref: string) => !tree.repeated.has(ref.replace(/_M-\d+_MI-\d+/, ""));
  const later = (ref: string) => once(ref) && once(refId) && (tree.place.get(refId) ?? -1) > (tree.place.get(ref) ?? Infinity);
  for (let g = bitOffset; g < bitOffset + sizeInBit; g++) {
    const at = offset + (g >> 3);
    if (at >= img.length) break;
    const bit = at * 8 + (g & 7), m = 0x80 >> (g & 7);
    const prior = writes.get(bit) ?? [];
    const other = prior.find((w) => w.union === union && w.param !== paramId && !later(w.ref));
    if (other && ((before[at - offset] ^ img[at]) & m)) {
      if (!contested) {
        throw new ProductError("PARAM_UNION_OVERLAP",
          `${other.ref} and ${refId} are active members of one <Union> placed on the same bits at offset ${at} of ${segId}, with different values, and ${refId} comes later among the ParameterRefs but not in the configuration's tree; no ETS capture shows which member ETS writes there, so refusing rather than writing either`);
      }
      contested[at] |= m;
    }
    writes.set(bit, [...prior, { union, param: paramId, ref: refId }]);
  }
}
// The place of each active ref in the configuration's tree (the image values' order), and the refs the
// application's trees place more than once.
function treeOrderOf(app: AppConfig, active: Map<string, string>): TreeOrder {
  const seen = new Set<string>(), repeated = new Set<string>();
  const walk = (nodes: DynNode[]) => {
    for (const n of nodes) {
      if (n.kind === "paramRef") { if (seen.has(n.refId)) repeated.add(n.refId); seen.add(n.refId); }
      else if (n.kind === "block" || n.kind === "container") walk(n.children);
      else if (n.kind === "choose") for (const w of n.whens) walk(w.children);
    }
  };
  walk(app.dynamic);
  for (const d of app.moduleDefs.values()) walk(d.dynamic);
  return { place: new Map([...active.keys()].map((k, i) => [k, i])), repeated };
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
// `hidden`: the bits of the parameters the configuration does not place, where none it places lies: the
// image holds the segment's <Data> there (FF past the end of its <Data>, zero in a segment without
// <Data>), or the parameter's default where hiddenParameterRule has ETS write it, and a write that places
// such a parameter writes its value there (a structural flash, which writes the image's bits back
// once it hides the parameter again).
export interface DeviceSegmentTarget extends DeviceSegmentImage { owned: number[]; verify: number[]; constant: number[]; constants: ConstantPlacement[]; hidden: number[]; dataBits?: number[] }

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

// Where a configuration has two readings (buildDeviceConfig), a segment is built from each, and refused unless
// both write the same bytes the same way. A calculation runs on the first reading's values only, so an application
// that declares one is refused outright there.
// `prior`: the configuration's build from the first pass, which the second reads its other reading from.
type Reading = { prior?: undefined } | { prior: DeviceConfigBuild };
const sameWrites = <T>(a: T, b: T, fields: (keyof T)[]): boolean => fields.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]));

export function buildAbsoluteSegmentTargets(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; textRefusals?: TextRefusals } = {},
): DeviceSegmentTarget[] {
  const { out, taken } = absoluteSegmentTargets(app, values, opts, {});
  if (!taken.otherReading) return out;
  const other = absoluteSegmentTargets(app, values, opts, { prior: taken }).out;
  if (other.length !== out.length || out.some((t, i) => !sameWrites(t, other[i], ["address", "bytes", "owned", "verify", "constant", "hidden", "dataBits"]))) throw unsettledDefaultRefusal(taken.unsettledChooses);
  return out;
}

function absoluteSegmentTargets(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; textRefusals?: TextRefusals },
  reading: Reading,
): { out: DeviceSegmentTarget[]; taken: DeviceConfigBuild } {
  // Module instances: the imported project's set when given, else re-run the allocators
  // for a from-scratch device so its channel parameters are placed at the same offsets
  // ETS would compute. Threaded into BOTH the image model (to materialise the per-instance
  // params) and the config view (to resolve which of them are active).
  const instances = absoluteBuildInstances(app, values, opts.moduleInstances);
  const model = toAppModel(app, { includeUnions: true, instances });
  // The results of the <ParameterCalculation>s Busforge runs, stored on their parameters as ETS stores them.
  const calc = applyCalculations(app, values, instances);
  const calculated = calc.values;
  // Effective value of every parameter reached in the active dynamic tree, keyed by
  // ParameterRef id. This includes Access="None" internal parameters that ETS writes
  // to memory but hides from the UI, so it is the right source for the image (the
  // visible blocks alone would miss them).
  // The calculations ran on the first reading's values; which of them the other reading would run is not known.
  if (reading.prior && app.calculations.length) throw unsettledDefaultRefusal(reading.prior.unsettledChooses);
  const taken = reading.prior ?? buildDeviceConfig(app, calculated, opts.lang, instances);
  if (!opts.moduleInstances?.length) refuseUnreachedInstances(app, taken, instances);
  const view = reading.prior ? reading.prior.otherReading! : taken;
  const active = view.imageValues;
  const treeOrder = treeOrderOf(app, active);
  // The parameters an active ref places: another ref of theirs is not a hidden parameter.
  const shown = new Set([...active.keys()].map((r) => model.refs.get(r)?.paramId));
  const hiddenRules = hiddenRulesOf(app, model.refs.values(), view.rejectedRefs, shown);

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
    const hidden = new Array<number>(seg.size).fill(0), placed = new Array<number>(seg.size).fill(0);
    const activeBits = new Array<number>(seg.size).fill(0);
    const unionWrites: UnionWrites = new Map();
    const contested = opts.textRefusals === "skip" ? new Array<number>(seg.size).fill(0) : null;
    // The user-facing parameters the configuration does not show, decided once every active one is written.
    const unshown: { refId: string; param: Param; type: ParamType; bits: number; plain: boolean; value?: string }[] = [];
    for (const ref of model.refs.values()) {
      const param = model.params.get(ref.paramId);
      if (!param || param.codeSegment !== segId || param.offset === undefined) continue;
      const v = active.get(ref.id);
      const type = model.types.get(param.typeId);
      const sized = !!type && Number.isFinite(type.sizeInBit) && type.sizeInBit > 0;
      if (sized) markOwned(v === undefined ? hidden : placed, [], param.offset, param.bitOffset, type!.sizeInBit, seg.size, false);
      const bits = type && type.base !== "Color" && sized ? type.sizeInBit : colorBits(app, param.typeId) ?? 8;
      // A module instance's parameter and ref are the ModuleDef's, with the instance in their ids.
      const cfgParam = app.params.get(ref.paramId.replace(INSTANCE, "")), access = app.refs.get(ref.id.replace(INSTANCE, ""))?.access;
      if (v === undefined && type && cfgParam && cfgParam.access !== "None" && access !== "None" && !shown.has(ref.paramId)) {
        const plain = sized && type.base !== "Color" && type.base !== "Text" && !cfgParam.union && !INSTANCE.test(ref.id);
        unshown.push({ refId: ref.id, param, type, bits, plain, value: param.value ?? cfgParam.value });
      }
      // An active parameter's bits, and those of one a <ParameterCalculation> sets (ETS computes it, Busforge
      // does not), are not the image's <Data> to write.
      // A module instance's ref is the ModuleDef's, as <ParameterCalculation> names it, with the instance in its id.
      if (v !== undefined || app.calculationRefs.has(ref.id) || app.calculationRefs.has(ref.id.replace(/_M-\d+_MI-\d+/, ""))) markOwned(activeBits, [], param.offset, param.bitOffset, bits, seg.size, false);
      if (v === undefined) continue; // not visible / not active: decided below (`unshown`)
      if (!type || !sized) continue;
      // A colour on these segments: no ETS capture of a product with absolute segments shows one, so the
      // bytes stay unowned and refuseColorWrites refuses an operation that would have to write one.
      if (type.base === "Color") continue;
      // An active text parameter on System 7 takes the codec's layout, its characters and a closing zero:
      // ETS's partial download activating the Theben Meteodata 140 S's threshold channel C14 (MV-0701)
      // wrote "20,0" into a 5-byte field as 32 30 2c 30 00 and "1,0" into a 4-byte field as 31 2c 30 00,
      // characters over <Data> bytes 32 and 19 (private corpus captures/meteodata-140s-ets6log-partial-c14-on.txt
      // l. 183, row 09F0 of Memory[$4000-$5FFF]). Its <Data> held zeros behind the characters, so no capture
      // of a System 7 product shows a zero written over a non-zero <Data> byte, nor a value filling its
      // field, nor any text on System 1: those are refused.
      let textRefusal: ProductError | undefined;
      if (type.base === "Text") {
        const size = type.sizeInBit / 8;
        if (maskInfo(app.mask).family !== "system-7") {
          textRefusal = new ProductError("PARAM_TEXT_UNSUPPORTED", `text parameter ${param.id} at offset ${param.offset} of ${segId}: no ETS capture shows a text parameter on this memory model`);
        } else {
          // The characters' bytes in the application's text encoding; the codec's zeros take the rest of the field.
          let n: number | undefined;
          try { n = textLength(type, v); } catch (e) { if (!isTextRefusal(e)) throw e; textRefusal = e as ProductError; }
          if (n === size) {
            textRefusal = new ProductError("PARAM_TEXT_TOO_LONG", `text parameter ${param.id} at offset ${param.offset} of ${segId}: "${v}" takes ${n} bytes and fills its ${size}-byte field, which no ETS capture of a System 7 product shows; it holds at most ${size - 1} bytes`);
          } else if (n !== undefined) {
            const over = Array.from({ length: Math.max(0, size - n) }, (_, i) => param.offset! + n + i).find((o) => (seg.data[o] ?? 0) !== 0);
            if (over !== undefined) textRefusal = new ProductError("PARAM_TEXT_UNSUPPORTED", `text parameter ${param.id} at offset ${param.offset} of ${segId}: "${v}" would write a zero over the <Data> byte ${seg.data[over].toString(16).padStart(2, "0")} at offset ${over}, which no ETS capture of a System 7 product shows`);
          }
        }
      }
      // Only mark bytes owned if encode ACTUALLY wrote them. A time/color/other
      // type (or a malformed value) writes nothing, so it must not claim authority over
      // its bytes: the flash path would otherwise push the segment's init/default value
      // over device memory the parameter never derived. Gating on the real write keeps
      // ownership exactly symmetric with the image, with no duplicated type gate.
      let wrote: boolean;
      const before = Buffer.from(img.subarray(param.offset, param.offset + byteWidth(type.sizeInBit, param.bitOffset)));
      try {
        if (textRefusal) throw textRefusal;
        wrote = encode(img, param.offset, param.bitOffset, type, v);
      } catch (e) {
        if (opts.textRefusals === "skip" && isTextRefusal(e)) continue;
        throw e;
      }
      if (!wrote) continue;
      noteUnionWrite(unionWrites, treeOrder, contested, app, ref.id, ref.paramId, before, img, param.offset, param.bitOffset ?? 0, type.sizeInBit, segId);
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
    // A parameter the configuration does not show, where no active one holds its bits: as hiddenParameterRule says.
    // One written at its default stays unowned, like the <Data> bits around it: the image holds the value ETS
    // writes there, and `dataBits` takes it (refuseHiddenBytes guards it as it guards <Data>). A union member, a
    // module instance's parameter, a text and a colour are written at their default by no ETS download Busforge has.
    // Two such defaults on the same bits that disagree are refused: which one ETS writes is not shown.
    const defaulted = new Array<number>(seg.size).fill(0);
    for (const u of unshown) {
      const rule = hiddenRules.get(u.param.id)!;
      if (rule === "template" || holdsBits(activeBits, u.param, u.bits)) continue;
      const written = u.type.base === "Color" ? null : withValue(img, u.param, u.type, u.value);
      if (rule === "default" && u.plain && written && !holdsBits(defaulted, u.param, u.bits)) {
        written.copy(img);
        markOwned(defaulted, [], u.param.offset!, u.param.bitOffset, u.bits, seg.size, false);
        continue;
      }
      if (rule === "default" && u.plain && written?.equals(img)) continue;
      if (opts.textRefusals !== "skip" && (!written || !written.equals(img))) {
        throw hiddenRefusal(u.refId, `offset ${u.param.offset} of ${segId}`, rule !== "default" ? rule.refuse
          : u.plain && written ? "another hidden parameter's default on the same bits differs, and no ETS download shows which of them ETS writes"
          : "no ETS download shows whether ETS writes a hidden union member, module parameter, text or colour at its default");
      }
    }
    // The bits of ETS's image where no active parameter lies: a hidden parameter's (at <Data>, or at its
    // default as above), and those no parameter uses (at <Data>). Without <Data> (or past it) none: no capture shows what
    // ETS's partial download writes there, so a write keeps the unit's bits.
    const dataBits = activeBits.map((a, i) => (i < seg.data.length ? ~a & 0xff : 0));
    if (contested) for (const [i, c] of contested.entries()) { owned[i] &= ~c; verify[i] &= ~c; constant[i] &= ~c; }
    out.push({ id: segId, address: seg.address, size: seg.size, bytes: img, owned, verify, constant, constants: placements, hidden: hidden.map((h, i) => h & ~placed[i] & 0xff), dataBits });
  }
  return { out: out.sort((a, b) => a.address - b.address), taken };
}

// The RelativeSegment (System B) parameter image as a SURGICAL target: the bytes plus
// an `owned` mask of which bytes we may write. Unlike buildParameterImage (which writes
// every memory-backed ref over the <Data> default and is used unchanged for the proven
// full-image semantics), this gates ownership so the flash path can preserve bytes ETS
// computes that we cannot reproduce.
//
// Ownership rule, hardware-derived (see docs/device-memory-model.md):
//  - A plain top-level memory parameter: OWNED, value = effective value when active; when
//    inactive, its parameter default where hiddenParameterRule has ETS write it (PSU M-0162
//    read-back: full-image byte-match only with the default fallback; gating it off
//    regressed 51 bytes), else not owned.
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
// What ETS writes for a parameter the configuration does not show (docs/load-procedures.md, R14): its default,
// or nothing, so its bytes keep the segment's template (<Data>, zeros where the segment has none; in a filled
// System B full download with a non-zero Fill, unowned bytes of a dataless segment stay at that allocation fill,
// fullDownloadParamImage). The
// application's <Options DownloadInvisibleParameters> and its MinEtsVersion decide, and only where an ETS
// download shows the combination; the others refuse, and the builders refuse them only where the two answers
// differ in a byte. `rejected`: every placement of the parameter lies in a branch of a choose ETS evaluated and
// did not take. Shown:
//  - System B, no option, MinEtsVersion 5 or later: the default. GVS AMMA, MDT IP Interface/Router, MEAN WELL
//    PSU (ETS captures and ETS's download records, private corpus); a parameter in no block (bussard's synthetic
//    `syn-hidden-default`, 6.0).
//  - System B, no option, MinEtsVersion 4: the template (`syn-relseg-dataless-hidden`, 4.0: 00 00 on a segment
//    without <Data>, neither the default nor the fill).
//  - System B, "None": the template for a rejected parameter. Theben MIX 2 (a JMG 4 T with its second extension
//    slot empty: offset 1129, P-63, left at 00 in the full download; offset 1201, P-36, absent from its
//    parameter download; captures/mix2-jmg4t-ets6log-fulldownload.txt and -partial-params.txt) and Jung
//    400021SE (captures and download records).
//  - System B, LegacyPatchAlways under "None" or "Background", outside a branch ETS evaluated and did not take:
//    the default. The MIX 2's P-202, gated by a choose on an unset Merker; `syn-legacy-patch-always` and
//    `syn-param-calculation` under "Background", in no block.
//  - System 7, "Background": the template. Every System 7 application in the corpus (ETS captures).
//  - System 7, no option: the default from MinEtsVersion 5 (`syn-s7-hidden-default`, 6.0), the template at 4
//    (`syn-s7-hidden-default-ets4`, `-p11`, 4.0).
export type HiddenWrite = "default" | "template" | { refuse: string };
export function hiddenParameterRule(app: AppConfig, p: { rejected: boolean; patchAlways: boolean }): HiddenWrite {
  const family = maskInfo(app.mask).family;
  const option = app.downloadInvisibleParameters;
  const minEts = /^\s*(\d+)/.exec(app.minEtsVersion ?? "")?.[1];
  const major = minEts === undefined ? undefined : Number(minEts);
  const declared = `DownloadInvisibleParameters ${option === undefined ? "not declared" : `"${option}"`}, MinEtsVersion ${app.minEtsVersion === undefined ? "not declared" : `"${app.minEtsVersion}"`}`;
  const refuse = (what: string): HiddenWrite => ({ refuse: `no ETS download shows whether ETS writes ${what} at its default on ${family} with ${declared}` });
  if (family === "system-b") {
    if (p.patchAlways) {
      if (option === undefined) return major !== undefined && major >= 5 ? "default" : refuse("a hidden LegacyPatchAlways parameter");
      return (option === "None" || option === "Background") && !p.rejected ? "default" : refuse(`a hidden LegacyPatchAlways parameter${p.rejected ? " in a branch it evaluated and did not take" : ""}`);
    }
    if (option === undefined) return major !== undefined && major >= 5 ? "default" : major === 4 ? "template" : refuse("a parameter the configuration does not show");
    if (option === "None" && p.rejected) return "template";
    return refuse("a parameter the configuration does not show");
  }
  if (family === "system-7") {
    if (p.patchAlways) return refuse("a hidden LegacyPatchAlways parameter");
    if (option === "Background") return "template";
    if (option === undefined) return major !== undefined && major >= 5 ? "default" : major === 4 ? "template" : refuse("a parameter the configuration does not show");
    return refuse("a parameter the configuration does not show");
  }
  return refuse("a parameter the configuration does not show");
}
// The rule of each parameter no active ref places, by its id in the image model, over all its refs: refs it
// decides differently for refuse.
const INSTANCE = /_M-\d+_MI-\d+/;
function hiddenRulesOf(app: AppConfig, refs: Iterable<{ id: string; paramId: string }>, rejectedRefs: Set<string>, shown: Set<string | undefined>): Map<string, HiddenWrite> {
  const out = new Map<string, HiddenWrite>();
  for (const ref of refs) {
    const p = app.params.get(ref.paramId.replace(INSTANCE, ""));
    if (!p || shown.has(ref.paramId)) continue;
    const rule = hiddenParameterRule(app, { rejected: rejectedRefs.has(ref.id), patchAlways: !!p.patchAlways });
    const was = out.get(ref.paramId);
    if (was === undefined || typeof was !== "string") { if (was === undefined) out.set(ref.paramId, rule); continue; }
    if (was !== rule) out.set(ref.paramId, typeof rule === "string" ? { refuse: `its ParameterRefs are hidden in ways ETS writes differently (${was}, ${rule})` } : rule);
  }
  return out;
}
// The image with `value` at the parameter's place; null where its type does not take the value.
function withValue(img: Buffer, param: { offset?: number; bitOffset?: number }, type: ParamType, value: string | undefined): Buffer | null {
  if (param.offset === undefined || value === undefined) return null;
  const trial = Buffer.from(img);
  try { return encode(trial, param.offset, param.bitOffset ?? 0, type, value) ? trial : null; } catch (e) { if (e instanceof ProductError) return null; throw e; }
}
// Whether any of the parameter's bits is set in `mask`.
function holdsBits(mask: number[], param: { offset?: number; bitOffset?: number }, sizeInBit: number): boolean {
  if (param.offset === undefined) return false;
  const mine = new Array<number>(mask.length).fill(0);
  markOwned(mine, [], param.offset, param.bitOffset ?? 0, sizeInBit, mask.length, false);
  return mine.some((m, i) => (m & mask[i]) !== 0);
}
const hiddenRefusal = (refId: string, at: string, reason: string) =>
  new ProductError("PARAM_HIDDEN_UNSUPPORTED", `parameter ${refId} at ${at} is not shown in this configuration, its default differs from the segment's template there, and ${reason}; refusing rather than guessing which of the two ETS writes`);

// `markers`: the bits of active Access="None" LegacyPatchAlways parameters, download markers ETS writes
// set every time and the device clears (the Theben MIX 2's P-199 "A_Download erfolgt", bit 0x80 of
// offset 39). Written, never asserted.
// `constant`, `constants`: the owned bits of constant parameters and whose they are, as DeviceSegmentTarget.
// `defaulted`: inactive parameters written at their default although the values hold another value for them.
export interface RelativeSegmentTarget { lsm: number; size: number; bytes: Buffer; owned: number[]; verify: number[]; markers: number[]; constant: number[]; constants: ConstantPlacement[]; defaulted: Set<string>; }

// The parameter segment a filled System B full download (LdCtrlRelSegment Mode 1) leaves on the device:
// on a segment without <Data>, unowned bytes stay at the allocation's `fillByte` (and fillAllocatedRuns
// leaves them untouched) while owned bytes keep `target.bytes` (partially-owned bytes keeping zero in
// their unowned bits, as ETS's download of M-00A6_A-0025-30-A50D into a simulated unit shows). Segments
// that declare <Data> keep `target.bytes` unchanged.
export function fullDownloadParamImage(
  app: AppConfig,
  target: Pick<RelativeSegmentTarget, "lsm" | "bytes" | "owned">,
  fillByte: number,
): Buffer {
  if (target.bytes.length !== target.owned.length) {
    throw new ProductError("FULL_DOWNLOAD_SEGMENT_UNKNOWN", `parameter image length ${target.bytes.length} does not match ownership length ${target.owned.length}`);
  }
  const seg = app.segments.find((s) => s.lsm === target.lsm);
  if (!seg || seg.data.length > 0) return target.bytes;
  const fill = fillByte & 0xff;
  if (fill === 0) return target.bytes;
  const out = Buffer.from(target.bytes);
  for (let i = 0; i < out.length; i++) if (!target.owned[i]) out[i] = fill;
  return out;
}

type RelativeOpts = { lang?: string; moduleInstances?: ModuleInstance[]; ownIdleUnionDefaults?: boolean; textRefusals?: TextRefusals; fullFill?: number };
export function buildRelativeSegmentTarget(
  app: AppConfig,
  values: Map<string, string>,
  lsm: number,
  // ownIdleUnionDefaults: own the DefaultUnionParameter member of every union with no active member,
  // as ETS writes it in both its full and its parameter download (GVS AMMA captures).
  // The read-back model leaves it unset: it compares what the configuration derives.
  opts: RelativeOpts = {},
): RelativeSegmentTarget | null {
  const built = relativeSegmentTarget(app, values, lsm, opts, {});
  if (!built?.taken.otherReading) return built?.target ?? null;
  const other = relativeSegmentTarget(app, values, lsm, opts, { prior: built.taken })!.target;
  if (!sameWrites(built.target, other, ["bytes", "owned", "verify", "markers", "constant"])) throw unsettledDefaultRefusal(built.taken.unsettledChooses);
  return built.target;
}

function relativeSegmentTarget(app: AppConfig, values: Map<string, string>, lsm: number, opts: RelativeOpts, reading: Reading): { target: RelativeSegmentTarget; taken: DeviceConfigBuild } | null {
  const instances = opts.moduleInstances?.length ? opts.moduleInstances : (app.hasModules ? resolveModuleInstances(app, values) : []);
  const model = toAppModel(app, { includeUnions: true, instances });
  const seg = model.segments.find((s) => s.lsm === lsm);
  if (!seg) return null;
  // The results of the <ParameterCalculation>s Busforge runs, stored on their parameters as ETS stores them.
  const calc = applyCalculations(app, values, instances);
  const calculated = calc.values;
  // The calculations ran on the first reading's values; which of them the other reading would run is not known.
  if (reading.prior && app.calculations.length) throw unsettledDefaultRefusal(reading.prior.unsettledChooses);
  const taken = reading.prior ?? buildDeviceConfig(app, calculated, opts.lang, instances);
  if (!opts.moduleInstances?.length) refuseUnreachedInstances(app, taken, instances);
  const built = reading.prior ? reading.prior.otherReading! : taken;
  const active = built.imageValues;
  // The parameters an active ref places: another ref of theirs is not a hidden parameter.
  const shown = new Set([...active.keys()].map((r) => model.refs.get(r)?.paramId));
  const hiddenRules = hiddenRulesOf(app, model.refs.values(), built.rejectedRefs, shown);
  // The hidden parameters whose bytes no ETS download shows: refused after the loop where their default would change a
  // byte no written parameter holds.
  const unshown: { refId: string; param: Param; type: ParamType | undefined; value?: string; reason: string }[] = [];
  const hiddenDefaults = new Array<number>(seg.size).fill(0); // the bits hidden parameters' defaults wrote
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
  const unionWrites: UnionWrites = new Map(), treeOrder = treeOrderOf(app, active);
  const contested = opts.textRefusals === "skip" ? new Array<number>(seg.size).fill(0) : null;

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
    //  - inactive plain param that is user-facing (Access != None): as hiddenParameterRule says. Where ETS
    //    writes its default, own it at its parameter default, not at a value the project still stores for
    //    it: the MDT IP Interface/Router's full download writes the defaults of inactive parameters the
    //    project holds other values for (private corpus captures/mdt-router-ets6log-fulldownload.txt,
    //    RelMemory(4) +122, +124, +231, +2692). Where ETS keeps the template: NOT owned.
    //  - inactive Access="None" param: NOT owned; the device byte stays.
    const gated = ref.id.includes("_MI-") || cfgParam?.union === true;
    let v: string | undefined;
    let hiddenDefault = false;
    if (gated || active.has(ref.id)) v = active.get(ref.id);
    //    A LegacyPatchAlways one a calculation computed: the computed value, as ETS's download of bussard's synthetic
    //    `syn-param-calculation` writes it into its hidden output.
    else if (cfgParam?.access !== "None" && !inModuleRegion(param.offset) && !shown.has(ref.paramId)) {
      const value = cfgParam?.patchAlways && calc.computed.has(ref.id) ? calculated.get(ref.id) : param.value;
      const rule = hiddenRules.get(ref.paramId)!;
      if (rule === "default") { v = value; hiddenDefault = true; }
      else if (rule !== "template") unshown.push({ refId: ref.id, param, type: model.types.get(param.typeId), value, reason: rule.refuse });
    }
    //  - a union with NO active member: ETS writes its DefaultUnionParameter member (GVS AMMA
    //    capture: every disabled channel's unions, byte for byte), under the same
    //    Access="None" rule as an inactive plain parameter. Module-instance unions are not
    //    covered by a capture and stay unowned.
    if (v === undefined && opts.ownIdleUnionDefaults && cfgParam?.unionDefault && cfgParam.unionId !== undefined && !ref.id.includes("_MI-")
      && !activeUnions.has(cfgParam.unionId) && cfgParam.access !== "None" && app.refs.get(ref.id)?.access !== "None"
      && !inModuleRegion(param.offset)) {
      v = calculated.get(ref.id) ?? app.refs.get(ref.id)?.value ?? param.value;
    }
    if (v === undefined) continue;
    const type = model.types.get(param.typeId);
    if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
    // Two hidden parameters' defaults on the same bits that disagree: which one ETS writes is not shown.
    if (hiddenDefault && holdsBits(hiddenDefaults, param, type.sizeInBit) && opts.textRefusals !== "skip" && !withValue(img, param, type, v)?.equals(img)) {
      throw hiddenRefusal(ref.id, `offset ${param.offset} of the parameter segment (LSM ${lsm})`, "another hidden parameter's default on the same bits differs, and no ETS download shows which of them ETS writes");
    }
    let wrote: boolean;
    const before = Buffer.from(img.subarray(param.offset, param.offset + byteWidth(type.sizeInBit, param.bitOffset)));
    try {
      wrote = encode(img, param.offset, param.bitOffset, type, v);
    } catch (e) {
      if (opts.textRefusals === "skip" && (isTextRefusal(e) || (type.base === "Color" && e instanceof ProductError))) continue;
      throw e;
    }
    if (!wrote) continue;
    if (hiddenDefault) markOwned(hiddenDefaults, [], param.offset, param.bitOffset, type.sizeInBit, seg.size, false);
    noteUnionWrite(unionWrites, treeOrder, contested, app, ref.id, ref.paramId, before, img, param.offset, param.bitOffset ?? 0, type.sizeInBit, `the parameter segment (LSM ${lsm})`);
    if (!gated && !active.has(ref.id) && calculated.has(ref.id) && calculated.get(ref.id) !== v) defaulted.add(ref.id);
    const verifiable = cfgParam?.access !== "None"; // device-internal markers stay owned but unverified
    markOwned(owned, verify, param.offset, param.bitOffset, type.sizeInBit, seg.size, verifiable);
    if (!verifiable && cfgParam?.patchAlways) markOwned(markers, [], param.offset, param.bitOffset, type.sizeInBit, seg.size, false);
    if (constants.has(param.id) && constantParams(app).get(param.id) === v) {
      markOwned(constant, [], param.offset, param.bitOffset, type.sizeInBit, seg.size, false);
      placements.push({ paramRefId: ref.id, paramId: param.id, offset: param.offset, bitOffset: param.bitOffset ?? 0, sizeInBit: type.sizeInBit });
    }
  }
  // In a filled System B full download (`opts.fullFill` set), unowned bytes of a dataless segment stay at the
  // allocation fill rather than 0x00, so an unknown hidden parameter rule compares against that filled template
  // (while partially-owned bytes still keep zero in their unowned bits, matching ETS's RelMemory(4)). Partial
  // downloads, parameter flashes and structural flashes leave `opts.fullFill` unset and compare against `img`.
  if (unshown.length && opts.textRefusals !== "skip") {
    const template = opts.fullFill !== undefined ? fullDownloadParamImage(app, { lsm, bytes: img, owned }, opts.fullFill) : img;
    for (const u of unshown) {
      if (!u.type || !Number.isFinite(u.type.sizeInBit) || holdsBits(owned, u.param, u.type.sizeInBit)) continue;
      const written = withValue(img, u.param, u.type, u.value);
      const at = u.param.offset;
      const span = byteWidth(u.type.sizeInBit, u.param.bitOffset);
      if (!written || at === undefined || !written.subarray(at, at + span).equals(template.subarray(at, at + span))) {
        throw hiddenRefusal(u.refId, `offset ${u.param.offset} of the parameter segment (LSM ${lsm})`, u.reason);
      }
    }
  }
  if (contested) for (const [i, c] of contested.entries()) { owned[i] &= ~c; verify[i] &= ~c; markers[i] &= ~c; constant[i] &= ~c; }
  return { target: { lsm, size: seg.size, bytes: img, owned, verify, markers, constant, constants: placements, defaulted }, taken };
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

// ETS's parameter download sends the bytes that differ from its record of the unit, the image of its last
// download; a parameter flash compares with its read of the unit instead, which stands for that record
// wherever the unit gives its bytes back. A byte it reads as FF says nothing there, so it is decided against
// the image of the programmed baseline (`base`, the parameters the device was last programmed with): where
// the target differs from the read at such a byte but not from the baseline (same owned bits, same bits),
// the project has not changed it since and the flash leaves it alone, as ETS's partial download leaves the
// MDT IP router's web interface password. `left`: those bytes as device addresses from `at`, in runs; the
// returned target no longer owns them and holds the unit's byte there, so no write, verify or count sees
// them. A unit that really holds FF there keeps it. A baseline of another size decides nothing.
export function leaveUnreadUnchanged(current: Buffer, target: RelativeSegmentTarget, base: RelativeSegmentTarget | null, at: number): { target: RelativeSegmentTarget; left: ConfirmedOnlyRange[] } {
  if (!base || base.size !== target.size) return { target, left: [] };
  const left: number[] = [];
  for (let i = 0; i < target.size; i++) {
    const m = target.owned[i];
    if (current[i] !== 0xff || m === 0 || base.owned[i] !== m) continue;
    if (((mergeOwnedBits(current[i], target.bytes[i], m) ^ current[i]) & ~target.constant[i]) === 0) continue;
    if (((target.bytes[i] ^ base.bytes[i]) & m) === 0) left.push(i);
  }
  if (!left.length) return { target, left: [] };
  const out = { ...target, bytes: Buffer.from(target.bytes), owned: [...target.owned], verify: [...target.verify] };
  for (const i of left) { out.bytes[i] = current[i]; out.owned[i] = 0; out.verify[i] = 0; }
  return { target: out, left: addressRuns(left.map((i) => at + i)) };
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
// a parameter download writes, where a colour keeps the device's own bits (the absolute image path encodes none).
export function parameterMemoryBytes(app: AppConfig, segId: string, size: number, opts: { moduleInstances?: ModuleInstance[]; colorWidth?: boolean } = {}): boolean[] | null {
  const model = toAppModel(app, { includeUnions: true, instances: opts.moduleInstances ?? [] });
  const covered = new Array<boolean>(size).fill(false);
  for (const p of model.params.values()) {
    if (p.codeSegment !== segId || p.offset === undefined) continue;
    const t = model.types.get(p.typeId);
    const bits = t && t.base !== "Color" && Number.isFinite(t.sizeInBit) && t.sizeInBit > 0 ? t.sizeInBit : opts.colorWidth ? colorBits(app, p.typeId) : undefined;
    if (!bits) return null;
    for (let b = 0; b < byteWidth(bits, p.bitOffset); b++) if (p.offset + b < size) covered[p.offset + b] = true;
  }
  return covered;
}
// A TypeColor declares no SizeInBit; its memory is three bytes in the RGB and the HSV space, the bytes
// ETS's image of the MDT BE-06001.02 parameter download lists for its RGBColor and HSV parameters. Other
// spaces have no width shown by a capture. The absolute image build encodes no colour, so a colour is never
// owned there.
function colorBits(app: AppConfig, typeId: string): number | undefined {
  const t = app.types.get(typeId);
  return t?.kind === "TypeColor" && (t.colorSpace === "RGB" || t.colorSpace === "HSV") ? 24 : undefined;
}

// The colour parameters with memory that a configuration activates, by ParameterRef id, with their values.
export function activeColorValues(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[]): Map<string, string> {
  return colorReadings(app, values, instances)[0];
}
// The same, one map per reading of the configuration (readingsOf).
function colorReadings(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[]): Map<string, string>[] {
  const model = toAppModel(app, { includeUnions: true, instances });
  return readingsOf(buildDeviceConfig(app, values, undefined, instances)).map((view) => {
    const out = new Map<string, string>();
    for (const [refId, v] of view.imageValues) {
      const ref = model.refs.get(refId);
      const p = ref ? model.params.get(ref.paramId) : undefined;
      if (p?.offset !== undefined && app.types.get(p.typeId)?.base === "Color") out.set(refId, v);
    }
    return out;
  });
}

// How ETS encodes a colour is shown for the RGB space on a relative segment (image.ts colorBytes): there
// the image path writes it, and `rgbWritten` says the operation's path is that one. Every other colour
// (another space, or any colour on an absolute segment, whose image path encodes none) has no encoding
// shown, and an operation that would have to write one refuses instead of leaving the device's bytes as
// they are and reporting the new colour programmed:
//  - a parameter or structural flash, when a colour in use differs from the configuration the device was
//    last programmed with, or comes into use (`base` given);
//  - a full download, and a parameter flash of a device never programmed from this project, for any colour
//    in use (`base` absent): it knows no configuration the device holds, and would leave there either the
//    segment's <Data> (a segment loaded afresh) or the unit's bytes (a segment written into the loaded
//    application), neither shown to be the colour.
export function refuseColorWrites(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[], rgbWritten: boolean, base?: { values: Map<string, string>; instances: ModuleInstance[] }): void {
  const model = toAppModel(app, { includeUnions: true, instances });
  // Written by the relative image: an RGB colour in no code segment or in the parameter segment (LSM 4).
  const encoded = (ref: string) => {
    const p = model.params.get(model.refs.get(ref)?.paramId ?? "");
    return rgbWritten && !!p && model.types.get(p.typeId)?.base === "Color"
      && (!p.codeSegment || model.segments.find((s) => s.id === p.codeSegment)?.lsm === 4);
  };
  // A colour is unchanged only where every reading of the configuration the device holds has it.
  const before = base ? colorReadings(app, base.values, base.instances) : [];
  const written = [...new Set(colorReadings(app, values, instances).flatMap((now) => [...now]
    .filter(([ref, v]) => !encoded(ref) && (!base || before.some((b) => b.get(ref)?.toUpperCase() !== v.toUpperCase()))).map(([ref]) => ref)))];
  if (!written.length) return;
  const what = base
    ? `this flash writes the device's parameters, and ${written.length} colour parameter(s) among them changed or came into use (e.g. ${written[0]})`
    : `the configuration has ${written.length} colour parameter(s) in use (e.g. ${written[0]}), which a full download, or the flash of a device never programmed from this project, writes`;
  throw new ProductError("PARAM_COLOR_UNSUPPORTED",
    `${what}; no ETS download shows how a colour of this kind is encoded in this device's memory (only an RGB colour on a relative segment is shown), so Busforge cannot write it. Refusing rather than leaving the device's colour unchanged; apply the colour with ETS`);
}

// ETS computes the parameters of a <ParameterCalculation> once one it reads holds another value than its
// default: its LRTransformation sets the RParameters from the LParameters, its RLTransformation the
// LParameters from the RParameters; at the defaults every one keeps its value. The image builders above store
// the results of every calculation Busforge runs (applyCalculations, calculations.ts). An operation that writes a
// device's parameters refuses what that leaves open:
//  - a calculation it ran, where the configuration sets a result the user can edit to another value than the
//    script computes (ETS's RLTransformation would recompute the inputs from it), or where a result with memory that
//    no active branch places takes another value than its default (no ETS download shows whether ETS writes it;
//    the LegacyPatchAlways one on a relative segment is shown);
//  - every other calculation, where a parameter on one side takes another value than in the configuration the
//    device holds, and the other side reaches the image: a parameter with memory or in a property, or one a
//    <choose> tests or an <Assign> reads or sets, which decides what else is written. For a parameter or
//    structural flash that is the configuration the device was last programmed with (`base`); for a full
//    download, the System 1 download and the parameter flash of a device never programmed from this project
//    (`base` absent), the defaults.
// A parameter's value is that of its ref the configuration places, else one stored on any of its refs, in
// each module instance.
export function refuseCalculationWrites(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[], base?: { values: Map<string, string>; instances: ModuleInstance[] }): void {
  if (!app.calculations.length) return;
  const refuse = (message: string): never => { throw new ProductError("PARAM_CALCULATION_UNSUPPORTED", `${message}; refusing rather than writing an image built from values nothing computed. Apply this change with ETS`); };
  const same = sameParamValue(app);
  const applied = applyCalculations(app, values, instances);
  const computedRuns = applied.runs.filter((r) => r.state === "computed");
  if (computedRuns.length) {
    const view = buildDeviceConfig(app, applied.values, undefined, instances);
    const placed = new Map<string, string[]>(); // per instance and Parameter id: the refs the configuration places
    for (const r of view.imageValues.keys()) { const k = paramKey(app, r); if (k !== undefined) (placed.get(k) ?? placed.set(k, []).get(k)!).push(r); }
    // A result the user can edit: a ref of it the configuration places is neither read-only nor hidden.
    const editable = (key: string) => (placed.get(key) ?? []).some((r) => { const x = resolveParamRef(app, r)!; const access = x.ref.access ?? x.param?.access; return access !== "Read" && access !== "None"; });
    const stored = (v: Map<string, string>) => { const out = new Map<string, string>(); for (const [r, x] of v) { const k = paramKey(app, r); if (k !== undefined && !out.has(k)) out.set(k, x); } return out; };
    const storedNow = stored(values), storedBefore = base ? stored(base.values) : undefined;
    // The relative-segment image holds `value` for a result no active branch places: the LegacyPatchAlways case of
    // bussard's synthetic capture, where the builder writes the computed value.
    const imageHolds = (ref: string, value: string): boolean => {
      const { param } = resolveParamRef(app, ref)!;
      const seg = app.segments.find((g) => g.id === param!.codeSegment);
      if (!param!.patchAlways || !seg || param!.offset === undefined) return false;
      let target;
      // An image Busforge refuses to build for a hidden parameter holds nothing.
      try { target = buildRelativeSegmentTarget(app, values, seg.lsm, { moduleInstances: instances, ownIdleUnionDefaults: true }); }
      catch (e) { if (e instanceof ProductError && e.code === "PARAM_HIDDEN_UNSUPPORTED") return false; throw e; }
      const model = toAppModel(app, { includeUnions: true, instances });
      const p = model.params.get(param!.id), type = p && model.types.get(p.typeId);
      if (!target || !type || !target.owned[param!.offset]) return false;
      const expected = Buffer.from(target.bytes);
      encode(expected, param!.offset, param!.bitOffset ?? 0, type, value);
      return expected.equals(target.bytes);
    };
    for (const run of computedRuns) {
      // An input differs from the configuration the device was last programmed with: a result still stored from
      // before that change is the earlier computation's, which the script replaces.
      const inputChanged = !!storedBefore && run.inputs.some((r) => { const k = paramKey(app, r)!; return !same(r, storedNow.get(k) ?? null, storedBefore.get(k) ?? null); });
      for (const [ref, value] of run.outputs) {
        const key = paramKey(app, ref)!;
        const set = storedNow.get(key);
        if (set !== undefined && !same(ref, set, value) && editable(key)) {
          const stale = inputChanged && same(ref, set, storedBefore!.get(key) ?? null);
          if (!stale) refuse(`parameter ${ref} is set to ${set} where the application's <ParameterCalculation> "${run.label}" computes ${value}, and ETS's RLTransformation would compute the calculation's inputs from it, which Busforge does not run`);
        }
        if (resolveParamRef(app, ref)!.param!.hasMemory && !placed.has(key) && !same(ref, null, value) && !imageHolds(ref, value)) {
          refuse(`the application's <ParameterCalculation> "${run.label}" computes ${value} for parameter ${ref}, which no active branch places, and no ETS download shows whether ETS writes such a result`);
        }
      }
    }
  }
  // The parameters of the calculations Busforge ran in this configuration, unless another one it did not run reads
  // or sets them too.
  const notRun = new Map<string, CalculationRun>();
  for (const r of applied.runs) if (r.state !== "computed") for (const k of r.keys) if (!notRun.has(k)) notRun.set(k, r);
  // A calculation refused whatever the configuration is keyed by its Parameter ids alone (no instance).
  const bare = (key: string) => key.replace(/^_M-\d+_MI-\d+/, "");
  const covered = new Set(computedRuns.flatMap((r) => r.keys).filter((k) => !notRun.has(k) && !notRun.has(bare(k))));
  const paramOf = (refId: string | undefined) => (refId ? resolveParamRef(app, refId)?.param?.id : undefined);
  const steering = steeringParamIds(app);
  const reaches = (refs: string[]) => refs.some((r) => { const p = resolveParamRef(app, r)?.param; return !!p && (p.hasMemory || !!p.onProperty || steering.has(p.id)); });
  const feeding = new Map<string, string>(); // Parameter id -> name of a calculation that computes the image from it
  for (const c of app.calculations) {
    for (const [side, other] of [[c.lRefs, c.rRefs], [c.rRefs, c.lRefs]]) {
      if (!reaches(other)) continue;
      for (const id of side.map(paramOf)) if (id && !feeding.has(id)) feeding.set(id, c.name || c.id);
    }
  }
  if (!feeding.size) return;
  // Per module instance and Parameter id: the ref whose value counts and that value, one map per reading of the
  // configuration (readingsOf).
  const paramValues = (v: Map<string, string>, inst: ModuleInstance[]) => readingsOf(buildDeviceConfig(app, v, undefined, inst)).map((view) => {
    const out = new Map<string, { ref: string; value: string }>();
    const take = (entries: Iterable<[string, string]>) => {
      for (const [ref, value] of entries) {
        const id = paramOf(ref);
        const key = id && feeding.has(id) ? instanceMarker(ref) + id : undefined;
        if (key && !covered.has(key) && !out.has(key)) out.set(key, { ref, value });
      }
    };
    take(view.imageValues);
    take(v);
    return out;
  });
  // Both configurations as the builders write them, with the results Busforge computes: a result one calculation
  // computes can be the input of another that Busforge does not run.
  // Every reading of the configuration against every reading of the one the device holds.
  const befores = paramValues(base ? applyCalculations(app, base.values, base.instances).values : new Map(), base?.instances ?? instances);
  for (const now of paramValues(applied.values, instances)) for (const before of befores) for (const key of new Set([...now.keys(), ...before.keys()])) {
    const is = now.get(key), was = before.get(key);
    const ref = (is ?? was)!.ref;
    if (same(ref, was?.value ?? null, is?.value ?? null)) continue;
    const run = notRun.get(key) ?? notRun.get(bare(key));
    const why = run?.state === "refused" ? `which Busforge cannot run as ETS does: ${run.reason}`
      : run ? "which ETS runs on a change of either side and Busforge only from inputs off their defaults"
      : "which Busforge does not run in a module instance the configuration does not place";
    refuse(`parameter ${ref} is ${is?.value ?? "at its default"} where ${base ? "the device was last programmed with" : "the defaults hold"} ${was?.value ?? "its default"}, and the application's <ParameterCalculation> "${run?.label ?? feeding.get(paramOf(ref)!)}" computes from it parameters that reach the device's image, ${why}`);
  }
}
