import type { AppConfig, ModuleInstance } from "./appconfig.ts";
import { toAppModel } from "./application.ts";
import { buildDeviceConfig } from "./config.ts";
import { resolveModuleInstances } from "./modules.ts";
import { encode } from "./image.ts";

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
// docs/mv0705-spike-findings.md). Union and module-instance parameters are not yet
// placed (toAppModel drops them), so larger devices still differ in exactly those
// bytes until union/module support lands.

export interface DeviceSegmentImage { id: string; address: number; size: number; bytes: Buffer; }

// Like DeviceSegmentImage, but also reports which bytes the image OWNS, i.e. bytes
// whose value was positively derived from an active (visible/resolved) parameter.
// The remaining bytes are modelled (manufacturer <Data> default, the zero-init of a
// Data-less segment's parameter regions, or erased-EEPROM gaps) so the whole image
// can be COMPARED against a device read-back, but the model is not authoritative for
// them: a Data-less segment cannot reconstruct ETS's precomputed non-zero defaults
// (see the M-008E 4-byte residual in docs/mv0705-spike-findings.md). The flash path
// must only WRITE owned bytes; see planAbsoluteSegmentFlash.
export interface DeviceSegmentTarget extends DeviceSegmentImage { owned: boolean[]; }

export function buildAbsoluteSegmentImages(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[] } = {},
): DeviceSegmentImage[] {
  return buildAbsoluteSegmentTargets(app, values, opts).map(({ id, address, size, bytes }) => ({ id, address, size, bytes }));
}

export function buildAbsoluteSegmentTargets(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[] } = {},
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
        const bytes = t && t.sizeInBit >= 8 ? t.sizeInBit >> 3 : 1;
        for (let b = 0; b < bytes && p.offset + b < seg.size; b++) img[p.offset + b] = 0;
      }
    }
    const owned = new Array<boolean>(seg.size).fill(false);
    for (const ref of model.refs.values()) {
      const param = model.params.get(ref.paramId);
      if (!param || param.codeSegment !== segId || param.offset === undefined) continue;
      const v = active.get(ref.id);
      if (v === undefined) continue; // not visible / not active: keep the <Data> default
      const type = model.types.get(param.typeId);
      if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
      // Only mark bytes owned if encode ACTUALLY wrote them. A text/time/color/other
      // type (or a malformed value) writes nothing, so it must not claim authority over
      // its bytes: the flash path would otherwise push the segment's init/default value
      // over device memory the parameter never derived. Gating on the real write keeps
      // ownership exactly symmetric with the image, with no duplicated type gate.
      const wrote = encode(img, param.offset, param.bitOffset, type, v);
      if (!wrote) continue;
      // This parameter's value is authoritative: mark its byte(s) owned so the flash
      // path may write them. A sub-byte parameter owns the single byte it shares.
      const bytes = type.sizeInBit >= 8 ? type.sizeInBit >> 3 : 1;
      for (let b = 0; b < bytes && param.offset + b < seg.size; b++) owned[param.offset + b] = true;
    }
    out.push({ id: segId, address: seg.address, size: seg.size, bytes: img, owned });
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
//    device byte. The Theben channel devices' "Objektlink" unions are Access="None"
//    Value="0" placeholders whose real content ETS computes from the channel/link
//    allocation: they are never active in our resolver, so they stay UNOWNED and the
//    flash preserves the device's computed table rather than zeroing it.
//  - LegacyPatchAlways params: dropped by toAppModel, so never owned (ETS patches them).
// Ownership is gated on encode() ACTUALLY writing, exactly like the absolute path, so a
// text/time/malformed value claims no bytes.
export interface RelativeSegmentTarget { lsm: number; size: number; bytes: Buffer; owned: boolean[]; }

export function buildRelativeSegmentTarget(
  app: AppConfig,
  values: Map<string, string>,
  lsm: number,
  opts: { lang?: string; moduleInstances?: ModuleInstance[] } = {},
): RelativeSegmentTarget | null {
  const instances = opts.moduleInstances?.length ? opts.moduleInstances : (app.hasModules ? resolveModuleInstances(app, values) : []);
  const model = toAppModel(app, { includeUnions: true, instances });
  const seg = model.segments.find((s) => s.lsm === lsm);
  if (!seg) return null;
  const active = buildDeviceConfig(app, values, opts.lang, instances).imageValues;

  const img = Buffer.alloc(seg.size);
  seg.data.copy(img); // manufacturer default image (overwritten where owned)
  const owned = new Array<boolean>(seg.size).fill(false);

  for (const ref of model.refs.values()) {
    const param = model.params.get(ref.paramId);
    if (!param || param.offset === undefined) continue;
    if (param.codeSegment && model.segments.find((s) => s.id === param.codeSegment)?.lsm !== lsm) continue;
    const cfgParam = app.params.get(ref.paramId);
    // Value source / ownership, in priority order:
    //  - union member / module-instance param: own only when ACTIVE (overlap-safe).
    //  - any active param: own, use its resolved value.
    //  - inactive plain param that is user-facing (Access != None): own at its default;
    //    System B writes every such default and the device holds it (PSU byte-match).
    //  - inactive Access="None" param: NOT owned. Its on-device value is ETS-computed
    //    (e.g. the channel "Objektlink"/count tables), which our static default does not
    //    reproduce; leave the device byte untouched. Hardware-checked on the Theben HMG
    //    (writing the default 0 over those computed bytes would corrupt the config).
    const gated = ref.id.includes("_MI-") || cfgParam?.union === true;
    let v: string | undefined;
    if (gated || active.has(ref.id)) v = active.get(ref.id);
    else if (cfgParam?.access !== "None") v = values.get(ref.id) ?? param.value;
    if (v === undefined) continue;
    const type = model.types.get(param.typeId);
    if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
    if (!encode(img, param.offset, param.bitOffset, type, v)) continue;
    const bytes = type.sizeInBit >= 8 ? type.sizeInBit >> 3 : 1;
    for (let b = 0; b < bytes && param.offset + b < seg.size; b++) owned[param.offset + b] = true;
  }
  return { lsm, size: seg.size, bytes: img, owned };
}

// Merge a surgical relative target onto the live segment for a System B download: write
// ONLY owned bytes, carry every unowned byte over from the device read. Returns the full
// image to flash (the protocol rewrites the whole segment after realloc) and the count of
// bytes that differ from `current` (== owned bytes we are actually changing; 0 means a
// no-op reconfiguration). `current` is the device read, guaranteed `target.size` long.
export function mergeRelativeTarget(current: Buffer, target: RelativeSegmentTarget): { image: Buffer; diffBytes: number } {
  const image = Buffer.from(current);
  let diffBytes = 0;
  for (let i = 0; i < target.size; i++) {
    if (target.owned[i]) image[i] = target.bytes[i];
    if (image[i] !== current[i]) diffBytes++;
  }
  return { image, diffBytes };
}

// Verify a relative flash by comparing ONLY owned bytes against the intended values. The
// unowned bytes are not under our authority: a System B reload can recompute them on the
// device (the channel "Objektlink" tables), so a full-buffer equality check would report a
// correct flash as failed. Mirrors the absolute path's owned-only verify.
export function verifyRelativeOwned(back: Buffer, target: RelativeSegmentTarget): boolean {
  for (let i = 0; i < target.size; i++) if (target.owned[i] && back[i] !== target.bytes[i]) return false;
  return true;
}
