// KNXnet/IP + cEMI + TPCI/APCI byte handling. See ../../../docs/findings.md.
import { formatGa, type Levels } from "./ga.ts";

export const KNXPORT = 3671;

// --- individual address ---
export const iaToNum = (s: string) => { const [a, l, d] = s.split(/[./]/).map(Number); return (a << 12) | (l << 8) | d; };
export const numToIa = (n: number) => `${(n >> 12) & 0xf}.${(n >> 8) & 0xf}.${n & 0xff}`;

// --- KNXnet/IP service ids ---
export const SVC = {
  SEARCH_REQ: 0x0201, SEARCH_RES: 0x0202,
  DESCRIPTION_REQ: 0x0203, DESCRIPTION_RES: 0x0204,
  CONNECT_REQ: 0x0205, CONNECT_RES: 0x0206,
  CONNECTIONSTATE_REQ: 0x0207, CONNECTIONSTATE_RES: 0x0208,
  DISCONNECT_REQ: 0x0209, DISCONNECT_RES: 0x020a,
  DEVICE_CONFIG_REQ: 0x0310, DEVICE_CONFIG_ACK: 0x0311,
  TUNNEL_REQ: 0x0420, TUNNEL_ACK: 0x0421,
} as const;

// --- cEMI message codes ---
// The code decides what a frame MEANS, and the three are easy to confuse because they carry
// identical L_Data bytes behind it: .req is "put this on the bus", .con is the interface
// confirming it did, .ind is a telegram that came FROM the bus. Anything that forwards or
// displays telegrams has to branch on this, or it will report our own outgoing frames back to
// us as if a device had sent them.
export const CEMI = { LDATA_REQ: 0x11, LDATA_CON: 0x2e, LDATA_IND: 0x29 } as const;

// The confirm flag lives in the low bit of the first control field of an L_Data.con: 0 means the
// frame reached the bus, 1 means it did not. It is the only channel a KNXnet/IP server has to
// tell a tunnelling client that its telegram was lost.
export const CEMI_CON_ERROR = 0x01;

// --- APCI (10-bit) ---
export const APCI = {
  DEVICE_DESCRIPTOR_READ: 0x300, DEVICE_DESCRIPTOR_RESPONSE: 0x340,
  MEMORY_READ: 0x200, MEMORY_RESPONSE: 0x240, MEMORY_WRITE: 0x280,
  PROPERTY_READ: 0x3d5, PROPERTY_RESPONSE: 0x3d6, PROPERTY_WRITE: 0x3d7,
  RESTART: 0x380,
  // Individual-address management. These are BROADCAST services (unnumbered, destination
  // 0x0000): they address a device by the fact that its programming mode is on, not by its
  // address, which is what makes them the only way to reach a device that has none yet.
  // The Response carries no payload; the responding device's address is the frame's SOURCE.
  INDIVIDUAL_ADDRESS_WRITE: 0x0c0, INDIVIDUAL_ADDRESS_READ: 0x100, INDIVIDUAL_ADDRESS_RESPONSE: 0x140,
  // Addressing a device by its SERIAL NUMBER instead of by its programming mode. Also broadcast,
  // but it names exactly one device, so it needs no button pressed and cannot hit a bystander.
  // That matters most in the situation it exists for: several unconfigured devices on one line,
  // all sitting on the factory address, where nothing else can tell them apart.
  IA_SERIAL_READ: 0x3dc, IA_SERIAL_RESPONSE: 0x3dd, IA_SERIAL_WRITE: 0x3de,
} as const;

// The KNX broadcast address: destination 0x0000 with the group/broadcast address type, which
// cemiLDataGroup already sets. Every device on the line receives it.
export const BROADCAST = 0x0000;

// An unnumbered (T_Data_Broadcast / T_Data_Group) APDU: no sequence number, unlike the
// connection-oriented `apdu()` above. Broadcast management services use this form.
export function apduUnnumbered(apci: number, tail: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([(apci >> 8) & 0x03, apci & 0xff]), tail]);
}

export function knxFrame(service: number, body: Buffer): Buffer {
  const h = Buffer.from([0x06, 0x10, (service >> 8) & 0xff, service & 0xff, 0, 0]);
  h.writeUInt16BE(h.length + body.length, 4);
  return Buffer.concat([h, body]);
}
export function hpai(ip: string, port: number): Buffer {
  const b = Buffer.alloc(8); b[0] = 8; b[1] = 1;
  ip.split(".").forEach((o, i) => (b[2 + i] = Number(o)));
  b.writeUInt16BE(port, 6); return b;
}
// HPAI for a frame carried on a TCP connection (KNXnet/IP Core v2, 3/8/2 §5.2.1). The host
// protocol code is 0x02 (IPV4_TCP) and both address and port are zero: on a TCP connection the
// socket itself is the endpoint, so there is nothing to name and the receiver answers on the same
// connection rather than at any address these bytes could carry.
export function hpaiTcp(): Buffer {
  return Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}
export interface Endpoint { address: string; port: number; }
// Read an HPAI out of a frame body. A client that sits behind NAT (or simply does not know its
// own routable address, which is what our own tunnel does) advertises 0.0.0.0:0 and means "answer
// wherever this packet came from" — so the datagram's real origin is the fallback, not an error.
export function parseHpai(b: Buffer, off: number, from: Endpoint): Endpoint {
  const address = `${b[off + 2]}.${b[off + 3]}.${b[off + 4]}.${b[off + 5]}`;
  const port = b.readUInt16BE(off + 6);
  return address === "0.0.0.0" || port === 0 ? from : { address, port };
}

// KNXnet/IP over UDP is one frame per datagram; over TCP it is a byte stream, where a single frame
// may arrive split across several reads or several frames coalesced into one read. This reassembles
// the stream into whole frames. Every KNXnet/IP frame is self-describing: the 6-byte header
// 06 10 <service:2> <totalLength:2> states the full frame length (header included), so the header
// alone says where the frame ends. A stream that does not begin with the 06 10 header magic, or
// that declares a length below the header itself, is a desynchronised or hostile peer with no safe
// resync point, so push() throws and the caller drops the connection rather than guess. Because the
// length field is 16 bits, a single frame is bounded at 65535 bytes and cannot force an unbounded
// allocation.
export class KnxIpStreamParser {
  private buf: Buffer = Buffer.alloc(0);
  // Feed a received chunk and return every complete frame now available, in arrival order.
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 6) {
      if (this.buf[0] !== 0x06 || this.buf[1] !== 0x10) {
        throw new Error(`KNXnet/IP TCP stream out of frame: header begins 0x${this.buf[0]!.toString(16)} 0x${this.buf[1]!.toString(16)}, not 06 10`);
      }
      const total = this.buf.readUInt16BE(4);
      if (total < 6) throw new Error(`KNXnet/IP frame length ${total} is below the 6-byte header`);
      if (this.buf.length < total) break; // the rest of this frame has not arrived yet
      out.push(this.buf.subarray(0, total));
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

// Re-stamp a cEMI frame with a different message code, leaving every other byte alone. Used by
// the KNXnet/IP server to turn a client's L_Data.req into the .con it owes that client and into
// the .ind the other tunnels see. Re-encoding the frame from its decoded fields instead would
// quietly normalise priority, hop count and the repeat flag into whatever the encoder emits.
export function withMessageCode(cemi: Buffer, code: number): Buffer {
  const out = Buffer.from(cemi);
  out[0] = code;
  return out;
}

// Source address of a cEMI L_Data frame. The additional-info field is variable-length, so the
// address does not sit at a fixed offset.
export const cemiSource = (cemi: Buffer): number => cemi.readUInt16BE(2 + cemi[1] + 2);
export function withSource(cemi: Buffer, src: number): Buffer {
  const out = Buffer.from(cemi);
  out.writeUInt16BE(src, 2 + out[1] + 2);
  return out;
}
// L_Data.req cEMI carrying a raw TPDU (point-to-point, individual dest)
export function cemiLData(src: number, dst: number, tpdu: Buffer): Buffer {
  const head = Buffer.from([0x11, 0x00, 0xbc, 0x60, (src >> 8) & 0xff, src & 0xff, (dst >> 8) & 0xff, dst & 0xff, tpdu.length - 1]);
  return Buffer.concat([head, tpdu]);
}

// --- TPCI / APDU builders (connection-oriented) ---
export const tpConnect = () => Buffer.from([0x80]);
export const tpDisconnect = () => Buffer.from([0x81]);
export const tpAck = (seq: number) => Buffer.from([0xc2 | (seq << 2)]);

// numbered T_Data_Connected with a 10-bit APCI + optional trailing bytes
export function apdu(seq: number, apci: number, tail: Buffer = Buffer.alloc(0), apciLowData = 0): Buffer {
  const o0 = 0x40 | (seq << 2) | ((apci >> 8) & 0x03);
  const o1 = (apci & 0xff) | (apciLowData & 0x3f);
  return Buffer.concat([Buffer.from([o0, o1]), tail]);
}

export interface ParsedApdu { control: boolean; seq: number; apci: number; data: Buffer; }
export function parseApdu(tpdu: Buffer): ParsedApdu {
  const t = tpdu[0];
  if ((t & 0xc0) === 0xc0) return { control: true, seq: (t >> 2) & 0x0f, apci: -1, data: Buffer.alloc(0) }; // ACK/NAK
  const seq = (t >> 2) & 0x0f;
  let apci = ((t & 0x03) << 8) | (tpdu[1] ?? 0);
  // memory services carry a 6-bit count in the low bits of octet1
  if ((apci & 0x3c0) === APCI.MEMORY_RESPONSE) apci = APCI.MEMORY_RESPONSE;
  return { control: false, seq, apci, data: tpdu.subarray(2) };
}

// --- group address (multicast) ---
export const gaToNum = (s: string) => { const [m, mid, sub] = s.split("/").map(Number); return (m << 11) | (mid << 8) | sub; };

// The single level-aware GA formatter lives in the dependency-free ./ga module (so the
// browser can import it too via the "@busforge/knx/ga" subpath); re-exported here for the
// node callers that import it from frame.
export { formatGa, type Levels };
// The bus-log / no-project-context default is three-level.
export const numToGa = (n: number) => formatGa(n, 3);
export function cemiLDataGroup(src: number, ga: number, tpdu: Buffer): Buffer {
  const head = Buffer.from([0x11, 0x00, 0xbc, 0xe0, (src >> 8) & 0xff, src & 0xff, (ga >> 8) & 0xff, ga & 0xff, tpdu.length - 1]);
  return Buffer.concat([head, tpdu]);
}
export const groupValueRead = () => Buffer.from([0x00, 0x00]); // unnumbered, APCI GroupValueRead

// Decode an unnumbered group T_Data APDU (the TPDU of a group-addressed L_Data). The
// 10-bit APCI is the low 2 bits of octet 0 plus all of octet 1; the top 4 APCI bits
// select the group service. The value is the trailing octets for a >2-byte APDU, or the
// low 6 bits of octet 1 packed into a single byte for the compact 2-byte form. This is
// the group-telegram counterpart to parseApdu (which handles numbered T_Data_Connected).
export type GroupApci = "GroupValueRead" | "GroupValueResponse" | "GroupValueWrite" | "Unknown";
export interface GroupApdu { apci: GroupApci; value: Buffer; }
export function decodeGroupApdu(tpdu: Buffer): GroupApdu {
  const top = (((tpdu[0] & 0x03) << 8) | (tpdu[1] ?? 0)) & 0x03c0;
  const apci: GroupApci =
    top === 0x000 ? "GroupValueRead" :
    top === 0x040 ? "GroupValueResponse" :
    top === 0x080 ? "GroupValueWrite" : "Unknown";
  const value = tpdu.length > 2 ? Buffer.from(tpdu.subarray(2)) : Buffer.from([(tpdu[1] ?? 0) & 0x3f]);
  return { apci, value };
}
