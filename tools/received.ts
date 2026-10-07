// Diagnostic packages received from users, kept in the private corpus for internal regression tests
// (the procedure is internal: received-packages.md in the corpus). A package comes in as the plain JSON file the
// app saves (`busforge-diagnostic/1`, packages/product/src/diagnostic.ts); it is checked here, stored
// byte for byte with a record of where it came from, loaded by the tests, and deleted on request.
//
//   <corpus>/received/<id>/package.json      the file as received
//   <corpus>/received/<id>/provenance.json   who sent it, for which issue, with which consent, and who
//                                            configured the device it was read from
//   <corpus>/received/<id>/derived/          anything made from the package; deleted with it
//
// <id> is the first 16 hex digits of the file's SHA-256. Nothing from the package or its sender
// reaches a path.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { isSerialRecord, type DiagnosticPackage } from "../packages/product/src/index.ts";
import type { MaskPlan, RangeSource } from "../packages/product/src/collectplan.ts";
import type { RecordOutcome, RecordSpace, StopReason } from "../packages/product/src/collect.ts";
import { originReference, type DeclaredOrigin } from "./evidence.ts";

export const RECEIVED_DIR = "received";
export const DIAGNOSTIC_FORMAT = "busforge-diagnostic/1";
export const PROVENANCE_FORMAT = "busforge-received/1";
// Busforge's own bound, far above what the collector can produce: its memory guard is 1 MiB (2 MiB
// as hex), and the 10-minute bound holds the property reads to well under that.
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;

// C0 and C1 control characters, the line and paragraph separators, the bidirectional marks and
// overrides and the invisible spaces: what a terminal acts on, or what makes printed text read other
// than it is.
// oxlint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const CONTROL = new RegExp(UNPRINTABLE.source);
export const printable = (s: string) => s.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Its message can quote the file (a field name, a parse error) and is printed: it is made printable.
export class IntakeRefused extends Error {
  constructor(message: string) { super(printable(message)); this.name = "IntakeRefused"; }
}

export interface Provenance {
  format: typeof PROVENANCE_FORMAT;
  id: string;
  sha256: string;
  bytes: number;
  receivedAt: string;
  // Who sent it and by which route, as the operator records it.
  from: string;
  // The issue the package belongs to.
  issue: string;
  // The sender's consent to keeping the package for internal regression tests, in their words or as
  // the route recorded it, and when it was given.
  consent: { statement: string; givenAt: string };
  // Who configured the device the package was read from, as the sender states it.
  origin: DeclaredOrigin;
  reference: ReturnType<typeof originReference>;
}

// A package as builds have saved it: the first builds wrote no plan.maxApduAlone.
export type ReceivedDiagnostic = Omit<DiagnosticPackage, "plan"> & { plan: (Omit<MaskPlan, "maxApduAlone"> & { maxApduAlone?: boolean }) | null };

export interface ReceivedPackage { id: string; provenance: Provenance; pkg: ReceivedDiagnostic }

// Every member of a union, checked by the compiler in both directions.
const every = <T extends string>() => <const A extends readonly T[]>(a: A & ([T] extends [A[number]] ? unknown : never)) => a;
const SPACES = every<RecordSpace>()(["descriptor", "authorize", "property", "property-description", "function-property", "memory", "memory-extended"]);
const OUTCOMES = every<RecordOutcome>()(["bytes", "refused", "timeout", "connection-closed", "malformed", "not-attempted"]);
const SOURCES = every<RangeSource>()(["master-data", "device", "product-xml"]);
const STOPS = every<StopReason>()(["duration", "unresponsive", "descriptor-malformed", "secured-no-key", "interface", "error"]);
const CONFIGURED_BY = every<DeclaredOrigin["configuredBy"]>()(["ets", "busforge", "unknown"]);
const PRIOR_WRITES = every<DeclaredOrigin["priorBusforgeWrites"]>()(["none", "some", "unknown"]);

// Leading bytes of the files that are not a package and are named in the refusal: archives are never
// unpacked and programs never run, so neither is accepted in place of the JSON file.
const SIGNATURES: [string, number[], number?][] = [
  ["a gzip archive", [0x1f, 0x8b]], ["a zip archive", [0x50, 0x4b, 0x03, 0x04]], ["a zip archive", [0x50, 0x4b, 0x05, 0x06]],
  ["a 7z archive", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]], ["a rar archive", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  ["an xz archive", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]], ["a bzip2 archive", [0x42, 0x5a, 0x68]], ["a zstd archive", [0x28, 0xb5, 0x2f, 0xfd]],
  ["a tar archive", [0x75, 0x73, 0x74, 0x61, 0x72], 257],
  ["an ELF executable", [0x7f, 0x45, 0x4c, 0x46]], ["a Windows executable", [0x4d, 0x5a]],
  ["a Mach-O executable", [0xcf, 0xfa, 0xed, 0xfe]], ["a Mach-O executable", [0xce, 0xfa, 0xed, 0xfe]], ["a Mach-O executable", [0xca, 0xfe, 0xba, 0xbe]],
  ["a script", [0x23, 0x21]], ["a WebAssembly module", [0x00, 0x61, 0x73, 0x6d]],
];

class Field {
  constructor(readonly path: string) {}
  fail(why: string): never { throw new IntakeRefused(`${this.path}: ${why}`); }
  at(key: string | number): Field {
    return new Field(typeof key === "number" ? `${this.path}[${key}]` : /^[A-Za-z_][\w]*$/.test(key) ? `${this.path}.${key}` : `${this.path}[${JSON.stringify(key)}]`);
  }
  obj(v: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!v || typeof v !== "object" || Array.isArray(v)) this.fail("expected an object");
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) this.at(k).fail("unknown field");
    for (const k of keys) if (!Object.hasOwn(o, k)) this.at(k).fail("missing");
    return o;
  }
  arr(v: unknown): unknown[] { if (!Array.isArray(v)) this.fail("expected an array"); return v; }
  str(v: unknown): string {
    if (typeof v !== "string" || v === "") this.fail("expected a non-empty string");
    if (CONTROL.test(v)) this.fail("holds a control character");
    return v;
  }
  strOrNull(v: unknown): string | null { return v === null ? null : this.str(v); }
  // Free text the link or the collector wrote (a reason, an error): any string, also empty or on
  // several lines. Never printed unescaped.
  text(v: unknown): string { if (typeof v !== "string") this.fail("expected a string"); return v; }
  textOrNull(v: unknown): string | null { return v === null ? null : this.text(v); }
  int(v: unknown): number { if (!Number.isSafeInteger(v) || (v as number) < 0) this.fail("expected a non-negative integer"); return v as number; }
  intOrNull(v: unknown): number | null { return v === null ? null : this.int(v); }
  time(v: unknown): number { if (typeof v !== "number" || !Number.isFinite(v) || v < 0) this.fail("expected a time in milliseconds"); return v; }
  bool(v: unknown): boolean { if (typeof v !== "boolean") this.fail("expected true or false"); return v; }
  hex(v: unknown): string { if (typeof v !== "string" || v.length % 2 !== 0 || /[^0-9a-f]/.test(v)) this.fail("expected lower-case hex bytes"); return v; }
  oneOf<T extends string>(v: unknown, allowed: readonly T[]): T { if (!allowed.includes(v as T)) this.fail(`expected one of ${allowed.join(", ")}`); return v as T; }
  pattern(v: unknown, re: RegExp, what: string): string { const s = this.str(v); if (!re.test(s)) this.fail(`expected ${what}`); return s; }
}

function checkPlan($: Field, v: unknown): void {
  if (v === null) return;
  // maxApduAlone came after the first builds that saved this format; their packages lack it.
  const p = $.obj(v, ["mask", "family", "authorize", "objects", "identity", "applicationObject", "properties", "loadStateObjects", "memory", "tables", "segments", "securityModeLast", "notAttempted"], ["maxApduAlone"]);
  $.at("mask").str(p.mask); $.at("family").str(p.family);
  for (const k of ["authorize", "identity", "securityModeLast"]) $.at(k).bool(p[k]);
  if (Object.hasOwn(p, "maxApduAlone")) $.at("maxApduAlone").bool(p.maxApduAlone);
  $.at("objects").oneOf(p.objects, ["declared", "probe", "none"]);
  $.at("applicationObject").intOrNull(p.applicationObject);
  $.at("properties").arr(p.properties).forEach((x, i) => {
    const f = $.at("properties").at(i), o = f.obj(x, ["object", "pid", "name"]);
    f.at("object").int(o.object); f.at("pid").int(o.pid); f.at("name").str(o.name);
  });
  $.at("loadStateObjects").arr(p.loadStateObjects).forEach((x, i) => $.at("loadStateObjects").at(i).int(x));
  $.at("memory").arr(p.memory).forEach((x, i) => {
    const f = $.at("memory").at(i), o = f.obj(x, ["address", "length", "name", "source"]);
    f.at("address").int(o.address); f.at("length").int(o.length); f.at("name").str(o.name); f.at("source").oneOf(o.source, SOURCES);
  });
  $.at("tables").arr(p.tables).forEach((x, i) => {
    const f = $.at("tables").at(i);
    const kind = f.at("kind").oneOf(f.obj(x, ["kind"], ["object", "name", "at", "entryBytes"]).kind, ["property-pointer", "counted"]);
    if (kind === "property-pointer") {
      const o = f.obj(x, ["kind", "object", "name"]);
      f.at("object").int(o.object); f.at("name").str(o.name);
      return;
    }
    const o = f.obj(x, ["kind", "name", "at", "entryBytes"]);
    f.at("name").str(o.name); f.at("entryBytes").int(o.entryBytes);
    const a = f.at("at"), at = a.obj(o.at, [], ["address", "property", "memory"]);
    const keys = Object.keys(at);
    if (keys.length !== 1) a.fail("expected exactly one of address, property, memory");
    if (keys[0] === "address") a.at("address").int(at.address);
    else if (keys[0] === "property") {
      const q = a.at("property"), pr = q.obj(at.property, ["object", "pid", "bytes"]);
      q.at("object").int(pr.object); q.at("pid").int(pr.pid); q.at("bytes").int(pr.bytes);
    } else {
      const q = a.at("memory"), m = q.obj(at.memory, ["address", "bytes"]);
      q.at("address").int(m.address); q.at("bytes").int(m.bytes);
    }
  });
  if (p.segments !== null) {
    $.at("segments").arr(p.segments).forEach((x, i) => {
      const f = $.at("segments").at(i), o = f.obj(x, ["address", "length"]);
      f.at("address").int(o.address); f.at("length").int(o.length);
    });
  }
  $.at("notAttempted").arr(p.notAttempted).forEach((x, i) => {
    const f = $.at("notAttempted").at(i), o = f.obj(x, ["name", "reason"], ["space"]);
    f.at("name").str(o.name); f.at("reason").text(o.reason);
    if (Object.hasOwn(o, "space")) f.at("space").oneOf(o.space, ["memory", "property"]);
  });
}

const NUMERIC_TARGET = new Set(["object", "pid", "start", "count", "address", "length", "propertyIndex", "type"]);

function checkRecord($: Field, v: unknown): void {
  const r = $.obj(v, ["step", "space", "target", "source", "outcome", "at"], ["bytes", "raw", "description", "detail", "removed"]);
  $.at("step").str(r.step);
  $.at("space").oneOf(r.space, SPACES);
  const t = $.at("target"), target = t.obj(r.target, Object.keys(r.target ?? {}));
  for (const [k, x] of Object.entries(target)) {
    if (!/^[a-zA-Z]+$/.test(k)) t.fail(`unexpected key ${JSON.stringify(k)}`);
    // Locations are numbers; as a string ("11") a PID would not be recognised as the serial's.
    if (typeof x === "number" || NUMERIC_TARGET.has(k)) t.at(k).int(x); else t.at(k).str(x);
  }
  $.at("source").oneOf(r.source, SOURCES);
  $.at("outcome").oneOf(r.outcome, OUTCOMES);
  $.at("at").time(r.at);
  if (Object.hasOwn(r, "bytes")) $.at("bytes").hex(r.bytes);
  if (Object.hasOwn(r, "raw")) $.at("raw").hex(r.raw);
  if (Object.hasOwn(r, "detail")) $.at("detail").text(r.detail);
  if (Object.hasOwn(r, "description")) {
    const d = $.at("description"), o = d.obj(r.description, ["objectIndex", "pid", "propertyIndex", "writable", "pdt", "maxElements", "readLevel", "writeLevel"]);
    for (const k of ["objectIndex", "pid", "propertyIndex", "pdt", "maxElements", "readLevel", "writeLevel"]) d.at(k).int(o[k]);
    d.at("writable").bool(o.writable);
  }
  const serial = isSerialRecord(r as Parameters<typeof isSerialRecord>[0]);
  if (Object.hasOwn(r, "removed")) {
    $.at("removed").pattern(r.removed, /^serial number, \d+ bytes?$/, `"serial number, <n> bytes"`);
    if (!serial) $.at("removed").fail("only a serial number record has bytes removed");
  }
  if (serial && ((r.bytes as string | undefined) || (r.raw as string | undefined))) {
    $.fail("still holds the device's serial number: the package was not cleaned by Busforge's diagnostic export");
  }
}

// Check an untrusted file that claims to be a diagnostic package. Refuses rather than repairs: an
// unknown field, a missing one, bytes that are not hex or a serial left in place is an error.
export function checkPackage(data: Uint8Array): ReceivedDiagnostic {
  if (data.length === 0) throw new IntakeRefused("the file is empty");
  if (data.length > MAX_PACKAGE_BYTES) throw new IntakeRefused(`the file has ${data.length} bytes, more than the ${MAX_PACKAGE_BYTES} a diagnostic package can have`);
  for (const [what, sig, offset = 0] of SIGNATURES) {
    if (sig.every((b, i) => data[offset + i] === b)) throw new IntakeRefused(`the file is ${what}; only the plain JSON file Busforge saves is taken, nothing is unpacked or run`);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new IntakeRefused("the file is not UTF-8 text"); }
  if (!text.trimStart().startsWith("{")) throw new IntakeRefused("the file is not a JSON object");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new IntakeRefused(`the file is not valid JSON: ${(e as Error).message}`); }

  const $ = new Field("package");
  const p = $.obj(raw, ["format"], ["cleaned", "busforge", "connection", "ia", "mask", "family", "secured", "authorizeLevel", "maxApdu", "plan", "records", "limits", "stop", "error", "counts", "startedAt", "finishedAt", "bus"]);
  if (p.format !== DIAGNOSTIC_FORMAT) $.at("format").fail(`expected ${DIAGNOSTIC_FORMAT}${p.format === "busforge-raw-collect/1" ? " (this is an uncleaned collector package)" : ""}`);
  $.obj(raw, ["format", "cleaned", "busforge", "connection", "ia", "mask", "family", "secured", "authorizeLevel", "maxApdu", "plan", "records", "limits", "stop", "error", "counts", "startedAt", "finishedAt", "bus"]);

  const c = $.at("cleaned"), cleaned = c.obj(p.cleaned, ["removed", "notAnonymized"]);
  for (const k of ["removed", "notAnonymized"]) c.at(k).arr(cleaned[k]).forEach((x, i) => c.at(k).at(i).str(x));
  const b = $.at("busforge"), bf = b.obj(p.busforge, ["version", "commit"]);
  b.at("version").str(bf.version); b.at("commit").str(bf.commit);
  const k = $.at("connection"), conn = k.obj(p.connection, ["kind"], ["ipTransport", "usbVendorId", "usbProductId"]);
  if (k.at("kind").oneOf(conn.kind, ["ip", "usb"]) === "ip") { k.obj(conn, ["kind", "ipTransport"]); k.at("ipTransport").str(conn.ipTransport); }
  else { k.obj(conn, ["kind", "usbVendorId", "usbProductId"]); k.at("usbVendorId").intOrNull(conn.usbVendorId); k.at("usbProductId").intOrNull(conn.usbProductId); }

  const ia = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/.exec(String(p.ia))?.slice(1).map(Number);
  if (typeof p.ia !== "string" || !ia || ia[0] > 15 || ia[1] > 15 || ia[2] > 255) $.at("ia").fail("expected an individual address <area>.<line>.<device>");
  if (p.mask !== null) $.at("mask").pattern(p.mask, /^MV-[0-9A-F]{4}$/, "a mask version MV-XXXX or null");
  $.at("family").strOrNull(p.family);
  $.at("secured").bool(p.secured);
  $.at("authorizeLevel").intOrNull(p.authorizeLevel);
  $.at("maxApdu").intOrNull(p.maxApdu);
  checkPlan($.at("plan"), p.plan);
  $.at("records").arr(p.records).forEach((r, i) => checkRecord($.at("records").at(i), r));
  $.at("limits").arr(p.limits).forEach((x, i) => $.at("limits").at(i).text(x));
  if (p.stop !== null) {
    const s = $.at("stop"), stop = s.obj(p.stop, ["reason", "detail"]);
    s.at("reason").oneOf(stop.reason, STOPS); s.at("detail").text(stop.detail);
  }
  $.at("error").textOrNull(p.error);
  const n = $.at("counts"), counts = n.obj(p.counts, ["requests", "scanRequests", "memoryRequests", "memoryBytes", "reconnects"]);
  for (const key of Object.keys(counts)) n.at(key).int(counts[key]);
  const started = $.at("startedAt").time(p.startedAt);
  if ($.at("finishedAt").time(p.finishedAt) < started) $.at("finishedAt").fail("is before startedAt");
  const u = $.at("bus"), bus = u.obj(p.bus, ["takenAt", "monitorClosedAt", "releasedAt"]);
  u.at("takenAt").time(bus.takenAt); u.at("releasedAt").time(bus.releasedAt);
  if (bus.monitorClosedAt !== null) u.at("monitorClosedAt").time(bus.monitorClosedAt);
  return raw as ReceivedDiagnostic;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function checkProvenance(raw: unknown, where: string): Provenance {
  const $ = new Field(where);
  const p = $.obj(raw, ["format", "id", "sha256", "bytes", "receivedAt", "from", "issue", "consent", "origin", "reference"]);
  if (p.format !== PROVENANCE_FORMAT) $.at("format").fail(`expected ${PROVENANCE_FORMAT}`);
  $.at("id").pattern(p.id, /^[0-9a-f]{16}$/, "16 hex digits");
  $.at("sha256").pattern(p.sha256, /^[0-9a-f]{64}$/, "a SHA-256");
  if ((p.sha256 as string).slice(0, 16) !== p.id) $.at("id").fail("is not the start of the SHA-256");
  $.at("bytes").int(p.bytes);
  const receivedAt = $.at("receivedAt").str(p.receivedAt);
  if (!isDate(receivedAt)) $.at("receivedAt").fail("expected a date YYYY-MM-DD");
  $.at("from").str(p.from); $.at("issue").str(p.issue);
  const c = $.at("consent"), consent = c.obj(p.consent, ["statement", "givenAt"]);
  c.at("statement").str(consent.statement);
  const givenAt = c.at("givenAt").str(consent.givenAt);
  if (!isDate(givenAt)) c.at("givenAt").fail("expected a date YYYY-MM-DD");
  if (givenAt > receivedAt) c.at("givenAt").fail(`is after the package was received (${receivedAt}); consent comes first`);
  const o = $.at("origin"), origin = o.obj(p.origin, ["configuredBy", "priorBusforgeWrites"]) as unknown as DeclaredOrigin;
  o.at("configuredBy").oneOf(origin.configuredBy, CONFIGURED_BY); o.at("priorBusforgeWrites").oneOf(origin.priorBusforgeWrites, PRIOR_WRITES);
  if (origin.configuredBy === "busforge" && origin.priorBusforgeWrites === "none") o.fail("a device Busforge configured has Busforge writes");
  if (p.reference !== originReference(origin)) $.at("reference").fail(`does not follow from the origin (expected ${originReference(origin)})`);
  return p as unknown as Provenance;
}

const repo = () => realpathSync(join(import.meta.dir, ".."));
const insideRepo = (real: string) => { const r = repo(); return real === r || real.startsWith(r + sep); };

// The received/ directory of a corpus, which must be a real directory, not a link, and lie outside
// the repository: there the packages would sit in the working tree, one `git add` or one build
// context away from being published.
export function receivedRoot(corpus: string): string {
  const real = realpathSync(corpus);
  if (insideRepo(real)) throw new IntakeRefused(`the corpus ${corpus} lies inside the repository ${repo()}; received packages are kept only outside it`);
  const root = join(real, RECEIVED_DIR);
  if (existsSync(root) || lstatSync(root, { throwIfNoEntry: false })) {
    if (!lstatSync(root).isDirectory()) throw new IntakeRefused(`${root} is not a directory (a link is not followed)`);
    if (insideRepo(realpathSync(root))) throw new IntakeRefused(`${root} lies inside the repository ${repo()}`);
  }
  return root;
}

// The repository's tracked files with their text: what is published with the source.
export function trackedFiles(): { path: string; text: string }[] {
  const r = repo();
  const list = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: r });
  if (list.exitCode !== 0) throw new Error(`git ls-files failed in ${r}: ${list.stderr.toString()}`);
  return list.stdout.toString().split("\0").filter((f) => f !== "" && existsSync(join(r, f)))
    .map((f) => ({ path: join(r, f), text: readFileSync(join(r, f)).toString("latin1") }));
}

export interface IntakeDetails { from: string; issue: string; consent: { statement: string; givenAt: string }; origin: DeclaredOrigin; receivedAt: string }

// The bytes of a regular file, opened without following a link and checked on the open descriptor,
// so that the file read is the file checked.
function readRegularFile(file: string): Buffer {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    throw new IntakeRefused(`${file} cannot be opened as a regular file: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new IntakeRefused(`${file} is not a regular file`);
    if (st.size > MAX_PACKAGE_BYTES) throw new IntakeRefused(`the file has ${st.size} bytes, more than the ${MAX_PACKAGE_BYTES} a diagnostic package can have`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

// Check a file and store it in the corpus. The file is copied, not moved: the copy the transfer
// delivered is the operator's to delete.
export function receive(corpus: string, file: string, details: IntakeDetails): ReceivedPackage {
  const data = readRegularFile(file);
  const pkg = checkPackage(data);
  const hash = sha256(data), id = hash.slice(0, 16);
  const provenance = checkProvenance({
    format: PROVENANCE_FORMAT, id, sha256: hash, bytes: data.length, receivedAt: details.receivedAt,
    from: details.from, issue: details.issue, consent: details.consent, origin: details.origin, reference: originReference(details.origin),
  }, "provenance");
  const root = receivedRoot(corpus);
  const dir = join(root, id);
  if (lstatSync(dir, { throwIfNoEntry: false })) throw new IntakeRefused(`this package was received before, as ${id}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = join(root, `.incoming-${id}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
  writeFileSync(join(tmp, "package.json"), data, { mode: 0o600 });
  writeFileSync(join(tmp, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, dir);
  return { id, provenance, pkg };
}

// Every link under a directory: a received package holds real files only, so that deleting its
// directory deletes the bytes and not a pointer to them.
function links(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isSymbolicLink() ? [p] : e.isDirectory() ? links(p) : [];
  });
}

// One package directory, checked as loadReceived checks it. Any damage is a refusal that names the
// directory: a damaged package is inspected and deleted by hand, never repaired by the tool.
function readPackageDir(root: string, id: string): ReceivedPackage {
  const dir = join(root, id);
  const damaged = (why: string): never => { throw new IntakeRefused(`${dir}: ${why}; inspect it and delete it by hand if it is to go`); };
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (!st) throw new IntakeRefused(`there is no received package ${id}`);
  if (!st.isDirectory()) damaged("is not a directory (a link is not followed)");
  const extra = readdirSync(dir).filter((f) => !["package.json", "provenance.json", "derived", ".DS_Store"].includes(f));
  if (extra.length) damaged(`holds ${extra.join(", ")}; anything made from a package belongs in its derived/ directory`);
  const found = links(dir);
  if (found.length) damaged(`holds links (${found.join(", ")}); deleting the package would leave what they point at`);
  let provenance: Provenance, data: Buffer;
  try {
    provenance = checkProvenance(JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8")), "provenance.json");
    data = readFileSync(join(dir, "package.json"));
  } catch (e) { return damaged((e as Error).message); }
  if (provenance.id !== id) damaged(`provenance.json names the package ${provenance.id}`);
  if (sha256(data) !== provenance.sha256 || data.length !== provenance.bytes) damaged("package.json is not the file that was received (its SHA-256 or size differs)");
  let pkg: ReceivedDiagnostic;
  try { pkg = checkPackage(data); } catch (e) { return damaged(`package.json: ${(e as Error).message}`); }
  return { id, provenance, pkg };
}

// Every received package, sorted by id, each checked again: its file must still hash to its
// provenance and pass today's package check. Without a received/ directory there are none.
export function loadReceived(corpus: string): ReceivedPackage[] {
  const root = receivedRoot(corpus);
  if (!existsSync(root)) return [];
  const out: ReceivedPackage[] = [];
  for (const name of readdirSync(root).sort()) {
    if (name === ".DS_Store") continue;
    if (!/^[0-9a-f]{16}$/.test(name)) throw new IntakeRefused(`${join(root, name)} is not a received package; remove it (an interrupted intake leaves .incoming-<id>)`);
    out.push(readPackageDir(root, name));
  }
  return out;
}

// The package as a reference for the bytes a configuration should produce. Only a device ETS
// configured and Busforge never wrote can be one; a dump of bytes Busforge wrote proves transfer at
// most, and an unknown writer proves nothing (docs/evidence-contract.md).
export function asReference(r: ReceivedPackage): ReceivedDiagnostic {
  if (r.provenance.reference !== "independently-commissioned-device") {
    throw new IntakeRefused(`package ${r.id} is not an independent reference: its device was configured by ${r.provenance.origin.configuredBy}, prior Busforge writes ${r.provenance.origin.priorBusforgeWrites} (reference "${r.provenance.reference}")`);
  }
  return r.pkg;
}

const RUN = 32;

// Byte runs of a package distinctive enough to find a copy of them elsewhere: each aligned 16-byte
// chunk of its record bytes with at least 8 different byte values (fill patterns and short tables
// recur everywhere). A copy of 32 bytes or more holds at least one whole chunk.
export function distinctiveRuns(pkg: ReceivedDiagnostic): string[] {
  const runs = new Set<string>();
  for (const r of pkg.records) {
    for (const hex of [r.bytes, r.raw]) {
      if (!hex) continue;
      for (let i = 0; i + RUN <= hex.length; i += RUN) {
        const chunk = hex.slice(i, i + RUN);
        if (new Set(chunk.match(/../g)).size >= 8) runs.add(chunk);
      }
    }
  }
  return [...runs].sort();
}

// The text of a file reduced to its hex digits, lower case, so that a hex dump with spaces, line
// breaks, commas or 0x prefixes still contains the runs it copies.
export const hexDigits = (text: string) => text.toLowerCase().replace(/0x/g, "").replace(/[^0-9a-f]/g, "");

// Whether the hex digits of a text hold any of the runs, at any offset: one pass over the text.
export function holdsRun(digits: string, runs: ReadonlySet<string>): boolean {
  if (runs.size === 0) return false;
  for (let i = 0; i + RUN <= digits.length; i++) if (runs.has(digits.slice(i, i + RUN))) return true;
  return false;
}

// Whether a file's content holds a run: written as hex text (a dump, a C array, a JSON string) or
// as the bytes themselves (a .bin). A base64 copy is not found.
export function contentHoldsRun(data: Buffer, runs: ReadonlySet<string>): boolean {
  return holdsRun(hexDigits(data.toString("latin1")), runs) || holdsRun(data.toString("hex"), runs);
}

// A corpus file's content; a gzipped one unpacked, so that a copy inside it is found too.
function corpusContent(path: string): Buffer {
  const data = readFileSync(path);
  if (data[0] === 0x1f && data[1] === 0x8b) { try { return gunzipSync(data); } catch { /* not gzip after all: searched as it is */ } }
  return data;
}

// Every file under a directory, and every link: a link is not followed, so the caller refuses it
// rather than leave what it points at unsearched.
function walk(dir: string, rel = ""): { files: string[]; links: string[] } {
  const out = { files: [] as string[], links: [] as string[] };
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) out.links.push(p);
    else if (e.isDirectory()) { const sub = walk(dir, p); out.files.push(...sub.files); out.links.push(...sub.links); }
    else if (e.isFile()) out.files.push(p);
  }
  return out;
}

// Delete a received package with everything under its directory, its derived/ copies included.
// Refused while a file elsewhere in the corpus or among the repository's tracked files names its id
// or SHA-256, or, outside received/, holds a run of its bytes (distinctiveRuns): that file was made
// from it and goes first, by hand. A file the operator names in `independent` is known not to be
// made from it (an own capture of the same product, say): its bytes do not block, its naming the
// package still does. A link in the corpus is refused, not followed. A backup of the corpus is not
// reached (received-packages.md in the corpus, "Deleting a package").
export function removeReceived(corpus: string, id: string, tracked: { path: string; text: string }[], independent: string[] = []): string {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new IntakeRefused(`${id} is not a package id (16 hex digits)`);
  const root = receivedRoot(corpus);
  const { provenance, pkg } = readPackageDir(root, id);
  const runs = new Set(distinctiveRuns(pkg));
  const corpusReal = realpathSync(corpus);
  const exempt = new Set(independent.map((p) => { try { return realpathSync(p); } catch { throw new IntakeRefused(`${p}, named as independent, does not exist`); } }));
  const names = (data: Buffer) => { const t = data.toString("latin1"); return t.includes(id) || t.includes(provenance.sha256); };
  const trace = (path: string, data: Buffer, bytesCount: boolean) => names(data) ? "names it"
    : bytesCount && !exempt.has(path) && contentHoldsRun(data, runs) ? "holds its bytes" : null;
  const { files, links: found } = walk(corpusReal);
  if (found.length) throw new IntakeRefused(`the corpus holds links (${found.map((f) => join(corpusReal, f)).join(", ")}), which the search for copies does not follow; replace them by what they point at or remove them first`);
  const hits: string[] = [];
  for (const f of files) {
    if (f.startsWith(`${RECEIVED_DIR}/${id}/`)) continue;
    const path = join(corpusReal, f);
    // Another received package may hold the same bytes (the same device sent twice, two devices of a
    // product with the same defaults) without being made from this one; it is searched for the name.
    const why = trace(path, corpusContent(path), !f.startsWith(`${RECEIVED_DIR}/`));
    if (why) hits.push(`${path} (${why})`);
  }
  for (const f of tracked) { const why = trace(f.path, Buffer.from(f.text, "latin1"), true); if (why) hits.push(`${f.path} (${why})`); }
  if (hits.length) {
    throw new IntakeRefused(`package ${id} is still in ${hits.join(", ")}; remove what was made from it there first, or, for a file that holds the same bytes from an independent source, name it with --independent`);
  }
  rmSync(join(root, id), { recursive: true });
  return join(root, id);
}
