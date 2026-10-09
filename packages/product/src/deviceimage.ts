import type { AppConfig, ModuleInstance } from "./appconfig.ts";
import { toAppModel } from "./application.ts";
import { buildDeviceConfig } from "./config.ts";
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
export interface DeviceSegmentTarget extends DeviceSegmentImage { owned: number[]; verify: number[]; }

export function buildAbsoluteSegmentImages(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; textRefusals?: TextRefusals } = {},
): DeviceSegmentImage[] {
  return buildAbsoluteSegmentTargets(app, values, opts).map(({ id, address, size, bytes }) => ({ id, address, size, bytes }));
}

export function buildAbsoluteSegmentTargets(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[]; textRefusals?: TextRefusals } = {},
): DeviceSegmentTarget[] {
  // Module instances: the imported project's set when given, else re-run the allocators
  // for a from-scratch device so its channel parameters are placed at the same offsets
  // ETS would compute. Threaded into BOTH the image model (to materialise the per-instance
  // params) and the config view (to resolve which of them are active).
  const instances = opts.moduleInstances?.length ? opts.moduleInstances : (app.hasModules ? resolveModuleInstances(app, values) : []);
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
    }
    out.push({ id: segId, address: seg.address, size: seg.size, bytes: img, owned, verify });
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
//    (MDT BE-02001.02 captures; the Theben MIX house devices hold the values, not <Data>).
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
// `defaulted`: inactive parameters written at their default although the values hold another value for them.
export interface RelativeSegmentTarget { lsm: number; size: number; bytes: Buffer; owned: number[]; verify: number[]; markers: number[]; defaulted: Set<string>; }

export function buildRelativeSegmentTarget(
  app: AppConfig,
  values: Map<string, string>,
  lsm: number,
  // ownIdleUnionDefaults: own the DefaultUnionParameter member of every union with no active member,
  // as ETS writes it in both its full and its parameter download (GVS AMMA captures, 2026-09-25/26).
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
    //    capture, 2026-09-25: every disabled channel's unions, byte for byte), under the same
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
  }
  return { lsm, size: seg.size, bytes: img, owned, verify, markers, defaulted };
}

// Merge a surgical relative target onto the live segment for a System B download: write
// ONLY owned bytes, carry every unowned byte over from the device read. Returns the full
// image to flash (the bytes a download may write or keep) and the count of
// bytes that differ from `current` (== owned bytes we are actually changing; 0 means a
// no-op reconfiguration). `current` is the device read, guaranteed `target.size` long.
export function mergeRelativeTarget(current: Buffer, target: RelativeSegmentTarget): { image: Buffer; diffBytes: number } {
  const image = Buffer.from(current);
  let diffBytes = 0;
  for (let i = 0; i < target.size; i++) {
    image[i] = mergeOwnedBits(current[i], target.bytes[i], target.owned[i]);
    if (image[i] !== current[i]) diffBytes++;
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
// - it reads there what it read before the operation (`before`), the write made no difference to
//   what it returns;
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
      if (w !== undefined && before && ((before[i] ^ want[i]) & m)) landed = true;
      continue;
    }
    if (w === undefined || ((w ^ want[i]) & m) || !before || before.length <= i || back[i] !== before[i]) return null;
    only.push(at + i);
  }
  if (only.length && !landed) return null;
  const runs: ConfirmedOnlyRange[] = [];
  for (const a of only) {
    const last = runs.at(-1);
    if (last && last.address + last.length === a) last.length++;
    else runs.push({ address: a, length: 1 });
  }
  return runs;
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
export function parameterMemoryBytes(app: AppConfig, segId: string, size: number, opts: { moduleInstances?: ModuleInstance[] } = {}): boolean[] | null {
  const model = toAppModel(app, { includeUnions: true, instances: opts.moduleInstances ?? [] });
  const covered = new Array<boolean>(size).fill(false);
  for (const p of model.params.values()) {
    if (p.codeSegment !== segId || p.offset === undefined) continue;
    const t = model.types.get(p.typeId);
    if (!t || !Number.isFinite(t.sizeInBit) || t.sizeInBit <= 0) return null;
    for (let b = 0; b < byteWidth(t.sizeInBit, p.bitOffset); b++) if (p.offset + b < size) covered[p.offset + b] = true;
  }
  return covered;
}
