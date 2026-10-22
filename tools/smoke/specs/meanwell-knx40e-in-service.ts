import type { DeviceSpec } from "../spec.ts";

// The MEAN WELL KNX-40E-1280D power supply (application 0004, MV-07B0, System B) as a unit in
// service: the run takes its configuration by read-back and writes one parameter flash, one GA flash
// and one structural flash, each reverted (inservice.ts); a full download of the configuration found
// only with --full-download. Refs pinned verbatim from the application's catalogue; the run refuses a
// ref the unit's configuration does not list.
//
// The unit is the power supply of the line the run talks to. A download ends with A_Restart, which
// restarts its application, not its power stage: ETS's and Busforge's downloads of every kind kept the
// bus voltage through every unload and restart, and a bystander's tunnel through the installation's
// KNXnet/IP interface stayed up across each of them (ipInterface); the run's own tunnel through it
// across a restart of the unit has not been shown. What cuts the bus is a telegram to object 6
// ("Bus reset"); objects 3 to 5 trigger sends or clear counters. No step links any of them: the link
// step uses object 2, the structural step shows object 18 unlinked, and the full download writes the
// configuration found.
//
// The unit restarts before its layer-2 acknowledgement of A_Restart, so an interface confirms that
// frame negatively, and the unit gives no T_Disconnect: each flash ends verified with restartUnproven
// (docs/load-procedures.md). The persistence check (persistence.ts) needs two silent probes in a row
// after such a restart, and on the restart this unit showed over a KNX-USB interface it sees only one:
// the run then leaves the persistence step not assessed, the unit answering again
// (persistence.test.ts, "observeReboot on the MEAN WELL power supply's recorded restart"). Through an
// interface that confirms the restart it sees the reboot.
//
// Fingerprint: the application id (object 4, PID 13) and the version (object 0, PID 25); the unit
// refuses PID 9.
//
// Each write ends with the unit's restart, about 2.2 s offline: per channel twice per step plus the
// persistence restart, one more with a full download.
export const meanwellKnx40eInService: DeviceSpec = {
  id: "meanwell-knx40e-in-service",
  device: {
    appRef: "M-0162_H-KNX.2D40E.2D1280D-1_HP-0004-11-F245",
    productRef: "M-0162_H-KNX.2D40E.2D1280D-1_P-KNX.2D40E.2D1280D",
    ia: "1.1.20",
    mask: "MV-07B0",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "0162000411" },
      { name: "version", object: 0, pid: 25, expect: "1044" },
    ],
    ipInterface: { ia: "1.1.90", restart: "keeps", shown: "a bystander's tunnel through it stayed up, every frame confirmed, across every ETS and Busforge download of this unit and its restarts, while the downloads themselves ran through a USB interface on the line" },
    // "Maximum Tracking Period" 1800 to 1810 s: both tracking functions are disabled in the
    // installation, so the value has no effect on the unit, and it shows and hides nothing. The run
    // reads the unit's value and refuses if it already holds this one.
    param: { paramRefId: "M-0162_A-0004-11-F245_P-29_R-29", value: "1810" },
    // "Power supply on" (1 bit, read + transmit), unlinked in the installation; linked to the run's test
    // address while the run reads it. The unit also sends it at every start.
    link: { comObjRefId: "M-0162_A-0004-11-F245_O-2_R-2" },
    // "Maximale Temperatur" "Dekativiert" to "aktiviert" shows object 18 (the maximum temperature) in
    // the configuration, which takes the structural flash; the object stays unlinked (no group
    // address). The change sets object 18's two bytes of the com-object table (its config and type;
    // the table goes whole where the unit's record is not of a download that wrote it, as after a
    // parameter flash, else those two bytes) and the switch; the parameter it shows, "maximale Temperatur senden", stays at its default, which
    // the unit holds. The revert hides the object and resets the switch. ETS's partial downloads of
    // this change and its revert are captured (tools/etsdiff.test.ts).
    structural: { paramRefId: "M-0162_A-0004-11-F245_P-97_R-97", value: "1" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // The unit answers a GroupValueRead of "Power supply on" with 1 while it supplies the line.
    { kind: "output", label: "Power supply on answers on the test link", comObjRefId: "M-0162_A-0004-11-F245_O-2_R-2", expectValue: "01" },
  ],
  unsafe: [],
};
