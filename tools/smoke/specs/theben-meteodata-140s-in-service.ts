import type { DeviceSpec } from "../spec.ts";

// The Theben Meteodata 140 S (MV-0701, System 7 memory-mapped load state, dynamic tables) as a unit
// in service: the run takes its configuration by read-back and writes one parameter flash and one GA
// flash, each reverted (inservice.ts); a full download of the configuration found only with
// --full-download. Refs pinned verbatim as the device configuration of this application lists
// them, taken offline from its catalogue; the run refuses a ref the unit's configuration does not
// list. The com-object ref is the one the configuration found activates: a unit whose
// configuration activates another ref of the same object stops before the first write.
//
// Fingerprint: the application id, which this family reports on the application object (object 3,
// PID 13), and the firmware revision (object 0, PID 9). The unit does not report PID 25; its
// properties answer although its load state is memory-mapped.
//
// The unit offers no PID_MAX_APDU_LENGTH (PID 56), so every memory read and write carries at most
// 12 bytes, and even a two-byte parameter flash, with its backup and verify reads, takes about a
// minute. While a write runs, and through the restart it ends with, the unit sends no measured
// values and no alarms; it sends them again within seconds of starting. Restarts per channel: twice
// per step plus the persistence restart, one more with a full download.
export const thebenMeteodata140sInService: DeviceSpec = {
  id: "theben-meteodata-140s-in-service",
  device: {
    appRef: "M-0048_H-1409208-1_HP-140C-14-EB70",
    productRef: "M-0048_H-1409208-1_P-1409201",
    ia: "1.1.24",
    mask: "MV-0701",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 3, pid: 13, expect: "0048140c14" },
      { name: "firmware revision", object: 0, pid: 9, expect: "06" },
    ],
    // "Temperature calibration in 0.1°C stages": an offset of the measured temperature in the
    // parameter image that shows or hides nothing and leaves the com-object table alone. While it is
    // set the measured temperature reads 0.1 K higher, which may send it or cross a channel's
    // temperature threshold. The run reads the unit's value and refuses if it already holds this one.
    param: { paramRefId: "M-0048_A-140C-14-EB70_P-2234_R-2234", value: "1" },
    // "C1 Brightness threshold" (read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-0048_A-140C-14-EB70_O-23_R-229" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // With its read flag set the unit answers a GroupValueRead with the threshold it holds, which
    // the run does not set.
    { kind: "output", label: "C1 Brightness threshold answers on the test link", comObjRefId: "M-0048_A-140C-14-EB70_O-23_R-229" },
  ],
  unsafe: [
    { capability: "structuralFlash", reason: "never written to this product on hardware: a product's first structural flash is not run on a unit in service" },
  ],
};
