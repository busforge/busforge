import type { Recipe } from "../recipe.ts";

// OpenKNX RaumController (AB-SmartHouse Präsenz-Multisensor "AB-PRE", MV-07B0, System B, one
// RelativeSegment, LSM 4). This is the from-factory full download that was taken end-to-end through
// the production endpoints on 2026-07-17 (assign-ia by prog-mode → full download over the busforge
// bridge → device up 1.2.32 Configured and answering on the bus). The recipe re-proves that whole
// path after any code change. It matters more than a manufacturer device: OpenKNX is not a KNX
// Association member and cannot ship a signed .knxprod, so an ETS-free commission is the product's
// whole reason to exist. Refs pinned verbatim from GET .../config and GET /api/catalog/products
// (2026-07-19 bench DB). Background and every trap behind it: docs/openknx.md.
export const openknxRaumController: Recipe = {
  id: "openknx-raumcontroller",
  device: {
    appRef: "M-00FA_H-0xA012-1_HP-A012-55-0000",
    productRef: "M-00FA_H-0xA012-1_P-OpenKnxRaumController",
    ia: "1.2.32",
    mask: "MV-07B0",
  },
  // From virgin: the erased device sits on 15.15.255 and is addressed in programming mode, so the
  // operator presses its button when P3 asks. (assign-ia rides A_IndividualAddress_Write, which hits
  // whichever device is in programming mode; only one may be, hence the P3 single-device gate.)
  provision: "require-prog-mode",
  // MV-07B0 System B does the full download: application id + parameter image + com-object table +
  // the two group tables, all verified against the device. The application code (LSM5) is never
  // downloaded and does not need to be (OpenKNX firmware is flashed over USB as a .uf2).
  commission: "download",
  // A non-virgin OpenKNX device carries poisoned `flash openknx` module state that its closing
  // A_Restart's configured boot would restore, deadlocking the loop until the ~8.3 s watchdog loops
  // and the firmware auto-erases the KNX region back to factory (docs/openknx.md, "the death loop").
  // A power cycle does NOT clear it; only the console erase does. So every run of this recipe starts
  // from a genuinely clean module region, which is why the closing restart comes up cleanly.
  precondition:
    "Bench console (USB serial to the device): run `erase knx` then `erase openknx`, power-cycle the " +
    "device so it boots Unconfigured (15.15.255) with an empty module region, then put ONLY this " +
    "device into programming mode (press its button) when P3 asks for it.",
  configure: [
    // Presence channel PM 1 = Aktiv. This is the one non-default parameter the proven bench config
    // carried; enabling it reveals the presence switch object O-133 below.
    { set: { paramRefId: "M-00FA_A-A012-55-0000_UP-3001008_R-300100801", value: "1" } },
    // "In Betrieb" heartbeat (DPST-1-2, read+transmit) → 5/2/1. Cyclic, and readable, so L2 can
    // prove the device is not merely programmed but running its own application.
    { link: { comObjRefId: "M-00FA_A-A012-55-0000_O-1_R-100000101", ga: "5/2/1" } },
    // "PM 1: Schalten 1", the presence switch output (DPST-1-1, read+transmit) → 3/3/1.
    { link: { comObjRefId: "M-00FA_A-A012-55-0000_O-133_R-300101301", ga: "3/3/1" } },
  ],
  verify: {
    // L1: both GAs must appear in the device's read-back group tables (the byte-match proof).
    readback: { expectGas: ["5/2/1", "3/3/1"] },
    // L2: the real functional proof recorded on 2026-07-17. The heartbeat answers a GroupValueRead
    // with 1 (In Betrieb) on a device that booted its application; the presence switch answers too
    // (its value tracks whether a target is present, so it is not pinned; a response is the proof).
    bus: [
      { groupRead: { ga: "5/2/1", expectValue: "01" } },
      { groupRead: { ga: "3/3/1" } },
    ],
  },
  // No P7 mutate+revert on purpose. The full download above exercises the complete write path every
  // run. A surgical parameter flash is NOT hardware-proven on OpenKNX, and re-flashing a device that
  // is already running configured is exactly the open death-loop risk in docs/openknx.md ("What is
  // NOT done" / the poisoned-restore boot). Claiming that path here would be pretending, and driving
  // it could brick the device mid-run. It stays out until it is proven on the bench in its own right.
};
