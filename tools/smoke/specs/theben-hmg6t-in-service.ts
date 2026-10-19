import type { DeviceSpec } from "../spec.ts";

// The Theben HMG 6 T heating actuator (MIX 2 application, MV-07B0, System B, module slots) as a unit
// in service: the run takes its configuration by read-back and writes one parameter flash and one GA
// flash, each reverted (inservice.ts); a full download of the configuration found only with
// --full-download. Refs pinned verbatim as the device configuration of this application lists them
// (module refs with their instance), taken offline from its catalogue and the unit's configuration;
// the run refuses a ref the unit's configuration does not list.
//
// Fingerprint: the application id, which this family reports on the application object (object 4,
// PID 13), and the device object's version (object 0, PID 25). The unit does not report PID 9. The
// HMG 6 T, JMG 4 T and RMG 8 T share application, firmware and hardware type, so the fingerprint
// passes on any of them. The module types of the base module and the extension modules have no
// memory location, so no read-back sees them: the run assumes the unit's (assumeParams), and a wrong
// one leaves links unresolved or the dry runs finding bytes to write, before the first write.
//
// A unit taken over by read-back carries no stamp record, and the MIX 2 firmware clears its download
// marker, so every parameter flash writes every byte the parameters own and every GA flash the
// com-object table whole, as ETS does when its stamps do not match (docs/load-procedures.md).
//
// Each write ends with the device's restart, after which its start-up telegrams follow within about
// 5 s; a DME 2 T extension's load detection may flash its load briefly (manufacturer behaviour),
// and what the heating channels do through a restart is not shown. Restarts per channel: twice per
// step plus the persistence restart, one more with a full download.
export const thebenHmg6tInService: DeviceSpec = {
  id: "theben-hmg6t-in-service",
  device: {
    appRef: "M-0048_H-4930240-2_HP-493B-21-B471",
    productRef: "M-0048_H-4930240-2_P-4930240",
    ia: "1.1.51",
    mask: "MV-07B0",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "0048493b21" },
      { name: "version", object: 0, pid: 25, expect: "0800" },
    ],
    // "Art des Grundmoduls" 6 is the HMG 6 T (the JMG 4 T is 5, the RMG units 1 to 3 and 8), and the
    // unit's extension modules. Each channel's "Regelung" and the setting it shows (P-37) have no
    // memory location either and show the channel's heating/cooling object, which the unit links.
    assumeParams: [
      { name: "base module type", paramRefId: "M-0048_A-493B-21-B471_P-57_R-57", value: "6" },
      { name: "1st extension module type", paramRefId: "M-0048_A-493B-21-B471_P-200_R-200", value: "4" },
      { name: "2nd extension module type", paramRefId: "M-0048_A-493B-21-B471_P-201_R-201", value: "5" },
      { name: "C1 Regelung", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-1_P-19_R-21", value: "1" },
      { name: "C2 Regelung", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-2_P-19_R-21", value: "1" },
      { name: "C3 Regelung", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-3_P-19_R-21", value: "1" },
      { name: "C4 Regelung", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-4_P-19_R-21", value: "1" },
      { name: "C5 Regelung", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-5_P-19_R-21", value: "1" },
      { name: "C6 Regelung", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-6_P-19_R-21", value: "1" },
      { name: "C1 cooling setting (P-37)", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-1_P-37_R-43", value: "1" },
      { name: "C2 cooling setting (P-37)", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-2_P-37_R-43", value: "1" },
      { name: "C3 cooling setting (P-37)", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-3_P-37_R-43", value: "1" },
      { name: "C4 cooling setting (P-37)", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-4_P-37_R-43", value: "1" },
      { name: "C5 cooling setting (P-37)", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-5_P-37_R-43", value: "1" },
      { name: "C6 cooling setting (P-37)", paramRefId: "M-0048_A-493B-21-B471_MD-7_M-19_MI-6_P-37_R-43", value: "1" },
    ],
    // "Ausschaltverzögerung für Pumpe": 10 min to 15 min, a value in the parameter image that leaves the
    // com-object table alone. The run reads the unit's value and refuses if it already holds this one.
    param: { paramRefId: "M-0048_A-493B-21-B471_MD-8_M-20_MI-1_P-6_R-6", value: "15" },
    // "Größte Stellgröße" (1 byte, read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-0048_A-493B-21-B471_MD-8_M-20_MI-1_O-2-3_R-4" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // With its read flag set the unit answers a GroupValueRead with the largest valve position it
    // computes, which the run does not set.
    { kind: "output", label: "Größte Stellgröße answers on the test link", comObjRefId: "M-0048_A-493B-21-B471_MD-8_M-20_MI-1_O-2-3_R-4" },
  ],
  unsafe: [
    { capability: "structuralFlash", reason: "never written to this product on hardware: a product's first structural flash is not run on a unit in service" },
  ],
};
