// KNXnet/IP + cEMI + TPCI/APCI byte handling. See ../../../docs/findings.md.

export const KNXPORT = 3671;

// --- individual address ---
export const iaToNum = (s: string) => { const [a, l, d] = s.split(/[./]/).map(Number); return (a << 12) | (l << 8) | d; };
export const numToIa = (n: number) => `${(n >> 12) & 0xf}.${(n >> 8) & 0xf}.${n & 0xff}`;

// --- KNXnet/IP service ids ---
export const SVC = {
  SEARCH_REQ: 0x0201, SEARCH_RES: 0x0202,
  CONNECT_REQ: 0x0205, CONNECT_RES: 0x0206,
  DISCONNECT_REQ: 0x0209, DISCONNECT_RES: 0x020a,
  TUNNEL_REQ: 0x0420, TUNNEL_ACK: 0x0421,
} as const;

// --- APCI (10-bit) ---
export const APCI = {
  DEVICE_DESCRIPTOR_READ: 0x300, DEVICE_DESCRIPTOR_RESPONSE: 0x340,
  MEMORY_READ: 0x200, MEMORY_RESPONSE: 0x240, MEMORY_WRITE: 0x280,
  PROPERTY_READ: 0x3d5, PROPERTY_RESPONSE: 0x3d6, PROPERTY_WRITE: 0x3d7,
  RESTART: 0x380,
} as const;

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
export const numToGa = (n: number) => `${(n >> 11) & 0x1f}/${(n >> 8) & 0x7}/${n & 0xff}`;
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
