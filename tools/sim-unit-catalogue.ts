// A simulated unit for a catalogue row of the ETS sweep whose application has no own unit: the unit of a donor, an own
// unit of the application's mask (tools/sim-units.ts), with what the application's product gives put over it, and what
// ETS required of it in an earlier run (the identity loop, tools/sim-unit-product.ts) put over that.
//
// From the product: the mask (the donor's must be the application's), the manufacturer (0/12), the application's
// program id (PID 13 of the application object, ETS's LdCtrlWriteProp and task segments carry it), every bit its
// LdCtrlCompareProp steps expect, and on System 7 the PEI type of its task segments. From the identity loop: each
// value an ETS6.log `Required data mismatch` line required. From the donor: everything else, as its collection and
// its captures show it (its serial, order info, hardware type where nothing above names one, descriptions, segment
// places, load states, restart, link timing). What neither gives is refused, never filled in: a property the product
// gives only some bits of and the donor never showed, a value longer than the donor's element, a segment the donor
// places nowhere (the simulator refuses it when it comes). Every answer carries its source in the simulator's log
// (tools/sim-unit.ts AnswerSources).
//
// The donor is chosen by one rule per mask (DONOR_RULES), never per product, from the own units there are: one that
// cannot show what a download of the application needs of its unit does not qualify, and of those that do the one
// whose captures leave the fewest of its answers unshown is taken.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { declaredPropMatches, MM_STATUS_BASE } from "../packages/knx/src/index.ts";
import { declaredPropChecks, maskInfo, parseAppConfig, programIdStamp, type CollectPackage } from "../packages/product/src/index.ts";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { SimUnit, type AnswerSources, type SimProperty, type SimUnitCoreModel } from "./sim-unit.ts";
import { simUnitModel } from "./sim-unit-model.ts";
import { SimUnit0701, simUnit0701Model, type AdditionalControl } from "./sim-unit-0701.ts";
import { SimUnit0705, simUnit0705Model } from "./sim-unit-0705.ts";
import { productUnit, rerunIdentity, type IdentityValue, type Mismatch, type ProductUnit } from "./sim-unit-product.ts";
import { newSimUnit, SIM_UNITS, type SimUnitSpec } from "./sim-units.ts";

// A catalogue row's unit: the application, the donor, the rule that chose it, and the ETS6.log lines the identity
// loop learned from, in the order it took them.
export interface CatalogueUnitSpec {
  id: string;
  name: string;
  application: string;
  // The application program's XML (its manufacturer document): a catalogue row's comes from the row's own export,
  // not from the corpus's catalogue/ (tools/ets-sweep.ts).
  appXml: string;
  // The donor's interface: the simulator's, which ETS and Busforge reach the unit through.
  interfaceIa: number;
  interfaceMaxApdu: number;
  donor: SimUnitSpec;
  rule: string;
  learned: string[];
}

// The unit of a sweep row: an own unit, or a catalogue unit.
export type RowUnit = SimUnitSpec | CatalogueUnitSpec;
export const isCatalogueUnit = (u: RowUnit): u is CatalogueUnitSpec => "donor" in u;
// The application program a row's unit runs: an own unit's from the corpus's catalogue/, a catalogue unit's its own.
export const unitAppXml = (u: RowUnit): string => (isCatalogueUnit(u) ? u.appXml : catalogueXml(u.catalogue));

// How a row's row.json names a catalogue unit: its donor, the rule, the identity loop's lines, and the source of
// each property the unit answers otherwise than its donor or with the product's or the loop's value; `donorDigest` what
// the donor was (donorDigest).
export interface CatalogueUnitRecord { source: "donor"; donor: string; donorDigest: string; rule: string; identity: string[]; properties: Record<string, string> }

const MASKS = ["MV-07B0", "MV-0701", "MV-0705"] as const;
type Mask = (typeof MASKS)[number];

// The mask of an own unit: the one its model takes (tools/sim-unit-model.ts takes MV-07B0 only, the memory-mapped
// model MV-0701, the property-mapped one MV-0705).
export const unitMask = (u: SimUnitSpec): Mask => (u.memoryMapped ? "MV-0701" : u.propertyMapped ? "MV-0705" : "MV-07B0");

const COMMON_RULE = "an own unit of the mask whose application leaves its memory as written after a restart (another application's would not) and whose captures show its answer to each restart a download of the application ends with; of those, the one whose captures leave the fewest of its answers unshown, then one collected in the state its captures show, then by id";
// The rule per mask. MV-07B0 asks besides for A_MemoryExtended_Write where the application declares extended memory
// services, MV-0701 for the additional load controls the application declares, which its units take or refuse as
// their captures show.
export const DONOR_RULES: Record<Mask, string> = {
  "MV-07B0": `MV-07B0: ${COMMON_RULE}; and whose captures show A_MemoryExtended_Write where the application declares extended memory services`,
  "MV-0701": `MV-0701: ${COMMON_RULE}; and that takes every additional load control the application declares`,
  "MV-0705": `MV-0705: ${COMMON_RULE}`,
};

const ADDITIONAL_VERBS: Record<string, AdditionalControl> = { LdCtrlAbsSegment: "absolute-segment", LdCtrlTaskSegment: "task-segment", LdCtrlTaskCtrl1: "task-control-1" };

type AppConfig = ReturnType<typeof parseAppConfig>;
type Needs = { basic: boolean; confirmed: boolean; extendedWrite: boolean; additional: AdditionalControl[] };

// What a download of the application needs of its unit beyond the mask: a basic restart at its end (System 7's
// LdCtrlRestart; a System B download without Data Secure, whose closing ETS takes from the mask), a confirmed restart
// (a System B download with Data Secure, as ETS's downloads of the Theben MIX 2, the Jung 400021SE and the GVS AMMA
// show; a declared LdCtrlMasterReset), A_MemoryExtended_Write (a System B application with extended memory services,
// whose memory ETS writes so: packages/product/src/loadproc.ts), the additional load controls it declares on MV-0701.
function needs(cfg: AppConfig): Needs {
  const proc = cfg.loadProcedures;
  const systemB = cfg.mask === "MV-07B0";
  return {
    basic: systemB ? !proc.secureEnabled : proc.verbs.includes("LdCtrlRestart"),
    confirmed: (systemB && proc.secureEnabled) || proc.verbs.includes("LdCtrlMasterReset"),
    extendedWrite: systemB && proc.extendedMemoryServices,
    additional: cfg.mask === "MV-0701" ? [...new Set(proc.verbs.flatMap((v) => (ADDITIONAL_VERBS[v] ? [ADDITIONAL_VERBS[v]] : [])))] : [],
  };
}

// Why `u` cannot be the donor of a download with these needs, or null.
function unfit(u: SimUnitSpec, need: Needs): string | null {
  const b = u.behaviour;
  if (!u.memoryMapped && !u.propertyMapped && "clearsAfterRestart" in b && b.clearsAfterRestart.length) return "its application changes its memory after a restart";
  if (u.memoryMapped && u.memoryMapped.clearedByRestart.size) return "its application changes its memory after a restart";
  if (need.basic && b.restart.basic === null) return "its captures show no basic restart";
  if (need.confirmed && b.restart.confirmedRestartSeconds === null) return "its captures show no confirmed restart";
  if (need.extendedWrite && !b.memoryExtendedWrite) return "its captures show no A_MemoryExtended_Write";
  const missing = need.additional.filter((a) => !u.memoryMapped?.additional.includes(a));
  if (missing.length) return `its captures show no ${missing.join(", ")}`;
  return null;
}

// Why the own unit `u` cannot be a donor for `appXml` (of its mask), or null where it can.
export const donorUnfit = (u: SimUnitSpec, appXml: string): string | null => unfit(u, needs(parseAppConfig(appXml)));

// How many of its answers the unit's captures leave unshown.
function unshown(u: SimUnitSpec): number {
  const b = u.behaviour;
  const stops = u.propertyMapped ? u.propertyMapped.unloadStopsApplication : u.memoryMapped ? undefined : "unloadStopsApplication" in b ? b.unloadStopsApplication : undefined;
  return [b.restart.basic, b.restart.deadConnection, b.restart.confirmedRestartSeconds, b.programmingMode, b.serialNumberResponseTail, b.descriptionIndex, stops].filter((x) => x === null).length;
}
const collectedInAnotherState = (u: SimUnitSpec) => "stateInCaptures" in u.behaviour && u.behaviour.stateInCaptures !== undefined;

export type DonorChoice = { donor: SimUnitSpec; rule: string } | { refused: string };

// The donor of `appXml` by the rule of its mask, among `units`.
export function chooseDonor(appXml: string, units: readonly SimUnitSpec[] = SIM_UNITS): DonorChoice {
  return chooseDonorFor(parseAppConfig(appXml), units);
}
function chooseDonorFor(cfg: AppConfig, units: readonly SimUnitSpec[]): DonorChoice {
  const mask = cfg.mask;
  if (!(MASKS as readonly string[]).includes(mask)) return { refused: `no donor for ${mask}: no rule for it, the simulator models ${MASKS.join(", ")}` };
  const need = needs(cfg);
  const same = units.filter((u) => unitMask(u) === mask);
  const why = same.map((u) => ({ u, why: unfit(u, need) }));
  const fit = why.filter((x) => x.why === null).map((x) => x.u);
  if (fit.length === 0) return { refused: `no donor for ${mask}: ${same.length ? why.map((x) => `${x.u.id}: ${x.why}`).join("; ") : "no own unit of the mask"}` };
  const [donor] = fit.sort((a, b) => unshown(a) - unshown(b) || Number(collectedInAnotherState(a)) - Number(collectedInAnotherState(b)) || a.id.localeCompare(b.id));
  return { donor, rule: DONOR_RULES[mask as Mask] };
}

// The catalogue unit of `application` (an application program id), whose program `appXml` holds: the donor the rule
// picks, or the one named (a row's, which must still fit the rule's needs); with the identity loop's lines in the
// order it took them. Refused for an application that has an own unit (its rows take that) and where no donor fits.
export function catalogueUnitSpec(application: string, appXml: string, opts: { donor?: string; learned?: string[]; units?: readonly SimUnitSpec[] } = {}): CatalogueUnitSpec | { refused: string } {
  const units = opts.units ?? SIM_UNITS;
  const own = units.find((u) => u.catalogue === `${application}.xml.gz`);
  if (own) return { refused: `${application} has its own unit ${own.id}` };
  const cfg = parseAppConfig(appXml);
  if (cfg.id !== application) return { refused: `the application program given is ${cfg.id}, not ${application}` };
  let choice: DonorChoice;
  if (opts.donor === undefined) choice = chooseDonorFor(cfg, units);
  else {
    const named = units.find((u) => u.id === opts.donor);
    if (!named) return { refused: `no own unit ${opts.donor} to borrow` };
    if (unitMask(named) !== cfg.mask) return { refused: `the donor ${named.id} is of ${unitMask(named)}, the application of ${cfg.mask}` };
    const why = unfit(named, needs(cfg));
    if (why) return { refused: `the donor ${named.id} does not fit the rule: ${why}` };
    choice = { donor: named, rule: DONOR_RULES[cfg.mask as Mask] };
  }
  if ("refused" in choice) return choice;
  const { donor, rule } = choice;
  return { id: `${application}@${donor.id}`, name: `${application} (catalogue unit on ${donor.name})`, application, appXml, interfaceIa: donor.interfaceIa, interfaceMaxApdu: donor.interfaceMaxApdu, donor, rule, learned: opts.learned ?? [] };
}

const hex = (b: Buffer) => b.toString("hex");
const PID_PROGRAM_ID = 13;

// The identity the product gives: productUnit's, with the application's program id on its application object.
function productIdentity(appXml: string): ProductUnit {
  const refuse = (why: string): never => { throw new Error(`no catalogue unit: ${why}`); };
  const unit = productUnit(appXml);
  const cfg = parseAppConfig(appXml);
  const key = `${maskInfo(cfg.mask).family === "system-b" ? 4 : 3}/${PID_PROGRAM_ID}`;
  const id = programIdStamp(cfg);
  const had = unit.properties.get(key);
  // A compare on the program id (the ABB US/U 4.2's on its application number) must hold on the application's own.
  if (had && Array.from(had.bytes).some((b, i) => i >= id.length ? (b & had.known[i]) !== 0 : (b & had.known[i]) !== (id[i] & had.known[i]))) refuse(`the application's program id ${hex(id)} does not pass its own compare of ${key} (${hex(had.bytes)})`);
  const properties = new Map(unit.properties);
  properties.set(key, { bytes: id, known: Buffer.alloc(id.length, 0xff), sources: [...(had?.sources ?? []), { from: "product", what: `the application's program id ${hex(id)}` }] });
  return { ...unit, properties };
}

const keyParts = (key: string) => key.split("/").map(Number) as [number, number];
// What a unit holding `objects` answers as a property's first element; empty where it answers none.
const answered = (objects: Objects) => (key: string) => { const [o, pid] = keyParts(key); return Buffer.from(objects.get(o)?.get(pid)?.elements?.[0] ?? []); };

const sourceOf = (v: IdentityValue) => v.sources.map((s) => (s.from === "product" ? `product: ${s.what}` : `identity loop: ETS6.log "${s.line}"`)).join("; ");

type SimOpts = ConstructorParameters<typeof SimUnit>[2];
type Objects = SimUnitCoreModel["objects"];
// What the catalogue unit puts over its donor's model: its properties and their sources, and on System 7 the program
// id and PEI type its task segments carry, which the unit checks them against.
type Over = { objects: Objects; sources: AnswerSources; programId: Buffer; peiType: number };
type DonorModel = { core: SimUnitCoreModel; make: (over: Over, opts: SimOpts) => SimUnit; memoryAt: (a: number) => number | undefined };

// The load-state machine (1 to 15) whose state a System 7 unit answers at memory address `a`, or null.
export const loadStateMachineAt = (a: number): number | null => (a > MM_STATUS_BASE && a <= MM_STATUS_BASE + 15 ? a - MM_STATUS_BASE : null);
const PID_LOAD_STATE = 5;
// A System 7 unit's load state as memory, which its PID 5 holds at the start.
const loadStateAt = (m: SimUnitCoreModel, a: number) => { const lsm = loadStateMachineAt(a); return lsm === null ? undefined : m.objects.get(lsm)?.get(PID_LOAD_STATE)?.elements?.[0]?.[0]; };

// The donor's own unit as its model builder makes it, with how to make a simulated unit of a model of its kind.
function donorModel(donor: SimUnitSpec): DonorModel {
  const collection = JSON.parse(readFileSync(corpusPath(donor.collection), "utf8")) as CollectPackage;
  const xml = catalogueXml(donor.catalogue);
  const opts = (o: SimOpts): SimOpts => ({ interfaceMaxApdu: donor.interfaceMaxApdu, ...o });
  if (donor.propertyMapped) {
    const m = simUnit0705Model(collection, xml, donor.behaviour, donor.propertyMapped);
    const make = ({ objects, sources, programId, peiType }: Over, o: SimOpts) => new SimUnit0705({ ...m, objects, sources, programId, propertyMapped: { ...m.propertyMapped, peiType } }, donor.interfaceIa, opts(o));
    return { core: m, make, memoryAt: (a) => (m.memory.known[a] ? m.memory.bytes[a] : loadStateAt(m, a)) };
  }
  if (donor.memoryMapped) {
    const m = simUnit0701Model(collection, xml, donor.behaviour, donor.memoryMapped);
    const make = ({ objects, sources, programId, peiType }: Over, o: SimOpts) => new SimUnit0701({ ...m, objects, sources, programId, memoryMapped: { ...m.memoryMapped, peiType } }, donor.interfaceIa, opts(o));
    return { core: m, make, memoryAt: (a) => m.memory.get(a) ?? loadStateAt(m, a) };
  }
  const m = simUnitModel(collection, xml, donor.behaviour as Parameters<typeof simUnitModel>[2]);
  const memoryAt = (a: number) => { for (const seg of m.segments.values()) if (a >= seg.at && a < seg.at + seg.size) return seg.bytes[a - seg.at]; return undefined; };
  // System B's program id is its object 4 PID 13 alone; its unit takes no task segment.
  return { core: m, make: ({ objects, sources }, o) => new SimUnit({ ...m, objects, sources }, donor.interfaceIa, opts(o)), memoryAt };
}

// What a donor is, as a digest: its collection and everything tools/sim-units.ts gives it besides. A row names it, so
// a donor collected again or given another behaviour since the row ran is seen.
export function donorDigest(donor: SimUnitSpec): string {
  const plain = (_: string, v: unknown) => (v instanceof Map ? [...v] : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v && typeof v === "object" && (v as { type?: string }).type === "Buffer" ? Buffer.from((v as { data: number[] }).data).toString("hex") : v);
  return createHash("sha256").update(readFileSync(corpusPath(donor.collection))).update(JSON.stringify(donor, plain)).digest("hex");
}

// `value` as the unit answers it: over the donor's element where it has one (the donor's octets where the value gives
// no bit, its length; the value's bits past it must be zero, as ETS takes a shorter answer with a zero tail,
// declaredPropMatches), the value alone where the donor has none and the value is given whole; null where neither
// gives it whole. A value given whole and shorter than the donor's element is refused: the donor's octets after it
// nobody gave for this unit.
function over(donor: Buffer | undefined, v: IdentityValue, key: string, refuse: (why: string) => never): Buffer | null {
  const whole = v.known.every((k) => k === 0xff);
  if (!donor) return whole ? Buffer.from(v.bytes) : null;
  if (whole && v.bytes.length < donor.length) refuse(`${key}: ${sourceOf(v)} gives ${v.bytes.length} octets ${hex(v.bytes)}, the donor answers ${donor.length}; what the unit answers after them is not given`);
  const out = Buffer.from(donor);
  v.bytes.forEach((b, i) => {
    if (i < out.length) out[i] = (out[i] & ~v.known[i]) | (b & v.known[i]);
    else if (b & v.known[i]) refuse(`${key}: ${sourceOf(v)} gives ${v.bytes.length} octets ${hex(v.bytes)}, past the donor's ${donor.length}, and not zero there`);
  });
  return out;
}

export interface CatalogueUnit {
  spec: CatalogueUnitSpec;
  // The identity from the product and the identity loop.
  identity: ProductUnit;
  // Its properties as it holds them at the start.
  objects: Objects;
  // `<object>/<PID>` -> the source of each property the unit answers otherwise than its donor; on System 7 also
  // `PEI type`, the source of the PEI type its task segments carry.
  properties: Map<string, string>;
  make: (opts?: SimOpts) => SimUnit;
}

// The unit of `spec`, built: the donor's model with the identity over it (the identity loop's lines put in one after
// the other, each checked against what the unit answered before it). Throws `no catalogue unit: ...`.
export function catalogueUnit(spec: CatalogueUnitSpec): CatalogueUnit {
  const refuse = (why: string): never => { throw new Error(`no catalogue unit: ${why}`); };
  const appXml = spec.appXml;
  const cfg = parseAppConfig(appXml);
  if (cfg.mask !== unitMask(spec.donor)) refuse(`the application is for ${cfg.mask}, the donor ${spec.donor.id} is ${unitMask(spec.donor)}`);
  const why = unfit(spec.donor, needs(cfg));
  if (why) refuse(`the donor ${spec.donor.id} does not fit the rule: ${why}`);
  const donor = donorModel(spec.donor);
  const compose = (identity: ProductUnit) => {
    const objects = new Map([...donor.core.objects].map(([o, props]) => [o, new Map(props)]));
    const properties = new Map<string, string>();
    for (const [key, v] of identity.properties) {
      const [o, pid] = keyParts(key);
      const had = objects.get(o)?.get(pid);
      const value = over(had?.elements?.[0], v, key, refuse);
      // Only a masked compare gives a value in part, and the application's compare needs the property answered.
      if (value === null) refuse(`${key}: ${sourceOf(v)} gives only the bits ${hex(v.known)} of it, and donor ${spec.donor.id} ${had?.elements === null ? "refused it" : "never showed it"}`);
      const p: SimProperty = had?.elements ? { ...had, elements: [value!, ...had.elements.slice(1)] } : { elements: [value!], countKnown: false };
      (objects.get(o) ?? objects.set(o, new Map()).get(o)!).set(pid, p);
      // The donor's octets stay where the value gives no bit, and past its end.
      const donorKept = had?.elements && (v.known.some((k) => k !== 0xff) || value!.length > v.bytes.length);
      properties.set(key, donorKept ? `${sourceOf(v)}, over donor ${spec.donor.id}` : sourceOf(v));
    }
    return { objects, properties };
  };
  let identity = productIdentity(appXml);
  for (const line of spec.learned) {
    const r = rerunIdentity(identity, line, answered(compose(identity).objects));
    if ("refused" in r) refuse(`the identity loop's line does not apply: ${r.refused}`);
    identity = (r as { identity: ProductUnit }).identity;
  }
  const { objects, properties } = compose(identity);
  // The application's own compares must pass on the unit, as on an own unit (tools/sim-unit-model.ts).
  for (const op of ["full", "par"] as const) for (const c of declaredPropChecks(cfg.loadProcedures, op)) {
    const v = objects.get(c.obj)?.get(c.pid)?.elements?.[0];
    if (!v || !declaredPropMatches(v, c.expect, c.mask)) refuse(`the application expects ${hex(c.expect)} in property ${c.obj}/${c.pid}, the unit answers ${v ? hex(v) : "nothing"}`);
  }
  const programId = identity.properties.get(`${maskInfo(cfg.mask).family === "system-b" ? 4 : 3}/${PID_PROGRAM_ID}`)!.bytes;
  const sources: AnswerSources = {
    unit: `catalogue unit of ${spec.application} from donor ${spec.donor.id} (${spec.donor.name}), by the rule ${spec.rule}`,
    mask: `product: the application's mask ${cfg.mask}, donor ${spec.donor.id}'s`,
    properties,
    held: `donor ${spec.donor.id}`,
    absent: `neither the product nor donor ${spec.donor.id} gives it`,
    memoryAt: donor.memoryAt,
  };
  if (spec.donor.propertyMapped || spec.donor.memoryMapped) properties.set("PEI type", `product: the application's PEI type ${cfg.appPeiType}`);
  const overlay: Over = { objects, sources, programId: Buffer.from(programId), peiType: cfg.appPeiType };
  return { spec, identity, objects, properties, make: (opts = {}) => donor.make(overlay, opts) };
}

// A fresh simulated unit of a row: an own unit (tools/sim-units.ts) or a catalogue unit.
export function newRowUnit(u: RowUnit, opts: SimOpts = {}): SimUnit {
  return isCatalogueUnit(u) ? catalogueUnit(u).make(opts) : newSimUnit(u, opts);
}

// The identity loop's rerun step for a catalogue unit: from the ETS6.log of a run ETS failed, the unit to run again
// with (the lines it learned from added), or why not (rerunIdentity's refusals, against what this unit answered).
export function learnIdentity(spec: CatalogueUnitSpec, log: Buffer | string): { spec: CatalogueUnitSpec; learned: Mismatch[] } | { refused: string } {
  let unit: CatalogueUnit;
  try { unit = catalogueUnit(spec); } catch (e) { return { refused: (e as Error).message }; }
  const r = rerunIdentity(unit.identity, log, answered(unit.objects));
  if ("refused" in r) return r;
  const next = { ...spec, learned: [...spec.learned, ...r.learned.map((m) => m.line)] };
  let after: CatalogueUnit;
  try { after = catalogueUnit(next); } catch (e) { return { refused: (e as Error).message }; }
  // A required value the unit answers no differently (a zero tail past the donor's element) would fail the same.
  const [was, now] = [answered(unit.objects), answered(after.objects)];
  if (r.learned.every((m) => was(`${m.object}/${m.pid}`).equals(now(`${m.object}/${m.pid}`)))) return { refused: `the unit answers ${r.learned.map((m) => `${m.object}/${m.pid}`).join(", ")} as before with what ETS required: a rerun fails the same` };
  return { spec: next, learned: r.learned };
}

// How row.json names the catalogue unit.
export function catalogueUnitRecord(unit: CatalogueUnit): CatalogueUnitRecord {
  return { source: "donor", donor: unit.spec.donor.id, donorDigest: donorDigest(unit.spec.donor), rule: unit.spec.rule, identity: unit.spec.learned, properties: Object.fromEntries(unit.properties) };
}
