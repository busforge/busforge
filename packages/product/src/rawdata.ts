import { sameParamValue, type AppConfig, type ModuleInstance } from "./appconfig.ts";
import { toAppModel } from "./application.ts";
import { buildDeviceConfig, readingsOf } from "./config.ts";
import { paramKey } from "./calculations.ts";
import { ProductError } from "./errors.ts";

// A TypeRawData parameter has no byte layout an ETS download has shown, so no image writes one: the segment's
// <Data> or the unit's bytes stay where it lies. An operation that writes a device's parameters therefore
// refuses where a raw-data parameter with memory that the configuration activates holds a value nothing shows the
// device to hold:
//  - a parameter or structural flash: another value than in the configuration the device was last programmed
//    with (`base`), or than its default where that configuration did not activate it, compared per parameter of
//    each module instance whichever of its ParameterRefs places it;
//  - a full download, and the System 1 download (`base` absent): another value than its default;
//  - the parameter flash of a device never programmed from this project (`base` "unknown"): any value, as the
//    flash keeps the bytes the device holds there, which nothing has shown.
export function refuseRawDataWrites(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[], base?: { values: Map<string, string>; instances: ModuleInstance[] } | "unknown"): void {
  if (![...app.types.values()].some((t) => t.kind === "TypeRawData")) return;
  // One map per reading of the configuration (readingsOf).
  const rawValues = (vals: Map<string, string>, inst: ModuleInstance[]) => {
    const model = toAppModel(app, { includeUnions: true, instances: inst });
    return readingsOf(buildDeviceConfig(app, vals, undefined, inst)).map((view) => {
      const out = new Map<string, { ref: string; value: string }>();
      for (const [refId, value] of view.imageValues) {
        const ref = model.refs.get(refId);
        const p = ref ? model.params.get(ref.paramId) : undefined;
        const key = paramKey(app, refId);
        if (key !== undefined && p?.offset !== undefined && app.types.get(p.typeId)?.kind === "TypeRawData") out.set(key, { ref: refId, value });
      }
      return out;
    });
  };
  const same = sameParamValue(app);
  const now = rawValues(values, instances).flatMap((m) => [...m]);
  if (base === "unknown") {
    if (!now.length) return;
    throw new ProductError("PARAM_RAW_DATA_UNSUPPORTED",
      `this flash writes the parameters of a device never programmed from this project, and ${now.length} raw-data parameter(s) are in use (e.g. ${now[0][1].ref}); no ETS download shows how a TypeRawData value is laid out in a device's memory, so the flash would keep the device's bytes there, which nothing has shown to hold the value. Refusing; apply the value with ETS`);
  }
  // A value is unchanged only where every reading of the configuration the device holds has it.
  const befores = base ? rawValues(base.values, base.instances) : [new Map<string, { ref: string; value: string }>()];
  const written = [...new Set(now.filter(([key, { ref, value }]) => befores.some((before) => !same(ref, before.get(key)?.value ?? null, value))).map(([, { ref }]) => ref))];
  if (!written.length) return;
  const what = base
    ? `this flash writes the device's parameters, and ${written.length} raw-data parameter(s) among them changed (e.g. ${written[0]})`
    : `the configuration has ${written.length} raw-data parameter(s) away from their default (e.g. ${written[0]}), which a full download writes`;
  throw new ProductError("PARAM_RAW_DATA_UNSUPPORTED",
    `${what}; no ETS download shows how a TypeRawData value is laid out in a device's memory, so Busforge cannot write it. Refusing rather than leaving the device's bytes as they are; apply the value with ETS`);
}
