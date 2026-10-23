import type { DeviceSpec } from "../spec.ts";

// The Theben RMG 8 T switch actuator (MIX 2 application, MV-07B0, System B, module slots) as a unit in
// service: the run takes its configuration by read-back and writes one parameter flash, one GA flash
// and one structural flash, each reverted (inservice.ts); a full download of the configuration found
// only with --full-download. Refs pinned verbatim as the device configuration of this application
// lists them (module refs with their instance), taken offline from its catalogue and the unit's
// configuration; the run refuses a ref the unit's configuration does not list. All three steps lie in
// channel C2 of the second DME 2 T extension.
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
// 5 s; the switching channels take the state configured for a download and the bus's return, and a
// DME 2 T extension's load detection may flash its load briefly (manufacturer behaviour). Restarts
// per channel: twice per step plus the persistence restart, one more with a full download.
export const thebenRmg8tInService: DeviceSpec = {
  id: "theben-rmg8t-in-service",
  device: {
    appRef: "M-0048_H-4930200-2_HP-493B-21-B471",
    productRef: "M-0048_H-4930200-2_P-4930200",
    ia: "1.1.53",
    mask: "MV-07B0",
  },
  provision: "in-service",
  inService: {
    // The download marker P-199, bit 0x80 (docs/load-procedures.md R17): every parameter download sets it, the
    // unit clears it.
    runtimeMemory: [{ address: 0x3c25, mask: 0x80, why: "download marker P-199, set by each download and cleared by the unit" }],
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "0048493b21" },
      { name: "version", object: 0, pid: 25, expect: "0800" },
    ],
    // "Art des Grundmoduls": 1 (RMG 8 S). This RMG 8 T unit's configuration names the RMG 8 S base
    // module; 2 (RMG 8 T), the HMG 6 T's 6 or the JMG 4 T's 5 would stop the run. With the unit's
    // extension modules.
    assumeParams: [
      { name: "base module type", paramRefId: "M-0048_A-493B-21-B471_P-57_R-57", value: "1" },
      { name: "1st extension module type", paramRefId: "M-0048_A-493B-21-B471_P-200_R-200", value: "1" },
      { name: "2nd extension module type", paramRefId: "M-0048_A-493B-21-B471_P-201_R-201", value: "4" },
    ],
    expectParams: [
      // Channel C5 drives an output that must never switch by itself: an impulse channel with a normally
      // open contact, off on a download and a bus failure, off on the bus's return, its lock and logic
      // functions off. These values decide its state on a download, a bus failure and the bus's return;
      // a unit configured otherwise stops the run before its first write.
      { name: "C5 function (impulse)", paramRefId: "M-0048_A-493B-21-B471_MD-1_M-1_MI-5_P-1_R-1", value: "2" },
      { name: "C5 contact type (normally open)", paramRefId: "M-0048_A-493B-21-B471_MD-1_M-1_MI-5_P-9_R-9", value: "0" },
      { name: "C5 state on download and bus failure (off)", paramRefId: "M-0048_A-493B-21-B471_MD-1_M-1_MI-5_P-10_R-11", value: "0" },
      { name: "C5 state on power or bus return (off)", paramRefId: "M-0048_A-493B-21-B471_MD-1_M-1_MI-5_UP-12_R-13", value: "0" },
      { name: "C5 lock function (off)", paramRefId: "M-0048_A-493B-21-B471_MD-1_M-1_MI-5_P-3_R-3", value: "0" },
      { name: "C5 logic function (off)", paramRefId: "M-0048_A-493B-21-B471_MD-1_M-1_MI-5_P-8_R-8", value: "0" },
    ],
    // "Dimmzeit 1 von 0 % auf 100 %" of the second DME 2 T, C2: 4 s to 6 s, a value in the parameter
    // image that leaves the com-object table alone. The run reads the unit's value and refuses if it
    // already holds this one.
    param: { paramRefId: "M-0048_A-493B-21-B471_MD-12_M-39_MI-1_P-28_R-442", value: "6" },
    // "Rückmeldung in %" of the second DME 2 T, C2 (1 byte, read + transmit), linked to the run's test
    // address while the run observes it.
    link: { comObjRefId: "M-0048_A-493B-21-B471_MD-12_M-39_MI-1_O-2-10_R-8" },
    // The second extension module's (DME 2 T) C2 "Diagnosemeldungen aktivieren": "nein" to "ja" shows
    // objects 205 to 209 (diagnostics) in the configuration, which takes the structural flash; the
    // objects stay unlinked (no group address). The change sets five config bytes of the com-object
    // table (written whole, as ETS writes it), the switch and the cyclic sending time it shows (10); the revert hides the objects and
    // resets the switch but leaves the sending time at 10, as ETS's revert leaves it, since neither
    // writes a parameter the configuration no longer shows (so a unit that held 10 there already
    // changes only in the switch and the table). ETS's partial
    // downloads of this change and its revert are captured (tools/etsdiff.test.ts).
    structural: { paramRefId: "M-0048_A-493B-21-B471_MD-12_M-39_MI-1_P-9_R-9", value: "1" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // With its read flag set the unit answers a GroupValueRead with the channel's brightness, which
    // the run does not set.
    { kind: "output", label: "2. DME 2 T C2 Rückmeldung in % answers on the test link", comObjRefId: "M-0048_A-493B-21-B471_MD-12_M-39_MI-1_O-2-10_R-8" },
  ],
  unsafe: [],
};
