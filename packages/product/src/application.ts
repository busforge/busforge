import { XMLParser } from "fast-xml-parser";

// Parse a KNX ApplicationProgram (.knxprod manufacturer XML) into the model needed
// to build a parameter memory image: parameter types (sizes), parameters (with
// memory location), parameter refs, and the default parameter segment.

// `base` is the parameter's value kind, needed to pick the right memory codec:
// "Float" is a KNX 2-byte float (DPT 9), the integer write/read is wrong for it.
export type ParamBase = "Value" | "Number" | "Float" | "Text" | "Time" | "Other";
export interface ParamType { id: string; base: ParamBase; sizeInBit: number; signed: boolean; }
export interface Param { id: string; typeId: string; value?: string; codeSegment?: string; offset?: number; bitOffset: number; }
export interface ParamRef { id: string; paramId: string; value?: string; }
export interface Segment { id: string; lsm: number; size: number; data: Buffer; }
export interface AppModel {
  mask: string; manufacturer: number; appNumber: number; version: number;
  types: Map<string, ParamType>;
  params: Map<string, Param>;
  refs: Map<string, ParamRef>;
  segments: Segment[];
}

const arr = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const hex = (s: string) => parseInt(s, 16);

export function parseApplication(xml: string): AppModel {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: () => false });
  const doc = p.parse(xml);
  // find the ApplicationProgram node (under KNX > ManufacturerData > Manufacturer > Applications)
  const ap = findFirst(doc, "ApplicationProgram");
  if (!ap) throw new Error("no ApplicationProgram");
  const idParts = String(ap.Id).split("_"); // M-0162_A-0004-11-F245
  const manufacturer = hex(idParts[0].replace("M-", ""));
  const appNumber = Number(ap.ApplicationNumber);
  const version = Number(ap.ApplicationVersion);
  const mask = String(ap.MaskVersion);
  const st = ap.Static ?? {};

  const types = new Map<string, ParamType>();
  for (const t of arr<any>(st.ParameterTypes?.ParameterType)) {
    const base: ParamBase = t.TypeFloat ? "Float" : t.TypeNumber ? "Number" : t.TypeText ? "Text"
      : t.TypeTime ? "Time" : t.TypeRestriction ? "Value" : "Other";
    const tr = t.TypeRestriction ?? t.TypeNumber ?? t.TypeText ?? t.TypeFloat ?? t.TypeTime ?? {};
    // A DPT-9 float is 16 bits; the manufacturer XML may omit SizeInBit on TypeFloat.
    const sizeInBit = Number(tr.SizeInBit ?? (base === "Float" ? 16 : 0));
    const signed = String(t.TypeNumber?.Type ?? tr.Type ?? "").toLowerCase().includes("signed");
    types.set(t.Id, { id: t.Id, base, sizeInBit, signed });
  }

  const params = new Map<string, Param>();
  for (const pa of arr<any>(st.Parameters?.Parameter)) {
    const mem = pa.Memory;
    params.set(pa.Id, {
      id: pa.Id, typeId: pa.ParameterType, value: pa.Value,
      codeSegment: mem?.CodeSegment, offset: mem ? Number(mem.Offset) : undefined,
      bitOffset: mem ? Number(mem.BitOffset ?? 0) : 0,
    });
  }

  const refs = new Map<string, ParamRef>();
  for (const r of arr<any>(st.ParameterRefs?.ParameterRef)) {
    refs.set(r.Id, { id: r.Id, paramId: r.RefId, value: r.Value });
  }

  const segments: Segment[] = [];
  for (const s of arr<any>(st.Code?.RelativeSegment)) {
    segments.push({ id: s.Id, lsm: Number(s.LoadStateMachine), size: Number(s.Size), data: Buffer.from(String(s.Data ?? ""), "base64") });
  }

  return { mask, manufacturer, appNumber, version, types, params, refs, segments };
}

function findFirst(node: any, key: string): any {
  if (node == null || typeof node !== "object") return undefined;
  if (node[key]) return Array.isArray(node[key]) ? node[key][0] : node[key];
  for (const k of Object.keys(node)) { const r = findFirst(node[k], key); if (r) return r; }
  return undefined;
}
