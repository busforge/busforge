import type { DeviceSpec } from "../spec.ts";

// The MDT IP Interface Secure SCN-IP000.03 (System 1, MV-0012, KNX Data Secure, no group objects) as a
// unit in service: the run takes its configuration by read-back and writes one parameter download
// there and back (inservice.ts); a full download of the configuration found only with --full-download.
// It has no objects, so no link step and no behaviour: its parameters are proven to the byte. Refs
// pinned verbatim from the application's device configuration, taken offline from its catalogue.
//
// Data Secure: the run imports the installation's project file (--knxproj), which brings the unit's
// tool key and its KNXnet/IP settings (IP configuration, tunnelling addresses), which the download
// writes as they are; it refuses a project that would change them.
//
// The unit is the installation's KNXnet/IP interface, and its download runs only under its secure
// session through that interface (a USB interface does not carry its 30-byte name write). Its restart
// keeps the tunnels it serves, so the run goes through it; each write ends with one.
//
// Fingerprint: the application id the unit keeps in its EEPROM at 0x0104 (manufacturer, application
// number, version), as a secured read-only collection of a unit shows it.
export const mdtIpSecureInService: DeviceSpec = {
  id: "mdt-ip-secure-in-service",
  device: {
    appRef: "M-0083_H-135-3-O0072_HP-0138-21-F18E-O0072",
    productRef: "M-0083_H-135-3-O0072_P-SCN.2DIP000.2E03",
    ia: "1.1.90",
    mask: "MV-0012",
  },
  provision: "in-service",
  inService: {
    fingerprint: [{ name: "application id", memory: 0x0104, length: 4, expect: "83013821" }],
    dataSecure: true,
    ipInterface: { ia: "1.1.90", restart: "keeps", shown: "a parameter download of this unit through its own tunnel, which kept its tunnels and their individual addresses through the restart" },
    // "HTTP port" of its web frontend, 8080 to 80: a byte in its EEPROM the download verifies, nothing
    // that addresses the interface. The run reads the unit's value and refuses if it already holds 80.
    param: { paramRefId: "M-0083_A-0138-21-F18E-O0072_P-10_R-10", value: "80" },
    fullDownload: true,
  },
  configure: [],
  behaviours: [],
  unsafe: [],
};
