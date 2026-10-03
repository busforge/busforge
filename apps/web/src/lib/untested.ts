import type { DeviceConfigView, MatrixOperation, OperationVerdict } from "../api.ts";

// Operations of `ops` this device's Product has not been tested for on hardware. Empty when all are
// tested, the user acknowledged the Product for this project, or the server attached no matrix
// (then it does not gate the write either).
export function untestedOps(view: Pick<DeviceConfigView, "compatibility" | "untestedAcknowledged"> | undefined, ops: MatrixOperation[]): MatrixOperation[] {
  if (!view?.compatibility || view.untestedAcknowledged) return [];
  return ops.filter((op) => view.compatibility![op].state !== "tested" && view.compatibility![op].state !== "refused");
}

// Operations of `ops` that failed or gave contradictory results on this Product. Shown even after the
// acknowledgement: the acknowledgement covers "untested", it does not make a failure on hardware news
// the user has already seen.
export function failedOps(view: Pick<DeviceConfigView, "compatibility"> | undefined, ops: MatrixOperation[]): MatrixOperation[] {
  if (!view?.compatibility) return [];
  return ops.filter((op) => view.compatibility![op].state === "failed" || view.compatibility![op].state === "conflict");
}

export const MATRIX_OPS: MatrixOperation[] = ["readParams", "readLinks", "flashParams", "flashLinks", "fullDownload", "structuralFlash"];

export type Summary = "tested" | "partial" | "failed" | "derived" | "untested" | "unsupported";
// One word for the device, the worst fact first: a failure or conflict anywhere outranks any pass.
// Refused operations are left out ("tested" means every supported one); a device that supports none
// says so instead of "untested". "derived" only when every supported operation is.
export function summarize(c: Record<MatrixOperation, OperationVerdict>): Summary {
  const offered = MATRIX_OPS.map((op) => c[op].state).filter((s) => s !== "refused");
  if (offered.length === 0) return "unsupported";
  if (offered.some((s) => s === "failed" || s === "conflict")) return "failed";
  if (offered.every((s) => s === "tested")) return "tested";
  if (offered.some((s) => s === "tested")) return "partial";
  if (offered.every((s) => s === "derived")) return "derived";
  return "untested";
}

// "M-0004_H-…_P-400021SE" -> "400021SE": KNX ids escape characters as .XX hex.
export const orderOf = (productRef: string) => (productRef.split("_P-")[1] ?? productRef).replace(/\.([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
