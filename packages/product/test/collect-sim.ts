import { parseApdu, tpAck, APCI, type KnxTransport } from "@busforge/knx";

// A simulated System B device (MV-07B0) on the transport, answering every service raw acquisition
// may send, and recording the APCI of each request it got. Objects, properties and memory are
// plain data, so a test can bend them (refuse a byte, drop a property, go silent).
export interface SimProperty { pdt: number; readLevel: number; elements: Buffer[] }
export interface SimObject { type: number; props: Map<number, SimProperty> }

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const prop = (pdt: number, ...elements: Buffer[]): SimProperty => ({ pdt, readLevel: 3, elements });

export function systemBObjects(): SimObject[] {
  const obj = (type: number, extra: [number, SimProperty][]) => ({ type, props: new Map<number, SimProperty>([[1, prop(0x04, u16(type))], ...extra]) });
  const mcb = (size: number) => Buffer.concat([u32(size), Buffer.from([0, 0, 0x12, 0x34])]);
  return [
    obj(0, [[11, prop(0x11, Buffer.from("00fa01020304", "hex"))], [12, prop(0x04, u16(0x0085))], [56, prop(0x04, u16(55))]]),
    obj(1, [[5, prop(0x0a, Buffer.from([1]))], [7, prop(0x13, u32(0x5000))], [27, prop(0x1b, mcb(10))]]),
    obj(2, [[5, prop(0x0a, Buffer.from([1]))], [7, prop(0x13, u32(0x10000))], [27, prop(0x1b, mcb(60))],
      [23, prop(0x14, ...Array.from({ length: 20 }, (_, i) => u32(i)))]]),
    obj(3, [[5, prop(0x0a, Buffer.from([0]))], [7, prop(0x13, u32(0))]]),
    obj(4, [[5, prop(0x0a, Buffer.from([1]))], [7, prop(0x13, u32(0x5100))], [27, prop(0x1b, mcb(30))], [13, prop(0x11, Buffer.from("0085007201", "hex"))]]),
    obj(5, [[5, prop(0x0a, Buffer.from([1]))]]),
    obj(17, [[51, prop(0x3e, Buffer.from([0]))], [53, prop(0x12, Buffer.alloc(18))]]),
  ];
}

export class SimSystemB implements KnxTransport {
  assignedIa = 0x11ff;
  onCemi: ((src: number, dst: number, tpdu: Buffer, isGroup: boolean) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  // The individual address the sim answers from; null answers as whichever device a request addresses.
  device: number | null = null;
  apcis: number[] = [];
  mask = "07b0";
  objects: SimObject[] = systemBObjects();
  refused = new Set<number>([0x5105]);
  // "object:pid" -> first element index the device refuses to read.
  refuseElementsFrom = new Map<string, number>();
  // At most this many elements per property answer, however many were asked.
  maxElementsPerAnswer = 15;
  // Memory answers echo this offset added to the address asked.
  echoOffset = 0;
  descriptorData: Buffer | null = null;
  // Requests the device leaves unanswered (no ACK, no response) while this returns true.
  silent: (apci: number) => boolean = () => false;
  async connect() {}
  async disconnect() {}
  memory(a: number): number { return (a * 7 + 3) & 0xff; }

  async sendCemi(cemi: Buffer): Promise<void> {
    const tpdu = cemi.subarray(9);
    const from = this.device ?? cemi.readUInt16BE(6);
    if ((tpdu[0] & 0xc0) === 0x80) return; // T_Connect / T_Disconnect
    const p = parseApdu(tpdu);
    if (p.control) return;
    const apci = p.apci === APCI.MEMORY_RESPONSE ? p.apci : ((tpdu[0] & 0x03) << 8) | tpdu[1];
    const service = (apci & 0x3c0) === APCI.MEMORY_READ ? APCI.MEMORY_READ : apci;
    this.apcis.push(service);
    if (this.silent(service)) return;
    const reply = (apciOut: number, data: Buffer, low = 0) => {
      const a = Buffer.concat([Buffer.from([0x40 | (p.seq << 2) | ((apciOut >> 8) & 0x03), (apciOut & 0xff) | (low & 0x3f)]), data]);
      queueMicrotask(() => { this.onCemi?.(from, this.assignedIa, tpAck(p.seq), false); this.onCemi?.(from, this.assignedIa, a, false); });
    };
    const d = p.data;
    switch (service) {
      case APCI.DEVICE_DESCRIPTOR_READ: return reply(APCI.DEVICE_DESCRIPTOR_RESPONSE, this.descriptorData ?? Buffer.from(this.mask, "hex"));
      case APCI.AUTHORIZE_REQUEST: return reply(APCI.AUTHORIZE_RESPONSE, Buffer.from([0]));
      case APCI.PROPERTY_DESCRIPTION_READ: {
        const [o, pid, idx] = d;
        const object = this.objects[o];
        const entries = object ? [...object.props.entries()] : [];
        const hit = pid !== 0 ? entries.find(([k]) => k === pid) : entries[idx];
        if (!hit) return reply(APCI.PROPERTY_DESCRIPTION_RESPONSE, Buffer.from([o, 0, idx, 0, 0, 0, 0]));
        const [k, v] = hit;
        const at = entries.indexOf(hit);
        return reply(APCI.PROPERTY_DESCRIPTION_RESPONSE, Buffer.from([o, k, at, v.pdt, v.elements.length >> 8, v.elements.length & 0xff, (v.readLevel << 4) | 2]));
      }
      case APCI.PROPERTY_READ: {
        const [o, pid] = d;
        const count = d[2] >> 4, start = ((d[2] & 0x0f) << 8) | d[3];
        const v = this.objects[o]?.props.get(pid);
        const from = this.refuseElementsFrom.get(`${o}:${pid}`);
        const refusedHere = from !== undefined && start > 0 && start + count - 1 >= from;
        if (!v || refusedHere || (start > 0 && start + count - 1 > v.elements.length)) return reply(APCI.PROPERTY_RESPONSE, Buffer.from([o, pid, start >> 8, start & 0xff]));
        const n = Math.min(count, this.maxElementsPerAnswer);
        const value = start === 0 ? u16(v.elements.length) : Buffer.concat(v.elements.slice(start - 1, start - 1 + n));
        return reply(APCI.PROPERTY_RESPONSE, Buffer.concat([Buffer.from([o, pid, (n << 4) | (d[2] & 0x0f), d[3]]), value]));
      }
      case APCI.MEMORY_READ: {
        const count = tpdu[1] & 0x3f, a = d.readUInt16BE(0);
        const bytes = Array.from({ length: count }, (_, i) => a + i);
        const data = bytes.some((x) => this.refused.has(x)) ? Buffer.alloc(0) : Buffer.from(bytes.map((x) => this.memory(x)));
        const echo = a + this.echoOffset;
        return reply(APCI.MEMORY_RESPONSE, Buffer.concat([Buffer.from([(echo >> 8) & 0xff, echo & 0xff]), data]), data.length);
      }
      case APCI.MEMORY_EXT_READ: {
        const count = d[0], a = (d[1] << 16) | (d[2] << 8) | d[3];
        const bytes = Array.from({ length: count }, (_, i) => a + i);
        if (bytes.some((x) => this.refused.has(x))) return reply(APCI.MEMORY_EXT_READ_RESP, Buffer.concat([Buffer.from([0xfd]), d.subarray(1, 4)]));
        return reply(APCI.MEMORY_EXT_READ_RESP, Buffer.concat([Buffer.from([0]), d.subarray(1, 4), Buffer.from(bytes.map((x) => this.memory(x)))]));
      }
      case APCI.FUNCTION_PROPERTY_EXT_STATE_READ: return reply(APCI.FUNCTION_PROPERTY_EXT_STATE_RESPONSE, Buffer.concat([d.subarray(0, 5), Buffer.from([0, 0, 0])]));
    }
  }
}

// The services raw acquisition may send (docs/raw-acquisition.md, "Boundaries").
export const ALLOWED_APCIS = new Set<number>([
  APCI.DEVICE_DESCRIPTOR_READ, APCI.AUTHORIZE_REQUEST, APCI.PROPERTY_DESCRIPTION_READ, APCI.PROPERTY_READ,
  APCI.PROPERTY_EXT_READ, APCI.FUNCTION_PROPERTY_EXT_STATE_READ, APCI.MEMORY_READ, APCI.MEMORY_EXT_READ,
]);
