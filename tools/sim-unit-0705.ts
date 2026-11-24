// A simulated property-mapped System 7 unit (MV-0705) on tools/sim-unit.ts's transport and property core,
// built from a read-only collection of a real unit and the product's application program, as strict as the
// System B unit: what it does not model it refuses, with a reason, and sends nothing in answer.
//
// What differs from System B, from the units' captures (tools/sim-units.ts names them):
// - the load-state machines on PID 5 of objects 1 to 3 (address table, association table, application) take
//   absolute segments: `03 00 <address:2> <size:2> <access> <memory type> <flags> 00` (the stack segment
//   `03 01` in the same form) at the address the request names, and the task segment
//   `03 02 <address:2> <octet> <program id:5>`, and the task control 1 its application declares,
//   `03 04 <address:2> <count> 00 00 00 00 00`, where the unit's captures show one of that count and address place;
//   every one answered LOADING. A load is taken from UNLOADED and from LOADED (the application loaded again without
//   an unload, ETS's partial form); a load completed after an unload needs a segment, a task segment and the task
//   control 1 the application declares for the machine, as every capture sends them;
// - its memory is one address space at fixed addresses: what the collection read, and what is written; an
//   unload forgets the machine's segments and keeps their bytes (a later allocation at the same address
//   holds them, which the CRCs of the memory-control blocks after a download show);
// - a write goes into an EEPROM segment of a machine that is loading, a read into the segments of a machine
//   that is loaded (or loading, the bytes written since its load, where the unit's captures show it answer
//   them), and into the load states at
//   0xB6EA to 0xB6ED (46825 + machine), which hold PID 5;
// - the memory-control block (PID 27) of an object whose unit answers it: one element per segment it reports
//   (`mcbSegments`), in the order allocated, computed at load completed;
// - the table reference (PID 7) after a download: the address of the machine's first segment, where its task
//   segment names the same address;
// - the unload of the application (object 3), and its load while it is loaded, set the device control's
//   application-stopped bit where the unit's captures show it (`unloadStopsApplication`, `loadStopsApplication`),
//   as on System B the unload of object 4;
// - no property but PID 5 and the device control is written; the program id comes with the task segment, which
//   names the start of a segment the machine holds (or the address its application declares for the machine, at
//   the end of a segment or inside one, where the unit's captures show one so), and carries the unit's PEI type and
//   the application it holds.
import { iaToNum, APCI, LSM, MM_STATUS_BASE, PID, STATE } from "../packages/knx/src/index.ts";
import { flattenSteps, parseLoadProcedures, taskCtrl1Of, type CollectPackage, type LdStep, type LoadProcedures } from "../packages/product/src/index.ts";
import { SimUnit, crcConventionOf, mcbCrc, MEMORY_END, type Reply, type SimUnitCoreModel } from "./sim-unit.ts";
import { collectedUnit, type Target, type UnitBehaviour } from "./sim-unit-model.ts";

const refuse = (why: string): never => { throw new Error(`no simulated unit: ${why}`); };

const PID_LOAD_STATE = PID.LOAD_STATE_CONTROL, PID_TABLE_REFERENCE = PID.TABLE_REFERENCE, PID_PROGRAM_ID = PID.PROGRAM_ID, PID_DEVICE_CONTROL = PID.DEVICE_CONTROL, PID_MCB = PID.MCB_TABLE;
const EVENT = { ...LSM, ADDITIONAL: 3 } as const;
const SEGMENT = { DATA: 0x00, STACK: 0x01, TASK: 0x02, TASK_CONTROL_1: 0x04 } as const;
const LSMS = [1, 2, 3];
// The application's load-state machine.
export const APPLICATION_LSM = 3;
const MEMORY_TYPE = { RAM: 2, EEPROM: 3 } as const;
// The segment flag of a segment the unit reports in its memory-control block.
const MCB_FLAG = 0x80;

export interface SimUnit0705Segment { at: number; size: number; access: number; memoryType: number; flags: number }

// What only a property-mapped System 7 unit's captures show besides its UnitBehaviour.
export interface PropertyMappedBehaviour {
  // The longest APDU it takes and gives, where it refuses PID 56.
  maxApdu: number;
  // Whether it answers a memory read into a segment that is loading (with the bytes written there since its
  // load), or refuses it, as no capture shows it answer.
  readsWhileLoading: boolean;
  // The octet between the address and the program id of its task segments (`03 02 <address:2> <octet> <id:5>`).
  peiType: number;
  // Whether the unload of its application (object 3) sets the device control's application-stopped bit
  // (PID 14 bit 0) until its restart; null where no capture shows it, and the device control is then unknown.
  unloadStopsApplication: boolean | null;
  // The same for a load of its application while it is loaded (ETS's partial form); null where no capture shows it,
  // a read of the device control then refused until it is written or the unit restarts.
  loadStopsApplication: boolean | null;
  // Where `loadStopsApplication` is null: whether its captures show its memory writes after such a load answered as
  // before it; where not, they are refused as after an unshown unload.
  writesAfterLoadShown: boolean;
  // The task segments it takes at the address its application declares where that starts no segment it holds, per
  // machine with where the address lies (at the end of a segment, or inside one), as its captures show them; any other
  // task segment names a held segment's start.
  taskSegmentsElsewhere: readonly { lsm: number; place: "end" | "inside" }[];
  // The task controls 1 it takes (`03 04 <address:2> <count> 00 00 00 00 00`, answered LOADING), per machine with their
  // count and where their address lies (0, or against the machine's segments), as its captures show them, each at the
  // address the application declares; any other is refused.
  taskControls1: readonly { lsm: number; count: number; at: TaskControlPlace }[];
  // Which segments its memory-control block reports: those flagged 0x80, each `<size:4> 00 <access> <CRC:2>`
  // ("flagged"), or every EEPROM segment, a flagged one `<size:4> 01 <access> <CRC:2>`, another
  // `<size:4> 00 <access> 00 00` ("eeprom"); null for a unit that refuses its memory-control blocks.
  mcbSegments: "flagged" | "eeprom" | null;
}

export interface SimUnit0705Model extends SimUnitCoreModel {
  // The unit's memory, by address, and which octets of it are known (1).
  memory: { bytes: Buffer; known: Uint8Array };
  // Per load-state machine the segments the unit holds, in the order allocated.
  held: Map<number, SimUnit0705Segment[]>;
  // The CRC convention of its memory-control blocks; null where the unit reports none.
  crcConvention: "ccitt" | "ccitt-false" | null;
  // The application the unit holds (object 3 PID 13), which every task segment carries.
  programId: Buffer;
  // Per load-state machine the address of the task segment and the task control 1 its application declares.
  declaredTaskSegment: Map<number, number>;
  declaredTaskControl1: Map<number, { address: number; count: number }>;
  propertyMapped: PropertyMappedBehaviour;
}

// The octets between size and CRC of a segment's element in the memory-control block, `<octet> <access>`, as
// `mcbSegments` gives them; undefined where the unit reports no element for the segment.
function mcbHead(pm: PropertyMappedBehaviour, s: SimUnit0705Segment): number | undefined {
  const flagged = (s.flags & MCB_FLAG) !== 0;
  if (pm.mcbSegments === null || (pm.mcbSegments === "flagged" ? !flagged : s.memoryType !== MEMORY_TYPE.EEPROM)) return undefined;
  return ((pm.mcbSegments === "eeprom" && flagged ? 1 : 0) << 8) | s.access;
}

// The segment's element, `<size:4> <octet> <access> <CRC:2>`, the CRC only for a flagged segment.
function mcbElement(pm: PropertyMappedBehaviour, s: SimUnit0705Segment, crc: () => number): Buffer | null {
  const head = mcbHead(pm, s);
  if (head === undefined) return null;
  const e = Buffer.alloc(8);
  e.writeUInt32BE(s.size, 0); e.writeUInt16BE(head, 4);
  if (s.flags & MCB_FLAG) e.writeUInt16BE(crc(), 6);
  return e;
}

// A RAM segment flagged for the memory-control block, which no unit's capture shows.
const flaggedRam = (s: SimUnit0705Segment) => (s.flags & MCB_FLAG) !== 0 && s.memoryType === MEMORY_TYPE.RAM;

export function simUnit0705Model(collection: CollectPackage, appXml: string, behaviour: UnitBehaviour, pm: PropertyMappedBehaviour): SimUnit0705Model {
  if (collection.mask !== "MV-0705") refuse(`this model is for MV-0705, not ${collection.mask}`);
  const { records, mask, objects, descriptions, functionStates, memoryExtendedRead } = collectedUnit(collection, appXml, refuse);
  if (collection.maxApdu !== null && collection.maxApdu !== pm.maxApdu) refuse(`the unit reports a maximum APDU of ${collection.maxApdu}, the spec ${pm.maxApdu}`);
  const programId = objects.get(APPLICATION_LSM)?.get(PID_PROGRAM_ID)?.elements?.[0] ?? refuse("the collection did not read the program id (object 3 PID 13)");
  const steps = fullSteps(parseLoadProcedures(appXml));
  const tasks = declaredTasks(steps);
  if (typeof tasks === "string") return refuse(tasks);
  const segments = declaredSegments(steps);
  if (typeof segments === "string") return refuse(segments);

  const bytes = Buffer.alloc(MEMORY_END), known = new Uint8Array(MEMORY_END);
  for (const r of records) {
    const at = (r.target as Target).address;
    if (r.space !== "memory" || r.outcome !== "bytes" || !r.bytes || at === undefined) continue;
    const b = Buffer.from(r.bytes, "hex");
    for (let i = 0; i < b.length; i++) {
      if (known[at + i] && bytes[at + i] !== b[i]) refuse(`the collection read 0x${(at + i).toString(16)} as ${bytes[at + i].toString(16)} and ${b[i].toString(16)}`);
      bytes[at + i] = b[i]; known[at + i] = 1;
    }
  }
  const state = (lsm: number) => objects.get(lsm)?.get(PID_LOAD_STATE)?.elements?.[0]?.[0];
  for (const lsm of [...LSMS, 4]) {
    const at = MM_STATUS_BASE + lsm;
    if (known[at] && bytes[at] !== state(lsm)) refuse(`the unit reports load state ${state(lsm)} on object ${lsm} PID 5 and ${bytes[at]} at 0x${at.toString(16)}`);
    known[at] = 0;
  }

  // Where the unit holds its segments: those its application declares, or where it reports its own in the
  // memory-control block (a table ETS allocated at its own size), there.
  const declared = (lsm: number): SimUnit0705Segment[] => (segments.get(lsm) ?? []).map((s) => ({ ...s }));
  const held = new Map<number, SimUnit0705Segment[]>();
  let crc: "ccitt" | "ccitt-false" | null = null;
  for (const lsm of LSMS) {
    const st = state(lsm);
    if (st === undefined) refuse(`the collection did not read the load state of object ${lsm}`);
    if (st === STATE.UNLOADED) { held.set(lsm, []); continue; }
    if (st !== STATE.LOADED) refuse(`object ${lsm} is in load state ${st}`);
    const mcb = objects.get(lsm)?.get(PID_MCB)?.elements;
    const ref = objects.get(lsm)?.get(PID_TABLE_REFERENCE)?.elements?.[0];
    let segs = declared(lsm);
    const ram = segs.find(flaggedRam);
    if (ram) refuse(`object ${lsm}'s application declares the RAM segment at 0x${ram.at.toString(16)} flagged for the memory-control block, which no capture shows`);
    if (mcb && mcb.length > 0) {
      if (pm.mcbSegments === null) refuse(`the unit reports the memory-control block of object ${lsm}, which its spec says it refuses`);
      const head = (s: SimUnit0705Segment) => mcbHead(pm, s);
      const expected = segs.filter((s) => head(s) !== undefined);
      const reported = mcb.map((e) => ({ size: e.readUInt32BE(0), control: e.readUInt16BE(4) }));
      const same = reported.length === expected.length && reported.every((e, i) => e.size === expected[i].size && e.control === head(expected[i]));
      if (!same) {
        const reportedHead = segs.length === 1 ? head(segs[0]) : undefined;
        if (reportedHead === undefined || reported.length !== 1 || !ref || reported[0].control >> 8 !== reportedHead >> 8) refuse(`the memory-control block of object ${lsm} reports segments its application does not declare`);
        segs = [{ ...segs[0], at: ref!.readUInt16BE(0), size: reported[0].size, access: reported[0].control & 0xff }];
      }
      segs.filter((s) => head(s) !== undefined).forEach((s, i) => {
        const reportedCrc = mcb[i].readUInt16BE(6);
        if (!(s.flags & MCB_FLAG)) { if (reportedCrc !== 0) refuse(`the memory-control block of object ${lsm} reports CRC ${reportedCrc.toString(16)} for the unflagged segment at 0x${s.at.toString(16)}`); return; }
        if (!known.subarray(s.at, s.at + s.size).every((k) => k === 1)) refuse(`the collection did not read the segment of object ${lsm} at 0x${s.at.toString(16)}, whose CRC the unit reports`);
        const seg = bytes.subarray(s.at, s.at + s.size);
        const conv = crcConventionOf(reportedCrc, seg) ?? refuse(`the memory-control block of object ${lsm} reports CRC ${reportedCrc.toString(16)} over the segment at 0x${s.at.toString(16)}, which neither convention gives`);
        if (crc && crc !== conv) refuse("the memory-control blocks take both CRC conventions");
        crc = conv;
      });
    }
    if (ref && (segs.length === 0 || ref.readUInt16BE(0) !== segs[0].at)) refuse(`object ${lsm} references 0x${ref.toString("hex")}, ${segs.length ? `its first segment is at 0x${segs[0].at.toString(16)}` : "it holds no segment"}`);
    held.set(lsm, segs);
  }
  return {
    ...behaviour,
    ia: iaToNum(collection.ia), mask, maxApdu: pm.maxApdu, objects, descriptions, functionStates, memoryExtendedRead,
    crcConvention: crc, memory: { bytes, known }, held, programId: Buffer.from(programId), ...tasks, propertyMapped: pm,
  };
}

export type DeclaredTasks = Pick<SimUnit0705Model, "declaredTaskSegment" | "declaredTaskControl1">;

// The steps of an application's full download (flattenSteps), which the readers below take.
export type FullSteps = LdStep[];
export const fullSteps = (proc: LoadProcedures): FullSteps => flattenSteps(proc, "full");

// An attribute of a load-procedure step as the decimal integer from 0 to `max` it declares, or undefined where it is
// absent or of another form ("", "abc", "1.5").
function intAttr(s: LdStep, name: string, max: number): number | undefined {
  const v = s.attrs[name];
  if (v === undefined || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n <= max ? n : undefined;
}
// A load-state machine (1 to 15), a 16-bit address or size, and an octet.
const lsmAttr = (s: LdStep) => { const n = intAttr(s, "LsmIdx", 15); return n === 0 ? undefined : n; };
const ADDRESS_MAX = 0xffff, OCTET_MAX = 0xff;

// The absolute segments the application's full download declares, per load-state machine in the order declared; or
// why they cannot be read.
export function declaredSegments(steps: FullSteps): Map<number, SimUnit0705Segment[]> | string {
  const out = new Map<number, SimUnit0705Segment[]>();
  for (const s of steps.filter((x) => x.verb === "LdCtrlAbsSegment")) {
    const lsm = lsmAttr(s), at = intAttr(s, "Address", ADDRESS_MAX), size = intAttr(s, "Size", ADDRESS_MAX);
    const access = intAttr(s, "Access", OCTET_MAX), memoryType = intAttr(s, "MemType", OCTET_MAX);
    const flags = s.attrs.SegFlags === undefined ? 0 : intAttr(s, "SegFlags", OCTET_MAX);
    if (lsm === undefined || at === undefined || size === undefined || access === undefined || memoryType === undefined || flags === undefined) {
      return `the application declares an absolute segment ${JSON.stringify(s.attrs)} without a machine, an address, a size, an access, a memory type and flags of their form`;
    }
    (out.get(lsm) ?? out.set(lsm, []).get(lsm)!).push({ at, size, access, memoryType, flags });
  }
  return out;
}

// The task segment and task control 1 of each load-state machine as the application's full download declares them,
// which the unit running it checks a download's against; or why they cannot be read.
export function declaredTasks(steps: FullSteps): DeclaredTasks | string {
  const declaredTaskSegment = new Map<number, number>();
  for (const s of steps.filter((x) => x.verb === "LdCtrlTaskSegment")) {
    const lsm = lsmAttr(s), at = intAttr(s, "Address", ADDRESS_MAX);
    if (lsm === undefined || at === undefined) return `the application declares a task segment ${JSON.stringify(s.attrs)} without a machine and an address of their form`;
    if (declaredTaskSegment.has(lsm)) return `the application declares two task segments for object ${lsm}`;
    declaredTaskSegment.set(lsm, at);
  }
  const declaredTaskControl1 = new Map<number, { address: number; count: number }>();
  for (const s of steps.filter((x) => x.verb === "LdCtrlTaskCtrl1")) {
    // The unit takes the decimal form alone, as for the segments.
    if (lsmAttr(s) === undefined || intAttr(s, "Address", ADDRESS_MAX) === undefined || intAttr(s, "Count", OCTET_MAX) === undefined) return `the application declares a task control 1 ${JSON.stringify(s.attrs)} without a machine, an address and a count of their form`;
    const t = taskCtrl1Of(s);
    if (typeof t === "string") return `the application's task control 1: ${t}`;
    if (declaredTaskControl1.has(t.lsm)) return `the application declares two task controls 1 for object ${t.lsm}`;
    declaredTaskControl1.set(t.lsm, { address: t.address, count: t.count });
  }
  return { declaredTaskSegment, declaredTaskControl1 };
}

// How a refusal names where an address lies against segments.
export const PLACE_TEXT = { start: "at the start of a segment", end: "at the end of a segment", inside: "inside a segment", outside: "outside the segments" } as const;

// Where a task segment at `at` lies against segments: at the start of one, at the end of one, inside one, or outside.
export type TaskSegmentPlace = "start" | "end" | "inside" | "outside";
export function taskSegmentPlace(at: number, segs: readonly { at: number; size: number }[]): TaskSegmentPlace {
  if (segs.some((x) => x.at === at)) return "start";
  if (segs.some((x) => x.at + x.size === at)) return "end";
  return segs.some((x) => at > x.at && at < x.at + x.size) ? "inside" : "outside";
}

// Where a task control 1's address lies: 0 (no task), or against the machine's segments.
export type TaskControlPlace = "zero" | TaskSegmentPlace;
export const taskControlPlace = (at: number, segs: readonly { at: number; size: number }[]): TaskControlPlace => (at === 0 ? "zero" : taskSegmentPlace(at, segs));

// A task segment on load-state machine 5, which ETS never sends (packages/product/src/deviceflash.ts isLsm5TaskSegment:
// the ABB US/U 4.2's and the Gira Tastsensor 3's captures), and Busforge neither.
const PEI_TASK_LSM = 5;

// The forms of the application's full download's task declarations against the absolute segments it declares for
// each machine: each task segment that starts none of them, with where it lies, and each task control 1 with its count
// and where its address lies; or why no unit of its kind takes them: a segment or task declared on a machine other
// than objects 1 to 3 (but the task segment on machine 5 ETS never sends).
export interface DeclaredTaskForms { taskPlaces: { lsm: number; place: Exclude<TaskSegmentPlace, "start"> }[]; taskControls1: { lsm: number; count: number; at: TaskControlPlace }[] }
export function declaredTaskForms(segments: Map<number, readonly { at: number; size: number }[]>, tasks: DeclaredTasks): DeclaredTaskForms | string {
  const machines = new Set([...segments.keys(), ...[...tasks.declaredTaskSegment.keys()].filter((l) => l !== PEI_TASK_LSM), ...tasks.declaredTaskControl1.keys()]);
  const other = [...machines].find((l) => !LSMS.includes(l));
  if (other !== undefined) return `the application declares a segment or task on object ${other}, whose load-state machine no unit of the mask shows`;
  const taskPlaces = [...tasks.declaredTaskSegment].filter(([lsm]) => lsm !== PEI_TASK_LSM).flatMap(([lsm, at]) => {
    const place = taskSegmentPlace(at, segments.get(lsm) ?? []);
    return place === "start" ? [] : [{ lsm, place }];
  });
  const taskControls1 = [...tasks.declaredTaskControl1].map(([lsm, t]) => ({ lsm, count: t.count, at: taskControlPlace(t.address, segments.get(lsm) ?? []) }));
  return { taskPlaces, taskControls1 };
}

export class SimUnit0705 extends SimUnit {
  private readonly bytes: Buffer;
  private readonly known: Uint8Array;
  // The octets written since the load of the machine holding them (1).
  private readonly fresh = new Uint8Array(MEMORY_END);
  private readonly held = new Map<number, SimUnit0705Segment[]>();
  // The address each machine's task segment named since its unload.
  private readonly taskAt = new Map<number, number>();
  // The machines unloaded in this session: their load completed needs a segment and a task segment declared
  // since, as every capture declares them, and the task control 1 their application declares.
  private readonly unloaded = new Set<number>();
  // The machines that took their task control 1 since their unload.
  private readonly taskControlled = new Set<number>();

  constructor(private readonly unit: SimUnit0705Model, assignedIa: number, opts: ConstructorParameters<typeof SimUnit>[2] = {}) {
    super(unit, assignedIa, opts);
    this.bytes = Buffer.from(unit.memory.bytes);
    this.known = Uint8Array.from(unit.memory.known);
    for (const [lsm, segs] of unit.held) this.held.set(lsm, segs.map((s) => ({ ...s })));
  }

  // The octets [at, at + n) of the unit's memory, null where one is not known.
  memory(at: number, n: number): Buffer | null {
    return this.known.subarray(at, at + n).every((k) => k === 1) ? Buffer.from(this.bytes.subarray(at, at + n)) : null;
  }

  // Its captures write PID 5 and the device control, nothing else; the program id comes with the task segment.
  protected override propertyWrite(obj: number, pid: number, count: number, start: number, value: Buffer, reply: Reply): void {
    if (pid !== PID_LOAD_STATE && !(obj === 0 && pid === PID_DEVICE_CONTROL)) { this.refuse(`A_PropertyValue_Write ${obj}/${pid} ${value.toString("hex")}: no capture shows this unit take a write of it`); return; }
    super.propertyWrite(obj, pid, count, start, value, reply);
  }

  protected override loadEvent(obj: number, value: Buffer, what: string): number | null {
    if (!LSMS.includes(obj)) { this.refuse(`${what}: object ${obj}'s load-state machine is not shown`); return null; }
    const prop = this.property(obj, PID_LOAD_STATE)!;
    const state = this.state(obj);
    const set = (s: number) => { prop.elements = [Buffer.from([s])]; return s; };
    switch (value[0]) {
      case EVENT.UNLOAD:
        this.held.set(obj, []);
        this.taskAt.delete(obj);
        this.taskControlled.delete(obj);
        this.unloaded.add(obj);
        if (this.property(obj, PID_TABLE_REFERENCE)?.elements) this.referenceKnown.set(obj, false);
        if (this.property(obj, PID_MCB)?.elements) this.mcbKnown.set(obj, false);
        if (obj === APPLICATION_LSM) this.stopsApplication("unload", this.unit.propertyMapped.unloadStopsApplication);
        return set(STATE.UNLOADED);
      case EVENT.LOAD:
        if (state === STATE.LOADING) { this.refuse(`${what}: a load of a machine that is loading`); return null; }
        if (obj === APPLICATION_LSM && state === STATE.LOADED) this.stopsApplication("load", this.unit.propertyMapped.loadStopsApplication);
        for (const s of this.held.get(obj)!) this.fresh.fill(0, s.at, s.at + s.size);
        return set(STATE.LOADING);
      case EVENT.ADDITIONAL:
        if (state !== STATE.LOADING) { this.refuse(`${what}: an additional load control in state ${state}`); return null; }
        return this.additional(obj, value, what) ? state : null;
      case EVENT.LOAD_COMPLETED:
        if (state !== STATE.LOADING) { this.refuse(`${what}: load completed in state ${state}`); return null; }
        return this.complete(obj, what) ? set(STATE.LOADED) : null;
    }
    this.refuse(`${what}: load-state event ${value[0]}`);
    return null;
  }

  private additional(obj: number, value: Buffer, what: string): boolean {
    const segs = this.held.get(obj)!;
    if (value[1] === SEGMENT.DATA || value[1] === SEGMENT.STACK) {
      if (value.length !== 10 || value[9] !== 0) { this.refuse(`${what}: a segment allocation of another form`); return false; }
      const s: SimUnit0705Segment = { at: value.readUInt16BE(2), size: value.readUInt16BE(4), access: value[6], memoryType: value[7], flags: value[8] };
      if (s.size === 0 || s.at + s.size > MEMORY_END) { this.refuse(`${what}: ${s.size} octets at 0x${s.at.toString(16)}`); return false; }
      if (s.memoryType !== MEMORY_TYPE.RAM && s.memoryType !== MEMORY_TYPE.EEPROM) { this.refuse(`${what}: memory type ${s.memoryType}`); return false; }
      if (value[1] === SEGMENT.STACK && s.memoryType !== MEMORY_TYPE.RAM) { this.refuse(`${what}: a stack segment outside RAM`); return false; }
      if (flaggedRam(s)) { this.refuse(`${what}: a RAM segment flagged for the memory-control block, which no capture shows`); return false; }
      const other = [...this.held].flatMap(([lsm, l]) => l.map((x) => [lsm, x] as const)).find(([, x]) => s.at < x.at + x.size && x.at < s.at + s.size);
      if (other) { this.refuse(`${what}: ${s.size} octets at 0x${s.at.toString(16)} reach into a segment of object ${other[0]} at 0x${other[1].at.toString(16)}`); return false; }
      this.fresh.fill(0, s.at, s.at + s.size);
      segs.push(s);
      return true;
    }
    if (value[1] === SEGMENT.TASK) {
      if (value.length !== 10) { this.refuse(`${what}: a task segment of another form`); return false; }
      const at = value.readUInt16BE(2), id = value.subarray(5, 10);
      if (segs.length === 0) { this.refuse(`${what}: a task segment where object ${obj} holds no segment`); return false; }
      const place = taskSegmentPlace(at, segs);
      if (place !== "start") {
        if (place === "outside") { this.refuse(`${what}: a task segment at 0x${at.toString(16)}, ${PLACE_TEXT.outside} object ${obj} holds`); return false; }
        if (this.unit.declaredTaskSegment.get(obj) !== at) { this.refuse(`${what}: a task segment at 0x${at.toString(16)}, ${PLACE_TEXT[place]} of object ${obj}, which the application does not declare`); return false; }
        if (!this.unit.propertyMapped.taskSegmentsElsewhere.some((t) => t.lsm === obj && t.place === place)) { this.refuse(`${what}: a task segment at 0x${at.toString(16)}, ${PLACE_TEXT[place]} of object ${obj}, which no capture shows the unit take`); return false; }
      }
      if (value[4] !== this.unit.propertyMapped.peiType) { this.refuse(`${what}: a task segment of PEI type ${value[4]}, where the unit's captures carry ${this.unit.propertyMapped.peiType}`); return false; }
      if (!id.equals(this.unit.programId)) { this.refuse(`${what}: a task segment for application ${id.toString("hex")}, where the unit holds ${this.unit.programId.toString("hex")}`); return false; }
      this.taskAt.set(obj, at);
      return true;
    }
    if (value[1] === SEGMENT.TASK_CONTROL_1 && this.unit.propertyMapped.taskControls1.length) {
      if (value.length !== 10 || value.subarray(5).some((b) => b !== 0)) { this.refuse(`${what}: a task control 1 of another form`); return false; }
      const declared = this.unit.declaredTaskControl1.get(obj);
      const at = value.readUInt16BE(2), count = value[4];
      if (!declared || declared.address !== at || declared.count !== count) { this.refuse(`${what}: a task control 1 at 0x${at.toString(16)} with count ${count}, which the application does not declare for object ${obj}`); return false; }
      const place = taskControlPlace(at, segs);
      if (!this.unit.propertyMapped.taskControls1.some((t) => t.lsm === obj && t.count === count && t.at === place)) { this.refuse(`${what}: a task control 1 of object ${obj} with count ${count} at ${place === "zero" ? "address 0" : `an address ${PLACE_TEXT[place]}`}, which no capture shows the unit take`); return false; }
      this.taskControlled.add(obj);
      return true;
    }
    this.refuse(`${what}: additional load control 0x${value[1].toString(16)} is not shown on this unit`);
    return false;
  }

  private complete(obj: number, what: string): boolean {
    const segs = this.held.get(obj)!;
    if (this.unloaded.has(obj) && (segs.length === 0 || !this.taskAt.has(obj))) { this.refuse(`${what}: load completed after an unload without a segment and a task segment declared, which no capture shows`); return false; }
    if (this.unloaded.has(obj) && this.unit.declaredTaskControl1.has(obj) && !this.taskControlled.has(obj)) { this.refuse(`${what}: load completed after an unload without the task control 1 the application declares for object ${obj}, which no capture shows`); return false; }
    const mcb = this.property(obj, PID_MCB);
    if (mcb?.elements) {
      const crc = this.unit.crcConvention;
      const flagged = segs.filter((s) => s.flags & MCB_FLAG);
      if (!crc) { this.refuse(`${what}: the unit reports a memory-control block whose CRC convention its collection does not show`); return false; }
      const unknown = flagged.find((s) => !this.memory(s.at, s.size));
      if (unknown) { this.refuse(`${what}: the segment at 0x${unknown.at.toString(16)} holds octets no write set and the unit was not shown to hold, so its CRC is not known`); return false; }
      mcb.elements = segs.flatMap((s) => mcbElement(this.unit.propertyMapped, s, () => mcbCrc(crc, this.bytes.subarray(s.at, s.at + s.size))) ?? []);
      mcb.countKnown = true;
      this.mcbKnown.set(obj, true);
    }
    const ref = this.property(obj, PID_TABLE_REFERENCE);
    const width = ref?.elements?.[0]?.length;
    if (width && this.referenceKnown.get(obj) === false && segs[0] && this.taskAt.get(obj) === segs[0].at) {
      const at = Buffer.alloc(width); at.writeUIntBE(segs[0].at, 0, width);
      ref!.elements = [at];
      this.referenceKnown.set(obj, true);
    }
    return true;
  }

  // The machine and segment holding [addr, addr + n), or null.
  private heldAt(addr: number, n: number): [number, SimUnit0705Segment] | null {
    for (const [lsm, l] of this.held) for (const s of l) if (addr >= s.at && addr + n <= s.at + s.size) return [lsm, s];
    return null;
  }

  protected override memoryRead(n: number, addr: number, reply: Reply): void {
    const what = `A_Memory_Read ${n} at 0x${addr.toString(16)}`;
    if (n === 0) { this.refuse(`${what}: a read of no octet`); return; }
    const head = Buffer.from([addr >> 8, addr & 0xff]);
    if (addr > MM_STATUS_BASE && addr + n <= MM_STATUS_BASE + 1 + 4) {
      const states = Array.from({ length: n }, (_, i) => this.property(addr - MM_STATUS_BASE + i, PID_LOAD_STATE)?.elements?.[0]?.[0]);
      if (states.some((x) => x === undefined)) { this.refuse(`${what}: the load state of a machine the unit was not read on`); return; }
      reply(APCI.MEMORY_RESPONSE, Buffer.concat([head, Buffer.from(states as number[])]), n);
      return;
    }
    const hit = this.heldAt(addr, n);
    const data = this.memory(addr, n);
    const state = hit ? this.state(hit[0]) : null;
    const freshlyWritten = this.unit.propertyMapped.readsWhileLoading && this.fresh.subarray(addr, addr + n).every((f) => f === 1);
    if (hit && state !== STATE.LOADED && !(state === STATE.LOADING && freshlyWritten)) { this.refuse(`${what}: into the segment of object ${hit[0]} while it is in load state ${this.state(hit[0])}, where no capture shows the unit answer a read of these octets`); return; }
    if (!hit || !data) { this.refuse(`${what}: outside the memory the unit is known to hold in its segments`); return; }
    reply(APCI.MEMORY_RESPONSE, Buffer.concat([head, data]), n);
  }

  protected override memoryWrite(n: number, addr: number, data: Buffer, reply: Reply): void {
    const what = `A_Memory_Write ${n} at 0x${addr.toString(16)}`;
    if (n === 0 || data.length !== n) { this.refuse(`${what}: ${data.length} octets of data`); return; }
    if (this.deviceControlUnknown && !(this.deviceControlUnknown === "load" && this.unit.propertyMapped.writesAfterLoadShown)) { this.refuse(`${what}: whether the unit echoes it is not known, its device control after the application's ${this.deviceControlUnknown} not shown`); return; }
    const hit = this.heldAt(addr, n);
    if (!hit) { this.refuse(`${what}: outside an allocated segment`); return; }
    if (this.state(hit[0]) !== STATE.LOADING) { this.refuse(`${what}: into the segment of object ${hit[0]} while it is not loading`); return; }
    if (hit[1].memoryType !== MEMORY_TYPE.EEPROM) { this.refuse(`${what}: into a RAM segment, which no capture shows written`); return; }
    data.copy(this.bytes, addr);
    this.known.fill(1, addr, addr + n);
    this.fresh.fill(1, addr, addr + n);
    this.verifyEcho(addr, this.bytes.subarray(addr, addr + n), reply);
  }
}
