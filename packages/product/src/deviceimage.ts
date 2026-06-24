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

export function buildAbsoluteSegmentImages(
  app: AppConfig,
  values: Map<string, string>,
  opts: { lang?: string; moduleInstances?: ModuleInstance[] } = {},
): DeviceSegmentImage[] {
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

  const out: DeviceSegmentImage[] = [];
  for (const segId of targeted) {
    const seg = bySeg.get(segId)!;
    // Start from the EEPROM blank state (0xFF), then lay the manufacturer default
    // image over it. Most segments carry a full-size <Data> so the 0xFF never shows;
    // but some (e.g. Steinel M-008E) omit <Data> entirely, and there the unwritten
    // bytes are the device's erased 0xFF, not 0x00. Hardware-verified: a Data-less
    // 256-byte segment went from 256 byte diffs to 2 once initialised to 0xFF.
    const img = Buffer.alloc(seg.size, 0xff);
    seg.data.copy(img); // manufacturer default image (covers [0, data.length))
    for (const ref of model.refs.values()) {
      const param = model.params.get(ref.paramId);
      if (!param || param.codeSegment !== segId || param.offset === undefined) continue;
      const v = active.get(ref.id);
      if (v === undefined) continue; // not visible / not active: keep the <Data> default
      const type = model.types.get(param.typeId);
      if (!type || !Number.isFinite(type.sizeInBit) || type.sizeInBit === 0) continue;
      encode(img, param.offset, param.bitOffset, type, v);
    }
    out.push({ id: segId, address: seg.address, size: seg.size, bytes: img });
  }
  return out.sort((a, b) => a.address - b.address);
}
