// A simulated property-mapped System 7 unit (MV-0705) on tools/sim-unit.ts's transport and property core,
// built from a read-only collection of a real unit and the product's application program, as strict as the
// System B unit: what it does not model it refuses, with a reason, and sends nothing in answer.
//
// What differs from System B, from the units' captures (tools/sim-units.ts names them):
// - the load-state machines on PID 5 of objects 1 to 3 (address table, association table, application) take
//   absolute segments: `03 00 <address:2> <size:2> <access> <memory type> <flags> 00` (the stack segment
//   `03 01` in the same form) at the address the request names, and the task segment
//   `03 02 <address:2> <octet> <program id:5>`; every one answered LOADING. A load is taken from UNLOADED and
//   from LOADED (the application loaded again without an unload, ETS's partial form);
// - its memory is one address space at fixed addresses: what the collection read, and what is written; an
//   unload forgets the machine's segments and keeps their bytes (a later allocation at the same address
//   holds them, which the CRCs of the memory-control blocks after a download show);
// - a write goes into an EEPROM segment of a machine that is loading, a read into the segments of a machine
//   that is loaded (or loading, the bytes written since its load, where the unit's captures show it answer
//   them), and into the load states at
//   0xB6EA to 0xB6ED (46825 + machine), which hold PID 5;
// - the memory-control block (PID 27) of an object whose unit answers it: one element per segment with
//   flags 0x80, in the order allocated, `<size:4> 00 <access> <CRC:2>`, computed at load completed;
// - the table reference (PID 7) after a download: the address of the machine's first segment, where its task
//   segment names the same address;
// - the unload of the application (object 3) sets the device control's application-stopped bit, as on System B
//   the unload of object 4;
// - no program id is written as a property: it comes with the task segment, into object 3 PID 13.
import { crc16CcittFalse, crc16Ccitt, iaToNum, APCI, MM_STATUS_BASE } from "../packages/knx/src/index.ts";
import { flattenSteps, parseLoadProcedures, type CollectPackage } from "../packages/product/src/index.ts";
import { SimUnit, mcbCrc, APPLICATION_STOPPED, EVENT, MEMORY_END, PID_DEVICE_CONTROL, PID_LOAD_STATE, PID_MCB, PID_PROGRAM_ID, PID_TABLE_REFERENCE, STATE, type Reply, type SimUnitCoreModel } from "./sim-unit.ts";
import { collectedUnit, unitMaxApdu, type Target, type UnitBehaviour } from "./sim-unit-model.ts";

const refuse = (why: string): never => { throw new Error(`no simulated unit: ${why}`); };

const SEGMENT = { DATA: 0x00, STACK: 0x01, TASK: 0x02 } as const;
const LSMS = [1, 2, 3], APPLICATION_LSM = 3;
const MEMORY_TYPE = { RAM: 2, EEPROM: 3 } as const;
// The segment flag of a segment the unit reports in its memory-control block.
const MCB_FLAG = 0x80;

export interface Sim0705Segment { at: number; size: number; access: number; memoryType: number; flags: number }

export interface Sim0705Model extends SimUnitCoreModel {
  // The unit's memory, by address, and which octets of it are known (1).
  memory: { bytes: Buffer; known: Uint8Array };
  // Per load-state machine the segments the unit holds, in the order allocated.
  held: Map<number, Sim0705Segment[]>;
  // The CRC convention of its memory-control blocks; null where the unit reports none.
  crcConvention: "ccitt" | "ccitt-false" | null;
  readsWhileLoading: boolean;
}

export function sim0705Model(collection: CollectPackage, appXml: string, behaviour: UnitBehaviour): Sim0705Model {
  if (collection.mask !== "MV-0705") refuse(`this model is for MV-0705, not ${collection.mask}`);
  const { records, mask, objects, descriptions } = collectedUnit(collection, appXml, refuse);
  const steps = flattenSteps(parseLoadProcedures(appXml), "full");

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
  const declared = (lsm: number): Sim0705Segment[] => steps
    .filter((s) => s.verb === "LdCtrlAbsSegment" && Number(s.attrs.LsmIdx) === lsm)
    .map((s) => ({ at: Number(s.attrs.Address), size: Number(s.attrs.Size), access: Number(s.attrs.Access), memoryType: Number(s.attrs.MemType), flags: Number(s.attrs.SegFlags ?? 0) }));
  const held = new Map<number, Sim0705Segment[]>();
  let crc: "ccitt" | "ccitt-false" | null = null;
  for (const lsm of LSMS) {
    const st = state(lsm);
    if (st === undefined) refuse(`the collection did not read the load state of object ${lsm}`);
    if (st === STATE.UNLOADED) { held.set(lsm, []); continue; }
    if (st !== STATE.LOADED) refuse(`object ${lsm} is in load state ${st}`);
    const mcb = objects.get(lsm)?.get(PID_MCB)?.elements;
    const ref = objects.get(lsm)?.get(PID_TABLE_REFERENCE)?.elements?.[0];
    let segs = declared(lsm);
    if (mcb && mcb.length > 0) {
      const flagged = segs.filter((s) => s.flags & MCB_FLAG);
      const reported = mcb.map((e) => ({ size: e.readUInt32BE(0), control: e.readUInt16BE(4) }));
      const same = reported.length === flagged.length && reported.every((e, i) => e.size === flagged[i].size && e.control === flagged[i].access);
      if (!same) {
        if (segs.length !== 1 || reported.length !== 1 || !ref || reported[0].control >> 8 !== 0) refuse(`the memory-control block of object ${lsm} reports segments its application does not declare`);
        segs = [{ ...segs[0], at: ref!.readUInt16BE(0), size: reported[0].size, access: reported[0].control & 0xff }];
      }
      segs.filter((s) => s.flags & MCB_FLAG).forEach((s, i) => {
        if (!known.subarray(s.at, s.at + s.size).every((k) => k === 1)) refuse(`the collection did not read the segment of object ${lsm} at 0x${s.at.toString(16)}, whose CRC the unit reports`);
        const seg = bytes.subarray(s.at, s.at + s.size), reportedCrc = mcb[i].readUInt16BE(6);
        const conv = reportedCrc === crc16CcittFalse(seg) ? "ccitt-false" : reportedCrc === crc16Ccitt(seg) ? "ccitt" : refuse(`the memory-control block of object ${lsm} reports CRC ${reportedCrc.toString(16)} over the segment at 0x${s.at.toString(16)}, which neither convention gives`);
        if (crc && crc !== conv) refuse("the memory-control blocks take both CRC conventions");
        crc = conv;
      });
    }
    if (ref && (segs.length === 0 || ref.readUInt16BE(0) !== segs[0].at)) refuse(`object ${lsm} references 0x${ref.toString("hex")}, ${segs.length ? `its first segment is at 0x${segs[0].at.toString(16)}` : "it holds no segment"}`);
    held.set(lsm, segs);
  }
  return {
    ...behaviour,
    ia: iaToNum(collection.ia), mask, maxApdu: unitMaxApdu(collection, behaviour, refuse), objects, descriptions,
    crcConvention: crc, memory: { bytes, known }, held, readsWhileLoading: behaviour.readsWhileLoading ?? false,
  };
}

export class SimUnit0705 extends SimUnit {
  private readonly bytes: Buffer;
  private readonly known: Uint8Array;
  // The octets written since the load of the machine holding them (1).
  private readonly fresh = new Uint8Array(MEMORY_END);
  private readonly held = new Map<number, Sim0705Segment[]>();
  // The address each machine's task segment named since its unload.
  private readonly taskAt = new Map<number, number>();
  // The machines unloaded in this session: their load completed needs a segment and a task segment declared
  // since, as every capture declares them.
  private readonly unloaded = new Set<number>();

  constructor(private readonly unit: Sim0705Model, assignedIa: number, opts: ConstructorParameters<typeof SimUnit>[2] = {}) {
    super(unit, assignedIa, opts);
    this.bytes = Buffer.from(unit.memory.bytes);
    this.known = Uint8Array.from(unit.memory.known);
    for (const [lsm, segs] of unit.held) this.held.set(lsm, segs.map((s) => ({ ...s })));
  }

  // The octets [at, at + n) of the unit's memory, null where one is not known.
  memory(at: number, n: number): Buffer | null {
    return this.known.subarray(at, at + n).every((k) => k === 1) ? Buffer.from(this.bytes.subarray(at, at + n)) : null;
  }

  protected override propertyWrite(obj: number, pid: number, count: number, start: number, value: Buffer, reply: Reply): void {
    if (pid === PID_PROGRAM_ID) { this.refuse(`A_PropertyValue_Write ${obj}/${pid} ${value.toString("hex")}: a System 7 unit takes its program id with the task segment`); return; }
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
        this.unloaded.add(obj);
        if (this.property(obj, PID_TABLE_REFERENCE)?.elements) this.referenceKnown.set(obj, false);
        if (this.property(obj, PID_MCB)?.elements) this.mcbKnown.set(obj, false);
        // The unit reports its application stopped after the application is unloaded: the MDT BE-02001.02's
        // device control read 1 after ETS unloaded objects 1 to 3, the Gira's 0 after it unloaded 1 and 2.
        if (obj === APPLICATION_LSM) { const dc = this.property(0, PID_DEVICE_CONTROL)!; dc.elements = [Buffer.from([dc.elements![0][0] | APPLICATION_STOPPED])]; }
        return set(STATE.UNLOADED);
      case EVENT.LOAD:
        if (state === STATE.LOADING) { this.refuse(`${what}: a load of a machine that is loading`); return null; }
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
      const s: Sim0705Segment = { at: value.readUInt16BE(2), size: value.readUInt16BE(4), access: value[6], memoryType: value[7], flags: value[8] };
      if (s.size === 0 || s.at + s.size > MEMORY_END) { this.refuse(`${what}: ${s.size} octets at 0x${s.at.toString(16)}`); return false; }
      if (s.memoryType !== MEMORY_TYPE.RAM && s.memoryType !== MEMORY_TYPE.EEPROM) { this.refuse(`${what}: memory type ${s.memoryType}`); return false; }
      if (value[1] === SEGMENT.STACK && s.memoryType !== MEMORY_TYPE.RAM) { this.refuse(`${what}: a stack segment outside RAM`); return false; }
      const other = [...this.held].flatMap(([lsm, l]) => l.map((x) => [lsm, x] as const)).find(([, x]) => s.at < x.at + x.size && x.at < s.at + s.size);
      if (other) { this.refuse(`${what}: ${s.size} octets at 0x${s.at.toString(16)} reach into a segment of object ${other[0]} at 0x${other[1].at.toString(16)}`); return false; }
      this.fresh.fill(0, s.at, s.at + s.size);
      segs.push(s);
      return true;
    }
    if (value[1] === SEGMENT.TASK) {
      if (value.length !== 10) { this.refuse(`${what}: a task segment of another form`); return false; }
      const id = value.subarray(5, 10);
      const pid13 = this.property(obj, PID_PROGRAM_ID);
      // The program id the collections after ETS's downloads read in object 3 PID 13 is the one its task segment
      // carried.
      if (pid13?.elements?.[0] && pid13.elements[0].length === id.length) pid13.elements = [Buffer.from(id)];
      this.taskAt.set(obj, value.readUInt16BE(2));
      return true;
    }
    this.refuse(`${what}: additional load control 0x${value[1].toString(16)} is not shown on this unit`);
    return false;
  }

  private complete(obj: number, what: string): boolean {
    const segs = this.held.get(obj)!;
    if (this.unloaded.has(obj) && (segs.length === 0 || !this.taskAt.has(obj))) { this.refuse(`${what}: load completed after an unload without a segment and a task segment declared, which no capture shows`); return false; }
    const mcb = this.property(obj, PID_MCB);
    if (mcb?.elements) {
      const crc = this.unit.crcConvention;
      const flagged = segs.filter((s) => s.flags & MCB_FLAG);
      if (!crc) { this.refuse(`${what}: the unit reports a memory-control block whose CRC convention its collection does not show`); return false; }
      const unknown = flagged.find((s) => !this.memory(s.at, s.size));
      if (unknown) { this.refuse(`${what}: the segment at 0x${unknown.at.toString(16)} holds octets no write set and the unit was not shown to hold, so its CRC is not known`); return false; }
      mcb.elements = flagged.map((s) => {
        const e = Buffer.alloc(8);
        e.writeUInt32BE(s.size, 0); e[4] = 0; e[5] = s.access; e.writeUInt16BE(mcbCrc(crc, this.bytes.subarray(s.at, s.at + s.size)), 6);
        return e;
      });
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
  private heldAt(addr: number, n: number): [number, Sim0705Segment] | null {
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
    const freshlyWritten = this.unit.readsWhileLoading && this.fresh.subarray(addr, addr + n).every((f) => f === 1);
    if (hit && state !== STATE.LOADED && !(state === STATE.LOADING && freshlyWritten)) { this.refuse(`${what}: into the segment of object ${hit[0]} while it is in load state ${this.state(hit[0])}, where no capture shows the unit answer a read of these octets`); return; }
    if (!hit || !data) { this.refuse(`${what}: outside the memory the unit is known to hold in its segments`); return; }
    reply(APCI.MEMORY_RESPONSE, Buffer.concat([head, data]), n);
  }

  protected override memoryWrite(n: number, addr: number, data: Buffer, reply: Reply): void {
    const what = `A_Memory_Write ${n} at 0x${addr.toString(16)}`;
    if (n === 0 || data.length !== n) { this.refuse(`${what}: ${data.length} octets of data`); return; }
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
