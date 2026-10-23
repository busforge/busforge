import type { DeviceSpec } from "../spec.ts";

// The Theben TheLuxa P300 (MV-0705, System 7 property-mapped, dynamic tables) as a unit in service:
// the run takes its configuration by read-back and writes one parameter flash, one GA flash and one
// structural flash, each reverted (inservice.ts); a full download of the configuration found only
// with --full-download. Refs pinned verbatim as the device configuration of this application lists
// them, taken offline from its catalogue; the run refuses a ref the unit's configuration does not
// list. The com-object ref is the one the configuration found activates: a unit whose configuration
// activates another ref of the same object stops before the first write.
//
// Fingerprint: the application id, which this family reports on the application object (object 3,
// PID 13), and the firmware revision (object 0, PID 9). The unit does not report PID 25.
//
// Each write ends with the device's restart, during which its channels are briefly offline: per
// channel twice per step plus the persistence restart, one more with a full download.
export const thebenTheluxaP300InService: DeviceSpec = {
  id: "theben-theluxa-p300-in-service",
  device: {
    appRef: "M-0048_H-1019610-1_HP-107E-12-5B58",
    productRef: "M-0048_H-1019610-1_P-1019610",
    ia: "1.1.10",
    mask: "MV-0705",
  },
  provision: "in-service",
  inService: {
    // The download marker P-2228 (docs/load-procedures.md R17): every parameter download writes AA, the unit
    // reads it back 00.
    runtimeMemory: [{ address: 0x4800, mask: 0xff, why: "download marker P-2228, written AA by each download and cleared by the unit" }],
    fingerprint: [
      { name: "application id", object: 3, pid: 13, expect: "0048107e12" },
      { name: "firmware revision", object: 0, pid: 9, expect: "01" },
    ],
    // "Temperature calibration in 0.1 °C": an offset in the parameter image that leaves the
    // com-object table alone. The run reads the unit's value and refuses if it already holds this one.
    param: { paramRefId: "M-0048_A-107E-12-5B58_P-2234_R-2234", value: "1" },
    // "C1 Block" (read + write), linked to the run's test address while the run observes it.
    link: { comObjRefId: "M-0048_A-107E-12-5B58_O-16_R-730" },
    // "Time delay adjustable via bus": on adds object 13 ("C1 Time delay") to the com-object table.
    structural: { paramRefId: "M-0048_A-107E-12-5B58_P-14636_R-14636", value: "1" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // A GroupValueRead of the block object only reads it; with its read flag set the unit answers
    // with the object's current value, which the run does not set.
    { kind: "output", label: "C1 Block answers on the test link", comObjRefId: "M-0048_A-107E-12-5B58_O-16_R-730" },
  ],
  unsafe: [],
};
