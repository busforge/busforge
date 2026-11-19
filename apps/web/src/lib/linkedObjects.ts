import type { GaComObj, GaDevicesView } from "../api.ts";

// One com-object that shares a group address with the object shown, as the link view lists it:
// whether it sends on the address (the server's sender split: communication and transmit flags, and
// the address is its first) and whether it takes writes from it (its write flag). An object that does
// neither is still linked and listed.
export interface LinkedObject extends GaComObj { sends: boolean; receives: boolean; sameDevice: boolean }

// The objects on one address besides `self` (an object its device page shows), from the address's
// device view: each object once, also where it is both sender and receiver, ordered by individual
// address and object number. A hidden object of the same device and number is another ref, not `self`.
export function linkedObjects(view: Pick<GaDevicesView, "senders" | "receivers">, self: { deviceId: string; comObjNumber: number }): LinkedObject[] {
  const key = (e: GaComObj) => `${e.deviceId}\u0000${e.comObjRefId}`;
  const senders = new Set(view.senders.map(key));
  const out = new Map<string, LinkedObject>();
  for (const e of [...view.senders, ...view.receivers]) {
    if (!e.hidden && e.deviceId === self.deviceId && e.comObjNumber === self.comObjNumber) continue;
    const k = key(e);
    if (!out.has(k)) out.set(k, { ...e, sends: senders.has(k), receives: e.flags.write, sameDevice: e.deviceId === self.deviceId });
  }
  return [...out.values()].sort((a, b) => a.ia.localeCompare(b.ia, undefined, { numeric: true }) || a.comObjNumber - b.comObjNumber);
}

// Where a linked object's row leads on its device page: to its row (`co`), unless the device's
// configuration hides it. Then the page has no row for it, and its number may be another object's.
export const objectSearch = (e: Pick<GaComObj, "comObjNumber" | "hidden">): { co?: number } =>
  e.hidden ? {} : { co: e.comObjNumber };

// Whether `flags`, and whether the object sends or receives by them, are the object's as its device
// has them: not where the project's own flags cannot be placed (they are the application's), and not
// for an object its configuration hides (its project overrides are not resolved). The device page
// shows none in either case.
export const flagsKnown = (e: Pick<GaComObj, "flagsRefused" | "hidden">): boolean => !e.flagsRefused && !e.hidden;
