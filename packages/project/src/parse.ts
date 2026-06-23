import { XMLParser } from "fast-xml-parser";
import { numToGa } from "@busforge/knx";
import type { Project, Device, Topology, TopologyArea, GroupAddress, GroupRangeNode } from "./model.ts";

const arr = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// "DPST-1-1" -> "1.001"; "DPT-1" -> "1.*"; pass through anything else.
function dptDisplay(s: string | undefined): string {
  if (!s) return "";
  const m = /^DPST-(\d+)-(\d+)$/.exec(s);
  if (m) return `${m[1]}.${m[2].padStart(3, "0")}`;
  const d = /^DPT-(\d+)$/.exec(s);
  if (d) return `${d[1]}.*`;
  return s;
}

const manufacturerOf = (productRef: string): number => {
  const m = /^M-([0-9A-Fa-f]+)/.exec(productRef);
  return m ? parseInt(m[1], 16) : 0;
};

export function parseProject(xml0: string, projectXml: string | undefined, fallbackName: string, productNames: Map<string, string> = new Map()): Project {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const doc = p.parse(xml0);

  const installation = firstByKey(doc, "Installation");
  const topology = parseTopology(installation?.Topology, productNames);
  const devices = topology.areas.flatMap((a) => a.lines.flatMap((l) => l.devices));
  const { groupRanges, groupAddresses } = parseGroupAddresses(installation?.GroupAddresses);
  const deviceParams = devices.map((d) => ({ deviceId: d.id, values: parseDeviceParams(doc, d.id) }));
  const deviceModules = devices.map((d) => ({ deviceId: d.id, instances: parseDeviceModules(doc, d.id) }));
  const gaIdToRaw = new Map<string, number>();
  buildGaIdMap(doc, gaIdToRaw);
  const deviceLinks = devices.map((d) => ({ deviceId: d.id, links: parseDeviceLinks(doc, d.id, gaIdToRaw) }));

  return { name: parseName(projectXml, installation, fallbackName), topology, devices, groupRanges, groupAddresses, deviceParams, deviceModules, deviceLinks };
}

// Map the prefix-stripped GroupAddress id ("GA-189") to its 16-bit address, so
// com-object links ("Links=GA-189 GA-190") can be resolved.
function buildGaIdMap(node: any, out: Map<string, number>) {
  if (node == null || typeof node !== "object") return;
  for (const g of arr<any>(node.GroupAddress)) out.set(String(g.Id).split("_").pop()!, Number(g.Address));
  for (const k of Object.keys(node)) buildGaIdMap(node[k], out);
}

// A device's com-object -> GA links (ComObjectInstanceRef RefId + resolved GAs).
function parseDeviceLinks(doc: any, deviceId: string, gaIdToRaw: Map<string, number>) {
  const dev = findDeviceInstance(doc, deviceId);
  const out: { comObjRefId: string; gaRaws: number[] }[] = [];
  for (const c of arr<any>(dev?.ComObjectInstanceRefs?.ComObjectInstanceRef)) {
    if (!c.Links) continue;
    const gaRaws = String(c.Links).split(/\s+/).map((l) => gaIdToRaw.get(l)).filter((x): x is number => x !== undefined);
    if (gaRaws.length) out.push({ comObjRefId: String(c.RefId), gaRaws });
  }
  return out;
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

function parseTopology(topo: any, productNames: Map<string, string>): Topology {
  const areas: TopologyArea[] = [];
  for (const area of arr<any>(topo?.Area)) {
    const lines = arr<any>(area.Line).map((line) => {
      // Devices may sit directly under Line or under a Segment (ETS6).
      const devNodes = [...arr<any>(line.DeviceInstance), ...arr<any>(line.Segment).flatMap((s: any) => arr<any>(s.DeviceInstance))];
      const devices: Device[] = devNodes.map((d) => ({
        id: String(d.Id ?? ""),
        ia: `${Number(area.Address)}.${Number(line.Address)}.${Number(d.Address)}`,
        // ETS falls back to the catalogue product name when a device has no
        // user-given instance name.
        name: String(d.Name || productNames.get(String(d.ProductRefId ?? "")) || ""),
        productRef: String(d.ProductRefId ?? ""),
        appRef: String(d.Hardware2ProgramRefId ?? ""),
        manufacturer: manufacturerOf(String(d.ProductRefId ?? "")),
        comment: [d.Comment, d.Description].map((x) => String(x ?? "").trim()).filter(Boolean).join(" "),
      }));
      return { address: Number(line.Address), name: String(line.Name ?? ""), devices };
    });
    areas.push({ address: Number(area.Address), name: String(area.Name ?? ""), lines });
  }
  return { areas };
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
    id: String(r.Id ?? ""),
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
