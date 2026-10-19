import type { DeviceSpec } from "../spec.ts";

// The MDT Universal Interface 6-fold BE-06001.02 (MV-0705, System 7 property-mapped, module device)
// as a unit in service: the run takes its configuration by read-back and writes one parameter flash,
// one GA flash and one structural flash, each reverted (inservice.ts); a full download of the
// configuration found only with --full-download. Refs pinned verbatim as the device configuration
// of this application lists them (module refs with their instance), taken offline from its
// catalogue and the unit's configuration; the run refuses a ref the unit's configuration does not
// list.
//
// Fingerprint: the application id, which this family reports on the application object (object 3,
// PID 13), and the firmware revision (object 0, PID 9). The unit does not report PID 25. The bench
// spec mdt-be02001 (BE-02001.02) targets the same individual address on its own bus; its application
// id differs (00b6 against 00b4 here), so a run through the wrong interface stops at the fingerprint.
//
// Each write ends with the device's restart (its configured start-up time, 2 s by default), during
// which its inputs and logic outputs report nothing. Restarts per channel: twice per step plus the
// persistence restart, one more with a full download.
export const mdtBe06001InService: DeviceSpec = {
  id: "mdt-be06001-in-service",
  device: {
    appRef: "M-0083_H-180-0_HP-00B4-32-3919",
    productRef: "M-0083_H-180-0_P-BE.2D06001.2E02",
    ia: "1.1.56",
    mask: "MV-0705",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 3, pid: 13, expect: "008300b432" },
      { name: "firmware revision", object: 0, pid: 9, expect: "00" },
    ],
    // Parameters without a memory location that the unit runs off their defaults (its ETS project's
    // values), which no read-back sees. Logic 3's setting shows the logic's output, which the unit
    // links; each changes which parameter bytes are active, so the read-back's image check, which must
    // find nothing to write, shows them.
    assumeParams: [
      { name: "Setting Logic, Logic 1", paramRefId: "M-0083_A-00B4-32-3919_MD-3_M-49_MI-1_P-1_R-3", value: "0" },
      { name: "Setting Logic, Logic 2", paramRefId: "M-0083_A-00B4-32-3919_MD-3_M-50_MI-1_P-1_R-3", value: "0" },
      { name: "Setting Logic, Logic 3", paramRefId: "M-0083_A-00B4-32-3919_MD-3_M-51_MI-1_P-1_R-3", value: "2" },
      { name: "Input A value for contact closed", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-2_MI-1_P-31_R-43", value: "1" },
      { name: "Input A value for contact opened", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-2_MI-1_P-32_R-50", value: "0" },
      { name: "Input B value for contact closed", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-3_MI-1_P-31_R-43", value: "1" },
      { name: "Input B value for contact opened", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-3_MI-1_P-32_R-50", value: "0" },
      { name: "Input C value for contact closed", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-5_MI-1_P-31_R-43", value: "1" },
      { name: "Input C value for contact opened", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-5_MI-1_P-32_R-50", value: "0" },
      { name: "Input D send delay", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-6_MI-1_P-19_R-57", value: "3" },
      { name: "Input E function", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-7_MI-1_P-24_R-2", value: "255" },
      { name: "Input F function", paramRefId: "M-0083_A-00B4-32-3919_MD-2_M-8_MI-1_P-24_R-2", value: "255" },
    ],
    // "Time for long keypress (Basic setting)": 0.5 s to 0.6 s, a value in the parameter image that
    // leaves the com-object table alone. The run reads the unit's value and refuses if it already
    // holds this one.
    param: { paramRefId: "M-0083_A-00B4-32-3919_P-8_R-7", value: "33368" },
    // "Operation" (DPST-1-11, read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-0083_A-00B4-32-3919_O-48_R-47" },
    // "Setting Logic" of Logic 4, from "not active" to AND: the logic's output object (47) enters the
    // com-object table.
    structural: { paramRefId: "M-0083_A-00B4-32-3919_MD-3_M-52_MI-1_P-1_R-3", value: "1" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // A device that runs its application answers a GroupValueRead of "Operation" with 1.
    { kind: "output", label: "Operation answers on the test link", comObjRefId: "M-0083_A-00B4-32-3919_O-48_R-47", expectValue: "01" },
  ],
  unsafe: [],
};
