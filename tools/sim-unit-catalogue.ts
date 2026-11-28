// A simulated unit for a catalogue row of the ETS sweep whose application has no own unit: the unit of a donor, an own
// unit of the application's mask (tools/sim-units.ts), with what the application's product gives put over it, and what
// ETS required of it in an earlier run (the identity loop, tools/sim-unit-product.ts) put over that.
//
// From the product: the mask (the donor's must be the application's), the manufacturer (0/12), the application's
// program id (PID 13 of the application object, ETS's LdCtrlWriteProp and task segments carry it), every bit its
// LdCtrlCompareProp steps expect, on System 7 the PEI type of its task segments, and on MV-0705 the task segments and
// task control 1 it declares, which the unit checks a download's against. From the identity loop: each
// value an ETS6.log `Required data mismatch` line required. From the donor: everything else, as its collection and
// its captures show it (its serial, order info, hardware type where nothing above names one, descriptions, segment
// places, load states, restart, link timing). What neither gives is refused, never filled in: a property the product
// gives only some bits of and the donor never showed, a value longer than the donor's element with bits set past it, a
// value given whole and shorter than the donor's element, a segment the donor places nowhere or cannot fit (checked
// up front by the MV-07B0 donor rule, and by the simulator for anything else when it comes). Every answer carries its
// source in the simulator's log (tools/sim-unit.ts AnswerSources).
//
// The donor is chosen by one rule per mask (DONOR_RULES), never per product, from the own units there are: one that
// cannot show what a download of the application needs of its unit does not qualify, and of those that do the one
// whose captures leave the fewest of its answers unshown is taken.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { XMLValidator } from "fast-xml-parser";
import { declaredPropMatches, MM_STATUS_BASE, PID } from "../packages/knx/src/index.ts";
import { extractAppPrograms } from "../packages/project/src/index.ts";
import { closingSteps, declaredPropChecks, lsmIdx, maskInfo, memType, parseAppConfig, PEI_LSM, programIdStamp, resolveModuleInstances, segType, stepAddress, stepSize, type DynNode, type ModuleInstance } from "../packages/product/src/index.ts";
import { catalogueXml, corpusPath } from "./corpus.ts";
import { MEMORY_END, MEMORY_EXT_END, segmentAllocationRefusal, type AnswerSources, type SimProperty, type SimUnit, type SimUnitCoreModel } from "./sim-unit.ts";
import { LSMS as MV0701_LSMS, WRITTEN_MEMORY_TYPE, type AdditionalControl } from "./sim-unit-0701.ts";
import { APPLICATION_LSM as PROPERTY_MAPPED_APPLICATION_LSM, declaredSegments, declaredTaskForms, declaredTasks, fullSteps, PLACE_TEXT, type DeclaredTaskForms, type DeclaredTasks } from "./sim-unit-0705.ts";
import { productUnit, rerunIdentity, type IdentityValue, type Mismatch, type ProductUnit } from "./sim-unit-product.ts";
import { collectionOf, newSimUnit, SIM_UNITS, simUnitOf, unitModel, type SimUnitSpec, type UnitModel } from "./sim-units.ts";

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
  // Set for a stored sweep row recorded under an earlier rule of its mask whose application now has no qualifying
  // donor: keeps the row replayable on its recorded donor while manifestRow records rulePicksNow.
  retiredRule?: true;
  // Set when replaying a row whose 0/78 the identity loop alone gave: skips declaredHardwareType
  // (<Property ObjectIndex="0" PropertyId="78"/> and <ApplicationProgram HardwareType="..."/>) so the unit keeps
  // the exact property sources ETS saw.
  skipPropertyHardwareType?: true;
}

// The unit of a sweep row: an own unit, or a catalogue unit.
export type RowUnit = SimUnitSpec | CatalogueUnitSpec;
export const isCatalogueUnit = (u: RowUnit): u is CatalogueUnitSpec => "donor" in u;
// The application program a row's unit runs: an own unit's from the corpus's catalogue/, a catalogue unit's its own.
export const unitAppXml = (u: RowUnit): string => (isCatalogueUnit(u) ? u.appXml : catalogueXml(u.catalogue));
// A file's bytes, gunzipped where its name ends in .gz: a row's export, a --product file of tools/sim-unit-serve.ts.
export const readMaybeGzipped = (path: string): Buffer => { const b = readFileSync(path); return path.endsWith(".gz") ? gunzipSync(b) : b; };

// How a row's row.json names a catalogue unit: its donor, the rule, the identity loop's lines, and the source of
// each property the unit answers otherwise than its donor or with the product's or the loop's value; `donorDigest` what
// the donor was (donorDigest).
export interface CatalogueUnitRecord { source: "donor"; donor: string; donorDigest: string; rule: string; identity: string[]; properties: Record<string, string> }

const MASKS = ["MV-07B0", "MV-0701", "MV-0705"] as const;
type Mask = (typeof MASKS)[number];

// The mask of an own unit: the one its model takes (tools/sim-unit-model.ts takes MV-07B0 only, the memory-mapped
// model MV-0701, the property-mapped one MV-0705).
export const unitMask = (u: SimUnitSpec): Mask => (u.memoryMapped ? "MV-0701" : u.propertyMapped ? "MV-0705" : "MV-07B0");

const COMMON_RULE = "an own unit of the mask whose application leaves its memory as written after a restart (another application's would not), whose captures show its answer to each restart a download of the application ends with, and whose collection shows its answer to each property the application's LdCtrlLoadImageProp reads; of those, the one whose captures leave the fewest of its answers unshown, then one collected in the state its captures show, then by id";
// The rule per mask. MV-07B0 asks besides for A_MemoryExtended_Write where the application declares extended memory
// services, for the device control after the application's unload where it declares none (ETS and Busforge then
// write its memory with A_Memory_Write, echoed in verify mode, which that octet holds), and for enough room in the
// donor's segment layout and memory reach for the application's relative segments and com-object table; MV-0701 for
// every additional load control the full download declares (distinguishing LdCtrlAbsSegment by SegType, since
// SegType=1 sends additional load control 1, and skipping LdCtrlTaskSegment on LSM 5 which ETS never sends), for
// collected memory covering every declared EEPROM segment (MV-0701 downloads read memory before writing), for valid
// 16-bit non-overlapping segments on machines 1-4, and for LdCtrlLoad plus both an absolute segment and
// LdCtrlTaskSegment inside a declared segment before LdCtrlLoadCompleted on every unloaded machine; MV-0705 for the device control after the application's unload where
// its full download unloads it (its memory is always written with A_Memory_Write), its task controls 1 (by machine,
// count and where the address lies) and its task segments at an address that starts no declared segment (by machine
// and where the address lies), which its units take or refuse as their captures show.
export const DONOR_RULES: Record<Mask, string> = {
  "MV-07B0": `MV-07B0: ${COMMON_RULE}; and whose captures show A_MemoryExtended_Write where the application declares extended memory services, whose captures show its device control after its application's unload where the application declares none, and whose segment layout holds the application's relative segments and com-object table`,
  "MV-0701": `MV-0701: ${COMMON_RULE}; and that takes every additional load control the application declares (distinguishing LdCtrlAbsSegment by SegType), whose collected memory covers every declared EEPROM segment, and for an application whose full download declares both an absolute segment and a task segment before LdCtrlLoadCompleted on every unloaded machine`,
  "MV-0705": `MV-0705: ${COMMON_RULE}; and whose captures show its device control after its application's unload where the application's full download unloads it, each task control 1 the application declares, of its machine and count with its address 0 or at the same place, and each task segment it declares at an address that starts no declared segment, of its machine and at the same place (the end of a segment, or inside one)`,
};

// Exact historical rule strings recorded on stored sweep rows whose mask rule later tightened so no donor qualifies
// any more. Only these exact strings (never arbitrary mask-prefixed text) may take the retired-rule replay path.
export const RETIRED_DONOR_RULES: Readonly<Record<Mask, readonly string[]>> = {
  "MV-07B0": [],
  "MV-0701": [`MV-0701: ${COMMON_RULE}; and that takes every additional load control the application declares`],
  "MV-0705": [],
};

type AdditionalNeed = AdditionalControl | `additional load control ${number} (SegType=${number})`;

type AppConfig = ReturnType<typeof parseAppConfig>;
type Needs = { basic: boolean; confirmed: boolean; extendedWrite: boolean; controlAfterUnload: boolean; loadImage: { obj: number; pid: number }[]; additional: AdditionalNeed[]; eepromSegments: { lsm: number; at: number; size: number }[]; relSegments: { lsm: number; size: number }[] } & DeclaredTaskForms;
const NO_TASKS: DeclaredTaskForms = { taskPlaces: [], taskControls1: [] };

// Highest com-object number declared by `cfg`, including modular com-objects resolved from `instances` without running
// buildDeviceConfig (which can refuse unrelated UI/InitialValue constructs that ETS captures are meant to settle).
function maxDeclaredComObjectNumber(cfg: AppConfig, instances: readonly ModuleInstance[]): number {
  let maxCo = 0;
  for (const co of cfg.comObjects.values()) if (!co.baseNumber && co.number > maxCo) maxCo = co.number;
  if (!instances.length) return maxCo;
  const byNode = new Map<string, ModuleInstance[]>();
  const strip = (id: string) => (id.startsWith(`${cfg.id}_`) ? id.slice(cfg.id.length + 1) : id);
  for (const inst of instances) (byNode.get(inst.refId) ?? byNode.set(inst.refId, []).get(inst.refId)!).push(inst);
  const walk = (nodes: DynNode[], args: Map<string, number> | null) => {
    for (const n of nodes) {
      if (n.kind === "comObjRef" && args) {
        const ref = cfg.comObjectRefs.get(n.refId), co = ref ? cfg.comObjects.get(ref.refId) : undefined;
        if (co) {
          const base = co.baseNumber ? args.get(co.baseNumber) : 0;
          if (base !== undefined && Number.isFinite(base)) maxCo = Math.max(maxCo, co.number + base);
        }
      } else if (n.kind === "choose") {
        for (const w of n.whens) walk(w.children, args);
      } else if (n.kind === "container" || n.kind === "block") {
        walk(n.children, args);
      } else if (n.kind === "module") {
        const def = cfg.moduleDefs.get(n.refId);
        if (!def) continue;
        for (const inst of byNode.get(strip(n.id)) ?? []) {
          const next = new Map(args ?? []);
          for (const a of inst.args) if (/^-?\d+$/.test(a.value)) next.set(`${cfg.id}_${a.refId}`, Number(a.value));
          walk(def.dynamic, next);
        }
      }
    }
  };
  walk(cfg.dynamic, null);
  return maxCo;
}

// The System B relative segment sizes a full download allocates: every declared LdCtrlRelSegment (each distinct size
// kept so a Size="0" step is never masked by a positive size on the same object) and the com-object table on object 3
// (2 + 2 * maxComObjectNumber).
function systemBSegments(cfg: AppConfig, steps: ReturnType<typeof fullSteps>): { lsm: number; size: number }[] | string {
  const seen = new Set<string>();
  const out: { lsm: number; size: number }[] = [];
  const add = (lsm: number, size: number) => {
    const k = `${lsm}:${size}`;
    if (!seen.has(k)) { seen.add(k); out.push({ lsm, size }); }
  };
  for (const s of steps) {
    if (s.verb !== "LdCtrlRelSegment") continue;
    let lsm: number, size: number | undefined;
    try {
      lsm = s.attrs.LsmIdx === undefined ? 4 : lsmIdx(s)!;
      size = stepSize(s);
    } catch (e) { return (e as Error).message; }
    if (size === undefined) return "the load procedure declares LdCtrlRelSegment without Size";
    add(lsm, size);
  }
  let instances: ModuleInstance[] = [];
  if (cfg.hasModules) {
    try { instances = resolveModuleInstances(cfg, new Map()); } catch { instances = []; }
  }
  const maxCo = maxDeclaredComObjectNumber(cfg, instances);
  if (maxCo > 0) add(3, 2 + 2 * maxCo);
  return out.sort((a, b) => a.lsm - b.lsm || a.size - b.size);
}

const hexAddr = (a: number) => `0x${a.toString(16).padStart(4, "0")}`;

// What an MV-0701 application's full download requires of its donor and SimUnit0701:
// - every additional load control it declares (distinguishing LdCtrlAbsSegment by SegType, skipping LdCtrlTaskSegment
//   on LSM 5 which ETS never sends);
// - valid 16-bit non-overlapping absolute segments on machines 1-4, and every EEPROM segment (SegType=0, MemType=3)
//   that must lie within the donor's collected memory;
// - for every unloaded machine: LdCtrlLoad before its additional controls and LdCtrlLoadCompleted, and both an
//   absolute segment and an LdCtrlTaskSegment inside one of its declared segments before LdCtrlLoadCompleted.
// Or why SimUnit0701 will refuse the load procedure on every MV-0701 donor.
function memoryMappedNeeds(steps: ReturnType<typeof fullSteps>): { additional: AdditionalNeed[]; eepromSegments: { lsm: number; at: number; size: number }[] } | string {
  const additional = new Set<AdditionalNeed>();
  const eepromSegments: { lsm: number; at: number; size: number }[] = [];
  const machines = new Map<number, { unloaded: boolean; loading: boolean; segments: { at: number; size: number }[]; hasTask: boolean }>();
  const stateOf = (lsm: number) => machines.get(lsm) ?? machines.set(lsm, { unloaded: false, loading: false, segments: [], hasTask: false }).get(lsm)!;
  const requireLsm = (s: ReturnType<typeof fullSteps>[number]): number | string => {
    const lsm = lsmIdx(s);
    if (lsm === undefined) return `the load procedure declares ${s.verb} without LsmIdx`;
    if (!MV0701_LSMS.includes(lsm)) return `the load procedure declares ${s.verb} for load-state machine ${lsm}, which no MV-0701 unit models`;
    return lsm;
  };
  for (const s of steps) {
    if (s.verb === "LdCtrlUnload") {
      const lsm = requireLsm(s);
      if (typeof lsm === "string") return lsm;
      machines.set(lsm, { unloaded: true, loading: false, segments: [], hasTask: false });
    } else if (s.verb === "LdCtrlLoad") {
      const lsm = requireLsm(s);
      if (typeof lsm === "string") return lsm;
      stateOf(lsm).loading = true;
    } else if (s.verb === "LdCtrlAbsSegment") {
      const lsm = requireLsm(s);
      if (typeof lsm === "string") return lsm;
      const m = stateOf(lsm);
      if (m.unloaded && !m.loading) return `the load procedure declares LdCtrlAbsSegment for unloaded load-state machine ${lsm} before LdCtrlLoad`;
      const st = segType(s);
      if (st !== 0) {
        additional.add(`additional load control ${st} (SegType=${st})`);
        continue;
      }
      const at = stepAddress(s), size = stepSize(s), mt = memType(s);
      if (at === undefined || size === undefined || mt === undefined) {
        return "the application declares an absolute segment without its machine, address, size or memory type";
      }
      additional.add("absolute-segment");
      if (size === 0 || size >= MEMORY_END || at + size > MEMORY_END) {
        return `the application declares an absolute segment of ${size} octets at 0x${at.toString(16)}, which the memory services do not reach whole`;
      }
      const other = MV0701_LSMS.find((l) => l !== lsm && (machines.get(l)?.segments.some((seg) => at < seg.at + seg.size && seg.at < at + size) ?? false));
      if (other !== undefined) {
        return `the application declares an absolute segment for load-state machine ${lsm} at ${hexAddr(at)} (${size} octets) reaching into one of load-state machine ${other}`;
      }
      m.segments.push({ at, size });
      if (mt === WRITTEN_MEMORY_TYPE) eepromSegments.push({ lsm, at, size });
    } else if (s.verb === "LdCtrlTaskSegment") {
      const rawLsm = lsmIdx(s);
      if (rawLsm === undefined) return "the load procedure declares LdCtrlTaskSegment without LsmIdx";
      if (rawLsm === PEI_LSM) continue;
      if (!MV0701_LSMS.includes(rawLsm)) return `the load procedure declares LdCtrlTaskSegment for load-state machine ${rawLsm}, which no MV-0701 unit models`;
      const m = stateOf(rawLsm);
      if (m.unloaded && !m.loading) return `the load procedure declares LdCtrlTaskSegment for unloaded load-state machine ${rawLsm} before LdCtrlLoad`;
      const at = stepAddress(s);
      if (at === undefined || at >= MEMORY_END) return `the load procedure declares LdCtrlTaskSegment for load-state machine ${rawLsm} without a 16-bit Address`;
      if (m.unloaded && !m.segments.some((seg) => at >= seg.at && at < seg.at + seg.size)) {
        return `the load procedure declares LdCtrlTaskSegment for load-state machine ${rawLsm} at ${hexAddr(at)}, outside its declared segments`;
      }
      additional.add("task-segment");
      m.hasTask = true;
    } else if (s.verb === "LdCtrlTaskCtrl1") {
      const lsm = requireLsm(s);
      if (typeof lsm === "string") return lsm;
      const m = stateOf(lsm);
      if (m.unloaded && !m.loading) return `the load procedure declares LdCtrlTaskCtrl1 for unloaded load-state machine ${lsm} before LdCtrlLoad`;
      additional.add("task-control-1");
    } else if (s.verb === "LdCtrlLoadCompleted") {
      const lsm = requireLsm(s);
      if (typeof lsm === "string") return lsm;
      const m = machines.get(lsm);
      if (m?.unloaded && !m.loading) return `the load procedure completes unloaded load-state machine ${lsm} without LdCtrlLoad`;
      if (m?.unloaded && (m.segments.length === 0 || !m.hasTask)) {
        const missing = [m.segments.length === 0 ? "an absolute segment" : null, !m.hasTask ? "LdCtrlTaskSegment" : null].filter(Boolean).join(" and ");
        return `the load procedure completes unloaded load-state machine ${lsm} without ${missing}`;
      }
      if (m) m.loading = false;
    }
  }
  return { additional: [...additional], eepromSegments };
}

// What a download of the application needs of its unit beyond the mask: a basic restart at its end (System 7's
// LdCtrlRestart; a System B download without Data Secure, whose closing ETS takes from the mask), a confirmed restart
// (a System B download with Data Secure, as ETS's downloads of the Theben MIX 2, the Jung 400021SE and the GVS AMMA
// show; a declared LdCtrlMasterReset), on System B A_MemoryExtended_Write (an application with extended memory services,
// whose memory ETS writes so: packages/product/src/loadproc.ts) or else the device control after the application's
// unload (its memory written with A_Memory_Write, echoed where the octet holds verify mode), and room in the donor's
// segment layout for its declared relative segments and com-object table; the same unload control on MV-0705 where
// its full download unloads the application (object 3), an answer to each
// property its LdCtrlLoadImageProp reads at the download's end, on MV-0701 the additional load controls (by SegType),
// EEPROM segment bounds and unload/complete declarations it declares,
// on MV-0705 the task controls 1 and the task segments at an address that starts none of the machine's declared
// segments its full download declares. Or why the application's declarations cannot be read.
function needs(cfg: AppConfig): Needs | string {
  const proc = cfg.loadProcedures;
  const systemB = cfg.mask === "MV-07B0";
  let loadImage: Needs["loadImage"];
  try { loadImage = closingSteps(proc, "full").flatMap((c) => (c.kind === "read" ? [{ obj: c.obj, pid: c.pid }] : [])); } catch (e) { return (e as Error).message; }
  const steps = fullSteps(proc);
  const relSegments = systemB ? systemBSegments(cfg, steps) : [];
  if (typeof relSegments === "string") return relSegments;
  const mm = cfg.mask === "MV-0701" ? memoryMappedNeeds(steps) : { additional: [], eepromSegments: [] };
  if (typeof mm === "string") return mm;
  const forms = cfg.mask === "MV-0705" ? taskForms(steps) : NO_TASKS;
  if (typeof forms === "string") return forms;
  const unloadsApplication = steps.some((s) => s.verb === "LdCtrlUnload" && s.attrs.LsmIdx === String(PROPERTY_MAPPED_APPLICATION_LSM));
  return {
    basic: systemB ? !proc.secureEnabled : proc.verbs.includes("LdCtrlRestart"),
    confirmed: (systemB && proc.secureEnabled) || proc.verbs.includes("LdCtrlMasterReset"),
    extendedWrite: systemB && proc.extendedMemoryServices,
    controlAfterUnload: (systemB && !proc.extendedMemoryServices) || (cfg.mask === "MV-0705" && unloadsApplication),
    loadImage,
    additional: mm.additional,
    eepromSegments: mm.eepromSegments,
    relSegments,
    ...forms,
  };
}
// An MV-0705 application's task declarations and their forms, or why they cannot be read.
function taskForms(steps: ReturnType<typeof fullSteps>): DeclaredTaskForms | string {
  const tasks = declaredTasks(steps);
  if (typeof tasks === "string") return tasks;
  const segments = declaredSegments(steps);
  return typeof segments === "string" ? segments : declaredTaskForms(segments, tasks);
}

// What a unit's collection shows of property `<object>/<PID>`, as its captures leave it at the start
// (`stateInCaptures`): an element answered, its count alone, refused, or not read; by unit, as neither changes while a
// process runs.
type Shown = "element" | "count" | "refused" | "not read";
const collected = new Map<string, Map<string, Shown>>();
function collectedProperty(u: SimUnitSpec, key: string): Shown {
  let shown = collected.get(u.id);
  if (!shown) {
    shown = new Map();
    for (const r of collectionOf(u).records) {
      const t = r.target as { object?: number; pid?: number; start?: number };
      if (r.space !== "property" || t.object === undefined || t.pid === undefined) continue;
      const k = `${t.object}/${t.pid}`, had = shown.get(k);
      if (r.outcome === "refused") shown.set(k, "refused");
      else if (r.outcome === "bytes" && had !== "refused") shown.set(k, (t.start ?? 1) === 0 && had !== "element" ? "count" : "element");
    }
    const state = "stateInCaptures" in u.behaviour ? u.behaviour.stateInCaptures?.properties : undefined;
    for (const [k, hex] of Object.entries(state ?? {})) shown.set(k, hex === "" ? "refused" : "element");
    collected.set(u.id, shown);
  }
  return shown.get(key) ?? "not read";
}

// A System B donor's segment map from its model, cached per spec for segmentAllocationRefusal.
const donorSegments = new WeakMap<SimUnitSpec, ReadonlyMap<number, { at: number; size: number }>>();
function systemBDonorSegments(u: SimUnitSpec): ReadonlyMap<number, { at: number; size: number }> {
  let segs = donorSegments.get(u);
  if (!segs) {
    const m = unitModel(u);
    segs = m.kind === "system-b" ? m.model.segments : new Map();
    donorSegments.set(u, segs);
  }
  return segs;
}

// Contiguous [start, end) ranges of an MV-0701 donor's collected memory, cached per spec.
const donorMemoryRanges = new WeakMap<SimUnitSpec, readonly { start: number; end: number }[]>();
function memoryMappedDonorRanges(u: SimUnitSpec): readonly { start: number; end: number }[] {
  let ranges = donorMemoryRanges.get(u);
  if (!ranges) {
    const m = unitModel(u);
    if (m.kind !== "memory-mapped") ranges = [];
    else {
      const addrs = [...m.model.memory.keys()].sort((a, b) => a - b);
      const merged: { start: number; end: number }[] = [];
      for (const a of addrs) {
        const last = merged.at(-1);
        if (last && a === last.end) last.end = a + 1;
        else merged.push({ start: a, end: a + 1 });
      }
      ranges = merged;
    }
    donorMemoryRanges.set(u, ranges);
  }
  return ranges;
}

// Why `u` cannot be the donor of a download with these needs, or null.
function unfit(u: SimUnitSpec, need: Needs): string | null {
  const b = u.behaviour;
  if (!u.memoryMapped && !u.propertyMapped && "clearsAfterRestart" in b && b.clearsAfterRestart.length) return "its application changes its memory after a restart";
  if (u.memoryMapped && u.memoryMapped.clearedByRestart.size) return "its application changes its memory after a restart";
  if (need.basic && b.restart.basic === null) return "its captures show no basic restart";
  if (need.confirmed && b.restart.confirmedRestartSeconds === null) return "its captures show no confirmed restart";
  if (need.extendedWrite && !b.memoryExtendedWrite) return "its captures show no A_MemoryExtended_Write";
  const stops = u.propertyMapped ? u.propertyMapped.unloadStopsApplication : "unloadStopsApplication" in b ? b.unloadStopsApplication : undefined;
  if (need.controlAfterUnload && stops === null) return "its captures show no device control after its application's unload, which decides whether its A_Memory_Write is echoed";
  if (need.relSegments.length) {
    const segs = systemBDonorSegments(u);
    // Without extended memory services ETS writes with 16-bit A_Memory_Write, capped at MEMORY_END regardless of donor.
    const memoryLimit = need.extendedWrite && b.memoryExtendedWrite ? MEMORY_EXT_END : MEMORY_END;
    for (const { lsm, size } of need.relSegments) {
      const refused = segmentAllocationRefusal(segs, lsm, size, memoryLimit);
      if (refused) return `segment of object ${lsm}: ${refused}`;
    }
  }
  // Whether it answers the property, not how many elements: those the simulator computes from the download's
  // segments at its load completed (the collection read the donor's own), and a read past them it refuses. A count
  // alone is an answer only where its captures show what the block reports after a load (System B's `mcb`).
  for (const { obj, pid } of need.loadImage) {
    const shown = collectedProperty(u, `${obj}/${pid}`);
    const answers = shown === "element" || (shown === "count" && "mcb" in b && b.mcb !== undefined);
    if (!answers) return `its collection ${shown === "refused" ? "shows it refuse" : shown === "count" ? "shows only the element count of" : "did not read"} property ${obj}/${pid}, which the application's LdCtrlLoadImageProp reads`;
  }
  const taken: readonly AdditionalNeed[] = u.memoryMapped?.additional ?? [];
  const missing = need.additional.filter((a) => !taken.includes(a));
  if (missing.length) return `its captures show no ${missing.join(", ")}`;
  if (need.eepromSegments.length) {
    const ranges = memoryMappedDonorRanges(u);
    for (const { lsm, at, size } of need.eepromSegments) {
      const end = at + size;
      if (!ranges.some((r) => r.start <= at && end <= r.end)) {
        return `its collected memory does not cover EEPROM segment of object ${lsm} (${hexAddr(at)}-${hexAddr(end - 1)}, ${size} bytes)`;
      }
    }
  }
  const control = need.taskControls1.find((t) => !u.propertyMapped?.taskControls1.some((x) => x.lsm === t.lsm && x.count === t.count && x.at === t.at));
  if (control) return `its captures show no task control 1 of object ${control.lsm} with count ${control.count} at ${control.at === "zero" ? "address 0" : `an address ${PLACE_TEXT[control.at]}`}`;
  const task = need.taskPlaces.find((t) => !u.propertyMapped?.taskSegmentsElsewhere.some((x) => x.lsm === t.lsm && x.place === t.place));
  if (task) return `its captures show no task segment of object ${task.lsm} ${PLACE_TEXT[task.place]}`;
  return null;
}
// The same, for an application whose declarations cannot be read.
const unfitFor = (u: SimUnitSpec, need: Needs | string): string | null => (typeof need === "string" ? need : unfit(u, need));

// Why the own unit `u` cannot be a donor for `appXml` (of its mask), or null where it can.
export const donorUnfit = (u: SimUnitSpec, appXml: string): string | null => unfitFor(u, needs(parseAppConfig(appXml)));

// How many of its answers the unit's captures leave unshown.
function unshown(u: SimUnitSpec): number {
  const b = u.behaviour;
  const stops = u.propertyMapped ? [u.propertyMapped.unloadStopsApplication, u.propertyMapped.loadStopsApplication] : u.memoryMapped ? [] : "unloadStopsApplication" in b ? [b.unloadStopsApplication] : [];
  return [b.restart.basic, b.restart.deadConnection, b.restart.confirmedRestartSeconds, b.programmingMode, b.serialNumberResponseTail, b.descriptionIndex, ...stops].filter((x) => x === null).length;
}
const collectedInAnotherState = (u: SimUnitSpec) => "stateInCaptures" in u.behaviour && u.behaviour.stateInCaptures !== undefined;

export type DonorChoice = { donor: SimUnitSpec; rule: string } | { refused: string };

// ETS's local ProductStore (ProductStore/M-*/M-*_A-*/A) keeps application programs as UTF-8 XML with shortened
// element names (<AP>, <St>, <Opt>, <COT>, <CO>, <P>, ...) and the same attributes as an exported .knxproj;
// <LoadProcedures>, <LdCtrl*>, <Dynamic>, <ModuleDefs>, <Allocators>, and <Arguments> are stored unshortened by ETS 6
// (verified across all 5,520 ProductStore files). None of these keys is a standard KNX XML element name, so expanding
// them is idempotent on standard XML. Stored in a Map so Object.prototype keys never match.
export const PRODUCT_STORE_TAGS: ReadonlyMap<string, string> = new Map(Object.entries({
  APS: "ApplicationPrograms", AP: "ApplicationProgram", St: "Static",
  AS: "AbsoluteSegment", RS: "RelativeSegment",
  ADRT: "AddressTable", ASSOT: "AssociationTable",
  COT: "ComObjectTable", COs: "ComObjects", CO: "ComObject",
  CORS: "ComObjectRefs", COR: "ComObjectRef",
  PTS: "ParameterTypes", PT: "ParameterType",
  TR: "TypeRestriction", TNr: "TypeNumber", TFl: "TypeFloat", TTxt: "TypeText",
  TColor: "TypeColor", TTime: "TypeTime", TIP: "TypeIPAddress",
  TNone: "TypeNone", TPic: "TypePicture", TDate: "TypeDate", TRaw: "TypeRawData",
  PS: "Parameters", P: "Parameter", U: "Union", M: "Memory", Prop: "Property",
  PRS: "ParameterRefs", PR: "ParameterRef",
  Opt: "Options", Ext: "Extension",
  PCs: "ParameterCalculations", PC: "ParameterCalculation",
  LPars: "LParameters", RPars: "RParameters", LRT: "LRTransformation", RLT: "RLTransformation",
  LS: "Languages", L: "Language", TU: "TranslationUnit", TE: "TranslationElement", T: "Translation",
  Ms: "Message",
}));

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

// ETS ProductStore application XML (plain UTF-8 or gzipped) normalized to standard KNX XML element names so
// parseAppConfig and chooseDonor read it identically to an exported .knxproj application program.
export function normalizeProductStoreXml(raw: string | Buffer): string {
  const bytes = typeof raw === "string"
    ? null
    : (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw);
  const text = bytes === null ? raw as string : UTF8_STRICT.decode(bytes);
  const stripped = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return stripped.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<(\/?)([A-Za-z_][A-Za-z0-9_:-]*)(?=[\s/>])/g,
    (m, slash: string | undefined, tag: string | undefined) => {
      if (!tag) return m;
      const mapped = PRODUCT_STORE_TAGS.get(tag);
      return mapped ? `<${slash ?? ""}${mapped}` : m;
    },
  );
}

export type PrecheckOutcome =
  | { kind: "donor"; donor: SimUnitSpec; rule: string }
  | { kind: "refused"; why: string }
  | { kind: "fallback"; why: string };

// Offline donor and product-identity pre-check for `application` against an ETS ProductStore application file (`raw`,
// plain or gzipped XML). Returns the exact chooseDonor() / productIdentity() verdict when the file decodes strictly as
// UTF-8, validates as well-formed XML, parses cleanly and matches `application` (and `mask`, when given, as "07B0" or
// "MV-07B0"), or `fallback` when the file is truncated, corrupt, unparseable, or disagrees on identity so the batch
// runner falls back to ETS's export instead of refusing on broken local data.
export function precheckDonor(
  application: string,
  raw: string | Buffer,
  opts: { mask?: string; units?: readonly SimUnitSpec[] } = {},
): PrecheckOutcome {
  let xml: string;
  try { xml = normalizeProductStoreXml(raw); } catch (e) {
    return { kind: "fallback", why: `could not decode ProductStore XML: ${e instanceof Error ? e.message : String(e)}` };
  }
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return { kind: "fallback", why: `ProductStore XML is malformed: ${valid.err.msg} (line ${valid.err.line})` };
  let cfg: AppConfig;
  try { cfg = parseAppConfig(xml); } catch (e) {
    return { kind: "fallback", why: `could not parse ProductStore XML: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (cfg.id !== application) return { kind: "fallback", why: `ProductStore XML holds ${cfg.id || "no application id"}, expected ${application}` };
  if (!/^M-[0-9A-Fa-f]{4}_/.test(cfg.id)) return { kind: "fallback", why: `ProductStore XML has invalid application id ${cfg.id}` };
  if (!Number.isInteger(cfg.appNumber) || cfg.appNumber < 0 || cfg.appNumber > 0xffff) {
    return { kind: "fallback", why: `ProductStore XML has invalid ApplicationNumber (${cfg.appNumber})` };
  }
  if (!Number.isInteger(cfg.appVersion) || cfg.appVersion < 0 || cfg.appVersion > 0xff) {
    return { kind: "fallback", why: `ProductStore XML has invalid ApplicationVersion (${cfg.appVersion})` };
  }
  if (!Number.isInteger(cfg.appPeiType) || cfg.appPeiType < 0 || cfg.appPeiType > 0xff) {
    return { kind: "fallback", why: `ProductStore XML has invalid PeiType (${cfg.appPeiType})` };
  }
  if (opts.mask !== undefined) {
    const wantMask = opts.mask.startsWith("MV-") ? opts.mask : `MV-${opts.mask}`;
    if (cfg.mask !== wantMask) return { kind: "fallback", why: `ProductStore XML mask ${cfg.mask || "missing"} disagrees with ${wantMask}` };
  }
  const choice = chooseDonorFor(cfg, opts.units ?? SIM_UNITS);
  if ("refused" in choice) return { kind: "refused", why: choice.refused };
  try { productIdentity(xml, cfg, { includePropertyHardwareType: false }); } catch (e) {
    if (e instanceof Error && /^no (?:catalogue|product) unit:/.test(e.message)) return { kind: "refused", why: e.message };
    throw e;
  }
  return { kind: "donor", donor: choice.donor, rule: choice.rule };
}

// The donor of `appXml` by the rule of its mask, among `units`.
export function chooseDonor(appXml: string, units: readonly SimUnitSpec[] = SIM_UNITS): DonorChoice {
  return chooseDonorFor(parseAppConfig(appXml), units);
}
function chooseDonorFor(cfg: AppConfig, units: readonly SimUnitSpec[]): DonorChoice {
  const mask = cfg.mask;
  if (!(MASKS as readonly string[]).includes(mask)) return { refused: `no donor for ${mask}: no rule for it, the simulator models ${MASKS.join(", ")}` };
  const need = needs(cfg);
  if (typeof need === "string") return { refused: `no donor for ${mask}: ${need}` };
  const same = units.filter((u) => unitMask(u) === mask);
  const why = same.map((u) => ({ u, why: unfit(u, need) }));
  const fit = why.filter((x) => x.why === null).map((x) => x.u);
  if (fit.length === 0) return { refused: `no donor for ${mask}: ${same.length ? why.map((x) => `${x.u.id}: ${x.why}`).join("; ") : "no own unit of the mask"}` };
  const [donor] = fit.sort((a, b) => unshown(a) - unshown(b) || Number(collectedInAnotherState(a)) - Number(collectedInAnotherState(b)) || a.id.localeCompare(b.id));
  return { donor, rule: DONOR_RULES[mask as Mask] };
}

// The catalogue unit of `application` (an application program id), whose program `appXml` holds: the donor the rule
// picks, or the one named (a row's, which must still fit the rule's needs, except for a stored row whose earlier rule
// `recordedRule` has since tightened so no donor qualifies any more); with the identity loop's lines in the order it
// took them. Refused for an application that has an own unit (its rows take that) and where no donor fits.
export function catalogueUnitSpec(
  application: string,
  appXml: string,
  opts: { donor?: string; learned?: string[]; units?: readonly SimUnitSpec[]; recordedRule?: string; skipPropertyHardwareType?: boolean } = {},
): CatalogueUnitSpec | { refused: string } {
  const units = opts.units ?? SIM_UNITS;
  const own = units.find((u) => u.catalogue === `${application}.xml.gz`);
  if (own) return { refused: `${application} has its own unit ${own.id}` };
  const cfg = parseAppConfig(appXml);
  if (cfg.id !== application) return { refused: `the application program given is ${cfg.id}, not ${application}` };
  let choice: DonorChoice;
  let retiredRule = false;
  if (opts.donor === undefined) choice = chooseDonorFor(cfg, units);
  else {
    const named = units.find((u) => u.id === opts.donor);
    if (!named) return { refused: `no own unit ${opts.donor} to borrow` };
    if (unitMask(named) !== cfg.mask) return { refused: `the donor ${named.id} is of ${unitMask(named)}, the application of ${cfg.mask}` };
    const currentRule = DONOR_RULES[cfg.mask as Mask];
    const need = needs(cfg);
    const why = unfitFor(named, need);
    if (why) {
      const retired = typeof opts.recordedRule === "string" && (RETIRED_DONOR_RULES[cfg.mask as Mask] ?? []).includes(opts.recordedRule);
      const anyFitsNow = typeof need !== "string" && units.some((u) => unitMask(u) === cfg.mask && unfit(u, need) === null);
      if (retired && !anyFitsNow) {
        choice = { donor: named, rule: opts.recordedRule! };
        retiredRule = true;
      } else {
        return { refused: `the donor ${named.id} does not fit the rule: ${why}` };
      }
    } else {
      choice = { donor: named, rule: currentRule };
    }
  }
  if ("refused" in choice) return choice;
  const { donor, rule } = choice;
  return {
    id: `${application}@${donor.id}`, name: `${application} (catalogue unit on ${donor.name})`, application, appXml,
    interfaceIa: donor.interfaceIa, interfaceMaxApdu: donor.interfaceMaxApdu, donor, rule, learned: opts.learned ?? [],
    ...(retiredRule ? { retiredRule: true as const } : {}),
    ...(opts.skipPropertyHardwareType ? { skipPropertyHardwareType: true as const } : {}),
  };
}

const hex = (b: Buffer) => b.toString("hex");
// The property that holds the application's program id: on System B object 4's, on System 7 object 3's.
const programIdKey = (cfg: AppConfig) => `${maskInfo(cfg.mask).family === "system-b" ? 4 : 3}/${PID.PROGRAM_ID}`;

// The identity the product gives: productUnit's, with the application's program id on its application object.
function productIdentity(appXml: string, cfg: AppConfig, opts: { includePropertyHardwareType?: boolean } = {}): ProductUnit {
  const refuse = (why: string): never => { throw new Error(`no catalogue unit: ${why}`); };
  const unit = productUnit(appXml, cfg, opts);
  const key = programIdKey(cfg);
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
// What the catalogue unit puts over its donor's model: its properties and their sources, on System 7 the program id
// and PEI type its task segments carry, which the unit checks them against, and on MV-0705 the task segments and
// task control 1 its application declares.
type Over = { objects: Objects; sources: AnswerSources; programId: Buffer; peiType: number; tasks: DeclaredTasks | null };

// The load-state machine (1 to 15) whose state a System 7 unit answers at memory address `a`, or null.
export const loadStateMachineAt = (a: number): number | null => (a > MM_STATUS_BASE && a <= MM_STATUS_BASE + 15 ? a - MM_STATUS_BASE : null);
// A System 7 unit's load state as memory, which its PID 5 holds at the start.
const loadStateAt = (m: SimUnitCoreModel, a: number) => { const lsm = loadStateMachineAt(a); return lsm === null ? undefined : m.objects.get(lsm)?.get(PID.LOAD_STATE_CONTROL)?.elements?.[0]?.[0]; };

// The octet the donor's own unit holds at address `a` at the start.
function memoryAt(u: UnitModel): (a: number) => number | undefined {
  if (u.kind === "property-mapped") { const m = u.model; return (a) => (m.memory.known[a] ? m.memory.bytes[a] : loadStateAt(m, a)); }
  if (u.kind === "memory-mapped") { const m = u.model; return (a) => m.memory.get(a) ?? loadStateAt(m, a); }
  const m = u.model;
  return (a) => { for (const seg of m.segments.values()) if (a >= seg.at && a < seg.at + seg.size) return seg.bytes[a - seg.at]; return undefined; };
}

// The donor's model with what the catalogue unit puts over it. System B's program id is its object 4 PID 13 alone, and
// its unit takes no task segment.
function overDonor(u: UnitModel, { objects, sources, programId, peiType, tasks }: Over): UnitModel {
  if (u.kind === "property-mapped") return { kind: u.kind, model: { ...u.model, ...tasks, objects, sources, programId, propertyMapped: { ...u.model.propertyMapped, peiType } } };
  if (u.kind === "memory-mapped") return { kind: u.kind, model: { ...u.model, objects, sources, programId, memoryMapped: { ...u.model.memoryMapped, peiType } } };
  return { kind: u.kind, model: { ...u.model, objects, sources } };
}

// What a donor is, as a digest: its collection, its application program (whose segments, tasks and descriptions its
// model reads) and everything tools/sim-units.ts gives it besides. A row names it, so a donor collected again, run on
// another application program or given another behaviour since the row ran is seen.
export function donorDigest(donor: SimUnitSpec): string {
  const plain = (_: string, v: unknown) => (v instanceof Map ? [...v] : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v && typeof v === "object" && (v as { type?: string }).type === "Buffer" ? Buffer.from((v as { data: number[] }).data).toString("hex") : v);
  return createHash("sha256").update(readFileSync(corpusPath(donor.collection))).update(readFileSync(corpusPath(`catalogue/${donor.catalogue}`))).update(JSON.stringify(donor, plain)).digest("hex");
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
  const retired = spec.retiredRule === true && (RETIRED_DONOR_RULES[cfg.mask as Mask] ?? []).includes(spec.rule);
  if (!retired) {
    const why = unfitFor(spec.donor, needs(cfg));
    if (why) refuse(`the donor ${spec.donor.id} does not fit the rule: ${why}`);
  }
  const donor = unitModel(spec.donor);
  const compose = (identity: ProductUnit) => {
    const objects = new Map([...donor.model.objects].map(([o, props]) => [o, new Map(props)]));
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
  let identity = productIdentity(appXml, cfg, { includePropertyHardwareType: !spec.skipPropertyHardwareType });
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
  const programId = identity.properties.get(programIdKey(cfg))!.bytes;
  const sources: AnswerSources = {
    unit: `catalogue unit of ${spec.application} from donor ${spec.donor.id} (${spec.donor.name}), by the rule ${spec.rule}`,
    mask: `product: the application's mask ${cfg.mask}, donor ${spec.donor.id}'s`,
    properties,
    held: `donor ${spec.donor.id}`,
    absent: `neither the product nor donor ${spec.donor.id} gives it`,
    memoryAt: memoryAt(donor),
  };
  if (spec.donor.propertyMapped || spec.donor.memoryMapped) properties.set("PEI type", `product: the application's PEI type ${cfg.appPeiType}`);
  const tasks = spec.donor.propertyMapped ? declaredTasks(fullSteps(cfg.loadProcedures)) : null;
  if (typeof tasks === "string") return refuse(tasks);
  const overlaid = overDonor(donor, { objects, sources, programId: Buffer.from(programId), peiType: cfg.appPeiType, tasks });
  return { spec, identity, objects, properties, make: (opts = {}) => simUnitOf(spec.donor, overlaid, opts) };
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

// The catalogue unit of `application` with its program from a product (a .knxproj or .knxprod holding it, or its
// manufacturer XML), the donor named or its mask's rule's, and what the identity loop learned from each ETS6.log of
// `learnedFrom` in order; or why there is none. tools/sim-unit-serve.ts serves it, tools/ets-driver.ts records it in
// row.json. Throws where the product holds no such program: that is no unit's refusal.
export function catalogueUnitFrom(application: string, product: Buffer, opts: { donor?: string; learnedFrom?: { name: string; log: Buffer }[] } = {}): CatalogueUnitSpec | { refused: string } {
  const appXml = extractAppPrograms(product, [application]).get(application);
  if (appXml === undefined) throw new Error(`the product holds no application program ${application}`);
  const applyLogs = (initial: CatalogueUnitSpec | { refused: string }) => {
    let spec = initial;
    for (const { name, log } of opts.learnedFrom ?? []) {
      if ("refused" in spec) break;
      const r = learnIdentity(spec, log);
      spec = "refused" in r ? { refused: `${name}: ${r.refused}` } : r.spec;
    }
    return spec;
  };
  const base = catalogueUnitSpec(application, appXml, { donor: opts.donor });
  const spec = applyLogs(base);
  if (!("refused" in spec) || "refused" in base || !opts.learnedFrom?.length) return spec;
  // A log recorded without declaredHardwareType pre-seeding names the donor's un-preseeded 0/78 and asks ETS's
  // required value; replay it with skipPropertyHardwareType only when all logs apply cleanly and land on the same 0/78.
  let baseHw: Buffer;
  try { baseHw = answered(catalogueUnit(base).objects)("0/78"); } catch { return spec; }
  const hist = applyLogs(catalogueUnitSpec(application, appXml, { donor: opts.donor, skipPropertyHardwareType: true }));
  if ("refused" in hist) return spec;
  try {
    if (answered(catalogueUnit(hist).objects)("0/78").equals(baseHw)) return hist;
  } catch { /* keep original refusal */ }
  return spec;
}

// How row.json names the catalogue unit.
export function catalogueUnitRecord(unit: CatalogueUnit): CatalogueUnitRecord {
  return { source: "donor", donor: unit.spec.donor.id, donorDigest: donorDigest(unit.spec.donor), rule: unit.spec.rule, identity: unit.spec.learned, properties: Object.fromEntries(unit.properties) };
}
