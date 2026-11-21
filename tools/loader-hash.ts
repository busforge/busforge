// Whether two commits read the private corpus alike: every archive and catalogue file of the corpus
// (`.knxproj`, `.knxprod`, OpenKNX release zips and the manufacturer XMLs inside them, manufacturer XMLs,
// the catalogue's `catalogue/*.xml.gz` unpacked) is run through the archive readers of `packages/project`
// (loadKnxproj, readXml0, readBaggage, extractCatalogProducts, hardwareApplications, extractAppPrograms,
// readAppProgram, extractPictureBaggage) as each commit has them, and each reader's output is reduced to one
// hash, or to the code and text of its refusal. The tool prints every file and reader whose result differs
// between the two, and each side's refusals by reader and code.
//
//   KNXPROJ_PASSWORDS="…" BUSFORGE_CORPUS=… bun tools/loader-hash.ts <commit> <commit|worktree>
//
// `worktree` is the checkout's packages/ as they are, uncommitted changes included. A commit's packages/
// are unpacked under node_modules/.cache/loader-hash/<commit>/ and its own @busforge packages linked
// there; third-party packages come from this checkout's node_modules. A protected project is opened with
// each of KNXPROJ_PASSWORDS (tools/corpus-archives.ts); without them the tool does not run. Exits 1 where
// any result differs.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { catalogueXml, corpusRoot, listCatalogue } from "./corpus.ts";
import { corpusArchives, describeFailure, openWithPasswords, passwords, PASSWORDS_ENV } from "./corpus-archives.ts";

const REPO = resolve(import.meta.dir, "..");
type Results = Record<string, Record<string, string>>; // file -> reader -> hash or refusal

// The first 4 KiB of a file: a manufacturer XML names <ManufacturerData> in its first lines.
function head(path: string): string {
  const fd = openSync(path, "r");
  const b = Buffer.alloc(4096);
  const n = readSync(fd, b, 0, b.length, 0);
  closeSync(fd);
  return b.subarray(0, n).toString("latin1");
}
// The corpus files the readers take: every .knxproj, .knxprod and .zip, and every .xml of manufacturer data.
const corpusFiles = () => corpusArchives((name, path) => /\.(knxproj|knxprod|zip)$/i.test(name) || (/\.xml$/i.test(name) && head(path).includes("<ManufacturerData")));

// A value as text that a hash can be taken of: maps as their entries in order, bytes as their hash (taken
// from the value itself, before JSON.stringify turns it into an array of numbers).
const stable = (v: unknown): string => JSON.stringify(v, function (this: Record<string, unknown>, key, x) {
  const raw = this[key];
  if (Buffer.isBuffer(raw)) return { bytes: createHash("sha256").update(raw).digest("hex") };
  if (x instanceof Map) return { map: [...x.entries()] };
  if (x instanceof Set) return { set: [...x] };
  return x;
});
const hashOf = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex").slice(0, 16);

// Runs inside one commit's packages: every reader on every file, as a JSON object on stdout.
async function measure(projectSrc: string): Promise<void> {
  const p = await import(join(projectSrc, "index.ts"));
  const root = corpusRoot();
  if (!root) throw new Error("BUSFORGE_CORPUS is not set");
  const out: Results = {};
  const inputs: [string, Buffer][] = [];
  for (const file of corpusFiles()) {
    const bytes = readFileSync(join(root, file));
    inputs.push([file, bytes]);
    // An OpenKNX release carries its product database as plain manufacturer XMLs below data/.
    if (/\.zip$/i.test(file)) {
      try {
        for (const [name, b] of p.readZip(bytes) as Map<string, Buffer>) {
          if (/^data[\\/][^\\/]+\.xml$/.test(name) && !/[\\/]content\.xml$/.test(name)) inputs.push([`${file}!${name}`, b]);
        }
      } catch { /* the zip readers below record the refusal */ }
    }
  }
  for (const name of listCatalogue()) inputs.push([`catalogue/${name}`, Buffer.from(catalogueXml(name))]);
  for (const [file, bytes] of inputs) {
    const r: Record<string, string> = {};
    const run = (reader: string, fn: () => unknown): unknown => {
      try { const v = fn(); r[reader] = hashOf(v); return v; } catch (e) { r[reader] = `refused ${describeFailure(e)}`; return undefined; }
    };
    // A protected project: what the first password that opens it gives.
    const withPassword = (reader: string, fn: (pw: string | undefined) => unknown): unknown => run(reader, () => {
      const v = openWithPasswords(fn);
      if (v === null) throw new Error(`no password of ${PASSWORDS_ENV} opens it`);
      return v;
    });
    const project = withPassword("loadKnxproj", (pw) => p.loadKnxproj(bytes, pw, "x")) as { devices: { appRef: string; appProgramId: string }[] } | undefined;
    withPassword("readXml0", (pw) => p.readXml0(bytes, pw));
    withPassword("readBaggage", (pw) => p.readBaggage(bytes, pw));
    const products = run("extractCatalogProducts", () => p.extractCatalogProducts(bytes)) as { appRef: string; appProgramId: string }[] | undefined;
    const applications = run("hardwareApplications", () => p.hardwareApplications(bytes)) as Map<string, string> | undefined;
    const devices = project?.devices ?? [];
    const ids = [...new Set([...devices, ...(products ?? [])].map((d) => d.appProgramId).filter(Boolean))].sort();
    const programs = run("extractAppPrograms", () => p.extractAppPrograms(bytes, ids)) as Map<string, string> | undefined;
    const appRefs = [...new Set([...devices.map((d) => d.appRef), ...(applications?.keys() ?? [])].filter(Boolean))].sort();
    run("readAppProgram", () => appRefs.map((ref) => [ref, p.readAppProgram(bytes, ref)]));
    if (programs) run("extractPictureBaggage", () => p.extractPictureBaggage(bytes, programs));
    out[file] = r;
  }
  process.stdout.write(JSON.stringify(out));
}

// The packages/ of `rev` on disk: the checkout's own for "worktree", else unpacked from git once.
function packagesOf(rev: string): string {
  if (rev === "worktree") return join(REPO, "packages");
  const sha = execFileSync("git", ["-C", REPO, "rev-parse", "--verify", `${rev}^{commit}`], { encoding: "utf8" }).trim();
  const dir = join(REPO, "node_modules", ".cache", "loader-hash", sha);
  if (!existsSync(join(dir, "packages", "project", "src", "index.ts"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "node_modules", "@busforge"), { recursive: true });
    execFileSync("sh", ["-c", `git -C "$0" archive "$1" packages | tar -x -C "$2"`, REPO, sha, dir]);
    for (const pkg of readdirSync(join(dir, "packages"))) symlinkSync(join(dir, "packages", pkg), join(dir, "node_modules", "@busforge", pkg));
  }
  return join(dir, "packages");
}

function resultsOf(rev: string): Results {
  const run = spawnSync(process.execPath, [import.meta.path, "--measure", join(packagesOf(rev), "project", "src")], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });
  if (run.status !== 0) throw new Error(`measuring ${rev} failed (exit ${run.status})`);
  return JSON.parse(run.stdout) as Results;
}

if (process.argv[2] === "--measure") await measure(process.argv[3]);
else {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error("usage: bun tools/loader-hash.ts <commit> <commit|worktree>"); process.exit(2); }
  // Without the passwords every protected project is refused alike on both sides, which would compare equal.
  if (passwords().length === 0) { console.error(`${PASSWORDS_ENV} is not set: the protected projects would not be read`); process.exit(2); }
  const ra = resultsOf(a), rb = resultsOf(b);
  const files = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort();
  let differ = 0, readings = 0;
  // Refusals by reader and code, for each side: a reader refused alike on both sides compares equal.
  const refusals = new Map<string, [number, number]>();
  for (const file of files) {
    const readers = [...new Set([...Object.keys(ra[file] ?? {}), ...Object.keys(rb[file] ?? {})])];
    for (const reader of readers) {
      readings++;
      const x = ra[file]?.[reader] ?? "(not run)", y = rb[file]?.[reader] ?? "(not run)";
      [x, y].forEach((v, side) => {
        if (!v.startsWith("refused")) return;
        const key = `${reader} ${v.slice("refused ".length).split(":")[0]}`;
        const n = refusals.get(key) ?? [0, 0];
        n[side]++;
        refusals.set(key, n);
      });
      if (x !== y) { differ++; console.log(`${file}  ${reader}\n  ${a}: ${x}\n  ${b}: ${y}`); }
    }
  }
  console.log(`refusals (${a} / ${b}):`);
  for (const [key, [na, nb]] of [...refusals].sort(([x], [y]) => x.localeCompare(y))) console.log(`  ${key}: ${na} / ${nb}`);
  console.log(`${files.length} files, ${readings} readings, ${differ} differ`);
  process.exit(differ ? 1 : 0);
}
