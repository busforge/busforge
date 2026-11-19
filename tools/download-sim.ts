import { readFileSync } from "node:fs";
import { APCI, apdu, parseApdu, tpAck, type KnxTransport } from "../packages/knx/src/index.ts";
import { parseTunnelFrame } from "./etsdiff.ts";
import { pcapToLog } from "./pcap.ts";

// A download as frames, and a unit that answers one as the device simulator in bussard's captures answered
// ETS (captures/external/bussard-synthetic/ in the corpus), so a test runs Busforge's load plan against it
// and holds the frames Busforge sends to the frames ETS sent. It models what those captures show of the
// simulator and nothing more:
// - T_Ack to every numbered frame, the answer numbered by its own counter, both counters back to 0 at T_Connect;
// - A_DeviceDescriptor_Read (the mask), A_PropertyValue_Read/Write, A_PropertyDescription_Read of the
//   properties a test gives it, every other property absent (an answer without elements);
// - the load-state machines on PID 5 (property-mapped) or on the 0x0104 control with their states at
//   46825 + LSM (memory-mapped), every event and control answered with the resulting state;
// - memory, zero where nothing was written, a write answered with A_Memory_Response where the device control
//   (PID 14) holds verify mode, or always (`echoMemoryWrites`), as the System B captures show;
// - the confirmed A_Restart with an erase code (a master reset), answered error 0, process time 0, or as a
//   test sets it (`masterResetAnswer`, null for no answer).
// A basic A_Restart and any other service it does not take: recorded in `refused` and not answered, so the
// tool's own timeout ends the run; the tests run a plan up to its closing restart.

// One data frame of a download: who sent it and its TPDU without the sequence number (the TPCI octet keeps
// only the APCI's top bits); a transport-layer connect or disconnect as "connect" / "disconnect". `at`: when
// the capture holds it, in milliseconds.
export type DownloadFrame = { from: "tool" | "device"; tpdu: string; at?: number };
const CONNECT = "connect", DISCONNECT = "disconnect";
const strip = (tpdu: Buffer): string => Buffer.concat([Buffer.from([tpdu[0] & 0x03]), tpdu.subarray(1)]).toString("hex");
// A transport-layer control frame (T_Connect 0x80, T_Disconnect 0x81, T_Ack/T_Nak 0xC2/0xC3 with a number).
const control = (tpdu: Buffer): string | null => (tpdu[0] & 0x80) === 0 ? null : tpdu[0] === 0x80 ? CONNECT : tpdu[0] === 0x81 ? DISCONNECT : "ack";

// The frames between ETS and the device at `device` in a capture, in capture order, without acknowledgements.
export function captureFrames(pcap: Buffer, device: number): DownloadFrame[] {
  return pcapToLog(pcap).split("\n").flatMap((line): DownloadFrame[] => {
    const from = line.includes(" ETS->BRIDGE TUNNELLING_REQ ") ? "tool" : line.includes(" BRIDGE->ETS TUNNELLING_REQ ") ? "device" : null;
    if (!from) return [];
    const fr = parseTunnelFrame(line.slice(line.lastIndexOf("| ") + 2));
    if (!fr || fr.group || (from === "tool" ? fr.code !== 0x11 || fr.dst !== device : fr.code !== 0x29 || fr.src !== device)) return [];
    const c = control(fr.tpdu);
    if (c === "ack") return [];
    return [{ from, tpdu: c ?? strip(fr.tpdu), at: Date.parse(line.slice(0, line.indexOf(" "))) }];
  });
}
export const captureFramesOf = (path: string, device: number) => captureFrames(readFileSync(path), device);

// `description`: what A_PropertyDescription_Read answers, the property's index in its object included.
export interface SimProperty { elements: Buffer; description?: { index: number; type: number; maxElements: number; access: number } }
export interface DownloadSimOpts {
  mask: string;                    // the descriptor type 0 answer, e.g. "0701"
  memoryMappedLsms: boolean;       // MV-0700/0701: load control at 0x0104, states at 46825 + LSM
  properties?: Map<string, SimProperty>; // "obj:pid" -> what a read answers
  echoMemoryWrites?: boolean;
  masterResetAnswer?: Buffer | null; // error code and process time (3 octets); default 00 0000
}

const MM_CTRL = 0x0104, MM_STATUS_BASE = 46825;
const STATE = { UNLOADED: 0, LOADED: 1, LOADING: 2 } as const, STATE_ERROR = 3;

export class DownloadSim implements KnxTransport {
  assignedIa = 0x11fe;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  frames: DownloadFrame[] = [];
  refused: string[] = [];
  readonly memory = new Map<number, number>();
  private readonly states = new Map<number, number>();
  // Where each relative allocation (03 0B) put its segment, the table reference (PID 7) a read answers.
  private readonly allocated = new Map<number, number>();
  private nextBase = 0x4000;
  private readonly props: Map<string, SimProperty>;
  private seq = 0;
  private device = 0x1101;
  constructor(private readonly opts: DownloadSimOpts, device = 0x1101) {
    this.device = device;
    this.props = new Map([["0:14", { elements: Buffer.from([0]) }], ...(opts.properties ?? [])]);
  }
  async connect() {}
  async disconnect() {}
  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    const c = control(tpdu);
    if (c === "ack") return;
    if (c) { this.frames.push({ from: "tool", tpdu: c }); if (c === CONNECT) this.seq = 0; return; }
    this.frames.push({ from: "tool", tpdu: strip(tpdu) });
    const p = parseApdu(tpdu);
    queueMicrotask(() => this.answer(p.seq, p.apci, p.data, tpdu));
  }
  private send(apci: number, data: Buffer, low = 0) {
    const t = apdu(this.seq, apci, data, low);
    this.seq = (this.seq + 1) & 0x0f;
    this.frames.push({ from: "device", tpdu: strip(t) });
    this.onCemi?.(this.device, this.assignedIa, t, false);
  }
  private refuse(what: string): void { this.refused.push(what); }
  private answer(seq: number, apci: number, data: Buffer, tpdu: Buffer) {
    this.onCemi?.(this.device, this.assignedIa, tpAck(seq), false);
    if (apci === APCI.DEVICE_DESCRIPTOR_READ) return this.send(APCI.DEVICE_DESCRIPTOR_RESPONSE, Buffer.from(this.opts.mask, "hex"));
    if ((apci & 0x3c0) === APCI.MEMORY_READ) {
      const n = apci & 0x3f, at = data.readUInt16BE(0);
      const bytes = Buffer.from(Array.from({ length: n }, (_, i) => this.readByte(at + i)));
      return this.send(APCI.MEMORY_RESPONSE, Buffer.concat([data.subarray(0, 2), bytes]), n);
    }
    if ((apci & 0x3c0) === APCI.MEMORY_WRITE) {
      const n = apci & 0x3f, at = data.readUInt16BE(0), bytes = data.subarray(2, 2 + n);
      if (this.opts.memoryMappedLsms && at === MM_CTRL) this.control(bytes[0] >> 4, bytes);
      else bytes.forEach((b, i) => this.memory.set(at + i, b));
      if (this.opts.echoMemoryWrites || ((this.prop(0, 14)?.elements[0] ?? 0) & 0x04)) this.send(APCI.MEMORY_RESPONSE, Buffer.from(data.subarray(0, 2 + n)), n);
      return;
    }
    if (apci === APCI.PROPERTY_READ) {
      const [obj, pid] = data, start = ((data[2] & 0x0f) << 8) | data[3];
      if (pid === 5 && !this.opts.memoryMappedLsms) return this.send(APCI.PROPERTY_RESPONSE, Buffer.from([obj, pid, 0x10 | (start >> 8), start & 0xff, this.states.get(obj) ?? STATE.UNLOADED]));
      const base = this.allocated.get(obj);
      if (pid === 7 && base !== undefined) return this.send(APCI.PROPERTY_RESPONSE, Buffer.from([obj, pid, 0x10, 0x01, base >> 24, (base >> 16) & 0xff, (base >> 8) & 0xff, base & 0xff]));
      const p = this.prop(obj, pid);
      return this.send(APCI.PROPERTY_RESPONSE, p ? Buffer.concat([data.subarray(0, 4), p.elements]) : Buffer.from([obj, pid, start >> 8, start & 0xff]));
    }
    if (apci === APCI.PROPERTY_WRITE) {
      const [obj, pid] = data, value = data.subarray(4);
      if (pid === 5 && !this.opts.memoryMappedLsms) return this.send(APCI.PROPERTY_RESPONSE, Buffer.concat([data.subarray(0, 4), Buffer.from([this.control(obj, value)])]));
      this.props.set(`${obj}:${pid}`, { ...this.props.get(`${obj}:${pid}`), elements: Buffer.from(value) });
      return this.send(APCI.PROPERTY_RESPONSE, Buffer.from(data));
    }
    if (apci === APCI.PROPERTY_DESCRIPTION_READ) {
      const [obj, pid, index] = data, d = this.prop(obj, pid)?.description;
      if (!d) return this.send(APCI.PROPERTY_DESCRIPTION_RESPONSE, Buffer.from([obj, 0, index, 0, 0, 0, 0]));
      return this.send(APCI.PROPERTY_DESCRIPTION_RESPONSE, Buffer.from([obj, pid, d.index, d.type, (d.maxElements >> 8) & 0x0f, d.maxElements & 0xff, d.access]));
    }
    // A_Restart: tpdu octet 1 bit 0 is the master-reset request, then the erase code and the channel.
    if ((apci & 0x3e0) === APCI.RESTART && (tpdu[1] & 0x01) === 1) {
      const a = this.opts.masterResetAnswer === undefined ? Buffer.from([0, 0, 0]) : this.opts.masterResetAnswer;
      if (a) this.send(APCI.RESTART | 0x21, a);
      return;
    }
    this.refuse(`service 0x${apci.toString(16)} (${strip(tpdu)})`);
  }
  private prop(obj: number, pid: number): SimProperty | undefined { return this.props.get(`${obj}:${pid}`); }
  private readByte(at: number): number {
    if (this.opts.memoryMappedLsms && at > MM_STATUS_BASE && at <= MM_STATUS_BASE + 15) return this.states.get(at - MM_STATUS_BASE) ?? STATE.UNLOADED;
    return this.memory.get(at) ?? 0;
  }
  // A load event or an additional load control on load-state machine `lsm`; the resulting state.
  private control(lsm: number, value: Buffer): number {
    const event = this.opts.memoryMappedLsms ? value[0] & 0x0f : value[0];
    if (!this.opts.memoryMappedLsms && event === 3 && value[1] === 0x0b) {
      this.allocated.set(lsm, this.nextBase);
      this.nextBase += (value.readUInt32BE(2) + 0xff) & ~0xff;
    }
    const next = event === 1 ? STATE.LOADING : event === 2 ? STATE.LOADED : event === 4 ? STATE.UNLOADED : event === 3 ? STATE.LOADING : undefined;
    if (next === undefined) { this.refuse(`load event ${event}`); return STATE_ERROR; }
    this.states.set(lsm, next);
    return next;
  }
}
