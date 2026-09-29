import { numToIa, numToGa, decodeGroupApdu, type GroupApci } from "@busforge/knx";

export type TelegramKind = GroupApci;

// How a secured (A_Data_Secure) group telegram was received; absent on a plain one. Only
// "decrypted" carries a kind and value; every other state has kind Unknown and an empty value, so
// nothing downstream can decode a value from ciphertext.
export type TelegramSecurity = "decrypted" | "noKey" | "authFailed" | "replay" | "unsupported";
export const TELEGRAM_SECURITY: readonly TelegramSecurity[] = ["decrypted", "noKey", "authFailed", "replay", "unsupported"];

export interface Telegram {
  ts: number;
  src: string;    // source individual address "1.2.50"
  dst: string;    // destination group address "1/2/3"
  dstRaw: number; // 16-bit GA, kept for DB storage and GA-name joins
  kind: TelegramKind;
  raw: string;    // hex of the value payload
  security?: TelegramSecurity;
}

// Turn a decoded group cEMI into a stored/displayable Telegram (address formatting +
// hex payload). The APCI/value split lives in @busforge/knx (decodeGroupApdu), so the
// bus-level bit layout is defined once.
export function decodeGroupTpdu(src: number, dst: number, tpdu: Buffer, ts: number): Telegram {
  const { apci, value } = decodeGroupApdu(tpdu);
  return { ts, src: numToIa(src), dst: numToGa(dst), dstRaw: dst, kind: apci, raw: value.toString("hex") };
}

// A secured group telegram the monitor could not open (or must not show): no kind, no value.
export function undecodedSecureTelegram(src: number, dst: number, security: Exclude<TelegramSecurity, "decrypted">, ts: number): Telegram {
  return { ts, src: numToIa(src), dst: numToGa(dst), dstRaw: dst, kind: "Unknown", raw: "", security };
}
