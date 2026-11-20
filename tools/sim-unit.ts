// A simulated System B unit (MV-07B0) on the KnxTransport seam: one device on an otherwise empty line,
// built from what a real unit of the product answered (a read-only collection, tools/collect.ts) and checked
// against the product's application program. KnxIpServer puts it on the network, so ETS or Busforge download
// into it over KNXnet/IP exactly as into a unit behind the bench bridge.
//
// It is strict, like packages/product/test/collected-unit.ts: what it does not model it refuses, with a
// reason in its log and in `refusals`, and sends nothing in answer, so the tool's own timeout ends the run
// where an invented answer would have let it continue on a byte no unit gave. What it models:
// - the transport layer of KNX 3/3/4 for one connection: T_Connect, T_Disconnect, T_Ack before every answer,
//   the answer under the unit's own sequence number, a repeated request acknowledged again and not executed,
//   the 6 s connection timeout; a T_Connect from the partner of the open connection is taken as nothing, one
//   from another address and a numbered frame without a connection are answered with T_Disconnect (the
//   transport rules packages/knx/src/device.ts follows), and frames on the connection a restart ended as the
//   unit's captures show;
// - connectionless A_DeviceDescriptor_Read and A_PropertyValue_Read;
// - the broadcast A_IndividualAddress_Read in programming mode (which the restart ends) and
//   A_IndividualAddressSerialNumber_Read, as far as the unit's captures show them;
// - A_Authorize_Request with the keys whose answer the unit's captures show;
// - the interface objects and properties the unit answered, element by element, and its property
//   descriptions, those of the index past its last property included; a property the unit refused is answered
//   without elements, as the unit answered it;
// - the load-state machines on PID 5: unload, load, the relative allocation (`03 0B <size:4> <mode> <fill>`),
//   load completed, each refused out of order; the table reference (PID 7) and the memory-control block
//   (PID 27, the CRC over the segment as the unit computes it) that follow from them;
// - memory inside the allocated segments, a write echoed by A_Memory_Response in verify mode (PID 14 bit 2);
// - the basic restart as the unit's captures show it.
// Every frame it sends carries the request's priority (system priority on a transport-layer control frame)
// and is an extended frame where it is longer than a standard one, as the unit's frames in the captures are.
// tools/sim-unit-0701.ts builds the memory-mapped System 7 unit (MV-0701) on this transport core,
// tools/sim-unit-0705.ts the property-mapped one (MV-0705).
import {
  APCI, CEMI, cemiLData, numToIa, parseApdu, parseCemiLData, tpAck, tpDisconnect, withMessageCode, crc16Ccitt, crc16CcittFalse,
  type KnxTransport, type PropertyDescription,
} from "../packages/knx/src/index.ts";

const PID_LOAD_STATE = 5, PID_TABLE_REFERENCE = 7, PID_PROGRAM_ID = 13, PID_DEVICE_CONTROL = 14, PID_MCB = 27;
const STATE = { UNLOADED: 0, LOADED: 1, LOADING: 2 } as const;
const EVENT = { LOAD: 1, LOAD_COMPLETED: 2, ADDITIONAL: 3, UNLOAD: 4 } as const;
export const APPLICATION_STOPPED = 0x01;
const VERIFY_MODE = 0x04, PID_SERIAL = 11;
const APPLICATION_LSM = 4;
const PRIORITY_BITS = 0x0c, STANDARD_FRAME = 0x80, STANDARD_TPDU_MAX = 16, GROUP_ADDRESS = 0x80;
// The reach of the memory services the unit answers (A_Memory_Read/Write, a 16-bit address).
export const MEMORY_END = 0x10000;
// KNX 3/3/4: a transport connection that carries nothing for 6 s is closed by the device.
const CONNECTION_TIMEOUT_MS = 6_000;
// KNX 3/3/4: a numbered frame is acknowledged within 3 s.
const ACK_TIMEOUT_MS = 3_000;

export interface SimProperty {
  // The elements as the unit answered them, from element 1; null where the unit refused the property
  // (answered its first element without elements).
  elements: Buffer[] | null;
  // Whether the unit was asked for its element count (element 0); where not, `elements` may not be all of them.
  countKnown: boolean;
}

// How the unit takes a basic A_Restart, from its captures.
export interface SimRestart {
  // The unit acknowledges the restart frame itself, on layer 2 and, unless `transportAck` is false, with T_Ack.
  acknowledged: boolean;
  transportAck?: boolean;
  // For this long after the restart no frame to it is acknowledged on layer 2. The restart's time is when the
  // line took it: on a replay's clock its request's, on the wall clock `link.ackMs` later.
  linkDownMs: number;
  // From this long after the restart a frame is acknowledged again, where the captures leave a gap after
  // `linkDownMs`: a frame in the gap is refused (and confirmed negatively), since no capture shows whether the
  // unit acknowledges it. Absent: acknowledged from `linkDownMs` on.
  linkUpMs?: number;
  // What the unit answers a numbered frame on the connection the restart ended, until that partner connects
  // again: T_Disconnect (KNX 3/3/4 A10), nothing, as a unit whose stack drops such frames, or "unknown" where
  // its captures show neither, and the frame is refused.
  deadConnection: "disconnect" | "nothing" | "unknown";
}

// What a simulated unit holds whatever its load control.
export interface SimUnitCoreModel {
  ia: number;
  mask: number;
  maxApdu: number;
  // object index -> PID -> property.
  objects: Map<number, Map<number, SimProperty>>;
  // object index -> the descriptions the unit gave; one with PID 0 is its answer past its last property.
  descriptions: Map<number, PropertyDescription[]>;
  // A_Authorize_Request key (hex) -> the level the unit grants.
  authorize: Map<string, number>;
  restart: SimRestart;
  // How long the unit's interface took to confirm a frame on the line: positively, and negatively (no
  // layer-2 acknowledgement, after the repetitions).
  link: { ackMs: number; nakMs: number };
  // Whether the unit is in programming mode at the start, where its captures show it (it answers a broadcast
  // A_IndividualAddress_Read, or leaves it unanswered); its restart ends it. Absent: not known, and the read
  // is refused.
  programmingMode?: boolean;
  // The four octets after the serial number in its A_IndividualAddressSerialNumber_Response, as its captures
  // show them. Absent: the read is refused.
  serialNumberResponseTail?: Buffer;
}

// A System B unit: its relative load control on PID 5.
export interface SimUnitModel extends SimUnitCoreModel {
  // Per load-state machine: where the unit places its segment (it chose that address on every download its
  // captures show) and the segment it holds at the start.
  segments: Map<number, { at: number; size: number; bytes: Buffer }>;
  // The two octets of a memory-control-block element between the size and the CRC, as the unit reports them.
  mcbControl: Buffer;
  crc: "ccitt" | "ccitt-false";
}

// A segment's bytes, and which of them the unit is known to hold (1): a mode-0 allocation that grows a segment
// leaves its new octets unknown until they are written.
interface Segment { at: number; size: number; bytes: Buffer; known: Uint8Array }
interface Connection { partner: number; recv: number; send: number; pendingAck: ReturnType<typeof setTimeout> | null; idle: ReturnType<typeof setTimeout> | null }
export type Reply = (apci: number, data: Buffer, low?: number) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SimUnit implements KnxTransport {
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onRawCemi: ((cemi: Buffer) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  readonly refusals: string[] = [];
  readonly lines: string[] = [];
  private readonly objects: Map<number, Map<number, SimProperty>>;
  private readonly segments = new Map<number, Segment>();
  // Per object, whether its table reference and memory-control block are known (false after an unload until
  // the allocation and the load completed that follow it set them).
  protected readonly referenceKnown = new Map<number, boolean>();
  protected readonly mcbKnown = new Map<number, boolean>();
  private conn: Connection | null = null;
  private restartedAt: number | null = null;
  // The partner of the connection the last restart ended, until it connects again.
  private deadPartner: number | null = null;
  // Whether the frame on the line is a restart the unit carried out.
  private restartedNow = false;
  // The priority bits of the request on the line, which the unit's frames in answer carry.
  private priority = 0;
  private line: Promise<void> = Promise.resolve();
  // Set by disconnect(): no frame is taken and none sent until connect().
  private stopped = false;
  private programmingMode: boolean | undefined;

  constructor(
    // A unit of another load control (tools/sim-unit-0701.ts, tools/sim-unit-0705.ts) has none of System B's
    // relative segments and its memory-control block convention.
    private readonly model: SimUnitCoreModel & Partial<Pick<SimUnitModel, "segments" | "mcbControl" | "crc">>,
    // The interface's own individual address: the source of the frames the tool sends through it.
    readonly assignedIa: number,
    private readonly opts: { log?: (line: string) => void; now?: () => number } = {},
  ) {
    this.programmingMode = model.programmingMode;
    this.objects = new Map([...model.objects].map(([o, props]) => [o, new Map([...props].map(([pid, p]) => [pid, { ...p, elements: p.elements?.map((e) => Buffer.from(e)) ?? null }]))]));
    if (!this.property(0, PID_DEVICE_CONTROL)?.elements?.[0]) throw new Error("a simulated unit needs the device control (object 0 PID 14) its unit answered: verify mode and the stopped application live there");
    for (const [lsm, s] of model.segments ?? []) {
      this.segments.set(lsm, { at: s.at, size: s.size, bytes: Buffer.from(s.bytes), known: new Uint8Array(s.size).fill(1) });
      this.referenceKnown.set(lsm, true);
      this.mcbKnown.set(lsm, true);
    }
  }

  // The unit's own individual address.
  get deviceIa(): number { return this.model.ia; }

  private now(): number { return this.opts.now?.() ?? Date.now(); }
  protected note(line: string): void { this.lines.push(line); this.opts.log?.(line); }
  protected refuse(what: string): void { const r = `sim-refused ${what}`; this.refusals.push(r); this.note(r); }

  async connect(): Promise<void> { this.stopped = false; }
  async disconnect(): Promise<void> { this.stopped = true; this.close(); await this.line; }

  // The device's memory of one segment, for a test that compares what a download left in it.
  segment(lsm: number): { at: number; bytes: Buffer } | null {
    const s = this.segments.get(lsm);
    return s && s.known.every((k) => k === 1) ? { at: s.at, bytes: Buffer.from(s.bytes) } : null;
  }

  // One cEMI L_Data.req from the interface. A rejection is the frame not acknowledged on layer 2, which the
  // KNXnet/IP server confirms negatively. Frames take the line one after the other, each for the time the
  // unit's interface took to confirm it.
  sendCemi(cemi: Buffer): Promise<void> {
    const turn = this.line.then(() => this.onLine(cemi));
    this.line = turn.catch(() => {});
    return turn;
  }

  private async onLine(cemi: Buffer): Promise<void> {
    const nak = async (why: string): Promise<never> => { await sleep(this.model.link.nakMs); throw new Error(why); };
    if (this.stopped) throw new Error("the simulated unit is disconnected");
    if (cemi[0] !== CEMI.LDATA_REQ) { this.refuse(`cEMI message code 0x${cemi[0].toString(16)}`); return; }
    const { src, dst, tpdu, isGroup } = parseCemiLData(cemi);
    if (isGroup && (dst !== 0 || !isAddressBroadcast(tpdu))) { this.refuse(`a ${dst === 0 ? "broadcast" : "group"} telegram ${tpdu.toString("hex")} from ${numToIa(src)}: no group service is modelled, and of the broadcasts only the address reads`); return; }
    if (!isGroup && dst !== this.model.ia) {
      this.note(`no device at ${numToIa(dst)}: ${tpdu.toString("hex")} not acknowledged`);
      return nak(`no device at ${numToIa(dst)} acknowledged the frame`);
    }
    const since = this.restartedAt === null ? null : this.now() - this.restartedAt;
    if (since !== null && since < this.model.restart.linkDownMs) {
      if (isGroup) { this.refuse(`broadcast ${tpdu.toString("hex")} from ${numToIa(src)} while the unit restarts (${since} ms): whether it answers is not known`); return nak("whether the restarting unit answers a broadcast is not shown"); }
      this.note(`restarting (${since} ms): ${tpdu.toString("hex")} not acknowledged`);
      return nak("the unit is restarting and acknowledged nothing");
    }
    if (since !== null && this.model.restart.linkUpMs !== undefined && since < this.model.restart.linkUpMs) {
      this.refuse(`${tpdu.toString("hex")} ${since} ms after the restart: whether the unit acknowledges a frame then is not shown`);
      return nak("the unit's answer this soon after its restart is not shown");
    }
    await sleep(this.model.link.ackMs);
    this.restartedAt = null;
    this.priority = cemi[2 + cemi[1]] & PRIORITY_BITS;
    this.restartedNow = false;
    try { if (isGroup) this.onBroadcast(src, tpdu); else this.onFrame(src, tpdu); }
    catch (e) { this.refuse(`${tpdu.toString("hex")} from ${numToIa(src)}: ${e instanceof Error ? e.message : String(e)}`); }
    if (this.restartedNow && !this.model.restart.acknowledged) {
      await sleep(this.model.link.nakMs - this.model.link.ackMs);
      throw new Error("the unit restarted without acknowledging the restart");
    }
  }

  // ---- transport layer ----

  private onFrame(src: number, tpdu: Buffer): void {
    const tpci = tpdu[0];
    if (tpdu.length === 1 && (tpci & 0xc3) === 0x80) { this.onConnect(src); return; }
    if (tpdu.length === 1 && (tpci & 0xc3) === 0x81) { this.onDisconnect(src); return; }
    if (tpdu.length === 1 && (tpci & 0xc3) === 0xc2) { this.onAck(src, (tpci >> 2) & 0x0f); return; }
    if (tpdu.length === 1 && (tpci & 0xc3) === 0xc3) { this.refuse(`T_Nak ${(tpci >> 2) & 0x0f} from ${numToIa(src)}: no frame of the unit is repeated`); return; }
    if (tpdu.length < 2) { this.refuse(`TPDU ${tpdu.toString("hex")} from ${numToIa(src)}`); return; }
    if (tpdu.length - 1 > this.model.maxApdu) { this.refuse(`an APDU of ${tpdu.length - 1} octets from ${numToIa(src)}, beyond the unit's maximum of ${this.model.maxApdu}`); return; }
    if ((tpci & 0xc0) === 0x00) { this.onConnectionless(src, tpdu); return; }
    if ((tpci & 0xc0) !== 0x40) { this.refuse(`TPCI 0x${tpci.toString(16)} from ${numToIa(src)}`); return; }
    const seq = (tpci >> 2) & 0x0f;
    const c = this.conn;
    if (!c || c.partner !== src) {
      if (this.deadPartner === src && this.model.restart.deadConnection === "nothing") { this.note(`numbered frame ${tpdu.toString("hex")} from ${numToIa(src)} on the connection the restart ended: dropped`); return; }
      if (this.deadPartner === src && this.model.restart.deadConnection === "unknown") { this.refuse(`numbered frame ${tpdu.toString("hex")} from ${numToIa(src)} on the connection the restart ended: the unit's answer is not shown`); return; }
      this.note(`numbered frame ${tpdu.toString("hex")} from ${numToIa(src)} without a connection: T_Disconnect`);
      this.emit(src, tpDisconnect());
      return;
    }
    this.touch(c);
    if (seq === ((c.recv - 1) & 0x0f)) { this.note(`repeated request ${seq}: acknowledged again, not executed`); this.emit(src, tpAck(seq)); return; }
    if (seq !== c.recv) { this.refuse(`request with sequence ${seq} where ${c.recv} was due`); return; }
    if (c.pendingAck) { this.refuse(`request ${seq} while the unit's answer ${c.send} is unacknowledged`); return; }
    c.recv = (c.recv + 1) & 0x0f;
    if (isBasicRestart(tpdu)) {
      const why = this.restartRefusal();
      if (why) { this.emit(src, tpAck(seq)); this.refuse(`A_Restart: ${why}`); return; }
      // A unit that restarts at once acknowledges the restart neither on layer 2 nor with T_Ack.
      if (this.model.restart.acknowledged && this.model.restart.transportAck !== false) this.emit(src, tpAck(seq));
      this.restart(src);
      return;
    }
    this.emit(src, tpAck(seq));
    this.onApdu(src, tpdu, true);
  }

  private onConnect(src: number): void {
    if (this.conn && this.conn.partner === src) { this.note(`T_Connect from ${numToIa(src)} while connected to it: taken as nothing`); this.touch(this.conn); return; }
    if (this.conn) { this.note(`T_Connect from ${numToIa(src)} while connected to ${numToIa(this.conn.partner)}: T_Disconnect`); this.emit(src, tpDisconnect()); return; }
    if (this.deadPartner === src) this.deadPartner = null;
    this.conn = { partner: src, recv: 0, send: 0, pendingAck: null, idle: null };
    this.touch(this.conn);
    this.note(`connected to ${numToIa(src)}`);
  }

  private onDisconnect(src: number): void {
    if (!this.conn || this.conn.partner !== src) { this.note(`T_Disconnect from ${numToIa(src)} outside a connection to it: ignored`); return; }
    this.close();
    this.note(`disconnected by ${numToIa(src)}`);
  }

  private onAck(src: number, seq: number): void {
    const c = this.conn;
    if (!c || c.partner !== src || !c.pendingAck) { this.refuse(`T_Ack ${seq} from ${numToIa(src)} for no answer of the unit`); return; }
    if (seq !== c.send) { this.refuse(`T_Ack ${seq} where the unit's answer ${c.send} waits for one`); return; }
    clearTimeout(c.pendingAck);
    c.pendingAck = null;
    c.send = (c.send + 1) & 0x0f;
    this.touch(c);
  }

  private touch(c: Connection): void {
    if (c.idle) clearTimeout(c.idle);
    c.idle = setTimeout(() => {
      if (this.conn !== c) return;
      this.note(`connection to ${numToIa(c.partner)} idle for ${CONNECTION_TIMEOUT_MS} ms: T_Disconnect`);
      this.close();
      this.emit(c.partner, tpDisconnect());
    }, CONNECTION_TIMEOUT_MS);
    c.idle.unref?.();
  }

  private close(): void {
    const c = this.conn;
    if (!c) return;
    if (c.idle) clearTimeout(c.idle);
    if (c.pendingAck) clearTimeout(c.pendingAck);
    this.conn = null;
  }

  // An answer of the unit on the open connection, under its own sequence number.
  private answer(to: number, apci: number, data: Buffer, low = 0): void {
    const c = this.conn;
    if (!c || c.partner !== to) { this.answerConnectionless(to, apci, data, low); return; }
    if (1 + data.length > this.model.maxApdu) { this.refuse(`an answer of ${1 + data.length} octets, beyond the unit's maximum APDU of ${this.model.maxApdu}`); return; }
    const seq = c.send;
    this.emit(to, Buffer.concat([Buffer.from([0x40 | (seq << 2) | ((apci >> 8) & 0x03), (apci & 0xff) | (low & 0x3f)]), data]));
    c.pendingAck = setTimeout(() => {
      if (this.conn !== c) return;
      this.refuse(`no T_Ack for the unit's answer ${seq} within ${ACK_TIMEOUT_MS} ms: no repetition is modelled, the connection is dropped`);
      this.close();
    }, ACK_TIMEOUT_MS);
    c.pendingAck.unref?.();
  }

  private answerConnectionless(to: number, apci: number, data: Buffer, low = 0): void {
    if (1 + data.length > this.model.maxApdu) { this.refuse(`an answer of ${1 + data.length} octets, beyond the unit's maximum APDU of ${this.model.maxApdu}`); return; }
    this.emit(to, Buffer.concat([Buffer.from([(apci >> 8) & 0x03, (apci & 0xff) | (low & 0x3f)]), data]));
  }

  // A frame from the unit, delivered after the interface's confirmation of the request that caused it.
  private emit(to: number, tpdu: Buffer, broadcast = false): void {
    const cemi = withMessageCode(cemiLData(this.model.ia, to, tpdu), CEMI.LDATA_IND);
    const ctrl = 2 + cemi[1];
    const priority = tpdu.length === 1 ? 0 : this.priority;
    cemi[ctrl] = (cemi[ctrl] & ~(PRIORITY_BITS | STANDARD_FRAME)) | priority | (tpdu.length > STANDARD_TPDU_MAX ? 0 : STANDARD_FRAME);
    if (broadcast) cemi[ctrl + 1] |= GROUP_ADDRESS;
    setTimeout(() => { if (this.stopped) return; this.onRawCemi?.(cemi); this.onCemi?.(this.model.ia, to, tpdu, broadcast); }, 0);
  }

  // ---- application layer ----

  // A_IndividualAddress_Read, answered in programming mode and left unanswered outside it, and
  // A_IndividualAddressSerialNumber_Read, answered where the serial number is the unit's.
  private onBroadcast(src: number, tpdu: Buffer): void {
    const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
    const what = `${apci === APCI.INDIVIDUAL_ADDRESS_READ ? "A_IndividualAddress_Read" : "A_IndividualAddressSerialNumber_Read"} ${tpdu.toString("hex")} from ${numToIa(src)}`;
    if (apci === APCI.INDIVIDUAL_ADDRESS_READ) {
      if (this.programmingMode === undefined) { this.refuse(`${what}: whether the unit is in programming mode is not known`); return; }
      if (!this.programmingMode) { this.note(`${what} outside programming mode: no answer`); return; }
      this.emit(0, Buffer.from([APCI.INDIVIDUAL_ADDRESS_RESPONSE >> 8, APCI.INDIVIDUAL_ADDRESS_RESPONSE & 0xff]), true);
      return;
    }
    const serial = this.property(0, PID_SERIAL)?.elements?.[0];
    if (!serial) { this.refuse(`${what}: the unit's serial number was not read`); return; }
    if (!serial.equals(tpdu.subarray(2))) { this.note(`${what}: another unit's serial number, no answer`); return; }
    const tail = this.model.serialNumberResponseTail;
    if (!tail) { this.refuse(`${what}: the octets after the serial number in the unit's answer are not known`); return; }
    this.emit(0, Buffer.concat([Buffer.from([APCI.IA_SERIAL_RESPONSE >> 8, APCI.IA_SERIAL_RESPONSE & 0xff]), serial, tail]), true);
  }

  private onConnectionless(src: number, tpdu: Buffer): void {
    const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
    if ((apci & 0x3c0) === APCI.DEVICE_DESCRIPTOR_READ || apci === APCI.PROPERTY_READ) { this.onApdu(src, tpdu, false); return; }
    this.refuse(`connectionless ${tpdu.toString("hex")} from ${numToIa(src)}: only the descriptor and property reads are answered without a connection`);
  }

  private onApdu(src: number, tpdu: Buffer, connected: boolean): void {
    const raw = ((tpdu[0] & 0x03) << 8) | tpdu[1];
    const d = parseApdu(tpdu).data;
    const reply: Reply = (apci, data, low = 0) => connected ? this.answer(src, apci, data, low) : this.answerConnectionless(src, apci, data, low);
    const shape = (n: number) => { if (d.length < n) throw new Error(`service 0x${raw.toString(16)} with ${d.length} octets of data`); };
    switch (raw & 0x3c0) {
      case APCI.DEVICE_DESCRIPTOR_READ: {
        if ((raw & 0x3f) !== 0) { this.refuse(`A_DeviceDescriptor_Read of descriptor type ${raw & 0x3f}`); return; }
        reply(APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from([this.model.mask >> 8, this.model.mask & 0xff]));
        return;
      }
      case APCI.MEMORY_READ: shape(2); this.memoryRead(raw & 0x3f, d.readUInt16BE(0), reply); return;
      case APCI.MEMORY_WRITE: shape(2); this.memoryWrite(raw & 0x3f, d.readUInt16BE(0), d.subarray(2), reply); return;
      case APCI.RESTART: this.refuse(`A_Restart ${tpdu.subarray(1).toString("hex")}: only the basic restart is modelled for this unit`); return;
    }
    switch (raw) {
      case APCI.AUTHORIZE_REQUEST: {
        shape(5);
        const key = d.subarray(1, 5).toString("hex");
        const level = this.model.authorize.get(key);
        if (level === undefined) { this.refuse(`A_Authorize_Request with key ${key}: the unit's answer to it is not known`); return; }
        reply(APCI.AUTHORIZE_RESPONSE, Buffer.from([level]));
        return;
      }
      case APCI.PROPERTY_READ: shape(4); this.propertyRead(d[0], d[1], d[2] >> 4, ((d[2] & 0x0f) << 8) | d[3], reply); return;
      case APCI.PROPERTY_WRITE: shape(4); this.propertyWrite(d[0], d[1], d[2] >> 4, ((d[2] & 0x0f) << 8) | d[3], Buffer.from(d.subarray(4)), reply); return;
      case APCI.PROPERTY_DESCRIPTION_READ: shape(3); this.propertyDescription(d[0], d[1], d[2], reply); return;
    }
    this.refuse(`${connected ? "" : "connectionless "}APDU ${tpdu.toString("hex")}: service 0x${raw.toString(16)} is not modelled`);
  }

  // Why the unit's restart now is not modelled, or null.
  protected restartRefusal(): string | null {
    const loading = [...this.objects.keys()].filter((o) => this.state(o) === STATE.LOADING);
    return loading.length ? `with object ${loading.join(", ")} loading; what the unit holds after that is not shown` : null;
  }

  protected restart(partner: number): void {
    this.close();
    // A restart ends a programming mode the unit's captures show.
    if (this.programmingMode !== undefined) this.programmingMode = false;
    this.deadPartner = partner;
    this.restartedAt = this.now();
    this.restartedNow = true;
    // Its device control after the restart: the collections taken after a download read it 0.
    this.property(0, PID_DEVICE_CONTROL)!.elements = [Buffer.from([0])];
    this.note("restart");
  }

  protected property(obj: number, pid: number): SimProperty | null {
    return this.objects.get(obj)?.get(pid) ?? null;
  }

  protected propertyRead(obj: number, pid: number, count: number, start: number, reply: Reply): void {
    const what = `A_PropertyValue_Read ${obj}/${pid} of ${count} from ${start}`;
    const prop = this.property(obj, pid);
    if (!prop) { this.refuse(`${what}: the unit was not read there`); return; }
    const head = (n: number) => Buffer.from([obj, pid, (n << 4) | ((start >> 8) & 0x0f), start & 0xff]);
    if (prop.elements === null) {
      if (start !== 1 || count !== 1) { this.refuse(`${what}: the unit refused the property's first element, its answer here is not known`); return; }
      reply(APCI.PROPERTY_RESPONSE, head(0));
      return;
    }
    if ((pid === PID_TABLE_REFERENCE && this.referenceKnown.get(obj) === false) || (pid === PID_MCB && this.mcbKnown.get(obj) === false)) {
      this.refuse(`${what} after the unload of its load-state machine: what the unit reports there before the next allocation is not known`);
      return;
    }
    if (start === 0) {
      if (count !== 1) { this.refuse(`${what}: a count read of more than one element`); return; }
      if (!prop.countKnown) { this.refuse(`${what}: the unit's element count was not read`); return; }
      reply(APCI.PROPERTY_RESPONSE, Buffer.concat([head(1), Buffer.from([prop.elements.length >> 8, prop.elements.length & 0xff])]));
      return;
    }
    if (count === 0 || start + count - 1 > prop.elements.length) { this.refuse(`${what}: past the ${prop.elements.length} elements read, the unit's answer is not known`); return; }
    reply(APCI.PROPERTY_RESPONSE, Buffer.concat([head(count), ...prop.elements.slice(start - 1, start - 1 + count)]));
  }

  private propertyDescription(obj: number, pid: number, index: number, reply: Reply): void {
    const d = this.model.descriptions.get(obj)?.find((x) => pid !== 0 ? x.pid === pid : x.propertyIndex === index);
    if (!d) { this.refuse(`A_PropertyDescription_Read ${obj}/${pid} index ${index}: the unit's description is not known`); return; }
    reply(APCI.PROPERTY_DESCRIPTION_RESPONSE, Buffer.from([obj, d.pid, d.propertyIndex, (d.writable ? 0x80 : 0) | d.pdt, (d.maxElements >> 8) & 0x0f, d.maxElements & 0xff, (d.readLevel << 4) | d.writeLevel]));
  }

  protected propertyWrite(obj: number, pid: number, count: number, start: number, value: Buffer, reply: Reply): void {
    const prop = this.property(obj, pid);
    const what = `A_PropertyValue_Write ${obj}/${pid} ${value.toString("hex")}`;
    if (!prop || prop.elements === null) { this.refuse(`${what}: the unit holds no such property`); return; }
    if (count !== 1 || start !== 1) { this.refuse(`${what} of ${count} elements from ${start}: only a write of the first element is modelled`); return; }
    const echo = (v: Buffer) => reply(APCI.PROPERTY_RESPONSE, Buffer.concat([Buffer.from([obj, pid, 0x10, 0x01]), v]));
    if (pid === PID_LOAD_STATE) { const state = this.loadEvent(obj, value, what); if (state !== null) echo(Buffer.from([state])); return; }
    if (obj === 0 && pid === PID_DEVICE_CONTROL && value.length === 1) { prop.elements = [Buffer.from(value)]; echo(value); return; }
    if (obj === APPLICATION_LSM && pid === PID_PROGRAM_ID && value.length === prop.elements[0]?.length) {
      if (this.state(obj) !== STATE.LOADING) { this.refuse(`${what} while the application is not loading`); return; }
      prop.elements = [Buffer.from(value)];
      echo(value);
      return;
    }
    this.refuse(`${what}: no write of this property is modelled`);
  }

  protected state(obj: number): number {
    return this.property(obj, PID_LOAD_STATE)?.elements?.[0]?.[0] ?? STATE.UNLOADED;
  }

  // One load-state event; the state the unit answers, or null where it is refused.
  protected loadEvent(obj: number, value: Buffer, what: string): number | null {
    const prop = this.property(obj, PID_LOAD_STATE)!;
    const state = this.state(obj);
    const set = (s: number) => { prop.elements = [Buffer.from([s])]; return s; };
    switch (value[0]) {
      case EVENT.UNLOAD:
        if (this.segments.has(obj)) { this.referenceKnown.set(obj, false); this.mcbKnown.set(obj, false); }
        // The unit reports its application stopped after the application is unloaded, until its restart: its
        // device control read 0 before a download and 1 or 5 after it (ETS's and Busforge's captures).
        if (obj === APPLICATION_LSM) { const dc = this.property(0, PID_DEVICE_CONTROL)!; dc.elements = [Buffer.from([dc.elements![0][0] | APPLICATION_STOPPED])]; }
        return set(STATE.UNLOADED);
      case EVENT.LOAD:
        if (state !== STATE.UNLOADED) { this.refuse(`${what}: a load of a machine in state ${state}`); return null; }
        return set(STATE.LOADING);
      case EVENT.ADDITIONAL:
        if (state !== STATE.LOADING) { this.refuse(`${what}: an additional load control in state ${state}`); return null; }
        if (value[1] !== 0x0b || value.length < 8) { this.refuse(`${what}: only the relative allocation (0x0B) is modelled`); return null; }
        return this.allocate(obj, value.readUInt32BE(2), value[6], value[7], what) ? state : null;
      case EVENT.LOAD_COMPLETED: {
        if (state !== STATE.LOADING) { this.refuse(`${what}: load completed in state ${state}`); return null; }
        if (this.referenceKnown.get(obj) === false) { this.refuse(`${what}: load completed without an allocation after the unload`); return null; }
        const seg = this.segments.get(obj);
        const mcb = this.property(obj, PID_MCB);
        if (mcb && mcb.elements !== null) {
          if (!seg || seg.known.some((k) => k === 0)) { this.refuse(`${what}: the segment of object ${obj} holds octets no write set and the unit was not shown to hold, so its CRC is not known`); return null; }
          if (!this.model.mcbControl || !this.model.crc) { this.refuse(`${what}: the unit's memory-control block of object ${obj} is not modelled`); return null; }
          const crc = mcbCrc(this.model.crc, seg.bytes);
          const size = Buffer.alloc(4); size.writeUInt32BE(seg.size);
          mcb.elements = [Buffer.concat([size, this.model.mcbControl, Buffer.from([crc >> 8, crc & 0xff])])];
          this.mcbKnown.set(obj, true);
        }
        return set(STATE.LOADED);
      }
    }
    this.refuse(`${what}: load-state event ${value[0]}`);
    return null;
  }

  // The relative allocation. The unit placed each segment at the same address on every download its captures
  // show, also where the segment grew (its address table by two octets for a new group address); one that
  // would reach into another segment is not shown and refused. Mode 1 fills the segment with the fill byte;
  // mode 0 keeps the bytes it held, and a grown segment's new octets are unknown until written.
  private allocate(obj: number, size: number, mode: number, fill: number, what: string): boolean {
    const seg = this.segments.get(obj);
    if (!seg) { this.refuse(`${what}: where the unit places a segment of object ${obj} is not known`); return false; }
    const other = [...this.segments].find(([lsm, s]) => lsm !== obj && seg.at < s.at + s.size && s.at < seg.at + size);
    if (other) { this.refuse(`${what}: ${size} bytes at 0x${seg.at.toString(16)} reach into the segment of object ${other[0]}; where the unit places them then is not known`); return false; }
    if (mode !== 0 && mode !== 1) { this.refuse(`${what}: allocation mode ${mode}`); return false; }
    if (size === 0 || seg.at + size > MEMORY_END) { this.refuse(`${what}: ${size} bytes at 0x${seg.at.toString(16)} do not fit the unit's memory services`); return false; }
    const bytes = Buffer.alloc(size, fill), known = new Uint8Array(size).fill(mode);
    if (mode === 0) { seg.bytes.copy(bytes, 0, 0, Math.min(size, seg.size)); known.set(seg.known.subarray(0, Math.min(size, seg.size))); }
    Object.assign(seg, { size, bytes, known });
    this.referenceKnown.set(obj, true);
    const ref = this.property(obj, PID_TABLE_REFERENCE);
    if (ref?.elements) { const at = Buffer.alloc(4); at.writeUInt32BE(seg.at); ref.elements = [at]; }
    return true;
  }

  // The segment holding [addr, addr + n), or null.
  private segmentAt(addr: number, n: number): [number, Segment] | null {
    for (const [lsm, s] of this.segments) if (addr >= s.at && addr + n <= s.at + s.size) return [lsm, s];
    return null;
  }

  protected memoryRead(n: number, addr: number, reply: Reply): void {
    const what = `A_Memory_Read ${n} at 0x${addr.toString(16)}`;
    if (n === 0) { this.refuse(`${what}: a read of no octet`); return; }
    const hit = this.segmentAt(addr, n);
    const off = hit ? addr - hit[1].at : 0;
    if (!hit || this.referenceKnown.get(hit[0]) === false || hit[1].known.subarray(off, off + n).some((k) => k === 0)) { this.refuse(`${what}: outside the memory the unit is known to hold`); return; }
    reply(APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([addr >> 8, addr & 0xff]), hit[1].bytes.subarray(off, off + n)]), n);
  }

  protected memoryWrite(n: number, addr: number, data: Buffer, reply: Reply): void {
    const what = `A_Memory_Write ${n} at 0x${addr.toString(16)}`;
    if (n === 0 || data.length !== n) { this.refuse(`${what}: ${data.length} octets of data`); return; }
    const hit = this.segmentAt(addr, n);
    if (!hit) { this.refuse(`${what}: outside an allocated segment`); return; }
    if (this.state(hit[0]) !== STATE.LOADING) { this.refuse(`${what}: into the segment of object ${hit[0]} while it is not loading`); return; }
    if (this.referenceKnown.get(hit[0]) === false) { this.refuse(`${what}: into the segment of object ${hit[0]}, unloaded and not allocated again`); return; }
    const off = addr - hit[1].at;
    data.copy(hit[1].bytes, off);
    hit[1].known.fill(1, off, off + n);
    this.verifyEcho(addr, hit[1].bytes.subarray(off, off + n), reply);
  }

  // In verify mode the unit answers each write with the bytes it then holds there.
  protected verifyEcho(addr: number, held: Buffer, reply: Reply): void {
    if (this.property(0, PID_DEVICE_CONTROL)!.elements![0][0] & VERIFY_MODE) reply(APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([addr >> 8, addr & 0xff]), held]), held.length);
  }
}

// The CRC of a memory-control-block element over the segment's bytes.
export const mcbCrc = (conv: "ccitt" | "ccitt-false", b: Buffer): number => conv === "ccitt" ? crc16Ccitt(b) : crc16CcittFalse(b);
// The convention that gives the CRC a unit reported over a segment's bytes, or null where neither does.
export const crcConventionOf = (reported: number, b: Buffer): "ccitt" | "ccitt-false" | null =>
  reported === crc16CcittFalse(b) ? "ccitt-false" : reported === crc16Ccitt(b) ? "ccitt" : null;

// The broadcasts the unit takes: A_IndividualAddress_Read and A_IndividualAddressSerialNumber_Read.
function isAddressBroadcast(tpdu: Buffer): boolean {
  if (tpdu.length < 2 || (tpdu[0] & 0xfc) !== 0) return false;
  const apci = ((tpdu[0] & 0x03) << 8) | tpdu[1];
  return (apci === APCI.INDIVIDUAL_ADDRESS_READ && tpdu.length === 2) || (apci === APCI.IA_SERIAL_READ && tpdu.length === 8);
}

// A basic A_Restart (no restart type, no data), numbered.
function isBasicRestart(tpdu: Buffer): boolean {
  return tpdu.length === 2 && (tpdu[0] & 0xc3) === 0x43 && tpdu[1] === 0x80;
}
