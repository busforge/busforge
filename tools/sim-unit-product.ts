// A simulated unit's identity from its product alone, for a catalogue row of the ETS sweep that has no collection of a
// real unit (decision 0004 §1, "Identity"), and the identity loop: ETS refuses a unit whose identity does not fit the
// product ("inkompatible Produktdaten") and names in its ETS6.log what it required, the sweep runs again with that.
//
// Every value carries its source: the product (the application program's mask, its manufacturer, what its
// LdCtrlCompareProp steps expect, bit by bit where a compare masks) or an ETS6.log line. Nothing else is taken:
// what neither gives (the serial, the order info, the version, the device control, descriptions, where the unit
// places its segments) the product unit does not hold, and `productAgainstUnit` lists it against a collected unit.
import { parseAppConfig, parseLoadProcedures, declaredPropChecks } from "../packages/product/src/index.ts";
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

const hex = (b: Buffer) => b.toString("hex");
const keyOf = (object: number, pid: number) => `${object}/${pid}`;

// `value` given as far as `known` says, put over what `into` already holds; refused where a known bit differs.
function merge(into: IdentityValue | undefined, value: Buffer, known: Buffer, source: IdentitySource, offset: number, refuse: (why: string) => never): IdentityValue {
  const length = Math.max(into?.bytes.length ?? 0, offset + value.length);
  const bytes = Buffer.alloc(length), mask = Buffer.alloc(length);
  into?.bytes.copy(bytes); into?.known.copy(mask);
  for (let i = 0; i < value.length; i++) {
    const at = offset + i, both = mask[at] & known[i];
    if ((bytes[at] & both) !== (value[i] & both)) refuse(`octet ${at} is ${bytes[at].toString(16).padStart(2, "0")} under mask ${both.toString(16).padStart(2, "0")} by ${describe(into!.sources)}, ${describe([source])} gives ${value[i].toString(16).padStart(2, "0")}`);
    bytes[at] = (bytes[at] & ~known[i]) | (value[i] & known[i]);
    mask[at] |= known[i];
  }
  return { bytes, known: mask, sources: [...(into?.sources ?? []), source] };
}

const describe = (sources: IdentitySource[]) => sources.map((s) => s.from === "product" ? s.what : `ETS6.log "${s.line}"`).join(", ");

// The unit as the application program alone gives it. Refused where the application's identity steps are not
// modelled or contradict each other.
export function productUnit(appXml: string): ProductUnit {
  const refuse = (why: string): never => { throw new Error(`no product unit: ${why}`); };
  const cfg = parseAppConfig(appXml);
  const mask = /^MV-([0-9A-F]{4})$/.exec(cfg.mask);
  if (!mask) refuse(`the application's mask ${cfg.mask} is not MV-xxxx`);
  const proc = parseLoadProcedures(appXml);
  const unmodelled = UNMODELLED_IDENTITY_STEPS.filter((v) => proc.verbs.includes(v));
  if (unmodelled.length) refuse(`its load procedure holds ${unmodelled.join(", ")}, whose expectation is not modelled`);

  const properties = new Map<string, IdentityValue>();
  const set = (object: number, pid: number, value: Buffer, known: Buffer, source: IdentitySource) => {
    const key = keyOf(object, pid);
    properties.set(key, merge(properties.get(key), value, known, source, 0, (why) => refuse(`property ${key}: ${why}`)));
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
  return { application: cfg.id, mask: parseInt(mask![1], 16), properties };
}

// One `Required data mismatch` line of ETS6.log: at a system property's octet `offset`, the unit answered `device`,
// ETS required `required`.
export interface Mismatch { line: string; time: string | null; object: number; pid: number; offset: number; device: Buffer; required: Buffer }

const MISMATCH_MARK = "Required data mismatch";
const HEX_OCTETS = "((?:[0-9A-Fa-f]{2} ?)*)";
const MISMATCH = new RegExp(
  `^(?:(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d(?:,\\d+)?) .*)?${MISMATCH_MARK} at SystemProperty\\((\\d+)/(\\d+)\\)\\[\\$([0-9A-Fa-f]+)(?:-\\$([0-9A-Fa-f]+))?\\]: ?${HEX_OCTETS}\\s*instead of\\s+${HEX_OCTETS}\\s*$`,
);

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
    const octets = (s: string) => Buffer.from(s.replace(/ /g, ""), "hex");
    const offset = parseInt(m[4], 16), required = octets(m[7]);
    if (required.length === 0) throw new Error(`an ETS6.log mismatch requires no value: ${line}`);
    if (m[5] !== undefined && parseInt(m[5], 16) - offset + 1 !== required.length) throw new Error(`an ETS6.log mismatch's range is not the length of its required value: ${line}`);
    out.push({ line, time: m[1] ?? null, object: Number(m[2]), pid: Number(m[3]), offset, device: octets(m[6]), required });
  }
  return out;
}

export type Rerun = { identity: ProductUnit; learned: Mismatch[] } | { refused: string };

// The rerun step of the identity loop, which the ETS driver calls after a row ETS failed: from the ETS6.log lines
// of that run, the identity to run again with, every value ETS required put in with its line as the source; or the
// reason not to run again. Refused: a run whose log names no mismatch (its failure is not the identity), a mismatch
// whose `device` is not what `unit` answers (the log is of another identity), one that requires what `unit` already
// answers (a rerun would fail the same), one that contradicts the product or another line, and one past octets
// nothing gives.
export function rerunIdentity(unit: ProductUnit, log: Buffer | string): Rerun {
  let mismatches: Mismatch[];
  try { mismatches = mismatchLines(log); } catch (e) { return { refused: (e as Error).message }; }
  if (mismatches.length === 0) return { refused: "the run's ETS6.log names no required data: its failure is not the identity" };
  const properties = new Map(unit.properties);
  const learned: Mismatch[] = [];
  for (const m of mismatches) {
    const key = keyOf(m.object, m.pid);
    if (learned.some((l) => keyOf(l.object, l.pid) === key && l.offset === m.offset && l.required.equals(m.required))) continue;
    // A value not given in full the unit cannot answer (no bit is invented): ETS then saw nothing, as it does
    // past the end of a value given in full.
    const had = unit.properties.get(key);
    const full = (at: number, n: number) => had !== undefined && at + n <= had.bytes.length && had.known.subarray(at, at + n).every((k) => k === 0xff);
    const saw = m.device.length === 0
      ? had === undefined || !full(0, had.bytes.length) || had.bytes.length <= m.offset
      : full(m.offset, m.device.length) && had!.bytes.subarray(m.offset, m.offset + m.device.length).equals(m.device);
    if (!saw) return { refused: `ETS saw ${hex(m.device) || "nothing"} in ${key} from octet ${m.offset}, which this identity does not answer there: the log is of another run (${m.line})` };
    if (full(m.offset, m.required.length) && had!.bytes.subarray(m.offset, m.offset + m.required.length).equals(m.required)) return { refused: `ETS requires ${hex(m.required)} in ${key}, which this identity already answers: a rerun fails the same (${m.line})` };
    const before = properties.get(key);
    if (m.offset > 0 && (!before || before.bytes.length < m.offset || before.known.subarray(0, m.offset).some((k) => k !== 0xff))) return { refused: `ETS requires ${key} from octet ${m.offset}; the octets before it neither the product nor the log give (${m.line})` };
    try {
      properties.set(key, merge(before, m.required, Buffer.alloc(m.required.length, 0xff), { from: "ets6log", line: m.line }, m.offset, (why) => { throw new Error(why); }));
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
