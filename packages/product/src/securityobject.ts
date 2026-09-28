import { GROUP_KEY_ENTRY, type SecurityObjectTables } from "@busforge/knx";
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
export function buildSecurityObject(links: ComObjectLink[], comObjCount: number, groupKeys: ReadonlyMap<number, Buffer>): SecurityObjectTables {
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
  return { groupKeys: groupKeyTable, goFlags };
}
