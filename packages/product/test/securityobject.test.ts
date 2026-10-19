import { test, expect, describe } from "bun:test";
import { buildSecurityObject, reachableGroupKeys, GO_SECURED, type OtherDevice } from "../src/securityobject.ts";

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
  const JUNG = 0x1204, TUNNEL = 0x1202;
  const none = { byGa: new Map<number, number[]>(), ownIa: JUNG, otherDevices: new Map<number, OtherDevice[]>() };

  test("the ETS reference: one tunnel assigned to the secured address, one entry, address then a zero sequence", () => {
    const t = buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), { ...none, byGa: new Map([[1, [TUNNEL]]]) });
    expect(t.senders.toString("hex")).toBe("1202" + "000000000000");
  });

  test("the senders of every secured address the device uses, once each, ascending, never itself", () => {
    const byGa = new Map([[1, [0x1205, TUNNEL]], [5, [TUNNEL, JUNG]], [7, [0x1101]]]);
    const t = buildSecurityObject([{ comObjNum: 1, gaRaws: [1] }, { comObjNum: 2, gaRaws: [5] }, { comObjNum: 3, gaRaws: [7] }], 3, new Map([[1, K1], [5, K5]]), { ...none, byGa });
    // 7 is plain: its sender is not listed. JUNG is the device itself.
    expect(t.senders.toString("hex")).toBe("1202000000000000" + "1205000000000000");
  });

  test("no senders is an empty table, as ETS loads it for a device alone on its secured address", () => {
    const t = buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), none);
    expect(t.senders).toHaveLength(0);
    expect(buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]])).senders).toHaveLength(0);
  });

  // ETS 6.4.1 (capture, decrypted): the Jung 400021SE (object 253 transmits on the secured address)
  // and the GVS AMMA (object 3 transmits on it, object 2 receives), both secured, a tunnel assigned as
  // a sender. Each device's PID 54 lists the tunnel with sequence 0 and the other device with its
  // SequenceNumber from the project. The individual addresses here are synthetic, in the capture's order.
  const GVS = 0x1203;
  test("the ETS reference: another secured device on the address is listed with its project sequence", () => {
    const byGa = new Map([[1, [TUNNEL]]]);
    const jung = buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), { byGa, ownIa: JUNG, otherDevices: new Map([[1, [{ ia: GVS, transmits: true, sequence: 0x0ab9aen }]]]) });
    expect(jung.senders.toString("hex")).toBe("1202" + "000000000000" + "1203" + "0000000ab9ae");
    const gvs = buildSecurityObject([{ comObjNum: 2, gaRaws: [1] }, { comObjNum: 3, gaRaws: [1] }], 3, new Map([[1, K1]]), { byGa, ownIa: GVS, otherDevices: new Map([[1, [{ ia: JUNG, transmits: true, sequence: 0x010bcdn }]]]) });
    expect(gvs.senders.toString("hex")).toBe("1202" + "000000000000" + "1204" + "000000010bcd");
  });

  test("another device that only receives on the address is not listed, as ETS does", () => {
    const gvs = buildSecurityObject([{ comObjNum: 2, gaRaws: [1] }, { comObjNum: 3, gaRaws: [1] }], 3, new Map([[1, K1]]), { byGa: new Map([[1, [TUNNEL]]]), ownIa: GVS, otherDevices: new Map([[1, [{ ia: JUNG, transmits: false, sequence: null }]]]) });
    expect(gvs.senders.toString("hex")).toBe("1202" + "000000000000");
  });

  test("another device that has no sequence, or cannot be classed, is refused: not shown", () => {
    const tbl = (o: OtherDevice) => () => buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), { ...none, otherDevices: new Map([[1, [o]]]) });
    expect(tbl({ ia: GVS, transmits: false, sequence: 5n, unclear: "its linked object #3 transmits, but this is not its sending address" })).toThrow(/not its sending address/);
    expect(tbl({ ia: GVS, transmits: false, sequence: 5n, unclear: "its linked object #4 answers reads there" })).toThrow(/answers reads/);
    // A device that transmits there is listed whatever else its links leave unclear.
    expect(buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), { ...none, otherDevices: new Map([[1, [{ ia: GVS, transmits: true, sequence: 5n, unclear: "its linked object #4 answers reads there" }]]]) }).senders.toString("hex")).toBe("1203000000000005");
    expect(tbl({ ia: GVS, transmits: true, sequence: null })).toThrow(/another device/);
    expect(tbl({ ia: GVS, transmits: true, sequence: 5n, unresolved: "its linked object #3 is hidden by its parameters" })).toThrow(/hidden/);
    expect(tbl({ ia: GVS, transmits: true, sequence: 2n ** 48n })).toThrow(/48 bits/);
    expect(tbl({ ia: JUNG, transmits: true, sequence: 5n })).toThrow(/own individual address/);
    expect(() => buildSecurityObject([{ comObjNum: 253, gaRaws: [1] }], 1327, new Map([[1, K1]]), { ...none, otherDevices: new Map([[1, [{ ia: GVS, transmits: true, sequence: 1n }, { ia: GVS, transmits: true, sequence: 2n }]]]) })).toThrow(/same individual address/);
    // A plain address shared with another device is none of the table's business.
    expect(() => buildSecurityObject([{ comObjNum: 2, gaRaws: [7] }], 3, new Map([[1, K1]]), { ...none, otherDevices: new Map([[7, [{ ia: GVS, transmits: false, sequence: null }]]]) })).not.toThrow();
  });
});

describe("the group key entries a device's key table holds for its addresses", () => {
  test("trailing entries for indices beyond the address table refer to nothing and are left out", () => {
    const entry = (i: number, b: number) => Buffer.concat([Buffer.from([0, i]), Buffer.alloc(16, b)]);
    const table = Buffer.concat([entry(1, 0xaa), entry(2, 0xbb)]);
    expect(reachableGroupKeys(table, 1).equals(entry(1, 0xaa))).toBe(true);
    expect(reachableGroupKeys(table, 2).equals(table)).toBe(true);
    expect(reachableGroupKeys(Buffer.alloc(0), 3).length).toBe(0);
    // One before a reachable entry is not what a load leaves: it stays, so it shows as a difference.
    const odd = Buffer.concat([entry(1, 0xaa), entry(5, 0xcc), entry(3, 0xdd)]);
    expect(reachableGroupKeys(odd, 3).equals(odd)).toBe(true);
  });
});

