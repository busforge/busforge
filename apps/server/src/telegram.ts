import { numToIa, numToGa, decodeGroupApdu, type GroupApci } from "@busforge/knx";

export type TelegramKind = GroupApci;

export interface Telegram {
  ts: number;
  src: string;    // source individual address "1.2.50"
  dst: string;    // destination group address "1/2/3"
  dstRaw: number; // 16-bit GA, kept for DB storage and GA-name joins
  kind: TelegramKind;
  raw: string;    // hex of the value payload
}

// Turn a decoded group cEMI into a stored/displayable Telegram (address formatting +
// hex payload). The APCI/value split lives in @busforge/knx (decodeGroupApdu), so the
// bus-level bit layout is defined once.
export function decodeGroupTpdu(src: number, dst: number, tpdu: Buffer, ts: number): Telegram {
  const { apci, value } = decodeGroupApdu(tpdu);
  return { ts, src: numToIa(src), dst: numToGa(dst), dstRaw: dst, kind: apci, raw: value.toString("hex") };
}
