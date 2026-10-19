import type { DeviceSpec } from "../spec.ts";

// The Auro KNX presence detector (application FE01, MV-0705, System 7 property-mapped, static tables)
// as a unit in service: the run takes its configuration by read-back and writes one parameter flash
// and one GA flash, each reverted (inservice.ts); a full download of the configuration found only
// with --full-download. Refs pinned verbatim as the device configuration of this application lists
// them, taken offline from its catalogue; the run refuses a ref the unit's configuration does not
// list. Every parameter that decides which objects this application shows has a memory location, so
// the read-back finds the objects the unit uses. A unit running the manufacturer's second application
// (FF31) stops at the fingerprint.
//
// Fingerprint: the application id, which this family reports on the application object (object 3,
// PID 13), and the firmware revision (object 0, PID 9). The unit does not report PID 25.
//
// Each write ends with the device's restart, during which it is briefly offline: per channel twice
// per step plus the persistence restart, one more with a full download.
export const auroM0081InService: DeviceSpec = {
  id: "auro-m0081-in-service",
  device: {
    appRef: "M-0081_H-GeneratedNumber.2D22017-0_HP-FE01-11-75D9",
    productRef: "M-0081_H-GeneratedNumber.2D22017-0_P-180.2D02",
    ia: "1.1.18",
    mask: "MV-0705",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 3, pid: 13, expect: "0081fe0111" },
      { name: "firmware revision", object: 0, pid: 9, expect: "06" },
    ],
    // "Led feedback": led feedback to no led feedback, a value in the parameter image. Between these
    // two values it shows and hides nothing, so the com-object table stays; value 2 ("led controlled
    // by group address") would add object 20. The run reads the unit's value and refuses if it
    // already holds this one.
    param: { paramRefId: "M-0081_A-FE01-11-75D9_P-10_R-10", value: "0" },
    // "light level" (lux value, read + transmit), linked on the unit: the run's test address is
    // added behind the object's own address while the run observes it, then removed again. The unit's
    // configuration shows two objects (9 and 10), both linked, so no unlinked object is left to link.
    link: { comObjRefId: "M-0081_A-FE01-11-75D9_O-10_R-11", addToLinked: true },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // The unit answers a GroupValueRead of the light level with the lux it measures, which the run
    // does not set.
    { kind: "output", label: "light level answers on the added test address", comObjRefId: "M-0081_A-FE01-11-75D9_O-10_R-11" },
  ],
  unsafe: [
    { capability: "structuralFlash", reason: "never written to this product on hardware: a product's first structural flash is not run on a unit in service" },
  ],
};
