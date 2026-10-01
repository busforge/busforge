import { test, expect, describe } from "bun:test";
import { classifyOtherLink, type OtherDeviceModel } from "../src/deviceservice.ts";
import type { ComObjFlags, OtherDevice } from "@busforge/product";

// Whether another device linked to a secured address is one of its senders (docs/knx-secure.md,
// findings §22): only a visible object with the communication and transmit flags that has the address
// first (its sending address) makes it one; anything undecidable is refused, never left out.
const flags = (f: Partial<ComObjFlags>): ComObjFlags => ({ read: false, write: false, comm: true, transmit: false, update: false, readOnInit: false, ...f });
const GVS = 0x11cb;
const model = (over: Partial<OtherDeviceModel> = {}): OtherDeviceModel => ({
  ia: GVS, sequence: 0x0ab9aen,
  objs: new Map([
    ["O-2_R-2", { number: 2, flags: flags({ write: true }) }],             // Schalten: receives
    ["O-3_R-3", { number: 3, flags: flags({ read: true, transmit: true }) }], // Status: transmits
    ["O-9_R-9", { number: 9, flags: flags({ transmit: true }) }],            // hidden by parameters
    ["O-5_R-5", { number: 5, flags: flags({ transmit: true, comm: false }) }],
    ["O-4_R-4", { number: 4, flags: flags({ read: true }) }],                 // answers reads only
    ["O-6_R-6", { number: 6, flags: flags({ transmit: true }) }],            // another transmitter
  ]),
  active: new Set(["O-2_R-2", "O-3_R-3", "O-5_R-5", "O-4_R-4", "O-6_R-6"]),
  failure: null,
  ...over,
});
const start: OtherDevice = { ia: GVS, transmits: false, sequence: 0x0ab9aen, unresolved: null, unclear: null };
const fold = (d: OtherDeviceModel, links: { refId: string; slot: number }[]) => links.reduce((cur, l) => classifyOtherLink(cur, d, l), start);

describe("another device on a secured address", () => {
  test("the ETS reference: the GVS's receiving and its transmitting object make it a sender", () => {
    expect(fold(model(), [{ refId: "O-2_R-2", slot: 0 }, { refId: "O-3_R-3", slot: 0 }])).toEqual({ ...start, transmits: true });
  });

  test("an object that only receives does not make it one (ETS does not list it)", () => {
    expect(fold(model(), [{ refId: "O-2_R-2", slot: 0 }])).toEqual(start);
  });

  test("an object that answers reads, or transmits on a further address, is a case ETS was not seen to decide", () => {
    expect(fold(model(), [{ refId: "O-4_R-4", slot: 0 }])).toMatchObject({ transmits: false, unresolved: null, unclear: expect.stringMatching(/answers reads/) });
    expect(fold(model(), [{ refId: "O-3_R-3", slot: 1 }])).toMatchObject({ transmits: false, unresolved: null, unclear: expect.stringMatching(/not its sending address/) });
    // A transmitter on a further address with its communication flag off sends nothing there.
    expect(fold(model(), [{ refId: "O-5_R-5", slot: 1 }])).toEqual(start);
  });

  test("a device that transmits there anyway stays a sender whatever its other links are", () => {
    for (const links of [[{ refId: "O-6_R-6", slot: 1 }, { refId: "O-3_R-3", slot: 0 }], [{ refId: "O-3_R-3", slot: 0 }, { refId: "O-6_R-6", slot: 1 }]]) {
      expect(fold(model(), links)).toMatchObject({ transmits: true, unresolved: null });
    }
  });

  test("a hidden object, an unknown object, no application, a failed configuration or a switched-off communication flag leave it unresolved", () => {
    expect(fold(model(), [{ refId: "O-9_R-9", slot: 0 }]).unresolved).toMatch(/hidden/);
    expect(fold(model(), [{ refId: "O-7_R-7", slot: 0 }]).unresolved).toMatch(/not in its application program/);
    expect(fold(model({ objs: null }), [{ refId: "O-3_R-3", slot: 0 }]).unresolved).toMatch(/application program is not available/);
    expect(fold(model({ failure: "its configuration could not be built (boom)" }), [{ refId: "O-3_R-3", slot: 0 }]).unresolved).toMatch(/boom/);
    expect(fold(model(), [{ refId: "O-5_R-5", slot: 0 }]).unresolved).toMatch(/communication flag off/);
  });

  test("an unresolved link is not undone by a later transmitting one", () => {
    const r = fold(model(), [{ refId: "O-9_R-9", slot: 0 }, { refId: "O-3_R-3", slot: 0 }]);
    expect(r.unresolved).toMatch(/hidden/);
    expect(r.transmits).toBe(false);
  });
});
