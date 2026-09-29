import { decodeDpt } from "@busforge/knx/dpt";
import type { Telegram, TelegramSecurity } from "../api.ts";

// What the monitor shows in a telegram's value column: the decoded value, or, for a secured telegram
// the server could not open, its state. Only a known group service is run through the DPT decoder: a
// telegram of unknown service (which includes secured telegrams recorded before the monitor could
// tell them apart) shows its raw octets, never a value decoded from them.
export function telegramValue(t: Telegram, dpt: string | undefined): { value: string } | { secureState: Exclude<TelegramSecurity, "decrypted"> } {
  if (t.security && t.security !== "decrypted") return { secureState: t.security };
  if (t.kind === "Unknown") return { value: t.raw ? `0x${t.raw}` : "" };
  return { value: decodeDpt(t.raw, dpt) };
}
