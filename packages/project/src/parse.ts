import { XMLParser } from "fast-xml-parser";
import { numToGa } from "@busforge/knx";
import type { Project, Device, Topology, TopologyArea, GroupAddress, GroupRangeNode, SpaceNode, DeviceSecurity } from "./model.ts";

export const arr = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// "DPST-1-1" -> "1.001"; "DPT-1" -> "1.*"; pass through anything else.
function dptDisplay(s: string | undefined): string {
  if (!s) return "";
  const m = /^DPST-(\d+)-(\d+)$/.exec(s);
  if (m) return `${m[1]}.${m[2].padStart(3, "0")}`;
  const d = /^DPT-(\d+)$/.exec(s);
  if (d) return `${d[1]}.*`;
  return s;
}

// Numeric KNX manufacturer id from an M-XXXX-prefixed ref (product or app ref).
export const manufacturerOf = (ref: string): number => {
  const m = /^M-([0-9A-Fa-f]+)/.exec(ref);
  return m ? parseInt(m[1], 16) : 0;
};

export function parseProject(xml0: string, projectXml: string | undefined, fallbackName: string, productNames: Map<string, string> = new Map()): Project {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const doc = p.parse(xml0);

  const installation = firstByKey(doc, "Installation");
  const { topology, malformedDevices } = parseTopology(installation?.Topology, productNames);
  const locations = parseLocations(installation?.Locations);
  const devices = topology.areas.flatMap((a) => a.lines.flatMap((l) => l.devices));
  const { groupRanges, groupAddresses } = parseGroupAddresses(installation?.GroupAddresses);
  const deviceParams = devices.map((d) => ({ deviceId: d.id, values: parseDeviceParams(doc, d.id) }));
  const deviceModules = devices.map((d) => ({ deviceId: d.id, instances: parseDeviceModules(doc, d.id) }));
  const gaIdToRaw = new Map<string, number>();
  buildGaIdMap(doc, gaIdToRaw);
  const linkResults = devices.map((d) => ({ deviceId: d.id, ...parseDeviceLinks(doc, d.id, gaIdToRaw) }));
  const deviceLinks = linkResults.map(({ deviceId, links }) => ({ deviceId, links }));
  const unresolvedLinks = linkResults.reduce((n, r) => n + r.unresolved, 0);
  const deviceSecurity = devices.map((d) => parseDeviceSecurity(doc, d.id)).filter((x): x is DeviceSecurity => x !== undefined);

  return { name: parseName(projectXml, installation, fallbackName), topology, locations, devices, groupRanges, groupAddresses, deviceParams, deviceModules, deviceLinks, deviceSecurity, unresolvedLinks, malformedDevices };
}

// A device's Data-Secure commissioning secrets, or undefined for a non-secure device.
// The tool key lives in the device's nested <Security ToolKey="..b64.."> element
// (present only once ETS secure-commissioned it); the 6-byte device serial used for the
// Sync request is the DeviceInstance's own SerialNumber attribute. SequenceNumber here is
// the group/data counter, kept for completeness; tool-access programming syncs its own.
function parseDeviceSecurity(doc: any, deviceId: string): DeviceSecurity | undefined {
  const dev = findDeviceInstance(doc, deviceId);
  const sec = dev?.Security;
  // A non-secure device has no <Security> child; a stray Security="Off" attribute
  // parses to a string, not an object, so the ToolKey lookup safely yields nothing.
  if (!sec || typeof sec !== "object" || !sec.ToolKey) return undefined;
  return {
    deviceId,
    toolKey: String(sec.ToolKey),
    serialNumber: String(dev.SerialNumber ?? ""),
    sequenceNumber: String(sec.SequenceNumber ?? ""),
  };
}

// Map the prefix-stripped GroupAddress id ("GA-189") to its 16-bit address, so
// com-object links ("Links=GA-189 GA-190") can be resolved.
function buildGaIdMap(node: any, out: Map<string, number>) {
  if (node == null || typeof node !== "object") return;
  for (const g of arr<any>(node.GroupAddress)) out.set(String(g.Id).split("_").pop()!, Number(g.Address));
  for (const k of Object.keys(node)) buildGaIdMap(node[k], out);
}

// A device's com-object -> GA links (ComObjectInstanceRef RefId + resolved GAs).
// Also counts link tokens that did NOT resolve to a group address in the tree: those
// are real assignments we silently lose, so the caller can surface the count instead
// of pretending every link imported.
function parseDeviceLinks(doc: any, deviceId: string, gaIdToRaw: Map<string, number>): { links: { comObjRefId: string; gaRaws: number[] }[]; unresolved: number } {
  const dev = findDeviceInstance(doc, deviceId);
  // Merge by RefId: two ComObjectInstanceRefs on one device can share a RefId (synthetic
  // module-instance ids, or a malformed export). Stored per (refId, slot), two separate
  // rows would collide on the slot index and abort the whole import. Merging their GAs
  // keeps the assignments and never crashes; for the normal (unique-RefId) case it is a
  // no-op that preserves document order.
  const byRef = new Map<string, number[]>();
  let unresolved = 0;
  for (const c of arr<any>(dev?.ComObjectInstanceRefs?.ComObjectInstanceRef)) {
    if (!c.Links) continue;
    const tokens = String(c.Links).split(/\s+/).filter(Boolean);
    const gaRaws = tokens.map((l) => gaIdToRaw.get(l)).filter((x): x is number => x !== undefined);
    unresolved += tokens.length - gaRaws.length;
    if (!gaRaws.length) continue;
    const existing = byRef.get(String(c.RefId));
    if (existing) existing.push(...gaRaws);
    else byRef.set(String(c.RefId), gaRaws);
  }
  return { links: [...byRef].map(([comObjRefId, gaRaws]) => ({ comObjRefId, gaRaws })), unresolved };
}

// Collect a device's stored parameter values (ParameterRef id -> value).
function parseDeviceParams(doc: any, deviceId: string): { refId: string; value: string }[] {
  const dev = findDeviceInstance(doc, deviceId);
  const out: { refId: string; value: string }[] = [];
  for (const r of arr<any>(dev?.ParameterInstanceRefs?.ParameterInstanceRef)) {
    if (r.Value !== undefined) out.push({ refId: String(r.RefId), value: String(r.Value) });
  }
  return out;
}

// Collect a device's module instances with their resolved argument values.
function parseDeviceModules(doc: any, deviceId: string) {
  const dev = findDeviceInstance(doc, deviceId);
  return arr<any>(dev?.ModuleInstances?.ModuleInstance).map((mi) => ({
    id: String(mi.Id),
    refId: String(mi.RefId),
    args: arr<any>(mi.Arguments?.Argument).filter((a) => a.Value !== undefined).map((a) => ({ refId: String(a.RefId), value: String(a.Value) })),
  }));
}

// A single device's stored parameter values (ParameterRef id -> value) and its
// application ref, straight from a raw decrypted 0.xml. The full parseProject builds
// every device; the hardware read-back harnesses work one device at a time and only
// need this. Throws on an unknown id rather than returning a misleading empty map.
export function deviceParamValues(xml0: string, deviceId: string): { appRef: string; values: Map<string, string> } {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const dev = findDeviceInstance(p.parse(xml0), deviceId);
  if (!dev) throw new Error(`device ${deviceId} not found`);
  const values = new Map<string, string>();
  for (const r of arr<any>(dev.ParameterInstanceRefs?.ParameterInstanceRef)) if (r.Value !== undefined) values.set(String(r.RefId), String(r.Value));
  return { appRef: String(dev.Hardware2ProgramRefId ?? ""), values };
}

function findDeviceInstance(node: any, id: string): any {
  if (node == null || typeof node !== "object") return undefined;
  for (const d of arr<any>(node.DeviceInstance)) if (d.Id === id) return d;
  for (const k of Object.keys(node)) { const r = findDeviceInstance(node[k], id); if (r) return r; }
  return undefined;
}

function parseName(projectXml: string | undefined, installation: any, fallbackName: string): string {
  if (projectXml) {
    const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
    const info = firstByKey(p.parse(projectXml), "ProjectInformation");
    if (info?.Name) return String(info.Name);
  }
  if (installation?.Name) return String(installation.Name);
  return fallbackName;
}

function parseTopology(topo: any, productNames: Map<string, string>): { topology: Topology; malformedDevices: number } {
  const areas: TopologyArea[] = [];
  let malformedDevices = 0;
  for (const area of arr<any>(topo?.Area)) {
    const lines = arr<any>(area.Line).map((line) => {
      // Devices may sit directly under Line or under a Segment (ETS6).
      const devNodes = [...arr<any>(line.DeviceInstance), ...arr<any>(line.Segment).flatMap((s: any) => arr<any>(s.DeviceInstance))];
      const devices: Device[] = [];
      for (const d of devNodes) {
        const id = String(d.Id ?? "");
        const ia = `${Number(area.Address)}.${Number(line.Address)}.${Number(d.Address)}`;
        // A DeviceInstance without an Id cannot be correlated to its params/links/security
        // (findDeviceInstance keys on Id): keeping it would import a phantom that silently
        // drops all of them. A non-numeric address yields a "NaN.NaN.x" IA the device can
        // never be reached at. Both are genuinely unprocessable, so drop and COUNT them
        // rather than guess a default (see the no-silent-skip rule); the count is surfaced
        // to the user alongside unresolvedLinks.
        if (!id || ia.includes("NaN")) { malformedDevices++; continue; }
        devices.push({
          id,
          ia,
          // ETS falls back to the catalogue product name when a device has no
          // user-given instance name.
          name: String(d.Name || productNames.get(String(d.ProductRefId ?? "")) || ""),
          productRef: String(d.ProductRefId ?? ""),
          appRef: String(d.Hardware2ProgramRefId ?? ""),
          manufacturer: manufacturerOf(String(d.ProductRefId ?? "")),
          comment: [d.Comment, d.Description].map((x) => String(x ?? "").trim()).filter(Boolean).join(" "),
        });
      }
      return { address: Number(line.Address), name: String(line.Name ?? ""), devices };
    });
    areas.push({ address: Number(area.Address), name: String(area.Name ?? ""), lines });
  }
  return { topology: { areas }, malformedDevices };
}

// The building structure: <Locations> holds a tree of <Space> elements (ETS6),
// each carrying its Type (Building/Floor/Room/...), Name and the device instances
// placed directly in it. Nesting is arbitrary depth. Absent in older/structureless
// exports, in which case this returns an empty array.
function parseLocations(node: any): SpaceNode[] {
  const toSpace = (s: any): SpaceNode => ({
    id: "", // not addressable until stored (the DB assigns the row id); source id is extId
    extId: String(s.Id ?? ""),
    type: String(s.Type ?? ""),
    name: String(s.Name ?? ""),
    deviceIds: arr<any>(s.DeviceInstanceRef).map((r) => String(r.RefId ?? "")).filter(Boolean),
    children: arr<any>(s.Space).map(toSpace),
  });
  return arr<any>(node?.Space).map(toSpace);
}

function parseGroupAddresses(node: any): { groupRanges: GroupRangeNode[]; groupAddresses: GroupAddress[] } {
  const flat: GroupAddress[] = [];
  const toGa = (g: any): GroupAddress => {
    const raw = Number(g.Address);
    const ga: GroupAddress = { address: numToGa(raw), raw, name: String(g.Name ?? ""), dpt: dptDisplay(g.DatapointType) };
    flat.push(ga);
    return ga;
  };
  const toRange = (r: any): GroupRangeNode => ({
    id: "", // not addressable until stored (the DB assigns the row id); the XML id is discarded
    name: String(r.Name ?? ""),
    rangeStart: Number(r.RangeStart ?? 0),
    rangeEnd: Number(r.RangeEnd ?? 0),
    children: arr<any>(r.GroupRange).map(toRange),
    addresses: arr<any>(r.GroupAddress).map(toGa),
  });
  const groupRanges = arr<any>(node?.GroupRanges?.GroupRange).map(toRange);
  return { groupRanges, groupAddresses: flat };
}

function firstByKey(node: any, key: string): any {
  if (node == null || typeof node !== "object") return undefined;
  if (node[key]) return Array.isArray(node[key]) ? node[key][0] : node[key];
  for (const k of Object.keys(node)) { const r = firstByKey(node[k], key); if (r) return r; }
  return undefined;
}
