import { test, expect, describe } from "bun:test";
import type { GaComObj } from "../api.ts";
import { flagsKnown, linkedObjects, objectSearch } from "./linkedObjects.ts";

const noFlags = { read: false, write: false, comm: true, transmit: false, update: false, readOnInit: false };
const obj = (deviceId: string, ia: string, comObjNumber: number, flags: Partial<GaComObj["flags"]> = {}): GaComObj => ({
  deviceId, deviceName: deviceId, ia, comObjRefId: `O-${comObjNumber}_R-1`, comObjName: `obj ${comObjNumber}`, functionText: "", comObjNumber, flags: { ...noFlags, ...flags },
});

// The objects one com-object shares an address with, as the device page's link view lists them.
describe("the objects linked to a com-object on one group address", () => {
  const self = { deviceId: "a", comObjNumber: 3 };

  test("leaves out the object itself and keeps the device's other objects, marked as such", () => {
    const own = obj("a", "1.1.1", 3, { transmit: true });
    const status = obj("a", "1.1.1", 4, { write: true });
    const rows = linkedObjects({ senders: [own], receivers: [status] }, self);
    expect(rows.map((r) => [r.deviceId, r.comObjNumber, r.sameDevice])).toEqual([["a", 4, true]]);
  });

  test("lists an object that is both sender and receiver once, with both directions", () => {
    const both = obj("b", "1.1.2", 7, { transmit: true, write: true });
    const rows = linkedObjects({ senders: [both], receivers: [both] }, self);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId: "b", comObjNumber: 7, sends: true, receives: true, sameDevice: false });
  });

  test("an object listed as receiver without the write flag neither sends nor receives, and stays listed", () => {
    const responder = obj("c", "1.1.3", 2, { read: true });
    const rows = linkedObjects({ senders: [], receivers: [responder] }, self);
    expect(rows).toEqual([expect.objectContaining({ comObjNumber: 2, sends: false, receives: false })]);
  });

  test("orders by individual address, numerically, then by object number", () => {
    const rows = linkedObjects({
      senders: [obj("d", "1.1.10", 1, { transmit: true })],
      receivers: [obj("e", "1.1.9", 5, { write: true }), obj("e", "1.1.9", 2, { write: true }), obj("f", "1.0.20", 1, { write: true })],
    }, self);
    expect(rows.map((r) => `${r.ia}/${r.comObjNumber}`)).toEqual(["1.0.20/1", "1.1.9/2", "1.1.9/5", "1.1.10/1"]);
  });

  test("keeps the marks the device view gives an object (hidden, flags refused)", () => {
    const hidden: GaComObj = { ...obj("g", "1.1.4", 9, { write: true }), hidden: true, flagsRefused: "COM_OBJECT_FLAGS_UNPLACEABLE" };
    expect(linkedObjects({ senders: [], receivers: [hidden] }, self)[0]).toMatchObject({ hidden: true, flagsRefused: "COM_OBJECT_FLAGS_UNPLACEABLE" });
  });

  test("a hidden ref of the same device and number is another object, listed apart from a visible one", () => {
    const hiddenSelf: GaComObj = { ...obj("a", "1.1.1", 3, { write: true }), comObjRefId: "O-3_R-2", hidden: true };
    const other = obj("b", "1.1.2", 3, { write: true });
    const otherHidden: GaComObj = { ...other, comObjRefId: "O-3_R-2", hidden: true };
    const rows = linkedObjects({ senders: [], receivers: [obj("a", "1.1.1", 3, { write: true }), hiddenSelf, other, otherHidden] }, self);
    expect(rows.map((r) => [r.deviceId, r.comObjRefId, !!r.hidden])).toEqual([["a", "O-3_R-2", true], ["b", "O-3_R-1", false], ["b", "O-3_R-2", true]]);
  });

  test("an address no other object uses gives an empty list", () => {
    expect(linkedObjects({ senders: [obj("a", "1.1.1", 3, { transmit: true })], receivers: [] }, self)).toEqual([]);
  });
});

describe("a linked object's row", () => {
  test("leads to the object's row, unless its configuration hides it", () => {
    expect(objectSearch({ comObjNumber: 5 })).toEqual({ co: 5 });
    expect(objectSearch({ comObjNumber: 5, hidden: true })).toEqual({});
  });
  test("shows flags only where they are the device's", () => {
    expect(flagsKnown({})).toBe(true);
    expect(flagsKnown({ flagsRefused: "COM_OBJECT_FLAGS_UNPLACEABLE" })).toBe(false);
    expect(flagsKnown({ hidden: true })).toBe(false);
  });
});
