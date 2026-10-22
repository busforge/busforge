import type { DeviceSpec } from "../spec.ts";

// The Gira Tastsensor 3 Komfort (application 10D7, MV-0705, System 7 property-mapped, dynamic tables)
// as a unit in service: the run takes its configuration by read-back and writes one parameter flash,
// one GA flash and one structural flash, each reverted (inservice.ts); a full download of the
// configuration found only with --full-download. Refs pinned verbatim as the device configuration of this application lists
// them, taken offline from its catalogue; the run refuses a ref the unit's configuration does not
// list.
//
// Fingerprint: the application id, which this family reports on the application object (object 3,
// PID 13), and the firmware revision (object 0, PID 9). The unit does not report PID 25.
//
// Busforge keeps no stamp record for this application (docs/load-procedures.md), so every parameter
// flash writes the whole application image, as ETS does when its stamps do not match. Each write ends
// with the device's restart, during which its keys do nothing: per channel twice per step plus the
// persistence restart, one more with a full download.
export const giraM0008InService: DeviceSpec = {
  id: "gira-m0008-in-service",
  device: {
    appRef: "M-0008_H-8.20.2F.2F.20zxy3.20xx-1_HP-10D7-11-2783-O000A",
    productRef: "M-0008_H-8.20.2F.2F.20zxy3.20xx-1_P-5133.2000",
    ia: "1.1.1",
    mask: "MV-0705",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 3, pid: 13, expect: "000810d711" },
      { name: "firmware revision", object: 0, pid: 9, expect: "05" },
    ],
    // The rocker functions and status LED functions have no memory location, so no read-back sees
    // them; the unit runs these values (its ETS project's), not the catalogue defaults. Under the
    // defaults two of the objects the unit links under "Dimmen" stay hidden and their links unresolved.
    // The server takes them only if the unit's configuration then shows an object for every link and
    // the parameter image under them equals the unit's: "Jalousie" shows the same objects as "Dimmen",
    // so the image, not the links, tells the rocker functions apart, and it shows the LED functions.
    assumeParams: [
      { name: "rocker function (P-224)", paramRefId: "M-0008_A-10D7-11-2783-O000A_P-224_R-224", value: "2" },
      { name: "rocker function (P-2194)", paramRefId: "M-0008_A-10D7-11-2783-O000A_P-2194_R-2194", value: "2" },
      { name: "left status LED function (P-579)", paramRefId: "M-0008_A-10D7-11-2783-O000A_P-579_R-579", value: "3" },
      { name: "left status LED function (P-1286)", paramRefId: "M-0008_A-10D7-11-2783-O000A_P-1286_R-1286", value: "3" },
    ],
    // "Einschaltdauer der Status-LED": 3 s to 4 s, a value in the parameter image that shows and hides
    // nothing, so the com-object table stays. The run reads the unit's value and refuses if it already
    // holds this one.
    param: { paramRefId: "M-0008_A-10D7-11-2783-O000A_P-3764_R-3764", value: "40" },
    // "Wippe 3 / Schalten" (1 bit, write + transmit, no read flag), unlinked on the unit: linked to
    // the run's test address and unlinked again. No object of this application has the read flag as
    // it sets it, so nothing on the unit answers a read, and a telegram on it needs someone to press
    // the rocker: the link is shown to the byte only.
    link: { comObjRefId: "M-0008_A-10D7-11-2783-O000A_O-4_R-3038" },
    // "Sperrfunktion?": "Nein" to "Ja" shows object 54 (Tasten sperren) in the configuration, which takes
    // the structural flash; the object stays unlinked (no group address). In ETS's captured partial
    // downloads of this change and its revert (tools/etsdiff.test.ts) two bytes change on the unit:
    // object 54's config byte and the lock function's parameter byte. The parameter has no memory
    // location, so the run takes the project's value, "Nein"; the dry runs that compare the unit's
    // bytes (those two included) back it.
    structural: { paramRefId: "M-0008_A-10D7-11-2783-O000A_P-3848_R-3848", value: "1" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [],
  unsafe: [],
};
