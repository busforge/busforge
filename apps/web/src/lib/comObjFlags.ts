import type { CfgComObjView } from "../api.ts";

export type Flag = keyof CfgComObjView["flags"];
// ETS's order of the flags (C R W T U I).
export const FLAGS: { flag: Flag; key: string }[] = [
  { flag: "comm", key: "Communication" }, { flag: "read", key: "Read" }, { flag: "write", key: "Write" },
  { flag: "transmit", key: "Transmit" }, { flag: "update", key: "Update" }, { flag: "readOnInit", key: "ReadOnInit" },
];

// The set flags as ETS's letters (K L S Ü A I in German), in ETS's order.
export const flagLetters = (flags: Record<Flag, boolean>, t: (key: string) => string): string =>
  FLAGS.filter(({ flag }) => flags[flag]).map(({ key }) => t(`device.flagLetter${key}`)).join(" ");
