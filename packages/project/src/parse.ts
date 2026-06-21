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

export function parseProject(xml0: string, projectXml: string | undefined, fallbackName: string): Project {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const doc = p.parse(xml0);

  const installation = firstByKey(doc, "Installation");
  const topology = parseTopology(installation?.Topology);
  const devices = topology.areas.flatMap((a) => a.lines.flatMap((l) => l.devices));
  const { groupRanges, groupAddresses } = parseGroupAddresses(installation?.GroupAddresses);
  const deviceParams = devices.map((d) => ({ deviceId: d.id, values: parseDeviceParams(doc, d.id) }));
  const deviceModules = devices.map((d) => ({ deviceId: d.id, instances: parseDeviceModules(doc, d.id) }));

  return { name: parseName(projectXml, installation, fallbackName), topology, devices, groupRanges, groupAddresses, deviceParams, deviceModules };
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

function parseTopology(topo: any): Topology {
  const areas: TopologyArea[] = [];
  for (const area of arr<any>(topo?.Area)) {
    const lines = arr<any>(area.Line).map((line) => {
      // Devices may sit directly under Line or under a Segment (ETS6).
      const devNodes = [...arr<any>(line.DeviceInstance), ...arr<any>(line.Segment).flatMap((s: any) => arr<any>(s.DeviceInstance))];
      const devices: Device[] = devNodes.map((d) => ({
        id: String(d.Id ?? ""),
        ia: `${Number(area.Address)}.${Number(line.Address)}.${Number(d.Address)}`,
        name: String(d.Name ?? ""),
        productRef: String(d.ProductRefId ?? ""),
        appRef: String(d.Hardware2ProgramRefId ?? ""),
        manufacturer: manufacturerOf(String(d.ProductRefId ?? "")),
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
