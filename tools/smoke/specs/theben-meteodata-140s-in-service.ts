import type { DeviceSpec } from "../spec.ts";

// The Theben Meteodata 140 S (MV-0701, System 7 memory-mapped load state, dynamic tables) as a unit
// in service: the run takes its configuration by read-back and writes one parameter flash, one GA
// flash and one structural flash, each reverted (inservice.ts); a full download of the configuration
// found only with --full-download. Refs pinned verbatim as the device configuration of this
// application lists them, taken offline from its catalogue; the run refuses a ref the unit's configuration does not
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
    // The structural step shows threshold channel C14, whose parameters the unit holds at the segment's
    // <Data> while it is off; ETS writes the values its project holds for them (tools/etsdiff.test.ts),
    // which only the installation's project file carries.
    hiddenValuesFromProject: true,
    fingerprint: [
      { name: "application id", object: 3, pid: 13, expect: "0048140c14" },
      { name: "firmware revision", object: 0, pid: 9, expect: "06" },
    ],
    // Two channel functions without a memory location that the unit runs off their defaults (its ETS
    // project's values), which no read-back sees; they change which parameter bytes are active, so the
    // read-back's image check, which must find nothing to write, shows them.
    assumeParams: [
      { name: "channel function (P-7060)", paramRefId: "M-0048_A-140C-14-EB70_P-7060_R-7060", value: "3" },
      { name: "channel function (P-7152)", paramRefId: "M-0048_A-140C-14-EB70_P-7152_R-7152", value: "4" },
    ],
    // "Temperature calibration in 0.1°C stages": an offset of the measured temperature in the
    // parameter image that shows or hides nothing and leaves the com-object table alone. While it is
    // set the measured temperature reads 0.1 K higher, which may send it or cross a channel's
    // temperature threshold. The run reads the unit's value and refuses if it already holds this one.
    param: { paramRefId: "M-0048_A-140C-14-EB70_P-2234_R-2234", value: "1" },
    // "C1 Brightness threshold" (read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-0048_A-140C-14-EB70_O-23_R-229" },
    // "Activate threshold channel C14", off to on: shows the channel's parameters and objects 84 and 86,
    // which take the structural flash; the objects stay unlinked (no group address). ETS's partial
    // downloads of this change and its revert are captured (tools/etsdiff.test.ts): the change writes the
    // switch, the channel's parameters as the project holds them (its texts included) and the entries
    // of objects 84 and 86 in the com-object table; the revert sets them back, the channel's parameters
    // to the segment's <Data>.
    structural: { paramRefId: "M-0048_A-140C-14-EB70_P-6571_R-6571", value: "1" },
    fullDownload: true,
    // Its wind and rain alarms drive the installation's awnings, and it sends none while it restarts.
    weatherGuard: true,
  },
  configure: [],
  behaviours: [
    // With its read flag set the unit answers a GroupValueRead with the threshold it holds, which
    // the run does not set.
    { kind: "output", label: "C1 Brightness threshold answers on the test link", comObjRefId: "M-0048_A-140C-14-EB70_O-23_R-229" },
  ],
  unsafe: [],
};
