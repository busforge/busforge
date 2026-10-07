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
  return { style, ...(appId !== undefined ? { app: appId } : {}), blocks, verbs: [...verbs].sort(), unknown: [...unknown].sort() };
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
// as ETS writes them (declaredMcbWrites). ETS 6 sends no
// property write for the declared LdCtrlLoadImageProp to PID 27 (Jung capture, 2026-09-25): the
// device computes the CRC itself. On an absolute device a declared write to PID 27 blocks, and a
// declared LdCtrlLoadImageProp is a read of it where an ETS capture of the application shows that
// (ETS_CAPTURED_SYSTEM7_APPS below); elsewhere it blocks.
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

// Declared property writes whose effect is not known, run only because an ETS capture shows ETS 6
// sending exactly this write to a device of exactly this application, after every LoadCompleted and
// right before the restart, and the device echoing it. The verb class stays blocked: a manufacturer
// property means whatever that firmware makes of it, so one application's capture says nothing about
// another's, nor about a different value or object.
interface CapturedClosingWrite { app: string; obj: number; pid: number; data: string; ops: readonly ClosingOp[] }
const ETS_CAPTURED_CLOSING_WRITES: readonly CapturedClosingWrite[] = [
  // GVS AMMA-04/06.S, declared AppliesTo="all" Verify="true". Private corpus:
  // captures/gvs-amma-ets-fulldownload-defaults.log (full download) and
  // captures/gvs-amma-ets-partial-links.log (partial download of parameters and links, which also
  // reloads object 4). No capture of a links-only download exists; "grp" rests on the declared "all"
  // and on that partial download ending with the write.
  { app: "M-0085_A-0072-30-69AA", obj: 4, pid: 67, data: "01", ops: ["full", "par", "grp"] },
];

// The downloads a closing write is run in. "grp" is the group-address flash; a step reaches it only by
// naming "grp" or "all", since what ETS's "auto" means for a group-table download is not shown.
export type ClosingOp = LoadOp | "grp";

function capturedClosingWrite(step: LdStep, app: string | undefined): CapturedClosingWrite | undefined {
  if (step.verb !== "LdCtrlWriteProp" || app === undefined) return undefined;
  const a = step.attrs;
  return ETS_CAPTURED_CLOSING_WRITES.find((w) => w.app === app && a.ObjIdx === String(w.obj) && a.PropId === String(w.pid)
    && a.InlineData?.toLowerCase() === w.data && a.Verify === "true" && (a.StartElement ?? "1") === "1" && (a.Count ?? "1") === "1");
}

// A property write a download ends with: written after every LoadCompleted, right before the restart,
// and the device's echo must equal the data (the step's Verify="true").
export interface ClosingPropWrite { obj: number; pid: number; data: Buffer }

// The captured closing writes a procedure declares for one download, in declaration order.
export function closingPropWrites(lp: LoadProcedures, op: ClosingOp): ClosingPropWrite[] {
  const steps = op === "grp" ? grpSteps(lp) : flattenSteps(lp, op);
  return steps.flatMap((s) => {
    const w = capturedClosingWrite(s, lp.app);
    return w && w.ops.includes(op) ? [{ obj: w.obj, pid: w.pid, data: Buffer.from(w.data, "hex") }] : [];
  });
}

const grpSteps = (lp: LoadProcedures): LdStep[] =>
  orderedSteps(lp).filter((s) => (s.attrs.AppliesTo ?? "").split(",").map((x) => x.trim()).some((x) => x === "grp" || x === "all"));

// The steps a procedure names for a group-table download ("grp" or "all") that the System B
// group-address flash does not run. A CompareProp is not among them: the group-address flash runs no
// declared check, an open question kept in docs/roadmap.md. Every other such step, a property
// write without a capture above included, refuses the flash rather than be skipped.
export function unrunGrpSteps(lp: LoadProcedures): { verb: string; detail: string }[] {
  return grpSteps(lp).flatMap((s) => {
    if (s.verb === "LdCtrlCompareProp") return [];
    if (capturedClosingWrite(s, lp.app)?.ops.includes("grp")) return [];
    return [{ verb: s.verb, detail: `${s.verb} declared AppliesTo="${s.attrs.AppliesTo}"${s.attrs.PropId !== undefined ? ` to PID ${s.attrs.PropId}` : ""} (not modeled for a group-address flash)` }];
  });
}

// ---- System 7 applications whose downloads ETS 6 is captured running ----
// For these, what ETS sends is not the declared procedure step by step, and Busforge sends what the
// captures show instead (load-procedures.md, "ETS-captured System 7 downloads"). The Gira Tastsensor 3
// Komfort (DynamicTableManagement="true"), 2026-10-06, private corpus
// captures/gira-m0008-ets-{fulldownload,partial-params,partial-links,partial-revert,fulldownload-restore}.log
// with ETS's own log of each step beside them:
//   - the address and association tables are re-declared at their built size: the address table's
//     segment as long as the table, the association table's directly behind it with the rest of the
//     two declared segments (LdCtrlAbsSegment 16384+17 and 16401+467 for declared 16384+243 and
//     16627+241), each unloaded first;
//   - the application (LSM 3) is not unloaded and its segments are not declared again: it is loaded,
//     its data segments written, and completed (no LdCtrlTaskSegment, LdCtrlTaskCtrl1 or RAM segment);
//   - LdCtrlLoadImageProp is a property READ of PID 27 (one element, or Count of them) after the last
//     LoadCompleted; nothing is written for it;
//   - the declared LdCtrlTaskSegment LsmIdx 5 after the restart is not sent.
// Every one of the five downloads did so on a device that held this application. What ETS sends to a
// device that does not is not shown, so that full download is refused (System7Profile.downloadFull).
export const ETS_CAPTURED_SYSTEM7_APPS: readonly string[] = ["M-0008_A-10D7-11-2783-O000A"];
export const etsCapturedSystem7 = (lp: Pick<LoadProcedures, "app">): boolean => lp.app !== undefined && ETS_CAPTURED_SYSTEM7_APPS.includes(lp.app);

// ---- System 7 applications ETS 6 is captured downloading in their declared order ----
// For these, ETS runs the full download's declared steps one by one, in the order the procedure
// declares them (load-procedures.md, "Declared-order System 7 downloads"). The Auro presence detector
// (M-0081_A-FE01-11-75D9, house unit), private corpus
// captures/auro-m0081-ets-fulldownload.log and captures/auro-m0081-ets-partial-params.log, and the
// Theben TheLuxa P300 (M-0048_A-107E-12-5B58, house unit),
// captures/theluxa-p300-ets-{fulldownload,partial-params,partial-links,partial-revert}.log, and the
// Theben Meteodata 140 S (M-0048_A-140C-14-EB70, MV-0701, house unit),
// captures/meteodata-140s-ets-{fulldownload,partial-params,partial-links,partial-revert}.log, with ETS's
// own log of each step beside them (*-ets6log-*.txt):
//   - every LdCtrlAbsSegment and LdCtrlTaskSegment is the load-state machine's PID 5 write (the 0x0104
//     memory write on the memory-mapped MV-0701), and a segment's memory writes follow its declaration;
//   - LdCtrlTaskCtrl1 is the PID 5 write 03 04, the declared Address (2 bytes) and Count (1 byte), and
//     zero bytes to 10 (on MV-0701 the same fields in the 0x0104 control), which the device answers
//     LOADING; only the form each capture shows is run (ETS_DECLARED_ORDER_TASK_CTRL1);
//   - of a segment that declares a <Mask>, ETS writes the bytes the mask marks and the bytes a
//     parameter's memory covers, of a table only those inside its built length; a segment without a
//     <Mask> it writes whole, one without <Data>, or whose <Mask> marks nothing, not at all.
// The TheLuxa's and the Meteodata's tables are re-declared as the Gira's are (ETS_REGION_TABLES_SYSTEM7_APPS).
// Each full download ran on a device that held the application, loaded; what ETS sends to one that
// does not is not shown, so that full download is refused (System7Profile.downloadFull).
export const ETS_DECLARED_ORDER_SYSTEM7_APPS: readonly string[] = ["M-0081_A-FE01-11-75D9", "M-0048_A-107E-12-5B58", "M-0048_A-140C-14-EB70"];
export const etsDeclaredOrderSystem7 = (lp: Pick<LoadProcedures, "app">): boolean => lp.app !== undefined && ETS_DECLARED_ORDER_SYSTEM7_APPS.includes(lp.app);

// The LdCtrlTaskCtrl1 each declared-order application's capture shows ETS sending, as declared:
// auro-m0081-ets-fulldownload.log (PID 5 03 04 00 00 00 ...) and theluxa-p300-ets-fulldownload.log
// (PID 5 03 04 45 D3 01 00 ..., the TheLuxa's task-control block at 0x45D3 in its com-object table's
// segment) and meteodata-140s-ets-fulldownload.log (0x0104 33 04 00 46 EB 01 00 ..., the Meteodata's at
// 0x46EB behind its com-object table). Any other declaration refuses the full download.
export const ETS_DECLARED_ORDER_TASK_CTRL1: Readonly<Record<string, { LsmIdx: string; Address: string; Count: string }>> = {
  "M-0081_A-FE01-11-75D9": { LsmIdx: "3", Address: "0", Count: "0" },
  "M-0048_A-107E-12-5B58": { LsmIdx: "3", Address: "17875", Count: "1" },
  "M-0048_A-140C-14-EB70": { LsmIdx: "3", Address: "18155", Count: "1" },
};

// ---- System 7 applications whose group tables ETS re-declares as one region ----
// For these, ETS does not declare the address and association tables' segments as the procedure does:
// it takes the two declared segments as one region, declares the address table's segment exactly as
// long as the table and the association table's directly behind it with the rest, in the full and in
// every group-address download, and writes the associations in its own order (grouptables.ts,
// "ets-captured"). Gira M-0008 (gira-m0008-ets-*.log: 16384+17 and 16401+467 for declared 16384+243
// and 16627+241), Theben TheLuxa P300 (theluxa-p300-ets-*.log: 16384+9 and 16393+1011 for declared
// 16384+511 and 16895+509) and Theben Meteodata 140 S (meteodata-140s-ets-*.log: 16384+41 and 16425+983
// for declared 16384+513 and 16897+511). All three declare DynamicTableManagement="true"; the Auro, which
// ETS declares as the procedure does, declares it "false".
export const ETS_REGION_TABLES_SYSTEM7_APPS: readonly string[] = ["M-0008_A-10D7-11-2783-O000A", "M-0048_A-107E-12-5B58", "M-0048_A-140C-14-EB70"];
export const etsRegionTablesSystem7 = (lp: Pick<LoadProcedures, "app">): boolean => lp.app !== undefined && ETS_REGION_TABLES_SYSTEM7_APPS.includes(lp.app);

// Applications of ETS_REGION_TABLES_SYSTEM7_APPS whose table segments carry <Data> bytes behind the tables
// that ETS's full download writes, in the association table's bracket. Only the Theben Meteodata 140 S
// shows it: AS-4000 offsets 511-512 = 00 00, not FF and marked by the <Mask> (meteodata-140s-ets6log-
// fulldownload.txt, "Execute image" rows 01F0/0200; the capture reads them after the association table);
// its group-address downloads leave them out. That is not a rule: the Gira's AS-40F3 offset 0 (78, marked)
// and the TheLuxa's AS-41FF offset 0 (00, no <Mask>) are non-FF <Data> behind their tables too, and ETS
// writes neither. The Meteodata's bytes lie past what its address table can hold (3 + 2 x 254 = 511 bytes),
// theirs at the association segment's first byte; which of these ETS keys on is not shown (docs/roadmap.md).
export const ETS_TABLE_SEGMENT_DATA_SYSTEM7_APPS: readonly string[] = ["M-0048_A-140C-14-EB70"];
export const etsTableSegmentDataSystem7 = (lp: Pick<LoadProcedures, "app">): boolean => lp.app !== undefined && ETS_TABLE_SEGMENT_DATA_SYSTEM7_APPS.includes(lp.app);

// The PID 27 reads the declared LdCtrlLoadImageProp steps become on a captured application, in
// declaration order; none elsewhere. ETS keeps the answers to skip identical bytes in its next
// download, which Busforge does not do (it reads the device instead), so they are only required to
// arrive.
export interface StampRead { obj: number; pid: number; start: number }
export function imageStampReads(lp: LoadProcedures): StampRead[] {
  if (!etsCapturedSystem7(lp)) return [];
  return flattenSteps(lp, "full").filter((s) => s.verb === "LdCtrlLoadImageProp").flatMap((s) => {
    const obj = Number(s.attrs.ObjIdx), pid = Number(s.attrs.PropId), count = Number(s.attrs.Count ?? 1);
    if (!Number.isInteger(obj) || pid !== MCB_PID || !Number.isInteger(count) || count < 1 || count > 15) {
      throw new ProductError("LOAD_STEP_UNSUPPORTED", `${s.verb} ${JSON.stringify(s.attrs)} is not the PID 27 read the ETS captures show; refusing to guess what it reads`);
    }
    return Array.from({ length: count }, (_, i) => ({ obj, pid, start: i + 1 }));
  });
}

export function assessParStep(step: LdStep, model: "absolute" | "relative", app?: string): ParDisposition {
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
      case "LdCtrlLoadImageProp":
        // The stamp read after the last LoadCompleted (imageStampReads), where an ETS capture shows it.
        if (app !== undefined && etsCapturedSystem7({ app }) && Number(step.attrs.PropId) === MCB_PID) return { kind: "executed" };
        break;
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
        // Run at the end of the bracket (closingPropWrites), as the ETS capture shows it.
        if (capturedClosingWrite(step, app)?.ops.includes("par")) return { kind: "executed" };
        return { kind: "blocked", detail: `${step.verb} to PID ${step.attrs.PropId} (side effect unknown)` };
      case "LdCtrlLoadImageProp":
        if (Number(step.attrs.PropId) === MCB_PID) {
          return { kind: "skipped", reason: "MCB CRC from the image (PID 27): ETS 6 sends no property write for it, the device computes the CRC" };
        }
        return { kind: "blocked", detail: `${step.verb} to PID ${step.attrs.PropId} (side effect unknown)` };
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
    const d = assessParStep(step, model, lp.app);
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
