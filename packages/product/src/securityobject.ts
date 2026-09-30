import { GROUP_KEY_ENTRY, SENDER_ENTRY, type SecurityObjectTables } from "@busforge/knx";
import type { ComObjectLink } from "./grouptables.ts";
import { ProductError } from "./errors.ts";

// The flag byte for a group object linked to a secured group address: bit 0 authentication, bit 1
// confidentiality, one byte per object for both directions (thelsing/knx
// SecurityInterfaceObject::getGroupObjectSecurity checks the same byte on send and receive). ETS
// writes 0x03 for such an object and 0x00 for every other one (Jung 400021SE, 2026-09-28); it offers
// no authentication-only setting.
export const GO_SECURED = 0x03;

// What a Data Secure device's security object holds for a set of links: the key of every secured
// group address the device is linked to, and one flag byte per com-object from object 1 to
// `comObjCount`. A key entry is filed under the address's 1-based position in the device's address
// table (the group index buildGroupTables assigns), not under the address: the device looks a key
// up by that index, and stops at the first entry past it, so the entries are ascending
// (thelsing/knx SecurityInterfaceObject::groupKey). In ETS's capture of the Jung both are 1, since
// its one secured address 0/0/1 is also the first in its table.
//
// An object linked to both secured and plain addresses has no single flag that is right for both,
// so it is refused rather than given one.
//
// The security individual address table lists who may send the device secured group telegrams, once
// each, ascending (thelsing/knx looks entries up by binary search), never the device itself, each
// with the last sequence number accepted from it:
// - the senders the project assigns to each secured address it uses (a tunnelling channel), with 0;
// - every other secured device with an object that transmits on such an address, with the
//   SequenceNumber the project holds for that device.
// Both as ETS 6.4.1 loads them (the Jung 400021SE and the GVS AMMA on one secured address,
// 2026-09-30). Another device linked to a secured address only by objects that do not transmit, or
// without a sequence in the project, is not shown and is refused.
// unresolved: why the device cannot be classed as a sender or not (its application or object does not
// resolve, or the linked object is hidden); such a device is refused, never left out.
export interface OtherDevice { ia: number; transmits: boolean; sequence: bigint | null; unresolved?: string | null }
export interface SecuritySenders {
  byGa: ReadonlyMap<number, readonly number[]>;        // group address -> assigned sender individual addresses
  ownIa: number;
  otherDevices: ReadonlyMap<number, readonly OtherDevice[]>; // group address -> the other devices linked to it
}
export function buildSecurityObject(links: ComObjectLink[], comObjCount: number, groupKeys: ReadonlyMap<number, Buffer>, senders?: SecuritySenders): SecurityObjectTables {
  const goFlags = Buffer.alloc(comObjCount);
  for (const l of links) {
    const secured = l.gaRaws.filter((g) => groupKeys.has(g));
    if (secured.length === 0) continue;
    if (secured.length !== l.gaRaws.length) {
      throw new ProductError("SECURE_LINK_MIXED", `communication object #${l.comObjNum} is linked to both secured and plain group addresses; refusing to pick one security flag for both`);
    }
    if (l.comObjNum < 1 || l.comObjNum > comObjCount) {
      throw new ProductError("COM_OBJECT_NUMBER_INVALID", `communication object #${l.comObjNum} is outside the ${comObjCount} objects of this application`);
    }
    goFlags[l.comObjNum - 1] = GO_SECURED;
  }
  // The same ordering buildGroupTables writes the address table in.
  const table = [...new Set(links.flatMap((l) => l.gaRaws))].sort((a, b) => a - b);
  const secured = table.map((g, i) => ({ g, index: i + 1 })).filter(({ g }) => groupKeys.has(g));
  const groupKeyTable = Buffer.alloc(secured.length * GROUP_KEY_ENTRY);
  secured.forEach(({ g, index }, i) => {
    const key = groupKeys.get(g)!;
    if (key.length !== 16) throw new ProductError("SECURE_KEY_BAD", `the key of group address ${g} is ${key.length} bytes, not 16`);
    groupKeyTable.writeUInt16BE(index, i * GROUP_KEY_ENTRY);
    key.copy(groupKeyTable, i * GROUP_KEY_ENTRY + 2);
  });
  const listed = new Map<number, bigint>();
  for (const { g } of secured) {
    for (const ia of senders?.byGa.get(g) ?? []) if (ia !== senders!.ownIa && !listed.has(ia)) listed.set(ia, 0n);
    const seen = new Set<number>();
    for (const o of senders?.otherDevices.get(g) ?? []) {
      if (o.ia === senders!.ownIa) {
        throw new ProductError("SECURE_SENDERS_UNPROVEN", `secured group address ${g} is linked to another device with this device's own individual address; refusing to decide which of them to list`);
      }
      if (seen.has(o.ia)) throw new ProductError("SECURE_SENDERS_UNPROVEN", `secured group address ${g} is linked to two devices with the same individual address; refusing to pick one`);
      seen.add(o.ia);
      const why = o.unresolved ?? (!o.transmits ? "that does not transmit on it (no transmitting object with it as sending address)" : o.sequence === null ? "whose sequence number the project does not hold" : o.sequence >= 2n ** 48n ? "whose sequence number does not fit 48 bits" : null);
      if (why) {
        throw new ProductError("SECURE_SENDERS_UNPROVEN", `secured group address ${g} is also linked to another device ${o.unresolved ? `(${why})` : why}; whether a receiver lists it is not established, so its security object is not loaded`);
      }
      listed.set(o.ia, o.sequence!);
    }
  }
  const senderTable = Buffer.alloc(listed.size * SENDER_ENTRY);
  [...listed].sort(([a], [b]) => a - b).forEach(([ia, seq], i) => {
    senderTable.writeUInt16BE(ia, i * SENDER_ENTRY);
    senderTable.writeUIntBE(Number(seq), i * SENDER_ENTRY + 2, 6);
  });
  return { groupKeys: groupKeyTable, goFlags, senders: senderTable };
}
