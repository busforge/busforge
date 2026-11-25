// A simulated unit's identity from its product alone, for a catalogue row of the ETS sweep that has no collection of a
// real unit (decision 0004 §1, "Identity"), and the identity loop: ETS refuses a unit whose identity does not fit the
// product ("inkompatible Produktdaten") and names in its ETS6.log what it required, the sweep runs again with that.
//
// The mask is the application's; every property value carries its source: the product (its manufacturer, what its
// LdCtrlCompareProp steps expect, bit by bit where a compare masks) or an ETS6.log line. Nothing else is taken:
// what neither gives (the serial, the order info, the version, the device control, descriptions, where the unit
// places its segments) the product unit does not hold, and `productAgainstUnit` lists it against a collected unit.
import { assessParStep, declaredPropChecks, flattenSteps, maskInfo, parseAppConfig } from "../packages/product/src/index.ts";
import type { collectedUnit } from "./sim-unit-model.ts";

export type IdentitySource = { from: "product"; what: string } | { from: "ets6log"; line: string };

// A property's first element as far as it is given: `known` holds a 1 for every bit a source gives.
export interface IdentityValue { bytes: Buffer; known: Buffer; sources: IdentitySource[] }

export interface ProductUnit {
  application: string;
  // The device descriptor 0 the unit answers: the application's mask.
  mask: number;
  // `<object>/<PID>` -> the property's first element as far as the product (and ETS's log) give it.
  properties: Map<string, IdentityValue>;
}

const PID_MANUFACTURER = 12;
// Load-procedure steps that would decide the identity and are not modelled: a memory compare, and a choice
// between steps by the parameters.
const UNMODELLED_IDENTITY_STEPS = ["LdCtrlCompareMem", "choose"];
const COMPARE_ATTRIBUTES = ["ObjIdx", "PropId", "StartElement", "InlineData", "Mask", "AppliesTo"];

const hex = (b: Buffer) => b.toString("hex");
const keyOf = (object: number, pid: number) => `${object}/${pid}`;

// `value` given as far as `known` says, put over what `into` already holds; refused where a known bit differs.
function merge(into: IdentityValue | undefined, value: Buffer, known: Buffer, source: IdentitySource, refuse: (why: string) => never): IdentityValue {
  const length = Math.max(into?.bytes.length ?? 0, value.length);
  const bytes = Buffer.alloc(length), mask = Buffer.alloc(length);
  into?.bytes.copy(bytes); into?.known.copy(mask);
  for (let i = 0; i < value.length; i++) {
    const at = i, both = mask[at] & known[i];
    if ((bytes[at] & both) !== (value[i] & both)) refuse(`octet ${at} is ${bytes[at].toString(16).padStart(2, "0")} under mask ${both.toString(16).padStart(2, "0")} by ${describe(into!.sources)}, ${describe([source])} gives ${value[i].toString(16).padStart(2, "0")}`);
    bytes[at] = (bytes[at] & ~known[i]) | (value[i] & known[i]);
    mask[at] |= known[i];
  }
  return { bytes, known: mask, sources: [...(into?.sources ?? []), source] };
}

const describe = (sources: IdentitySource[]) => sources.map((s) => s.from === "product" ? s.what : `ETS6.log "${s.line}"`).join(", ");

// The unit as the application program alone gives it (`cfg`: the program parsed, where the caller has it). Refused
// where the application's identity steps are not modelled or contradict each other.
export function productUnit(appXml: string, cfg: ReturnType<typeof parseAppConfig> = parseAppConfig(appXml)): ProductUnit {
  const refuse = (why: string): never => { throw new Error(`no product unit: ${why}`); };
  // Only System B and System 7 keep their identity in a device object's properties (a BCU1 has none).
  const mask = maskInfo(cfg.mask);
  if (mask.family !== "system-b" && mask.family !== "system-7") refuse(`the application's mask ${cfg.mask} is of family ${mask.family}, whose identity is not modelled`);
  const proc = cfg.loadProcedures;
  const unmodelled = UNMODELLED_IDENTITY_STEPS.filter((v) => proc.verbs.includes(v));
  if (unmodelled.length) refuse(`its load procedure holds ${unmodelled.join(", ")}, whose expectation is not modelled`);
  // A compare is taken as declaredPropChecks reads it only where that is all it says: on the first element, and
  // with a mask that is one (declaredPropChecks compares every octet where it is not, which gives no known bit).
  for (const s of [...flattenSteps(proc, "full"), ...flattenSteps(proc, "par")].filter((s) => s.verb === "LdCtrlCompareProp")) {
    const how = assessParStep(s, "relative");
    if (how.kind === "blocked") refuse(how.detail);
    if (s.attrs.Mask !== undefined && !/^([0-9A-Fa-f]{2})+$/.test(s.attrs.Mask)) refuse(`an LdCtrlCompareProp masks with ${JSON.stringify(s.attrs.Mask)}, which is no mask`);
    const other = Object.keys(s.attrs).filter((k) => !COMPARE_ATTRIBUTES.includes(k));
    if (other.length) refuse(`an LdCtrlCompareProp declares ${other.join(", ")}, which is not modelled`);
  }

  const properties = new Map<string, IdentityValue>();
  const set = (object: number, pid: number, value: Buffer, known: Buffer, source: IdentitySource) => {
    const key = keyOf(object, pid);
    properties.set(key, merge(properties.get(key), value, known, source, (why) => refuse(`property ${key}: ${why}`)));
  };
  // The manufacturer the application is registered under. An application made for another (OriginalManufacturer)
  // names it besides; the unit answers its own all the same on the Jung 400021SE, the Gira Tastsensor 3 and the
  // Theben DALI-Gateway (their collections), so it is taken as the source names it.
  const manufacturer = /^M-([0-9A-F]{4})_/.exec(cfg.id);
  if (!manufacturer) refuse(`the application id ${cfg.id} names no manufacturer`);
  const original = proc.originalManufacturer && proc.originalManufacturer !== `M-${manufacturer![1]}` ? `, made for ${proc.originalManufacturer}` : "";
  set(0, PID_MANUFACTURER, Buffer.from(manufacturer![1], "hex"), Buffer.from("ffff", "hex"), { from: "product", what: `the application's manufacturer M-${manufacturer![1]}${original}` });
  for (const op of ["full", "par"] as const) for (const c of declaredPropChecks(proc, op)) {
    // A mask selects the bits compared (declaredPropMatches); past its end nothing is compared.
    const known = Buffer.alloc(c.expect.length, c.mask ? 0 : 0xff);
    c.mask?.copy(known, 0, 0, Math.min(c.mask.length, known.length));
    const what = `LdCtrlCompareProp ${c.obj}/${c.pid} ${hex(c.expect)}${c.mask ? ` mask ${hex(c.mask)}` : ""}`;
    if (properties.get(keyOf(c.obj, c.pid))?.sources.some((s) => s.from === "product" && s.what === what)) continue;
    set(c.obj, c.pid, c.expect, known, { from: "product", what });
  }
  return { application: cfg.id, mask: mask.hex, properties };
}

// One `Required data mismatch` line of ETS6.log: the unit answered `device` in a system property, ETS required
// `required`.
export interface Mismatch { line: string; object: number; pid: number; device: Buffer; required: Buffer }

// Read is only the form decision 0004 §1 quotes, as bussard's sweep reads it and as ETS wrote it on the MEAN WELL
// KNX-40E-1280D's sweep row with a wrong hardware type: `Required data mismatch at
// SystemProperty(<object>/<PID>)[$0000]: <device> instead of <required>`, the values as contiguous hex, the
// device's possibly empty. Another index than $0000, a range, or spaced octets are refused until a recorded line
// shows what they mean.
const MISMATCH_MARK = "Required data mismatch";
const MISMATCH = new RegExp(`${MISMATCH_MARK} at SystemProperty\\((\\d{1,3})/(\\d{1,3})\\)\\[\\$0000\\]: ((?:[0-9A-Fa-f]{2})*) instead of ((?:[0-9A-Fa-f]{2})+)$`);

// The mismatch lines of an ETS6.log excerpt (Latin-1 as ETS writes it, or text). A line that names a mismatch and
// does not read as one is refused: a mismatch skipped would rerun the row with the identity it failed on.
export function mismatchLines(log: Buffer | string): Mismatch[] {
  const text = typeof log === "string" ? log : log.toString("latin1");
  const out: Mismatch[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.includes(MISMATCH_MARK)) continue;
    const line = raw.trim();
    const m = MISMATCH.exec(line);
    if (!m) throw new Error(`an ETS6.log line names a mismatch this parser does not read: ${line}`);
    // The property services address an interface object and a property by one octet each.
    const object = Number(m[1]), pid = Number(m[2]);
    if (object > 0xff || pid > 0xff) throw new Error(`an ETS6.log mismatch names a property no property service addresses: ${line}`);
    out.push({ line, object, pid, device: Buffer.from(m[3], "hex"), required: Buffer.from(m[4], "hex") });
  }
  return out;
}

export type Rerun = { identity: ProductUnit; learned: Mismatch[] } | { refused: string };

// The rerun step of the identity loop, which the ETS driver calls after a row ETS failed: from the ETS6.log lines
// of that run, the identity to run again with, every value ETS required put in with its line as the source; or the
// reason not to run again. Refused: a run whose log names no mismatch (its failure is not the identity), a mismatch
// whose `device` is not what `unit` answers (the log is of another identity), one that requires what `unit` already
// answers (a rerun would fail the same), one that requires the first octets of what it answers alone (no answer
// shorter than the unit's is modelled), two that require different values of one property (which one the unit is to
// answer the run does not show), and one that contradicts the product or another line. `answered`: what the
// unit answers as a property's first element (empty where it answers none), where that is not `unit`'s own: a
// catalogue unit's, whose donor answers what the identity does not give (tools/sim-unit-catalogue.ts).
export function rerunIdentity(unit: ProductUnit, log: Buffer | string, answered?: (key: string) => Buffer): Rerun {
  let mismatches: Mismatch[];
  try { mismatches = mismatchLines(log); } catch (e) { return { refused: (e as Error).message }; }
  if (mismatches.length === 0) return { refused: "the run's ETS6.log names no required data: its failure is not the identity" };
  // Every line is checked against the identity the run had before any is put in.
  for (const m of mismatches) {
    const key = keyOf(m.object, m.pid);
    // A value not given in full the unit cannot answer (no bit is invented): ETS then saw nothing.
    const had = unit.properties.get(key);
    const answers = answered ? answered(key) : had !== undefined && had.known.every((k) => k === 0xff) ? had.bytes : null;
    if (answers === null ? m.device.length > 0 : !answers.equals(m.device)) return { refused: `ETS saw ${hex(m.device) || "nothing"} in ${key}, which this identity does not answer: the log is of another run (${m.line})` };
    if (answers?.equals(m.required)) return { refused: `ETS requires ${hex(m.required)} in ${key}, which this identity already answers: a rerun fails the same (${m.line})` };
    if (answers && answers.length > m.required.length && answers.subarray(0, m.required.length).equals(m.required)) return { refused: `ETS requires the ${m.required.length} octets ${hex(m.required)} in ${key}, where this identity answers ${answers.length} beginning with them: an answer shorter than the unit's is not modelled (${m.line})` };
    const other = mismatches.find((x) => keyOf(x.object, x.pid) === key && !x.required.equals(m.required));
    if (other) return { refused: `ETS requires both ${hex(m.required)} and ${hex(other.required)} in ${key} in one run: which the unit is to answer is not shown (${m.line}; ${other.line})` };
  }
  const properties = new Map(unit.properties);
  const learned: Mismatch[] = [];
  for (const m of mismatches) {
    const key = keyOf(m.object, m.pid);
    if (learned.some((l) => keyOf(l.object, l.pid) === key && l.required.equals(m.required))) continue;
    try {
      properties.set(key, merge(properties.get(key), m.required, Buffer.alloc(m.required.length, 0xff), { from: "ets6log", line: m.line }, (why) => { throw new Error(why); }));
    } catch (e) { return { refused: `ETS requires ${hex(m.required)} in ${key}: ${(e as Error).message}` }; }
    learned.push(m);
  }
  return { identity: { ...unit, properties }, learned };
}

// The product unit against a unit built from a real unit's collection (tools/sim-unit-model.ts's `collectedUnit`),
// each as one line: the properties the product gives as the unit holds them; a property both hold whose given bits
// differ, whose length differs, or that the product gives only in part; a property the product gives and the
// collection did not read; and everything the collected unit holds that the product does not give (its properties,
// descriptions, function-property states, whether it answered A_MemoryExtended_Read): what a catalogue row's
// simulator would not know.
export function productAgainstUnit(product: ProductUnit, unit: Pick<ReturnType<typeof collectedUnit>, "mask" | "objects" | "descriptions" | "functionStates" | "memoryExtendedRead">): string[] {
  const out: string[] = [];
  if (product.mask !== unit.mask) out.push(`mask: product ${product.mask.toString(16).padStart(4, "0")}, unit ${unit.mask.toString(16).padStart(4, "0")}`);
  const shown = (v: IdentityValue) => Array.from(v.bytes).map((b, i) => v.known[i] === 0xff ? b.toString(16).padStart(2, "0") : v.known[i] === 0 ? "??" : `${b.toString(16).padStart(2, "0")}/${v.known[i].toString(16).padStart(2, "0")}`).join("");
  const unitKeys: string[] = [], equal: string[] = [];
  for (const [o, props] of [...unit.objects].sort(([a], [b]) => a - b)) for (const [pid, p] of [...props].sort(([a], [b]) => a - b)) {
    const key = keyOf(o, pid), given = product.properties.get(key);
    if (!given) { unitKeys.push(key); continue; }
    const first = p.elements?.[0];
    if (!first) { out.push(`${key}: product ${shown(given)}, unit ${p.elements === null ? "refused" : "no element read"}`); continue; }
    const differs = Array.from(given.bytes).some((b, i) => i < first.length && (b & given.known[i]) !== (first[i] & given.known[i]));
    if (differs) out.push(`${key} differs: product ${shown(given)}, unit ${hex(first)}`);
    else if (first.length !== given.bytes.length) out.push(`${key} length: product ${given.bytes.length} octets ${shown(given)}, unit ${first.length} octets ${hex(first)}`);
    else if (given.known.some((k) => k !== 0xff)) out.push(`${key} given in part: product ${shown(given)}, unit ${hex(first)}`);
    else equal.push(key);
  }
  if (equal.length) out.unshift(`given as the unit holds them: ${equal.join(" ")}`);
  for (const [key, given] of product.properties) {
    const [o, pid] = key.split("/").map(Number);
    if (!unit.objects.get(o)?.has(pid)) out.push(`${key} not collected: product ${shown(given)}`);
  }
  if (unitKeys.length) out.push(`properties not given: ${unitKeys.join(" ")}`);
  const descriptions = [...unit.descriptions.values()].reduce((n, l) => n + l.length, 0);
  if (descriptions) out.push(`descriptions not given: ${descriptions} for ${unit.descriptions.size} object indices`);
  if (unit.functionStates.size) out.push(`function-property states not given: ${[...unit.functionStates.keys()].join(", ")}`);
  if (unit.memoryExtendedRead) out.push("A_MemoryExtended_Read not given");
  return out;
}
