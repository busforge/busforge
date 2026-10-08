import { XMLParser } from "fast-xml-parser";
import { type ONode, tagOf, attrsOf, kidsOf, childrenByTag } from "./onode.ts";
import { ProductError } from "./errors.ts";

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
  preferPartialIfLoaded: boolean;
  dynamicTables: boolean;
  secureEnabled: boolean;
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
    blocks.push({ mergeId: mergeId !== undefined ? Number(mergeId) : undefined, steps });
  }
  return {
    style, ...(appId !== undefined ? { app: appId } : {}), blocks, verbs: [...verbs].sort(), unknown: [...unknown].sort(),
    preferPartialIfLoaded: (options ? attrsOf(options).PreferPartialDownloadIfApplicationLoaded : undefined) === "true",
    dynamicTables: appAttrs.DynamicTableManagement === "true",
    secureEnabled: appAttrs.IsSecureEnabled === "true",
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
  return [...lp.blocks].sort((a, b) => (a.mergeId ?? 0) - (b.mergeId ?? 0)).flatMap((b) => b.steps);
}

// The byte the device is asked to pre-fill the parameter segment (LSM 4) with, from the full
// download's LdCtrlRelSegment step. Most System B devices declare 0 (zero the segment); some declare
// 255 (0xFF, the erased-flash state). The full download must allocate with this value AND treat it as
// the "already there" byte when sparsing the image, or the un-written regions read back wrong. 0 when
// the procedure declares no relative parameter allocation (the safe default, and the historical one).
export function relParamFillByte(lp: LoadProcedures): number {
  const rel = flattenSteps(lp, "full").filter((s) => s.verb === "LdCtrlRelSegment");
  const seg = rel.find((s) => s.attrs.LsmIdx === "4") ?? rel.find((s) => s.attrs.LsmIdx === undefined);
  return seg ? Number(seg.attrs.Fill ?? 0) & 0xff : 0;
}

// ---- typed attribute accessors (the fields the executor reads) ----
export const lsmIdx = (s: LdStep): number | undefined => (s.attrs.LsmIdx !== undefined ? Number(s.attrs.LsmIdx) : undefined);
export const stepAddress = (s: LdStep): number | undefined => (s.attrs.Address !== undefined ? Number(s.attrs.Address) : undefined);
export const stepSize = (s: LdStep): number | undefined => (s.attrs.Size !== undefined ? Number(s.attrs.Size) : undefined);
export const memType = (s: LdStep): number | undefined => (s.attrs.MemType !== undefined ? Number(s.attrs.MemType) : undefined);
export const segType = (s: LdStep): number => (s.attrs.SegType !== undefined ? Number(s.attrs.SegType) : 0);
export const segAccess = (s: LdStep): number => (s.attrs.Access !== undefined ? Number(s.attrs.Access) : 0);
export const segFlags = (s: LdStep): number => (s.attrs.SegFlags !== undefined ? Number(s.attrs.SegFlags) : 0);

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
  if (Number(step.attrs.ObjIdx) !== MCB_OBJ) return `it targets object ${step.attrs.ObjIdx}; only the parameter segment (object ${MCB_OBJ}) is known to carry declared regions`;
  const element = Number(step.attrs.StartElement ?? 1);
  if (!Number.isInteger(element) || element < 1 || element > 4095) return `StartElement "${step.attrs.StartElement}" is not an element index`;
  if (step.attrs.Count !== undefined && step.attrs.Count !== "1") return `Count="${step.attrs.Count}" writes more than one entry`;
  return { obj: MCB_OBJ, element, data: data.subarray(0, MCB_ENTRY_BYTES), ...(step.attrs.Verify === "false" ? { echoPrefix: 4 } : {}) };
}

// The MCB entries a System B application declares for one download, in declaration order. Their
// regions must cover the parameter segment exactly: regions that do not add up to the allocation
// would have the device check the wrong bytes at boot.
export function declaredMcbWrites(lp: LoadProcedures, segmentSize: number, op: LoadOp = "full"): McbWrite[] {
  const writes = flattenSteps(lp, op)
    .filter((s) => s.verb === "LdCtrlWriteProp" && Number(s.attrs.PropId) === MCB_PID)
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
const isClosingVerb = (s: LdStep) => s.verb === "LdCtrlLoadImageProp" || (s.verb === "LdCtrlWriteProp" && Number(s.attrs.PropId) !== MCB_PID);

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
  return closingCandidates(lp).filter((s) => isClosingVerb(s) && closingApplies(s, op)).map((s) => {
    const r = closingStep(s);
    if (typeof r === "string") throw new ProductError("LOAD_STEP_UNSUPPORTED", `the load procedure closes with ${s.verb} ${JSON.stringify(s.attrs)}, which cannot be executed as declared: ${r}`);
    return r;
  });
}

function closingStep(s: LdStep): ClosingStep | string {
  const obj = Number(s.attrs.ObjIdx), pid = Number(s.attrs.PropId), start = Number(s.attrs.StartElement ?? 1), count = Number(s.attrs.Count ?? 1);
  if (s.attrs.ObjIdx === undefined || !Number.isInteger(obj) || obj < 0 || obj > 255) return "it names no object index";
  if (s.attrs.PropId === undefined || !Number.isInteger(pid) || pid < 1 || pid > 255) return "it names no property";
  if (!Number.isInteger(start) || start < 1 || start > 4095) return `StartElement "${s.attrs.StartElement}" is not an element index`;
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
  const lsm = Number(s.attrs.LsmIdx), address = Number(s.attrs.Address), count = Number(s.attrs.Count);
  const extra = Object.keys(s.attrs).filter((k) => !["LsmIdx", "Address", "Count"].includes(k));
  if (extra.length) return `it declares ${extra.join(", ")}, which no capture shows encoded`;
  if (s.attrs.LsmIdx === undefined || !Number.isInteger(lsm) || lsm < 1 || lsm > 15) return "it names no load-state machine";
  if (s.attrs.Address === undefined || !Number.isInteger(address) || address < 0 || address > 0xffff) return `Address "${s.attrs.Address}" is not a 16-bit address`;
  if (s.attrs.Count === undefined || !Number.isInteger(count) || count < 0 || count > 0xff) return `Count "${s.attrs.Count}" does not fit the one byte the control carries`;
  return { lsm, address, count };
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
      if (!hexOk || step.attrs.ObjIdx === undefined || step.attrs.PropId === undefined || (start !== undefined && start !== "1")) {
        return { kind: "blocked", detail: `${step.verb} with malformed/missing inline data or element addressing (not modeled)` };
      }
      return { kind: "executed" }; // run as a pre-flight property check
    }
  }
  if (model === "absolute") {
    switch (step.verb) {
      case "LdCtrlLoad":
      case "LdCtrlLoadCompleted":
      case "LdCtrlAbsSegment":   // segment->LSM mapping consumed by the planner
      case "LdCtrlWriteAbsMem":  // superseded by the surgical owned-byte write (strictly narrower)
        return { kind: "executed" };
      case "LdCtrlUnload":
        return { kind: "skipped", reason: "full-download erase; a surgical par write must leave loaded segments intact (hw-evidenced, M-0081)" };
      case "LdCtrlTaskSegment":
      case "LdCtrlTaskCtrl1":
        return { kind: "skipped", reason: "full-download task/segment allocation; a par write rewrites no app code (hw-evidenced, M-0081)" };
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
        // download reads it here (relParamFillByte) and both the allocation and the sparse image
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
        if (Number(step.attrs.PropId) === MCB_PID) {
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
  s.attrs.LsmIdx !== undefined ? Number(s.attrs.LsmIdx) : s.attrs.ObjIdx !== undefined ? Number(s.attrs.ObjIdx) : undefined;

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

// Build the app-id / hardware pre-flight a single LdCtrlCompareProp step declares. The Mask
// selects which InlineData bytes must match (e.g. ABB's 0000FFFF00 checks only the application
// number, ignoring manufacturer + version); honoured only as strict hex, else a full-byte compare
// (the stricter fallback). Malformed inline data / addressing throws rather than silently
// truncating to a shorter (and possibly passing) expected value.
function comparePropCheck(step: LdStep): DeclaredPropCheck {
  if (!/^([0-9A-Fa-f]{2})+$/.test(step.attrs.InlineData ?? "") || step.attrs.ObjIdx === undefined || step.attrs.PropId === undefined) {
    throw new ProductError("LOAD_STEP_UNSUPPORTED", `an LdCtrlCompareProp step has malformed/missing inline data or addressing (${JSON.stringify(step.attrs)}); refusing to run its check blind`);
  }
  const maskHex = step.attrs.Mask;
  const mask = maskHex !== undefined && /^([0-9A-Fa-f]{2})+$/.test(maskHex) ? Buffer.from(maskHex, "hex") : undefined;
  return { obj: Number(step.attrs.ObjIdx), pid: Number(step.attrs.PropId), expect: Buffer.from(step.attrs.InlineData, "hex"), mask };
}

// The CompareProp pre-flights a given load OP declares. A full download must source these from its
// OWN "full" steps, not the "par" steps assessParCoverage walks: a CompareProp declared
// AppliesTo="full" would otherwise be missed and the app-id guard silently skipped.
export function declaredPropChecks(lp: LoadProcedures, op: LoadOp): DeclaredPropCheck[] {
  return flattenSteps(lp, op).filter((s) => s.verb === "LdCtrlCompareProp").map(comparePropCheck);
}
