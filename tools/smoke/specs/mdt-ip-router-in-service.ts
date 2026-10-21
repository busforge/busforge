import type { DeviceSpec } from "../spec.ts";

// The MDT IP Interface/Router SCN-IP000.03 (System B, MV-07B0, KNX Data Secure) as a unit in service:
// the run takes its configuration by read-back and writes one parameter flash and one GA flash, each
// reverted (inservice.ts). The product offers no full download (its application declares tunnelling
// entries, FULL_DOWNLOAD_TUNNELING_ENTRIES) and no structural flash. Its GA flash is ETS's group-address
// download of this product, byte for byte and step for step (tools/etsdiff.test.ts): the association
// table in the short form the unit describes, the address table after the security object. Refs pinned
// verbatim from the application's device configuration, taken offline from its catalogue; the run refuses
// a ref the unit's configuration does not list.
//
// Data Secure: the unit answers plain reads with nothing usable, so the run imports the installation's
// project file (--knxproj) for the unit's tool key and the keys of its group addresses, and opens every
// connection, its own included, under the unit's secure session.
//
// The unit is the second application of the box whose other one, the MDT IP Interface Secure, is the
// installation's KNXnet/IP interface. Every restart of this unit (each write ends with one, and the
// persistence check adds one) makes that interface stop serving its tunnels for up to a minute and then
// drop them, so the run reaches the unit through another interface (a USB interface on the line behind
// Busforge's bridge, the route of its verified parameter flashes in docs/status.md) and refuses that one,
// and the unit itself, should the box's KNXnet/IP server report its address. The other clients of
// that interface lose their tunnels at each restart all the same.
//
// Fingerprint: the application id (object 4, PID 13) and the version (object 0, PID 25), as a secured
// read-only collection of a unit shows them; the unit refuses PID 9.
export const mdtIpRouterInService: DeviceSpec = {
  id: "mdt-ip-router-in-service",
  device: {
    appRef: "M-0083_H-135-3_HP-0137-20-7EB2",
    productRef: "M-0083_H-135-3_P-SCN.2DIP000.2E03",
    ia: "1.1.91",
    mask: "MV-07B0",
  },
  provision: "in-service",
  inService: {
    fingerprint: [
      { name: "application id", object: 4, pid: 13, expect: "0083013720" },
      { name: "version", object: 0, pid: 25, expect: "1000" },
    ],
    dataSecure: true,
    ipInterface: { ia: "1.1.90", restart: "drops", shown: "the parameter flashes of this unit through the interface, where it dropped every tunnel after each restart" },
    // "Device name", a text in the parameter image that leaves the com-object table alone; its change
    // and change back were verified on a unit outside the smoke runs (docs/status.md). The run reads
    // the unit's name and refuses if it already holds this one.
    param: { paramRefId: "M-0083_A-0137-20-7EB2_P-162_R-162", value: "Busforge in service" },
    // "Operation" (DPST-1-11, read + transmit), unlinked in the application's default configuration,
    // linked to the run's test address while the run reads it.
    link: { comObjRefId: "M-0083_A-0137-20-7EB2_O-1_R-142" },
  },
  configure: [],
  behaviours: [
    // A unit that runs its application answers a GroupValueRead of "Operation"; which value it sends
    // is not shown, so any answer counts.
    { kind: "output", label: "Operation answers on the test link", comObjRefId: "M-0083_A-0137-20-7EB2_O-1_R-142" },
  ],
  unsafe: [],
};
