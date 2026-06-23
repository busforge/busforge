// The parsed view-model of a .knxproj, shared by the loader and the server API.

export interface Device {
  id: string;           // the 0.xml DeviceInstance Id, e.g. "P-07C7-0_DI-1"
  ia: string;           // "1.2.50"
  name: string;
  productRef: string;   // M-0048_H-...-P-...
  appRef: string;       // Hardware2ProgramRefId
  manufacturer: number; // from the M-XXXX prefix
  comment: string;      // ETS "Beschreibung" (Comment/Description), for search
}

// A placeable catalog product: a manufacturer product paired with an application
// program it runs. Extracted from the manufacturer Hardware.xml at ingest. The
// shape is source-agnostic: a .knxproj and a .knxprod share this structure, so
// the same extractor feeds the catalog from either (see the storage design note).
export interface CatalogProduct {
  appRef: string;       // Hardware2Program Id == a device's Hardware2ProgramRefId
  productRef: string;   // Product Id == a device's ProductRefId
  appProgramId: string; // appProgramId(appRef): the app_programs catalog key
  manufacturer: number; // from the M-XXXX prefix
  name: string;         // product catalogue text
  orderNumber: string;  // manufacturer order number
  hwVersion: string;    // hardware VersionNumber
}

// A device's stored parameter values, keyed by the application ParameterRef id.
export interface DeviceParam { refId: string; value: string; }
export interface DeviceParams { deviceId: string; values: DeviceParam[]; }

// A device's module instances (from 0.xml), pinning each instance's resolved
// argument values, used to expand channel/module configuration.
export interface ModuleInstanceData { id: string; refId: string; args: DeviceParam[]; }
export interface DeviceModules { deviceId: string; instances: ModuleInstanceData[]; }

// A device's com-object -> group-address links (from 0.xml). comObjRefId is the
// instance ComObjectInstanceRef RefId (prefix-stripped, as ETS stores it).
export interface DeviceLink { comObjRefId: string; gaRaws: number[]; }
export interface DeviceLinks { deviceId: string; links: DeviceLink[]; }

export interface TopologyLine {
  address: number;
  name: string;
  devices: Device[];
}
export interface TopologyArea {
  address: number;
  name: string;
  lines: TopologyLine[];
}
export interface Topology {
  areas: TopologyArea[];
}

export interface GroupAddress {
  address: string;      // "1/2/3"
  raw: number;          // 16-bit
  name: string;
  dpt: string;          // "DPST-1-1" -> "1.001" (display); raw kept too
}

// A node of the group-address tree (main group, then middle group), carrying
// the human names ETS assigned to each range.
export interface GroupRangeNode {
  id: string;
  name: string;
  rangeStart: number;
  rangeEnd: number;
  children: GroupRangeNode[];
  addresses: GroupAddress[];
}

export interface Project {
  name: string;
  topology: Topology;
  devices: Device[];
  groupRanges: GroupRangeNode[];
  groupAddresses: GroupAddress[]; // flat, for counts and search
  deviceParams: DeviceParams[];   // per-device parameter values from 0.xml
  deviceModules: DeviceModules[]; // per-device module instances from 0.xml
  deviceLinks: DeviceLinks[];     // per-device com-object -> GA links from 0.xml
}
