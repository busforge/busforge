import type { DeviceSpec } from "../spec.ts";

// OpenKNX RaumController (AB-SmartHouse "AB-PRE", MV-07B0, System B, LSM 4). The from-factory full
// download taken end-to-end through the production endpoints on 2026-07-17. It matters more than a
// manufacturer device: OpenKNX cannot ship a signed .knxprod, so an ETS-free commission is the
// product's whole reason to exist. Refs pinned verbatim from GET .../config and GET /api/catalog/products.
// Background and every trap behind it: docs/commissioning.md.
export const openknxRaumController: DeviceSpec = {
  id: "openknx-raumcontroller",
  device: {
    appRef: "M-00FA_H-0xA012-1_HP-A012-55-0000",
    productRef: "M-00FA_H-0xA012-1_P-OpenKnxRaumController",
    ia: "1.1.32",
    mask: "MV-07B0",
  },
  // From virgin: the erased device sits on 15.15.255 and is addressed in programming mode, so the
  // operator presses its button (api channel: at provision; ui channel: when the CommissionDialog scans).
  provision: "require-prog-mode",
  precondition:
    "Bench console (USB serial to the device): run `erase knx` then `erase openknx`, power-cycle the " +
    "device so it boots Unconfigured (15.15.255) with an empty module region, then put ONLY this " +
    "device into programming mode (press its button) when the runner asks for it.",
  // Enable presence channel PM 1 (reveals the presence switch object O-133), and link the two
  // observed objects to FIXED GAs. On OpenKNX the links are committed by the full download, not a
  // surgical GA flash (see `unsafe`), so the behaviours below observe these fixed addresses.
  configure: [
    { set: { paramRefId: "M-00FA_A-A012-55-0000_UP-3001008_R-300100801", value: "1" } },
    { link: { comObjRefId: "M-00FA_A-A012-55-0000_O-1_R-100000101", ga: "7/7/1" } },
    { link: { comObjRefId: "M-00FA_A-A012-55-0000_O-133_R-300101301", ga: "3/3/1" } },
  ],
  behaviours: [
    // "In Betrieb" heartbeat (DPST-1-2, read+transmit): a GroupValueRead is answered with 1 by a
    // device that booted its application — proof it is not merely programmed but running.
    { kind: "output", label: "In Betrieb heartbeat", comObjRefId: "M-00FA_A-A012-55-0000_O-1_R-100000101", ga: "7/7/1", expectValue: "01" },
    // "PM 1: Schalten 1", the presence switch output (DPST-1-1, read+transmit). Its value tracks
    // presence so it is not pinned; a response is the proof.
    { kind: "output", label: "PM1 Schalten 1", comObjRefId: "M-00FA_A-A012-55-0000_O-133_R-300101301", ga: "3/3/1" },
  ],
  // System B claims flashParams/flashLinks and the endpoints perform them. They are kept out of
  // automated runs because a failed boot on this firmware ends in an auto-erase whose recovery needs
  // the device's serial console. The surgical parameter flash has since been proven by hand on the
  // house unit (docs/findings.md §16); both stay for the controlled comparison on docs/roadmap.md.
  unsafe: [
    { capability: "flashParams", reason: "proven by hand on the house unit (one byte, verified after the restart, docs/findings.md §16), not by this spec; a failed boot auto-erases the device and recovery needs its serial console, so it runs only in the controlled comparison (docs/roadmap.md)" },
    { capability: "flashLinks", reason: "never driven on OpenKNX; a failed boot auto-erases the device and recovery needs its serial console, so it runs only in the controlled comparison (docs/roadmap.md)" },
  ],
  // No fuzz: the seeded param sweep is the surgical path excluded above, so there is nothing to
  // draw from. The full download exercises the complete write path every run.
};
