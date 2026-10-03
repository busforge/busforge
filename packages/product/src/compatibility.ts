import { ProductError } from "./errors.ts";
import type { DeviceCapabilities } from "./config.ts";
import { cellState, type AxisState, type EvidenceAxis, type EvidenceRecord } from "./evidence.ts";

// The compatibility matrix (docs/evidence-contract.md): for each Product running one application
// program, and each operation, what Busforge may attempt (capabilities, computed from the catalog)
// and what was shown on hardware (evidence records of that Product only). Evidence of another
// Product never raises a state; on the same Hardware with the same application program version it
// yields `derived`, which never counts as tested.

export type MatrixOperation = keyof DeviceCapabilities;
export const MATRIX_OPERATIONS: readonly MatrixOperation[] = ["readParams", "readLinks", "flashParams", "flashLinks", "fullDownload", "structuralFlash"];
// "Tested" needs the api and, where the UI offers the operation, the ui channel (contract, "Per
// owned Product"). The UI offers every matrix operation, so both are required for all of them.
const CHANNELS = ["api", "ui"] as const;
type Channel = (typeof CHANNELS)[number];
const AXES: EvidenceAxis[] = ["transfer", "reference", "behaviour", "persistence"];

export type OperationState = "tested" | "failed" | "conflict" | "derived" | "eligible" | "refused";

export interface MatrixCell { state: AxisState | "conflict"; basis: string[] }
export interface OperationVerdict {
  state: OperationState;
  // The Product's own cells per channel and axis; empty when it has no records for the operation.
  cells: Partial<Record<Channel | "tool", Record<EvidenceAxis, MatrixCell>>>;
  // Firmware the deciding transfer records were taken on ("unknown" where none was observed); for
  // `derived`, those of the sibling it is derived from.
  firmware: string[];
  // `derived`: the Product on the same Hardware whose operation was tested.
  derivedFrom?: string;
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

const ownKey = (productRef: string, appProgramId: string) => `${productRef}|${appProgramId}`;

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
// siblings for `derived` and the same-application hint: a record naming a Product the caller does
// not know (a typo, an uncatalogued id) raises nothing.
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
    const own = byOwner.get(ownKey(productRef, appProgramId)) ?? [];
    const operations = {} as Record<MatrixOperation, OperationVerdict>;
    for (const op of MATRIX_OPERATIONS) {
      const { cells, firmware, transfer } = ownVerdict(own, op);
      const others = (tested.get(op) ?? []).filter((t) => t.appProgramId === appProgramId && t.productRef !== productRef)
        .sort((a, b) => a.productRef.localeCompare(b.productRef));
      const sibling = others.find((t) => hardwareOf(t.productRef) === hardwareRef);
      const otherHardware = others.find((t) => hardwareOf(t.productRef) !== hardwareRef)?.productRef;
      const verdict: OperationVerdict = { state: "eligible", cells, firmware };
      // Evidence stays visible after a policy refusal, but cannot make a refused operation tested.
      const shown = stateFromTransfer(transfer);
      if (!capabilities[op]) verdict.state = "refused";
      else if (shown) verdict.state = shown;
      else if (sibling) { verdict.state = "derived"; verdict.derivedFrom = sibling.productRef; verdict.firmware = sibling.firmware; }
      if (verdict.state === "eligible" && otherHardware) verdict.sameAppTestedOn = otherHardware;
      operations[op] = verdict;
    }
    return { productRef, hardwareRef, appProgramId, operations };
  });
}
