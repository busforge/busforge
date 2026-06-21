// The parsed view-model of a .knxproj, shared by the loader and the server API.

export interface Device {
  ia: string;           // "1.2.50"
  name: string;
  productRef: string;   // M-0048_H-...-P-...
  appRef: string;       // Hardware2ProgramRefId
  manufacturer: number; // from the M-XXXX prefix
}

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
}
