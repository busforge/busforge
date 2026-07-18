import type { Recipe } from "../recipe.ts";

// ABB US/U 4.2 universal interface (MV-0701, System 7 memory-mapped). The from-factory full
// download for this device family was implemented and hardware byte-verified on 2026-07-18; this
// recipe re-proves it after any code change. Refs are pinned verbatim from GET .../config and
// GET /api/catalog/products (2026-07-18 bench session).
export const abbUsu42: Recipe = {
  id: "abb-usu-4.2",
  device: {
    appRef: "M-0002_H-2.20.2F.2F.20GHQ.20631.200070-1_HP-A001-13-63C2",
    productRef: "M-0002_H-2.20.2F.2F.20GHQ.20631.200070-1_P-GH.20Q631.200070.20R0111",
    ia: "1.1.201",
    mask: "MV-0701",
  },
  provision: "skip-if-present", // the bench device keeps 1.1.201 between runs; unattended
  commission: "download",       // memory-mapped System 7 supports the full download
  configure: [
    { set: { paramRefId: "M-0002_A-A001-13-63C2_P-9_R-9", value: "104" } },   // channel A function: control an LED (output)
    { link: { comObjRefId: "M-0002_A-A001-13-63C2_O-1_R-95", ga: "1/1/1" } }, // "Ausgang A" -> 1/1/1
  ],
  verify: {
    // L1 is the byte-match proof: the device's read-back group tables must carry 1/1/1.
    readback: { expectGas: ["1/1/1"] },
    // L2: "Ausgang A" is a WRITE-ONLY output, so the only bus check available without the bench
    // camera (L3) is driving it — the device now filters 1/1/1 in its address table. A behavioural
    // assertion (the LED actually lights) needs L3. This drive still exercises the witness path.
    bus: [{ groupWrite: { ga: "1/1/1", value: "01" } }],
  },
  // Send-delay: a numeric parameter whose change does not restructure the com-object table, so the
  // surgical param flash accepts it. 2 → 5 → 2, each proven by the device's own read-back — this is
  // what proves the memory-mapped System 7 PARAM flash path (not just the full download) on hardware.
  mutation: { paramRefId: "M-0002_A-A001-13-63C2_P-3_R-3", value: "5" },
};
