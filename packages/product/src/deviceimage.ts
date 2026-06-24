import type { AppConfig, ModuleInstance } from "./appconfig.ts";
import { toAppModel } from "./application.ts";
import { buildDeviceConfig } from "./config.ts";
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
  const model = toAppModel(app, { includeUnions: true });
  // Effective value of every parameter reached in the active dynamic tree, keyed by
  // ParameterRef id. This includes Access="None" internal parameters that ETS writes
  // to memory but hides from the UI, so it is the right source for the image (the
  // visible blocks alone would miss them).
  const view = buildDeviceConfig(app, values, opts.lang, opts.moduleInstances ?? []);
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
