import type { DeviceSpec } from "../spec.ts";

// The Theben JMG 4 T blind actuator (MIX 2 application, MV-07B0, System B, module slots) as a unit in
// service: the run takes its configuration by read-back and writes one parameter flash, one GA flash
// and one structural flash, each reverted (inservice.ts); a full download of the configuration found
// only with --full-download. Refs pinned verbatim as the device configuration of this application
// lists them (module refs with their instance), taken offline from its catalogue and the unit's
// configuration; the run refuses a ref the unit's configuration does not list. All three steps lie in
// channel C3.
//
// Fingerprint: the application id, which this family reports on the application object (object 4,
// PID 13), and the device object's version (object 0, PID 25). The unit does not report PID 9. The
// HMG 6 T, JMG 4 T and RMG 8 T share application, firmware and hardware type, so the fingerprint
// passes on any of them; the base module type of the configuration (expectParams) tells them apart
// before the first write.
//
// A unit taken over by read-back carries no stamp record, and the MIX 2 firmware clears its download
// marker, so every parameter flash writes every byte the parameters own and every GA flash the
// com-object table whole, as ETS does when its stamps do not match (docs/load-procedures.md).
//
// Each write ends with the device's restart, after which its start-up telegrams follow within about
// 5 s; the blind channels take the reaction configured for a download and the bus's return, and a
// DME 2 T extension's load detection may flash its load briefly (manufacturer behaviour). Restarts
// per channel: twice per step plus the persistence restart, one more with a full download.
export const thebenJmg4tInService: DeviceSpec = {
  id: "theben-jmg4t-in-service",
  device: {
    appRef: "M-0048_H-4930250-2_HP-493B-21-B471",
    productRef: "M-0048_H-4930250-2_P-4930250",
    ia: "1.1.54",
    mask: "MV-07B0",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "0048493b21" },
      { name: "version", object: 0, pid: 25, expect: "0800" },
    ],
    // "Art des Grundmoduls": 5 is the JMG 4 T (the HMG 6 T is 6, the RMG units 1 to 3 and 8).
    expectParams: [{ name: "base module type", paramRefId: "M-0048_A-493B-21-B471_P-57_R-57", value: "5" }],
    // C3 "Laufzeit komplett Ab": 50 s to 51 s, a number in the parameter image that leaves the
    // com-object table alone. The run reads the unit's value and refuses if it already holds this one.
    param: { paramRefId: "M-0048_A-493B-21-B471_MD-6_M-16_MI-3_P-13_R-13", value: "51" },
    // C3 "Rückmelden Höhe %" (1 byte, read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-0048_A-493B-21-B471_MD-6_M-16_MI-3_O-2-13_R-4" },
    // C3 "Sperrfunktion aktivieren": on adds the channel's "Sperren" object (46) to the com-object
    // table.
    structural: { paramRefId: "M-0048_A-493B-21-B471_MD-6_M-16_MI-3_P-8_R-8", value: "1" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // With its read flag set the unit answers a GroupValueRead with the channel's height, which the
    // run does not set.
    { kind: "output", label: "C3 Rückmelden Höhe % answers on the test link", comObjRefId: "M-0048_A-493B-21-B471_MD-6_M-16_MI-3_O-2-13_R-4" },
  ],
  unsafe: [],
};
