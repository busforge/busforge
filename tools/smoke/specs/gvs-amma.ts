import type { DeviceSpec } from "../spec.ts";

// GVS AMMA 4-fold multifunction actuator (M-0085, MV-07B0, System B). A switch actuator with a
// READABLE status object, so it is the spec that proves the device functionally ACTS: write the
// switch, read the status back (an inputToOutput behaviour), not merely that the bytes landed.
// Hardware-proven 2026-07-14/17; refs pinned verbatim from GET .../config and GET /api/catalog/products.
export const gvsAmma: DeviceSpec = {
  id: "gvs-amma",
  device: {
    appRef: "M-0085_H-AM22AA-16_HP-0072-30-69AA",
    productRef: "M-0085_H-AM22AA-16_P-AMMA.2D04.2F06.2ES",
    ia: "1.1.203",
    mask: "MV-07B0",
  },
  provision: "skip-if-present", // the bench AMMA keeps 1.1.203 between runs
  // Baseline: Output 1&2 function = Switch, and enable Output 1. This reveals the switch + status
  // com-objects the behaviour binds to; the behaviour then links them to random GAs and flashes.
  configure: [
    { set: { paramRefId: "M-0085_A-0072-30-69AA_P-20_R-20", value: "1" } },
    { set: { paramRefId: "M-0085_A-0072-30-69AA_UP-142_R-142", value: "1" } },
  ],
  behaviours: [
    // Drive the "Switch" input off→on→off and require "Switch status" to TRACK each transition — the
    // real functional proof (the status object carries the read flag, so the device answers it
    // itself). The transitions matter: a stuck-on relay would fail the off steps, so a match on one
    // value cannot pass by luck.
    {
      kind: "inputToOutput", label: "switch drives status",
      inObjRefId: "M-0085_A-0072-30-69AA_O-2_R-3", outObjRefId: "M-0085_A-0072-30-69AA_O-3_R-4",
      steps: [{ write: "00", expect: "00" }, { write: "01", expect: "01" }, { write: "00", expect: "00" }],
    },
  ],
  // Toggling "enable Output 1" off removes that channel's com-objects, which rewrites the com-object
  // table — the change the UI full-download (FlashDialog needs-download) needs to be reachable on this
  // kept-addressed device. The runner sets it, runs the UI download, then restores it.
  uiFullDownloadTrigger: { paramRefId: "M-0085_A-0072-30-69AA_UP-142_R-142", value: "0" },
  // The seeded param sweep draws from the safe parameters; the two structural enables above are
  // excluded so the sweep does not tear down the behaviour's object graph mid-run.
  fuzz: { gaRange: { main: 1, mid: 2, subStart: 1 }, excludeParams: ["_P-20_R-20", "_UP-142_R-142"], paramSweepRounds: 3 },
};
