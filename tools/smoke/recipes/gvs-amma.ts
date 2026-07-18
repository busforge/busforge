import type { Recipe } from "../recipe.ts";

// GVS AMMA 4-fold multifunction actuator (M-0085, MV-07B0, System B). Complements the ABB US/U:
// a different memory model (relative, System B) AND — because a switch actuator has a READABLE
// status object — the first recipe whose L2 proves the device functionally ACTS (write the switch,
// read the status back), not merely that the bytes landed. Hardware-proven 2026-07-14/17; refs from
// the bench sessions. Output 1 is configured as a switch and its switch + status objects linked.
export const gvsAmma: Recipe = {
  id: "gvs-amma",
  device: {
    appRef: "M-0085_H-AM22AA-16_HP-0072-30-69AA",
    productRef: "M-0085_H-AM22AA-16_P-AMMA.2D04.2F06.2ES",
    ia: "1.1.203",
    mask: "MV-07B0",
  },
  provision: "skip-if-present", // the bench AMMA keeps 1.1.203 between runs
  commission: "download",       // System B supports the full download
  configure: [
    { set: { paramRefId: "M-0085_A-0072-30-69AA_P-20_R-20", value: "1" } },   // Output 1&2 function: Switch
    { set: { paramRefId: "M-0085_A-0072-30-69AA_UP-142_R-142", value: "1" } }, // enable Output 1 (reveals its com-objects)
    { link: { comObjRefId: "M-0085_A-0072-30-69AA_O-2_R-3", ga: "1/2/1" } },  // "Switch" (write) -> 1/2/1
    { link: { comObjRefId: "M-0085_A-0072-30-69AA_O-3_R-4", ga: "1/2/2" } },  // "Switch status" (read/transmit) -> 1/2/2
  ],
  verify: {
    readback: { expectGas: ["1/2/1", "1/2/2"] },
    // The real functional proof: drive the switch and read the status the actuator reports back.
    // The status object carries the read flag, so a GroupValueRead is answered by the device itself.
    bus: [
      { groupWrite: { ga: "1/2/1", value: "01" }, readBack: { ga: "1/2/2", expectValue: "01" } },
      { groupWrite: { ga: "1/2/1", value: "00" }, readBack: { ga: "1/2/2", expectValue: "00" } },
    ],
  },
  // A send-delay parameter: changing it does not restructure the com-object table, so the surgical
  // flash accepts it. 5 → 10 → 5, each proven by the flash's own read-back.
  mutation: { paramRefId: "M-0085_A-0072-30-69AA_P-3_R-3", value: "10" },
};
