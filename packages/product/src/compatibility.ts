import { ProductError } from "./errors.ts";
import type { DeviceCapabilities } from "./config.ts";
import { cellState, parseEvidenceRecord, type AxisState, type EvidenceAxis, type EvidenceRecord } from "./evidence.ts";

// The compatibility matrix (docs/evidence-contract.md): for each Product running one application
// program, and each operation, what Busforge may attempt (capabilities, computed from the catalog)
// and what was shown on hardware (evidence records of that Product only). Evidence of another
// Product never raises a state; on the same Hardware with the same application program version it
// yields `derived`, and another version of the same application program tested on the same Hardware
// yields `otherVersion`. Neither counts as tested.

export type MatrixOperation = keyof DeviceCapabilities;
export const MATRIX_OPERATIONS: readonly MatrixOperation[] = ["readParams", "readLinks", "flashParams", "flashLinks", "fullDownload", "structuralFlash"];
// "Tested" needs the api and, where the UI offers the operation, the ui channel (contract, "Per
// owned Product"). The UI offers every matrix operation, so both are required for all of them.
const CHANNELS = ["api", "ui"] as const;
type Channel = (typeof CHANNELS)[number];
const AXES: EvidenceAxis[] = ["transfer", "reference", "behaviour", "persistence"];

export type OperationState = "tested" | "failed" | "conflict" | "derived" | "otherVersion" | "eligible" | "refused";

export interface MatrixCell { state: AxisState | "conflict"; basis: string[] }
export interface OperationVerdict {
  state: OperationState;
  // The Product's own cells per channel and axis; empty when it has no records for the operation.
  cells: Partial<Record<Channel | "tool", Record<EvidenceAxis, MatrixCell>>>;
  // Firmware the deciding transfer records were taken on ("unknown" where none was observed); for
  // `derived` and `otherVersion`, those of the test they name.
  firmware: string[];
  // `derived`: the Product on the same Hardware whose operation was tested.
  derivedFrom?: string;
  // `otherVersion`: the Product on the same Hardware (this one or a sibling) and the other version of
  // the application program the operation was tested with.
  otherVersionTested?: { productRef: string; appProgramId: string };
  // A hint only, never a state: the same application program version was tested on other Hardware.
  sameAppTestedOn?: string;
}
export interface MatrixProduct { productRef: string; appProgramId: string; capabilities: DeviceCapabilities }
export interface MatrixRow { productRef: string; hardwareRef: string; appProgramId: string; operations: Record<MatrixOperation, OperationVerdict> }

// "M-0004_H-…_P-400021SE" -> "M-0004_H-…": a Product id is its Hardware id plus the order variant.
export function hardwareOf(productRef: string): string {
  const parts = productRef.split("_P-");
  if (parts.length !== 2 || !parts[0].includes("_H-")) throw new ProductError("PRODUCT_REF_INVALID", `${productRef} is not a <Hardware>_P-<Product> id`);
  return parts[0];
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ownKey = (productRef: string, appProgramId: string) => `${productRef}|${appProgramId}`;

// "M-0085_A-0072-30-69AA" -> "M-0085_A-0072": the catalogue id of an application program is its
// manufacturer, application number, version and content hash, with an optional "-O<xxxx>" suffix of
// the OEM it was built for. Two ids that differ only in version or hash are versions of one
// application program. An id outside that form names no application, so it relates to none (null).
const APP_ID = /^(M-[0-9A-F]{4})_A-([0-9A-F]{4})-[0-9A-F]{2}-[0-9A-F]{4}(-O[0-9A-F]{4})?$/;
export function applicationOf(appProgramId: string): string | null {
  const m = APP_ID.exec(appProgramId);
  return m ? `${m[1]}_A-${m[2]}${m[3] ?? ""}` : null;
}

function ownVerdict(records: EvidenceRecord[], op: MatrixOperation): Pick<OperationVerdict, "cells" | "firmware"> & { transfer: Record<Channel | "tool", AxisState | "conflict"> } {
  const cells: OperationVerdict["cells"] = {};
  for (const channel of [...CHANNELS, "tool"] as const) {
    const inCell = records.filter((r) => r.scope.operation === op && r.scope.channel === channel);
    if (inCell.length === 0) continue;
    cells[channel] = Object.fromEntries(AXES.map((axis) => [axis, cellState(inCell, axis)])) as Record<EvidenceAxis, MatrixCell>;
  }
  const transfer = Object.fromEntries([...CHANNELS, "tool"].map((c) => [c, cells[c as Channel | "tool"]?.transfer.state ?? "not-assessed"])) as Record<Channel | "tool", AxisState | "conflict">;
  const byId = new Map(records.map((r) => [r.id, r]));
  const deciding = CHANNELS.flatMap((c) => cells[c]?.transfer.basis ?? []).map((id) => byId.get(id)!);
  const firmware = [...new Set(deciding.map((r) => (r.subject.firmware.state === "observed" ? r.subject.firmware.value : "unknown")))].sort();
  return { cells, firmware, transfer };
}

// A failure or conflict in any channel, the tool's included, is the Product's own and is never
// hidden behind a tested sibling; a pass needs the api and ui channels.
function stateFromTransfer(t: Record<Channel | "tool", AxisState | "conflict">): "tested" | "failed" | "conflict" | null {
  const states = Object.values(t);
  if (states.includes("conflict")) return "conflict";
  if (states.includes("fail")) return "failed";
  if (CHANNELS.every((c) => t[c] === "pass")) return "tested";
  return null;
}

// One row per Product. Records must already be validated (parseEvidenceRecord); one without a
// Product is refused, as it cannot back any cell. Only Products in `products` count as tested
// siblings for `derived`, `otherVersion` and the same-application hint: a record naming a Product
// the caller does not know (a typo, an uncatalogued id) raises nothing.
export function buildMatrix(records: EvidenceRecord[], products: MatrixProduct[]): MatrixRow[] {
  const unattributed = records.find((r) => r.subject.productRef === null);
  if (unattributed) throw new ProductError("EVIDENCE_PRODUCT_UNKNOWN", `${unattributed.id} names no Product, so it cannot back a matrix cell`);
  const byOwner = new Map<string, EvidenceRecord[]>();
  for (const r of records) {
    const k = ownKey(r.subject.productRef!, r.subject.appProgramId);
    byOwner.set(k, [...(byOwner.get(k) ?? []), r]);
  }
  // Which (Product, application) tested which operation, from its own records alone.
  const tested = new Map<MatrixOperation, { productRef: string; appProgramId: string; firmware: string[] }[]>();
  const known = new Set(products.map((p) => ownKey(p.productRef, p.appProgramId)));
  for (const [k, own] of byOwner) {
    if (!known.has(k)) continue;
    const [productRef, appProgramId] = k.split("|");
    for (const op of MATRIX_OPERATIONS) {
      const v = ownVerdict(own, op);
      if (stateFromTransfer(v.transfer) === "tested") tested.set(op, [...(tested.get(op) ?? []), { productRef, appProgramId, firmware: v.firmware }]);
    }
  }

  return products.map(({ productRef, appProgramId, capabilities }) => {
    const hardwareRef = hardwareOf(productRef);
    const application = applicationOf(appProgramId);
    const own = byOwner.get(ownKey(productRef, appProgramId)) ?? [];
    const operations = {} as Record<MatrixOperation, OperationVerdict>;
    for (const op of MATRIX_OPERATIONS) {
      const { cells, firmware, transfer } = ownVerdict(own, op);
      const others = (tested.get(op) ?? []).filter((t) => t.appProgramId === appProgramId && t.productRef !== productRef)
        .sort((a, b) => a.productRef.localeCompare(b.productRef));
      const sibling = others.find((t) => hardwareOf(t.productRef) === hardwareRef);
      const otherHardware = others.find((t) => hardwareOf(t.productRef) !== hardwareRef)?.productRef;
      // Another version on the same Hardware, the Product's own first, then in code-point order so the
      // generated compatibility page names the same one everywhere.
      const version = application === null ? undefined : (tested.get(op) ?? [])
        .filter((t) => t.appProgramId !== appProgramId && applicationOf(t.appProgramId) === application && hardwareOf(t.productRef) === hardwareRef)
        .sort((a, b) => Number(b.productRef === productRef) - Number(a.productRef === productRef) || byCodePoint(a.productRef, b.productRef) || byCodePoint(a.appProgramId, b.appProgramId))[0];
      const verdict: OperationVerdict = { state: "eligible", cells, firmware };
      // Evidence stays visible after a policy refusal, but cannot make a refused operation tested.
      const shown = stateFromTransfer(transfer);
      if (!capabilities[op]) verdict.state = "refused";
      else if (shown) verdict.state = shown;
      else if (sibling) { verdict.state = "derived"; verdict.derivedFrom = sibling.productRef; verdict.firmware = sibling.firmware; }
      else if (version) { verdict.state = "otherVersion"; verdict.otherVersionTested = { productRef: version.productRef, appProgramId: version.appProgramId }; verdict.firmware = version.firmware; }
      if ((verdict.state === "eligible" || verdict.state === "otherVersion") && otherHardware) verdict.sameAppTestedOn = otherHardware;
      operations[op] = verdict;
    }
    return { productRef, hardwareRef, appProgramId, operations };
  });
}

// A set of records that can be shipped as one matrix: ids unique, and every supersession resolves
// inside its own cell to an older record. Checked record by record, so the error names the record
// at fault instead of failing whichever matrix cell happens to meet it first.
export function checkEvidenceSet(records: EvidenceRecord[]): void {
  const cellOf = (r: EvidenceRecord) => [r.subject.productRef, r.subject.appProgramId, r.scope.operation, r.scope.channel].join("|");
  const byId = new Map<string, EvidenceRecord>();
  for (const r of records) {
    if (byId.has(r.id)) throw new ProductError("EVIDENCE_SET_INVALID", `${r.id}: the id occurs twice`);
    byId.set(r.id, r);
  }
  for (const r of records) for (const id of r.supersedes) {
    const old = byId.get(id);
    if (!old) throw new ProductError("EVIDENCE_SET_INVALID", `${r.id}: supersedes ${id}, which is not in the set`);
    if (cellOf(old) !== cellOf(r)) throw new ProductError("EVIDENCE_SET_INVALID", `${r.id}: supersedes ${id} of another cell (${cellOf(old)})`);
    if (r.recordedAt === null || (old.recordedAt !== null && !(Date.parse(r.recordedAt) > Date.parse(old.recordedAt)))) {
      throw new ProductError("EVIDENCE_SET_INVALID", `${r.id}: supersedes ${id} but is not newer than it`);
    }
  }
}

// The evidence shipped with a build: the kept records and the Products they were taken on, each
// with the capabilities its application program had when the bundle was generated.
export const EVIDENCE_BUNDLE_SCHEMA = "busforge.evidence-bundle/1";
export interface EvidenceBundle { schema: typeof EVIDENCE_BUNDLE_SCHEMA; products: MatrixProduct[]; records: EvidenceRecord[] }

export function parseEvidenceBundle(raw: unknown): EvidenceBundle {
  const b = raw as Partial<EvidenceBundle> | null;
  if (!b || typeof b !== "object" || b.schema !== EVIDENCE_BUNDLE_SCHEMA || !Array.isArray(b.products) || !Array.isArray(b.records)) {
    throw new ProductError("EVIDENCE_BUNDLE_INVALID", `not a ${EVIDENCE_BUNDLE_SCHEMA} bundle`);
  }
  const records = b.records.map((r) => parseEvidenceRecord(r));
  const unattributed = records.find((r) => r.subject.productRef === null);
  if (unattributed) throw new ProductError("EVIDENCE_PRODUCT_UNKNOWN", `${unattributed.id} names no Product, so it cannot back a matrix cell`);
  checkEvidenceSet(records);
  const owners = new Set(records.map((r) => `${r.subject.productRef}|${r.subject.appProgramId}`));
  const listed = new Set<string>();
  for (const p of b.products) {
    const k = `${p?.productRef}|${p?.appProgramId}`;
    hardwareOf(String(p?.productRef));
    const exact = (o: object, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((x) => Object.hasOwn(o, x));
    if (typeof p.appProgramId !== "string" || !p.capabilities || !exact(p, ["productRef", "appProgramId", "capabilities"]) || !exact(p.capabilities, MATRIX_OPERATIONS)
      || MATRIX_OPERATIONS.some((op) => typeof p.capabilities[op] !== "boolean")) {
      throw new ProductError("EVIDENCE_BUNDLE_INVALID", `${k}: a bundled Product needs its application program and every capability`);
    }
    if (listed.has(k)) throw new ProductError("EVIDENCE_BUNDLE_INVALID", `${k}: listed twice`);
    listed.add(k);
  }
  const missing = [...owners].find((k) => !listed.has(k));
  if (missing) throw new ProductError("EVIDENCE_BUNDLE_INVALID", `${missing}: has records but is not listed with its capabilities`);
  const idle = [...listed].find((k) => !owners.has(k));
  if (idle) throw new ProductError("EVIDENCE_BUNDLE_INVALID", `${idle}: listed without any record`);
  return { schema: EVIDENCE_BUNDLE_SCHEMA, products: b.products, records };
}
