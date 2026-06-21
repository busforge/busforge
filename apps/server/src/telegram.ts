import { numToIa, numToGa } from "@busforge/knx";

export type TelegramKind = "GroupValueRead" | "GroupValueResponse" | "GroupValueWrite" | "Unknown";

export interface Telegram {
  ts: number;
  src: string;    // source individual address "1.2.50"
  dst: string;    // destination group address "1/2/3"
  dstRaw: number; // 16-bit GA, kept for DB storage and GA-name joins
  kind: TelegramKind;
  raw: string;    // hex of the value payload
}

// Classify a group cEMI TPDU. Group telegrams are unnumbered T_Data: the 10-bit
// APCI lives in the low 2 bits of octet 0 and all of octet 1.
export function decodeGroupTpdu(src: number, dst: number, tpdu: Buffer, ts: number): Telegram {
  const apci = ((tpdu[0] & 0x03) << 8) | (tpdu[1] ?? 0);
  const top = apci & 0x03c0;
  const kind: TelegramKind =
    top === 0x000 ? "GroupValueRead" :
    top === 0x040 ? "GroupValueResponse" :
    top === 0x080 ? "GroupValueWrite" : "Unknown";

  // Value: >2 bytes carries data in trailing octets; a 2-byte APDU packs a 6-bit
  // value into the low bits of octet 1.
  const payload = tpdu.length > 2 ? tpdu.subarray(2) : Buffer.from([tpdu[1] & 0x3f]);
  return { ts, src: numToIa(src), dst: numToGa(dst), dstRaw: dst, kind, raw: payload.toString("hex") };
}
