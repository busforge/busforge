// The model of a simulated unit (tools/sim-unit.ts), from a read-only collection of a real unit of the product
// (tools/collect.ts) and the product's application program. The collection gives what the product data does
// not: the unit's serial, order info, hardware type (object 0 PID 78), descriptions, where it places its
// segments and what they hold. The product is checked against it: its mask and its declared property compares
// must agree with what the unit answered, or the model is refused rather than a unit built that no real one is.
import { crc16Ccitt, crc16CcittFalse, iaToNum, type PropertyDescription } from "../packages/knx/src/index.ts";
import { parseAppConfig, parseLoadProcedures, declaredPropChecks, type CollectPackage } from "../packages/product/src/index.ts";
import type { SimProperty, SimUnitModel } from "./sim-unit.ts";

// What the collection cannot show and the unit's captures do: how it takes a restart and an authorization, and
// how long its interface took to confirm a frame.
export type UnitBehaviour = Pick<SimUnitModel, "restart" | "authorize" | "link">;

// The fields of a record's target the model reads.
type Target = { object?: number; pid?: number; start?: number; count?: number; address?: number; type?: number };
const LSMS = [1, 2, 3, 4];
const PID_DEVICE_CONTROL = 14;

// What every simulated unit takes from its collection, whatever its mask: its mask (the descriptor it answered,
// which must be the application's), the interface objects and properties it answered and their descriptions; the
// application's own pre-flight compares must pass on them. `refuse` throws.
export function collectedUnit(collection: CollectPackage, appXml: string, refuse: (why: string) => never) {
  const cfg = parseAppConfig(appXml);
  if (cfg.mask !== collection.mask) refuse(`the application is for ${cfg.mask}, the collected unit is ${collection.mask}`);
  const records = collection.records.map((r) => ({ ...r, target: r.target as Target }));
  const descriptor = records.find((r) => r.space === "descriptor" && r.outcome === "bytes" && (r.target.type ?? 0) === 0);
  if (!descriptor?.bytes) refuse("the collection holds no device descriptor 0");
  const mask = Buffer.from(descriptor!.bytes!, "hex").readUInt16BE(0);
  if (`MV-${mask.toString(16).padStart(4, "0").toUpperCase()}` !== cfg.mask) refuse(`the unit answered descriptor ${descriptor!.bytes}, the application is for ${cfg.mask}`);

  const objects = new Map<number, Map<number, SimProperty>>();
  const prop = (o: number, pid: number) => {
    const props = objects.get(o) ?? objects.set(o, new Map()).get(o)!;
    return props.get(pid) ?? props.set(pid, { elements: [], countKnown: false }).get(pid)!;
  };
  const descriptions = new Map<number, PropertyDescription[]>();
  const counts = new Map<string, number>();
  for (const r of records) {
    const { object: o, pid, start = 1, count = 1 } = r.target;
    if (r.space === "property-description" && r.outcome === "bytes" && r.description) {
      const list = descriptions.get(r.description.objectIndex) ?? descriptions.set(r.description.objectIndex, []).get(r.description.objectIndex)!;
      if (list.some((d) => d.propertyIndex === r.description!.propertyIndex)) refuse(`object ${r.description.objectIndex} described property index ${r.description.propertyIndex} twice`);
      list.push(r.description);
      continue;
    }
    if (r.space !== "property" || o === undefined || pid === undefined) continue;
    if (r.outcome === "refused") {
      if (start !== 1 || count !== 1) refuse(`the unit refused property ${o}/${pid} from element ${start}, which the model does not hold`);
      prop(o, pid).elements = null;
      continue;
    }
    if (r.outcome !== "bytes" || !r.bytes) continue;
    const bytes = Buffer.from(r.bytes, "hex");
    const p = prop(o, pid);
    if (p.elements === null) refuse(`the unit refused property ${o}/${pid} and answered it`);
    if (start === 0) { counts.set(`${o}/${pid}`, bytes.readUInt16BE(0)); p.countKnown = true; continue; }
    if (bytes.length % count !== 0) refuse(`property ${o}/${pid} answered ${bytes.length} octets for ${count} elements`);
    const size = bytes.length / count;
    for (let i = 0; i < count; i++) {
      const e = bytes.subarray(i * size, (i + 1) * size);
      const had = p.elements![start - 1 + i];
      if (had && !had.equals(e)) refuse(`property ${o}/${pid} element ${start + i} answered ${had.toString("hex")} and ${e.toString("hex")}`);
      p.elements![start - 1 + i] = Buffer.from(e);
    }
  }
  for (const [key, n] of counts) {
    const [o, pid] = key.split("/").map(Number);
    const p = objects.get(o)!.get(pid)!;
    if (p.elements === null) continue;
    // A count the collection did not read every element of leaves the property readable only where it read.
    if (p.elements.length !== n || p.elements.some((e) => e === undefined)) p.countKnown = false;
  }
  for (const props of objects.values()) for (const [pid, p] of props) {
    if (p.elements !== null && p.elements.some((e) => e === undefined)) p.elements = p.elements.slice(0, p.elements.findIndex((e) => e === undefined));
    if (p.elements !== null && p.elements.length === 0) props.delete(pid);
  }

  // The application's own pre-flight compares must pass on the collected unit.
  const proc = parseLoadProcedures(appXml);
  for (const op of ["full", "par"] as const) for (const c of declaredPropChecks(proc, op)) {
    const v = objects.get(c.obj)?.get(c.pid)?.elements?.[0];
    if (!v) refuse(`the application compares property ${c.obj}/${c.pid}, which the collection did not read`);
    const masked = (b: Buffer) => Buffer.from(b.map((x, i) => x & (c.mask?.[i] ?? 0xff)));
    if (v!.length !== c.expect.length || !masked(v!).equals(masked(c.expect))) refuse(`the application expects ${c.expect.toString("hex")} in property ${c.obj}/${c.pid}, the unit holds ${v!.toString("hex")}`);
  }

  if (!objects.get(0)?.get(PID_DEVICE_CONTROL)?.elements?.[0]) refuse("the collection did not read the device control (object 0 PID 14)");
  return { mask, objects, descriptions, records };
}

export function simUnitModel(collection: CollectPackage, appXml: string, behaviour: UnitBehaviour): SimUnitModel {
  const refuse = (why: string): never => { throw new Error(`no simulated unit: ${why}`); };
  if (collection.mask !== "MV-07B0") refuse(`only System B (MV-07B0) is modelled here, not ${collection.mask}`);
  const { mask, objects, descriptions, records } = collectedUnit(collection, appXml, refuse);
  if (collection.maxApdu === null) refuse("the collection holds no maximum APDU length");

  const memory = records.filter((r) => r.space === "memory" && r.outcome === "bytes" && r.target.address !== undefined && r.bytes);
  const segments = new Map<number, { at: number; size: number; bytes: Buffer }>();
  let mcbControl: Buffer | null = null;
  let crc: "ccitt" | "ccitt-false" | null = null;
  for (const lsm of LSMS) {
    const ref = objects.get(lsm)?.get(7)?.elements?.[0];
    const mcb = objects.get(lsm)?.get(27)?.elements;
    if (!ref || !mcb || mcb.length !== 1 || mcb[0].length !== 8) continue;
    const at = ref.readUInt32BE(0), size = mcb[0].readUInt32BE(0);
    const rec = memory.find((r) => r.target.address === at && Buffer.from(r.bytes!, "hex").length === size);
    if (!rec) continue;
    const bytes = Buffer.from(rec.bytes!, "hex");
    const control = mcb[0].subarray(4, 6);
    if (mcbControl && !mcbControl.equals(control)) refuse(`the memory-control blocks report ${mcbControl.toString("hex")} and ${control.toString("hex")} between size and CRC`);
    mcbControl = Buffer.from(control);
    const reported = mcb[0].readUInt16BE(6);
    const conv = reported === crc16CcittFalse(bytes) ? "ccitt-false" : reported === crc16Ccitt(bytes) ? "ccitt" : null;
    if (conv === null) refuse(`the memory-control block of object ${lsm} reports CRC ${reported.toString(16)}, which neither convention gives over the segment collected`);
    if (crc && crc !== conv) refuse(`the memory-control blocks take both CRC conventions`);
    crc = conv;
    segments.set(lsm, { at, size, bytes });
  }
  if (mcbControl === null || crc === null) refuse("the collection holds no segment with its memory-control block");
  return {
    ia: iaToNum(collection.ia), mask, maxApdu: collection.maxApdu!, objects, descriptions, segments, mcbControl: mcbControl!, crc: crc!,
    ...behaviour,
  };
}
