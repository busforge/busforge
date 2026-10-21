// A unit in service as a read-only collection (tools/collect.ts) shows it, emulated: the interface
// object properties it answered (every element read), the memory it gave back, its load states, and
// writes that change them as the device would (load-state events on PID 5, a System 7 segment
// declaration moving a table reference, memory). It answers only what the collection holds: a read of
// memory or a property the collection did not read throws, so no path runs on invented bytes.
import { STATE, transferChunks, type KnxDevice, type PropertyDescription } from "@busforge/knx";
import { isMemoryMappedLsm } from "../src/masks.ts";

const MM_CTRL = 0x0104, MM_STATE = 46825;

// One record of a collection, as far as the emulator reads it.
export interface CollectedRecord { step: string; space: string; target: { object?: number; pid?: number; start?: number; count?: number; address?: number; length?: number; propertyIndex?: number }; outcome: string; bytes?: string; description?: PropertyDescription }
export interface Collection { mask: string; records: CollectedRecord[] }

export class CollectedUnit {
  readonly mask: string;
  mem = new Map<number, number>();
  // "object/pid/start" -> the element as answered; null where the unit refused the property.
  props = new Map<string, Buffer | null>();
  // "object/pid" -> the description the unit gave of that property.
  descriptions = new Map<string, PropertyDescription>();
  ops: string[] = [];
  // Objects whose PID 5 no longer answers as collected: a memory-mapped load event changed their state,
  // and no capture shows whether the unit's PID 5 follows it.
  private pid5Unknown = new Set<number>();
  constructor(c: Collection) {
    this.mask = c.mask;
    for (const r of c.records) {
      if (r.space === "memory" && r.outcome === "bytes" && r.target.address !== undefined) Buffer.from(r.bytes!, "hex").forEach((b, i) => this.mem.set(r.target.address! + i, b));
      if (r.space === "property" && r.target.object !== undefined && r.target.pid !== undefined && (r.target.count ?? 1) === 1 && (r.outcome === "bytes" || r.outcome === "refused")) {
        this.props.set(`${r.target.object}/${r.target.pid}/${r.target.start ?? 1}`, r.outcome === "bytes" ? Buffer.from(r.bytes!, "hex") : null);
      }
      if (r.space === "property-description" && r.outcome === "bytes" && r.description && r.description.pid !== 0) this.descriptions.set(`${r.description.objectIndex}/${r.description.pid}`, r.description);
    }
  }
  private prop(obj: number, pid: number, start = 1): Buffer | null {
    if (pid === 5 && start === 1 && this.pid5Unknown.has(obj)) throw new Error(`PID 5 of object ${obj} after a memory-mapped load event: no capture shows whether the unit's PID 5 follows its state at ${MM_STATE + obj}`);
    const k = `${obj}/${pid}/${start}`;
    if (!this.props.has(k)) throw new Error(`the collection did not read property ${obj}/${pid} element ${start}`);
    return this.props.get(k)!;
  }
  state(obj: number): number { return this.prop(obj, 5)?.[0] ?? STATE.UNLOADED; }
  // A load-state machine's state where the unit reports it: on a memory-mapped mask the byte at
  // 46825 + LSM, else PID 5.
  loadState(obj: number): number {
    if (!isMemoryMappedLsm(this.mask)) return this.state(obj);
    const b = this.mem.get(MM_STATE + obj);
    if (b === undefined) throw new Error(`the collection did not read the state of LSM ${obj} at ${MM_STATE + obj}`);
    return b;
  }

  async connect() {}
  async disconnect() {}
  async deviceDescriptor() { return this.mask; }
  async authorizeFreeKey() { return 0; }
  async restart() { this.ops.push("restart"); }
  async setVerifyMode() {}
  async writesConfirmed() { return false; }
  confirmedWrites() { return []; }
  clearConfirmedWrites() {}
  setExtendedMemoryServices() {}
  acceptUnprovenRestart() {}
  async propValueDataMax() { return 10; }
  // The maximum APDU the unit declares (object 0 PID 56), or none where it refused it, as KnxDevice reads it.
  async classicReadChunk() {
    const v = this.prop(0, 56);
    if (v !== null && v.length === 0) throw new Error("the collection holds an empty maximum APDU length (object 0 PID 56)");
    return transferChunks(v === null ? null : v.length >= 2 ? v.readUInt16BE(0) : v[0], false).classicRead;
  }
  async tableAddr(obj: number) { let a = 0; for (const x of this.prop(obj, 7) ?? []) a = (a << 8) | x; return a; }
  async memRead(addr: number, len: number) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      const b = this.mem.get(addr + i);
      if (b === undefined) throw new Error(`the collection did not read memory at 0x${(addr + i).toString(16)}`);
      out[i] = b;
    }
    return out;
  }
  async memWrite(addr: number, data: Buffer) {
    // A memory-mapped System 7 unit (MV-0700/0701) takes its load controls at 0x0104 and answers each
    // load-state machine's state at 46825 + LSM (packages/knx/src/flash.ts). Its PID 5 agrees with that
    // byte at rest (the Meteodata 140 S collection); no capture reads it during a load, so after an event
    // it refuses its PID 5.
    if (addr === MM_CTRL && isMemoryMappedLsm(this.mask)) {
      const lsm = data[0] >> 4, event = data[0] & 0x0f;
      if (event === 3 && data[1] === 0) { this.props.set(`${lsm}/7/1`, data.subarray(3, 5)); this.ops.push(`absSegment:${lsm}`); }
      else if (event === 3) this.ops.push(`segment:${lsm}:${data[1]}`);
      else {
        const ev = ({ 1: "load", 2: "loadCompleted", 4: "unload" } as Record<number, string>)[event];
        if (!ev) throw new Error(`unexpected load-state event ${data.toString("hex")} on LSM ${lsm}`);
        if (!this.mem.has(MM_STATE + lsm)) throw new Error(`the collection did not read the state of LSM ${lsm} at ${MM_STATE + lsm}`);
        const state = event === 1 ? STATE.LOADING : event === 2 ? STATE.LOADED : STATE.UNLOADED;
        this.mem.set(MM_STATE + lsm, state);
        this.pid5Unknown.add(lsm);
        this.ops.push(`${ev}:${lsm}`);
      }
      return;
    }
    if (this.ops.at(-1) !== "write") this.ops.push("write");
    data.forEach((b, i) => this.mem.set(addr + i, b));
  }
  async propertyDescription(obj: number, pid: number) {
    const d = this.descriptions.get(`${obj}/${pid}`);
    if (!d) throw new Error(`the collection did not read the description of property ${obj}/${pid}`);
    return d;
  }
  async propRead(obj: number, pid: number, start = 1) { return this.prop(obj, pid, start) ?? Buffer.alloc(0); }
  async propReadIfPresent(obj: number, pid: number) { const v = this.prop(obj, pid); return v?.length ? v : null; }
  async propReadCounted(obj: number, pid: number, start: number, count = 1) {
    const value = Buffer.concat(Array.from({ length: count }, (_, i) => this.prop(obj, pid, start + i) ?? Buffer.alloc(0)));
    this.ops.push(`read ${obj}/${pid}#${start}${count > 1 ? `x${count}` : ""}`);
    return { objectIndex: obj, pid, count, start, value };
  }
  async propWrite(obj: number, pid: number, data: Buffer, start = 1) {
    if (pid === 5 && isMemoryMappedLsm(this.mask)) throw new Error(`a PID 5 write to object ${obj} on memory-mapped mask ${this.mask}: its load controls go to 0x0104, and no capture shows how it takes this`);
    if (pid === 5) {
      const set = (s: number) => this.props.set(`${obj}/5/1`, Buffer.from([s]));
      if (data[0] === 3 && data[1] === 0) { this.props.set(`${obj}/7/1`, data.subarray(2, 4)); this.ops.push(`absSegment:${obj}`); }
      else if (data[0] === 3) this.ops.push(`segment:${obj}:${data[1]}`);
      else {
        const ev = ({ 1: "load", 2: "loadCompleted", 4: "unload" } as Record<number, string>)[data[0]];
        if (!ev) throw new Error(`unexpected load-state event ${data.toString("hex")} on object ${obj}`);
        set(data[0] === 1 ? STATE.LOADING : data[0] === 2 ? STATE.LOADED : STATE.UNLOADED);
        this.ops.push(`${ev}:${obj}`);
      }
      return Buffer.from([this.state(obj)]);
    }
    this.props.set(`${obj}/${pid}/${start}`, Buffer.from(data));
    this.ops.push(`prop ${obj}/${pid}#${start}`);
    return data;
  }
}
export const asDevice = (u: CollectedUnit) => u as unknown as KnxDevice;
