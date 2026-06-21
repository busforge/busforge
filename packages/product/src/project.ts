import { XMLParser } from "fast-xml-parser";

// Extract a device's parameter instance values (ParameterRef id -> value) and its
// application id from a decrypted ETS project 0.xml.
export function deviceParamValues(xml0: string, deviceId: string): { appRef: string; values: Map<string, string> } {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const doc = p.parse(xml0);
  const dev = findDevice(doc, deviceId);
  if (!dev) throw new Error(`device ${deviceId} not found`);
  const values = new Map<string, string>();
  const pis = dev.ParameterInstanceRefs?.ParameterInstanceRef;
  for (const r of pis ? (Array.isArray(pis) ? pis : [pis]) : []) if (r.Value !== undefined) values.set(r.RefId, String(r.Value));
  return { appRef: String(dev.Hardware2ProgramRefId ?? ""), values };
}

function findDevice(node: any, id: string): any {
  if (node == null || typeof node !== "object") return undefined;
  if (node.DeviceInstance) for (const d of (Array.isArray(node.DeviceInstance) ? node.DeviceInstance : [node.DeviceInstance])) if (d.Id === id) return d;
  for (const k of Object.keys(node)) { const r = findDevice(node[k], id); if (r) return r; }
  return undefined;
}
