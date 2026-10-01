import { ProductError } from "./errors.ts";
import type { DeviceCapabilities } from "./config.ts";

// One observation about one product, in the versioned form the compatibility matrix is built from
// (docs/evidence-contract.md). The four result axes are independent on purpose: a device can hold
// exactly the bytes Busforge wrote (transfer) while those bytes encode the wrong configuration
// (reference), do nothing on the bus (behaviour) or be lost at the next power cycle (persistence).
// Nothing here is inferred: a fact the source did not record is null or "unknown", never defaulted.

export const EVIDENCE_SCHEMA = "busforge.evidence/1";

export type EvidenceOperation = keyof DeviceCapabilities | "assignIa" | "provision" | "uiClickThrough";
export type AxisState = "pass" | "fail" | "not-assessed" | "not-applicable";
export type EvidenceAxis = "transfer" | "reference" | "behaviour" | "persistence";
export interface AxisResult { state: AxisState; method?: string; detail?: string }

export type Firmware = { state: "unknown" } | { state: "observed"; value: string; source: string };

export interface EvidenceRecord {
  schema: typeof EVIDENCE_SCHEMA;
  id: string;
  // When the observation was made. Null when the source never recorded it; such a record ranks
  // below every dated one.
  recordedAt: string | null;
  subject: {
    manufacturer: string;
    productRef: string | null;
    // Carries its version (M-0085_A-0072-30-69AA: version 0x30).
    appProgramId: string;
    mask: string;
    firmware: Firmware;
  };
  medium: "TP" | "PL" | "RF" | "IP" | "unknown";
  transport: { kind: "ip-udp" | "ip-tcp" | "usb" | "unknown"; via: "direct" | "busforge-bridge" | "unknown" };
  build: {
    server: { version: string; commit: string } | null;
    runner: { name: string; revision: string | null } | null;
    spec: { name: string; revision: string | null } | null;
  };
  scope: { operation: EvidenceOperation; channel: "api" | "ui" | "tool"; configuration: string; configurationFingerprint: string | null };
  origin: {
    // Who put the configuration under test into the device, or produced the compared image.
    configuredBy: "busforge" | "ets" | "unknown";
    // What the result was compared against. Only an ETS capture or a device commissioned by another
    // tool, never written by Busforge, can confirm that Busforge builds the right bytes.
    reference: "none" | "self-written" | "ets-capture" | "independently-commissioned-device";
    priorBusforgeWrites: "none" | "some" | "unknown";
  };
  results: Record<EvidenceAxis, AxisResult>;
  supersedes: string[];
  supersedeReason: string | null;
  source: { kind: "smoke-report" | "readback-tool" | "etsdiff" | "manual" | "diagnostic-package"; artifact: string | null; sha256: string | null };
}

const OPERATIONS = ["readParams", "readLinks", "flashParams", "flashLinks", "fullDownload", "structuralFlash", "assignIa", "provision", "uiClickThrough"] as const;
const AXES: EvidenceAxis[] = ["transfer", "reference", "behaviour", "persistence"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const has = (o: object, k: string) => Object.hasOwn(o, k);

class Shape {
  constructor(private path: string) {}
  fail(why: string): never { throw new ProductError("EVIDENCE_INVALID", `${this.path}: ${why}`); }
  obj(v: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
    if (!v || typeof v !== "object" || Array.isArray(v)) this.fail("expected an object");
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) new Shape(`${this.path}.${k}`).fail("unknown field");
    for (const k of keys) if (!(k in o)) new Shape(`${this.path}.${k}`).fail("missing");
    return o;
  }
  at(key: string): Shape { return new Shape(`${this.path}.${key}`); }
  str(v: unknown): string { if (typeof v !== "string" || v === "") this.fail("expected a non-empty string"); return v; }
  strOrNull(v: unknown): string | null { return v === null ? null : this.str(v); }
  oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
    if (!allowed.includes(v as T)) this.fail(`expected one of ${allowed.join(", ")}`);
    return v as T;
  }
}

// Validate an untrusted record. Refuses rather than repairs: an unknown field, a missing one or a
// claim the record's own origin cannot support is an error, not something to drop or default.
export function parseEvidenceRecord(raw: unknown): EvidenceRecord {
  const $ = new Shape("record");
  const r = $.obj(raw, ["schema", "id", "recordedAt", "subject", "medium", "transport", "build", "scope", "origin", "results", "supersedes", "supersedeReason", "source"]);
  if (r.schema !== EVIDENCE_SCHEMA) throw new ProductError("EVIDENCE_SCHEMA_UNSUPPORTED", `evidence schema ${String(r.schema)} is not ${EVIDENCE_SCHEMA}`);
  $.at("id").str(r.id);
  if (r.recordedAt !== null) {
    const at = $.at("recordedAt").str(r.recordedAt);
    // The pattern alone accepts month 13; a real instant must also round-trip through Date.
    if (!ISO.test(at) || Number.isNaN(Date.parse(at)) || new Date(at).toISOString().slice(0, 19) !== at.slice(0, 19)) $.at("recordedAt").fail("expected an ISO 8601 UTC timestamp or null");
  }

  const s = $.at("subject"), subject = s.obj(r.subject, ["manufacturer", "productRef", "appProgramId", "mask", "firmware"]);
  const manufacturer = s.at("manufacturer").str(subject.manufacturer);
  s.at("productRef").strOrNull(subject.productRef);
  if (!s.at("appProgramId").str(subject.appProgramId).startsWith(`${manufacturer}_A-`)) s.at("manufacturer").fail("is not the application program's manufacturer");
  s.at("mask").str(subject.mask);
  const f = s.at("firmware"), fw = f.obj(subject.firmware, ["state"], ["value", "source"]);
  if (f.at("state").oneOf(fw.state, ["unknown", "observed"]) === "observed") {
    f.obj(fw, ["state", "value", "source"]);
    f.at("value").str(fw.value); f.at("source").str(fw.source);
  } else f.obj(fw, ["state"]);

  $.at("medium").oneOf(r.medium, ["TP", "PL", "RF", "IP", "unknown"]);
  const t = $.at("transport"), transport = t.obj(r.transport, ["kind", "via"]);
  t.at("kind").oneOf(transport.kind, ["ip-udp", "ip-tcp", "usb", "unknown"]);
  t.at("via").oneOf(transport.via, ["direct", "busforge-bridge", "unknown"]);

  const b = $.at("build"), build = b.obj(r.build, ["server", "runner", "spec"]);
  if (build.server !== null) { const x = b.at("server"), o = x.obj(build.server, ["version", "commit"]); x.at("version").str(o.version); x.at("commit").str(o.commit); }
  for (const k of ["runner", "spec"] as const) {
    if (build[k] === null) continue;
    const x = b.at(k), o = x.obj(build[k], ["name", "revision"]);
    x.at("name").str(o.name); x.at("revision").strOrNull(o.revision);
  }

  const sc = $.at("scope"), scope = sc.obj(r.scope, ["operation", "channel", "configuration", "configurationFingerprint"]);
  sc.at("operation").oneOf(scope.operation, OPERATIONS);
  sc.at("channel").oneOf(scope.channel, ["api", "ui", "tool"]);
  sc.at("configuration").str(scope.configuration);
  sc.at("configurationFingerprint").strOrNull(scope.configurationFingerprint);

  const o = $.at("origin"), origin = o.obj(r.origin, ["configuredBy", "reference", "priorBusforgeWrites"]);
  o.at("configuredBy").oneOf(origin.configuredBy, ["busforge", "ets", "unknown"]);
  const reference = o.at("reference").oneOf(origin.reference, ["none", "self-written", "ets-capture", "independently-commissioned-device"]);
  const prior = o.at("priorBusforgeWrites").oneOf(origin.priorBusforgeWrites, ["none", "some", "unknown"]);

  const rs = $.at("results"), results = rs.obj(r.results, AXES);
  for (const axis of AXES) {
    const x = rs.at(axis), a = x.obj(results[axis], ["state"], ["method", "detail"]);
    const state = x.at("state").oneOf(a.state, ["pass", "fail", "not-assessed", "not-applicable"]);
    if (has(a, "method")) x.at("method").str(a.method);
    if (has(a, "detail")) x.at("detail").str(a.detail);
    if (state === "not-applicable" && !has(a, "detail")) x.at("detail").fail("not-applicable must say why");
    if (state === "pass" && !has(a, "method")) throw new ProductError("EVIDENCE_METHOD_MISSING", `results.${axis}: a pass must name the method that established it`);
  }
  const independent = reference === "ets-capture"
    || (reference === "independently-commissioned-device" && prior === "none" && origin.configuredBy !== "busforge");
  if ((results.reference as AxisResult).state === "pass" && !independent) {
    throw new ProductError("EVIDENCE_REFERENCE_NOT_INDEPENDENT",
      `a ${reference} comparison (configured by ${String(origin.configuredBy)}, prior Busforge writes "${prior}") cannot confirm that Busforge builds the right bytes`);
  }

  const sup = $.at("supersedes");
  if (!Array.isArray(r.supersedes)) sup.fail("expected an array of record ids");
  (r.supersedes as unknown[]).forEach((id, i) => { if (sup.at(String(i)).str(id) === r.id) sup.fail("a record cannot supersede itself"); });
  const reason = $.at("supersedeReason").strOrNull(r.supersedeReason);
  if ((r.supersedes as unknown[]).length > 0 && reason === null) $.at("supersedeReason").fail("a record that supersedes others must say why");

  const so = $.at("source"), source = so.obj(r.source, ["kind", "artifact", "sha256"]);
  so.at("kind").oneOf(source.kind, ["smoke-report", "readback-tool", "etsdiff", "manual", "diagnostic-package"]);
  so.at("artifact").strOrNull(source.artifact);
  const sha = so.at("sha256").strOrNull(source.sha256);
  if (sha !== null && !SHA256.test(sha)) so.at("sha256").fail("expected a lowercase hex SHA-256");
  // The one axis that says Busforge builds the right bytes has to stay re-checkable.
  if ((results.reference as AxisResult).state === "pass" && (source.artifact === null || sha === null)) {
    throw new ProductError("EVIDENCE_REFERENCE_UNRETAINED", "a reference pass must name its compared artifact and its SHA-256");
  }
  return raw as EvidenceRecord;
}

// The conditions a result was obtained under. Two records with equal conditions and opposite
// outcomes are unexplained: the matrix shows a conflict instead of picking the newer or the better.
// An unrecorded condition counts as equal, because it cannot tell the two runs apart.
const conditions = (r: EvidenceRecord) => {
  const fw = r.subject.firmware;
  return JSON.stringify([
    r.build.server?.commit ?? null, r.build.spec?.revision ?? null,
    fw.state === "observed" ? [fw.value, fw.source] : null, r.transport.kind, r.transport.via, r.medium,
  ]);
};
const time = (r: EvidenceRecord) => (r.recordedAt === null ? -Infinity : Date.parse(r.recordedAt));

const mixed = (why: string): never => { throw new ProductError("EVIDENCE_CELL_MIXED", why); };

// The state of one matrix cell on one axis. A cell is one Product running one application program,
// for one operation and channel: evidence from another Product, even on the same KNX Hardware, never
// raises it. `basis` lists the deciding records, newest first. Records that do not form one cell,
// or whose supersessions do not resolve inside it, are refused rather than half-counted.
export function cellState(records: EvidenceRecord[], axis: EvidenceAxis): { state: AxisState | "conflict"; basis: string[] } {
  const unattributed = records.find((r) => r.subject.productRef === null);
  if (unattributed) throw new ProductError("EVIDENCE_PRODUCT_UNKNOWN", `${unattributed.id} names no Product, so it cannot back a matrix cell`);
  const key = (r: EvidenceRecord) => [r.subject.productRef, r.subject.appProgramId, r.scope.operation, r.scope.channel].join("|");
  if (new Set(records.map(key)).size > 1) mixed(`records of different cells for ${axis}: ${[...new Set(records.map(key))].join(", ")}`);
  const ids = new Set(records.map((r) => r.id));
  if (ids.size !== records.length) mixed("duplicate record ids");
  const byId = new Map(records.map((r) => [r.id, r]));
  // A correction comes after what it corrects, which also rules out supersession cycles.
  for (const r of records) for (const id of r.supersedes) {
    const old = byId.get(id);
    if (!old) mixed(`${r.id} supersedes ${id}, which is not in this cell`);
    else if (!(time(r) > time(old))) mixed(`${r.id} supersedes ${id} but is not newer than it`);
  }
  const assessed = records.filter((r) => r.results[axis].state !== "not-assessed");
  // Supersession counts only on axes the superseding record assessed itself.
  const superseded = new Set(assessed.flatMap((r) => r.supersedes));
  const live = assessed.filter((r) => !superseded.has(r.id)).sort((a, b) => time(b) - time(a));
  if (live.length === 0) return { state: "not-assessed", basis: [] };
  const same = live.filter((r) => conditions(r) === conditions(live[0]));
  const states = new Set(same.map((r) => r.results[axis].state));
  if (states.has("pass") && states.has("fail")) return { state: "conflict", basis: same.map((r) => r.id) };
  return { state: live[0].results[axis].state, basis: [live[0].id] };
}
