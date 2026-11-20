// A simulated memory-mapped System 7 unit (MV-0701, BIM M112) on the transport core of tools/sim-unit.ts: the
// same connection, descriptor, authorization and property reads, with the load-state machines this mask keeps
// in memory. Its load controls are 11-octet A_Memory_Write frames to 0x0104 (the LSM in the high nibble of the
// first octet, the event in the low one), each machine's state is the octet at 46825 + LSM, and a tool reads
// memory before it writes and writes only what differs (docs/load-procedures.md, "The Meteodata 140 S,
// memory-mapped").
//
// Its memory is what the unit's collection read, octet by octet; nothing else. A read of an octet the
// collection did not read is refused, naming the read that would close it. What it models beyond the core:
// - each load-state machine's state, from its PID 5 in the collection (the unit's single-octet read of the
//   state answers it, its captures show), moved by the events unload, load, load completed;
// - the additional load controls its captures show, each only while its machine is loading and answered by
//   nothing, each field checked against what the captures hold: the absolute segment, the task segment (at a
//   declared segment, with the unit's program id and the PEI type its captures carry), task control 1;
// - after an unload, load completed only once an absolute segment and the task segment were declared, as every
//   capture declares them;
// - memory writes into an EEPROM segment of a machine that is loading, answered by nothing: these units take no
//   verify mode in their captures, and a tool reads back what it wrote;
// - the restart, as the core models it;
// - what only a unit's captures show besides (MemoryMappedBehaviour).
// Everything else is refused: a property write (none is shown on these units; the load controls go to 0x0104),
// PID 5 and the device control after an event of the session, a read of more than one state octet, a write in
// verify mode, memory past 0xFFFF.
import { APCI, LSM, MM_CTRL_ADDR, MM_STATUS_BASE, STATE, VERIFY_MODE, iaToNum } from "../packages/knx/src/index.ts";
import { flattenSteps, lsmIdx, memType, parseLoadProcedures, stepAddress, stepSize, unreadableReason, type CollectPackage } from "../packages/product/src/index.ts";
import { collectedUnit, type UnitBehaviour } from "./sim-unit-model.ts";
import { SimUnit, type Reply, type SimUnitCoreModel } from "./sim-unit.ts";

// A load control is 11 octets (packages/knx/src/flash.ts); the event of the additional load controls.
const LOAD_CONTROL_LENGTH = 11, ADDITIONAL = 3;
const LSMS = [1, 2, 3, 4];
const STATES_AT = MM_STATUS_BASE + 1, STATES_END = MM_STATUS_BASE + 1 + LSMS.length;
// The reach of A_Memory_Read and A_Memory_Write: a 16-bit address.
const MEMORY_END = 0x10000;
// The memory type of every segment the units' captures write (MemType="3" in their applications).
const WRITTEN_MEMORY_TYPE = 3;
const PID_LOAD_STATE = 5, PID_TABLE_REFERENCE = 7, PID_PROGRAM_ID = 13, PID_DEVICE_CONTROL = 14;
const APPLICATION_OBJECT = 3;

export interface Segment0701 { at: number; size: number; memType: number }

// The additional load controls (event 3) by their second octet.
export type AdditionalControl = "absolute-segment" | "task-segment" | "task-control-1";
const ADDITIONAL_CONTROLS: Record<number, AdditionalControl> = { 0: "absolute-segment", 2: "task-segment", 4: "task-control-1" };

// What only a memory-mapped unit's captures show besides UnitBehaviour.
export interface MemoryMappedBehaviour {
  // The longest APDU it takes and gives (it has no PID 56).
  maxApdu: number;
  // The additional load controls it takes.
  additional: AdditionalControl[];
  // The PEI type octet of its task segments.
  peiType: number;
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

export interface SimUnit0701Model extends SimUnitCoreModel {
  // The octets the collection read, by address.
  memory: Map<number, number>;
  // Per load-state machine whose PID 5 the collection read: its state.
  states: Map<number, number>;
  // Per load-state machine, the absolute segments the application declares for it: where a unit that holds the
  // application loaded takes writes before a tool declares the machine's segments again.
  appSegments: Map<number, Segment0701[]>;
  // The application the unit holds (object 3 PID 13), which its task segments carry.
  programId: Buffer;
  memoryMapped: MemoryMappedBehaviour;
}

export function simUnit0701Model(collection: CollectPackage, appXml: string, behaviour: UnitBehaviour, mm: MemoryMappedBehaviour): SimUnit0701Model {
  const refuse = (why: string): never => { throw new Error(`no simulated unit: ${why}`); };
  if (collection.mask !== "MV-0701") refuse(`only the memory-mapped System 7 mask MV-0701 is modelled here, not ${collection.mask}`);
  const { mask, objects, descriptions, functionStates, memoryExtendedRead, records } = collectedUnit(collection, appXml, refuse);
  if (behaviour.restart.basic?.tAck === "unless-application-loaded") refuse("a T_Ack that depends on the application's PID 5 load events, which this mask does not take");
  if (collection.maxApdu !== null && collection.maxApdu !== mm.maxApdu) refuse(`the unit reports a maximum APDU of ${collection.maxApdu}, the spec ${mm.maxApdu}`);
  const programId = objects.get(APPLICATION_OBJECT)?.get(PID_PROGRAM_ID)?.elements?.[0];
  if (!programId) refuse("the collection did not read the program id (object 3 PID 13)");

  const memory = new Map<number, number>();
  for (const r of records) {
    if (r.space !== "memory" || r.outcome !== "bytes" || r.target.address === undefined || !r.bytes) continue;
    Buffer.from(r.bytes, "hex").forEach((b, i) => {
      const at = r.target.address! + i;
      // The state octets are not memory: the unit answers a read of more than one of them otherwise than
      // their single reads (the ABB US/U 4.2's four-octet read 01000000 against PID 5 01, 01, 01).
      if (at >= STATES_AT && at < STATES_END) return;
      const had = memory.get(at);
      if (had !== undefined && had !== b) refuse(`memory at 0x${at.toString(16)} read ${had.toString(16)} and ${b.toString(16)}`);
      memory.set(at, b);
    });
  }
  const states = new Map<number, number>();
  for (const lsm of LSMS) {
    const s = objects.get(lsm)?.get(PID_LOAD_STATE)?.elements?.[0];
    if (s?.length === 1) states.set(lsm, s[0]);
  }
  const appSegments = new Map<number, Segment0701[]>();
  for (const s of flattenSteps(parseLoadProcedures(appXml), "full")) {
    if (s.verb !== "LdCtrlAbsSegment") continue;
    const lsm = lsmIdx(s), at = stepAddress(s), size = stepSize(s), type = memType(s);
    if (lsm === undefined || at === undefined || size === undefined || type === undefined) refuse(`the application declares an absolute segment without its machine, address, size or memory type`);
    (appSegments.get(lsm!) ?? appSegments.set(lsm!, []).get(lsm!)!).push({ at: at!, size: size!, memType: type! });
  }
  return { ia: iaToNum(collection.ia), mask, maxApdu: mm.maxApdu, objects, descriptions, functionStates, memoryExtendedRead, memory, states, appSegments, programId: Buffer.from(programId!), memoryMapped: mm, ...behaviour };
}

interface Machine {
  state: number | null;
  // The segments writes may go to: those declared since the machine's unload in this session, else the
  // application's where the unit holds the machine loaded.
  segments: Segment0701[];
  // Whether an event of this session moved the machine, so that its PID 5 no longer answers as collected.
  moved: boolean;
  // Whether the session unloaded the machine, and what it declared since.
  unloaded: boolean;
  taskSegment: boolean;
}

export class SimUnit0701 extends SimUnit {
  private readonly memory: Map<number, number>;
  private readonly machines = new Map<number, Machine>();
  // The octets a memory write set since the last restart.
  private readonly written = new Set<number>();
  // Whether a load event or a restart happened in the session: the device control no longer reads as collected.
  private changed = false;

  constructor(private readonly model0701: SimUnit0701Model, assignedIa: number, opts: ConstructorParameters<typeof SimUnit>[2] = {}) {
    super(model0701, assignedIa, opts);
    this.memory = new Map(model0701.memory);
    for (const lsm of LSMS) {
      const state = model0701.states.get(lsm) ?? null;
      // A machine the unit holds loaded keeps the segments its application declared.
      this.machines.set(lsm, { state, segments: state === STATE.LOADED ? [...(model0701.appSegments.get(lsm) ?? [])] : [], moved: false, unloaded: false, taskSegment: false });
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

  protected override restart(partner: number): void {
    super.restart(partner);
    this.changed = true;
    for (const [at, value] of this.model0701.memoryMapped.clearedByRestart) if (this.written.has(at)) this.memory.set(at, value);
    this.written.clear();
  }

  protected override propertyRead(obj: number, pid: number, count: number, start: number, reply: Reply): void {
    const what = `A_PropertyValue_Read ${obj}/${pid}`;
    if (pid === PID_LOAD_STATE && this.machines.get(obj)?.moved) { this.refuse(`${what} after a load event of its machine at 0x0104: whether the unit's PID 5 follows its state there is not shown`); return; }
    if (obj === 0 && pid === PID_DEVICE_CONTROL && this.changed) { this.refuse(`${what} after a load event or a restart: no capture of this mask reads the device control then`); return; }
    if (pid === PID_TABLE_REFERENCE && this.machines.get(obj)?.moved) {
      const declared = this.machines.get(obj)!.segments[0]?.at;
      const collected = this.property(obj, PID_TABLE_REFERENCE)?.elements?.[0];
      const shown = this.model0701.memoryMapped.tableReferenceFollows && (obj === 1 || obj === 2) && collected?.length === 2 && declared === collected.readUInt16BE(0);
      if (!shown) { this.refuse(`${what} after a load event of its machine${declared === undefined ? "" : `, its first segment declared at 0x${declared.toString(16)}`}: what the unit reports there then is not shown`); return; }
    }
    super.propertyRead(obj, pid, count, start, reply);
  }

  protected override propertyWrite(obj: number, pid: number, _count: number, _start: number, value: Buffer, _reply: Reply): void {
    this.refuse(`A_PropertyValue_Write ${obj}/${pid} ${value.toString("hex")}: no property write is shown on this unit${pid === PID_LOAD_STATE ? "; its load controls go to memory 0x0104" : ""}`);
  }

  protected override memoryRead(n: number, addr: number, reply: Reply): void {
    const what = `A_Memory_Read ${n} at 0x${addr.toString(16)}`;
    if (n === 0) { this.refuse(`${what}: a read of no octet`); return; }
    if (addr + n > MEMORY_END) { this.refuse(`${what}: past the reach of the memory services`); return; }
    if (addr < STATES_END && addr + n > STATES_AT) {
      const lsm = addr - MM_STATUS_BASE;
      if (n !== 1) { this.refuse(`${what}: a read of the load states other than one state octet, which the unit answers otherwise than their single reads`); return; }
      const state = this.machines.get(lsm)!.state;
      if (state === null) { this.refuse(`${what}: the state of load-state machine ${lsm} is not known; the collection did not read object ${lsm} PID 5`); return; }
      reply(APCI.MEMORY_RESPONSE, Buffer.from([addr >> 8, addr & 0xff, state]), n);
      return;
    }
    const unreadable = unreadableReason("MV-0701", { address: addr, length: n }, null);
    if (unreadable) { this.refuse(`${what}: ${unreadable}`); return; }
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
    if (addr + n > MEMORY_END) { this.refuse(`${what}: past the reach of the memory services`); return; }
    if (this.property(0, PID_DEVICE_CONTROL)!.elements![0][0] & VERIFY_MODE) { this.refuse(`${what} in verify mode: how the unit answers a write then is not shown`); return; }
    if (addr === MM_CTRL_ADDR && n === LOAD_CONTROL_LENGTH) { this.loadControl(data, what); return; }
    if (addr < MM_CTRL_ADDR + LOAD_CONTROL_LENGTH && addr + n > MM_CTRL_ADDR) { this.refuse(`${what}: the load control at 0x0104 takes ${LOAD_CONTROL_LENGTH} octets at once`); return; }
    if (addr < STATES_END && addr + n > STATES_AT) { this.refuse(`${what}: into the load states`); return; }
    const owner = LSMS.find((l) => this.machines.get(l)!.segments.some((s) => addr >= s.at && addr + n <= s.at + s.size));
    if (owner === undefined) { this.refuse(`${what}: outside every segment a load-state machine holds`); return; }
    const m = this.machines.get(owner)!;
    if (m.state !== STATE.LOADING) { this.refuse(`${what}: into a segment of load-state machine ${owner} in state ${m.state}`); return; }
    const seg = m.segments.find((s) => addr >= s.at && addr + n <= s.at + s.size)!;
    if (seg.memType !== WRITTEN_MEMORY_TYPE) { this.refuse(`${what}: into a segment of memory type ${seg.memType}, which no capture shows written`); return; }
    data.forEach((b, i) => { this.memory.set(addr + i, b); this.written.add(addr + i); });
  }

  private loadControl(data: Buffer, what: string): void {
    const lsm = data[0] >> 4, event = data[0] & 0x0f;
    const m = this.machines.get(lsm);
    if (!m) { this.refuse(`${what}: load-state machine ${lsm}`); return; }
    if (m.state === null) { this.refuse(`${what}: the state of load-state machine ${lsm} is not known; the collection did not read object ${lsm} PID 5`); return; }
    const mm = this.model0701.memoryMapped;
    switch (event) {
      case LSM.UNLOAD: {
        const table = lsm === 1 ? m.segments[0] : undefined;
        if (table && mm.addressTableCountOnDeclaration !== null) this.memory.delete(table.at);
        Object.assign(m, { state: STATE.UNLOADED, segments: [], moved: true, unloaded: true, taskSegment: false });
        this.changed = true;
        return;
      }
      case LSM.LOAD:
        // The unit takes a load of a loaded machine and reports it loading (the partial form loads the
        // application without unloading it, on both units).
        if (m.state !== STATE.UNLOADED && m.state !== STATE.LOADED) { this.refuse(`${what}: a load of a machine in state ${m.state}`); return; }
        Object.assign(m, { state: STATE.LOADING, moved: true });
        this.changed = true;
        return;
      case LSM.LOAD_COMPLETED:
        if (m.state !== STATE.LOADING) { this.refuse(`${what}: load completed in state ${m.state}`); return; }
        if (m.unloaded && (m.segments.length === 0 || !m.taskSegment)) { this.refuse(`${what}: load completed after the unload without an absolute segment and the task segment declared, which every capture declares first`); return; }
        Object.assign(m, { state: STATE.LOADED, moved: true });
        this.changed = true;
        return;
      case ADDITIONAL: {
        if (m.state !== STATE.LOADING) { this.refuse(`${what}: an additional load control in state ${m.state}`); return; }
        const kind = ADDITIONAL_CONTROLS[data[1]];
        if (!kind || !mm.additional.includes(kind)) { this.refuse(`${what}: additional load control ${data[1]}, which the unit's captures do not show it taking`); return; }
        if (data[2] !== 0) { this.refuse(`${what}: a third octet other than 00`); return; }
        const at = data.readUInt16BE(3);
        const inSegment = (a: number) => m.segments.some((s) => a >= s.at && a < s.at + s.size);
        if (kind === "absolute-segment") {
          const size = data.readUInt16BE(5);
          if (size === 0 || at + size > MEMORY_END) { this.refuse(`${what}: a segment of ${size} octets at 0x${at.toString(16)}, which the memory services do not reach whole`); return; }
          if (data[10] !== 0) { this.refuse(`${what}: a last octet other than 00`); return; }
          const other = LSMS.find((l) => l !== lsm && this.machines.get(l)!.segments.some((s) => at < s.at + s.size && s.at < at + size));
          if (other !== undefined) { this.refuse(`${what}: a segment reaching into one of load-state machine ${other}`); return; }
          if (lsm === 1 && m.unloaded && m.segments.length === 0 && mm.addressTableCountOnDeclaration !== null) this.memory.set(at, mm.addressTableCountOnDeclaration);
          m.segments.push({ at, size, memType: data[8] });
          return;
        }
        if (!inSegment(at)) { this.refuse(`${what}: at 0x${at.toString(16)}, outside the machine's segments`); return; }
        if (kind === "task-segment") {
          if (data[5] !== mm.peiType) { this.refuse(`${what}: PEI type ${data[5].toString(16)}, the unit's captures carry ${mm.peiType.toString(16)}`); return; }
          if (!data.subarray(6).equals(this.model0701.programId)) { this.refuse(`${what}: the application ${data.subarray(6).toString("hex")}, the unit holds ${this.model0701.programId.toString("hex")}; what it does with another one is not shown`); return; }
          m.taskSegment = true;
          return;
        }
        if (data.subarray(6).some((b) => b !== 0)) { this.refuse(`${what}: task control 1 with octets past its count`); return; }
        return;
      }
    }
    this.refuse(`${what}: load-state event ${event}`);
  }
}
