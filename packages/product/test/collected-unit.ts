// A unit in service as a read-only collection (tools/collect.ts) shows it, emulated: the interface
// object properties it answered (every element read), the memory it gave back, its load states, and
// writes that change them as the device would (load-state events on PID 5, a System 7 segment
// declaration moving a table reference, memory). It answers only what the collection holds: a read of
// memory or a property the collection did not read throws, so no path runs on invented bytes.
import { STATE, type KnxDevice } from "@busforge/knx";

// One record of a collection, as far as the emulator reads it.
export interface CollectedRecord { step: string; space: string; target: { object?: number; pid?: number; start?: number; count?: number; address?: number; length?: number }; outcome: string; bytes?: string }
export interface Collection { mask: string; records: CollectedRecord[] }

export class CollectedUnit {
  readonly mask: string;
  mem = new Map<number, number>();
  // "object/pid/start" -> the element as answered; null where the unit refused the property.
  props = new Map<string, Buffer | null>();
  ops: string[] = [];
  constructor(c: Collection) {
    this.mask = c.mask;
    for (const r of c.records) {
      if (r.space === "memory" && r.outcome === "bytes" && r.target.address !== undefined) Buffer.from(r.bytes!, "hex").forEach((b, i) => this.mem.set(r.target.address! + i, b));
      if (r.space === "property" && r.target.object !== undefined && r.target.pid !== undefined && (r.target.count ?? 1) === 1 && (r.outcome === "bytes" || r.outcome === "refused")) {
        this.props.set(`${r.target.object}/${r.target.pid}/${r.target.start ?? 1}`, r.outcome === "bytes" ? Buffer.from(r.bytes!, "hex") : null);
      }
    }
  }
  private prop(obj: number, pid: number, start = 1): Buffer | null {
    const k = `${obj}/${pid}/${start}`;
    if (!this.props.has(k)) throw new Error(`the collection did not read property ${obj}/${pid} element ${start}`);
    return this.props.get(k)!;
  }
  state(obj: number): number { return this.prop(obj, 5)?.[0] ?? STATE.UNLOADED; }

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
    if (this.ops.at(-1) !== "write") this.ops.push("write");
    data.forEach((b, i) => this.mem.set(addr + i, b));
  }
  async propRead(obj: number, pid: number, start = 1) { return this.prop(obj, pid, start) ?? Buffer.alloc(0); }
  async propReadIfPresent(obj: number, pid: number) { const v = this.prop(obj, pid); return v?.length ? v : null; }
  async propReadCounted(obj: number, pid: number, start: number, count = 1) {
    const value = Buffer.concat(Array.from({ length: count }, (_, i) => this.prop(obj, pid, start + i) ?? Buffer.alloc(0)));
    this.ops.push(`read ${obj}/${pid}#${start}${count > 1 ? `x${count}` : ""}`);
    return { objectIndex: obj, pid, count, start, value };
  }
  async propWrite(obj: number, pid: number, data: Buffer, start = 1) {
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
