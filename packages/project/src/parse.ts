import { XMLParser } from "fast-xml-parser";
import { formatGa, type Levels } from "@busforge/knx";
import type { Project, Device, Topology, TopologyArea, GroupAddress, GroupRangeNode, SpaceNode, DeviceSecurity, GroupKey, SecureSender } from "./model.ts";

export const arr = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// ─────────────────────────────────────────────────────────────────────────────
// The parsed .knxproj document.
//
// fast-xml-parser returns a schema-less object tree: element names and attribute names land as
// keys on the SAME object, a repeated child is an array and a lone one is not. The shape is ETS's,
// not ours, and it is not worth mirroring in types that would then lie about what a given export
// actually contains. So the document is named for what it is — untyped — and every value taken out
// of it is narrowed at the point of use, by `kids` (elements) and `attr` (attribute text).
//
// This is the difference that matters: with `any`, `d.Adress` (a typo) type-checked and silently
// produced NaN. Here it is `unknown`, and it cannot be used without saying what it is expected to be.
// ─────────────────────────────────────────────────────────────────────────────
export type XmlNode = { readonly [key: string]: unknown };

export const isNode = (v: unknown): v is XmlNode => typeof v === "object" && v !== null && !Array.isArray(v);

// Child elements, normalised over fast-xml-parser's one-vs-many shape. A value that is not an
// element (an attribute's text, an absent child) yields none.
export const kids = (v: unknown): XmlNode[] => (Array.isArray(v) ? v.filter(isNode) : isNode(v) ? [v] : []);

// A singular container element (<ParameterInstanceRefs>), so its children can be reached. Not an
// element -> undefined, and the optional chain that follows yields nothing.
export const node = (v: unknown): XmlNode | undefined => (isNode(v) ? v : undefined);

// An attribute as text. A numeric-looking attribute is typed as a number by the parser, so numbers
// and booleans are accepted; an element where an attribute was expected is not text, and is absent.
export const attr = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

// An attribute as text, or "" — the old `String(x ?? "")`, minus the `[object Object]`.
export const text = (v: unknown): string => attr(v) ?? "";

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

export function parseProject(xml0: string, projectXml: string | undefined, fallbackName: string, productNames: Map<string, string> = new Map(), busInterfaceIndex: ReadonlyMap<string, number> = new Map()): Project {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const doc = p.parse(xml0) as XmlNode;

  const installation = firstByKey(doc, "Installation");
  // Parse project.xml's <ProjectInformation> once; both the name and the group-address
  // style come from it (falling back to the 0.xml Installation).
  const projectInfo = projectXml ? firstByKey(p.parse(projectXml), "ProjectInformation") : undefined;
  const groupAddressLevels = parseGroupAddressLevels(projectInfo, installation);
  const { topology, malformedDevices } = parseTopology(installation?.Topology, productNames);
  const locations = parseLocations(installation?.Locations);
  const devices = topology.areas.flatMap((a) => a.lines.flatMap((l) => l.devices));
  const { groupRanges, groupAddresses, groupKeys } = parseGroupAddresses(installation?.GroupAddresses, groupAddressLevels);
  const deviceParams = devices.map((d) => ({ deviceId: d.id, values: parseDeviceParams(doc, d.id) }));
  const deviceModules = devices.map((d) => ({ deviceId: d.id, instances: parseDeviceModules(doc, d.id) }));
  const gaIdToRaw = new Map<string, number>();
  buildGaIdMap(doc, gaIdToRaw);
  const linkResults = devices.map((d) => ({ deviceId: d.id, ...parseDeviceLinks(doc, d.id, gaIdToRaw) }));
  const deviceLinks = linkResults.map(({ deviceId, links }) => ({ deviceId, links }));
  const unresolvedLinks = linkResults.reduce((n, r) => n + r.unresolved, 0);
  const securities = devices.map((d) => parseDeviceSecurity(doc, d.id));
  const deviceSecurity = securities.filter((x): x is DeviceSecurity => x !== undefined && x !== "noSerial");
  const secureDevicesWithoutSerial = securities.filter((x) => x === "noSerial").length;
  const { secureSenders, unresolvedSenders } = parseSecureSenders(doc, devices, busInterfaceIndex);

  return { name: parseName(projectInfo, installation, fallbackName), groupAddressLevels, topology, locations, devices, groupRanges, groupAddresses, deviceParams, deviceModules, deviceLinks, deviceSecurity, groupKeys, secureSenders, unresolvedSenders, secureDevicesWithoutSerial, unresolvedLinks, malformedDevices };
}

// The project's group-address style, as a level count. ETS stores GroupAddressStyle on
// <ProjectInformation> in Project.xml; some exports also carry it on the 0.xml
// <Installation>. Prefer the former, fall back to the latter, and default to three-level
// (ETS's default and the historical behaviour) when it is absent. "Free" style renders
// three-level here, its default display. Getting this right is what makes a TwoLevel
// project's addresses format as "m/s" instead of a phantom-middle "m/0/s".
function parseGroupAddressLevels(projectInfo: XmlNode | undefined, installation: XmlNode | undefined): Levels {
  const toLevels = (s: unknown): Levels | undefined => {
    // Only a string is a style name. This is not a bug fix: the old String() coercion produced
    // "[object Object]", which matched no branch and fell through to the same undefined. It is the
    // guard being made explicit, so the next reader does not have to work out that the coercion was
    // harmless — and so the three-level default below stays a default, not a coincidence.
    if (typeof s !== "string") return undefined;
    if (s === "TwoLevel") return 2;
    if (s === "ThreeLevel" || s === "Free") return 3;
    return undefined;
  };
  return toLevels(projectInfo?.GroupAddressStyle) ?? toLevels(installation?.GroupAddressStyle) ?? 3;
}

// A device's Data-Secure commissioning secrets, or undefined for a non-secure device.
// The tool key lives in the device's nested <Security ToolKey="..b64.."> element
// (present only once ETS secure-commissioned it); the 6-byte device serial used for the
// Sync request is the DeviceInstance's own SerialNumber attribute. SequenceNumber here is
// the group/data counter, kept for completeness; tool-access programming syncs its own.
//
// ETS generates a tool key as soon as a secure device is added, before it has ever reached the
// device; such a device has no SerialNumber yet, and without one no Sync can be run against it. It
// is reported as "noSerial" (counted by the caller) instead of stored with a key nothing can use.
function parseDeviceSecurity(doc: XmlNode, deviceId: string): DeviceSecurity | "noSerial" | undefined {
  const dev = findDeviceInstance(doc, deviceId);
  const sec = dev?.Security;
  // A non-secure device has no <Security> child; a stray Security="Off" attribute
  // parses to a string, not an object, so the ToolKey lookup safely yields nothing.
  if (!isNode(sec) || sec.ToolKey === undefined) return undefined;
  if (!text(dev?.SerialNumber)) return "noSerial";
  return {
    deviceId,
    toolKey: text(sec.ToolKey),
    serialNumber: text(dev?.SerialNumber),
    sequenceNumber: text(sec.SequenceNumber),
  };
}

// Bus interfaces assigned to group addresses: <BusInterface RefId><Connectors><Connector
// GroupAddressRefId> under a DeviceInstance. The interface's address is the device's own at
// AddressIndex 0, otherwise its AdditionalAddresses entry at AddressIndex (1-based, in document
// order, as ETS 6.4.1 lists a router's tunnelling channels). AddressIndex is declared by the
// application program, so an interface whose program is not at hand is counted, not guessed.
function parseSecureSenders(doc: XmlNode, devices: Device[], busInterfaceIndex: ReadonlyMap<string, number>): { secureSenders: SecureSender[]; unresolvedSenders: number } {
  const gaIdToRaw = new Map<string, number>();
  buildGaIdMap(doc, gaIdToRaw);
  const secureSenders: SecureSender[] = [];
  let unresolvedSenders = 0;
  for (const d of devices) {
    const dev = findDeviceInstance(doc, d.id);
    const extra = kids(node(dev?.AdditionalAddresses)?.Address).map((a) => Number(attr(a.Address)));
    const [area, line] = d.ia.split(".");
    for (const bi of kids(node(dev?.BusInterfaces)?.BusInterface)) {
      const refId = text(bi.RefId);
      for (const c of kids(node(bi.Connectors)?.Connector)) {
        const gaRaw = gaIdToRaw.get(text(c.GroupAddressRefId).split("_").pop()!);
        const index = busInterfaceIndex.get(refId);
        const address = index === 0 ? Number(d.ia.split(".")[2]) : index !== undefined ? extra.at(index - 1) : undefined;
        if (gaRaw === undefined || address === undefined || !Number.isInteger(address)) { unresolvedSenders++; continue; }
        secureSenders.push({ gaRaw, ia: `${area}.${line}.${address}`, deviceId: d.id, busInterfaceRefId: refId });
      }
    }
  }
  return { secureSenders, unresolvedSenders };
}

// Map the prefix-stripped GroupAddress id ("GA-189") to its 16-bit address, so
// com-object links ("Links=GA-189 GA-190") can be resolved.
//
// The walk MUST descend into arrays. fast-xml-parser makes a repeated element an array (two
// <Line>s, two <GroupRange>s, two <Area>s), so an array sits on the path to most of this document,
// and a walker that stops at one finds nothing below it — every device would import with no
// parameters and no links, and report zero of both, which is indistinguishable from a device that
// genuinely has none.
function buildGaIdMap(node: unknown, out: Map<string, number>) {
  if (Array.isArray(node)) { for (const e of node) buildGaIdMap(e, out); return; }
  if (!isNode(node)) return;
  for (const g of kids(node.GroupAddress)) {
    const id = attr(g.Id);
    if (id === undefined) continue; // no id: nothing a link could ever name
    out.set(id.split("_").pop()!, Number(attr(g.Address)));
  }
  for (const k of Object.keys(node)) buildGaIdMap(node[k], out);
}

// A device's com-object -> GA links (ComObjectInstanceRef RefId + resolved GAs).
// Also counts link tokens that did NOT resolve to a group address in the tree: those
// are real assignments we silently lose, so the caller can surface the count instead
// of pretending every link imported.
function parseDeviceLinks(doc: XmlNode, deviceId: string, gaIdToRaw: Map<string, number>): { links: { comObjRefId: string; gaRaws: number[] }[]; unresolved: number } {
  const dev = findDeviceInstance(doc, deviceId);
  // Merge by RefId: two ComObjectInstanceRefs on one device can share a RefId (synthetic
  // module-instance ids, or a malformed export). Stored per (refId, slot), two separate
  // rows would collide on the slot index and abort the whole import. Merging their GAs
  // keeps the assignments and never crashes; for the normal (unique-RefId) case it is a
  // no-op that preserves document order.
  const byRef = new Map<string, number[]>();
  let unresolved = 0;
  for (const c of kids(node(dev?.ComObjectInstanceRefs)?.ComObjectInstanceRef)) {
    const links = attr(c.Links);
    if (!links) continue;
    const tokens = links.split(/\s+/).filter(Boolean);
    const gaRaws = tokens.map((l) => gaIdToRaw.get(l)).filter((x): x is number => x !== undefined);
    unresolved += tokens.length - gaRaws.length;
    if (!gaRaws.length) continue;
    const existing = byRef.get(text(c.RefId));
    if (existing) existing.push(...gaRaws);
    else byRef.set(text(c.RefId), gaRaws);
  }
  return { links: [...byRef].map(([comObjRefId, gaRaws]) => ({ comObjRefId, gaRaws })), unresolved };
}

// Collect a device's stored parameter values (ParameterRef id -> value).
function parseDeviceParams(doc: XmlNode, deviceId: string): { refId: string; value: string }[] {
  const dev = findDeviceInstance(doc, deviceId);
  const out: { refId: string; value: string }[] = [];
  for (const r of kids(node(dev?.ParameterInstanceRefs)?.ParameterInstanceRef)) {
    if (r.Value !== undefined) out.push({ refId: text(r.RefId), value: text(r.Value) });
  }
  return out;
}

// Collect a device's module instances with their resolved argument values.
function parseDeviceModules(doc: XmlNode, deviceId: string) {
  const dev = findDeviceInstance(doc, deviceId);
  return kids(node(dev?.ModuleInstances)?.ModuleInstance).map((mi) => ({
    id: text(mi.Id),
    refId: text(mi.RefId),
    args: kids(node(mi.Arguments)?.Argument).filter((a) => a.Value !== undefined).map((a) => ({ refId: text(a.RefId), value: text(a.Value) })),
  }));
}

// A single device's stored parameter values (ParameterRef id -> value) and its
// application ref, straight from a raw decrypted 0.xml. The full parseProject builds
// every device; the hardware read-back harnesses work one device at a time and only
// need this. Throws on an unknown id rather than returning a misleading empty map.
export function deviceParamValues(xml0: string, deviceId: string): { appRef: string; values: Map<string, string> } {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const dev = findDeviceInstance(p.parse(xml0) as XmlNode, deviceId);
  if (!dev) throw new Error(`device ${deviceId} not found`);
  const values = new Map<string, string>();
  for (const r of kids(node(dev.ParameterInstanceRefs)?.ParameterInstanceRef)) if (r.Value !== undefined) values.set(text(r.RefId), text(r.Value));
  return { appRef: text(dev.Hardware2ProgramRefId), values };
}

// Descends into arrays: see buildGaIdMap. A project with two lines puts an array between the
// installation and every device in it, and a walker that stops there finds no device at all.
function findDeviceInstance(n: unknown, id: string): XmlNode | undefined {
  if (Array.isArray(n)) { for (const e of n) { const r = findDeviceInstance(e, id); if (r) return r; } return undefined; }
  if (!isNode(n)) return undefined;
  for (const d of kids(n.DeviceInstance)) if (d.Id === id) return d;
  for (const k of Object.keys(n)) { const r = findDeviceInstance(n[k], id); if (r) return r; }
  return undefined;
}

function parseName(projectInfo: XmlNode | undefined, installation: XmlNode | undefined, fallbackName: string): string {
  return attr(projectInfo?.Name) || attr(installation?.Name) || fallbackName;
}

function parseTopology(topo: unknown, productNames: Map<string, string>): { topology: Topology; malformedDevices: number } {
  const areas: TopologyArea[] = [];
  let malformedDevices = 0;
  for (const area of kids(node(topo)?.Area)) {
    const lines = kids(area.Line).map((line) => {
      // Devices may sit directly under Line or under a Segment (ETS6).
      const devNodes = [...kids(line.DeviceInstance), ...kids(line.Segment).flatMap((s) => kids(s.DeviceInstance))];
      const devices: Device[] = [];
      for (const d of devNodes) {
        const id = text(d.Id);
        const ia = `${Number(attr(area.Address))}.${Number(attr(line.Address))}.${Number(attr(d.Address))}`;
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
          name: attr(d.Name) || productNames.get(text(d.ProductRefId)) || "",
          productRef: text(d.ProductRefId),
          appRef: text(d.Hardware2ProgramRefId),
          manufacturer: manufacturerOf(text(d.ProductRefId)),
          comment: [d.Comment, d.Description].map((x) => text(x).trim()).filter(Boolean).join(" "),
          applicationProgramLoaded: text(d.ApplicationProgramLoaded) === "true",
        });
      }
      return { address: Number(attr(line.Address)), name: text(line.Name), devices };
    });
    areas.push({ address: Number(attr(area.Address)), name: text(area.Name), lines });
  }
  return { topology: { areas }, malformedDevices };
}

// The building structure: <Locations> holds a tree of <Space> elements (ETS6),
// each carrying its Type (Building/Floor/Room/...), Name and the device instances
// placed directly in it. Nesting is arbitrary depth. Absent in older/structureless
// exports, in which case this returns an empty array.
function parseLocations(loc: unknown): SpaceNode[] {
  const toSpace = (s: XmlNode): SpaceNode => ({
    id: "", // not addressable until stored (the DB assigns the row id); source id is extId
    extId: text(s.Id),
    type: text(s.Type),
    name: text(s.Name),
    deviceIds: kids(s.DeviceInstanceRef).map((r) => text(r.RefId)).filter(Boolean),
    children: kids(s.Space).map(toSpace),
  });
  return kids(node(loc)?.Space).map(toSpace);
}

// A secured group address carries its key in the Key attribute (plain inside the password-protected
// archive, like a device's ToolKey). It is kept apart from the GroupAddress model so the key never
// travels with the address to a client.
function parseGroupAddresses(gas: unknown, levels: Levels): { groupRanges: GroupRangeNode[]; groupAddresses: GroupAddress[]; groupKeys: GroupKey[] } {
  const flat: GroupAddress[] = [];
  const groupKeys: GroupKey[] = [];
  const toGa = (g: XmlNode): GroupAddress => {
    const raw = Number(attr(g.Address));
    const ga: GroupAddress = { address: formatGa(raw, levels), raw, name: text(g.Name), dpt: dptDisplay(attr(g.DatapointType)) };
    flat.push(ga);
    const key = attr(g.Key);
    if (key !== undefined) groupKeys.push({ raw, key });
    return ga;
  };
  const toRange = (r: XmlNode): GroupRangeNode => ({
    id: "", // not addressable until stored (the DB assigns the row id); the XML id is discarded
    name: text(r.Name),
    rangeStart: Number(attr(r.RangeStart) ?? 0),
    rangeEnd: Number(attr(r.RangeEnd) ?? 0),
    children: kids(r.GroupRange).map(toRange),
    addresses: kids(r.GroupAddress).map(toGa),
  });
  const groupRanges = kids(node(node(gas)?.GroupRanges)?.GroupRange).map(toRange);
  return { groupRanges, groupAddresses: flat, groupKeys };
}

// Descends into arrays: see buildGaIdMap.
function firstByKey(n: unknown, key: string): XmlNode | undefined {
  if (Array.isArray(n)) { for (const e of n) { const r = firstByKey(e, key); if (r) return r; } return undefined; }
  if (!isNode(n)) return undefined;
  if (n[key] !== undefined) { const hit = kids(n[key])[0]; if (hit) return hit; }
  for (const k of Object.keys(n)) { const r = firstByKey(n[k], key); if (r) return r; }
  return undefined;
}
