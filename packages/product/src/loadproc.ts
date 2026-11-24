import { XMLParser } from "fast-xml-parser";
import { type ONode, tagOf, attrsOf, kidsOf, childrenByTag } from "./onode.ts";
import { ProductError } from "./errors.ts";
import type { StepRefusal } from "./deviceflash.ts";

// Parse a KNX ApplicationProgram's <LoadProcedures> into a generic, executable step
// model. The load procedure is the device's own declared programming recipe: which
// LSM segments to load, in what order, and how to finalize them. It is what ETS
// follows to download a device, and (verified on real MV-0705 hardware) following it
// is what makes a device accept and activate a parameter change.
//
// Three styles exist (ApplicationProgram@LoadProcedureStyle), structurally different:
//   - ProductProcedure: ONE self-contained <LoadProcedure> with every LdCtrl step
//     inline (absolute-segment / BCU2-class devices). Directly executable from the XML.
//   - MergedProcedure: <LoadProcedure MergeId="n"> FRAGMENTS that ETS merges into the
//     management model's base procedure at merge points, selected per operation by a
//     step's AppliesTo ("full" | "par"). The base (connect / per-LSM load / restart)
//     is NOT in the product XML; it comes from the model (System B). So a MergedProcedure
//     is parameterization for a known base, not a standalone sequence.
//   - DefaultProcedure: nothing in the XML; the whole procedure is hardcoded by mask
//     version (legacy BCU1/2). We parse it to an empty block set and surface the gap.
//
// This module only PARSES (no bus). The executor (packages/knx flash.ts) consumes the
// steps. Keeping the step model generic (verb + attrs) means a new device's procedure
// is data, not code: unknown verbs are preserved and surfaced, never silently dropped.

export type LoadProcedureStyle = "ProductProcedure" | "MergedProcedure" | "DefaultProcedure" | "Unknown";

// One LdCtrl* step, kept generic: the verb plus its raw attributes. Typed accessors
// (lsmIdx/address/size/appliesTo) read the attributes the executor needs.
export interface LdStep { verb: string; attrs: Record<string, string>; }
export interface LoadProcedureBlock { mergeId?: number; steps: LdStep[]; }
export interface LoadProcedures {
  style: LoadProcedureStyle;
  app?: string;      // the ApplicationProgram Id the procedure belongs to
  blocks: LoadProcedureBlock[];
  verbs: string[];   // distinct verbs across all blocks, sorted
  unknown: string[]; // verbs not in KNOWN_LD_VERBS (the coverage gap signal), sorted
  // The application attributes that decide which form of its procedure ETS runs (docs/load-procedures.md,
  // "The rules, by level"):
  //  - preferPartialIfLoaded: <Options PreferPartialDownloadIfApplicationLoaded="true">. On a unit that
  //    holds this application loaded, ETS's full download leaves the application loaded and reloads the
  //    group tables only (Gira M-0008, ABB US/U 4.2, Theben DALI-Gateway captures).
  //  - dynamicTables: DynamicTableManagement="true". ETS takes the two group-table segments as one region,
  //    the address table's segment as long as the table (Gira M-0008, TheLuxa P300, Meteodata 140 S).
  //  - secureEnabled: IsSecureEnabled="true". ETS runs the mask's secure procedure, which closes a System B
  //    download with the confirmed restart (Theben MIX 2, Jung 400021SE, GVS AMMA against the DALI-Gateway).
  //  - extendedMemoryServices: <Options SupportsExtendedMemoryServices="true">. ETS writes memory with
  //    A_MemoryExtended_Write only on such an application (Jung 400021SE, GVS AMMA, Theben MIX 2, OpenKNX);
  //    elsewhere with A_Memory_Write, also on a unit that declares a long APDU (Theben DALI-Gateway, 55),
  //    which takes no extended write.
  preferPartialIfLoaded: boolean;
  dynamicTables: boolean;
  secureEnabled: boolean;
  extendedMemoryServices: boolean;
  //  - legacyTaskSegmentManufacturer: <Options LegacyPatchManufacturerIdInTaskSegment="true">, with
  //    originalManufacturer (ApplicationProgram@OriginalManufacturer, "M-xxxx") where the application names
  //    one: together they decide whether a System 7 task segment's manufacturer is one no capture shows
  //    (taskSegmentManufacturerRefusal, deviceflash.ts).
  legacyTaskSegmentManufacturer?: true;
  originalManufacturer?: string;
}

// The LdCtrl vocabulary the executor models. Sourced from the full inventory of the
// real catalogue (docs/load-procedures.md). A verb outside this set surfaces in
// LoadProcedures.unknown so a new catalogue can never be flashed blind.
export const KNOWN_LD_VERBS = new Set([
  // control
  "LdCtrlConnect", "LdCtrlDisconnect", "LdCtrlRestart",
  // load state machine
  "LdCtrlUnload", "LdCtrlLoad", "LdCtrlLoadCompleted",
  // memory segments
  "LdCtrlAbsSegment", "LdCtrlRelSegment", "LdCtrlTaskSegment", "LdCtrlTaskCtrl1",
  "LdCtrlWriteAbsMem", "LdCtrlWriteRelMem",
  // interface-object properties
  "LdCtrlWriteProp", "LdCtrlLoadImageProp", "LdCtrlCompareProp",
  // the steps the third-party synthetic captures show ETS running (docs/load-procedures.md, "Steps run as
  // the synthetic captures show them"); where a download does not run one, it refuses it
  "LdCtrlDelay", "LdCtrlMasterReset", "LdCtrlTaskPtr", "LdCtrlTaskCtrl2",
]);

function deepFirst(nodes: ONode[], tag: string): ONode | undefined {
  for (const n of nodes) {
    if (tagOf(n) === tag) return n;
    const r = deepFirst(kidsOf(n), tag);
    if (r) return r;
  }
  return undefined;
}

export function parseLoadProcedures(xml: string): LoadProcedures {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", attributesGroupName: ":@", preserveOrder: true });
  return loadProceduresOf(p.parse(xml) as ONode[]);
}

// The same, from a document already parsed by the order-preserving parser (parseAppConfig).
export function loadProceduresOf(root: ONode[]): LoadProcedures {
  const app = deepFirst(root, "ApplicationProgram");
  const styleAttr = app ? attrsOf(app).LoadProcedureStyle : undefined;
  const appId = app ? attrsOf(app).Id : undefined;
  const appAttrs = app ? attrsOf(app) : {};
  const appKids = app ? kidsOf(app) : [];
  const staticNode = appKids.find((n) => tagOf(n) === "Static");
  const options = [...(staticNode ? kidsOf(staticNode) : []), ...appKids].find((n) => tagOf(n) === "Options");
  const style: LoadProcedureStyle =
    styleAttr === "ProductProcedure" || styleAttr === "MergedProcedure" || styleAttr === "DefaultProcedure" ? styleAttr : "Unknown";

  const blocks: LoadProcedureBlock[] = [];
  const verbs = new Set<string>();
  const unknown = new Set<string>();
  const container = deepFirst(root, "LoadProcedures");
  for (const proc of container ? childrenByTag(kidsOf(container), "LoadProcedure") : []) {
    const mergeId = attrsOf(proc).MergeId;
    const steps: LdStep[] = [];
    for (const s of kidsOf(proc)) {
      const verb = tagOf(s);
      if (verb.startsWith("#")) continue; // text / whitespace pseudo-nodes
      steps.push({ verb, attrs: attrsOf(s) });
      verbs.add(verb);
      if (!KNOWN_LD_VERBS.has(verb)) unknown.add(verb);
    }
    blocks.push({ mergeId: mergeId !== undefined ? decimalAttr(mergeId) : undefined, steps });
  }
  return {
    style, ...(appId !== undefined ? { app: appId } : {}), blocks, verbs: [...verbs].sort(), unknown: [...unknown].sort(),
    preferPartialIfLoaded: (options ? attrsOf(options).PreferPartialDownloadIfApplicationLoaded : undefined) === "true",
    dynamicTables: appAttrs.DynamicTableManagement === "true",
    secureEnabled: appAttrs.IsSecureEnabled === "true",
    extendedMemoryServices: (options ? attrsOf(options).SupportsExtendedMemoryServices : undefined) === "true",
    ...((options ? attrsOf(options).LegacyPatchManufacturerIdInTaskSegment : undefined) === "true" ? { legacyTaskSegmentManufacturer: true as const } : {}),
    ...(appAttrs.OriginalManufacturer !== undefined ? { originalManufacturer: appAttrs.OriginalManufacturer } : {}),
  };
}

// ---- operation selection ----
// Which download a step belongs to. ETS distinguishes a full download (everything) from
// a parameter-only ("par") download. The schema (LdCtrlProcType_t) also names "grp" (a group-table-only
// download, which no step list here is built for), "all" (every download) and "auto", the default when
// the attribute is absent; a step declared "all" or "auto", or with no AppliesTo, applies to both.
export type LoadOp = "full" | "par";

export function stepApplies(step: LdStep, op: LoadOp): boolean {
  const ops = (step.attrs.AppliesTo ?? "auto").split(",").map((s) => s.trim());
  return ops.includes("all") || ops.includes("auto") || ops.includes(op);
}

// Flatten the procedure to an ordered step list for one operation: blocks in MergeId
// order (ProductProcedure has a single block), then per-step AppliesTo filtering.
export function flattenSteps(lp: LoadProcedures, op: LoadOp): LdStep[] {
  return orderedSteps(lp).filter((s) => stepApplies(s, op));
}

function orderedSteps(lp: LoadProcedures): LdStep[] {
  refuseMalformed(lp);
  return [...lp.blocks].sort((a, b) => (a.mergeId ?? 0) - (b.mergeId ?? 0)).flatMap((b) => b.steps);
}

// The byte the device is asked to pre-fill the parameter segment (LSM 4) with, from the full
// download's LdCtrlRelSegment step. Most System B devices declare 0 (zero the segment); some declare
// 255 (0xFF, the erased-flash state). The full download allocates with this value; on the filled
// allocation (Mode 1) it also treats it as the "already there" byte when choosing the bytes it writes,
// or the un-written regions read back wrong, where the unfilled one (Mode 0) writes every byte. 0 when
// the procedure declares no relative parameter allocation.
export function relParamFillByte(lp: LoadProcedures): number {
  const seg = relParamFullSegment(lp);
  return seg ? (stepNumber(seg, "Fill") ?? 0) & 0xff : 0;
}
// The allocation Mode the full download's LdCtrlRelSegment of the parameter segment declares ("1" =
// pre-filled with Fill, "0" = not), undefined when the procedure declares none.
export function relParamFullMode(lp: LoadProcedures): string | undefined {
  const seg = relParamFullSegment(lp);
  return seg ? seg.attrs.Mode ?? "0" : undefined;
}
function relParamFullSegment(lp: LoadProcedures): LdStep | undefined {
  const rel = flattenSteps(lp, "full").filter((s) => s.verb === "LdCtrlRelSegment");
  return rel.find((s) => s.attrs.LsmIdx === "4") ?? rel.find((s) => s.attrs.LsmIdx === undefined);
}

// ---- numeric attributes ----
// The schema declares every numeric attribute of a load procedure an unsigned integer, and every
// procedure of the catalogue and the corpus projects writes each in decimal without leading zeros.
// Number() reads more: "" as 0, "0x10" as 16, " 5" as 5, "1e3" as 1000, "-1" as -1. A value read that way
// is a value the procedure does not declare, so only the plain decimal form is read (with a leading zero
// it would also miss the steps matched by their text, LsmIdx "4"); anything else is NaN here, which the
// range checks below refuse, and a refusal where a value is taken (stepNumber).
const decimalAttr = (v: string | undefined): number => {
  const n = v !== undefined && /^(0|[1-9][0-9]*)$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : NaN;
};
// The attributes of a step Busforge reads as numbers (hex InlineData and Mask, and the flags, are read as text).
const NUMERIC_STEP_ATTRS = [
  "LsmIdx", "Address", "Size", "MemType", "SegType", "Access", "SegFlags", "Fill", "ObjIdx", "PropId", "StartElement",
  "Count", "Offset", "EraseCode", "ChannelNumber", "MilliSeconds", "InitPtr", "SavePtr", "SerialPtr", "Callback", "Seg0", "Seg1",
];
const MALFORMED = "LOAD_PROCEDURE_ATTRIBUTE_MALFORMED" as const;
const malformed = (what: string) => `the load procedure declares ${what}, which is not an unsigned decimal number; refusing to read a value from it`;
// A load procedure that declares one of those attributes, or a LoadProcedure's MergeId, as anything but a
// decimal number refuses every download, before any step is planned: which value it means is not said.
export function malformedStepRefusal(lp: LoadProcedures): { code: typeof MALFORMED; message: string } | null {
  const refusal = (what: string) => ({ code: MALFORMED, message: malformed(what) });
  for (const b of lp.blocks) {
    if (b.mergeId !== undefined && Number.isNaN(b.mergeId)) return refusal("a LoadProcedure MergeId");
    for (const s of b.steps) {
      const bad = NUMERIC_STEP_ATTRS.find((k) => s.attrs[k] !== undefined && Number.isNaN(decimalAttr(s.attrs[k])));
      if (bad) return refusal(`${s.verb} ${bad}="${s.attrs[bad]}"`);
    }
  }
  return null;
}
// The walks a planner takes values from (orderedSteps, closingSteps) start here, so a planner never
// takes a step of a malformed one.
function refuseMalformed(lp: LoadProcedures): void {
  const refusal = malformedStepRefusal(lp);
  if (refusal) throw new ProductError(refusal.code, refusal.message);
}
// A numeric attribute a download takes: undefined where the step does not declare it.
function stepNumber(s: LdStep, name: string): number | undefined {
  const v = s.attrs[name];
  if (v === undefined) return undefined;
  const n = decimalAttr(v);
  if (Number.isNaN(n)) throw new ProductError(MALFORMED, malformed(`${s.verb} ${name}="${v}"`));
  return n;
}

// ---- typed attribute accessors (the fields the executor reads) ----
export const lsmIdx = (s: LdStep): number | undefined => stepNumber(s, "LsmIdx");
export const stepAddress = (s: LdStep): number | undefined => stepNumber(s, "Address");
export const stepSize = (s: LdStep): number | undefined => stepNumber(s, "Size");
export const stepOffset = (s: LdStep): number | undefined => stepNumber(s, "Offset");
export const objIdx = (s: LdStep): number | undefined => stepNumber(s, "ObjIdx");
export const memType = (s: LdStep): number | undefined => stepNumber(s, "MemType");
export const segType = (s: LdStep): number => stepNumber(s, "SegType") ?? 0;
export const segAccess = (s: LdStep): number => stepNumber(s, "Access") ?? 0;
export const segFlags = (s: LdStep): number => stepNumber(s, "SegFlags") ?? 0;

// ---- par-download step policy ----
// The par (parameter-only) download deliberately does not execute every step a procedure
// declares: a surgical write into loaded segments must not erase them, and full-download
// bookkeeping (task segments, MCB stamps) does not apply. That is only honest if every
// par-applicable step gets an EXPLICIT disposition; a step without one blocks the flash.
// This replaces the old behavior where unexecuted steps simply vanished and the flash
// reported success ("silent partial recipe"), and it puts LoadProcedures.unknown on the
// runtime path instead of only in a fixture test.
//
// Dispositions:
//   executed - the planner/executor or the proven base bracket performs it (CompareProp
//              is executed as a pre-flight property check by the flash path)
//   caller   - session lifecycle the caller owns (a second T_Connect would desync the
//              sequence counter; see planAbsoluteParFlash)
//   skipped  - deliberately not executed, with a documented reason and hardware evidence
//   blocked  - not modeled: the flash must refuse rather than run a partial recipe

export type ParDisposition =
  | { kind: "executed" }
  | { kind: "caller" }
  | { kind: "skipped"; reason: string }
  | { kind: "blocked"; detail: string };

// PID 27 is the memory-control-block table: per segment region, its size, a control byte and a
// CRC. On System B an application may declare the regions itself (LdCtrlWriteProp to PID 27):
// the Jung 400021SE splits its 7701-byte parameter segment into 7700 bytes plus one byte the
// device changes at run time. Without that split the device keeps one region over the whole
// segment, the byte it changes breaks the CRC, and the application comes back from the next
// restart in ERROR. The allocation of a par download resets the regions just the same (hardware-
// measured on the Jung: two regions after a full download and a GA flash, one after a parameter
// flash). So both the full and the par download write the declared entries after the allocation,
// as ETS writes them (declaredMcbWrites). A declared LdCtrlLoadImageProp to PID 27 is a read of
// it that closes the download (closingSteps): the device computes the CRC itself. On an absolute
// device a declared write to PID 27 blocks.
const MCB_PID = 27;
// An MCB entry is 8 bytes: region size (4), control (2), CRC (2). The InlineData of the known
// applications is 10 bytes with two trailing zero bytes, and ETS sends the first 8.
const MCB_ENTRY_BYTES = 8;
const MCB_OBJ = 4;

// echoPrefix: the entry is declared Verify="false", so the device may fill its CRC in the echo;
// only the region size (the first 4 bytes) must come back as written.
export interface McbWrite { obj: number; element: number; data: Buffer; echoPrefix?: number }

// The MCB entry a declared LdCtrlWriteProp to PID 27 writes, or a reason it cannot be written
// faithfully.
function mcbWrite(step: LdStep): McbWrite | string {
  const hex = step.attrs.InlineData ?? "";
  if (!/^([0-9A-Fa-f]{2})+$/.test(hex)) return `InlineData "${hex}" is not hex`;
  const data = Buffer.from(hex, "hex");
  if (data.length < MCB_ENTRY_BYTES) return `InlineData of ${data.length} bytes is shorter than an MCB entry`;
  if (data.subarray(MCB_ENTRY_BYTES).some((b) => b !== 0)) return `InlineData carries data beyond the ${MCB_ENTRY_BYTES}-byte MCB entry`;
  if (decimalAttr(step.attrs.ObjIdx) !== MCB_OBJ) return `it targets object ${step.attrs.ObjIdx}; only the parameter segment (object ${MCB_OBJ}) is known to carry declared regions`;
  const element = decimalAttr(step.attrs.StartElement ?? "1");
  if (!Number.isInteger(element) || element < 1 || element > 4095) return `StartElement "${step.attrs.StartElement}" is not an element index`;
  if (step.attrs.Count !== undefined && step.attrs.Count !== "1") return `Count="${step.attrs.Count}" writes more than one entry`;
  return { obj: MCB_OBJ, element, data: data.subarray(0, MCB_ENTRY_BYTES), ...(step.attrs.Verify === "false" ? { echoPrefix: 4 } : {}) };
}

// The MCB entries a System B application declares for one download, in declaration order. Their
// regions must cover the parameter segment exactly: regions that do not add up to the allocation
// would have the device check the wrong bytes at boot.
export function declaredMcbWrites(lp: LoadProcedures, segmentSize: number, op: LoadOp = "full"): McbWrite[] {
  const writes = flattenSteps(lp, op)
    .filter((s) => s.verb === "LdCtrlWriteProp" && decimalAttr(s.attrs.PropId) === MCB_PID)
    .map((s) => {
      const w = mcbWrite(s);
      if (typeof w === "string") throw new ProductError("LOAD_STEP_UNSUPPORTED", `the load procedure's ${s.verb} to PID 27 cannot be executed: ${w}`);
      return w;
    });
  const covered = writes.reduce((sum, w) => sum + w.data.readUInt32BE(0), 0);
  if (writes.length && covered !== segmentSize) {
    throw new ProductError("LOAD_STEP_UNSUPPORTED", `the declared memory-control-block regions cover ${covered} bytes, the parameter segment is ${segmentSize}; refusing to program regions that do not match it`);
  }
  return writes;
}

// ---- the steps that close a download ----
// After its last LoadCompleted a procedure may declare reads of objects' memory-control blocks
// (LdCtrlLoadImageProp, PID 27) and property writes to other properties (LdCtrlWriteProp): the merge
// block 7 of a MergedProcedure, the steps behind the last LdCtrlLoadCompleted of a ProductProcedure.
// ETS executes them in declared order right before the restart, in the full, the parameter and the
// group-address download alike, every declared read whatever the download reloaded: the Gira M-0008
// (System 7), the Theben MIX 2, Jung 400021SE, GVS AMMA and Theben DALI-Gateway (System B) captures,
// the GVS's declared PID 67 write after its reads in each of its downloads. A write is echo-checked
// where it declares Verify="true". ETS keeps the stamps it reads to skip identical bytes in its next
// download, which Busforge does not do (it reads the device instead), so they are only required to arrive.
export type ClosingOp = LoadOp | "grp";
export type ClosingStep =
  | { kind: "read"; obj: number; pid: number; start: number; count: number }
  | { kind: "write"; obj: number; pid: number; start: number; data: Buffer; verify: boolean };

const CLOSING_MERGE_ID = 7;
const isClosingVerb = (s: LdStep) => s.verb === "LdCtrlLoadImageProp" || (s.verb === "LdCtrlWriteProp" && decimalAttr(s.attrs.PropId) !== MCB_PID);

function closingCandidates(lp: LoadProcedures): LdStep[] {
  if (lp.style === "MergedProcedure") return [...lp.blocks].filter((b) => b.mergeId === CLOSING_MERGE_ID).flatMap((b) => b.steps);
  const steps = orderedSteps(lp);
  const last = steps.findLastIndex((s) => s.verb === "LdCtrlLoadCompleted");
  return last < 0 ? [] : steps.slice(last + 1).filter(isClosingVerb);
}

// A step's AppliesTo for a closing step: the group-address download takes what applies to "all", "grp"
// or "auto" (every capture of one shows the undeclared reads, the GVS's write declared "all").
const closingApplies = (s: LdStep, op: ClosingOp): boolean => {
  const ops = (s.attrs.AppliesTo ?? "auto").split(",").map((x) => x.trim());
  return ops.includes("all") || ops.includes("auto") || ops.includes(op);
};

export function closingSteps(lp: LoadProcedures, op: ClosingOp): ClosingStep[] {
  refuseMalformed(lp);
  return closingCandidates(lp).filter((s) => isClosingVerb(s) && closingApplies(s, op)).map((s) => {
    const r = closingStep(s);
    if (typeof r === "string") throw new ProductError("LOAD_STEP_UNSUPPORTED", `the load procedure closes with ${s.verb} ${JSON.stringify(s.attrs)}, which cannot be executed as declared: ${r}`);
    return r;
  });
}

// The object index, PID and first element a property step names, or why it names none.
function propertyAddressOf(s: LdStep): { obj: number; pid: number; start: number } | string {
  const obj = decimalAttr(s.attrs.ObjIdx), pid = decimalAttr(s.attrs.PropId), start = decimalAttr(s.attrs.StartElement ?? "1");
  if (s.attrs.ObjIdx === undefined || !Number.isInteger(obj) || obj < 0 || obj > 255) return "it names no object index";
  if (s.attrs.PropId === undefined || !Number.isInteger(pid) || pid < 1 || pid > 255) return "it names no property";
  if (!Number.isInteger(start) || start < 1 || start > 4095) return `StartElement "${s.attrs.StartElement}" is not an element index`;
  return { obj, pid, start };
}

function closingStep(s: LdStep): ClosingStep | string {
  const a = propertyAddressOf(s);
  if (typeof a === "string") return a;
  const { obj, pid, start } = a, count = decimalAttr(s.attrs.Count ?? "1");
  if (s.verb === "LdCtrlLoadImageProp") {
    if (pid !== MCB_PID) return "only the memory-control block (PID 27) is known as the image a closing read takes";
    if (!Number.isInteger(count) || count < 1 || count > 15) return `Count "${s.attrs.Count}" is not a number of elements`;
    return { kind: "read", obj, pid, start, count };
  }
  const hex = s.attrs.InlineData ?? "";
  if (!/^([0-9A-Fa-f]{2})+$/.test(hex)) return "its InlineData is not hex";
  if (s.attrs.Count !== undefined && s.attrs.Count !== "1") return `Count="${s.attrs.Count}" writes more than one element`;
  return { kind: "write", obj, pid, start, data: Buffer.from(hex, "hex"), verify: s.attrs.Verify === "true" };
}

const isClosingStep = (lp: LoadProcedures, s: LdStep): boolean => closingCandidates(lp).includes(s);

// An LdCtrlWriteProp inside a load bracket, with its inline data: `count` elements from `start` in one
// write. ETS reads the property's description first and then writes the elements, at the step's declared
// place (the third-party synthetic MV-0701 capture: object 3 PID 204, two 5-octet elements inside LSM 3's
// load, between its segments' writes and its task segment). Held to the object of the bracket it lies in
// (`lsm`), and never to a property another step of the download writes or reads (load state, table
// reference, program id, memory-control block): no capture shows such a write inside a bracket.
const BRACKET_WRITE_FORBIDDEN_PIDS = [5, 7, 13, MCB_PID];
export interface BracketWriteProp { obj: number; pid: number; start: number; count: number; data: Buffer; verify: boolean }
export function bracketWritePropOf(s: LdStep, lsm: number): BracketWriteProp | string {
  const extra = Object.keys(s.attrs).filter((k) => !["ObjIdx", "PropId", "StartElement", "Count", "Verify", "InlineData", "AppliesTo"].includes(k));
  if (extra.length) return `it declares ${extra.join(", ")}, which no capture shows`;
  const a = propertyAddressOf(s);
  if (typeof a === "string") return a;
  const { obj, pid, start } = a, count = decimalAttr(s.attrs.Count ?? "1");
  if (obj !== lsm) return `it writes object ${obj} inside the load bracket of load-state machine ${lsm}, which no capture shows`;
  if (BRACKET_WRITE_FORBIDDEN_PIDS.includes(pid)) return `it writes PID ${pid}, which the download itself drives, inside a load bracket, which no capture shows`;
  if (!Number.isInteger(count) || count < 1 || count > 15) return `Count "${s.attrs.Count}" is not a number of elements one write carries`;
  const hex = s.attrs.InlineData ?? "";
  if (!/^([0-9A-Fa-f]{2})+$/.test(hex)) return "it declares no InlineData (a parameter placed in the property), which no capture shows written inside a load bracket";
  const data = Buffer.from(hex, "hex");
  if (data.length % count !== 0) return `its ${data.length} octets of InlineData do not split into ${count} elements`;
  return { obj, pid, start, count, data, verify: s.attrs.Verify === "true" };
}

const grpSteps = (lp: LoadProcedures): LdStep[] =>
  orderedSteps(lp).filter((s) => (s.attrs.AppliesTo ?? "").split(",").map((x) => x.trim()).some((x) => x === "grp" || x === "all"));

// The steps a procedure names for a group-table download ("grp" or "all") that the group-address flash
// does not run. A CompareProp is not among them: the group-address flash runs no declared check, an open
// question kept in docs/roadmap.md. A closing step is run (closingSteps); every other such step refuses
// the flash rather than be skipped.
export function unrunGrpSteps(lp: LoadProcedures): { verb: string; detail: string }[] {
  return grpSteps(lp).flatMap((s) => {
    if (s.verb === "LdCtrlCompareProp") return [];
    if (isClosingStep(lp, s) && typeof closingStep(s) !== "string") return [];
    return [{ verb: s.verb, detail: `${s.verb} declared AppliesTo="${s.attrs.AppliesTo}"${s.attrs.PropId !== undefined ? ` to PID ${s.attrs.PropId}` : ""} (not modeled for a group-address flash)` }];
  });
}

// ---- LdCtrlTaskCtrl1 ----
// The task-control declaration, encoded from its declared attributes as ETS sends it: PID 5 03 04, the
// Address (2 bytes) and the Count (1 byte), zero bytes to 10; the same fields in the 0x0104 control on a
// memory-mapped mask. Auro M-0081 (0/0), Theben TheLuxa P300 (17875/1) and Meteodata 140 S (18155/1,
// over 0x0104) captures. A form outside what one byte of Count and two of Address carry is refused.
export interface TaskCtrl1 { lsm: number; address: number; count: number }
export function taskCtrl1Of(s: LdStep): TaskCtrl1 | string {
  const lsm = decimalAttr(s.attrs.LsmIdx), address = decimalAttr(s.attrs.Address), count = decimalAttr(s.attrs.Count);
  const extra = Object.keys(s.attrs).filter((k) => !["LsmIdx", "Address", "Count"].includes(k));
  if (extra.length) return `it declares ${extra.join(", ")}, which no capture shows encoded`;
  if (s.attrs.LsmIdx === undefined || !Number.isInteger(lsm) || lsm < 1 || lsm > 15) return "it names no load-state machine";
  if (s.attrs.Address === undefined || !Number.isInteger(address) || address < 0 || address > 0xffff) return `Address "${s.attrs.Address}" is not a 16-bit address`;
  if (s.attrs.Count === undefined || !Number.isInteger(count) || count < 0 || count > 0xff) return `Count "${s.attrs.Count}" does not fit the one byte the control carries`;
  return { lsm, address, count };
}

// ---- LdCtrlTaskPtr, LdCtrlTaskCtrl2 ----
// The two task declarations, from their declared attributes, each field a 16-bit address (the
// third-party synthetic MV-0705 capture: TaskPtr 17424/17428/17432, TaskCtrl2 17436/17408/1792/17472).
export interface TaskPtr { lsm: number; initPtr: number; savePtr: number; serialPtr: number }
export interface TaskCtrl2 { lsm: number; callback: number; address: number; seg0: number; seg1: number }
// The step's load-state machine and the named attributes, each a 16-bit address, or why they are not.
function addressFields(s: LdStep, names: readonly string[]): { lsm: number; v: Record<string, number> } | string {
  const extra = Object.keys(s.attrs).filter((k) => k !== "LsmIdx" && !names.includes(k));
  if (extra.length) return `it declares ${extra.join(", ")}, which no capture shows encoded`;
  const lsm = decimalAttr(s.attrs.LsmIdx);
  if (s.attrs.LsmIdx === undefined || !Number.isInteger(lsm) || lsm < 1 || lsm > 15) return "it names no load-state machine";
  const v: Record<string, number> = {};
  for (const n of names) {
    const x = decimalAttr(s.attrs[n]);
    if (s.attrs[n] === undefined || !Number.isInteger(x) || x < 0 || x > 0xffff) return `${n} "${s.attrs[n]}" is not a 16-bit address`;
    v[n] = x;
  }
  return { lsm, v };
}
export function taskPtrOf(s: LdStep): TaskPtr | string {
  const r = addressFields(s, ["InitPtr", "SavePtr", "SerialPtr"]);
  return typeof r === "string" ? r : { lsm: r.lsm, initPtr: r.v.InitPtr, savePtr: r.v.SavePtr, serialPtr: r.v.SerialPtr };
}
export function taskCtrl2Of(s: LdStep): TaskCtrl2 | string {
  const r = addressFields(s, ["Callback", "Address", "Seg0", "Seg1"]);
  return typeof r === "string" ? r : { lsm: r.lsm, callback: r.v.Callback, address: r.v.Address, seg0: r.v.Seg0, seg1: r.v.Seg1 };
}

// ---- LdCtrlMasterReset, LdCtrlDelay ----
// A master reset's erase code and channel, each one octet of the A_Restart it sends.
export interface MasterReset { eraseCode: number; channel: number }
// The erase codes the synthetic captures show ETS sending in a download, each with channel 0: 6 and 5 on
// MV-0701 (reset links, reset parameters), 1 and 4 on MV-07B0 (confirmed restart, reset application).
// Another code (a factory reset or an address reset among them, after which the unit no longer answers at
// its address) or channel is refused.
export const CAPTURED_MASTER_RESETS = { system7: [5, 6], systemB: [1, 4] } as const;
export function capturedMasterResetRefusal(r: MasterReset, family: keyof typeof CAPTURED_MASTER_RESETS): string | null {
  const codes: readonly number[] = CAPTURED_MASTER_RESETS[family];
  if (!codes.includes(r.eraseCode) || r.channel !== 0) return `erase code ${r.eraseCode} on channel ${r.channel}, where the captures show ${codes.join(" and ")} on channel 0 on this family`;
  return null;
}
export function masterResetOf(s: LdStep): MasterReset | string {
  const extra = Object.keys(s.attrs).filter((k) => !["EraseCode", "ChannelNumber", "AppliesTo"].includes(k));
  if (extra.length) return `it declares ${extra.join(", ")}, which no capture shows`;
  const eraseCode = decimalAttr(s.attrs.EraseCode), channel = decimalAttr(s.attrs.ChannelNumber);
  if (s.attrs.EraseCode === undefined || !Number.isInteger(eraseCode) || eraseCode < 0 || eraseCode > 0xff) return `EraseCode "${s.attrs.EraseCode}" does not fit the octet the A_Restart carries`;
  if (s.attrs.ChannelNumber === undefined || !Number.isInteger(channel) || channel < 0 || channel > 0xff) return `ChannelNumber "${s.attrs.ChannelNumber}" does not fit the octet the A_Restart carries`;
  return { eraseCode, channel };
}
// A pause on the tool's side: nothing on the wire, the next step that long later (the third-party
// synthetic MV-0701 capture: 200 ms declared, 211 ms between the last LoadCompleted and A_Restart). A
// pause as long as a device's transport-connection timeout (6 s) would have it close the connection; no
// capture shows that, so it is refused.
const DELAY_MAX_MS = 5999;
export function delayOf(s: LdStep): number | string {
  const extra = Object.keys(s.attrs).filter((k) => !["MilliSeconds", "AppliesTo"].includes(k));
  if (extra.length) return `it declares ${extra.join(", ")}, which no capture shows`;
  const ms = decimalAttr(s.attrs.MilliSeconds);
  if (s.attrs.MilliSeconds === undefined || !Number.isInteger(ms) || ms < 0) return `MilliSeconds "${s.attrs.MilliSeconds}" is not a pause in milliseconds`;
  if (ms > DELAY_MAX_MS) return `a pause of ${ms} ms reaches a device's 6 s connection timeout, which no capture shows ETS handling`;
  return ms;
}

export function assessParStep(step: LdStep, model: "absolute" | "relative", lp?: LoadProcedures): ParDisposition {
  // A closing read or write is executed after the last LoadCompleted (closingSteps), on both families.
  const closing = lp !== undefined && isClosingStep(lp, step);
  if (closing) {
    const c = closingStep(step);
    return typeof c === "string" ? { kind: "blocked", detail: `${step.verb}: ${c}` } : { kind: "executed" };
  }
  switch (step.verb) {
    case "LdCtrlConnect":
    case "LdCtrlDisconnect":
      return { kind: "caller" };
    case "LdCtrlRestart":
      return { kind: "executed" };
    case "LdCtrlCompareProp": {
      const start = step.attrs.StartElement;
      // InlineData must be strict hex: Buffer.from(str, "hex") silently truncates at the
      // first invalid pair, which would turn a corrupt declaration into a shorter (and
      // possibly passing) expected value instead of a refusal.
      const hexOk = step.attrs.InlineData !== undefined && /^([0-9A-Fa-f]{2})+$/.test(step.attrs.InlineData);
      if (!hexOk || Number.isNaN(decimalAttr(step.attrs.ObjIdx)) || Number.isNaN(decimalAttr(step.attrs.PropId)) || (start !== undefined && start !== "1")) {
        return { kind: "blocked", detail: `${step.verb} with malformed/missing inline data or element addressing (not modeled)` };
      }
      return { kind: "executed" }; // run as a pre-flight property check
    }
  }
  if (model === "absolute") {
    // A task segment on LSM 5 is skipped below with the others; any other step on it no capture shows.
    if (stepObject(step) === PEI_LSM && step.verb !== "LdCtrlTaskSegment") {
      return { kind: "blocked", detail: `${step.verb} on load-state machine ${PEI_LSM}, which no capture shows` };
    }
    switch (step.verb) {
      case "LdCtrlLoad":
      case "LdCtrlLoadCompleted":
      case "LdCtrlAbsSegment":   // segment->LSM mapping consumed by the planner
      case "LdCtrlWriteAbsMem":  // superseded by the surgical owned-byte write (strictly narrower)
        return { kind: "executed" };
      case "LdCtrlUnload":
        return { kind: "skipped", reason: "full-download erase; a surgical par write must leave loaded segments intact (hw-evidenced on an M-0081 device)" };
      case "LdCtrlTaskSegment":
      case "LdCtrlTaskCtrl1":
        return { kind: "skipped", reason: "full-download task/segment allocation; a par write rewrites no app code (hw-evidenced on an M-0081 device)" };
    }
  } else {
    // The System B base bracket drives exactly ONE segment object: LSM/object 4 (the
    // parameter segment). A fragment step addressed to any other object would be claimed
    // "executed" while the flash never touches it, so scope every executed claim to 4.
    const REL_PARAM_LSM = "4";
    switch (step.verb) {
      case "LdCtrlLoad":
      case "LdCtrlLoadCompleted":
      case "LdCtrlUnload": {
        if (step.attrs.LsmIdx !== undefined && step.attrs.LsmIdx !== REL_PARAM_LSM) {
          return { kind: "blocked", detail: `${step.verb} targets LSM ${step.attrs.LsmIdx}; the System B par download only drives the parameter segment (LSM 4)` };
        }
        return { kind: "executed" }; // the proven System B base bracket drives the LSM cycle
      }
      case "LdCtrlRelSegment": {
        if (step.attrs.LsmIdx !== undefined && step.attrs.LsmIdx !== REL_PARAM_LSM) {
          return { kind: "blocked", detail: `${step.verb} targets LSM ${step.attrs.LsmIdx}; the System B par download only allocates the parameter segment (LSM 4)` };
        }
        // The fill VALUE (0 = zero the segment, 255 = 0xFF/erased-flash, ...) is honored: the full
        // download reads it here (relParamFillByte) and both the allocation and the image
        // write use it, so the un-written regions read back as the fill and the device's own segment
        // CRC still proves the whole image. Only a non-default allocation MODE stays unmodeled.
        if ((step.attrs.Mode ?? "0") !== "0") {
          return { kind: "blocked", detail: `${step.verb} with Mode=${step.attrs.Mode} (non-default allocation mode not modeled)` };
        }
        return { kind: "executed" };
      }
      case "LdCtrlWriteRelMem": {
        if (step.attrs.ObjIdx !== undefined && step.attrs.ObjIdx !== REL_PARAM_LSM) {
          return { kind: "blocked", detail: `${step.verb} targets object ${step.attrs.ObjIdx}; the System B par download only writes the parameter segment (object 4)` };
        }
        return { kind: "executed" }; // the read-back-verified segment write
      }
      case "LdCtrlWriteProp":
        if (decimalAttr(step.attrs.PropId) === MCB_PID) {
          const w = mcbWrite(step);
          return typeof w === "string" ? { kind: "blocked", detail: `${step.verb} to PID 27: ${w}` } : { kind: "executed" };
        }
        return { kind: "blocked", detail: `${step.verb} to PID ${step.attrs.PropId} outside the steps that close the download (not modeled)` };
    }
  }
  return {
    kind: "blocked",
    detail: KNOWN_LD_VERBS.has(step.verb)
      ? `${step.verb} is not modeled for a ${model} par download`
      : `unknown load-control verb ${step.verb}`,
  };
}

// A CompareProp the flash path must execute before writing: read obj/pid and compare
// against the declared value (wrong hardware or application aborts the download).
export interface DeclaredPropCheck { obj: number; pid: number; expect: Buffer; mask?: Buffer; }

export interface ParCoverage {
  blocked: { verb: string; detail: string }[];
  skipped: { verb: string; reason: string }[];
  checks: DeclaredPropCheck[];
}

// The interface object (load-state machine) a step addresses: LsmIdx, else ObjIdx; undefined for a
// step addressed to none (connect, restart, disconnect).
export const stepObject = (s: LdStep): number | undefined =>
  stepNumber(s, "LsmIdx") ?? stepNumber(s, "ObjIdx");

// Assess every par-applicable step of a procedure. The caller must refuse the flash when
// `blocked` is non-empty; `checks` are the CompareProp pre-flights it must run. `objects` narrows
// the assessment to the steps addressed to those interface objects (a write that touches only them).
export function assessParCoverage(lp: LoadProcedures, model: "absolute" | "relative", objects?: ReadonlySet<number>): ParCoverage {
  const blocked: ParCoverage["blocked"] = [];
  const skipped: ParCoverage["skipped"] = [];
  const checks: DeclaredPropCheck[] = [];
  for (const step of flattenSteps(lp, "par")) {
    if (objects) {
      const o = stepObject(step);
      if (o === undefined || !objects.has(o)) continue;
    }
    const d = assessParStep(step, model, lp);
    if (d.kind === "blocked") blocked.push({ verb: step.verb, detail: d.detail });
    else if (d.kind === "skipped") skipped.push({ verb: step.verb, reason: d.reason });
    else if (step.verb === "LdCtrlCompareProp") checks.push(comparePropCheck(step));
  }
  return { blocked, skipped, checks };
}

// The PEI program's load-state machine on System B: interface object 5 on MV-07B0.
export const PEI_LSM = 5;

// Every step a System B full download applies, held to a disposition as the parameter download's are
// (assessParStep): the download runs the mask's base bracket parameterized by them, and a step it does
// not run must refuse it, not vanish. The one step of its own is the parameter segment's allocation for
// the full download (LdCtrlRelSegment on LSM 4, whose Mode and Fill relParamFullMode and relParamFillByte
// read; Mode 1, filled, or Mode 0, unfilled, which relativeFullDownloadRefusal holds to the segment
// ETS's captures show it with; any other mode, and two allocations of different modes, are refused). The
// checks it runs are the parameter download's (assessParCoverage), so a CompareProp declared for the full
// download alone is refused. An unload of the PEI program (LSM 5) is the base bracket's own first step (rule R9); any other
// step on it is refused with PEI_PROGRAM_UNSUPPORTED: no ETS capture shows a System B download that loads it.
// A master reset runs right after the parameter segment's allocation, where the synthetic captures show it
// (isAfterParamAllocation, systemBMasterResets), with an erase code they show; anywhere else, with another
// code, in a Data Secure application and with ETS's partial form, it is refused.
export function relativeFullStepRefusal(lp: LoadProcedures): StepRefusal | null {
  let allocMode: string | undefined;
  for (const s of flattenSteps(lp, "full")) {
    if (s.verb === "LdCtrlMasterReset") {
      const r = masterResetOf(s);
      const why = typeof r === "string" ? r : capturedMasterResetRefusal(r, "systemB");
      if (why) return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares LdCtrlMasterReset ${JSON.stringify(s.attrs)}: ${why}; refusing to guess what it does` };
      if (lp.secureEnabled) return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: "the load procedure declares LdCtrlMasterReset in a Data Secure application; no capture shows a master reset on a secured connection, refusing to run it" };
      if (!isAfterParamAllocation(lp, s)) return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares LdCtrlMasterReset elsewhere than right after the parameter segment's allocation, where the ETS captures show it on System B; refusing to place it` };
      if (lp.preferPartialIfLoaded) return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: "the load procedure declares LdCtrlMasterReset in an application that asks for ETS's partial form on a unit that holds it; no capture shows that form with a master reset, refusing to run it without one" };
      continue;
    }
    if (s.verb === "LdCtrlCompareProp") {
      if (stepApplies(s, "par")) continue;
      return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares an LdCtrlCompareProp for the full download alone (${JSON.stringify(s.attrs)}); the System B full download runs the checks the parameter download declares, refusing to skip this one` };
    }
    if (stepObject(s) === PEI_LSM) {
      if (s.verb === "LdCtrlUnload") continue;
      return { code: "PEI_PROGRAM_UNSUPPORTED", message: `the load procedure declares ${s.verb} on the PEI program (load-state machine ${PEI_LSM}) for the full download; no ETS capture shows a System B download that loads that program, refusing to run the step or to leave it out` };
    }
    if (s.verb === "LdCtrlRelSegment" && (s.attrs.LsmIdx ?? "4") === "4") {
      const mode = s.attrs.Mode ?? "0";
      if (allocMode !== undefined && mode !== allocMode) {
        return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the full download allocates the parameter segment twice, with LdCtrlRelSegment Mode=${allocMode} and Mode=${mode}; no ETS capture shows such a procedure, refusing to pick one` };
      }
      allocMode = mode;
      if (mode === "1" || mode === "0") continue;
      return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the full download allocates the parameter segment with LdCtrlRelSegment Mode=${mode}; no ETS capture shows a download with an allocation of that mode, refusing to guess what it sends` };
    }
    const d = assessParStep(s, "relative", lp);
    if (d.kind === "blocked") return { code: "FULL_DOWNLOAD_STEP_UNSUPPORTED", message: `the load procedure declares a step the full download cannot execute yet (${d.detail}); refusing to run a partial recipe` };
  }
  return null;
}

// Whether `step` follows the full download's allocation of the parameter segment (LdCtrlRelSegment on LSM 4)
// in the same merge block, with nothing but master resets between: where the System B captures show ETS
// sending a master reset (syn-master-reset, -code4: MergeId 2, right after that allocation, before the
// tables' brackets). Another merge block is merged at another point of the mask's procedure.
function isAfterParamAllocation(lp: LoadProcedures, step: LdStep): boolean {
  const block = lp.blocks.find((b) => b.steps.includes(step));
  if (!block) return false;
  const steps = block.steps.filter((x) => stepApplies(x, "full"));
  for (let k = steps.indexOf(step) - 1; k >= 0; k--) {
    if (steps[k].verb === "LdCtrlMasterReset") continue;
    return steps[k].verb === "LdCtrlRelSegment" && (steps[k].attrs.LsmIdx ?? "4") === "4";
  }
  return false;
}

// The master resets a System B full download sends right after the parameter segment's allocation, in
// declared order (relativeFullStepRefusal holds them to that place).
// `mask`: the device's, which it must answer with after each.
export function systemBMasterResets(lp: LoadProcedures, mask: string): (MasterReset & { mask: string })[] {
  return flattenSteps(lp, "full").filter((s) => s.verb === "LdCtrlMasterReset").map((s) => {
    const r = masterResetOf(s);
    const why = typeof r === "string" ? r : capturedMasterResetRefusal(r, "systemB");
    if (typeof r === "string" || why) throw new ProductError("FULL_DOWNLOAD_STEP_UNSUPPORTED", `the load procedure declares LdCtrlMasterReset ${JSON.stringify(s.attrs)}: ${why}`);
    return { ...r, mask };
  });
}

// The parameter download's coverage as the System B full download is held to it: its checks, and every
// step it refuses but a master reset, which the full download runs itself (relativeFullStepRefusal). The
// parameter download keeps refusing a master reset: no capture shows ETS's parameter download of such an
// application.
export function fullDownloadParCoverage(lp: LoadProcedures): ParCoverage {
  const c = assessParCoverage(lp, "relative");
  return { ...c, blocked: c.blocked.filter((b) => b.verb !== "LdCtrlMasterReset") };
}

// Build the app-id / hardware pre-flight a single LdCtrlCompareProp step declares. The Mask
// selects which InlineData bytes must match (e.g. ABB's 0000FFFF00 checks only the application
// number, ignoring manufacturer + version); honoured only as strict hex, else a full-byte compare
// (the stricter fallback). Malformed inline data / addressing throws rather than silently
// truncating to a shorter (and possibly passing) expected value.
function comparePropCheck(step: LdStep): DeclaredPropCheck {
  const obj = decimalAttr(step.attrs.ObjIdx), pid = decimalAttr(step.attrs.PropId);
  if (!/^([0-9A-Fa-f]{2})+$/.test(step.attrs.InlineData ?? "") || Number.isNaN(obj) || Number.isNaN(pid)) {
    throw new ProductError("LOAD_STEP_UNSUPPORTED", `an LdCtrlCompareProp step has malformed/missing inline data or addressing (${JSON.stringify(step.attrs)}); refusing to run its check blind`);
  }
  const maskHex = step.attrs.Mask;
  const mask = maskHex !== undefined && /^([0-9A-Fa-f]{2})+$/.test(maskHex) ? Buffer.from(maskHex, "hex") : undefined;
  return { obj, pid, expect: Buffer.from(step.attrs.InlineData, "hex"), mask };
}

// The CompareProp pre-flights a given load OP declares. A full download must source these from its
// OWN "full" steps, not the "par" steps assessParCoverage walks: a CompareProp declared
// AppliesTo="full" would otherwise be missed and the app-id guard silently skipped.
export function declaredPropChecks(lp: LoadProcedures, op: LoadOp): DeclaredPropCheck[] {
  return flattenSteps(lp, op).filter((s) => s.verb === "LdCtrlCompareProp").map(comparePropCheck);
}
