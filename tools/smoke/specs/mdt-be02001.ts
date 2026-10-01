import type { DeviceSpec } from "../spec.ts";

// MDT BE-02001.02 Universal Interface 2-fold (M-0083, app 00B6, MV-0705, System 7 property-mapped).
// A MODULE device: its com-object table is materialized from module instances, and full download for
// this mask (authoring L3 into the <ComObjectTable CodeSegment>) is the capability MV-0705 unlocked
// (docs/commissioning.md). This spec drives it through the SMOKE framework, including the
// full download over the UI (FlashDialog's full-download action). Refs pinned verbatim from GET .../config and GET /api/catalog/products.
//
// Both channels of this device are CONTACT INPUTS, not outputs/relays — there is nothing for an input
// to drive, so the bus behaviour proven is `output`: the input's "Zustand senden" object carries the
// read flag, so a GroupValueRead is answered by the device itself (the same functional proof the
// MV-0705 certification used: 1.1.56 answered a read on a flashed link).
export const mdtBe02001: DeviceSpec = {
  id: "mdt-be02001",
  device: {
    appRef: "M-0083_H-182-0_HP-00B6-32-9642",
    productRef: "M-0083_H-182-0_P-BE.2D02001.2E02",
    ia: "1.1.56",
    mask: "MV-0705",
  },
  provision: "skip-if-present", // the bench MDT keeps 1.1.56 between runs
  // Baseline: Input A = "Zustand senden" (its default function 5), which exposes the readable object
  // #0 the behaviour binds to. Setting the default explicitly is a no-op on a fresh place but pins the
  // linkable state against a default change.
  configure: [
    { set: { paramRefId: "M-0083_A-00B6-32-9642_MD-2_M-2_MI-1_P-24_R-2", value: "5" } },
  ],
  behaviours: [
    // Link Input A's "Zustand senden" object to a random GA, flash it (surgical GA flash), then
    // GroupValueRead the GA and require the DEVICE to answer — the object carries the read flag, so the
    // device responds with its own contact state. No expectValue: the bench contact state is physical
    // and unknown, so any GroupValueResponse proves the link is functional (a byte-matched read-back
    // could not). The object number is resolved live; the ref distinguishes Input A (M-2) from B (M-3).
    {
      kind: "output", label: "input A answers a read",
      comObjRefId: "M-0083_A-00B6-32-9642_MD-2_M-2_MI-1_O-3-0_R-11",
    },
  ],
  // Input B's function drives its module-instance com-objects. Changing it from the canonical 5
  // ("Zustand senden", one object #6) to 7 ("kurz/lang", ADDS object #8) rewrites the com-object table:
  // the structuralFlash driver writes it and its revert as structural flashes, the change ETS's partial
  // download of 2026-10-01 made. Deliberately on Input B, NOT Input A: it must not disturb object #0 the
  // behaviour binds to.
  structuralTrigger: { paramRefId: "M-0083_A-00B6-32-9642_MD-2_M-3_MI-1_P-24_R-2", value: "7" },
  // The seeded sweep draws from the safe scalar/enum params (device timings, debounce, logic, input B
  // sub-params). Excluded because they rewrite the object graph the behaviour and trigger depend on:
  // the two per-input FUNCTION selectors (Input A + Input B, both refs end _P-24_R-2), and the separate
  // top-level combined selector «Funktion Eingang A / B» (_P-5_R-8, which zeroes all objects). Suffix
  // match is exact — _P-24_R-2 does not catch the safe _P-24_R-4, nor _P-5_R-8 the safe _P-4_R-2.
  fuzz: { gaRange: { main: 1, mid: 3, subStart: 1 }, excludeParams: ["_P-24_R-2", "_P-5_R-8"], paramSweepRounds: 3 },
};
