import type { DeviceSpec } from "../spec.ts";

// The Theben DALI-Gateway KNX plus (MV-07B0, System B, classic memory services only, no modules) as a
// unit in service: the run takes its configuration by read-back and writes one parameter flash, one GA
// flash and one structural flash, each reverted, and a full download of the configuration found only
// with --full-download (inservice.ts). Refs pinned verbatim as the device
// configuration of this application lists them, taken offline from its catalogue and the unit's
// configuration; the run refuses a ref the unit's configuration does not list. The com-object ref is
// the one the configuration found activates: a unit whose configuration activates another ref of the
// same object stops before the first write. All three steps lie in group 16.
//
// Fingerprint: the application id, which this family reports on the application object (object 4,
// PID 13), and the device object's version (object 0, PID 25). The unit does not report PID 9.
//
// The DALI configuration (addressing, groups, scenes, names) lives in interface object 6 and in the
// ballasts, written only by the manufacturer's ETS app (DCA), the gateway's web server or its buttons.
// No write of this run addresses it: the application's load procedure writes properties of objects 1
// to 4 only (object 0 it only compares), and the parameter, GA and structural flash write those
// objects' segments and load controls, and so does the full download in either form: on a unit
// holding this application loaded, with its tables and segment as the plan reads them, ETS's partial
// form, which leaves the PEI program loaded and unloads only the objects it reloads
// (docs/load-procedures.md, R1); otherwise the full form, which unloads the PEI program first (R9).
// Object 6 lies outside every write of both. The configuration is not
// in the fingerprint, which is read once before the run and would bind the spec to one
// installation's DALI data; only the ECGs' group assignments, which the application's objects
// follow, are in it (assumeParams).
//
// A unit taken over by read-back carries no stamp record, so its first parameter flash writes every
// byte the parameters own (ETS's fallback when its stamps do not match, docs/load-procedures.md) and
// its revert only the changed byte. Each write ends with the gateway's restart; while the application
// is not loaded its DALI fault object sends a fault, and how switched-on luminaires behave through
// such a write is not shown. Restarts per channel: twice per step plus the persistence restart, one
// more with a full download.
export const thebenDaliGatewayInService: DeviceSpec = {
  id: "theben-dali-gateway-in-service",
  device: {
    appRef: "M-0048_H-9070929-1-O00EF_HP-9071-20-F258-O00EF",
    productRef: "M-0048_H-9070929-1-O00EF_P-9070929",
    ia: "1.1.55",
    mask: "MV-07B0",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "0048907120" },
      { name: "version", object: 0, pid: 25, expect: "1846" },
    ],
    // Each ECG's group assignment has no memory location, so no read-back sees it, and under the
    // catalogue default ("not assigned") the application keeps every ECG's objects, which the unit's
    // com-object table does not hold for an assigned ECG. The run assumes the unit's assignments, as its
    // ETS project sets them. The read-back's image check shows which ECGs are assigned (their objects
    // leave the com-object table), not to which group: the groups are taken unproven, and the run
    // names them. ECGs not listed keep the default.
    assumeParams: [
      { name: "ECG group assignment (P-847)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-847_R-885", value: "6" },
      { name: "ECG group assignment (P-833)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-833_R-891", value: "2" },
      { name: "ECG group assignment (P-900)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-900_R-953", value: "2" },
      { name: "ECG group assignment (P-938)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-938_R-993", value: "6" },
      { name: "ECG group assignment (P-976)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-976_R-1033", value: "3" },
      { name: "ECG group assignment (P-1014)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1014_R-1073", value: "1" },
      { name: "ECG group assignment (P-1052)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1052_R-1113", value: "2" },
      { name: "ECG group assignment (P-1090)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1090_R-1153", value: "0" },
      { name: "ECG group assignment (P-1128)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1128_R-1193", value: "7" },
      { name: "ECG group assignment (P-1166)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1166_R-1233", value: "6" },
      { name: "ECG group assignment (P-1204)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1204_R-1273", value: "6" },
      { name: "ECG group assignment (P-1242)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1242_R-1313", value: "7" },
      { name: "ECG group assignment (P-1280)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1280_R-1353", value: "1" },
      { name: "ECG group assignment (P-1318)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1318_R-1393", value: "1" },
      { name: "ECG group assignment (P-1356)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1356_R-1433", value: "3" },
      { name: "ECG group assignment (P-1394)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1394_R-1473", value: "4" },
      { name: "ECG group assignment (P-1432)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1432_R-1513", value: "0" },
      { name: "ECG group assignment (P-1470)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1470_R-1553", value: "7" },
      { name: "ECG group assignment (P-1508)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1508_R-1593", value: "4" },
      { name: "ECG group assignment (P-1584)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1584_R-1673", value: "1" },
      { name: "ECG group assignment (P-1622)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1622_R-1713", value: "5" },
      { name: "ECG group assignment (P-1660)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1660_R-1753", value: "0" },
      { name: "ECG group assignment (P-1698)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1698_R-1793", value: "2" },
      { name: "ECG group assignment (P-1774)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1774_R-1873", value: "2" },
      { name: "ECG group assignment (P-1812)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1812_R-1913", value: "2" },
      { name: "ECG group assignment (P-1850)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1850_R-1953", value: "3" },
      { name: "ECG group assignment (P-1888)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1888_R-1993", value: "4" },
      { name: "ECG group assignment (P-1926)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1926_R-2033", value: "4" },
      { name: "ECG group assignment (P-1964)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-1964_R-2073", value: "7" },
      { name: "ECG group assignment (P-2002)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-2002_R-2113", value: "3" },
      { name: "ECG group assignment (P-2040)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-2040_R-2153", value: "3" },
      { name: "ECG group assignment (P-2078)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-2078_R-2193", value: "2" },
      { name: "ECG group assignment (P-2116)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-2116_R-2233", value: "2" },
      { name: "ECG group assignment (P-2154)", paramRefId: "M-0048_A-9071-20-F258-O00EF_P-2154_R-2273", value: "5" },
    ],
    // G16 "Time for Dimming": 10 s to 6 s (enumeration values 20 and 12), a value in the parameter
    // image that leaves the com-object table alone. The run reads the unit's value and refuses if it
    // already holds this one.
    param: { paramRefId: "M-0048_A-9071-20-F258-O00EF_P-781_R-832", value: "12" },
    // "Group 16, Status" (1 byte, read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-0048_A-9071-20-F258-O00EF_O-458_R-917" },
    // G16 "Additional SetValue Object incl. Dimming Time": on adds object 455 to the com-object table.
    structural: { paramRefId: "M-0048_A-9071-20-F258-O00EF_P-786_R-837", value: "1" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [
    // With its read flag set the gateway answers a GroupValueRead with the group's status, which the
    // run does not set.
    { kind: "output", label: "G16 Status answers on the test link", comObjRefId: "M-0048_A-9071-20-F258-O00EF_O-458_R-917" },
  ],
  unsafe: [],
};
