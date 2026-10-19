import type { DeviceSpec } from "../spec.ts";

// Jung 400021SE Tasterschnittstelle 2fach Secure (M-0004_A-7072, MV-07B0, System B, Insta-OEM). The
// FIRST System B *module* device in the smoke framework, and the first commissioned via A_MemoryExtended
// (its parameter segment sits at 0x15000, past the 16-bit reach of the classic memory services). It is
// also the device that surfaced the config-view Merker-in-a-hidden-block bug (its two channels are
// materialized by module instances gated behind a hidden-block Merker, now rendered by buildDeviceConfig).
//
// Each channel is a binary CONTACT INPUT in its default "Schalten" function: it reads a physical contact
// and TRANSMITS the state on a readable "Ausgang" object (read flag set), and can receive on an "Eingang"
// object to drive a status LED. The behaviour proven is `output`: the device answers a GroupValueRead on
// the contact-state object with its current value (0 = contact open on the bench). Refs pinned verbatim
// from GET .../config and GET /api/catalog/products.
//
// On this device the System B GA flash must bracket the application object. A table-only GA flash leaves
// all three tables LOADED and byte-perfect here while the APPLICATION PROGRAM object drops to ERROR: the
// device keeps answering management (so everything verifies green) but runs no application, so the
// freshly linked object is functionally dead. The GA flash holds object 4 in its own load bracket across
// the table rewrite; the surgical GA flash below is the hardware proof that it works (and a guard
// refuses a GA flash that degrades the application, instead of reporting it verified).
export const jung400021se: DeviceSpec = {
  id: "jung-400021se",
  device: {
    appRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_HP-7072-21-99A7-O000A",
    productRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_P-400021SE",
    ia: "1.1.204",
    mask: "MV-07B0",
  },
  provision: "skip-if-present", // the bench Jung keeps its address between runs
  // Both channels at their default "Schalten" function (0), which exposes each channel's readable
  // "Ausgang" contact object (#253 for K1, #261 for K2) the behaviour binds to.
  configure: [
    { set: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-2_R-2", value: "0" } },
    { set: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-2_R-2", value: "0" } },
  ],
  behaviours: [
    // K1's "Ausgang" (contact state, read+transmit): the framework links it to a RANDOM group address,
    // commits that with the surgical GA flash, and requires the device to answer a GroupValueRead on it.
    // No expectValue — the bench contact is unwired, so its state is physical; a GroupValueResponse (0x00
    // here) is the functional proof a byte-matched read-back could never be. This is both the first
    // bus-behaviour proof on a System B module device AND the regression test for the application-bracket
    // fix: without it this object answers nothing (see the file header).
    { kind: "output", label: "K1 contact answers a read", comObjRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_O-2-0_R-1" },
  ],
  // Changing K2's function from "Schalten" (0) to "Dimmen und Farbtemperatur" (1) swaps K2's com-objects
  // (different numbers and sizes), which rewrites the com-object table: the structuralFlash driver writes
  // it and its revert as structural flashes. Deliberately on K2, NOT K1: it must not disturb K1's
  // "Ausgang" object the behaviour observes.
  structuralTrigger: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-2_R-2", value: "1" },
  // The seeded param sweep exercises the surgical param flash (which DOES write L4 and byte-verifies with
  // zero drift on this device). Excluded: the two per-channel FUNCTION selectors (they rewrite the object
  // graph the behaviour and trigger depend on). Suffix _P-2_R-2 matches both channel functions.
  fuzz: { gaRange: { main: 1, mid: 6, subStart: 2 }, excludeParams: ["_P-2_R-2"], paramSweepRounds: 3 },
};
