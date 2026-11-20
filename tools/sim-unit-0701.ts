// A simulated memory-mapped System 7 unit (MV-0701, BIM M112) on the transport core of tools/sim-unit.ts: the
// same connection, descriptor, authorization and property services, with the load-state machines this mask
// keeps in memory. Its load controls are 11-octet A_Memory_Write frames to 0x0104 (the LSM in the high nibble
// of the first octet, the event in the low one), each machine's state is the octet at 0xB6E9 + LSM, and a tool
// reads memory before it writes and writes only what differs (docs/load-procedures.md, "The Meteodata 140 S,
// memory-mapped").
//
// Its memory is what the unit's collection read, octet by octet; nothing else. A read of an octet the
// collection did not read is refused, naming the read that would close it. What it models beyond the core:
// - each load-state machine's state, from its PID 5 in the collection (the unit's single-octet read of the
//   state answers it, its captures show), moved by the events unload, load, load completed;
// - the declarations of the additional load control (absolute segment, task segment and the further codes the
//   unit's captures show), each taken only while its machine is loading and answered by nothing;
// - memory writes into a segment of a machine that is loading, answered by nothing: these units take no
//   verify mode in their captures, and a tool reads back what it wrote;
// - the restart, as the core models it;
// - what only a unit's captures show besides (MemoryMappedBehaviour): its tables' PID 7 after a declaration, the
//   address table's count after the declaration, a download marker it clears at the restart.
// Everything else is refused, as the core refuses: a PID 5 write (the load controls go to 0x0104), PID 5 of a
// machine after one of its events in the session, a read of more than one state octet, a write in verify mode.
import { flattenSteps, lsmIdx, parseLoadProcedures, stepAddress, stepSize, type CollectPackage } from "../packages/product/src/index.ts";
import { collectedUnit, type UnitBehaviour } from "./sim-unit-model.ts";
import { SimUnit, type Reply, type SimUnitModel } from "./sim-unit.ts";
import { APCI, iaToNum } from "../packages/knx/src/index.ts";

const LOAD_CONTROL = 0x0104, LOAD_CONTROL_LENGTH = 11;
// The state of LSM n is the octet at STATE_BASE + n.
const STATE_BASE = 0xb6e9;
const LSMS = [1, 2, 3, 4];
const STATE = { UNLOADED: 0, LOADED: 1, LOADING: 2 } as const;
const EVENT = { LOAD: 1, LOAD_COMPLETED: 2, ADDITIONAL: 3, UNLOAD: 4 } as const;
const VERIFY_MODE = 0x04;

export interface Segment0701 { at: number; size: number }

// The additional load controls (event 3) the unit is shown to take, by their second octet, and what they declare.
export type AdditionalControl = "absolute-segment" | "task-segment" | "task-control-1";
const ADDITIONAL: Record<number, AdditionalControl> = { 0: "absolute-segment", 2: "task-segment", 4: "task-control-1" };

export interface SimUnit0701Model extends Omit<SimUnitModel, "segments" | "mcbControl" | "crc"> {
  // The octets the collection read, by address.
  memory: Map<number, number>;
  // Per load-state machine whose PID 5 the collection read: its state.
  states: Map<number, number>;
  // Per load-state machine, the absolute segments the application declares for it: where a unit that holds the
  // application loaded takes writes before a tool declares the machine's segments again.
  appSegments: Map<number, Segment0701[]>;
  memoryMapped: MemoryMappedBehaviour;
}

// What only a memory-mapped unit's captures show besides UnitBehaviour.
export interface MemoryMappedBehaviour {
  // The longest APDU it takes and gives (it has no PID 56).
  maxApdu: number;
  additional: AdditionalControl[];
  // Whether, after a load event, its tables' PID 7 (objects 1 and 2) reports the address the table was declared at.
  tableReferenceFollows: boolean;
  // What the first octet of the address table's segment (the table's count) reads after load-state machine 1 is
  // unloaded and its segment declared again, or null where it keeps the octet it held. Its captures read it only
  // after the declaration, so which of the unload, the load and the declaration sets it is not shown: the octet
  // is unknown from the unload until the declaration.
  addressTableCountOnDeclaration: number | null;
  // Octets a download writes that the unit then clears itself: address -> what it reads after the restart that
  // follows a write of it (a download marker, docs/load-procedures.md R17). Within the session the octet reads
  // as written.
  clearedByRestart: Map<number, number>;
}

export function simUnit0701Model(collection: CollectPackage, appXml: string, behaviour: UnitBehaviour, mm: MemoryMappedBehaviour): SimUnit0701Model {
  const refuse = (why: string): never => { throw new Error(`no simulated unit: ${why}`); };
  if (collection.mask !== "MV-0701") refuse(`only the memory-mapped System 7 mask MV-0701 is modelled here, not ${collection.mask}`);
  const { mask, objects, descriptions, records } = collectedUnit(collection, appXml, refuse);
  if (collection.maxApdu !== null && collection.maxApdu !== mm.maxApdu) refuse(`the unit reports a maximum APDU of ${collection.maxApdu}, the spec ${mm.maxApdu}`);

  const memory = new Map<number, number>();
  for (const r of records) {
    if (r.space !== "memory" || r.outcome !== "bytes" || r.target.address === undefined || !r.bytes) continue;
    Buffer.from(r.bytes, "hex").forEach((b, i) => {
      const at = r.target.address! + i;
      // The state octets are not memory: the unit answers a read of more than one of them otherwise than
      // their single reads (the ABB US/U 4.2's four-octet read 01000000 against PID 5 01, 01, 01).
      if (at > STATE_BASE && at <= STATE_BASE + LSMS.length) return;
      const had = memory.get(at);
      if (had !== undefined && had !== b) refuse(`memory at 0x${at.toString(16)} read ${had.toString(16)} and ${b.toString(16)}`);
      memory.set(at, b);
    });
  }
  const states = new Map<number, number>();
  for (const lsm of LSMS) {
    const s = objects.get(lsm)?.get(5)?.elements?.[0];
    if (s?.length === 1) states.set(lsm, s[0]);
  }
  const appSegments = new Map<number, Segment0701[]>();
  for (const s of flattenSteps(parseLoadProcedures(appXml), "full")) {
    if (s.verb !== "LdCtrlAbsSegment") continue;
    const lsm = lsmIdx(s), at = stepAddress(s), size = stepSize(s);
    if (lsm === undefined || at === undefined || size === undefined) refuse(`the application declares an absolute segment without its machine, address or size`);
    (appSegments.get(lsm!) ?? appSegments.set(lsm!, []).get(lsm!)!).push({ at: at!, size: size! });
  }
  return { ia: iaToNum(collection.ia), mask, maxApdu: mm.maxApdu, objects, descriptions, memory, states, appSegments, memoryMapped: mm, ...behaviour };
}

interface Machine {
  state: number | null;
  // The segments writes may go to: those declared since the machine's unload in this session, else the
  // application's where the unit holds the machine loaded.
  segments: Segment0701[];
  // Whether an event of this session moved the machine, so that its PID 5 no longer answers as collected.
  moved: boolean;
}

export class SimUnit0701 extends SimUnit {
  private readonly memory: Map<number, number>;
  private readonly machines = new Map<number, Machine>();
  // The octets a memory write set since the last restart.
  private readonly written = new Set<number>();

  constructor(private readonly model0701: SimUnit0701Model, assignedIa: number, opts: ConstructorParameters<typeof SimUnit>[2] = {}) {
    super({ ...model0701, segments: new Map() }, assignedIa, opts);
    this.memory = new Map(model0701.memory);
    for (const lsm of LSMS) {
      const state = model0701.states.get(lsm) ?? null;
      // A machine the unit holds loaded keeps the segments its application declared.
      this.machines.set(lsm, { state, segments: state === STATE.LOADED ? [...(model0701.appSegments.get(lsm) ?? [])] : [], moved: false });
    }
  }

  // The unit's memory at [at, at + n), or null where an octet of it is not known.
  read(at: number, n: number): Buffer | null {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) { const b = this.memory.get(at + i); if (b === undefined) return null; out[i] = b; }
    return out;
  }

  // Every octet of the unit's memory that is known, by address.
  memorySnapshot(): Map<number, number> { return new Map(this.memory); }

  // A load-state machine's state, or null where it is not known.
  loadState(lsm: number): number | null { return this.machines.get(lsm)?.state ?? null; }

  protected override restartRefusal(): string | null {
    const loading = LSMS.filter((l) => this.machines.get(l)!.state === STATE.LOADING);
    return loading.length ? `with load-state machine ${loading.join(", ")} loading; what the unit holds after that is not shown` : null;
  }

  protected override propertyRead(obj: number, pid: number, count: number, start: number, reply: Reply): void {
    if (pid === 5 && this.machines.get(obj)?.moved) { this.refuse(`A_PropertyValue_Read ${obj}/5 after a load event of its machine at 0x${LOAD_CONTROL.toString(16).padStart(4, "0")}: whether the unit's PID 5 follows its state there is not shown`); return; }
    if (pid === 7 && this.machines.get(obj)?.moved) {
      const declared = this.machines.get(obj)!.segments[0]?.at;
      const collected = this.property(obj, 7)?.elements?.[0];
      const shown = this.model0701.memoryMapped.tableReferenceFollows && (obj === 1 || obj === 2) && collected?.length === 2 && declared === collected.readUInt16BE(0);
      if (!shown) { this.refuse(`A_PropertyValue_Read ${obj}/7 after a load event of its machine${declared === undefined ? "" : `, its first segment declared at 0x${declared.toString(16)}`}: what the unit reports there then is not shown`); return; }
    }
    super.propertyRead(obj, pid, count, start, reply);
  }

  protected override propertyWrite(obj: number, pid: number, count: number, start: number, value: Buffer, reply: Reply): void {
    if (pid === 5) { this.refuse(`A_PropertyValue_Write ${obj}/5 ${value.toString("hex")}: the unit's load controls go to memory 0x0104, a PID 5 write is not shown`); return; }
    super.propertyWrite(obj, pid, count, start, value, reply);
  }

  protected override memoryRead(n: number, addr: number, reply: Reply): void {
    const what = `A_Memory_Read ${n} at 0x${addr.toString(16)}`;
    if (n === 0) { this.refuse(`${what}: a read of no octet`); return; }
    const lsm = addr - STATE_BASE;
    if (addr + n > STATE_BASE + 1 && addr <= STATE_BASE + LSMS.length) {
      if (n !== 1 || !LSMS.includes(lsm)) { this.refuse(`${what}: a read of the load states other than one state octet, which the unit answers otherwise than their single reads`); return; }
      const state = this.machines.get(lsm)!.state;
      if (state === null) { this.refuse(`${what}: the state of load-state machine ${lsm} is not known; the collection did not read object ${lsm} PID 5`); return; }
      reply(APCI.MEMORY_RESPONSE, Buffer.from([addr >> 8, addr & 0xff, state]), n);
      return;
    }
    if (addr <= LOAD_CONTROL + LOAD_CONTROL_LENGTH - 1 && addr + n > LOAD_CONTROL) { this.refuse(`${what}: into the load control at 0x0104, which does not read back what was written`); return; }
    const bytes = this.read(addr, n);
    if (!bytes) {
      const missing = Array.from({ length: n }, (_, i) => addr + i).filter((a) => !this.memory.has(a));
      this.refuse(`${what}: the collection did not read ${missing.length === 1 ? `0x${missing[0].toString(16)}` : `0x${missing[0].toString(16)}-0x${missing.at(-1)!.toString(16)}`}; a collect read of A_Memory_Read ${n} at 0x${addr.toString(16)} closes it`);
      return;
    }
    reply(APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([addr >> 8, addr & 0xff]), bytes]), n);
  }

  protected override memoryWrite(n: number, addr: number, data: Buffer, _reply: Reply): void {
    const what = `A_Memory_Write ${n} at 0x${addr.toString(16)} ${data.toString("hex")}`;
    if (n === 0 || data.length !== n) { this.refuse(`${what}: ${data.length} octets of data`); return; }
    const control = this.property(0, 14)!.elements![0][0];
    if (control & VERIFY_MODE) { this.refuse(`${what} in verify mode: how the unit answers a write then is not shown`); return; }
    if (addr === LOAD_CONTROL && n === LOAD_CONTROL_LENGTH) { this.loadControl(data, what); return; }
    if (addr <= LOAD_CONTROL + LOAD_CONTROL_LENGTH - 1 && addr + n > LOAD_CONTROL) { this.refuse(`${what}: the load control at 0x0104 takes ${LOAD_CONTROL_LENGTH} octets at once`); return; }
    if (addr + n > STATE_BASE + 1 && addr <= STATE_BASE + LSMS.length) { this.refuse(`${what}: into the load states`); return; }
    const owner = LSMS.find((l) => this.machines.get(l)!.segments.some((s) => addr >= s.at && addr + n <= s.at + s.size));
    if (owner === undefined) { this.refuse(`${what}: outside every segment a load-state machine holds`); return; }
    const state = this.machines.get(owner)!.state;
    if (state !== STATE.LOADING) { this.refuse(`${what}: into a segment of load-state machine ${owner} in state ${state}`); return; }
    data.forEach((b, i) => { this.memory.set(addr + i, b); this.written.add(addr + i); });
  }

  protected override restart(partner: number): void {
    super.restart(partner);
    for (const [at, value] of this.model0701.memoryMapped.clearedByRestart) if (this.written.has(at)) this.memory.set(at, value);
    this.written.clear();
  }

  private loadControl(data: Buffer, what: string): void {
    const lsm = data[0] >> 4, event = data[0] & 0x0f;
    const m = this.machines.get(lsm);
    if (!m) { this.refuse(`${what}: load-state machine ${lsm}`); return; }
    if (m.state === null) { this.refuse(`${what}: the state of load-state machine ${lsm} is not known; the collection did not read object ${lsm} PID 5`); return; }
    switch (event) {
      case EVENT.UNLOAD:
        if (lsm === 1 && this.model0701.memoryMapped.addressTableCountOnDeclaration !== null) for (const s of m.segments) this.memory.delete(s.at);
        Object.assign(m, { state: STATE.UNLOADED, segments: [], moved: true });
        this.note(`load-state machine ${lsm} unloaded`);
        return;
      case EVENT.LOAD:
        // The unit takes a load of a loaded machine and reports it loading (the ABB US/U 4.2's partial form loads
        // its application without unloading it).
        if (m.state !== STATE.UNLOADED && m.state !== STATE.LOADED) { this.refuse(`${what}: a load of a machine in state ${m.state}`); return; }
        Object.assign(m, { state: STATE.LOADING, moved: true });
        return;
      case EVENT.LOAD_COMPLETED:
        if (m.state !== STATE.LOADING) { this.refuse(`${what}: load completed in state ${m.state}`); return; }
        Object.assign(m, { state: STATE.LOADED, moved: true });
        return;
      case EVENT.ADDITIONAL: {
        if (m.state !== STATE.LOADING) { this.refuse(`${what}: an additional load control in state ${m.state}`); return; }
        const kind = ADDITIONAL[data[1]];
        if (!kind || !this.model0701.memoryMapped.additional.includes(kind)) { this.refuse(`${what}: additional load control ${data[1]}, which the unit's captures do not show it taking`); return; }
        if (kind === "absolute-segment") {
          const at = data.readUInt16BE(3), size = data.readUInt16BE(5);
          if (size === 0) { this.refuse(`${what}: a segment of no octet`); return; }
          const other = LSMS.find((l) => l !== lsm && this.machines.get(l)!.segments.some((s) => at < s.at + s.size && s.at < at + size));
          if (other !== undefined) { this.refuse(`${what}: a segment reaching into one of load-state machine ${other}`); return; }
          const count = this.model0701.memoryMapped.addressTableCountOnDeclaration;
          if (lsm === 1 && count !== null && m.segments.length === 0) this.memory.set(at, count);
          m.segments.push({ at, size });
        }
        return;
      }
    }
    this.refuse(`${what}: load-state event ${event}`);
  }
}
