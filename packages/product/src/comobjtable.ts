// Com-object table (L3) staleness detection.
//
// THE PROBLEM THIS EXISTS FOR. The parameter flash writes the parameter segment (L4) and keeps the
// device's com-object table; the group-address flash rewrites L3 only for the link-driven flags of the
// object set the device already has. L3 holds each com-object's flags and datapoint size, compiled for
// the parameter set the device was last programmed with.
//
// So when a parameter changes which com-objects exist, or their flags or size, neither flash can write
// it: the device would be left holding an L3 for the OLD configuration while busforge reports a
// successful flash. On a multi-channel device (a presence detector, a channel actuator) that is not an
// edge case: it is what enabling or disabling a channel does. The device would then silently behave
// unlike what the UI shows, which is the most expensive failure class this tool can have.
//
// Such a change is written by the structural flash (DeviceProfile.flashStructure), which authors L3
// with the parameters and group tables in one bracket, or by a full download. The two flashes refuse
// it here, and say exactly what would have gone stale; the server routes the change before it gets
// this far (deviceops.ts comObjectTableGuard).
//
// WHAT IT COMPARES, AND WHY NOT THE DEVICE. The obvious detector (decode the device's own
// parameter image and compare the com-object table it implies) does not work, and knowing why
// is the whole design: the parameters that decide a channel's existence frequently have NO
// memory offset at all. The Theben 493B's channel-active parameter (P-57) is one; it lives
// only in the project, and the device's com-object table is the sole record of it. Such a
// parameter is unobservable on the bus, so a device-image detector would be blind to exactly
// the change that matters most, while looking like a safety net.
//
// The sound comparison point is the PROGRAMMED BASELINE (device_param_base): the parameter set
// the device was last programmed with (ETS's values at import, our own after a flash). That is
// by definition the configuration its L3 was compiled for. The induction holds because this
// gate only ever lets com-object-neutral flashes through, and the structural flash and the full
// download author L3 for exactly the parameters they adopt, so a baseline advanced by busforge
// never invalidates the L3 the device holds. The read-back keeps it honest from the other side: it
// re-baselines only refs the device's image actually encodes (see foldDeviceValues), so an
// unflashed edit to an unobservable parameter cannot launder itself into the baseline.
//
// This needs no knowledge of L3's on-device byte layout (which differs per family and is only
// reverse-engineered for MV-0705): both sides come from the application model, so it works on
// every family the config engine understands.
import { buildDeviceConfig, type CfgComObjImage } from "./config.ts";
import { resolveModuleInstances } from "./modules.ts";
import { ProductError } from "./errors.ts";
import type { AppConfig, ComObjFlags, ModuleInstance } from "./appconfig.ts";

export interface ComObjTableChange {
  number: number;
  was?: CfgComObjImage; // absent: the object is newly activated
  now?: CfgComObjImage; // absent: the object is deactivated
  fields: string[];     // what differs: "added" | "removed" | "size" | "flag:<name>"
}

const FLAG_KEYS = ["comm", "read", "write", "transmit", "update", "readOnInit"] as const;

const flagDiff = (a: ComObjFlags, b: ComObjFlags): string[] =>
  FLAG_KEYS.filter((k) => Boolean(a[k]) !== Boolean(b[k])).map((k) => `flag:${k}`);

// The com-object table a parameter set implies: every com-object reached in the active dynamic
// tree (including hidden Access="None" blocks and per-instance module objects), keyed by
// resolved object number, carrying its resolved size and flags. This is the same projection
// docs/device-memory-model.md validated the MV-0705 L3 build against.
//
// `instances`: provided ones win, exactly as everywhere else in this package (an imported
// device's 0.xml module instances are authoritative), and they are what the flash itself places
// its bytes with. Re-deriving them here instead would compare a table the device was never
// programmed against, and would throw MODULE_ARG_UNRESOLVED on a device whose project-supplied
// instances flash fine.
export function comObjectTable(app: AppConfig, params: Map<string, string>, instances: ModuleInstance[] = []): Map<number, CfgComObjImage> {
  const inst = instances.length || !app.hasModules ? instances : resolveModuleInstances(app, params);
  return buildDeviceConfig(app, params, undefined, inst).imageComObjects;
}

// Compare two implied com-object tables. Both sides are derived the SAME way (comObjectTable),
// so identical parameter sets provably produce identical tables: a non-empty result is always a
// real configuration difference, never a projection artefact.
export function diffComObjectTables(was: Map<number, CfgComObjImage>, now: Map<number, CfgComObjImage>): ComObjTableChange[] {
  const changes: ComObjTableChange[] = [];
  for (const [number, w] of was) {
    const n = now.get(number);
    if (!n) { changes.push({ number, was: w, fields: ["removed"] }); continue; }
    const fields = flagDiff(w.flags, n.flags);
    if (w.objectSize !== n.objectSize) fields.unshift("size");
    if (fields.length) changes.push({ number, was: w, now: n, fields });
  }
  for (const [number, n] of now) if (!was.has(number)) changes.push({ number, now: n, fields: ["added"] });
  return changes.sort((a, b) => a.number - b.number);
}

// The com-object table changes a reconfiguration implies, relative to the programmed baseline:
// empty iff the device's kept-from-device L3 stays valid for the new parameters. Both the flash
// gate below (assertComObjectTableStable) and the route's promote-to-full-download decision are
// built on this one predicate, so they can never disagree about what "stale" means.
export function comObjectTableChanges(
  app: AppConfig,
  baseParams: Map<string, string>,
  newParams: Map<string, string>,
  instances: ModuleInstance[] = [],
): ComObjTableChange[] {
  return diffComObjectTables(comObjectTable(app, baseParams, instances), comObjectTable(app, newParams, instances));
}

// Refuse a write whose configuration implies a different com-object table than the one the device
// was last programmed with. Runs before any bus write, on BOTH the parameter flash and the group-
// address flash: the parameter flash would leave the stale table behind its new parameters, and
// the GA flash would point associations at object numbers that table does not configure. Same
// staleness, same refusal. This is the profile-layer last line: the route sends the change to the
// structural flash or the full download before it reaches here (see deviceops.ts), so a caller that
// reaches this throw is a family that can do neither, or a direct product-layer/test caller.
export function assertComObjectTableStable(
  app: AppConfig,
  baseParams: Map<string, string>,
  newParams: Map<string, string>,
  instances: ModuleInstance[] = [],
): void {
  const changes = comObjectTableChanges(app, baseParams, newParams, instances);
  if (!changes.length) return;
  const shown = changes.slice(0, 5).map((c) => `#${c.number} (${c.fields.join(", ")})`).join(", ");
  const more = changes.length > 5 ? `, and ${changes.length - 5} more` : "";
  throw new ProductError("COM_OBJECT_TABLE_STALE",
    `these parameters change the device's communication objects (${shown}${more}), which requires rewriting its com-object table. This flash keeps that table, so writing would leave the device with the old objects while reporting success; a structural flash or a full download writes it. Refusing.`);
}
