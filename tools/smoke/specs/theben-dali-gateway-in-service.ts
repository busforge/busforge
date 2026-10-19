import type { DeviceSpec } from "../spec.ts";

// The Theben DALI-Gateway KNX plus (MV-07B0, System B, classic memory services only, no modules) as a
// unit in service: the run takes its configuration by read-back and writes one parameter flash, one GA
// flash and one structural flash, each reverted (inservice.ts). Refs pinned verbatim as the device
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
// objects' segments and load controls. The configuration is not in the fingerprint, which is read once
// before the run and would bind the spec to one installation's DALI data.
//
// A unit taken over by read-back carries no stamp record, so its first parameter flash writes every
// byte the parameters own (ETS's fallback when its stamps do not match, docs/load-procedures.md) and
// its revert only the changed byte. Each write ends with the gateway's restart; while the application
// is not loaded its DALI fault object sends a fault, and how switched-on luminaires behave through
// such a write is not shown. Restarts per channel: twice per step plus the persistence restart.
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
    // G16 "Time for Dimming": 10 s to 6 s (enumeration values 20 and 12), a value in the parameter
    // image that leaves the com-object table alone. The run reads the unit's value and refuses if it
    // already holds this one.
    param: { paramRefId: "M-0048_A-9071-20-F258-O00EF_P-781_R-832", value: "12" },
    // "Group 16, Status" (1 byte, read + transmit), linked to the run's test address while the run
    // observes it.
    link: { comObjRefId: "M-0048_A-9071-20-F258-O00EF_O-458_R-917" },
    // G16 "Additional SetValue Object incl. Dimming Time": on adds object 455 to the com-object table.
    structural: { paramRefId: "M-0048_A-9071-20-F258-O00EF_P-786_R-837", value: "1" },
  },
  configure: [],
  behaviours: [
    // With its read flag set the gateway answers a GroupValueRead with the group's status, which the
    // run does not set.
    { kind: "output", label: "G16 Status answers on the test link", comObjRefId: "M-0048_A-9071-20-F258-O00EF_O-458_R-917" },
  ],
  unsafe: [
    { capability: "fullDownload", reason: "a full download unloads the application first, and restoring the gateway's DALI configuration (interface object 6, the ballasts) after one that breaks off is not shown" },
  ],
};
