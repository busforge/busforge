import type { GaComObj, GaDevicesView } from "../api.ts";

// One com-object that shares a group address with the object shown, as the link view lists it:
// whether it sends on the address (the server's sender split: communication and transmit flags, and
// the address is its first) and whether it takes writes from it (its write flag). An object that does
// neither is still linked and listed.
export interface LinkedObject extends GaComObj { sends: boolean; receives: boolean; sameDevice: boolean }

// The objects on one address besides `self`, from the address's device view: each object once, also
// where it is both sender and receiver, ordered by individual address and object number.
export function linkedObjects(view: Pick<GaDevicesView, "senders" | "receivers">, self: { deviceId: string; comObjNumber: number }): LinkedObject[] {
  const key = (e: GaComObj) => `${e.deviceId}\u0000${e.comObjNumber}`;
  const senders = new Set(view.senders.map(key));
  const out = new Map<string, LinkedObject>();
  for (const e of [...view.senders, ...view.receivers]) {
    if (e.deviceId === self.deviceId && e.comObjNumber === self.comObjNumber) continue;
    const k = key(e);
    if (!out.has(k)) out.set(k, { ...e, sends: senders.has(k), receives: e.flags.write, sameDevice: e.deviceId === self.deviceId });
  }
  return [...out.values()].sort((a, b) => a.ia.localeCompare(b.ia, undefined, { numeric: true }) || a.comObjNumber - b.comObjNumber);
}
