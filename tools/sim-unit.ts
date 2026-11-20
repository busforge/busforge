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
//   the 6 s connection timeout (on the unit's clock as well, for a replay on a capture's); a T_Connect from the
//   partner of the open connection is taken as nothing, one from another address and a numbered frame without a
//   connection are answered with T_Disconnect (the transport rules packages/knx/src/device.ts follows), and
//   frames on the connection a restart ended as the unit's captures show;
// - the interface's limit: a frame with a longer APDU than it carries is confirmed negatively and not sent;
// - connectionless A_DeviceDescriptor_Read, A_PropertyValue_Read and A_FunctionPropertyExtState_Read;
// - the broadcast A_IndividualAddress_Read in programming mode (which the restart ends) and
//   A_IndividualAddressSerialNumber_Read, as far as the unit's captures show them;
// - A_Authorize_Request with the keys whose answer the unit's captures show;
// - the interface objects and properties the unit answered, element by element, and its property
//   descriptions, those of the index past its last property included; a property the unit refused is answered
//   without elements, as the unit answered it; the function-property states it answered;
// - the load-state machines on PID 5: unload, load, the relative allocation (`03 0B <size:4> <mode> <fill>`),
//   load completed, each refused out of order; the table reference (PID 7) and the memory-control block
//   (PID 27: as written while loading, or the whole segment; the CRC over each block as the unit computes it)
//   that follow from them;
// - memory inside the allocated segments: A_Memory_Read and A_Memory_Write, a write echoed by A_Memory_Response
//   in verify mode (PID 14 bit 2), A_MemoryExtended_Write, answered with A_MemoryExtended_WriteResponse, and
//   A_MemoryExtended_Read where the unit answered it when collected;
// - the basic restart and the confirmed restart (a master reset with erase code 1), and the line after them,
//   as the unit's captures show them.
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
const VERIFY_MODE = 0x04, PID_SERIAL = 11, PID_PROGRAMMING_MODE = 54;
export const APPLICATION_STOPPED = 0x01;
const APPLICATION_LSM = 4;
// A_Restart_Response (KNX 3/3/7): the restart type in the APCI's low bit.
const A_RESTART_RESPONSE = 0x3a0;
const PRIORITY_BITS = 0x0c, STANDARD_FRAME = 0x80, STANDARD_TPDU_MAX = 16, GROUP_ADDRESS = 0x80;
// The reach of the memory services: A_Memory_Read/Write a 16-bit address, A_MemoryExtended_Read/Write a 24-bit one.
export const MEMORY_END = 0x10000;
const MEMORY_EXT_END = 0x1000000;
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

// How the unit takes an A_Restart, from its captures. Where they do not show a part (null), the simulator
// refuses what depends on it.
export interface SimRestart {
  // A basic restart: whether the unit acknowledges the frame on layer 2, and whether it answers it with T_Ack
  // before it restarts (always, never, or only where its application's load-state machine took no load event
  // since its last restart).
  basic: { acknowledged: boolean; tAck: "always" | "never" | "unless-application-loaded" } | null;
  // Its line after the restart as its captures show it: at each instant (ms after the restart, ascending)
  // whether a frame to it was acknowledged on layer 2. Between two instants of the same state it holds, after
  // the last one that state; before the first and between differing ones it is not shown, and a frame then
  // is refused.
  line: { atMs: number; up: boolean }[];
  // What the unit answers a numbered frame on the connection the restart ended, until that partner connects
  // again: T_Disconnect (KNX 3/3/4 A10), or nothing, as a unit whose stack drops such frames.
  deadConnection: "disconnect" | "nothing" | null;
  // The process time (s) of its A_Restart_Response to a master reset with erase code 1 (confirmed restart) on
  // channel 0, after which it restarts once the response is acknowledged; null where its captures show none.
  confirmedRestartSeconds: number | null;
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
  // A_FunctionPropertyExtState_Read `<object type>/<instance>/<PID> <data hex>` -> the result the unit answered
  // with return code 0.
  functionStates: Map<string, Buffer>;
  // A_Authorize_Request key (hex) -> the level the unit grants.
  authorize: Map<string, number>;
  restart: SimRestart;
  // The property index an A_PropertyDescription_Read by PID is answered with: the property's own, or the
  // request's; null where no capture shows one, and such a read is refused.
  descriptionIndex: "property" | "request" | null;
  // Whether the unit answered A_MemoryExtended_Read when it was collected (the collection holds memory it read so).
  memoryExtendedRead: boolean;
  // Whether its captures show it answer A_MemoryExtended_Write; a segment past 64 KB is allocated only then.
  memoryExtendedWrite: boolean;
  // Property writes whose answer only the unit's captures show (`<object>/<PID> <value hex>`) -> the element it
  // answered with, an empty one where it answered without elements: a write of a property whose read it refused,
  // and of its programming mode (object 0 PID 54).
  shownWrites: Map<string, Buffer>;
  // How long the unit's interface took to confirm a frame on the line: positively, and negatively (no
  // layer-2 acknowledgement, after the repetitions).
  link: { ackMs: number; nakMs: number };
  // Whether the unit is in programming mode at the start, where its captures show it (it answers a broadcast
  // A_IndividualAddress_Read, or leaves it unanswered); its restart ends it. Null: not shown, and the read is
  // refused.
  programmingMode: boolean | null;
  // The four octets after the serial number in its A_IndividualAddressSerialNumber_Response, as its captures
  // show them; null where they show none, and the read is refused.
  serialNumberResponseTail: Buffer | null;
}

// A System B unit: its relative load control on PID 5.
export interface SimUnitModel extends SimUnitCoreModel {
  // Per load-state machine: where the unit places its segment (it chose that address on every download its
  // captures show), the segment it holds at the start (empty where its memory-control block held no element,
  // so none of its octets is known), and the two octets of its memory-control-block element between the size
  // and the CRC, as the unit reports them (they differ between a unit's segments; null where the block held
  // several elements, so what a load that writes none leaves is not shown).
  segments: Map<number, { at: number; size: number; bytes: Buffer; mcbControl: Buffer | null }>;
  crc: "ccitt" | "ccitt-false";
  // Whether the unit sets its device control's application-stopped bit (PID 14 bit 0) when its application is
  // unloaded, until its restart.
  unloadStopsApplication: boolean | null;
  // Bits the unit's application changes in a segment of its own after a restart, as its captures show: at `offset`
  // from the segment's start, the bits of `mask` read `to` where they were `from` (and stay where they were `to`).
  clearsAfterRestart: { lsm: number; offset: number; mask: number; from: number; to: number }[];
}

// A segment's bytes, and which of them the unit is known to hold (1): a mode-0 allocation that grows a segment
// leaves its new octets unknown until they are written.
interface Segment { at: number; size: number; bytes: Buffer; known: Uint8Array; mcbControl: Buffer | null }
// `lastAt`: when the connection last carried a frame, on the unit's clock. `restartOnAck`: the unit restarts
// once its answer under way is acknowledged (a confirmed restart).
interface Connection { partner: number; recv: number; send: number; pendingAck: ReturnType<typeof setTimeout> | null; idle: ReturnType<typeof setTimeout> | null; lastAt: number; restartOnAck: boolean }
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
  // Per object, the memory-control-block elements written while it loads: the blocks the segment is cut into,
  // from its start, each with its size and the two octets after it as written.
  private readonly mcbWritten = new Map<number, Buffer[]>();
  private conn: Connection | null = null;
  private restartedAt: number | null = null;
  // The partner of the connection the last restart ended, until it connects again.
  private deadPartner: number | null = null;
  // Whether the frame on the line is a restart the unit carried out.
  private restartedNow = false;
  // Whether its application's load-state machine took a load event since its last restart.
  private applicationLoaded = false;
  // Whether its device control is not known: after an unload of the application where the captures do not
  // show what the unit reports then, until it is written or the unit restarts.
  protected deviceControlUnknown = false;
  // The priority bits of the request on the line, which the unit's frames in answer carry.
  private priority = 0;
  private line: Promise<void> = Promise.resolve();
  // Set by disconnect(): no frame is taken and none sent until connect().
  private stopped = false;
  private programmingMode: boolean | null;

  constructor(
    // A unit of another load control (tools/sim-unit-0701.ts) has none of System B's segments, memory-control
    // blocks and PID 5 load events, nor what follows from them.
    private readonly model: SimUnitCoreModel & (Pick<SimUnitModel, "segments" | "crc" | "unloadStopsApplication" | "clearsAfterRestart"> | { [K in "segments" | "crc" | "unloadStopsApplication" | "clearsAfterRestart"]?: undefined }),
    // The interface's own individual address: the source of the frames the tool sends through it.
    readonly assignedIa: number,
    // `interfaceMaxApdu`: the longest APDU the interface puts on the line; a longer frame it confirms
    // negatively and the unit never sees.
    private readonly opts: { log?: (line: string) => void; now?: () => number; interfaceMaxApdu?: number } = {},
  ) {
    this.programmingMode = model.programmingMode;
    this.objects = new Map([...model.objects].map(([o, props]) => [o, new Map([...props].map(([pid, p]) => [pid, { ...p, elements: p.elements?.map((e) => Buffer.from(e)) ?? null }]))]));
    if (!this.property(0, PID_DEVICE_CONTROL)?.elements?.[0]) throw new Error("a simulated unit needs the device control (object 0 PID 14) its unit answered: verify mode and the stopped application live there");
    for (const [lsm, s] of model.segments ?? []) {
      this.segments.set(lsm, { at: s.at, size: s.size, bytes: Buffer.from(s.bytes), known: new Uint8Array(s.size).fill(1), mcbControl: s.mcbControl && Buffer.from(s.mcbControl) });
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
    const limit = this.opts.interfaceMaxApdu;
    if (limit !== undefined && tpdu.length - 1 > limit) {
      this.note(`an APDU of ${tpdu.length - 1} octets, beyond the interface's ${limit}: not sent`);
      return nak(`the interface carries at most ${limit} APDU octets`);
    }
    if (isGroup && (dst !== 0 || !isAddressBroadcast(tpdu))) { this.refuse(`a ${dst === 0 ? "broadcast" : "group"} telegram ${tpdu.toString("hex")} from ${numToIa(src)}: no group service is modelled, and of the broadcasts only the address reads`); return; }
    if (!isGroup && dst !== this.model.ia) {
      this.note(`no device at ${numToIa(dst)}: ${tpdu.toString("hex")} not acknowledged`);
      return nak(`no device at ${numToIa(dst)} acknowledged the frame`);
    }
    this.expireIdle();
    const since = this.restartedAt === null ? null : this.now() - this.restartedAt;
    if (since !== null) {
      const line = this.model.restart.line;
      const before = line.findLast((p) => p.atMs <= since), after = line.find((p) => p.atMs >= since);
      const up = before && (!after || after.up === before.up) ? before.up : null;
      if (up === null) {
        this.refuse(`${tpdu.toString("hex")} ${since} ms after the restart: whether the unit acknowledges a frame then is not shown`);
        return nak("the unit's acknowledgement this soon after its restart is not shown");
      }
      if (!up && isGroup) {
        this.refuse(`broadcast ${tpdu.toString("hex")} from ${numToIa(src)} while the unit restarts (${since} ms): whether it answers is not known`);
        return nak("whether the restarting unit answers a broadcast is not shown");
      }
      if (!up) {
        this.note(`restarting (${since} ms): ${tpdu.toString("hex")} not acknowledged`);
        return nak("the unit is restarting and acknowledged nothing");
      }
      if (!after) this.restartedAt = null;
    }
    await sleep(this.model.link.ackMs);
    this.priority = cemi[2 + cemi[1]] & PRIORITY_BITS;
    this.restartedNow = false;
    try { if (isGroup) this.onBroadcast(src, tpdu); else this.onFrame(src, tpdu); }
    catch (e) { this.refuse(`${tpdu.toString("hex")} from ${numToIa(src)}: ${e instanceof Error ? e.message : String(e)}`); }
    if (this.restartedNow && !this.model.restart.basic?.acknowledged) {
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
      if (this.deadPartner === src && this.model.restart.deadConnection === null) { this.refuse(`numbered frame ${tpdu.toString("hex")} from ${numToIa(src)} on the connection the restart ended: what the unit answers it is not shown`); return; }
      if (this.deadPartner === src && this.model.restart.deadConnection === "nothing") { this.note(`numbered frame ${tpdu.toString("hex")} from ${numToIa(src)} on the connection the restart ended: dropped`); return; }
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
      const basic = this.model.restart.basic;
      const why = basic ? this.restartRefusal() : "how the unit takes a basic restart is not shown";
      if (why || !basic) { this.refuse(`A_Restart: ${why}`); return; }
      const { tAck } = basic;
      if (tAck === "always" || (tAck === "unless-application-loaded" && !this.applicationLoaded)) this.emit(src, tpAck(seq));
      this.restart(src);
      this.restartedNow = true;
      return;
    }
    this.emit(src, tpAck(seq));
    this.onApdu(src, tpdu, true);
  }

  private onConnect(src: number): void {
    if (this.conn && this.conn.partner === src) { this.note(`T_Connect from ${numToIa(src)} while connected to it: taken as nothing`); this.touch(this.conn); return; }
    if (this.conn) { this.note(`T_Connect from ${numToIa(src)} while connected to ${numToIa(this.conn.partner)}: T_Disconnect`); this.emit(src, tpDisconnect()); return; }
    if (this.deadPartner === src) this.deadPartner = null;
    this.conn = { partner: src, recv: 0, send: 0, pendingAck: null, idle: null, lastAt: this.now(), restartOnAck: false };
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
    if (c.restartOnAck) {
      this.restart(src);
      // A confirmed restart's line is timed from the T_Ack's arrival, as its captures show it (ETS's T_Disconnect
      // so many ms after its T_Ack), not `link.ackMs` later when the unit takes the frame.
      this.restartedAt = this.now() - this.model.link.ackMs;
    }
  }

  private touch(c: Connection): void {
    c.lastAt = this.now();
    if (c.idle) clearTimeout(c.idle);
    c.idle = setTimeout(() => {
      if (this.conn !== c) return;
      this.note(`connection to ${numToIa(c.partner)} idle for ${CONNECTION_TIMEOUT_MS} ms: T_Disconnect`);
      this.close();
      this.emit(c.partner, tpDisconnect());
    }, CONNECTION_TIMEOUT_MS);
    c.idle.unref?.();
  }

  // The connection timeout on the unit's clock, where that is not the wall clock the timer above runs on: a
  // connection idle for the timeout before the frame now on the line was closed by the unit then.
  private expireIdle(): void {
    const c = this.conn;
    if (!c || this.now() - c.lastAt < CONNECTION_TIMEOUT_MS) return;
    this.note(`connection to ${numToIa(c.partner)} idle for ${CONNECTION_TIMEOUT_MS} ms: T_Disconnect`);
    this.close();
    this.emit(c.partner, tpDisconnect());
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
      if (this.programmingMode === null) { this.refuse(`${what}: whether the unit is in programming mode is not known`); return; }
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
    if ((apci & 0x3c0) === APCI.DEVICE_DESCRIPTOR_READ || apci === APCI.PROPERTY_READ || apci === APCI.FUNCTION_PROPERTY_EXT_STATE_READ) { this.onApdu(src, tpdu, false); return; }
    this.refuse(`connectionless ${tpdu.toString("hex")} from ${numToIa(src)}: only the descriptor, property and function-property state reads are answered without a connection`);
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
      case APCI.RESTART: this.onRestartRequest(raw & 0x3f, d, connected, reply); return;
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
      case APCI.FUNCTION_PROPERTY_EXT_STATE_READ: {
        shape(5);
        const type = d.readUInt16BE(0), instance = d.readUIntBE(2, 3) >> 12, pid = d.readUIntBE(2, 3) & 0xfff;
        const key = `${type}/${instance}/${pid} ${d.subarray(5).toString("hex")}`;
        const result = this.model.functionStates.get(key);
        if (!result) { this.refuse(`A_FunctionPropertyExtState_Read ${key}: the unit's answer to it is not known`); return; }
        reply(APCI.FUNCTION_PROPERTY_EXT_STATE_RESPONSE, Buffer.concat([d.subarray(0, 5), Buffer.from([0x00]), result]));
        return;
      }
      case APCI.MEMORY_EXT_READ: shape(4); this.memoryExtRead(d[0], d.readUIntBE(1, 3), reply); return;
      case APCI.MEMORY_EXT_WRITE: shape(4); this.memoryExtWrite(d[0], d.readUIntBE(1, 3), d.subarray(4), reply); return;
    }
    this.refuse(`${connected ? "" : "connectionless "}APDU ${tpdu.toString("hex")}: service 0x${raw.toString(16)} is not modelled`);
  }

  // Why the unit's restart now is not modelled, or null.
  protected restartRefusal(): string | null {
    const loading = [...this.objects.keys()].filter((o) => this.state(o) === STATE.LOADING);
    return loading.length ? `with object ${loading.join(", ")} loading; what the unit holds after that is not shown` : null;
  }

  // A master reset (restart type 1). Only the confirmed restart (erase code 1) on channel 0 on a connection is
  // modelled, where the unit's captures show its answer: A_Restart_Response, then the restart once the
  // response is acknowledged.
  private onRestartRequest(type: number, d: Buffer, connected: boolean, reply: Reply): void {
    const what = `A_Restart type ${type} ${d.toString("hex")}`;
    const seconds = this.model.restart.confirmedRestartSeconds;
    if (type !== 1 || d.length !== 2 || d[0] !== 1 || d[1] !== 0 || !connected) { this.refuse(`${connected ? "" : "connectionless "}${what}: only the basic restart and the confirmed restart (erase code 1, channel 0) on a connection are modelled`); return; }
    if (seconds === null) { this.refuse(`${what}: the unit's answer to a confirmed restart is not shown`); return; }
    const why = this.restartRefusal();
    if (why) { this.refuse(`${what}: ${why}`); return; }
    reply(A_RESTART_RESPONSE, Buffer.from([0x00, seconds >> 8, seconds & 0xff]), 1);
    if (this.conn) this.conn.restartOnAck = true;
  }

  protected restart(partner: number): void {
    this.close();
    // A restart ends a programming mode the unit's captures show.
    if (this.programmingMode !== null) this.programmingMode = false;
    this.deadPartner = partner;
    // A basic restart's line (`restart.line`) is timed from here: on the wall clock `link.ackMs` (about 20 ms)
    // after the tool's request, from which the specs give it, so it runs that much later live than in the
    // captures; on a replay's clock, which stands still during the confirmation, at the request. A confirmed
    // restart's is moved back to its T_Ack's arrival (onAck).
    this.restartedAt = this.now();
    this.applicationLoaded = false;
    this.deviceControlUnknown = false;
    // A unit without System B's segments has none. What the application does with other bits, or while it is
    // not loaded, is not shown: the octet is then unknown. The memory-control block reports the CRC over the
    // segment as it then holds it.
    for (const { lsm, offset, mask, from, to } of this.model.clearsAfterRestart ?? []) {
      const seg = this.segments.get(lsm);
      if (!seg || offset >= seg.size || seg.known[offset] === 0) continue;
      const bits = seg.bytes[offset] & mask;
      if (bits === to) continue;
      if (this.state(lsm) !== STATE.LOADED || bits !== from) {
        seg.known[offset] = 0;
        this.mcbKnown.set(lsm, false);
        this.note(`restart: octet ${offset} of object ${lsm}'s segment holds ${seg.bytes[offset].toString(16)}, what the application leaves there is not shown`);
        continue;
      }
      seg.bytes[offset] = (seg.bytes[offset] & ~mask) | to;
      const mcb = this.property(lsm, PID_MCB);
      const elements = mcb?.elements && this.mcbKnown.get(lsm) ? this.mcbElements(seg, mcb.elements.map((e) => e.subarray(0, 6))) : null;
      if (elements) mcb!.elements = elements;
      else if (mcb?.elements) { this.mcbKnown.set(lsm, false); this.refuse(`restart: the memory-control block of object ${lsm} does not cover the octet its application clears`); }
    }
    // Its device control after the restart: the collections taken after a download read it 0.
    this.property(0, PID_DEVICE_CONTROL)!.elements = [Buffer.from([0])];
    this.note("restart");
  }

  protected property(obj: number, pid: number): SimProperty | null {
    return this.objects.get(obj)?.get(pid) ?? null;
  }

  protected propertyRead(obj: number, pid: number, count: number, start: number, reply: Reply): void {
    const what = `A_PropertyValue_Read ${obj}/${pid} of ${count} from ${start}`;
    const collectedMode = obj === 0 && pid === PID_PROGRAMMING_MODE ? this.property(0, pid)?.elements?.[0]?.[0] : undefined;
    if (collectedMode !== undefined && this.programmingMode !== null && ((collectedMode & 1) === 1) !== this.programmingMode) { this.refuse(`${what}: the unit's programming mode differs from the one collected, and what it reports then is not shown`); return; }
    const prop = this.property(obj, pid);
    if (!prop) { this.refuse(`${what}: the unit was not read there`); return; }
    const head = (n: number) => Buffer.from([obj, pid, (n << 4) | ((start >> 8) & 0x0f), start & 0xff]);
    if (prop.elements === null) {
      if (start !== 1 || count !== 1) { this.refuse(`${what}: the unit refused the property's first element, its answer here is not known`); return; }
      reply(APCI.PROPERTY_RESPONSE, head(0));
      return;
    }
    if (obj === 0 && pid === PID_DEVICE_CONTROL && this.deviceControlUnknown) { this.refuse(`${what} after the unload of the application: what the unit reports then is not shown`); return; }
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
    if (pid !== 0 && this.model.descriptionIndex === null) { this.refuse(`A_PropertyDescription_Read ${obj}/${pid} index ${index}: which index the unit answers a read by PID with is not shown`); return; }
    const at = pid !== 0 && this.model.descriptionIndex === "request" ? index : d.propertyIndex;
    reply(APCI.PROPERTY_DESCRIPTION_RESPONSE, Buffer.from([obj, d.pid, at, (d.writable ? 0x80 : 0) | d.pdt, (d.maxElements >> 8) & 0x0f, d.maxElements & 0xff, (d.readLevel << 4) | d.writeLevel]));
  }

  protected propertyWrite(obj: number, pid: number, count: number, start: number, value: Buffer, reply: Reply): void {
    const prop = this.property(obj, pid);
    const what = `A_PropertyValue_Write ${obj}/${pid} ${value.toString("hex")}`;
    if (!prop) { this.refuse(`${what}: the unit was not read there`); return; }
    if (pid === PID_MCB && count === 1 && start >= 1 && value.length === 8 && prop.elements !== null) { this.mcbWrite(obj, start, value, what, reply); return; }
    if (count !== 1 || start !== 1) { this.refuse(`${what} of ${count} elements from ${start}: only a write of the first element is modelled`); return; }
    const echo = (v: Buffer) => reply(APCI.PROPERTY_RESPONSE, Buffer.concat([Buffer.from([obj, pid, 0x10, 0x01]), v]));
    if (prop.elements === null) {
      // A property whose read the unit refused answers only the writes its captures show.
      const answer = this.model.shownWrites.get(`${obj}/${pid} ${value.toString("hex")}`);
      if (answer === undefined) { this.refuse(`${what}: a write of a property whose read the unit refused, its answer not shown`); return; }
      reply(APCI.PROPERTY_RESPONSE, Buffer.concat([Buffer.from([obj, pid, answer.length ? 0x10 : 0x00, 0x01]), answer]));
      return;
    }
    if (pid === PID_LOAD_STATE) {
      const state = this.loadEvent(obj, value, what);
      if (state === null) return;
      if (obj === APPLICATION_LSM) this.applicationLoaded = true;
      echo(Buffer.from([state]));
      return;
    }
    if (obj === 0 && pid === PID_DEVICE_CONTROL && value.length === 1) {
      this.deviceControlUnknown = false;
      prop.elements = [Buffer.from(value)];
      echo(value);
      return;
    }
    const shown = this.model.shownWrites.get(`${obj}/${pid} ${value.toString("hex")}`);
    if (shown) {
      // The unit's answer to a write is what it then holds; a shown answer other than the value is not modelled.
      if (!shown.equals(value)) { this.refuse(`${what}: the unit answered ${shown.toString("hex")}; what it holds then is not modelled`); return; }
      prop.elements = [Buffer.from(value)];
      echo(value);
      return;
    }
    if (obj === APPLICATION_LSM && pid === PID_PROGRAM_ID && value.length === prop.elements[0]?.length) {
      if (this.state(obj) !== STATE.LOADING) { this.refuse(`${what} while the application is not loading`); return; }
      prop.elements = [Buffer.from(value)];
      echo(value);
      return;
    }
    this.refuse(`${what}: no write of this property is modelled`);
  }

  // A write of one memory-control-block element while the object loads (LdCtrlWriteProp), echoed. The blocks
  // must be written in order from the first.
  private mcbWrite(obj: number, start: number, value: Buffer, what: string, reply: Reply): void {
    if (this.state(obj) !== STATE.LOADING) { this.refuse(`${what} while object ${obj} is not loading`); return; }
    const written = this.mcbWritten.get(obj) ?? [];
    if (start > written.length + 1) { this.refuse(`${what}: element ${start} before element ${written.length + 1}`); return; }
    written[start - 1] = Buffer.from(value);
    this.mcbWritten.set(obj, written);
    reply(APCI.PROPERTY_RESPONSE, Buffer.concat([Buffer.from([obj, PID_MCB, 0x10 | ((start >> 8) & 0x0f), start & 0xff]), value]));
  }

  // The memory-control-block elements of a segment cut into blocks from its start (each block's size and
  // control octets given), each with the CRC over its octets; null where the blocks reach past the segment or the
  // unit's CRC convention is not modelled.
  private mcbElements(seg: Segment, blocks: Buffer[]): Buffer[] | null {
    if (!this.model.crc) return null;
    const elements: Buffer[] = [];
    let at = 0;
    for (const b of blocks) {
      const size = b.readUInt32BE(0);
      if (at + size > seg.size) return null;
      const bytes = seg.bytes.subarray(at, at + size);
      const crc = mcbCrc(this.model.crc, bytes);
      elements.push(Buffer.concat([b.subarray(0, 6), Buffer.from([crc >> 8, crc & 0xff])]));
      at += size;
    }
    return elements;
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
        this.mcbWritten.delete(obj);
        if (this.segments.has(obj)) { this.referenceKnown.set(obj, false); this.mcbKnown.set(obj, false); }
        if (obj === APPLICATION_LSM && (this.model.unloadStopsApplication ?? null) === null) this.deviceControlUnknown = true;
        if (obj === APPLICATION_LSM && this.model.unloadStopsApplication) { const dc = this.property(0, PID_DEVICE_CONTROL)!; dc.elements = [Buffer.from([dc.elements![0][0] | APPLICATION_STOPPED])]; }
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
          if (!this.model.crc) { this.refuse(`${what}: the unit's memory-control block of object ${obj} is not modelled`); return null; }
          // The blocks written while loading, else the whole segment under the unit's own control octets.
          const written = this.mcbWritten.get(obj);
          if (!written && !seg.mcbControl) { this.refuse(`${what}: the memory-control block of object ${obj} held several blocks and none was written; what the unit reports then is not shown`); return null; }
          const elements = this.mcbElements(seg, written ?? [Buffer.concat([u32(seg.size), seg.mcbControl!])]);
          if (!elements) { this.refuse(`${what}: the memory-control blocks written reach past the ${seg.size} octets allocated`); return null; }
          mcb.elements = elements;
          this.mcbKnown.set(obj, true);
        }
        this.mcbWritten.delete(obj);
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
    if (size === 0 || seg.at + size > (this.model.memoryExtendedWrite ? MEMORY_EXT_END : MEMORY_END)) { this.refuse(`${what}: ${size} bytes at 0x${seg.at.toString(16)} do not fit the unit's memory services`); return false; }
    const bytes = Buffer.alloc(size, fill), known = new Uint8Array(size).fill(mode);
    if (mode === 0) { seg.bytes.copy(bytes, 0, 0, Math.min(size, seg.size)); known.set(seg.known.subarray(0, Math.min(size, seg.size))); }
    Object.assign(seg, { size, bytes, known });
    this.referenceKnown.set(obj, true);
    const ref = this.property(obj, PID_TABLE_REFERENCE);
    if (ref?.elements) ref.elements = [u32(seg.at)];
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
    const bytes = this.knownBytes(addr, n);
    if (!bytes) { this.refuse(`${what}: outside the memory the unit is known to hold`); return; }
    reply(APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([addr >> 8, addr & 0xff]), bytes]), n);
  }

  // The octets [addr, addr + n) of a segment where the unit is known to hold them, or null.
  private knownBytes(addr: number, n: number): Buffer | null {
    const hit = this.segmentAt(addr, n);
    const off = hit ? addr - hit[1].at : 0;
    if (!hit || this.referenceKnown.get(hit[0]) === false || hit[1].known.subarray(off, off + n).some((k) => k === 0)) return null;
    return Buffer.from(hit[1].bytes.subarray(off, off + n));
  }

  protected memoryWrite(n: number, addr: number, data: Buffer, reply: Reply): void {
    const what = `A_Memory_Write ${n} at 0x${addr.toString(16)}`;
    if (n === 0 || data.length !== n) { this.refuse(`${what}: ${data.length} octets of data`); return; }
    if (this.deviceControlUnknown) { this.refuse(`${what}: whether the unit echoes it is not known, its device control after the application's unload not shown`); return; }
    const hit = this.writeSegment(addr, data, what);
    if (!hit) return;
    const off = addr - hit.at;
    this.verifyEcho(addr, hit.bytes.subarray(off, off + n), reply);
  }

  // In verify mode the unit answers each write with the bytes it then holds there.
  protected verifyEcho(addr: number, held: Buffer, reply: Reply): void {
    if (this.property(0, PID_DEVICE_CONTROL)!.elements![0][0] & VERIFY_MODE) reply(APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([addr >> 8, addr & 0xff]), held]), held.length);
  }

  // A write into the segment holding [addr, addr + data.length), loading; the segment, or null where refused.
  private writeSegment(addr: number, data: Buffer, what: string): Segment | null {
    const hit = this.segmentAt(addr, data.length);
    if (!hit) { this.refuse(`${what}: outside an allocated segment`); return null; }
    if (this.state(hit[0]) !== STATE.LOADING) { this.refuse(`${what}: into the segment of object ${hit[0]} while it is not loading`); return null; }
    if (this.referenceKnown.get(hit[0]) === false) { this.refuse(`${what}: into the segment of object ${hit[0]}, unloaded and not allocated again`); return null; }
    const off = addr - hit[1].at;
    data.copy(hit[1].bytes, off);
    hit[1].known.fill(1, off, off + data.length);
    return hit[1];
  }

  // A_MemoryExtended_Read, answered with A_MemoryExtended_ReadResponse: return code 0, the address and the octets,
  // where the unit answered it when collected and holds them.
  private memoryExtRead(n: number, addr: number, reply: Reply): void {
    const what = `A_MemoryExtended_Read ${n} at 0x${addr.toString(16)}`;
    if (!this.model.memoryExtendedRead) { this.refuse(`${what}: the unit was not read with it`); return; }
    const bytes = n === 0 ? null : this.knownBytes(addr, n);
    if (!bytes) { this.refuse(`${what}: outside the memory the unit is known to hold`); return; }
    reply(APCI.MEMORY_EXT_READ_RESP, Buffer.concat([Buffer.from([0x00, addr >> 16, (addr >> 8) & 0xff, addr & 0xff]), bytes]));
  }

  // A_MemoryExtended_Write, answered with A_MemoryExtended_WriteResponse: return code 0 and the address, with
  // or without verify mode, as the units' captures show.
  private memoryExtWrite(n: number, addr: number, data: Buffer, reply: Reply): void {
    const what = `A_MemoryExtended_Write ${n} at 0x${addr.toString(16)}`;
    if (!this.model.memoryExtendedWrite) { this.refuse(`${what}: no capture of the unit shows its answer to it`); return; }
    if (n === 0 || data.length !== n) { this.refuse(`${what}: ${data.length} octets of data`); return; }
    if (!this.writeSegment(addr, data, what)) return;
    reply(APCI.MEMORY_EXT_WRITE_RESP, Buffer.from([0x00, addr >> 16, (addr >> 8) & 0xff, addr & 0xff]));
  }
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

// A basic A_Restart (no restart type, no data), numbered.
function isBasicRestart(tpdu: Buffer): boolean {
  return tpdu.length === 2 && (tpdu[0] & 0xc3) === 0x43 && tpdu[1] === 0x80;
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
