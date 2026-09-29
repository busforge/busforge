import { test, expect, describe } from "bun:test";
import { buildSecurityObject, GO_SECURED } from "../src/securityobject.ts";

const K1 = Buffer.alloc(16, 0x11), K5 = Buffer.alloc(16, 0x55);

describe("the security object a device's links imply", () => {
  test("the Jung reference: one secured address on object 253 of 1327", () => {
    const t = buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }, { comObjNum: 10, gaRaws: [7] }], 1327, new Map([[1, K1]]));
    expect(t.groupKeys.toString("hex")).toBe("0001" + K1.toString("hex"));
    expect(t.goFlags).toHaveLength(1327);
    expect([...t.goFlags.entries()].filter(([, v]) => v !== 0)).toEqual([[252, GO_SECURED]]);
  });

  test("each key is filed under its address's position in the address table, not the address itself", () => {
    // The device looks a key up by address-table index (thelsing/knx SecurityInterfaceObject::groupKey).
    // Addresses 1, 5 and 7 sit at positions 1, 2 and 3 of the sorted table; 7 is plain.
    const keys = new Map([[5, K5], [1, K1], [9, Buffer.alloc(16, 0x99)]]);
    const t = buildSecurityObject([{ comObjNum: 2, gaRaws: [5] }, { comObjNum: 3, gaRaws: [1, 5] }, { comObjNum: 4, gaRaws: [7] }], 4, keys);
    expect(t.groupKeys.toString("hex")).toBe("0001" + K1.toString("hex") + "0002" + K5.toString("hex"));
    expect([...t.goFlags]).toEqual([0, GO_SECURED, GO_SECURED, 0]);
  });

  test("keys only for secured addresses the device uses, once each", () => {
    const keys = new Map([[5, K5], [1, K1], [9, Buffer.alloc(16, 0x99)]]);
    const t = buildSecurityObject([{ comObjNum: 2, gaRaws: [5] }, { comObjNum: 3, gaRaws: [1, 5] }], 4, keys);
    expect(t.groupKeys.toString("hex")).toBe("0001" + K1.toString("hex") + "0002" + K5.toString("hex"));
    expect([...t.goFlags]).toEqual([0, GO_SECURED, GO_SECURED, 0]);
  });

  test("a device with no secured link still gets its flags written, all plain", () => {
    const t = buildSecurityObject([{ comObjNum: 1, gaRaws: [7] }], 3, new Map([[1, K1]]));
    expect(t.groupKeys).toHaveLength(0);
    expect([...t.goFlags]).toEqual([0, 0, 0]);
  });

  test("an object on both a secured and a plain address is refused, not given one flag", () => {
    expect(() => buildSecurityObject([{ comObjNum: 1, gaRaws: [1, 7] }], 2, new Map([[1, K1]]))).toThrow(/both secured and plain/);
  });

  test("a key of the wrong length and an object outside the table are refused", () => {
    expect(() => buildSecurityObject([{ comObjNum: 1, gaRaws: [1] }], 2, new Map([[1, Buffer.alloc(15)]]))).toThrow(/not 16/);
    expect(() => buildSecurityObject([{ comObjNum: 3, gaRaws: [1] }], 2, new Map([[1, K1]]))).toThrow(/outside/);
  });
});

describe("the security individual address table (PID 54) a device's links imply", () => {
  const JUNG = 0x11cc, TUNNEL = 0x1164;
  const none = { byGa: new Map<number, number[]>(), ownIa: JUNG, linkedElsewhere: new Set<number>() };

  test("the ETS reference: 1.1.100 assigned to 0/0/1, one entry, address then a zero sequence", () => {
    const t = buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), { ...none, byGa: new Map([[1, [TUNNEL]]]) });
    expect(t.senders.toString("hex")).toBe("1164" + "000000000000");
  });

  test("the senders of every secured address the device uses, once each, ascending, never itself", () => {
    const byGa = new Map([[1, [0x1205, TUNNEL]], [5, [TUNNEL, JUNG]], [7, [0x1101]]]);
    const t = buildSecurityObject([{ comObjNum: 1, gaRaws: [1] }, { comObjNum: 2, gaRaws: [5] }, { comObjNum: 3, gaRaws: [7] }], 3, new Map([[1, K1], [5, K5]]), { ...none, byGa });
    // 7 is plain: its sender is not listed. JUNG is the device itself.
    expect(t.senders.toString("hex")).toBe("1164000000000000" + "1205000000000000");
  });

  test("no senders is an empty table, as ETS loads it for a device alone on its secured address", () => {
    const t = buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), none);
    expect(t.senders).toHaveLength(0);
    expect(buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]])).senders).toHaveLength(0);
  });

  test("a secured address another device is linked to is refused: which of them ETS lists is not known", () => {
    expect(() => buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), { ...none, linkedElsewhere: new Set([1]) }))
      .toThrow(/another device/);
    // A plain address shared with another device is none of the table's business.
    expect(() => buildSecurityObject([{ comObjNum: 2, gaRaws: [7] }], 3, new Map([[1, K1]]), { ...none, linkedElsewhere: new Set([7]) })).not.toThrow();
  });
});

