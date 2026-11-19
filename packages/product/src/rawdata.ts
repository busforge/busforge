import { sameParamValue, type AppConfig, type ModuleInstance } from "./appconfig.ts";
import { toAppModel } from "./application.ts";
import { buildDeviceConfig } from "./config.ts";
import { paramKey } from "./calculations.ts";
import { ProductError } from "./errors.ts";

// A TypeRawData parameter has no byte layout an ETS download has shown, so no image writes one: the segment's
// <Data> or the unit's bytes stay where it lies. An operation that writes a device's parameters therefore
// refuses where a raw-data parameter with memory that the configuration activates holds another value:
//  - a parameter or structural flash: another value than in the configuration the device was last programmed
//    with (`base`), or than its default where that configuration did not activate it, compared per parameter of
//    each module instance whichever of its ParameterRefs places it;
//  - a full download, the System 1 download and the parameter flash of a device never programmed from this
//    project (`base` absent): another value than its default.
export function refuseRawDataWrites(app: AppConfig, values: Map<string, string>, instances: ModuleInstance[], base?: { values: Map<string, string>; instances: ModuleInstance[] }): void {
  if (![...app.types.values()].some((t) => t.kind === "TypeRawData")) return;
  const rawValues = (vals: Map<string, string>, inst: ModuleInstance[]) => {
    const model = toAppModel(app, { includeUnions: true, instances: inst });
    const out = new Map<string, { ref: string; value: string }>();
    for (const [refId, value] of buildDeviceConfig(app, vals, undefined, inst).imageValues) {
      const ref = model.refs.get(refId);
      const p = ref ? model.params.get(ref.paramId) : undefined;
      const key = paramKey(app, refId);
      if (key !== undefined && p?.offset !== undefined && app.types.get(p.typeId)?.kind === "TypeRawData") out.set(key, { ref: refId, value });
    }
    return out;
  };
  const same = sameParamValue(app);
  const before = base ? rawValues(base.values, base.instances) : new Map<string, { ref: string; value: string }>();
  const written = [...rawValues(values, instances)].filter(([key, { ref, value }]) => !same(ref, before.get(key)?.value ?? null, value)).map(([, { ref }]) => ref);
  if (!written.length) return;
  const what = base
    ? `this flash writes the device's parameters, and ${written.length} raw-data parameter(s) among them changed (e.g. ${written[0]})`
    : `the configuration has ${written.length} raw-data parameter(s) away from their default (e.g. ${written[0]}), which a full download, or the flash of a device never programmed from this project, writes`;
  throw new ProductError("PARAM_RAW_DATA_UNSUPPORTED",
    `${what}; no ETS download shows how a TypeRawData value is laid out in a device's memory, so Busforge cannot write it. Refusing rather than leaving the device's bytes as they are; apply the value with ETS`);
}
