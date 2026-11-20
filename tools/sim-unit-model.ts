// The model of a simulated unit (tools/sim-unit.ts), from a read-only collection of a real unit of the product
// (tools/collect.ts) and the product's application program. The collection gives what the product data does
// not: the unit's serial, order info, hardware type (object 0 PID 78), descriptions, where it places its
// segments and what they hold. The product is checked against it: its mask and its declared property compares
// must agree with what the unit answered, or the model is refused rather than a unit built that no real one is.
import { declaredPropMatches, iaToNum, type PropertyDescription } from "../packages/knx/src/index.ts";
import { parseAppConfig, parseLoadProcedures, declaredPropChecks, type CollectPackage } from "../packages/product/src/index.ts";
import { crcConventionOf, type SimProperty, type SimUnitCoreModel, type SimUnitModel } from "./sim-unit.ts";

// What the collection cannot show and the unit's captures do, whatever its mask: how it takes a restart and an
// authorization, how long its interface took to confirm a frame, its description answers by PID, the property
// writes only they show answered, whether it takes A_MemoryExtended_Write, its programming mode and the rest of
// its answer to a serial-number read.
export type UnitBehaviour = Pick<SimUnitCoreModel, "restart" | "authorize" | "link" | "descriptionIndex" | "shownWrites" | "memoryExtendedWrite" | "programmingMode" | "serialNumberResponseTail">;

// A captured state where the collection was taken in a later one: the answers the unit's captures show where they
// differ from the collection, a property's first element (`<object>/<PID>` -> hex) and a function-property state
// (the `functionStates` key -> hex); each must be one the collection holds.
export interface StateInCaptures { properties: Record<string, string>; functionStates: Record<string, string> }

// What a System B unit's captures show besides: its device control after an unload, what its application changes
// in its memory after a restart, and, for a unit whose memory-control blocks held no element when it was
// collected, what they report once a load completes (`mcb`, the two octets between size and CRC as hex, and the
// CRC's convention).
export type SystemBBehaviour = UnitBehaviour & Pick<SimUnitModel, "unloadStopsApplication" | "clearsAfterRestart">
  & { mcb?: { control: string; crc: SimUnitModel["crc"] }; stateInCaptures?: StateInCaptures };

// The fields of a record's target the model reads.
export type Target = { object?: number; pid?: number; start?: number; count?: number; address?: number; type?: number };
const LSMS = [1, 2, 3, 4];
const PID_DEVICE_CONTROL = 14;

// What every simulated unit takes from its collection, whatever its mask: its mask (the descriptor it answered,
// which must be the application's), the interface objects and properties it answered and their descriptions, its
// function-property states, whether it answered A_MemoryExtended_Read; with `stateInCaptures` where its captures
// found it otherwise. The application's own pre-flight compares must pass on them. `refuse` throws.
export function collectedUnit(collection: CollectPackage, appXml: string, refuse: (why: string) => never, stateInCaptures?: StateInCaptures) {
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
  const functionStates = new Map<string, Buffer>();
  // A property one of whose answers does not divide into its elements (the GVS AMMA's manufacturer property
  // 0/223: 13 octets for 4), or that the unit refused past its first element, is not held: its elements stay
  // unknown, and a read of it is refused.
  const unheld = new Set(records.filter((r) => r.space === "property" && (
    (r.outcome === "bytes" && r.bytes && (r.target.start ?? 1) !== 0 && (r.bytes.length / 2) % (r.target.count ?? 1) !== 0)
    || (r.outcome === "refused" && ((r.target.start ?? 1) !== 1 || (r.target.count ?? 1) !== 1)))).map((r) => `${r.target.object}/${r.target.pid}`));
  for (const r of records) {
    const { object: o, pid, start = 1, count = 1 } = r.target;
    if (r.space === "property-description" && r.outcome === "bytes" && r.description) {
      const list = descriptions.get(r.description.objectIndex) ?? descriptions.set(r.description.objectIndex, []).get(r.description.objectIndex)!;
      if (list.some((d) => d.propertyIndex === r.description!.propertyIndex)) refuse(`object ${r.description.objectIndex} described property index ${r.description.propertyIndex} twice`);
      list.push(r.description);
      continue;
    }
    if (r.space === "function-property" && r.outcome === "bytes" && r.bytes) {
      const t = r.target as { objectType?: number; instance?: number; pid?: number };
      // tools/collect.ts reads the security mode with the data 00 00 (packages/product/src/collect.ts); another
      // function-property read's data the record does not hold.
      if (r.step !== "security-mode") continue;
      functionStates.set(`${t.objectType}/${t.instance}/${t.pid} 0000`, Buffer.from(r.bytes, "hex"));
      continue;
    }
    if (r.space !== "property" || o === undefined || pid === undefined || unheld.has(`${o}/${pid}`)) continue;
    if (r.outcome === "refused") {
      prop(o, pid).elements = null;
      continue;
    }
    if (r.outcome !== "bytes" || !r.bytes) continue;
    const bytes = Buffer.from(r.bytes, "hex");
    const p = prop(o, pid);
    if (p.elements === null) refuse(`the unit refused property ${o}/${pid} and answered it`);
    if (start === 0) { counts.set(`${o}/${pid}`, bytes.readUInt16BE(0)); p.countKnown = true; continue; }
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
    if (p.elements !== null && p.elements.length === 0 && !p.countKnown) props.delete(pid);
  }

  for (const [key, hex] of Object.entries(stateInCaptures?.properties ?? {})) {
    const [o, pid] = key.split("/").map(Number);
    const p = objects.get(o)?.get(pid);
    // An empty answer: the unit answers the property's first element with none, as where it refused it.
    if (hex === "" && p) { p.elements = null; p.countKnown = false; continue; }
    if (!p?.elements?.[0] || p.elements[0].length !== hex.length / 2) refuse(`the captures' answer ${hex} for property ${key}, which the collection does not hold in that form`);
    p!.elements![0] = Buffer.from(hex, "hex");
  }
  for (const [key, hex] of Object.entries(stateInCaptures?.functionStates ?? {})) {
    if (!functionStates.has(key)) refuse(`the captures' answer ${hex} for function property ${key}, which the collection does not hold`);
    functionStates.set(key, Buffer.from(hex, "hex"));
  }

  // The application's own pre-flight compares must pass on the collected unit.
  const proc = parseLoadProcedures(appXml);
  for (const op of ["full", "par"] as const) for (const c of declaredPropChecks(proc, op)) {
    const v = objects.get(c.obj)?.get(c.pid)?.elements?.[0];
    if (!v) refuse(`the application compares property ${c.obj}/${c.pid}, which the collection did not read`);
    if (!declaredPropMatches(v!, c.expect, c.mask)) refuse(`the application expects ${c.expect.toString("hex")} in property ${c.obj}/${c.pid}, the unit holds ${v!.toString("hex")}`);
  }

  if (!objects.get(0)?.get(PID_DEVICE_CONTROL)?.elements?.[0]) refuse("the collection did not read the device control (object 0 PID 14)");
  const memoryExtendedRead = records.some((r) => r.space === "memory-extended" && r.outcome === "bytes");
  return { mask, objects, descriptions, functionStates, memoryExtendedRead, records };
}

export function simUnitModel(collection: CollectPackage, appXml: string, behaviour: SystemBBehaviour): SimUnitModel {
  const refuse = (why: string): never => { throw new Error(`no simulated unit: ${why}`); };
  if (collection.mask !== "MV-07B0") refuse(`only System B (MV-07B0) is modelled here, not ${collection.mask}`);
  const { mask, objects, descriptions, functionStates, memoryExtendedRead, records } = collectedUnit(collection, appXml, refuse, behaviour.stateInCaptures);
  if (collection.maxApdu === null) refuse("the collection holds no maximum APDU length");

  const memory = records.filter((r) => (r.space === "memory" || r.space === "memory-extended") && r.outcome === "bytes" && r.target.address !== undefined && r.bytes);
  const segments: SimUnitModel["segments"] = new Map();
  let crc: SimUnitModel["crc"] | null = null;
  const { mcb: emptyMcb, stateInCaptures: _, ...unitBehaviour } = behaviour;
  for (const lsm of LSMS) {
    const ref = objects.get(lsm)?.get(7)?.elements?.[0];
    const mcbProp = objects.get(lsm)?.get(27);
    const mcb = mcbProp?.elements;
    // A memory-control block without elements: the segment's place is known, nothing of what it holds.
    if (ref && ref.readUInt32BE(0) !== 0 && mcbProp?.countKnown && mcb?.length === 0) {
      if (!emptyMcb) refuse(`the memory-control block of object ${lsm} held no element; what it reports after a load is not given`);
      segments.set(lsm, { at: ref.readUInt32BE(0), size: 0, bytes: Buffer.alloc(0), mcbControl: Buffer.from(emptyMcb!.control, "hex") });
      continue;
    }
    // The segment as the blocks of its memory-control block cut it, from its start.
    if (!ref || !mcb || mcb.length === 0 || mcb.some((e) => e.length !== 8) || !mcbProp.countKnown) continue;
    const at = ref.readUInt32BE(0), size = mcb.reduce((n, e) => n + e.readUInt32BE(0), 0);
    const rec = memory.find((r) => r.target.address === at && Buffer.from(r.bytes!, "hex").length === size);
    if (!rec) continue;
    const bytes = Buffer.from(rec.bytes!, "hex");
    let from = 0;
    for (const e of mcb) {
      const block = bytes.subarray(from, from += e.readUInt32BE(0)), reported = e.readUInt16BE(6);
      const conv = crcConventionOf(reported, block);
      if (conv === null) refuse(`the memory-control block of object ${lsm} reports CRC ${reported.toString(16)}, which neither convention gives over the block collected`);
      if (crc && crc !== conv) refuse(`the memory-control blocks take both CRC conventions`);
      crc = conv;
    }
    segments.set(lsm, { at, size, bytes, mcbControl: mcb.length === 1 ? Buffer.from(mcb[0].subarray(4, 6)) : null });
  }
  if (emptyMcb && ![...segments.values()].some((s) => s.size === 0)) refuse("the behaviour gives what empty memory-control blocks report, and the unit held none");
  if (emptyMcb && crc && emptyMcb.crc !== crc) refuse(`the memory-control blocks collected take CRC ${crc}, the behaviour gives ${emptyMcb.crc}`);
  crc ??= emptyMcb?.crc ?? null;
  if (crc === null) refuse("the collection holds no segment with its memory-control block");
  return {
    ia: iaToNum(collection.ia), mask, maxApdu: collection.maxApdu!, objects, descriptions, functionStates, memoryExtendedRead, segments, crc: crc!,
    ...unitBehaviour,
  };
}
