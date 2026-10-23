// The parsed view-model of a .knxproj, shared by the loader and the server API.
import type { Levels } from "@busforge/knx";

export interface Device {
  id: string;           // the 0.xml DeviceInstance Id, e.g. "P-07C7-0_DI-1"
  ia: string;           // "1.2.3"
  name: string;
  productRef: string;   // M-0048_H-...-P-...
  appRef: string;       // Hardware2ProgramRefId
  manufacturer: number; // from the M-XXXX prefix
  comment: string;      // ETS "Beschreibung" (Comment/Description), for search
  // What ETS last downloaded into the device, from its per-device load flags. ETS sets each to "true"
  // when it downloads that part and drops it when the part is edited afterwards (a false flag is left
  // off); a device another tool programmed reads false throughout.
  etsLoaded: EtsLoaded;
}

export interface EtsLoaded { individualAddress: boolean; mediumConfig: boolean; application: boolean; parameters: boolean; communication: boolean }
// A part of a device ETS downloads apart from its application: its individual address, its medium
// configuration, its parameters, its group-address links (ETS's communication part).
export const ETS_PARTS = ["address", "medium", "parameters", "links"] as const;
export type EtsPart = (typeof ETS_PARTS)[number];

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
// argument values, used to expand channel/module configuration. Structurally identical
// to @busforge/product's ModuleInstance (the consuming form): serialized into the
// server's device_modules JSON here and re-validated on read (db/deviceparams.ts).
export interface ModuleInstanceData { id: string; refId: string; args: DeviceParam[]; }
export interface DeviceModules { deviceId: string; instances: ModuleInstanceData[]; }

// A device's com-object -> group-address links (from 0.xml). comObjRefId is the
// instance ComObjectInstanceRef RefId (prefix-stripped, as ETS stores it).
export interface DeviceLink { comObjRefId: string; gaRaws: number[]; }
export interface DeviceLinks { deviceId: string; links: DeviceLink[]; }

// The com-object flags and priority the project sets on one device over its application's (from 0.xml
// ComObjectInstanceRef ReadFlag, WriteFlag, CommunicationFlag, TransmitFlag, UpdateFlag,
// ReadOnInitFlag, Priority). `attrs` holds each attribute present, verbatim; what a value means is
// decided where the com-object table is written. comObjRefId as in DeviceLink. One entry per
// ComObjectInstanceRef carrying any of them, in document order (two can share a RefId).
export const COM_OBJ_INSTANCE_ATTRS = ["ReadFlag", "WriteFlag", "CommunicationFlag", "TransmitFlag", "UpdateFlag", "ReadOnInitFlag", "Priority"] as const;
export interface ComObjInstanceAttrs { comObjRefId: string; attrs: Record<string, string>; }
export interface DeviceComObjOverrides { deviceId: string; overrides: ComObjInstanceAttrs[]; }

// A Data-Secure device's commissioning secrets, parsed from the device's
// <Security> element in 0.xml (present only when the device is secure-commissioned).
// toolKey/serialNumber are base64 exactly as ETS stores them (16- and 6-byte values);
// sequenceNumber is the group/data counter (NOT the tool-access counter, which is
// obtained live via Sync). Keys are sealed before they touch the DB (see secrets.ts);
// the parser only lifts the plaintext out of the already-decrypted project archive.
export interface DeviceSecurity { deviceId: string; toolKey: string; serialNumber: string; sequenceNumber: string; }
// A Data Secure group address's key (base64, 16 bytes), from its <GroupAddress Key> attribute.
export interface GroupKey { raw: number; key: string; }

// An individual address the project lets send on a group address outside the devices' own objects:
// a bus interface (a tunnelling channel of an IP interface or router) assigned to the address. For a
// secured address this is who a receiving device lists in its security individual address table.
export interface SecureSender { gaRaw: number; ia: string; deviceId: string; busInterfaceRefId: string; }

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

// The building structure from 0.xml's <Locations>: a tree of <Space> elements
// (Building > Floor > Room, with deeper types like DistributionBoard/Corridor).
// Each space carries the ids of the device instances placed directly in it
// (DeviceInstanceRef RefId == Device.id). Empty for a project without locations.
export interface SpaceNode {
  // The addressable node id the edit/assign endpoints take: the DB row id in a STORED
  // tree (readSpaces), empty in a freshly PARSED tree that has no row yet. Never the
  // source 0.xml id (that is extId), so a node never lies about which id it carries.
  id: string;
  extId: string;       // the source 0.xml Space Id (provenance, persisted as spaces.ext_id)
  type: string;        // "Building" | "Floor" | "Room" | "DistributionBoard" | ...
  name: string;
  deviceIds: string[]; // device instance ids placed directly in this space
  children: SpaceNode[];
}

export interface GroupAddress {
  address: string;      // "1/2/3"
  raw: number;          // 16-bit
  name: string;
  dpt: string;          // "DPST-1-1" -> "1.001" (display); raw kept too
  security: GroupAddressSecurity;
}

// ETS's per-address Data Secure setting: "Automatisch" (secured while every linked device is
// secure), "Erzwungen an" (a device without security cannot be linked), "Erzwungen aus" (plain).
export type GroupAddressSecurity = "auto" | "on" | "off";

// A node of the group-address tree (main group, then middle group), carrying
// the human names ETS assigned to each range.
export interface GroupRangeNode {
  // The addressable range id: the DB row id in a STORED tree (getProject), the form the
  // group-range edit endpoints take. Empty in a freshly PARSED tree (the source 0.xml
  // range id is discarded at import; no column persists it and nothing addresses a
  // pre-store range), so a parsed range never presents a non-addressable id as if it were one.
  id: string;
  name: string;
  rangeStart: number;
  rangeEnd: number;
  children: GroupRangeNode[];
  addresses: GroupAddress[];
}

// The settings of a KNXnet/IP device that the project keeps on its DeviceInstance outside the
// application's parameters (0.xml), which ETS writes into the device's KNXnet/IP parameter object.
// Attributes are kept verbatim (names and values as ETS stores them, the security element's names
// only): what a value means, and which values a download can write, is decided where it is written.
// installation: the attributes of the project's <Installation> (the routing multicast settings live there).
export interface DeviceKnxIp {
  deviceId: string;
  instanceName: string;                    // the DeviceInstance Name, "" where ETS shows the product name
  productName: string;                     // the product's catalogue text (Hardware.xml Product Text, its default language)
  productNameTranslations: string[];       // the same text in the catalogue's other languages
  ipConfig: Record<string, string> | null; // <IPConfig> attributes
  additionalAddresses: (number | null)[];  // <AdditionalAddresses> Address values, in document order; null where not a number
  securityAttributes: string[];            // attribute names of <Security>
  toolKeyLoaded: boolean;                  // <Security> holds a ToolKey equal to its LoadedToolKey
  busInterfaces: number;                   // <BusInterface> elements under <BusInterfaces>
  installation: Record<string, string>;
}

export interface Project {
  name: string;
  groupAddressLevels: Levels; // group-address style (2 or 3), from GroupAddressStyle
  topology: Topology;
  locations: SpaceNode[];         // building structure from 0.xml <Locations> (empty if none)
  devices: Device[];
  groupRanges: GroupRangeNode[];
  groupAddresses: GroupAddress[]; // flat, for counts and search
  deviceParams: DeviceParams[];   // per-device parameter values from 0.xml
  deviceModules: DeviceModules[]; // per-device module instances from 0.xml
  deviceLinks: DeviceLinks[];     // per-device com-object -> GA links from 0.xml
  deviceComObjOverrides: DeviceComObjOverrides[]; // per-device com-object flags/priority the project sets, from 0.xml
  deviceSecurity: DeviceSecurity[]; // per-device Data-Secure tool keys from 0.xml (only secure devices)
  deviceKnxIp: DeviceKnxIp[];     // KNXnet/IP device settings from 0.xml (only devices with IPConfig or AdditionalAddresses)
  groupKeys: GroupKey[]; // Data-Secure group keys from 0.xml (only secured group addresses)
  secureSenders: SecureSender[]; // bus interfaces assigned to group addresses (0.xml BusInterface Connectors)
  unresolvedSenders: number;      // such assignments whose interface address could not be resolved (surfaced, never guessed)
  secureDevicesWithoutSerial: number; // secure devices ETS holds a tool key for but never commissioned (no serial): imported without it
  unresolvedLinks: number;        // link tokens that referenced a GA not in the tree (silently lost unless surfaced)
  malformedDevices: number;       // DeviceInstances dropped for a missing Id or non-numeric address (unkeyable/unaddressable; surfaced, not silently defaulted)
}
