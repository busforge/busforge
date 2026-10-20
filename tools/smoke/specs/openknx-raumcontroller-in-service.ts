import type { DeviceSpec } from "../spec.ts";

// The OpenKNX RaumController (AB-SmartHouse "AB-PRE", MV-07B0, System B, LSM 4) of
// openknx-raumcontroller.ts, but a unit in service: commissioned, configured and in use. The
// from-factory spec cannot run there (it erases the device and full-downloads it); this one takes
// the unit's configuration by read-back and writes one parameter flash and one GA flash, each
// reverted, and a full download of the configuration found only with --full-download
// (inservice.ts). Refs pinned verbatim from GET .../config of this application.
//
// Fingerprint: the application id (application object, PID 13) and the device object's PID 25,
// both as the unit reports them; a unit with another application or firmware stops the run before
// the first write. The unit does not report PID_FIRMWARE_REVISION (PID 9).
//
// Each write ends with the device's restart: the unit's sensors and outputs are briefly offline,
// four times per channel plus the persistence restart, one more with a full download. The full
// download here unloads the PEI program first (docs/load-procedures.md, R9): one that breaks off
// leaves the unit unloaded, recovered by another full download, or by its serial console where it no
// longer answers on its address.
export const openknxRaumControllerInService: DeviceSpec = {
  id: "openknx-raumcontroller-in-service",
  device: {
    appRef: "M-00FA_H-0xA012-1_HP-A012-55-0000",
    productRef: "M-00FA_H-0xA012-1_P-OpenKnxRaumController",
    ia: "1.1.32",
    mask: "MV-07B0",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "00faa01255" },
      { name: "version", object: 0, pid: 25, expect: "0945" },
    ],
    // "Startverzögerung für diesen Kanal" of PM 1: a number in the parameter image that leaves the
    // com-object table alone. The run reads the unit's value and refuses if it already holds this one.
    param: { paramRefId: "M-00FA_A-A012-55-0000_UP-3001019_R-300101901", value: "2" },
    // "In Betrieb" (DPST-1-2, read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-00FA_A-A012-55-0000_O-1_R-100000101" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // A device that booted its application answers a GroupValueRead of "In Betrieb" with 1. The
    // object sends on start, so the read after the GA flash's restart finds a value to answer with.
    { kind: "output", label: "In Betrieb answers on the test link", comObjRefId: "M-00FA_A-A012-55-0000_O-1_R-100000101", expectValue: "01" },
  ],
  unsafe: [],
};
