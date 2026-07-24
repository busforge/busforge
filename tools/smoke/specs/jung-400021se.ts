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
// IMPORTANT (hardware-diagnosed 2026-07-24): on this Insta family, a com-object's ACTIVATION is not
// carried by the L1/L2/L3 tables alone. A surgical GA flash writes the address/association tables and even
// sets the L3 Communication flag correctly (verified: obj253 L3 config 0xcb -> 0xcf), yet the freshly
// linked object stays functionally DEAD — it answers no GroupValueRead even after a restart. The SAME
// object linked by a full download (which also rewrites the parameter image, L4) answers 0x00. So link
// activation depends on L4 here, and a surgical GA flash (L1/L2/L3 only) is insufficient: it produces a
// byte-verified-but-dead link. `flashLinks` is therefore declared `unsafe` and reported as such (proven by
// nothing, never faked green), exactly like OpenKNX, and the behaviour observes a link committed by the
// full download instead of allocating one. Promoting GA flash to a full download for this family (or
// refusing it) is a follow-up (docs/next-steps.md).
export const jung400021se: DeviceSpec = {
  id: "jung-400021se",
  device: {
    appRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_HP-7072-21-99A7-O000A",
    productRef: "M-0004_H-4.20.2F.2F.20400021SE-0-O000A_P-400021SE",
    ia: "1.1.204",
    mask: "MV-07B0",
  },
  provision: "skip-if-present", // the bench Jung keeps 1.1.204 between runs
  // Both channels at their default "Schalten" function (0), which exposes each channel's readable
  // "Ausgang" contact object (#253 for K1, #261 for K2), and LINK K1's Ausgang to a fixed GA. On this
  // device the link is committed by the full download (a surgical GA flash leaves it dead, see above), so
  // the behaviour observes this fixed address.
  configure: [
    { set: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_P-2_R-2", value: "0" } },
    { set: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-2_R-2", value: "0" } },
    { link: { comObjRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_O-2-0_R-1", ga: "1/6/1" } },
  ],
  behaviours: [
    // K1's "Ausgang" (contact state, read+transmit), linked by the full download and observed at a fixed
    // GA: a GroupValueRead is answered by the device with the current contact state. No expectValue beyond
    // presence — the bench contact is unwired, so its state is physical; a GroupValueResponse (0x00 here)
    // is the functional proof (a byte-matched read-back could not be). This is the first bus-behaviour
    // proof on a System B module device.
    { kind: "output", label: "K1 contact answers a read", comObjRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-100_MI-1_O-2-0_R-1", ga: "1/6/1" },
  ],
  // Surgical GA flash produces a byte-verified but functionally-dead link on this Insta family (link
  // activation lives in the parameter image, L4, which a GA flash does not write; hardware-diagnosed, see
  // the file header). Declared unsafe and NOT exercised, rather than reported green off a byte match.
  unsafe: [
    { capability: "flashLinks", reason: "surgical GA flash writes L1/L2/L3 (and sets the L3 comm flag) but leaves the object functionally dead — link activation depends on the parameter image (L4) on this Insta family, so links are committed only by a full download; promoting/refusing is a follow-up" },
  ],
  // Changing K2's function from "Schalten" (0) to "Dimmen und Farbtemperatur" (1) swaps K2's com-objects
  // (different numbers and sizes), which rewrites the com-object table, so the surgical param flash is
  // refused stale and the UI FlashDialog offers the needs-download route (the automatable UI full-download
  // proof). Deliberately on K2, NOT K1: it must not disturb K1's "Ausgang" object the behaviour observes.
  // The runner sets it, runs the UI download, then restores 0.
  uiFullDownloadTrigger: { paramRefId: "M-0004_A-7072-21-99A7-O000A_MD-1_M-200_MI-1_P-2_R-2", value: "1" },
  // The seeded param sweep exercises the surgical param flash (which DOES write L4 and byte-verifies with
  // zero drift on this device). Excluded: the two per-channel FUNCTION selectors (they rewrite the object
  // graph the behaviour and trigger depend on). Suffix _P-2_R-2 matches both channel functions.
  fuzz: { gaRange: { main: 1, mid: 6, subStart: 2 }, excludeParams: ["_P-2_R-2"], paramSweepRounds: 3 },
};
