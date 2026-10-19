// Builds the evidence bundle the server ships, and renders the compatibility page
// docs/compatibility.md from the same matrix. The records as written (smoke runs and ETS reference
// comparisons, with their run times, builds and source files) are kept in the private corpus under
// evidence/runs/**/*.evidence.json and evidence/reference/*.json (tools/corpus.ts). The bundle holds
// only the records that decide a matrix cell, without what identifies a run or an installation
// (publicRecords). Each tested Product's capabilities come from its application program in the
// corpus catalogue; a Product without one is refused, and so is a run without the corpus.
//
//   BUSFORGE_CORPUS=<dir> bun run tools/evidence-bundle.ts          # fail when the bundle or the page is stale
//   BUSFORGE_CORPUS=<dir> bun run tools/evidence-bundle.ts --write  # regenerate both
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseEvidenceRecord, checkEvidenceSet, parseEvidenceBundle, buildMatrix, cellState, classify, parseAppConfig,
  EVIDENCE_BUNDLE_SCHEMA, MATRIX_OPERATIONS, type EvidenceBundle, type EvidenceRecord, type EvidenceAxis, type MatrixProduct,
  type MatrixRow, type MatrixCell, type OperationState, type MatrixOperation,
} from "../packages/product/src/index.ts";
import { catalogueDir, catalogueXml, corpusPath } from "./corpus.ts";

const ROOT = join(import.meta.dir, "..");
export const BUNDLE_PATH = join(ROOT, "apps", "server", "src", "evidence-bundle.json");
export const PAGE_PATH = join(ROOT, "docs", "compatibility.md");
const AXES: readonly EvidenceAxis[] = ["transfer", "reference", "behaviour", "persistence"];

// Code-point order, not locale collation: the generated files must be byte-identical everywhere.
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function walk(dir: string, keep: (file: string) => boolean): string[] {
  return readdirSync(dir).sort().flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
  });
}

// Every kept record as written, from the corpus.
export function collectRecords(): EvidenceRecord[] {
  const dir = corpusPath("evidence");
  for (const sub of ["runs", "reference"]) if (!existsSync(join(dir, sub))) throw new Error(`${join(dir, sub)} is missing: the kept evidence records are read from the private corpus`);
  const files = [
    ...walk(join(dir, "runs"), (p) => p.endsWith(".evidence.json")),
    ...walk(join(dir, "reference"), (p) => p.endsWith(".json")),
  ];
  const records = files.flatMap((p) => {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return (Array.isArray(raw) ? raw : [raw]).map((r) => {
      try { return parseEvidenceRecord(r); } catch (e) { throw new Error(`${p}: ${(e as Error).message}`); }
    });
  });
  checkEvidenceSet(records);
  return records.sort((a, b) => byCodePoint(a.id, b.id));
}

// KNX ids escape characters as .XX hex: "BE.2D02001.2E02" is "BE-02001.02".
export const unescapeKnxId = (s: string) => s.replace(/\.([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const orderOf = (productRef: string) => unescapeKnxId(productRef.split("_P-")[1]);

const cellKey = (r: EvidenceRecord) => [r.subject.productRef, r.subject.appProgramId, r.scope.operation, r.scope.channel].join("|");

// Text a shipped record may not carry: a date, an individual address, a host path. Group addresses
// in a result's detail stay: they are bench addresses, from the smoke specs and the links the smoke
// driver generates on the bench. Run times, revisions and source files are refused field by field
// below. A firmware value is a version, not checked as text (1.1.4 is no individual address).
const PRIVATE_TEXT: [RegExp, string][] = [
  [/\b20\d\d-[01]\d-[0-3]\d/, "a date"],
  [/(?:^|[^\w.])\d{1,2}\.\d{1,2}\.\d{1,3}(?![\w.])/, "an individual address"],
  [/\/(?:Users|home)\/|^[A-Za-z]:\\/, "a host path"],
];

// Refuses a shipped record that identifies its run or its installation (see publicRecords).
export function checkPublicRecord(r: EvidenceRecord): void {
  const fail = (why: string) => { throw new Error(`${r.id}: a shipped record ${why}`); };
  if (r.recordedAt !== null) fail("carries its run time");
  if (r.build.server !== null || r.build.runner?.revision != null || r.build.spec?.revision != null) fail("names a build or spec revision");
  if (r.supersedes.length > 0 || r.supersedeReason !== null) fail("supersedes a record that is not shipped");
  if ((r.source.artifact !== null || r.source.sha256 !== null) && r.results.reference.state !== "pass") fail("names a source file that no reference pass needs");
  const texts = [
    r.id, r.subject.mask, ("source" in r.subject.firmware ? r.subject.firmware.source ?? "" : ""), r.scope.configuration, r.source.artifact ?? "",
    r.build.runner?.name ?? "", r.build.spec?.name ?? "",
    ...AXES.flatMap((a) => [r.results[a].method ?? "", r.results[a].detail ?? ""]),
  ];
  for (const t of texts) for (const [re, what] of PRIVATE_TEXT) if (re.test(t)) fail(`contains ${what}: ${JSON.stringify(t)}`);
}

// The records the bundle ships: for every cell of a matrix operation, the records cellState decides
// each axis on, and nothing that identifies the run or the installation. A record loses its run
// time, its build and spec revisions, the supersessions (a superseded record is never deciding, so
// it is not shipped) and, unless a reference pass needs it, its source file; its id is rebuilt from
// what it is about. The ordering cellState takes from run times is gone, so the result is refused
// unless every cell and axis decides exactly as on the records as written: the shipped matrix is
// the matrix of the kept evidence, not a picked subset of it.
export function publicRecords(records: EvidenceRecord[], products: MatrixProduct[]): EvidenceRecord[] {
  const ops = new Set<string>(MATRIX_OPERATIONS);
  const cells = new Map<string, EvidenceRecord[]>();
  for (const r of records) if (ops.has(r.scope.operation)) cells.set(cellKey(r), [...(cells.get(cellKey(r)) ?? []), r]);
  const renamed = new Map<string, string>();
  const out: EvidenceRecord[] = [];
  for (const own of cells.values()) {
    const deciding = new Set(AXES.flatMap((axis) => cellState(own, axis).basis));
    for (const r of own.filter((x) => deciding.has(x.id))) {
      const axes = AXES.filter((a) => r.results[a].state !== "not-assessed").join("+");
      const base = `${orderOf(r.subject.productRef!)} ${r.scope.operation} ${r.scope.channel} ${axes}`;
      let id = base;
      for (let n = 2; out.some((x) => x.id === id); n++) id = `${base} #${n}`;
      renamed.set(r.id, id);
      const keepSource = r.results.reference.state === "pass";
      const shipped = parseEvidenceRecord({
        ...r, id, recordedAt: null,
        build: { server: null, runner: r.build.runner && { ...r.build.runner, revision: null }, spec: r.build.spec && { ...r.build.spec, revision: null } },
        supersedes: [], supersedeReason: null,
        source: { kind: r.source.kind, artifact: keepSource ? r.source.artifact : null, sha256: keepSource ? r.source.sha256 : null },
      });
      checkPublicRecord(shipped);
      out.push(shipped);
    }
  }
  // A conflict lists its records in run-time order, which the shipped records no longer carry, so a
  // bundle with one is refused until the kept evidence resolves it.
  const kept = buildMatrix(records, products);
  const conflict = cellsOf(kept).find((c) => c.cell.state === "conflict");
  if (conflict) throw new Error(`${conflict.at} is a conflict, and the shipped records carry no run times to order it, so the bundle is refused until the kept evidence resolves it`);
  // Without run times the records of an axis tie, and a tie falls to array order: every operation's
  // verdict and every cell must come out the same in the order the records ship and in the reverse
  // one, so no order decides it.
  out.sort((a, b) => byCodePoint(a.id, b.id));
  const shown = (rows: MatrixRow[], rename: (id: string) => string | undefined) => [
    ...cellsOf(rows).map((c) => ({ at: c.at, text: JSON.stringify({ ...c.cell, basis: c.cell.basis.map(rename) }) })),
    ...rows.flatMap((row) => MATRIX_OPERATIONS.map((op) => ({ at: `${orderOf(row.productRef)} ${op}`, text: JSON.stringify({ state: row.operations[op].state, firmware: row.operations[op].firmware }) }))),
  ];
  const asWritten = shown(kept, (id) => renamed.get(id));
  for (const order of [out, [...out].reverse()]) {
    const now = shown(buildMatrix(order, products), (id) => id);
    const differs = asWritten.find((x, i) => now[i]?.at !== x.at || now[i].text !== x.text) ?? (now.length !== asWritten.length ? now[asWritten.length] : undefined);
    if (differs) throw new Error(`the shipped records would not decide ${differs.at} as the kept records do (it needs the order of run times to decide), so they are refused`);
  }
  return out;
}

// Every cell of a matrix, named by product, operation, channel and axis.
function cellsOf(rows: MatrixRow[]): { at: string; cell: MatrixCell }[] {
  return rows.flatMap((row) => MATRIX_OPERATIONS.flatMap((op) => Object.entries(row.operations[op].cells).flatMap(([channel, axes]) =>
    AXES.map((axis) => ({ at: `${orderOf(row.productRef)} ${op} ${channel} ${axis}`, cell: axes![axis] })))));
}

function appOf(appProgramId: string) {
  const dir = catalogueDir();
  if (!existsSync(join(dir, `${appProgramId}.xml.gz`))) throw new Error(`${appProgramId}: has evidence but no application program in ${dir}, so its capabilities are unknown`);
  return parseAppConfig(catalogueXml(`${appProgramId}.xml.gz`));
}

export function generateBundle(records = collectRecords()): EvidenceBundle {
  const owners = [...new Map(records.map((r) => [`${r.subject.productRef}|${r.subject.appProgramId}`, r.subject])).values()]
    .sort((a, b) => byCodePoint(`${a.productRef}|${a.appProgramId}`, `${b.productRef}|${b.appProgramId}`));
  const products: MatrixProduct[] = owners.map((s) => ({ productRef: s.productRef!, appProgramId: s.appProgramId, capabilities: classify(appOf(s.appProgramId)).capabilities() }));
  return parseEvidenceBundle({ schema: EVIDENCE_BUNDLE_SCHEMA, products, records: publicRecords(records, products) });
}


const LABEL: Record<OperationState, string> = {
  tested: "tested", failed: "**failed**", conflict: "**conflict**", derived: "derived", eligible: "eligible, untested", refused: "refused",
};
const OP_LABEL: Record<MatrixOperation, string> = {
  readParams: "Read parameters", readLinks: "Read links", flashParams: "Parameter flash",
  flashLinks: "Group-address flash", fullDownload: "Full download", structuralFlash: "Structural flash",
};

export function renderPage(bundle: EvidenceBundle): string {
  const rows: MatrixRow[] = buildMatrix(bundle.records, bundle.products);
  const out: string[] = [
    "# Compatibility",
    "",
    "Generated by `bun run tools/evidence-bundle.ts --write` from the kept evidence records; do not",
    "edit by hand. The records that decide each cell ship with the server",
    "(`apps/server/src/evidence-bundle.json`, see",
    "[evidence-contract.md](evidence-contract.md#the-shipped-records)). What each state means is defined in",
    "[evidence-contract.md](evidence-contract.md#the-matrix-state-of-an-operation). A Product not listed",
    "here has no kept evidence: Busforge programs it where its capabilities allow, once the user has",
    "acknowledged for the project that it is untested (the server refuses the write until then).",
    "The capabilities shown are those of a device without KNX Data Secure; a secure device can refuse",
    "more.",
    "",
    "`tested` is the transfer axis in both the API and the UI, on hardware, on that Product only. It",
    "does not say the bytes match ETS (reference) or that the device acts on them (behaviour); those",
    "columns are listed per operation below.",
    "",
    `| Product | Application program | ${MATRIX_OPERATIONS.map((o) => OP_LABEL[o]).join(" | ")} |`,
    `|---|---|${MATRIX_OPERATIONS.map(() => "---").join("|")}|`,
  ];
  for (const row of rows) {
    out.push(`| ${row.productRef.split("_")[0]} ${orderOf(row.productRef)} | \`${row.appProgramId}\` | ${MATRIX_OPERATIONS.map((o) => LABEL[row.operations[o].state]).join(" | ")} |`);
  }
  for (const row of rows) {
    out.push("", `## ${row.productRef.split("_")[0]} ${orderOf(row.productRef)}`, "", `Product \`${row.productRef}\`, application program \`${row.appProgramId}\`.`, "");
    out.push("| Operation | State | Transfer api / ui | Behaviour api / ui | Persistence api / ui | Reference (tool) | Firmware |", "|---|---|---|---|---|---|---|");
    for (const o of MATRIX_OPERATIONS) {
      const v = row.operations[o];
      const pair = (axis: "transfer" | "behaviour" | "persistence") => `${v.cells.api?.[axis].state ?? "none"} / ${v.cells.ui?.[axis].state ?? "none"}`;
      out.push(`| ${OP_LABEL[o]} | ${LABEL[v.state]} | ${pair("transfer")} | ${pair("behaviour")} | ${pair("persistence")} | ${v.cells.tool?.reference.state ?? "none"} | ${v.firmware.join(", ") || "none"} |`);
    }
  }
  return `${out.join("\n")}\n`;
}

export const bundleText = (bundle: EvidenceBundle) => `${JSON.stringify(bundle, null, 1)}\n`;

if (import.meta.main) {
  const bundle = generateBundle();
  const files: [string, string][] = [[BUNDLE_PATH, bundleText(bundle)], [PAGE_PATH, renderPage(bundle)]];
  if (process.argv.includes("--write")) {
    for (const [p, text] of files) writeFileSync(p, text);
    console.log(`wrote ${bundle.records.length} records, ${bundle.products.length} Products`);
  } else {
    const stale = files.filter(([p, text]) => !existsSync(p) || readFileSync(p, "utf8") !== text).map(([p]) => p);
    if (stale.length) { console.error(`stale, run with --write: ${stale.join(", ")}`); process.exit(1); }
    console.log("evidence bundle and compatibility page are current");
  }
}
